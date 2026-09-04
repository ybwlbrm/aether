/**
 * DeepSeek Harness 风格的工具分类系统
 * 参考：packages/core/tools/src/presentation.ts
 * 
 * ToolCallKind: read | edit | delete | move | search | execute | fetch | other
 * ToolCallView: GenericCallView | TerminalCallView | DiffCallView
 * ToolResultView: GenericResultView | TerminalResultView | DiffResultView | SearchResultView | ReadResultView | WebResultView
 * 每个工具声明自己的渲染意图（presentCall/presentResult），UI 据此选择渲染方式。
 */

/** 工具调用类别（参考 DeepSeek ToolCallKind） */
export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other';

/** 工具行状态 */
export type ToolRowState = 'running' | 'ok' | 'error' | 'stopped';

/** 文件位置（参考 DeepSeek FileLocation） */
export interface FileLocation {
  path: string;
  line?: number;
}

/** 文件差异（参考 DeepSeek FileDiff） */
export interface FileDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

/** 文件行（参考 DeepSeek ReadFileLine） */
export interface ReadFileLine {
  number: number;
  text: string;
}

/** 搜索匹配行（参考 DeepSeek SearchLineMatch） */
export interface SearchLineMatch {
  lineNumber: number;
  line: string;
}

/** 文件内匹配组（参考 DeepSeek SearchFileMatches） */
export interface SearchFileMatches {
  path: string;
  matches: SearchLineMatch[];
}

/** Web 来源（参考 DeepSeek WebSource） */
export interface WebSource {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

/** 通用调用视图（参考 DeepSeek GenericCallView） */
export interface GenericCallView {
  card: 'generic';
  title: string;
  kind?: ToolCallKind;
  rawInput?: unknown;
  content?: string[];
  locations?: FileLocation[];
}

/** 终端调用视图（参考 DeepSeek TerminalCallView） */
export interface TerminalCallView {
  card: 'terminal';
  title: string;
  description?: string;
  cwd?: string;
}

/** Diff 调用视图（参考 DeepSeek DiffCallView） */
export interface DiffCallView {
  card: 'diff';
  title: string;
  diffs: FileDiff[];
  locations?: FileLocation[];
}

/** 调用时视图（参考 DeepSeek ToolCallView） */
export type ToolCallView = GenericCallView | TerminalCallView | DiffCallView;

/** 通用结果视图（参考 DeepSeek GenericResultView） */
export interface GenericResultView {
  card: 'generic';
  title?: string;
  content?: string[];
}

/** 终端结果视图（参考 DeepSeek TerminalResultView） */
export interface TerminalResultView {
  card: 'terminal';
  title?: string;
  output?: string;
  exitCode?: number;
  signal?: string;
}

/** Diff 结果视图（参考 DeepSeek DiffResultView） */
export interface DiffResultView {
  card: 'diff';
  title?: string;
  diffs: FileDiff[];
}

/** 搜索匹配结果（参考 DeepSeek SearchMatchesResultView） */
export interface SearchMatchesResultView {
  card: 'search';
  shape: 'matches';
  title?: string;
  files: SearchFileMatches[];
  truncated: boolean;
  total: number;
}

/** 搜索路径结果（参考 DeepSeek SearchPathsResultView） */
export interface SearchPathsResultView {
  card: 'search';
  shape: 'paths';
  title?: string;
  paths: string[];
  truncated: boolean;
  total: number;
}

/** 搜索结果视图（参考 DeepSeek SearchResultView） */
export type SearchResultView = SearchMatchesResultView | SearchPathsResultView;

/** 读取结果视图（参考 DeepSeek ReadResultView） */
export interface ReadResultView {
  card: 'read';
  title?: string;
  path: string;
  offset: number;
  lines: ReadFileLine[];
  totalLines: number;
  lang?: string;
  content?: string[];
}

/** Web 搜索结果（参考 DeepSeek WebSearchResultView） */
export interface WebSearchResultView {
  card: 'web';
  kind: 'search';
  title?: string;
  sources: WebSource[];
  answer?: string;
  truncated: boolean;
}

/** Web 获取结果（参考 DeepSeek WebFetchResultView） */
export interface WebFetchResultView {
  card: 'web';
  kind: 'fetch';
  title?: string;
  url: string;
  statusCode: number;
  truncated: boolean;
}

/** Web 结果视图（参考 DeepSeek WebResultView） */
export type WebResultView = WebSearchResultView | WebFetchResultView;

/** 结果时视图（参考 DeepSeek ToolResultView） */
export type ToolResultView =
  | GenericResultView
  | TerminalResultView
  | DiffResultView
  | SearchResultView
  | ReadResultView
  | WebResultView;

/** 类别标题 */
export const KIND_TITLES: Record<ToolCallKind, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Run',
  fetch: 'Fetch',
  other: 'Tool',
};

/** 工具名 → 类别映射（参考 DeepSeek 的 ToolCallKind 分类） */
const TOOL_KINDS: Record<string, ToolCallKind> = {
  read_file: 'read',
  write_file: 'edit',
  list_files: 'read',
  create_directory: 'edit',
  delete_file: 'delete',
  edit_file: 'edit',
  grep: 'search',
  glob: 'search',
  web_search: 'search',
  web_fetch: 'fetch',
  execute_command: 'execute',
  run_tests: 'execute',
  code_review: 'read',
  lsp_diagnostics: 'read',
  // MCP 工具前缀
  filesystem: 'read',
  browser: 'search',
  git: 'execute',
};

