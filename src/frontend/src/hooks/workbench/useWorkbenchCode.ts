/**
 * T21 `useWorkbenchCode` —— Code 面板：把工具事件投影成"文件 + 内容"。
 *
 * ## 两条数据路径（必须分开渲染）
 * ① **完整载荷**：`tool.outputDetail` 是全文（`buildToolPayload` 的 output 参数），
 *    `tool.toolOutput` 只是它的 200 字摘要。→ 渲染 outputDetail。
 * ② **packed-replay**：后端 `readEvents` 对打包行只回放 `payload: { content }`，
 *    T9 `hasFullToolPayload` 因此返回 false。此时只剩 200 字的 `toolOutput`，
 *    → 渲染摘要 + 显式截断提示，**绝不**拿它冒充完整文件。
 *
 * ## 诚实降级
 * 载荷里根本没有内容（`outputDetail` / `toolOutput` 都缺）时渲染 `MISSING_CONTENT_NOTICE`，
 * 而不是拼一段看起来像代码的假内容。
 *
 * ## 路径与操作
 * 一律取自 T9 `projectFileActivity`（`inputDetail.path`，回退 `toolInput`）——
 * 本文件不另写一套路径提取规则，两处判定因此不可能漂移。
 */
import { useCallback, useMemo, useState } from 'react';
import type { AgentEventEnvelope } from '@pacc/shared';
import { useActivityStore } from '../../store/activityStore';
import { hasFullToolPayload, projectFileActivity, type FileOp } from '../../store/projections';
import { useWorkspaceStore } from '../../store/workspace';
import { useActiveRunId } from './useActiveRunId';

/** packed-replay 降级时附在摘要后的显式提示（含英文关键词便于检索与断言）。 */
export const REPLAY_TRUNCATION_NOTICE =
  '⋯ 内容在 packed-replay 回放中被截断（truncated after replay），此处只有工具摘要的前 200 字 ⋯';

/** 载荷里没有任何可渲染内容时的诚实提示。 */
export const MISSING_CONTENT_NOTICE = '（无内容：该工具调用未返回可渲染内容）';

/** Code 面板的一行文件。 */
export interface WorkbenchCodeFile {
  readonly path: string;
  readonly name: string;
  readonly op: FileOp;
  /** 事件时间戳（ISO） */
  readonly at: string;
  /** 渲染文本：完整内容 / 降级摘要+提示 / 诚实缺失提示，绝不含伪造内容 */
  readonly content: string;
  /** 当前内容不完整（packed-replay 截断或内容缺失） */
  readonly truncated: boolean;
  /** 工具结果摘要本身被裁剪（T9 判定：`toolOutput` 以 '…' 结尾） */
  readonly sourceTruncated: boolean;
}

export interface UseWorkbenchCodeResult {
  readonly files: readonly WorkbenchCodeFile[];
  readonly currentFile: WorkbenchCodeFile | null;
  readonly selectFile: (path: string) => void;
  /** 当前文件内容是否不完整 */
  readonly truncated: boolean;
  /** 当前文件的渲染文本（无选中文件时为空串，不是 null —— 编辑区需要字符串） */
  readonly rawContent: string;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/** `outputDetail`（unknown）→ 渲染文本；`undefined` 表示"载荷里没有内容"。 */
function renderOutputDetail(detail: unknown): string | undefined {
  if (typeof detail === 'string') return detail;
  // `in` 收窄（与 store/projections.ts 的 toolPathOf 同一手法），不做类型断言
  if (typeof detail === 'object' && detail !== null) {
    if ('content' in detail && typeof detail.content === 'string') return detail.content;
    if ('text' in detail && typeof detail.text === 'string') return detail.text;
  }
  if (detail === undefined) return undefined;
  return JSON.stringify(detail, null, 2);
}

/**
 * 工具事件流 → Code 面板的文件列表。
 *
 * 同一路径多次操作时**以最后一次为准**（保留首次出现的位置，Code 面板是文件树而非日志）。
 * 载荷完整性按 run 判定（`hasFullToolPayload`）：一个 packed 事件就让整条 run 走降级路径。
 */
export function buildCodeFiles(
  events: AgentEventEnvelope[],
  runId?: string,
): WorkbenchCodeFile[] {
  const fullPayload = hasFullToolPayload(events, runId);
  const byPath = new Map<string, WorkbenchCodeFile>();

  for (const event of events) {
    const tool = event.tool;
    if (tool === undefined) continue;
    // 路径 / op / 摘要截断判定全部委托 T9
    const entry = projectFileActivity([event], runId).at(0);
    if (entry === undefined) continue;

    const full = fullPayload ? renderOutputDetail(tool.outputDetail) : undefined;
    const summary = tool.toolOutput ?? '';
    const file: WorkbenchCodeFile = {
      path: entry.path,
      name: baseName(entry.path),
      op: entry.op,
      at: entry.at,
      content: fullPayload
        ? (full ?? MISSING_CONTENT_NOTICE)
        : (summary === '' ? MISSING_CONTENT_NOTICE : `${summary}\n\n${REPLAY_TRUNCATION_NOTICE}`),
      truncated: !fullPayload || full === undefined,
      sourceTruncated: entry.truncated,
    };
    byPath.set(entry.path, file);
  }

  return [...byPath.values()];
}

/** Code 面板数据：当前会话活动 run 的文件列表 + 当前文件内容。 */
export function useWorkbenchCode(): UseWorkbenchCodeResult {
  const conversationId = useWorkspaceStore(state => state.conversationId);
  const events = useActivityStore(state => state.getEvents(conversationId ?? ''));
  const { runId } = useActiveRunId();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const files = useMemo(() => buildCodeFiles(events, runId ?? undefined), [events, runId]);
  // 选中的文件被新事件挤掉（不再出现在投影里）时回落到首个文件，而不是显示空白
  const currentFile = useMemo(
    () => files.find(file => file.path === selectedPath) ?? files.at(0) ?? null,
    [files, selectedPath],
  );
  const selectFile = useCallback((path: string): void => { setSelectedPath(path); }, []);

  return {
    files,
    currentFile,
    selectFile,
    truncated: currentFile?.truncated ?? false,
    rawContent: currentFile?.content ?? '',
  };
}
