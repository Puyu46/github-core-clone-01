// GraphQL v4: a small parser and executor for exactly the documents gh and github-mcp-server
// send (viewer, repository reads, issue/PR reads, the five mutations, __type introspection and
// batched operation arrays). Unknown fields are HTTP 200 with an errors array naming them.

import {
  gid,
  parseGid,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// tokenizer + parser
// -------------------------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<[string, Value]> };

interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<[string, Value]>;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

interface SpreadSelection {
  kind: 'spread';
  name: string;
}

type Selection = FieldSelection | FragmentSelection | SpreadSelection;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: Map<string, Value | null>;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Selection[]>;
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('()[]{}:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push(isFloat ? { kind: 'float', value: source.slice(i, j) } : { kind: 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: new Map(), selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next.kind === 'name') name = this.next().value as string;
        const varDefs = new Map<string, Value | null>();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            let def: Value | null = null;
            if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '=') {
              this.next();
              def = this.parseValue();
            }
            varDefs.set(varName, def);
          }
          this.expectPunct(')');
        }
        // Directives on the operation (rare here): skip @name(args).
        while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
          this.next();
          this.expectName();
          if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
        }
        operations.push({ kind, name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // the type condition
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      throw new Error('unexpected token in GraphQL document');
    }
    return { operations, fragments };
  }

  private parseType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        return { kind: 'spread', name: this.next().value as string };
      }
      return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Array<[string, Value]> = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      args = this.parseArguments();
    }
    // Directives on the field: skip @name(args).
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Array<[string, Value]> {
    this.expectPunct('(');
    const args: Array<[string, Value]> = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push([name, this.parseValue()]);
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<[string, Value]> = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push([name, this.parseValue()]);
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// -------------------------------------------------------------------------------------------
// schema: field names per type (validation + introspection)
// -------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate', 'createdAt', 'updatedAt'],
  Ref: ['name', 'prefix'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url', 'author', 'closedAt', 'labels', 'comments'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'author', 'url', 'closedAt', 'mergeCommitSha'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType', 'description'],
  Node: ['id'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

type AnyNode = Record<string, unknown> & { __type: string };

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
  fragments: Map<string, Selection[]>;
}

function valueOf(value: Value, variables: Readonly<Record<string, unknown>>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
      return value.value;
    case 'int':
    case 'float':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value.fields) out[k] = valueOf(v, variables);
      return out;
    }
  }
}

function argsOf(field: FieldSelection, variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of field.args) out[k] = valueOf(v, variables);
  return out;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1]!, 10);
  } catch {
    return -1;
  }
}

function pageInfoFor(total: number, start: number, end: number): AnyNode {
  return {
    __type: 'PageInfo',
    hasNextPage: end < total,
    hasPreviousPage: start > 0,
    startCursor: end > start ? cursorFor(start) : null,
    endCursor: end > start ? cursorFor(end - 1) : null,
  };
}

function issueNode(store: Store, repo: Repo, issue: Issue): AnyNode {
  return {
    __type: 'Issue',
    id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author: { __type: 'User', login: store.viewerLogin, id: 1000 },
    labels: issue.labels.map((label) => ({ __type: 'Label', name: label.name, color: label.color })),
    comments: issue.comments.map((c) => ({ __type: 'IssueComment', id: gid('IssueComment', repo.id, issue.number, c.id), body: c.body, createdAt: c.createdAt })),
    _issue: issue,
    _repo: repo,
  };
}

function pullNode(store: Store, repo: Repo, pull: Pull): AnyNode {
  const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  const mergeable = store.mergeAnalysis(repo, pull.headSha, pull.baseSha).conflict ? 'CONFLICTING' : 'MERGEABLE';
  return {
    __type: 'PullRequest',
    id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.closedAt,
    mergeCommitSha: pull.mergeCommitSha,
    url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    author: { __type: 'User', login: store.viewerLogin, id: 1000 },
    headRef: { __type: 'Ref', name: pull.headRef, prefix: 'refs/heads/' },
    baseRef: { __type: 'Ref', name: pull.baseRef, prefix: 'refs/heads/' },
    _pull: pull,
    _repo: repo,
    _store: store,
  };
}

