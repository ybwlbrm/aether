/**
 * 域响应类型：只描述前端**实际消费**的字段（parse-don't-validate 的边界产物）。
 * 这些类型是 `api/client.ts` 里 `api.result.*` 方法的 T 参数，
 * 让调用点拿到 `{ ok, data }` 后不再需要 `any` 断言。
 */

/** 外部工具可用性（ffmpeg / yt-dlp / LibreOffice） */
export interface ToolAvailability {
  available: boolean;
  [key: string]: unknown;
}

export type ToolsStatus = Record<string, ToolAvailability>;

/** 工具箱产物型响应：单个输出文件（Base64 或下载 URL） */
export interface ToolboxFileResult {
  output?: string;
  error?: string;
}

/** 工具箱逐文件型响应（convert / video-extract） */
export interface ToolboxItemResult {
  success: boolean;
  output?: string;
  message?: string;
}

export interface ToolboxConvertResult {
  results?: ToolboxItemResult[];
  error?: string;
}

export interface ToolboxEncodeResult {
  result?: string;
  error?: string;
}

/** 小工具（Base64 / 时间戳 / 颜色）单值响应 */
export interface ToolboxUtilityResult {
  result?: string;
  error?: string;
}

export interface ToolboxPdfCompressResult extends ToolboxFileResult {
  compressedSize?: number;
  originalSize?: number;
}

export interface ToolboxUnlockResult extends ToolboxFileResult {
  format?: string;
}

/** pdf-read 可能只回文本（不产出文件） */
export interface ToolboxReadResult extends ToolboxFileResult {
  result?: string;
}

export interface ToolboxPdfToDocxResult extends ToolboxFileResult {
  pageCount?: number;
}

export interface ToolboxYoutubeResult extends ToolboxFileResult {
  success?: boolean;
  title?: string;
  format?: string;
}

/** 终端共享命令历史（Agent 执行的命令也会出现在这里） */
export interface TerminalEntry {
  id: string;
  command: string;
  output: string;
  timestamp: string;
  duration: number;
  success: boolean;
  source?: 'terminal' | 'agent';
}

export interface TerminalExecuteResult {
  output?: string;
  error?: string;
}

export interface McpImportResult {
  imported?: string[];
  errors?: string[];
}

export interface ImportAllResult {
  importedCounts?: {
    providers?: number;
    projects?: number;
    conversations?: number;
    media?: number;
    documents?: number;
  };
  error?: string;
}

/** 编码互转参数（GBK/Big5/gb18030 走后端 iconv） */
export interface ToolboxEncodePayload {
  op: 'encode-text' | 'decode-text';
  input: string;
  encoding: 'gbk' | 'big5' | 'gb18030';
  format: 'hex' | 'unicode' | 'base64';
}

/** Provider 列表项（列表视图实际消费的字段；`provider` 为旧字段名的兼容别名） */
export interface ProviderSummary {
  id: string;
  name: string;
  type?: string;
  provider?: string;
  capabilities?: string[];
  models?: string[];
  defaultModel?: string;
  isDefault?: boolean;
  createdAt?: string;
}

/** 能力 → 默认 Provider id 的映射 */
export type DefaultProviders = Record<string, string>;

/**
 * 云同步配置回读（后端不回传明文 supabaseKey，只给 hasKey；
 * Key 从本地 sessionStorage/localStorage 兜底解析）。
 */
export interface SyncConfigInfo {
  configured?: boolean;
  supabaseUrl?: string;
  hasKey?: boolean;
}

/** 记忆分类（后端 memories 表） */
export type MemoryType = 'short_term' | 'long_term' | 'project';

export interface MemoryRow {
  id: string;
  type: MemoryType;
  key: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** 知识库 Wiki 页（后端持久化） */
export interface WikiPageRow {
  id: string;
  title: string;
  content: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}
