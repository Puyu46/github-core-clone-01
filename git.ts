// git smart HTTP: pkt-line framing, packfile read/write (plain objects plus OFS/REF deltas),
// and the upload-pack v2 / receive-pack v0 handlers. No git binary, only node:zlib and node:crypto.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  collectAncestors,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type Repo,
  type Store,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from the start of `buf` until a flush (or the end). Returns null on a
 * malformed header, and `rest` — the bytes after the terminating flush — for receive-pack packs.
 */
export function decodePktLines(buf: Buffer): { packets: Packet[]; rest: Buffer } | null {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return null;
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) return null;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, rest: buf.subarray(offset + 4) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > 65520 || offset + length > buf.length) return null;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/** Split a byte stream into sideband packets (band byte + chunk), each within the pkt-line limit. */
export function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  if (data.length === 0) return out;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const piece = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([band]), piece]);
    out.push(pktLine(payload));
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// packfile
// -------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile (version 2, no deltas) from plain objects. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/**
 * Read a packfile (version 2/3) into objects by id, resolving OFS_DELTA and REF_DELTA entries.
 * `lookup` supplies bases a thin pack leaves out (the store, usually). Throws on any corruption.
 */
export function readPack(pack: Buffer, lookup: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = lookup(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// -------------------------------------------------------------------------------------------
// object reachability
// -------------------------------------------------------------------------------------------

/** Every object reachable from `tips`: commits, their trees and parents, tags and their targets. */
export function reachableObjects(objects: Map<string, GitObject>, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) if (isOid(tip)) queue.push(tip);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    }
  }
  return seen;
}

/**
 * Reachable objects for a depth-limited fetch: only the commits in `included` (their trees and
 * blobs), plus tag objects in `extraRoots` and their targets. Parent commits are NOT followed,
 * so a depth-1 fetch carries the tip only. Commits outside `included` are never expanded.
 */
export function reachableShallow(
  objects: Map<string, GitObject>,
  included: Iterable<string>,
  extraRoots: Iterable<string>,
): Set<string> {
  const includedSet = new Set(included);
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const oid of includedSet) if (isOid(oid)) queue.push(oid);
  for (const oid of extraRoots) if (isOid(oid)) queue.push(oid);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      if (includedSet.has(oid)) queue.push(parseCommit(object.data).tree);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    }
  }
  return seen;
}

// -------------------------------------------------------------------------------------------
// ref listing
// -------------------------------------------------------------------------------------------

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

/** All refs of a repo, sorted heads then tags, with peeled targets for annotated tags. */
export function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!name.startsWith('refs/heads/')) continue;
    out.push({ name, oid: repo.refs.get(name)! });
  }
  for (const name of names) {
    if (!name.startsWith('refs/tags/')) continue;
    const oid = repo.refs.get(name)!;
    const peeled = peelToCommit(repo.objects, oid);
    out.push(peeled === oid ? { name, oid } : { name, oid, peeled });
  }
  return out;
}