function repositoryNode(store: Store, repo: Repo): AnyNode {
  return {
    __type: 'Repository',
    id: gid('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __type: 'User', login: repo.owner, id: 1000 },
    defaultBranchRef: { __type: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.isPrivate,
    createdAt: store.stamp(repo.createdSeq),
    updatedAt: store.stamp(repo.createdSeq),
    _repo: repo,
    _store: store,
  };
}

function findRepoById(store: Store, databaseId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === databaseId) return repo;
  return undefined;
}

/** Resolve one field's raw value; functions on the node receive (args, ctx) and may return a node. */
function resolveFieldValue(node: AnyNode, field: FieldSelection, args: Record<string, unknown>, ctx: Ctx): unknown {
  const name = field.name;
  if (name === '__typename') return node.__type;
  const raw = (node as Record<string, unknown>)[name];
  if (typeof raw === 'function') return (raw as (args: Record<string, unknown>, ctx: Ctx) => unknown)(args, ctx);
  if (raw !== undefined) return raw;

  const type = node.__type;
  if (type === 'Repository') {
    const repo = node._repo as Repo;
    const store = node._store as Store;
    if (name === 'issue') {
      const number = args.number as number;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueNode(store, repo, issue);
    }
    if (name === 'issues') {
      let list = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      if (orderBy?.field === 'CREATED_AT') {
        list.sort((a, b) => (orderBy.direction === 'ASC' ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number));
      } else {
        list.sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
      }
      const first = typeof args.first === 'number' ? args.first : list.length;
      const afterIndex = indexOfCursor(args.after);
      const start = afterIndex + 1;
      const page = list.slice(start, start + first);
      return {
        __type: 'IssueConnection',
        nodes: page.map((issue) => issueNode(store, repo, issue)),
        edges: page.map((issue, i) => ({ __type: 'IssueEdge', node: issueNode(store, repo, issue), cursor: cursorFor(start + i) })),
        pageInfo: pageInfoFor(list.length, start, start + page.length),
        totalCount: list.length,
      };
    }
    if (name === 'pullRequests') {
      const list = [...repo.pulls.values()].filter((pull) => pull.state === 'open').sort((a, b) => b.createdSeq - a.createdSeq);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      return {
        __type: 'PullRequestConnection',
        nodes: page.map((pull) => pullNode(store, repo, pull)),
        edges: page.map((pull, i) => ({ __type: 'IssueEdge', node: pullNode(store, repo, pull), cursor: cursorFor(i) })),
        pageInfo: pageInfoFor(list.length, 0, page.length),
        totalCount: list.length,
      };
    }
    if (name === 'pullRequest') {
      const number = args.number as number;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullNode(store, repo, pull);
    }
  }
  if (type === 'PullRequest') {
    const pull = node._pull as Pull;
    const repo = node._repo as Repo;
    const store = node._store as Store;
    if (name === 'files') {
      const changes = store.pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : changes.length;
      const page = changes.slice(0, first);
      return {
        __type: 'PullRequestChangedFileConnection',
        nodes: page.map((c) => ({ __type: 'PullRequestChangedFile', path: c.path, additions: c.additions, deletions: c.deletions, changeType: c.status })),
        totalCount: changes.length,
        pageInfo: pageInfoFor(changes.length, 0, page.length),
      };
    }
  }
  if (type === '__Type') {
    if (name === 'fields') {
      const fieldNames = (node._fields as string[]) ?? [];
      return fieldNames.map((n) => ({ __type: '__Field', name: n, description: null, args: [], type: null }));
    }
    if (name === 'enumValues') {
      const values = (node._enumValues as string[]) ?? [];
      return values.map((n) => ({ __type: '__EnumValue', name: n, description: null }));
    }
  }
  return undefined;
}

/** Validate + execute one selection set against a node, writing into `out`. */
function executeSelections(
  typeName: string,
  node: AnyNode | null,
  selections: Selection[],
  variables: Readonly<Record<string, unknown>>,
  ctx: Ctx,
  out: Record<string, unknown>,
): void {
  if (node === null) return;
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) executeSelections(typeName, node, fragment, variables, ctx, out);
      continue;
    }
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || (selection.typeCondition === 'Node' && ['Repository', 'Issue', 'PullRequest'].includes(typeName))) {
        executeSelections(typeName, node, selection.selections, variables, ctx, out);
      }
      continue;
    }
    const field = selection;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const allowed = SCHEMA_FIELDS[typeName];
    if (allowed !== undefined && !allowed.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const args = argsOf(field, variables);
    const value = resolveFieldValue(node, field, args, ctx);
    out[key] = executeValue(value, field.selections, variables, ctx);
  }
}

/** Turn a resolved raw value into its response form, recursing into sub-selections. */
function executeValue(value: unknown, selections: Selection[], variables: Readonly<Record<string, unknown>>, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => executeValue(entry, selections, variables, ctx));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const node = value as AnyNode;
    if (selections.length === 0) return {};
    const out: Record<string, unknown> = {};
    executeSelections(node.__type, node, selections, variables, ctx, out);
    return out;
  }
  return value;
}

