import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', '..', 'data'));

let dataDirEnsured = false;
export function ensureDataDir(): void {
  if (dataDirEnsured) return;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  dataDirEnsured = true;
}

// ---- Atomic Read/Write ----
export async function atomicRead<T>(filePath: string, defaultValue: T): Promise<T> {
  ensureDataDir();
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as any).code === 'ENOENT') {
      // File doesn't exist — create with default
      await atomicWrite(filePath, defaultValue);
      return defaultValue;
    }
    // JSON parse error — file corrupted, reset to default
    console.warn(`[DAL] Corrupted file ${filePath}, resetting to default`);
    await atomicWrite(filePath, defaultValue);
    return defaultValue;
  }
}

export async function atomicWrite<T>(filePath: string, data: T): Promise<void> {
  ensureDataDir();
  const tmpPath = filePath + '.tmp.' + randomUUID();
  const json = JSON.stringify(data, null, 2);
  await fsp.writeFile(tmpPath, json, 'utf-8');
  await fsp.rename(tmpPath, filePath);
}

// P2-2: per-file mutex — 防止并发 read-modify-write 丢失更新
const fileLocks = new Map<string, Promise<void>>();
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  // 用 .catch(() => {}) 确保前一个操作失败不阻塞后续
  const prev = (fileLocks.get(filePath) || Promise.resolve()).catch(() => {});
  let release!: () => void;
  const next = new Promise<void>(r => { release = r; });
  // P0-1 修复：保存同一个 Promise 引用，确保 finally 中的 === 比较始终命中，
  // fileLocks Map 不会因每次调用生成新 Promise 而永久泄漏条目
  const nextPromise = prev.then(() => next);
  fileLocks.set(filePath, nextPromise);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (fileLocks.get(filePath) === nextPromise) {
      fileLocks.delete(filePath);
    }
  }
}