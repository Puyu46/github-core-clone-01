// The HTTP server: health probe, git smart HTTP, REST v3, GraphQL v4 and MCP, over one Store.
// Every REST reply is application/json with a non-empty X-GitHub-Request-Id; errors carry a
// JSON body with a string message. Auth: the trial bearer token (MAKEFUN_SHOP_TOKEN when set,
// else any non-empty Bearer token); /healthz and the git surface take none.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  gid,
  parseCommit,
  parseTree,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store as StoreType,
} from './store.ts';
import { Store } from './store.ts';
import { handleGitInfoRefs, handleGitReceivePack, handleGitUploadPack, parseGitPath } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const VIEWER_LOGIN = process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen';

const store: StoreType = new Store(VIEWER_LOGIN);
let requestCounter = 0;

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId(), ...headers });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': requestId() });
  res.end();
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': requestId() });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}

/** Parse a JSON body: empty means {}, malformed means null (the caller answers 400). */
function parseJsonBody(body: Buffer): unknown | null {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// -------------------------------------------------------------------------------------------
// serializers
// -------------------------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? 1000 : 1001, node_id: gid('User', login), type: 'User', site_admin: false };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: store.stamp(repo.createdSeq),
    updated_at: store.stamp(repo.createdSeq),
    pushed_at: store.stamp(repo.createdSeq),
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length + [...repo.pulls.values()].filter((p) => p.state === 'open').length,
    license: null,
    forks: 0,
    open_issues: 0,
    watchers: 0,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  const names = [...repo.labels.keys()];
  return {
    id: names.indexOf(label.name) + 1,
    node_id: gid('Label', repo.id, label.name),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((label) => labelJson(repo, label)),
    user: userJson(VIEWER_LOGIN),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const state = pull.merged ? 'closed' : pull.state;
  return {
    id: pull.id,
    node_id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    locked: false,
    merged: pull.merged,
    mergeable: !store.mergeAnalysis(repo, pull.headSha, pull.baseSha).conflict,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: pull.closedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    user: userJson(VIEWER_LOGIN),
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: userJson(repo.owner), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: userJson(repo.owner), repo: repoJson(repo) },
    draft: false,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: gid('IssueComment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** Split a `Name <email> ts +0000` line into its parts. */
function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) \+0000$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]!) * 1000).toISOString() };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  return {
    sha,
    node_id: gid('Commit', repo.id, sha),
    commit: {
      // GitHub's API strips the trailing newline the raw commit object stores.
      message: commit.message.replace(/\n+$/, ''),
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: commit.tree },
    },
    author: userJson(VIEWER_LOGIN),
    committer: userJson(VIEWER_LOGIN),
    parents: commit.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

// -------------------------------------------------------------------------------------------
// pagination
// -------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Math.min(100, Math.max(1, Number.isFinite(rawPerPage) ? rawPerPage : 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** The Link header for the next page, or '' when this is the last page. */
function linkHeader(req: IncomingMessage, query: URLSearchParams, page: number, perPage: number, total: number): string {
  if (page * perPage >= total) return '';
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  const host = req.headers.host ?? 'localhost';
  const pathname = new URL(req.url ?? '/', 'http://entry').pathname;
  return `<http://${host}${pathname}?${next.toString()}>; rel="next"`;
}

function paged<T>(res: ServerResponse, req: IncomingMessage, query: URLSearchParams, items: readonly T[], serialize: (item: T) => unknown): void {
  const { page, perPage } = pageParams(query);
  const link = linkHeader(req, query, page, perPage, items.length);
  sendJson(res, 200, paginate(items, page, perPage).map(serialize), link === '' ? {} : { link });
}

// -------------------------------------------------------------------------------------------
// REST helpers
// -------------------------------------------------------------------------------------------