/** Validate every field in a selection set against the schema, collecting errors. */
function validateSelections(typeName: string, selections: Selection[], ctx: Ctx): void {
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) validateSelections(typeName, fragment, ctx);
      continue;
    }
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        validateSelections(selection.typeCondition ?? typeName, selection.selections, ctx);
      }
      continue;
    }
    if (selection.name === '__typename') continue;
    const allowed = SCHEMA_FIELDS[typeName];
    if (allowed !== undefined && !allowed.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      continue;
    }
    // Recurse into sub-selections with the field's return type when known.
    const childType = childTypeOf(typeName, selection.name);
    if (childType !== null && selection.selections.length > 0) validateSelections(childType, selection.selections, ctx);
  }
}

/** The GraphQL return type of a field, for validation recursion (null when scalar/unknown). */
function childTypeOf(parent: string, field: string): string | null {
  const map: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
    Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
    Issue: { author: 'User' },
    IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
    IssueEdge: { node: 'Issue' },
    PullRequest: { headRef: 'Ref', baseRef: 'Ref', files: 'PullRequestChangedFileConnection', author: 'User' },
    PullRequestConnection: { nodes: 'PullRequest', edges: 'IssueEdge', pageInfo: 'PageInfo' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
    IssueCommentEdge: { node: 'IssueComment' },
    IssueComment: { author: 'User' },
  };
  return map[parent]?.[field] ?? null;
}

// -------------------------------------------------------------------------------------------
// root fields + mutations
// -------------------------------------------------------------------------------------------

function typeNode(name: string): AnyNode | null {
  if (name === 'SearchType') {
    return { __type: '__Type', name, kind: 'ENUM', _fields: [], _enumValues: SEARCH_TYPE_VALUES, description: null };
  }
  const fields = SCHEMA_FIELDS[name];
  if (fields === undefined) return null;
  return { __type: '__Type', name, kind: name === 'Node' ? 'INTERFACE' : 'OBJECT', _fields: [...fields], _enumValues: [], description: null };
}

function viewerNode(store: Store): AnyNode {
  return {
    __type: 'User',
    login: store.viewerLogin,
    id: 1000,
    name: store.viewerName,
    email: store.viewerEmail,
    url: `https://example.invalid/${store.viewerLogin}`,
  };
}

function resolveRootField(store: Store, field: FieldSelection, args: Record<string, unknown>, ctx: Ctx): unknown {
  switch (field.name) {
    case 'viewer':
      return viewerNode(store);
    case 'repository': {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== store.viewerLogin) return null;
      const repo = store.getRepo(owner, name);
      return repo === undefined ? null : repositoryNode(store, repo);
    }
    case 'node': {
      const parsed = parseGid(String(args.id ?? ''));
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = findRepoById(store, Number(parsed.parts[0]));
        return repo === undefined ? null : repositoryNode(store, repo);
      }
      if (parsed.kind === 'Issue') {
        const repo = findRepoById(store, Number(parsed.parts[0]));
        const issue = repo?.issues.get(Number(parsed.parts[1]));
        return issue === undefined || repo === undefined ? null : issueNode(store, repo, issue);
      }
      if (parsed.kind === 'PullRequest') {
        const repo = findRepoById(store, Number(parsed.parts[0]));
        const pull = repo?.pulls.get(Number(parsed.parts[1]));
        return pull === undefined || repo === undefined ? null : pullNode(store, repo, pull);
      }
      return null;
    }
    case '__type':
      return typeNode(String(args.name ?? ''));
    case '__schema': {
      const types = Object.keys(SCHEMA_FIELDS)
        .map((n) => typeNode(n))
        .filter((n): n is AnyNode => n !== null);
      return {
        __type: '__Schema',
        types,
        queryType: typeNode('Query'),
        mutationType: typeNode('Mutation'),
        description: null,
      };
    }
    case 'createIssue': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed === null ? undefined : findRepoById(store, Number(parsed.parts[0]));
      if (repo === undefined) {
        ctx.errors.push({ message: 'repository not found' });
        return null;
      }
      const title = String(input.title ?? '');
      if (title === '') {
        ctx.errors.push({ message: 'title is required' });
        return null;
      }
      const created = store.createIssue(repo, title, String(input.body ?? ''), []);
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return null;
      }
      return { __type: 'CreateIssuePayload', issue: issueNode(store, repo, created), clientMutationId: (input.clientMutationId as string | null) ?? null };
    }
    case 'closeIssue': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.issueId ?? ''));
      const repo = parsed === null || parsed.kind !== 'Issue' ? undefined : findRepoById(store, Number(parsed.parts[0]));
      const issue = repo?.issues.get(Number(parsed?.parts[1] ?? Number.NaN));
      if (issue === undefined || repo === undefined) {
        ctx.errors.push({ message: 'issue not found' });
        return null;
      }
      issue.state = 'closed';
      issue.closedAt = store.stamp(store.tick());
      issue.updatedAt = issue.closedAt;
      return { __type: 'CloseIssuePayload', issue: issueNode(store, repo, issue), clientMutationId: (input.clientMutationId as string | null) ?? null };
    }
    case 'createPullRequest': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed === null ? undefined : findRepoById(store, Number(parsed.parts[0]));
      if (repo === undefined) {
        ctx.errors.push({ message: 'repository not found' });
        return null;
      }
      const created = store.createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return null;
      }
      return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(store, repo, created), clientMutationId: (input.clientMutationId as string | null) ?? null };
    }
    case 'mergePullRequest': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      const repo = parsed === null || parsed.kind !== 'PullRequest' ? undefined : findRepoById(store, Number(parsed.parts[0]));
      const pull = repo?.pulls.get(Number(parsed?.parts[1] ?? Number.NaN));
      if (pull === undefined || repo === undefined) {
        ctx.errors.push({ message: 'pull request not found' });
        return null;
      }
      if (pull.merged) {
        ctx.errors.push({ message: 'pull request is already merged' });
        return null;
      }
      const sha = store.squashMerge(repo, pull);
      if (sha === null) {
        ctx.errors.push({ message: 'merge conflict: the pull request cannot be merged' });
        return null;
      }
      return { __type: 'MergePullRequestPayload', pullRequest: pullNode(store, repo, pull), clientMutationId: (input.clientMutationId as string | null) ?? null };
    }
    case 'addComment': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.subjectId ?? ''));
      const repo = parsed === null || parsed.kind !== 'Issue' ? undefined : findRepoById(store, Number(parsed.parts[0]));
      const issue = repo?.issues.get(Number(parsed?.parts[1] ?? Number.NaN));
      if (issue === undefined || repo === undefined) {
        ctx.errors.push({ message: 'issue not found' });
        return null;
      }
      const comment = store.createComment(repo, issue, String(input.body ?? ''));
      const node: AnyNode = {
        __type: 'IssueComment',
        id: gid('IssueComment', repo.id, issue.number, comment.id),
        body: comment.body,
        createdAt: comment.createdAt,
        author: viewerNode(store),
      };
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'IssueCommentEdge', node, cursor: cursorFor(0) },
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      };
    }
    default:
      return null;
  }
}

