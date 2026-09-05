/**
 * Windows DPAPI-backed master key storage.
 * On Windows: uses CryptProtectData/CryptUnprotectData via koffi (CurrentUser scope).
 * On non-Windows: falls back to file storage with 0600 perms (documented limitation).
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { TypeObject, KoffiFunc } from 'koffi';

const DPAPI_BLOB_FILENAME = '.encryption_key.dpapi';
const LEGACY_KEY_FILENAME = '.encryption_key';

/**
 * koffi 绑定单例：DATA_BLOB 结构与 crypt32/kernel32 函数只声明一次。
 * koffi 全局按名称缓存类型，重复声明会抛 "Duplicate type name"。
 */
interface DpapiBindings {
  DATA_BLOB: TypeObject;
  CryptProtectData: KoffiFunc<(inPtr: unknown, descr: unknown, entropy: unknown, reserved: unknown, prompt: unknown, flags: number, outPtr: unknown) => boolean>;
  CryptUnprotectData: KoffiFunc<(inPtr: unknown, descr: unknown, entropy: unknown, reserved: unknown, prompt: unknown, flags: number, outPtr: unknown) => boolean>;
  LocalFree: KoffiFunc<(ptr: unknown) => unknown>;
}
let dpapiBindings: DpapiBindings | null = null;

async function getDpapiBindings(): Promise<DpapiBindings> {
  if (dpapiBindings) return dpapiBindings;
  const koffi = await import('koffi');
  const crypt32 = koffi.load('crypt32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const DATA_BLOB = koffi.struct('DATA_BLOB', {
    cbData: 'uint32',
    pbData: 'void *',
  });
  const CryptProtectData = crypt32.func(
    'CryptProtectData',
    'bool',
    ['void *', 'void *', 'void *', 'void *', 'void *', 'uint32', 'void *'],
  );
  const CryptUnprotectData = crypt32.func(
    'CryptUnprotectData',
    'bool',
    ['void *', 'void *', 'void *', 'void *', 'void *', 'uint32', 'void *'],
  );
  const LocalFree = kernel32.func('LocalFree', 'void *', ['void *']);
  dpapiBindings = { DATA_BLOB, CryptProtectData, CryptUnprotectData, LocalFree };
  return dpapiBindings;
}

/** Result of key loading operation */
export interface KeyLoadResult {
  /** The master encryption key (32 bytes as hex string) */
  encryptionKey: string;
  /** Whether a migration from legacy plaintext key occurred */
  migratedFromLegacy: boolean;
  /** Whether the stored blob was raw (fallback) and needs re-protection */
  rawFallback: boolean;
}

/**
 * Load or create the master encryption key.
 * - On Windows: uses DPAPI-protected blob (CurrentUser scope)
 * - On non-Windows: uses file with 0600 perms (fallback)
 * - Migrates legacy plaintext .encryption_key to DPAPI blob on first run
 */
export async function loadOrCreateMasterKey(dataDir: string): Promise<KeyLoadResult> {
  const dpapiPath = join(dataDir, DPAPI_BLOB_FILENAME);
  const legacyPath = join(dataDir, LEGACY_KEY_FILENAME);

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // 1. Try to load existing blob
  if (existsSync(dpapiPath)) {
    const storedBlob = readFileSync(dpapiPath);
    const { key, rawFallback } = await unprotectData(storedBlob);
    if (rawFallback) {
      // 自愈：旧版本 buggy fallback 写入的是原始字节，重新用真实 DPAPI 保护
      const protectedBlob = await protectData(Buffer.from(key, 'utf-8'));
      writeFileSync(dpapiPath, protectedBlob);
      console.warn('[Keystore] 检测到旧格式密钥（raw fallback），已重新用 DPAPI 保护');
    }
    return { encryptionKey: key, migratedFromLegacy: false, rawFallback };
  }

  // 2. Check for legacy plaintext key file (migration path)
  if (existsSync(legacyPath)) {
    const legacyKey = readFileSync(legacyPath, 'utf-8').trim();
    if (legacyKey.length > 0) {
      // Protect and store as DPAPI blob
      const protectedBlob = await protectData(Buffer.from(legacyKey, 'utf-8'));
      writeFileSync(dpapiPath, protectedBlob);
      // Delete legacy plaintext key file
      unlinkSync(legacyPath);
      console.log('[Keystore] Migrated legacy plaintext key to DPAPI-protected storage');
      return { encryptionKey: legacyKey, migratedFromLegacy: true, rawFallback: false };
    }
  }

  // 3. Generate new random key, protect, and store
  const newKey = randomBytes(32).toString('hex');
  const protectedBlob = await protectData(Buffer.from(newKey, 'utf-8'));
  writeFileSync(dpapiPath, protectedBlob);
  return { encryptionKey: newKey, migratedFromLegacy: false, rawFallback: false };
}

/**
 * Protect data using DPAPI (Windows) or fallback (non-Windows).
 * On Windows: CryptProtectData with CRYPTPROTECT_UI_FORBIDDEN, CurrentUser scope.
 * On non-Windows: returns data as-is (caller must handle file permissions).
 */