function headOid(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

const UPLOAD_V2_CAPS = ['ls-refs', 'fetch=shallow thin-pack ofs-delta', 'object-format=sha1'];

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of UPLOAD_V2_CAPS) parts.push(pktLine(`${cap}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main'
      : 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = headOid(repo) ?? refs[0]!.oid;
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// fetch planning
// -------------------------------------------------------------------------------------------

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Plan a fetch: which objects to send, the new shallow boundary, and the ACK lines.
 * `depth` limits commit generations from the wants (1 = the tips only); `priorShallow` is the
 * client's current shallow boundary. Objects the client already holds (reachable from `haves`)
 * are never re-sent.
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  priorShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const objects = repo.objects;
  // A shallow client's haves do NOT imply their ancestors: it holds only the have commits
  // themselves plus their trees/blobs. A non-shallow full fetch may assume full reachability.
  const shallowClient = depth !== null || priorShallow.length > 0;
  const haveSet = shallowClient
    ? reachableShallow(objects, haves.map((h) => peelToCommit(objects, h)), [])
    : reachableObjects(objects, haves);
  const acks: string[] = [];
  for (const have of haves) {
    const peeled = peelToCommit(objects, have);
    for (const want of wants) {
      if (isAncestor(objects, peeled, peelToCommit(objects, want))) {
        acks.push(have);
        break;
      }
    }
  }

  let sendSet: Set<string>;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth === null) {
    sendSet = reachableObjects(objects, wants);
  } else {
    // Walk commits from the wants by generation.
    const included = new Set<string>();
    const boundary = new Set<string>();
    const queue: Array<[string, number]> = [];
    for (const want of wants) queue.push([peelToCommit(objects, want), 0]);
    const seenGen = new Map<string, number>();
    while (queue.length > 0) {
      const [oid, gen] = queue.shift()!;
      const prev = seenGen.get(oid);
      if (prev !== undefined && prev <= gen) continue;
      seenGen.set(oid, gen);
      const object = objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (gen >= depth) continue;
      included.add(oid);
      const parents = parseCommit(object.data).parents;
      if (gen === depth - 1) {
        if (parents.length > 0) boundary.add(oid);
      } else {
        for (const parent of parents) queue.push([parent, gen + 1]);
      }
    }
    // Unshallow: prior boundary commits now fully included (all parents included too).
    for (const prior of priorShallow) {
      if (!included.has(prior)) continue;
      const object = objects.get(prior);
      const parents = object?.type === 'commit' ? parseCommit(object.data).parents : [];
      if (parents.every((p) => included.has(p))) unshallow.push(prior);
    }
    const unshallowSet = new Set(unshallow);
    shallow = [...boundary];
    for (const prior of priorShallow) {
      if (unshallowSet.has(prior)) continue;
      if (!shallow.includes(prior)) shallow.push(prior);
    }
    // Objects: the included commits, their trees/blobs, plus any wanted tag objects.
    // Never reachableObjects() here: it follows parents and would leak full history.
    const tagRoots: string[] = [];
    for (const want of wants) {
      const object = objects.get(want);
      if (object?.type === 'tag') tagRoots.push(want);
    }
    sendSet = reachableShallow(objects, included, tagRoots);
  }
  const send: GitObject[] = [];
  for (const oid of sendSet) {
    if (haveSet.has(oid)) continue;
    const object = objects.get(oid);
    if (object !== undefined) send.push(object);
  }
  return { objects: send, shallow, unshallow, acks };
}

// -------------------------------------------------------------------------------------------
// smart-HTTP handlers. Each returns {status, contentType, body} or null when the path is not git.
// -------------------------------------------------------------------------------------------

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonError(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

/** Parse `/<owner>/<repo>.git/<rest>`; null when the path is not a git path. */
export function parseGitPath(pathname: string): { owner: string; repo: string; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(pathname);
  if (match === null) return null;
  return { owner: match[1]!, repo: match[2]!, rest: match[3] ?? '' };
}

export function handleGitInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocolV2: boolean,
): GitResponse {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return jsonError(404, 'Not Found');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined || owner !== store.viewerLogin) return jsonError(404, 'Not Found');
  if (service === 'git-upload-pack' && gitProtocolV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(repo, service as 'git-upload-pack' | 'git-receive-pack'),
  };
}

function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; prefixes: string[] }): Buffer {
  const refs = listRefs(repo);
  const head = headOid(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  if (head !== null && args.prefixes.length === 0) {
    parts.push(pktLine(`${head} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV2Response(repo: Repo, plan: FetchPlan): Buffer {
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (plan.objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    const pack = writePack(plan.objects);
    parts.push(...sidebandPackets(1, pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(...sidebandPackets(1, pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleGitUploadPack(store: Store, owner: string, repoName: string, body: Buffer, gitProtocolV2: boolean): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined || owner !== store.viewerLogin) return jsonError(404, 'Not Found');
  const decoded = decodePktLines(body);
  if (decoded === null) return jsonError(400, 'malformed pkt-line stream');
  const lines: string[] = [];
  for (const packet of decoded.packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    else if (packet.kind === 'delim') lines.push('\u0001');
  }
  if (gitProtocolV2) {
    const command = lines[0]?.replace(/\n$/, '') ?? '';
    if (command === 'command=ls-refs') {
      const args = { peel: false, symrefs: false, prefixes: [] as string[] };
      for (const line of lines.slice(1)) {
        const text = line.replace(/\n$/, '');
        if (text === 'peel') args.peel = true;
        else if (text === 'symrefs') args.symrefs = true;
        else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, args) };
    }
    if (command === 'command=fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      for (const line of lines.slice(1)) {
        const text = line.replace(/\n$/, '');
        if (text.startsWith('want ')) wants.push(text.slice(5).trim());
        else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) {
          const n = Number.parseInt(text.slice(7), 10);
          if (Number.isFinite(n)) depth = n;
        }
      }
      if (wants.length === 0) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM, PKT_FLUSH]) };
      const plan = planFetch(repo, wants, haves, shallow, depth);
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2Response(repo, plan) };
    }
    return jsonError(400, `unknown upload-pack command ${JSON.stringify(command)}`);
  }
  // v0 fetch: section 1 (wants, shallow, deepen) then flush, section 2 (haves, done) then flush.
  const sections: string[][] = [[]];
  for (const line of lines) {
    if (line === '\u0001' || line === '') continue;
    sections[sections.length - 1]!.push(line);
  }
  // The decoder stops at the first flush, so a v0 body needs a second pass over `rest`.
  const second = decodePktLines(decoded.rest);
  const allLines = [...lines];
  if (second !== null) {
    for (const packet of second.packets) if (packet.kind === 'data') allLines.push(packet.payload.toString('utf8'));
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of allLines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7), 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  void sections;
  if (wants.length === 0) return jsonError(400, 'fetch with no wants');
  const plan = planFetch(repo, wants, haves, shallow, depth);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0Response(repo, plan) };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleGitReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined || owner !== store.viewerLogin) return jsonError(404, 'Not Found');
  const decoded = decodePktLines(body);
  if (decoded === null) return jsonError(400, 'malformed pkt-line stream');
  const commands: PushCommand[] = [];
  let sideband = false;
  let reportStatus = false;
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const head = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    if (nul >= 0) {
      const caps = text.slice(nul + 1).replace(/\n$/, '').split(' ');
      sideband = caps.includes('side-band-64k');
      reportStatus = caps.includes('report-status') || caps.includes('report-status-v2');
    }
    const parts = head.split(' ');
    if (parts.length !== 3) return jsonError(400, 'malformed receive-pack command');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) return jsonError(400, 'malformed receive-pack command');
    commands.push({ oldOid, newOid, ref });
  }
  void reportStatus;
  const reportLines: string[] = [];
  const failUnpack = (detail: string): GitResponse => {
    const report = Buffer.concat([pktLine(`unpack ${detail}\n`), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: sideband ? Buffer.concat([...sidebandPackets(1, report), PKT_FLUSH]) : report };
  };
  if (commands.length === 0) return failUnpack('no commands');
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let incoming = new Map<string, GitObject>();
  if (needsPack) {
    if (decoded.rest.length === 0) return failUnpack('missing packfile');
    try {
      incoming = readPack(decoded.rest, (oid) => repo.objects.get(oid));
    } catch (err) {
      return failUnpack(err instanceof Error ? err.message : 'unpack error');
    }
    for (const command of commands) {
      if (command.newOid !== ZERO_OID && !incoming.has(command.newOid) && !repo.objects.has(command.newOid)) {
        return failUnpack('missing object for a pushed ref');
      }
    }
    for (const [oid, object] of incoming) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  }
  // Validate and apply per ref; a refused ref never moves, an accepted one does.
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    const isTag = command.ref.startsWith('refs/tags/');
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} ref does not exist\n`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} old ref mismatch\n`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reportLines.push(`ng ${command.ref} already exists\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    // Update.
    if (current === undefined) {
      reportLines.push(`ng ${command.ref} ref does not exist\n`);
    } else if (current !== command.oldOid) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
    } else if (!isTag && !isAncestor(repo.objects, command.oldOid, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
    } else {
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
  }
  const reportParts: Buffer[] = [pktLine('unpack ok\n')];
  for (const line of reportLines) reportParts.push(pktLine(line));
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  const bodyOut = sideband ? Buffer.concat([...sidebandPackets(1, report), PKT_FLUSH]) : report;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: bodyOut };
}
