/**
 * Provider 解析工具 — 从 SQLite 数据库读取 AI Provider 配置
 * 这是整个系统中唯一解析 provider 的入口，确保数据源一致（SQLite，非 settings.json）
 */
import { getDb } from '../db/client.js';
import { providers } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { decrypt } from './crypto.js';

export interface ResolvedProvider {
  id: string;
  name: string;
  type: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  capabilities: string[];
  /** Wave0-PV: DB isDefault 映射（此前未映射，导致 (p as any).isDefault 永远 undefined） */
  isDefault: boolean;
}

/**
 * 按 provider ID 从 SQLite 查询 provider
 * P0-1 修复：encryptionKey 由调用方传入（来自 config.encryptionKey），
 *           不再自行派生 pacc-key-<dataDir>，确保与写入时使用的密钥一致。
 */
export function getProviderById(id: string, encryptionKey: string): ResolvedProvider | null {
  const db = getDb();
  const row = db.select().from(providers).where(eq(providers.id, id)).get();
  if (!row) return null;
  return rowToProvider(row, encryptionKey);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 同步读取 settings.json 中的 defaultProviders 配置。
 * 不能用 dal.ts 的 getSettings()（async），因为 getProviderByCapability 是同步函数。
 */
function readDefaultProvidersSync(): Record<string, string> {
  try {
    const dataDir = process.env.DATA_DIR || resolve(__dirname, '..', '..', '..', '..', 'data');
    const settingsPath = resolve(dataDir, 'settings.json');
    if (!existsSync(settingsPath)) return {};
    const raw = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);
    return (settings && typeof settings.defaultProviders === 'object') ? settings.defaultProviders : {};
  } catch {
    return {};
  }
}

/**
 * 按 capability 查询 provider
 * P0-1 修复：encryptionKey 由调用方传入（来自 config.encryptionKey）。
 */
/**
 * Wave0-PV: 从已解析 provider 列表中选择匹配 capability 的 provider（纯函数，可单测）。
 * 规则（P1-19/20/21 修复）：
 * 1. 先按 capability 过滤 —— 能力不符的 provider 绝不被当作该能力返回
 * 2. 无匹配能力 → null（拒绝悄悄 fallback 到任意 provider）
 * 3. settings defaultProviders[capability] 仅在过滤结果内生效
 * 4. isDefault 标记优先（DB 主源，P1-19 修复后真实生效）
 */
export function selectProviderByCapability(
  all: ResolvedProvider[],
  capability: 'image' | 'video' | 'text' | 'audio',
  defaultIds: Record<string, string>,
): ResolvedProvider | null {
  if (all.length === 0) return null;
  const filtered = all.filter(p => Array.isArray(p.capabilities) && p.capabilities.includes(capability));
  if (filtered.length === 0) return null;
  const defaultId = defaultIds[capability];
  if (defaultId) {
    const found = filtered.find(p => p.id === defaultId);
    if (found) return found;
  }
  const defaultProvider = filtered.find(p => p.isDefault);
  if (defaultProvider) return defaultProvider;
  return filtered[0];
}

export function getProviderByCapability(
  capability: 'image' | 'video' | 'text' | 'audio',
  encryptionKey: string,
): ResolvedProvider | null {
  const db = getDb();
  const all = db.select().from(providers).all().map(r => rowToProvider(r, encryptionKey));
  return selectProviderByCapability(all, capability, readDefaultProvidersSync());
}

/**
 * 获取第一个可用的 provider（通用回退）
 * P0-1 修复：encryptionKey 由调用方传入。
 */
export function getFirstAvailableProvider(encryptionKey: string): ResolvedProvider | null {
  const db = getDb();
  const all = db.select().from(providers).all().map(r => rowToProvider(r, encryptionKey));
  if (all.length === 0) return null;
  return all.find(p => p.apiKey && p.apiKey !== '***encrypted***') || all[0];
}

/**
 * P0-1 修复：rowToProvider 接收 encryptionKey 参数，不再自行派生密钥。
 */
/** Provider 数据库行类型 */
interface ProviderRow {
  id: string; name: string; type: string; apiKey: string;
  baseUrl: string | null; models: string; capabilities: string | null;
  isDefault: number | boolean | null; createdAt: string; updatedAt: string;
}

function rowToProvider(row: ProviderRow, encryptionKey: string): ResolvedProvider {
  let models: string[] = [];
  try { models = JSON.parse(row.models || '[]'); } catch { models = [row.models || 'gpt-4o'].filter(Boolean); }
  let capabilities: string[] = [];
  try { capabilities = JSON.parse(row.capabilities || '["text"]'); } catch { capabilities = ['text']; }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    apiKey: decrypt(row.apiKey, encryptionKey),
    baseUrl: (row.baseUrl || '').trim() || 'https://api.openai.com/v1',
    defaultModel: models[0] || 'gpt-4o',
    models,
    capabilities,
    // Wave0-PV: 映射 isDefault（DB 存 0/1 或 boolean）
    isDefault: row.isDefault === 1 || row.isDefault === true,
  };
}

/**
 * provider 是否支持 thinking 参数（深度思考模式）。
 * 启发式：baseUrl 含 deepseek 域名 或 模型名匹配 reasoner/r1/thinking 模式。
 */
export function providerSupportsThinking(provider: Pick<ResolvedProvider, 'baseUrl' | 'defaultModel' | 'models'> | null, model?: string): boolean {
  if (!provider) return false;
  const baseUrl = (provider.baseUrl || '').toLowerCase();
  const models = [...(provider.models || []), provider.defaultModel || '', model || ''];
  const joined = models.join(' ').toLowerCase();
  if (baseUrl.includes('deepseek')) return true;
  const pattern = /\b(deepseek|reasoner|r1|thinking)\b/i;
  return pattern.test(joined);
}