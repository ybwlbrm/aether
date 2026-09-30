/**
 * T21 `useWorkbenchFiles` —— Files 面板：三个数据源合并成一张按 path 唯一的表。
 *
 * ## 数据源
 *   ① 工具投影：T9 `projectFileActivity(events, runId)` —— Agent 真正读写过的文件
 *   ② 媒体资产：`GET /api/media`（解析见 asset-rows.ts）
 *   ③ 文档：`GET /api/documents`
 *
 * ## 合并不变量
 * **按 path 唯一**：同一路径同时出现在工具投影与媒体/文档里时只留一行。
 * 工具来源优先（它带真实路径与操作语义），时间取较晚者，截断标记取或。
 * 输出按更新时间倒序（缺时间的沉底）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useActivityStore } from '../../store/activityStore';
import { projectFileActivity, type FileActivityEntry } from '../../store/projections';
import { useWorkspaceStore } from '../../store/workspace';
import { fetchDocumentRows, fetchMediaRows, type DocumentRow, type MediaRow } from './asset-rows';
import { useActiveRunId } from './useActiveRunId';

/** 行的来源（决定"同 path 冲突时谁留下"）。 */
export type WorkbenchFileSource = 'tool' | 'media' | 'document';

export interface WorkbenchFileRow {
  /** 工具投影给的是真实路径；媒体/文档用 name 作为唯一键（后端无路径字段可依赖） */
  readonly path: string;
  readonly name: string;
  readonly source: WorkbenchFileSource;
  /** 工具行 = 文件操作（read/write/edit/…）；媒体/文档行 = 类型（image/ppt/…） */
  readonly kind: string;
  /** ISO 时间戳；后端未提供时为空串 */
  readonly updatedAt: string;
  /** 工具结果被裁剪（T9 判定） */
  readonly truncated: boolean;
}

export interface UseWorkbenchFilesResult {
  readonly files: readonly WorkbenchFileRow[];
  /** 重读媒体与文档（工具投影是派生的，随事件流自动更新） */
  readonly refresh: () => void;
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_MEDIA: readonly MediaRow[] = [];
const EMPTY_DOCUMENTS: readonly DocumentRow[] = [];

/** ISO 时间串取较晚者；空串永远输给非空（后端没给时间 ≠ 最新）。 */
function laterOf(a: string, b: string): string {
  return a > b ? a : b;
}

/** 工具投影内同路径多次操作：后一次覆盖（展示最新操作），截断标记取或。 */
function upsertTool(byPath: Map<string, WorkbenchFileRow>, row: WorkbenchFileRow): void {
  const previous = byPath.get(row.path);
  byPath.set(row.path, previous === undefined ? row : { ...row, truncated: previous.truncated || row.truncated });
}

/** 媒体/文档撞上已有 path：不夺来源与类型，只补较晚的时间。 */
function upsertAsset(byPath: Map<string, WorkbenchFileRow>, row: WorkbenchFileRow): void {
  const previous = byPath.get(row.path);
  if (previous === undefined) {
    byPath.set(row.path, row);
    return;
  }
  byPath.set(row.path, {
    ...previous,
    updatedAt: laterOf(previous.updatedAt, row.updatedAt),
    truncated: previous.truncated || row.truncated,
  });
}

/** 三源合并：先工具（优先），再媒体，最后文档；按更新时间倒序。 */
export function mergeWorkbenchFiles(
  toolEntries: readonly FileActivityEntry[],
  media: readonly MediaRow[],
  documents: readonly DocumentRow[],
): WorkbenchFileRow[] {
  const byPath = new Map<string, WorkbenchFileRow>();

  for (const entry of toolEntries) {
    upsertTool(byPath, {
      path: entry.path,
      name: entry.path.split(/[\\/]/).at(-1) ?? entry.path,
      source: 'tool',
      kind: entry.op,
      updatedAt: entry.at,
      truncated: entry.truncated,
    });
  }
  for (const item of media) {
    upsertAsset(byPath, {
      path: item.name,
      name: item.name,
      source: 'media',
      kind: item.kind,
      updatedAt: item.createdAt,
      truncated: false,
    });
  }
  for (const item of documents) {
    upsertAsset(byPath, {
      path: item.name,
      name: item.name,
      source: 'document',
      kind: item.kind,
      updatedAt: item.updatedAt,
      truncated: false,
    });
  }

  return [...byPath.values()].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path),
  );
}

/** 传输失败归一为一行可展示文本（settled.reason 在 TS 里未标注类型，这里立刻收窄成 unknown）。 */
function failureMessage(results: readonly PromiseSettledResult<unknown>[]): string | null {
  for (const result of results) {
    if (result.status !== 'rejected') continue;
    const reason: unknown = result.reason;
    return reason instanceof Error ? reason.message : String(reason);
  }
  return null;
}

/** Files 面板数据：活动 run 的工具投影 ∪ 媒体 ∪ 文档。 */
export function useWorkbenchFiles(): UseWorkbenchFilesResult {
  const conversationId = useWorkspaceStore(state => state.conversationId);
  const events = useActivityStore(state => state.getEvents(conversationId ?? ''));
  const { runId } = useActiveRunId();

  const [media, setMedia] = useState<readonly MediaRow[]>(EMPTY_MEDIA);
  const [documents, setDocuments] = useState<readonly DocumentRow[]>(EMPTY_DOCUMENTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback((): void => { setReloadToken(token => token + 1); }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      // 两个端点互不依赖：allSettled 让一侧失败不吞掉另一侧的真实数据
      const [mediaResult, documentResult] = await Promise.allSettled([fetchMediaRows(), fetchDocumentRows()]);
      if (!active) return;
      setMedia(mediaResult.status === 'fulfilled' ? mediaResult.value : EMPTY_MEDIA);
      setDocuments(documentResult.status === 'fulfilled' ? documentResult.value : EMPTY_DOCUMENTS);
      setError(failureMessage([mediaResult, documentResult]));
      setLoading(false);
    })();
    return () => { active = false; };
  }, [reloadToken]);

  const files = useMemo(
    () => mergeWorkbenchFiles(projectFileActivity(events, runId ?? undefined), media, documents),
    [events, runId, media, documents],
  );

  return { files, refresh, loading, error };
}
