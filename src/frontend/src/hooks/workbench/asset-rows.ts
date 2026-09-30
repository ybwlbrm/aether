/**
 * T21 边界解析：后端 media / documents 行 → 前端类型化行。
 *
 * ## 本文件存在的唯一理由
 * `api.getMedia()` / `api.getDocuments()`（api/client.ts:320,342）声明的返回类型
 * **未标注元素类型**（client.ts 没为这两个端点写 DTO）。Workbench 的 Files / Preview 两个 tab
 * 都消费它们，若各自写一份 `as` 断言，两个 tab 就会有两份可能漂移的形状。
 * 因此把 `unknown → 行` 的解析收敛到本文件：**边界解析一次，内部零断言**。
 *
 * 行的字段取自后端 schema（src/backend/src/db/schema/index.ts:87,98）与其路由的拼装：
 *   GET /api/media     = mediaAssets 行 + `url`（`/api/media/file/<文件名>`，无路径时为空串）
 *   GET /api/documents = documents 行
 * 解析策略是**丢弃不可用行**（无 id / name 的行 UI 无法定位），而不是补默认值造出行。
 */
import { api } from '../../api/client';

/** 媒体类别（后端 mediaAssets.type 的闭集） */
export type MediaKind = 'image' | 'video' | 'audio';

/** 文档类别（后端 documents.type 的闭集） */
export type DocumentKind = 'ppt' | 'doc';

/** 一行媒体资产（只描述 Workbench 实际消费的字段） */
export interface MediaRow {
  readonly id: string;
  readonly kind: MediaKind;
  readonly name: string;
  /** 后端拼好的服务路径；`path` 为空时后端返回空串 —— 诚实表示"没有可加载文件"。 */
  readonly url: string;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: string;
}

/** 一行文档（只描述 Workbench 实际消费的字段） */
export interface DocumentRow {
  readonly id: string;
  readonly kind: DocumentKind;
  readonly name: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly createdAt: string;
}

const MEDIA_KINDS: readonly MediaKind[] = ['image', 'video', 'audio'];
const DOCUMENT_KINDS: readonly DocumentKind[] = ['ppt', 'doc'];

/** 非空对象（排除数组与 null）—— Record 视图的类型守卫。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.some(candidate => candidate === value);
}

/** 数组归一为 `unknown[]`（非数组一律空），元素保持 unknown，不引入未标注类型。 */
function toRows(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseMediaRow(value: unknown): MediaRow | null {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  const name = readString(value, 'name');
  if (id === '' || name === '') return null;
  const type = value['type'];
  return {
    id,
    name,
    kind: isOneOf(type, MEDIA_KINDS) ? type : 'image',
    url: readString(value, 'url'),
    mimeType: readString(value, 'mimeType'),
    size: readNumber(value, 'size'),
    createdAt: readString(value, 'createdAt'),
  };
}

function parseDocumentRow(value: unknown): DocumentRow | null {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  const name = readString(value, 'name');
  if (id === '' || name === '') return null;
  const type = value['type'];
  return {
    id,
    name,
    kind: isOneOf(type, DOCUMENT_KINDS) ? type : 'doc',
    status: readString(value, 'status'),
    updatedAt: readString(value, 'updatedAt'),
    createdAt: readString(value, 'createdAt'),
  };
}

function parseRows<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  const rows: T[] = [];
  for (const item of toRows(value)) {
    const row = parse(item);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** `unknown` → 媒体行（丢弃不可用行） */
export function parseMediaRows(value: unknown): MediaRow[] {
  return parseRows(value, parseMediaRow);
}

/** `unknown` → 文档行（丢弃不可用行） */
export function parseDocumentRows(value: unknown): DocumentRow[] {
  return parseRows(value, parseDocumentRow);
}

/** GET /api/media → 媒体行。client 的声明未标注元素类型，此处拓宽到 `unknown[]` 后再解析。 */
export async function fetchMediaRows(): Promise<MediaRow[]> {
  const raw: unknown[] = await api.getMedia();
  return parseMediaRows(raw);
}

/** GET /api/documents → 文档行 */
export async function fetchDocumentRows(): Promise<DocumentRow[]> {
  const raw: unknown[] = await api.getDocuments();
  return parseDocumentRows(raw);
}
