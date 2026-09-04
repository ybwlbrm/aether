import { loadConfig as loadSharedConfig, type AppConfig } from '@pacc/shared';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadOrCreateMasterKey } from '../lib/keystore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface BackendConfig extends AppConfig {
  encryptionKey: string;
  dbPath: string;
  allowedDirs: string[];
  allowedOrigins: string[];
  enableSwagger: boolean;
}

export async function loadBackendConfig(): Promise<BackendConfig> {
  const base = loadSharedConfig();
  // 统一数据目录到项目根目录 data/（与 DAL 的 JSON 文件同目录），避免双数据源不一致
  const dataDir = resolve(__dirname, '..', '..', '..', '..', 'data');
  // 若环境变量显式指定则优先
  const finalDataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : dataDir;

  // 环境变量 ENCRYPTION_KEY 优先（用于测试/部署覆盖）
  let encryptionKey = process.env.ENCRYPTION_KEY;
  let migratedFromLegacy = false;

  if (!encryptionKey) {
    const result = await loadOrCreateMasterKey(finalDataDir);
    encryptionKey = result.encryptionKey;
    migratedFromLegacy = result.migratedFromLegacy;
  }

  if (migratedFromLegacy) {
    console.log('[Config] Master key migrated from legacy plaintext storage to DPAPI');
  }

  return {
    ...base,
    dataDir: finalDataDir,
    encryptionKey,
    dbPath: resolve(finalDataDir, 'pacc.db'),
    allowedDirs: [
      resolve(finalDataDir),
      resolve('./workspace'),
      ...base.allowedDirs.map(d => resolve(d)),
    ],
    allowedOrigins: base.allowedOrigins,
    enableSwagger: base.enableSwagger,
  };
}

/**
 * 迁移数据库中存储的明文 API Key 为加密格式（SEC-012）。
 * 应在数据库初始化后、注册路由前调用一次。
 */
export async function migratePlaintextApiKeys(config: BackendConfig): Promise<void> {
  try {
    const { reencryptPlaintextKeys } = await import('../lib/crypto.js');
    await reencryptPlaintextKeys(config.encryptionKey);
  } catch (e) {
    // 迁移失败不阻断启动，但记录错误供排查
    console.error('[Config] API Key 明文迁移失败:', (e as Error).message);
  }
}