function executeRootSelections(
  store: Store,
  operation: Operation,
  variables: Readonly<Record<string, unknown>>,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (selections: Selection[]): void => {
    for (const selection of selections) {
      if (selection.kind === 'spread') {
        const fragment = ctx.fragments.get(selection.name);
        if (fragment !== undefined) walk(fragment);
        continue;
      }
      if (selection.kind === 'fragment') {
        walk(selection.selections);
        continue;
      }
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = operation.kind === 'mutation' ? 'Mutation' : 'Query';
        continue;
      }
      const args = argsOf(selection, variables);
      const value = resolveRootField(store, selection, args, ctx);
      out[key] = executeValue(value, selection.selections, variables, ctx);
    }
  };
  walk(operation.selections);
  return out;
}

function executeOperation(store: Store, entry: Record<string, unknown>): Record<string, unknown> {
  const query = typeof entry.query === 'string' ? entry.query : '';
  let parsed: Document;
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  if (parsed.operations.length === 0) return { data: null, errors: [{ message: 'no operation found in document' }] };
  let operation = parsed.operations[0]!;
  if (typeof entry.operationName === 'string') {
    const found = parsed.operations.find((o) => o.name === entry.operationName);
    if (found !== undefined) operation = found;
    else return { data: null, errors: [{ message: `unknown operation ${entry.operationName}` }] };
  } else if (parsed.operations.length > 1) {
    return { data: null, errors: [{ message: 'operationName is required when the document has multiple operations' }] };
  }
  const variables = { ...((entry.variables ?? {}) as Record<string, unknown>) };
  for (const [name, def] of operation.varDefs) {
    if (!(name in variables) && def !== null) variables[name] = valueOf(def, {});
  }
  const ctx: Ctx = { store, errors: [], fragments: parsed.fragments };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(rootType, operation.selections, ctx);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  const data = executeRootSelections(store, operation, variables, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Handle one POST /api/graphql body. Returns the HTTP status and the JSON response value. */
export function handleGraphQL(store: Store, body: Buffer): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'malformed JSON body' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => (entry !== null && typeof entry === 'object' ? executeOperation(store, entry as Record<string, unknown>) : { data: null, errors: [{ message: 'invalid operation' }] })) };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, body: { errors: [{ message: 'the request body must be a JSON object' }] } };
  }
  return { status: 200, body: executeOperation(store, parsed as Record<string, unknown>) };
}
