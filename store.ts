// The forge's one store: git objects, refs, issues, pull requests and labels, all in memory.
// REST, GraphQL and MCP all read and write this same store, so an object created on one surface
// reads back identical on the others. Nothing here reads a wall clock or Math.random: timestamps
// and ids come from a monotonic counter, so two runs on the same requests leave the same state.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export const isOid = (value: string): boolean => HEX40.test(value);

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerText = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of (blank < 0 ? data : data.subarray(0, blank)).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every commit reachable from `tips` by following parents (tags are followed to their target). */
export function collectAncestors(objects: Map<string, GitObject>, tips: Iterable<string>): Set<string> {
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
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `maybeAncestor` is `tip` or one of its ancestors. */
export function isAncestor(objects: Map<string, GitObject>, maybeAncestor: string, tip: string): boolean {
  if (maybeAncestor === tip) return true;
  const seen = new Set<string>([tip]);
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === maybeAncestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** The nearest common ancestor of two commits, or null when their histories never meet. */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  if (a === b) return a;
  const distA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, d] = queueA.pop()!;
    if (distA.has(oid)) continue;
    distA.set(oid, d);
    const object = objects.get(oid);
    if (object?.type === 'commit') for (const p of parseCommit(object.data).parents) queueA.push([p, d + 1]);
  }
  let best: string | null = null;
  let bestScore = Infinity;
  const queueB: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const [oid, d] = queueB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const da = distA.get(oid);
    if (da !== undefined && da + d < bestScore) {
      bestScore = da + d;
      best = oid;
    }
    const object = objects.get(oid);
    if (object?.type === 'commit') for (const p of parseCommit(object.data).parents) queueB.push([p, d + 1]);
  }
  return best;
}

/** Flatten a tree into path -> entry, recursively. `treeOid` null means an empty tree. */
export function flattenTree(
  objects: Map<string, GitObject>,
  treeOid: string | null,
  out: Map<string, { mode: string; oid: string }> = new Map(),
  prefix = '',
): Map<string, { mode: string; oid: string }> {
  if (treeOid === null) return out;
  const object = objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(objects, entry.oid, out, path);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/**
 * Build (and store) the tree for a flat path map. Returns the root tree oid.
 * Intermediate directories are created as needed; an empty map yields the empty tree.
 */
export function buildTreeFromFiles(
  objects: Map<string, GitObject>,
  files: ReadonlyMap<string, { mode: string; oid: string }>,
): string {
  const put = (type: GitObjectType, data: Buffer): string => {
    const oid = hashObject(type, data);
    if (!objects.has(oid)) objects.set(oid, { type, data });
    return oid;
  };
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Set<string>();
    for (const [path, entry] of files) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
      else dirs.add(rest.slice(0, slash));
    }
    for (const dir of [...dirs].sort()) {
      entries.push({ mode: '40000', name: dir, oid: build(prefix === '' ? dir : `${prefix}/${dir}`) });
    }
    return put('tree', buildTree(entries));
  };
  return build('');
}

/** Count added/removed lines between two texts by multiset difference (deterministic, cheap). */
export function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of counts.values()) deletions += left;
  return { additions, deletions };
}

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

/** The path-level diff between two trees (null tree = empty). */
export function diffTrees(
  objects: Map<string, GitObject>,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): FileChange[] {
  const base = flattenTree(objects, baseTreeOid);
  const head = flattenTree(objects, headTreeOid);
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const data = objects.get(b.oid)?.data;
      const text = data === undefined ? '' : data.toString('utf8');
      const lines = text === '' ? 0 : text.split('\n').length;
      changes.push({ path, status: 'removed', additions: 0, deletions: lines, oldOid: b.oid, newOid: null });
    } else if (b === undefined && h !== undefined) {
      const data = objects.get(h.oid)?.data;
      const text = data === undefined ? '' : data.toString('utf8');
      const lines = text === '' ? 0 : text.split('\n').length;
      changes.push({ path, status: 'added', additions: lines, deletions: 0, oldOid: null, newOid: h.oid });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldText = objects.get(b.oid)?.data?.toString('utf8') ?? '';
      const newText = objects.get(h.oid)?.data?.toString('utf8') ?? '';
      const { additions, deletions } = countLineDiff(oldText, newText);
      changes.push({ path, status: 'modified', additions, deletions, oldOid: b.oid, newOid: h.oid });
    }
  }
  return changes;
}

// -------------------------------------------------------------------------------------------
// The store
// -------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  userLogin: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
}

/** Opaque Relay-style global ids: base64url of `Kind:ids`. Never the plain database id. */
export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

const BASE_EPOCH_SEC = 1_700_000_000;

export class Store {
  readonly viewerLogin: string;
  readonly viewerName: string;
  readonly viewerEmail: string;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private seq = 0;

  constructor(viewerLogin: string) {
    this.viewerLogin = viewerLogin;
    this.viewerName = viewerLogin === 'adaiversen' ? 'ada iversen' : viewerLogin;
    this.viewerEmail = `${viewerLogin}@example.invalid`;
  }

  /** The next monotonic sequence number (creation order and the deterministic clock). */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** A deterministic ISO timestamp derived from the sequence, never the wall clock. */
  stamp(seq: number): string {
    return new Date((BASE_EPOCH_SEC + seq) * 1000).toISOString();
  }

