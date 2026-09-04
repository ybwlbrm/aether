import { TEXT_EXTENSIONS, TEXT_BASENAMES } from './constants.js';

/** 判断是否为文本文件 */
export function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (!lower.includes('.')) {
    return TEXT_BASENAMES.has(lower) || lower.startsWith('dockerfile') || lower.startsWith('makefile');
  }
  const ext = lower.split('.').pop() || '';
  return TEXT_EXTENSIONS.has(ext);
}