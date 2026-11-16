// MCP: JSON-RPC 2.0 over Streamable HTTP. The suite speaks two dialects — the modern
// `server/discover` (2026-07-28) and the legacy `initialize` handshake — and calls exactly
// six tools against the same Store as REST and GraphQL.

import { parseGid, type Issue, type Pull, type Repo, type Store } from './store.ts';

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter issues by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch of the pull request.' },
        base: { type: 'string', description: 'The base branch of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function textResult(text: string, structuredContent?: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

function errorResult(message: string): Record<string, unknown> {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: pull.headRef,
    head_ref: pull.headRef,
    base: pull.baseRef,
    base_ref: pull.baseRef,
    merge_commit_sha: pull.mergeCommitSha,
    url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function asStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function findRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = asStr(args.owner);
  const repoName = asStr(args.repo ?? args.repository);
  if (owner === null || repoName === null) return null;
  if (owner !== store.viewerLogin) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
  switch (name) {
    case 'create_repo': {
      const repoName = asStr(args.name);
      if (repoName === null || repoName === '') return { result: errorResult('missing required argument: name') };
      const created = store.createRepo(store.viewerLogin, repoName, args.private === true, asStr(args.description) ?? '');
      if (created === null) return { result: errorResult('Repository already exists') };
      const obj = repoObject(created);
      return { result: textResult(JSON.stringify(obj), obj) };
    }
    case 'get_repo': {
      const owner = asStr(args.owner);
      const repoName = asStr(args.repo ?? args.repository);
      if (owner === null || repoName === null) return { result: errorResult('missing required arguments: owner and repo') };
      const repo = findRepo(store, args);
      if (repo === null) return { result: errorResult(`repository ${owner}/${repoName} not found`) };
      const obj = repoObject(repo);
      return { result: textResult(JSON.stringify(obj), obj) };
    }
    case 'create_issue': {
      const title = asStr(args.title);
      if (title === null || title === '') return { result: errorResult('missing required argument: title') };
      const repo = findRepo(store, args);
      if (repo === null) return { result: errorResult('repository not found') };
      const created = store.createIssue(repo, title, asStr(args.body) ?? '', []);
      if ('error' in created) return { result: errorResult(created.error) };
      const obj = issueObject(repo, created);
      return { result: textResult(JSON.stringify(obj), obj) };
    }
    case 'list_issues': {
      const repo = findRepo(store, args);
      if (repo === null) return { result: errorResult('repository not found') };
      const state = asStr(args.state) ?? 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const objects = list.map((issue) => issueObject(repo, issue));
      return { result: textResult(JSON.stringify(objects), { issues: objects }) };
    }
    case 'create_pull_request': {
      const title = asStr(args.title);
      const head = asStr(args.head ?? args.head_ref ?? args.headRef);
      const base = asStr(args.base ?? args.base_ref ?? args.baseRef);
      if (title === null || title === '') return { result: errorResult('missing required argument: title') };
      if (head === null || base === null) return { result: errorResult('missing required arguments: head and base') };
      const repo = findRepo(store, args);
      if (repo === null) return { result: errorResult('repository not found') };
      const stripOwner = (ref: string): string => (ref.includes(':') ? ref.split(':').pop()! : ref);
      const created = store.createPull(repo, title, asStr(args.body) ?? '', stripOwner(head), stripOwner(base));
      if ('error' in created) return { result: errorResult(created.error) };
      const obj = pullObject(repo, created);
      return { result: textResult(JSON.stringify(obj), obj) };
    }
    case 'merge_pull_request': {
      const number = asInt(args.pull_number ?? args.number ?? args.pullNumber ?? args.pull_request);
      if (number === null) return { result: errorResult('missing required argument: pull_number') };
      const repo = findRepo(store, args);
      if (repo === null) return { result: errorResult('repository not found') };
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { result: errorResult(`pull request #${number} not found`) };
      if (pull.merged) return { result: errorResult(`pull request #${number} is already merged`) };
      const sha = store.squashMerge(repo, pull);
      if (sha === null) return { result: errorResult('merge conflict: the pull request cannot be merged') };
      const obj = { merged: true, sha, number: pull.number, ...pullObject(repo, pull) };
      return { result: textResult(JSON.stringify(obj), obj) };
    }
    default:
      return { error: { code: -32601, message: `unknown tool: ${name}` } };
  }
}

function handleRequest(store: Store, request: Record<string, unknown>): Record<string, unknown> | null {
  const id = (request.id as string | number | null) ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const isNotification = request.id === undefined;

  const respond = (result: Record<string, unknown>): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === '') return isNotification ? null : fail(-32600, 'invalid request: missing method');
  if (method.startsWith('notifications/')) return null;

  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return respond({
      protocolVersion: PROTOCOL_VERSION,
      supportedVersions: [...SUPPORTED_VERSIONS],
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const version = requested !== null && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : PROTOCOL_VERSION;
    return respond({
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return respond({});
  if (method === 'tools/list') {
    // Deterministic: the same literal array is serialized every call.
    return respond({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (toolName === '') return fail(-32602, 'missing required parameter: name');
    const outcome = callTool(store, toolName, args);
    if ('error' in outcome) return fail(outcome.error.code, outcome.error.message);
    return respond(outcome.result);
  }
  return fail(-32601, `method not found: ${method}`);
}

/** Handle one POST /mcp body. Returns the HTTP status, content type and body bytes. */
export function handleMcp(store: Store, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, contentType: 'application/json', body: json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error: the request body is not valid JSON' } }) };
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => (entry !== null && typeof entry === 'object' ? handleRequest(store, entry as Record<string, unknown>) : { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }))
      .filter((r): r is Record<string, unknown> => r !== null);
    return { status: 200, contentType: 'application/json', body: json(responses) };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, contentType: 'application/json', body: json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }) };
  }
  const response = handleRequest(store, parsed as Record<string, unknown>);
  if (response === null) return { status: 202, contentType: 'application/json', body: Buffer.alloc(0) };
  return { status: 200, contentType: 'application/json', body: json(response) };
}

// Referenced only to keep the id helpers linked from this module's callers.
export { parseGid };
