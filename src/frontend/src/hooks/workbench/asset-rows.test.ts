/**
 * T21 `asset-rows` —— 后端 media / documents 行 → 前端类型化行的边界解析（TDD：先 RED）。
 *
 * `api.getMedia()` / `api.getDocuments()` 的声明返回类型**未标注元素类型**（client.ts 没写
 * DTO），因此这层解析是 Workbench 唯一的类型化入口，必须锁死三件事：
 *   ① 不可用行（无 id / name）被**丢弃**，而不是补默认值造出行
 *   ② 缺失字段归一到空串 / 0（消费方不必到处判空）
 *   ③ `type` 落在后端闭集外时回落到闭集内的值，绝不把运行时字符串带进类型
 */
import { describe, expect, it } from 'vitest';

import { parseDocumentRows, parseMediaRows } from './asset-rows';

describe('parseMediaRows', () => {
  it('读出后端拼好的服务路径与媒体字段', () => {
    const rows = parseMediaRows([
      { id: 'm1', type: 'video', name: 'clip.mp4', url: '/api/media/file/clip.mp4', mimeType: 'video/mp4', size: 2048, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);

    expect(rows).toEqual([
      { id: 'm1', kind: 'video', name: 'clip.mp4', url: '/api/media/file/clip.mp4', mimeType: 'video/mp4', size: 2048, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('丢弃无 id / name 的行（UI 无法定位的行不算数据）', () => {
    expect(parseMediaRows([{ name: 'a.png' }, { id: 'm2' }, null, 'x', { id: 'm3', name: 'b.png' }])).toHaveLength(1);
  });

  it('非数组输入返回空列表（不把异常响应读成数据）', () => {
    expect(parseMediaRows(undefined)).toEqual([]);
    expect(parseMediaRows({ items: [] })).toEqual([]);
  });

  it('缺失字段归一到空串 / 0，url 为空串即"后端无文件路径"', () => {
    const [row] = parseMediaRows([{ id: 'm1', name: 'a.png' }]);

    expect(row).toEqual({ id: 'm1', kind: 'image', name: 'a.png', url: '', mimeType: '', size: 0, createdAt: '' });
  });

  it('闭集外的 type 落到闭集内的默认值（不把运行时字符串带进类型）', () => {
    const [row] = parseMediaRows([{ id: 'm1', name: 'a.png', type: 'hologram' }]);

    expect(row?.kind).toBe('image');
  });
});

describe('parseDocumentRows', () => {
  it('读出文档闭集类型与时间', () => {
    const rows = parseDocumentRows([
      { id: 'd1', type: 'ppt', name: 'deck.pptx', status: 'completed', updatedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);

    expect(rows[0]).toEqual({ id: 'd1', kind: 'ppt', name: 'deck.pptx', status: 'completed', updatedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' });
  });

  it('闭集外的 type 落到 doc', () => {
    expect(parseDocumentRows([{ id: 'd1', name: 'x.pdf', type: 'pdf' }])[0]?.kind).toBe('doc');
  });

  it('缺 status 时归一到空串（不编造 "completed"）', () => {
    expect(parseDocumentRows([{ id: 'd1', name: 'x.docx', type: 'doc' }])[0]?.status).toBe('');
  });
});