/** The repo for an owner/name pair, or null when the token may not see it (never a 403). */
function visibleRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Walk a tree to a path; returns the entry ({mode, oid}) or null. */
function treeLookup(repo: Repo, treeOid: string, segments: readonly string[]): { mode: string; oid: string } | null {
  let currentOid = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(currentOid);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    currentOid = entry.oid;
  }
  return null;
}

function contentsFileJson(repo: Repo, path: string, blobOid: string): Record<string, unknown> {
  const data = repo.objects.get(blobOid)?.data ?? Buffer.alloc(0);
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    sha: blobOid,
    content: data.toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
    download_url: `https://example.invalid/${repo.owner}/${repo.name}/raw/HEAD/${path}`,
  };
}

function contentsDirJson(repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of parseTree(object.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.oid, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}` });
    } else {
      const size = repo.objects.get(entry.oid)?.data.length ?? 0;
      out.push({ type: 'file', name: entry.name, path, sha: entry.oid, size, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}` });
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// REST routes
// -------------------------------------------------------------------------------------------

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: Buffer,
): Promise<void> {
  const rawSegments = pathname.split('/').filter((s) => s !== '');
  // rawSegments[0..1] are 'api','v3'; the rest are the route.
  const segments = rawSegments.slice(2).map(decodeSegment);

  // API root.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound(res);
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound(res);
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }

  if (segments[0] === 'rate_limit' && segments.length === 1) {
    if (method !== 'GET') return notFound(res);
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 0, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 } });
    return;
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound(res);
    sendJson(res, 200, { ...userJson(VIEWER_LOGIN), name: store.viewerName, email: store.viewerEmail });
    return;
  }

  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (segments.length !== 2) return notFound(res);
    if (method === 'GET') {
      paged(res, req, query, store.listViewerRepos(), (repo) => repoJson(repo));
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null) return badRequest(res, 'malformed JSON body');
      if (!isRecord(parsed)) return badRequest(res, 'the request body must be a JSON object');
      const name = asString(parsed.name);
      if (name === null || name === '') return sendJson(res, 422, { message: 'name is required' });
      const created = store.createRepo(VIEWER_LOGIN, name, parsed.private === true, asString(parsed.description) ?? '');
      if (created === null) return sendJson(res, 422, { message: 'Repository already exists', errors: [{ message: 'name already exists on this account' }] });
      sendJson(res, 201, repoJson(created));
      return;
    }
    return notFound(res);
  }

  if (segments[0] !== 'repos' || segments.length < 3) return notFound(res);
  const owner = segments[1]!;
  const repoName = segments[2]!;
  const rest = segments.slice(3);

  // GET/PATCH/DELETE /repos/{owner}/{repo}
  if (rest.length === 0) {
    const repo = visibleRepo(owner, repoName);
    if (method === 'GET') {
      if (repo === null) return notFound(res);
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      if (repo === null) return notFound(res);
      const parsed = parseJsonBody(body);
      if (parsed === null) return badRequest(res, 'malformed JSON body');
      if (!isRecord(parsed)) return badRequest(res, 'the request body must be a JSON object');
      const description = asString(parsed.description);
      if (description !== null) repo.description = description;
      if (typeof parsed.private === 'boolean') repo.isPrivate = parsed.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      if (repo === null) return notFound(res);
      store.deleteRepo(owner, repoName);
      sendEmpty(res, 204);
      return;
    }
    return notFound(res);
  }

  const repo = visibleRepo(owner, repoName);
  if (repo === null) return notFound(res);

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .sort()
        .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name)! }, protected: false }));
      sendJson(res, 200, list);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const tip = repo.refs.get(`refs/heads/${rest[1]}`);
      if (tip === undefined) return notFound(res);
      sendJson(res, 200, { name: rest[1], commit: { sha: tip }, protected: false });
      return;
    }
    return notFound(res);
  }

  // Commits.
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (tip === null) {
        sendJson(res, 200, []);
        return;
      }
      const commits = store.commitsFrom(repo, tip);
      sendJson(res, 200, commits.map((sha) => commitJson(repo, sha)).filter((c) => c !== null));
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const found = commitJson(repo, rest[1]!);
      if (found === null) return notFound(res);
      sendJson(res, 200, found);
      return;
    }
    return notFound(res);
  }

  // Git data: refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(body);
      if (parsed === null) return badRequest(res, 'malformed JSON body');
      if (!isRecord(parsed)) return badRequest(res, 'the request body must be a JSON object');
      const ref = asString(parsed.ref);
      const sha = asString(parsed.sha);
      if (ref === null || sha === null || (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/'))) {
        return sendJson(res, 422, { message: 'invalid ref' });
      }
      const object = repo.objects.get(sha);
      if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) {
        return sendJson(res, 422, { message: 'object does not exist' });
      }
      if (repo.refs.has(ref)) return sendJson(res, 422, { message: 'Reference already exists' });
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: object.type }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref}` });
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const list = [...repo.refs.keys()].sort().map((name) => {
        const oid = repo.refs.get(name)!;
        const object = repo.objects.get(oid);
        return { ref: name, object: { sha: oid, type: object?.type ?? 'commit' } };
      });
      sendJson(res, 200, list);
      return;
    }
    if (method === 'GET' && rest.length === 4 && (rest[2] === 'heads' || rest[2] === 'tags')) {
      const ref = `refs/${rest[2]}/${rest[3]}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return notFound(res);
      const object = repo.objects.get(oid);
      sendJson(res, 200, { ref, object: { sha: oid, type: object?.type ?? 'commit' } });
      return;
    }
    return notFound(res);
  }

  // Contents.
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).join('/');
    if (method === 'GET') {
      const ref = query.get('ref') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (tip === null) return notFound(res);
      const tree = store.commitTree(repo, tip);
      if (tree === null) return notFound(res);
      const pathSegments = filePath === '' ? [] : filePath.split('/');
      if (pathSegments.length === 0) {
        sendJson(res, 200, contentsDirJson(repo, tree, ''));
        return;
      }
      const found = treeLookup(repo, tree, pathSegments);
      if (found === null) return notFound(res);
      if (found.mode === '40000') {
        sendJson(res, 200, contentsDirJson(repo, found.oid, filePath));
        return;
      }
      sendJson(res, 200, contentsFileJson(repo, filePath, found.oid));
      return;
    }
    if (method === 'PUT') {
      const parsed = parseJsonBody(body);
      if (parsed === null) return badRequest(res, 'malformed JSON body');
      if (!isRecord(parsed)) return badRequest(res, 'the request body must be a JSON object');
      const contentB64 = asString(parsed.content);
      const message = asString(parsed.message) ?? 'Update file';
      if (contentB64 === null) return sendJson(res, 422, { message: 'content is required' });
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return sendJson(res, 422, { message: 'content is not valid base64' });
      }
      const branch = asString(parsed.branch) ?? repo.defaultBranch;
      if (repo.refs.get(`refs/heads/${branch}`) === undefined) {
        const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (defaultTip !== undefined) repo.refs.set(`refs/heads/${branch}`, defaultTip);
      }
      const files = store.branchFiles(repo, branch);
      const existing = files.get(filePath);
      const sha = asString(parsed.sha);
      if (existing !== undefined) {
        if (sha === null) return sendJson(res, 409, { message: 'sha is required to update a file' });
        if (sha !== existing.oid) return sendJson(res, 409, { message: 'the sha does not match the current file' });
      }
      // A sha on a create is ignored: the fixture creates files without one, and the stale-sha
      // check only ever updates an existing file.
      const blobOid = store.putObject(repo, 'blob', content);
      files.set(filePath, { mode: '100644', oid: blobOid });
      const { commitSha } = store.commitFiles(repo, branch, files, message);
      sendJson(res, existing === undefined ? 201 : 200, {
        content: { ...contentsFileJson(repo, filePath, blobOid), content: contentB64 },
        commit: { sha: commitSha, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const parsed = parseJsonBody(body);
      if (parsed === null) return badRequest(res, 'malformed JSON body');
      if (!isRecord(parsed)) return badRequest(res, 'the request body must be a JSON object');
      const message = asString(parsed.message) ?? 'Delete file';
      const branch = asString(parsed.branch) ?? repo.defaultBranch;
      const files = store.branchFiles(repo, branch);
      const existing = files.get(filePath);
      if (existing === undefined) return notFound(res);
      const sha = asString(parsed.sha);
      if (sha !== null && sha !== existing.oid) return sendJson(res, 409, { message: 'the sha does not match the current file' });
      files.delete(filePath);
      const { commitSha } = store.commitFiles(repo, branch, files, message);
      sendJson(res, 200, { commit: { sha: commitSha, message } });
      return;
    }
    return notFound(res);
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(repo, label)));
      return;
    }
    if (rest.length === 1 && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null) return badRequest(res, 'malformed JSON body');
      if (!isRecord(parsed)) return badRequest(res, 'the request body must be a JSON object');
      const name = asString(parsed.name);
      if (name === null || name === '') return sendJson(res, 422, { message: 'name is required' });
      const existing = repo.labels.get(name);
      if (existing !== undefined) {
        sendJson(res, 201, labelJson(repo, existing));
        return;
      }
      const label: Label = { name, color: asString(parsed.color) ?? 'ededed', description: asString(parsed.description) ?? '' };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(repo, label));
      return;
    }
    return notFound(res);
  }

  // Issues.
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      paged(res, req, query, list, (issue) => issueJson(repo, issue));
      return;
    }
    if (rest.length === 1 && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null) return badRequest(res, 'malformed JSON body');
      if (!isRecord(parsed)) return badRequest(res, 'the request body must be a JSON object');
      const title = asString(parsed.title);
      if (title === null || title === '') return sendJson(res, 422, { message: 'title is required' });
      const labelNames: string[] = [];
      if (Array.isArray(parsed.labels)) {
        for (const entry of parsed.labels) {
          if (typeof entry === 'string') labelNames.push(entry);
          else if (isRecord(entry) && typeof entry.name === 'string') labelNames.push(entry.name);
        }
      }
      const created = store.createIssue(repo, title, asString(parsed.body) ?? '', labelNames);
      if ('error' in created) return sendJson(res, 422, { message: created.error });
      sendJson(res, 201, issueJson(repo, created));
      return;
    }
    const number = Number(rest[1]);
    if (rest.length >= 2 && Number.isInteger(number) && number > 0) {
      const issue = repo.issues.get(number);
      if (rest.length === 2 && method === 'GET') {
        if (issue === undefined) return notFound(res);
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (rest.length === 2 && method === 'PATCH') {
        if (issue === undefined) return notFound(res);
        const parsed = parseJsonBody(body);
        if (parsed === null) return badRequest(res, 'malformed JSON body');
        if (!isRecord(parsed)) return badRequest(res, 'the request body must be a JSON object');
        const title = asString(parsed.title);
        if (title !== null) issue.title = title;
        const bodyText = asString(parsed.body);
        if (bodyText !== null) issue.body = bodyText;
        const state = asString(parsed.state);
        if (state === 'closed' || state === 'open') {
          issue.state = state;
          issue.closedAt = state === 'closed' ? store.stamp(store.tick()) : null;
          issue.updatedAt = issue.closedAt ?? store.stamp(store.tick());
        }
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) return notFound(res);
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
          return;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (parsed === null) return badRequest(res, 'malformed JSON body');
          if (!isRecord(parsed)) return badRequest(res, 'the request body must be a JSON object');
          const commentBody = asString(parsed.body);
          if (commentBody === null) return sendJson(res, 422, { message: 'body is required' });
          const comment = store.createComment(repo, issue, commentBody);
          sendJson(res, 201, commentJson(repo, issue, comment));
          return;
        }
        return notFound(res);
      }
      return notFound(res);
    }
    return notFound(res);
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      paged(res, req, query, list, (pull) => pullJson(repo, pull));
      return;
    }
    if (rest.length === 1 && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null) return badRequest(res, 'malformed JSON body');
      if (!isRecord(parsed)) return badRequest(res, 'the request body must be a JSON object');
      const title = asString(parsed.title);
      const head = asString(parsed.head);
      const base = asString(parsed.base);
      if (title === null || head === null || base === null) return sendJson(res, 422, { message: 'title, head and base are required' });
      const stripOwner = (ref: string): string => (ref.includes(':') ? ref.split(':').pop()! : ref);
      const created = store.createPull(repo, title, asString(parsed.body) ?? '', stripOwner(head), stripOwner(base));
      if ('error' in created) return sendJson(res, 422, { message: created.error });
      sendJson(res, 201, pullJson(repo, created));
      return;
    }
    const number = Number(rest[1]);
    if (rest.length >= 2 && Number.isInteger(number) && number > 0) {
      const pull = repo.pulls.get(number);
      if (rest.length === 2 && method === 'GET') {
        if (pull === undefined) return notFound(res);
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull === undefined) return notFound(res);
        const files = store.pullFiles(repo, pull).map((change) => ({
          sha: change.newOid ?? change.oldOid ?? '',
          filename: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.additions + change.deletions,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        }));
        sendJson(res, 200, files);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) return notFound(res);
        const parsed = parseJsonBody(body);
        if (parsed === null) return badRequest(res, 'malformed JSON body');
        if (pull.merged) return sendJson(res, 405, { message: 'Pull request has already been merged' });
        if (pull.state === 'closed') return sendJson(res, 405, { message: 'Pull request is closed' });
        const mergeSha = store.squashMerge(repo, pull);
        if (mergeSha === null) return sendJson(res, 405, { message: 'Merge conflict: the pull request cannot be merged' });
        sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
      return notFound(res);
    }
    return notFound(res);
  }

  return notFound(res);
}