/** 各类别的摘要键偏好 */
const SUMMARY_KEYS: Record<ToolCallKind, readonly string[]> = {
  read: ['path', 'file_path', 'url'],
  edit: ['path', 'file_path'],
  delete: ['path', 'file_path'],
  move: ['path', 'source', 'destination'],
  search: ['query', 'pattern', 'url'],
  execute: ['command', 'description'],
  fetch: ['url', 'query'],
  other: [],
};

/**
 * 分类工具名到 ToolCallKind。
 * 参考 DeepSeek classifyTool
 */
export function classifyTool(toolName: string): ToolCallKind {
  const exact = TOOL_KINDS[toolName];
  if (exact) return exact;
  const prefix = toolName.split('_')[0];
  if (prefix && TOOL_KINDS[prefix]) return TOOL_KINDS[prefix];
  if (toolName.endsWith('_read') || toolName.endsWith('_list')) return 'read';
  if (toolName.endsWith('_write') || toolName.endsWith('_edit')) return 'edit';
  if (toolName.endsWith('_search')) return 'search';
  if (toolName.endsWith('_exec') || toolName.endsWith('_run')) return 'execute';
  return 'other';
}

export function toolRowTitle(toolName: string): string {
  return KIND_TITLES[classifyTool(toolName)] ?? 'Tool';
}

/**
 * 从 args 中提取摘要文本。
 * 参考 DeepSeek: deriveSummary()
 */
function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/**
 * 从 args 推导摘要。
 * 参考 DeepSeek: deriveSummary()
 */
export function deriveSummary(toolName: string, argsRaw: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(argsRaw); } catch { return firstLine(argsRaw); }
  if (typeof parsed !== 'object' || parsed === null) return firstLine(argsRaw);

  const args = parsed as Record<string, unknown>;
  const variant = classifyTool(toolName);

  if (variant === 'search' && Array.isArray(args.queries)) {
    const queries = args.queries.filter((q): q is string => typeof q === 'string' && q !== '');
    if (queries.length > 0) return queries.map(firstLine).join(', ');
  }

  const picked = pickString(args, SUMMARY_KEYS[variant]);
  if (picked !== undefined) return firstLine(picked);

  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v !== '') return firstLine(v);
  }
  return firstLine(argsRaw);
}

/** 工具行模型（纯数据，供渲染，参考 DeepSeek ToolRowModel） */
export interface ToolRowModel {
  variant: ToolCallKind;
  title: string;
  summary: string;
  body: string | null;
  output: string | null;
  state: ToolRowState;
  toolName: string;
  /** 调用视图（参考 DeepSeek presentCall） */
  callView?: ToolCallView;
  /** 结果视图（参考 DeepSeek presentResult） */
  resultView?: ToolResultView;
  /** 文件位置（用于编辑器跟踪） */
  locations?: FileLocation[];
}

/**
 * 从工具事件构建行模型。
 * 参考 DeepSeek: deriveToolRowModel()
 */
export function buildToolRowModel(toolName: string, argsRaw: string, result?: string, error?: string): ToolRowModel {
  const variant = classifyTool(toolName);
  const title = toolRowTitle(toolName);
  const summary = deriveSummary(toolName, argsRaw);

  let body: string | null = null;
  try {
    const parsed = JSON.parse(argsRaw);
    if (typeof parsed === 'object' && parsed !== null) {
      body = Object.entries(parsed as Record<string, unknown>)
        .map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n');
    }
  } catch { body = argsRaw; }

  let state: ToolRowState = 'ok';
  if (error) state = 'error';

  // 构建调用视图（参考 DeepSeek presentCall）
  const callView: ToolCallView = variant === 'execute'
    ? { card: 'terminal', title: summary, description: summary }
    : { card: 'generic', title, kind: variant, rawInput: summary };

  // 构建结果视图（参考 DeepSeek presentResult）
  let resultView: ToolResultView | undefined;
  if (result !== undefined) {
    if (variant === 'search') {
      resultView = { card: 'search', shape: 'paths', paths: result.split('\n'), truncated: false, total: 0, title };
    } else if (variant === 'read') {
      resultView = { card: 'read', title, path: summary, offset: 0, lines: [], totalLines: 0 };
    } else if (variant === 'execute') {
      resultView = { card: 'terminal', title, output: result.slice(0, 200), exitCode: error ? 1 : 0 };
    } else if (variant === 'fetch') {
      resultView = { card: 'web', kind: 'fetch', title, url: summary, statusCode: 200, truncated: false };
    } else {
      resultView = { card: 'generic', title };
    }
  }

  return {
    variant, title, summary, body,
    output: result ?? null, state, toolName,
    callView, resultView,
  };
}

/**
 * 格式化工具行输出（纯文字，一行）。
 * 格式: ✓ List D:\gongzuo
 * 参考 DeepSeek 的纯文字渲染风格
 */
export function formatToolRow(model: ToolRowModel): string {
  const stateIcon = model.state === 'ok' ? '✓'
    : model.state === 'error' ? '✕'
    : model.state === 'stopped' ? '■'
    : '●';
  return `${stateIcon} ${model.title} ${model.summary}`;
}