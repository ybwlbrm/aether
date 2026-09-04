/**
 * AES-256-GCM 加密/解密工具 — 用于加密存储 API Key
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** 从任意字符串派生 32 字节密钥（SHA-256） */
function deriveKey(encryptionKey: string): Buffer {
  return createHash('sha256').update(encryptionKey).digest();
}

/** 加密明文，返回 "enc:<iv_hex>:<tag_hex>:<ciphertext_hex>" 格式字符串 */
export function encrypt(plaintext: string, encryptionKey: string): string {
  if (!plaintext) return '';
  const key = deriveKey(encryptionKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** 解密 "enc:..." 格式字符串。非加密格式抛出错误（SEC-012）。 */
export function decrypt(ciphertext: string, encryptionKey: string): string {
  if (!ciphertext) return '';
  if (!ciphertext.startsWith('enc:')) {
    throw new Error('[Crypto] 拒绝解密明文值：数据库中存在未加密的 API Key，请先运行迁移重新加密。');
  }
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 4) {
      throw new Error('[Crypto] 无效的加密格式：预期 enc:iv:tag:ciphertext');
    }
    const iv = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const encrypted = Buffer.from(parts[3], 'hex');
    const key = deriveKey(encryptionKey);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('[Crypto]')) throw e;
    throw new Error(`[Crypto] 解密失败：${(e as Error).message}`);
  }
}

/** 判断字符串是否已加密 */
export function isEncrypted(value: string): boolean {
  return value.startsWith('enc:');
}

/**
 * 迁移数据库中存储的明文 API Key 为加密格式（SEC-012）。
 * 扫描 providers 表，将非 'enc:' 前缀的 apiKey 重新加密并写回。
 * 应在启动时、加载主密钥后、任何解密操作前调用一次。
 */
export async function reencryptPlaintextKeys(encryptionKey: string): Promise<number> {
  // 动态导入避免循环依赖
  const { getDb } = await import('../db/client.js');
  const { providers } = await import('../db/schema/index.js');
  const { eq } = await import('drizzle-orm');
  const { encrypt } = await import('./crypto.js');

  const db = getDb();
  const allProviders = db.select().from(providers).all();

  let migrated = 0;
  for (const p of allProviders) {
    if (!isEncrypted(p.apiKey)) {
      const encrypted = encrypt(p.apiKey, encryptionKey);
      db.update(providers).set({ apiKey: encrypted, updatedAt: new Date().toISOString() }).where(eq(providers.id, p.id)).run();
      migrated++;
    }
  }

  if (migrated > 0) {
    console.log(`[Crypto] 已迁移 ${migrated} 个明文 API Key 为加密存储`);
  }
  return migrated;
}