  commitTimestamp(seq: number): number {
    return BASE_EPOCH_SEC + seq;
  }

  authorLine(seq: number): string {
    return `${this.viewerName} <${this.viewerEmail}> ${this.commitTimestamp(seq)} +0000`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === this.viewerLogin) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const seq = this.tick();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: seq,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** Resolve a branch name, a full ref, or a commit sha to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      return oid ?? null;
    }
    if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
    return repo.refs.get(`refs/heads/${ref}`) ?? null;
  }

  /** The tip commit oid of a branch (creating the branch from the default tip when missing). */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The tree oid of a commit, or null when the commit is unknown. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Create a commit object on `branch` from a flat file map; returns the commit oid. */
  commitFiles(
    repo: Repo,
    branch: string,
    files: ReadonlyMap<string, { mode: string; oid: string }>,
    message: string,
  ): { commitSha: string; parent: string | null } {
    const parent = this.branchTip(repo, branch);
    const tree = buildTreeFromFiles(repo.objects, files);
    const seq = this.tick();
    const lines = [`tree ${tree}`];
    if (parent !== null) lines.push(`parent ${parent}`);
    const who = this.authorLine(seq);
    lines.push(`author ${who}`, `committer ${who}`, '');
    const data = Buffer.from(`${lines.join('\n')}\n${message.endsWith('\n') ? message : `${message}\n`}`, 'utf8');
    const commitSha = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, parent };
  }

  /** The current flat file map of a branch tip (empty when the branch is unborn). */
  branchFiles(repo: Repo, branch: string): Map<string, { mode: string; oid: string }> {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return new Map();
    const tree = this.commitTree(repo, tip);
    return flattenTree(repo.objects, tree);
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `label "${name}" does not exist` };
      labels.push(label);
    }
    const seq = this.tick();
    const stamp = this.stamp(seq);
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels,
      createdSeq: seq,
      createdAt: stamp,
      updatedAt: stamp,
      closedAt: null,
      comments: [],
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const seq = this.tick();
    const comment: IssueComment = { id: this.nextCommentId, body, createdAt: this.stamp(seq), userLogin: this.viewerLogin };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
    const headSha = this.resolveRef(repo, head);
    const baseSha = this.resolveRef(repo, base);
    if (headSha === null) return { error: `head ref "${head}" does not exist` };
    if (baseSha === null) return { error: `base ref "${base}" does not exist` };
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
        return { error: 'a pull request is already open for this head and base' };
      }
    }
    const seq = this.tick();
    const stamp = this.stamp(seq);
    const pull: Pull = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      headSha,
      baseRef: base,
      baseSha,
      createdSeq: seq,
      createdAt: stamp,
      updatedAt: stamp,
      closedAt: null,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** Whether `head` merges cleanly into `base`, and the conflicting paths when it does not. */
  mergeAnalysis(repo: Repo, headSha: string, baseSha: string): { conflict: boolean; paths: string[] } {
    if (headSha === baseSha) return { conflict: false, paths: [] };
    const mb = mergeBase(repo.objects, headSha, baseSha);
    const mbTree = mb === null ? null : this.commitTree(repo, mb);
    const headTree = this.commitTree(repo, headSha);
    const baseTree = this.commitTree(repo, baseSha);
    const headChanges = new Map(diffTrees(repo.objects, mbTree, headTree).map((c) => [c.path, c.newOid]));
    const baseChanges = new Map(diffTrees(repo.objects, mbTree, baseTree).map((c) => [c.path, c.newOid]));
    const paths: string[] = [];
    for (const [path, headOid] of headChanges) {
      if (baseChanges.has(path) && baseChanges.get(path) !== headOid) paths.push(path);
    }
    return { conflict: paths.length > 0, paths };
  }

  /** Squash-merge a pull request onto its base branch. Null when conflicted. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const headSha = this.resolveRef(repo, pull.headRef);
    const baseSha = this.resolveRef(repo, pull.baseRef);
    if (headSha === null || baseSha === null) return null;
    if (this.mergeAnalysis(repo, headSha, baseSha).conflict) return null;
    const headTree = this.commitTree(repo, headSha);
    if (headTree === null) return null;
    const seq = this.tick();
    const who = this.authorLine(seq);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const lines = [`tree ${headTree}`, `parent ${baseSha}`, `author ${who}`, `committer ${who}`, ''];
    const data = Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
    const mergeSha = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.stamp(seq);
    pull.mergeCommitSha = mergeSha;
    pull.closedAt = pull.mergedAt;
    pull.updatedAt = pull.mergedAt;
    pull.baseSha = mergeSha;
    return mergeSha;
  }

  /** The changed paths between a pull request's merge base and its head. */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const headSha = this.resolveRef(repo, pull.headRef);
    const baseSha = this.resolveRef(repo, pull.baseRef);
    if (headSha === null || baseSha === null) return [];
    const mb = mergeBase(repo.objects, headSha, baseSha);
    const mbTree = mb === null ? null : this.commitTree(repo, mb);
    return diffTrees(repo.objects, mbTree, this.commitTree(repo, headSha));
  }

  /** Commits reachable from a tip, newest first (depth-first pre-order from the tip). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
    }
    return out;
  }
}

/** The peeled commit of a tag object, or the oid itself when it is not a tag. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string {
  let current = oid;
  for (let i = 0; i < 8; i += 1) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}