async function protectData(data: Buffer): Promise<Buffer> {
  if (platform() !== 'win32') {
    // Non-Windows: no DPAPI, return raw data (caller stores with 0600)
    return data;
  }

  try {
    // Lazy-load shared koffi bindings (declared once at module level)
    const koffi = await import('koffi');
    const { DATA_BLOB, CryptProtectData, LocalFree } = await getDpapiBindings();

    // Allocate input blob
    const inBlobPtr = koffi.alloc(DATA_BLOB, 1);
    koffi.encode(inBlobPtr, DATA_BLOB, {
      cbData: data.length,
      pbData: data,
    });

    // Allocate output blob (will be filled by CryptProtectData)
    const outBlobPtr = koffi.alloc(DATA_BLOB, 1);
    koffi.encode(outBlobPtr, DATA_BLOB, {
      cbData: 0,
      pbData: 0, // NULL pointer
    });

    // Flags: CRYPTPROTECT_UI_FORBIDDEN (0x1)
    const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    const ok = CryptProtectData(
      inBlobPtr,
      0, // szDataDescr (optional, NULL)
      0, // pOptionalEntropy (NULL)
      0, // pvReserved (NULL)
      0, // pPromptStruct (NULL)
      CRYPTPROTECT_UI_FORBIDDEN,
      outBlobPtr
    );

    if (!ok) {
      koffi.free(inBlobPtr);
      koffi.free(outBlobPtr);
      throw new Error('CryptProtectData failed');
    }

    // Read protected data from output blob
    const outBlob = koffi.decode(outBlobPtr, DATA_BLOB);
    const outCbData = outBlob.cbData;
    const outPbData = outBlob.pbData;

    // Copy the protected data
    // 黑屏修复（P0-1）：Electron 内置 Node（ELECTRON_RUN_AS_NODE fork）下
    // koffi.view() 会触发 FATAL ERROR: Error::New napi_get_last_error_info 崩溃，
    // 改用 koffi.decode(pbData, 'uint8', n) 数组读取 —— 系统 Node 与 Electron
    // 内置 Node 双运行时 roundtrip 实证通过。
    const protectedData = Buffer.alloc(outCbData);
    protectedData.set(Buffer.from(koffi.decode(outPbData, 'uint8', outCbData)));

    // Free output blob memory (allocated by CryptProtectData via LocalAlloc)
    LocalFree(outPbData);

    // Free our allocated structs
    koffi.free(inBlobPtr);
    koffi.free(outBlobPtr);

    return protectedData;
  } catch (e) {
    // If DPAPI unavailable (shouldn't happen on Windows), fall back to raw
    console.warn('[Keystore] DPAPI protect failed, falling back to raw storage:', (e as Error).message);
    return data;
  }
}

/**
 * Unprotect data using DPAPI (Windows) or fallback (non-Windows).
 * On Windows: CryptUnprotectData with CurrentUser scope.
 * On non-Windows: returns data as-is.
 */
async function unprotectData(protectedData: Buffer): Promise<{ key: string; rawFallback: boolean }> {
  if (platform() !== 'win32') {
    // Non-Windows: data stored as raw
    return { key: protectedData.toString('utf-8'), rawFallback: true };
  }

  try {
    const koffi = await import('koffi');
    const { DATA_BLOB, CryptUnprotectData, LocalFree } = await getDpapiBindings();

    const inBlobPtr = koffi.alloc(DATA_BLOB, 1);
    koffi.encode(inBlobPtr, DATA_BLOB, {
      cbData: protectedData.length,
      pbData: protectedData,
    });

    const outBlobPtr = koffi.alloc(DATA_BLOB, 1);
    koffi.encode(outBlobPtr, DATA_BLOB, {
      cbData: 0,
      pbData: 0, // NULL pointer
    });

    const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    const ok = CryptUnprotectData(
      inBlobPtr,
      0, // ppszDataDescr (optional, NULL)
      0, // pOptionalEntropy (NULL)
      0, // pvReserved (NULL)
      0, // pPromptStruct (NULL)
      CRYPTPROTECT_UI_FORBIDDEN,
      outBlobPtr
    );

    if (!ok) {
      koffi.free(inBlobPtr);
      koffi.free(outBlobPtr);
      // 自愈路径：旧版本 fallback 写入了原始字节（非 DPAPI 密文），按 raw 读取以恢复密钥
      console.warn('[Keystore] DPAPI 解保护失败（可能为旧格式原始密钥），尝试按原始字节恢复');
      return { key: protectedData.toString('utf-8').trim(), rawFallback: true };
    }

    const outBlob = koffi.decode(outBlobPtr, DATA_BLOB);
    const outCbData = outBlob.cbData;
    const outPbData = outBlob.pbData;

    // 黑屏修复（P0-1）：同 protectData —— Electron 内置 Node 下 koffi.view() 崩溃，
    // 改用 koffi.decode('uint8', n) 数组读取输出 blob
    const unprotectedData = Buffer.from(koffi.decode(outPbData, 'uint8', outCbData));

    // Free output blob memory (allocated by CryptUnprotectData via LocalAlloc)
    LocalFree(outPbData);

    koffi.free(inBlobPtr);
    koffi.free(outBlobPtr);

    return { key: unprotectedData.toString('utf-8'), rawFallback: false };
  } catch (e) {
    throw new Error(`DPAPI unprotect failed: ${(e as Error).message}`);
  }
}