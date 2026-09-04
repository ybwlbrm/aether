import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import * as XLSX from 'xlsx';
import { exportDir, convertWithLibreOffice, parseCsv } from './utils.js';

/** 文档转换相关路由：docx/xlsx→PDF、csv↔xlsx */
export function registerDocRoutes(app: FastifyInstance, config: BackendConfig): void {
  // 文档转换在 /api/toolbox/convert 中处理
  // 这里导出供 convert 端点使用的核心函数
}

/** XLSX → CSV 转换 */
export async function xlsxToCsv(buf: Buffer): Promise<Buffer> {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return Buffer.from(XLSX.utils.sheet_to_csv(ws));
}

/** CSV → XLSX 转换 */
export async function csvToXlsx(text: string): Promise<Buffer> {
  const data = parseCsv(text);
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/** DOCX → PDF 转换（LibreOffice） */
export async function docxToPdf(buf: Buffer): Promise<Buffer> {
  return convertWithLibreOffice(buf, 'docx');
}

/** XLSX → PDF 转换（LibreOffice） */
export async function xlsxToPdf(buf: Buffer): Promise<Buffer> {
  return convertWithLibreOffice(buf, 'xlsx');
}

/** 导出目录工具 */
export { exportDir };