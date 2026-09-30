/**
 * T21 `useWorkbenchPreview` —— Preview 面板：文档与媒体的产物预览。
 *
 * ## 数据源
 *   - 文档：`GET /api/documents`（解析见 asset-rows.ts）
 *   - 媒体：`GET /api/media`
 *   - 文档地址：`api.documentDownloadUrl(id)` —— **client 里唯一返回 URL 字符串而非请求的
 *     方法**（api/client.ts:346，同步拼接 `/api/documents/<id>/download`），因此预览
 *     取址不需要额外往返，也不经过 requestResult。
 *
 * ## 诚实性
 * 媒体行 `url` 为空串表示后端 `path` 为空（没有可加载文件）—— 保留该条目并如实透出空串，
 * 由 UI 决定渲染占位还是隐藏，绝不替换成本地拼的假地址。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import {
  fetchDocumentRows,
  fetchMediaRows,
  type DocumentKind,
  type DocumentRow,
  type MediaKind,
  type MediaRow,
} from './asset-rows';

/** 预览类别：文档按 ppt/doc，媒体按 image/video/audio（两个来源的闭集并集）。 */
export type PreviewKind = DocumentKind | MediaKind;

export interface PreviewItem {
  readonly id: string;
  readonly kind: PreviewKind;
  readonly name: string;
  /** 可直接作为 src 的地址；媒体可能为空串（后端无文件路径） */
  readonly url: string;
  readonly updatedAt: string;
  readonly size: number;
  readonly mimeType: string;
}

export interface UseWorkbenchPreviewResult {
  readonly items: readonly PreviewItem[];
  /** 选中产物；传 null 关闭预览 */
  readonly open: (id: string | null) => void;
  readonly current: PreviewItem | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/** 媒体 + 文档 → 预览条目（按更新时间倒序，缺时间的沉底）。 */
export function buildPreviewItems(
  media: readonly MediaRow[],
  documents: readonly DocumentRow[],
): PreviewItem[] {
  const items: PreviewItem[] = [
    ...documents.map(item => ({
      id: item.id,
      kind: item.kind,
      name: item.name,
      url: api.documentDownloadUrl(item.id),
      updatedAt: item.updatedAt,
      size: 0,
      mimeType: '',
    })),
    ...media.map(item => ({
      id: item.id,
      kind: item.kind,
      name: item.name,
      url: item.url,
      updatedAt: item.createdAt,
      size: item.size,
      mimeType: item.mimeType,
    })),
  ];
  return items.sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name),
  );
}

const EMPTY_ROWS: readonly MediaRow[] = [];
const EMPTY_DOCUMENT_ROWS: readonly DocumentRow[] = [];

/** Preview 面板数据：产物列表 + 当前预览项。 */
export function useWorkbenchPreview(): UseWorkbenchPreviewResult {
  const [media, setMedia] = useState<readonly MediaRow[]>(EMPTY_ROWS);
  const [documents, setDocuments] = useState<readonly DocumentRow[]>(EMPTY_DOCUMENT_ROWS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      // 两个端点互不依赖：allSettled 让一侧失败不吞掉另一侧的真实数据
      const [mediaResult, documentResult] = await Promise.allSettled([fetchMediaRows(), fetchDocumentRows()]);
      if (!active) return;
      setMedia(mediaResult.status === 'fulfilled' ? mediaResult.value : EMPTY_ROWS);
      setDocuments(documentResult.status === 'fulfilled' ? documentResult.value : EMPTY_DOCUMENT_ROWS);
      const failure = [mediaResult, documentResult].find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure !== undefined) {
        const reason: unknown = failure.reason;
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  const items = useMemo(() => buildPreviewItems(media, documents), [media, documents]);
  const current = useMemo(
    () => items.find(item => item.id === selectedId) ?? null,
    [items, selectedId],
  );
  // 不直接把 setState 交给 UI：setSelectedId 还会把函数入参当 updater 用
  const open = useCallback((id: string | null): void => { setSelectedId(id); }, []);

  return { items, open, current, loading, error };
}
