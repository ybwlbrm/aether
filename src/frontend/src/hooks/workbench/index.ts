/**
 * T21 Workbench 数据 hooks 子桶。
 *
 * 5 个 tab 各自绑定真实数据源，**本目录内没有任何占位数据**：
 *   Browser → useWorkbenchBrowser（T4 lib/url 判定，iframe src 永不可执行协议）
 *   Code    → useWorkbenchCode（T9 文件投影 + packed-replay 诚实降级）
 *   Files   → useWorkbenchFiles（T9 工具投影 ∪ media ∪ documents，按 path 唯一）
 *   Terminal→ useWorkbenchTerminal（后端共享命令历史 + 前缀推断成功）
 *   Preview → useWorkbenchPreview（documents ∪ media，documentDownloadUrl 取址）
 *
 * 共同的数据入口是 `useActiveRunId`（workspace.conversationId + runStore）。
 */
export { useActiveRunId, resolveActiveRun } from './useActiveRunId';
export type { ActiveRunCandidate, ActiveRunResolution } from './useActiveRunId';

export { useWorkbenchBrowser, createBrowserSession, resolveBrowserInput, RELOAD_PARAM } from './useWorkbenchBrowser';
export type {
  BrowserInput,
  BrowserSession,
  BrowserSnapshot,
  UseWorkbenchBrowserResult,
} from './useWorkbenchBrowser';

export { useWorkbenchCode, buildCodeFiles, MISSING_CONTENT_NOTICE, REPLAY_TRUNCATION_NOTICE } from './useWorkbenchCode';
export type { UseWorkbenchCodeResult, WorkbenchCodeFile } from './useWorkbenchCode';

export { useWorkbenchFiles, mergeWorkbenchFiles } from './useWorkbenchFiles';
export type { UseWorkbenchFilesResult, WorkbenchFileRow, WorkbenchFileSource } from './useWorkbenchFiles';

export { useWorkbenchTerminal, inferTerminalSuccess, TERMINAL_FAILURE_PREFIXES } from './useWorkbenchTerminal';
export type { TerminalLine, UseWorkbenchTerminalResult } from './useWorkbenchTerminal';

export { useWorkbenchPreview, buildPreviewItems } from './useWorkbenchPreview';
export type { PreviewItem, PreviewKind, UseWorkbenchPreviewResult } from './useWorkbenchPreview';

export { fetchDocumentRows, fetchMediaRows, parseDocumentRows, parseMediaRows } from './asset-rows';
export type { DocumentKind, DocumentRow, MediaKind, MediaRow } from './asset-rows';
