/**
 * T21 `useWorkbenchFiles` —— Files 面板的三源合并契约（TDD：先 RED）。
 *
 * 三个数据源：T9 `projectFileActivity`（工具改过的文件）∪ `api.getMedia()` ∪ `api.getDocuments()`。
 * 合并的不变量：**按 path 唯一** —— 同一路径同时出现在工具投影与媒体/文档里时只留一行。
 */
import { describe, expect, it } from 'vitest';

import type { FileActivityEntry } from '../../store/projections';
import type { DocumentRow, MediaRow } from './asset-rows';
import { mergeWorkbenchFiles } from './useWorkbenchFiles';

const TS = '2026-01-01T00:00:00.000Z';

function toolEntry(partial: Partial<FileActivityEntry> & Pick<FileActivityEntry, 'path'>): FileActivityEntry {
  return { op: 'write', at: TS, truncated: false, ...partial };
}

function mediaRow(partial: Partial<MediaRow> & Pick<MediaRow, 'id' | 'name'>): MediaRow {
  return { kind: 'image', url: '/api/media/file/a.png', mimeType: 'image/png', size: 10, createdAt: TS, ...partial };
}

function documentRow(partial: Partial<DocumentRow> & Pick<DocumentRow, 'id' | 'name'>): DocumentRow {
  return { kind: 'ppt', status: 'completed', updatedAt: TS, createdAt: TS, ...partial };
}

describe('mergeWorkbenchFiles', () => {
  it('合并三个数据源并按更新时间倒序', () => {
    const rows = mergeWorkbenchFiles(
      [toolEntry({ path: 'src/app.ts', at: '2026-01-03T00:00:00.000Z' })],
      [mediaRow({ id: 'm1', name: 'shot.png', createdAt: '2026-01-02T00:00:00.000Z' })],
      [documentRow({ id: 'd1', name: 'deck.pptx', updatedAt: '2026-01-01T00:00:00.000Z' })],
    );

    expect(rows.map(r => r.path)).toEqual(['src/app.ts', 'shot.png', 'deck.pptx']);
    expect(rows.map(r => r.source)).toEqual(['tool', 'media', 'document']);
  });

  it('同一 path 出现在工具投影与媒体里时只留一行（工具来源优先，时间取较晚者）', () => {
    const rows = mergeWorkbenchFiles(
      [toolEntry({ path: 'shot.png', at: '2026-01-01T00:00:00.000Z' })],
      [mediaRow({ id: 'm1', name: 'shot.png', createdAt: '2026-01-05T00:00:00.000Z' })],
      [],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('tool');
    expect(rows[0]?.updatedAt).toBe('2026-01-05T00:00:00.000Z');
  });

  it('工具投影内的同路径多次操作去重，且保留被裁剪标记', () => {
    const rows = mergeWorkbenchFiles(
      [
        toolEntry({ path: 'src/app.ts', op: 'read', at: '2026-01-01T00:00:00.000Z' }),
        toolEntry({ path: 'src/app.ts', op: 'edit', at: '2026-01-02T00:00:00.000Z', truncated: true }),
      ],
      [],
      [],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('edit');
    expect(rows[0]?.truncated).toBe(true);
  });

  it('三源皆空时返回空列表（不造默认行）', () => {
    expect(mergeWorkbenchFiles([], [], [])).toEqual([]);
  });
});