// -------------------------------------------------------------------------------------------
// server
// -------------------------------------------------------------------------------------------

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const { pathname, query } = pathOf(req);
        const method = req.method ?? 'GET';

        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const gitPath = parseGitPath(pathname);
        if (gitPath !== null) {
          const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          if (gitPath.rest === 'info/refs' && method === 'GET') {
            const service = query.get('service') ?? '';
            const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const answer = handleGitInfoRefs(store, gitPath.owner, gitPath.repo, service, v2);
            sendBuffer(res, answer.status, answer.contentType, answer.body);
            return;
          }
          if (gitPath.rest === 'git-upload-pack' && method === 'POST') {
            const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const answer = handleGitUploadPack(store, gitPath.owner, gitPath.repo, body, v2);
            sendBuffer(res, answer.status, answer.contentType, answer.body);
            return;
          }
          if (gitPath.rest === 'git-receive-pack' && method === 'POST') {
            const answer = handleGitReceivePack(store, gitPath.owner, gitPath.repo, body);
            sendBuffer(res, answer.status, answer.contentType, answer.body);
            return;
          }
          notFound(res);
          return;
        }

        if (pathname === '/api/graphql' && method === 'POST') {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const body = await readBody(req);
          const answer = handleGraphQL(store, body);
          sendJson(res, answer.status, answer.body);
          return;
        }

        if (pathname === '/mcp' && method === 'POST') {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const body = await readBody(req);
          const answer = handleMcp(store, body);
          sendBuffer(res, answer.status, answer.contentType, answer.body);
          return;
        }

        if (pathname === '/mcp' && method === 'DELETE') {
          sendEmpty(res, 204);
          return;
        }

        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          await handleRest(req, res, method, pathname, query, body);
          return;
        }

        notFound(res);
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        else res.destroy();
      }
    })();
  });
}
