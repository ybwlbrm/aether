/**
 * Model Runtime Bridge — Aether 2.0 Phase 4 migration seam
 *
 * Connects the LEGACY provider configuration stored in the `providers` table
 * to the NEW core ModelRuntime layer without touching the existing handlers.
 *
 * Legacy call sites (orchestration.ts etc.) can progressively switch from
 * `fetchWithRetry(url, {...})` to `runtime.complete()/stream()` by resolving a
 * runtime through this bridge — the old path keeps working untouched while the
 * new runtime is wired in behind it (Adapter pattern, §2.1 不推倒重来).
 *
 * P0-007：本模块同时是 **ProviderRuntimeRegistry** 的宿主 —— providerId →
 * { runtime, transport, circuitBreaker, retryPolicy } 的进程级映射。熔断器必须
 * 跨请求复用，否则每请求新建实例 → consecutiveFailures 永远到不了阈值，
 * CIRCUIT_OPEN 成为死代码。
 *
 * No Fastify/SSE imports — pure TypeScript over drizzle sql-js.
 */

import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import * as schema from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import {
  buildModelRuntime,
  registerProviderModels,
  createCircuitBreaker,
  createRetryPolicy,
  type CircuitBreaker,
  type LegacyProviderConfig,
  type ModelRuntime,
  type RetryPolicy,
} from '../core/models/index.js';
import { ModelRegistry } from '../core/models/index.js';
import { decrypt, isEncrypted } from './crypto.js';
import { ProviderCredentialError } from '../core/errors/index.js';

type Db = SQLJsDatabase<typeof schema>;

/**
 * Provider 级运行时条目 —— 规范要求的 ProviderRuntime 概念：
 * 一个 providerId 对应一份 transport / retryPolicy / circuitBreaker。
 */
export interface ProviderRuntimeEntry {
  /** 绑定了 provider 级熔断/重试的 ModelRuntime */
  readonly runtime: ModelRuntime;
  /** 构建该 runtime 时使用的（已解密）provider 配置 */
  readonly config: LegacyProviderConfig;
  /** provider 级熔断器（同一 providerId 的所有请求共享） */
  readonly circuitBreaker: CircuitBreaker;
  /** provider 级重试策略 */
  readonly retryPolicy: RetryPolicy;
}

/**
 * providerId → ProviderRuntimeEntry。
 *
 * 失效策略：仅当"连接相关配置"（type / baseUrl / apiKey）变化时重建，
 * 避免 API Key 轮换后继续用陈旧凭据；模型列表变化不影响 runtime 本身
 * （注册由 registerProviderModels 每次调用完成，不走缓存）。
 */
const runtimeRegistry = new Map<string, ProviderRuntimeEntry>();

/** 连接相关配置指纹 —— 变化即重建 runtime（models/capabilities 不参与） */
function sameConnection(cached: LegacyProviderConfig, next: LegacyProviderConfig): boolean {
  return (
    cached.type === next.type &&
    cached.baseUrl === next.baseUrl &&
    cached.apiKey === next.apiKey
  );
}

/**
 * ProviderRuntimeRegistry：按 providerId 取或建 provider 级运行时。
 *
 * 凭据解密失败会在调用本函数**之前**抛出（rowToLegacyProvider），因此失败
 * 路径永不写入缓存 —— 凭据修好后同一 provider 仍能正常构建。
 */
export function getOrCreateProviderRuntime(config: LegacyProviderConfig): ProviderRuntimeEntry {
  const cached = runtimeRegistry.get(config.id);
  if (cached && sameConnection(cached.config, config)) return cached;

  const circuitBreaker = createCircuitBreaker();
  const retryPolicy = createRetryPolicy();
  const entry: ProviderRuntimeEntry = {
    runtime: buildModelRuntime(config, { circuitBreaker, retryPolicy }),
    config,
    circuitBreaker,
    retryPolicy,
  };
  runtimeRegistry.set(config.id, entry);
  return entry;
}

/** 清空 ProviderRuntimeRegistry（provider 配置变更后 / 测试隔离用） */
export function resetProviderRuntimeRegistry(): void {
  runtimeRegistry.clear();
}

/**
 * Read a provider row and shape it into the LegacyProviderConfig the core factory expects.
 * P0-13：数据库保存的是 AES-256-GCM 密文 —— 必须在 bridge 层解密后才能交给
 * ModelRuntime 作为 Authorization Bearer；否则密文会被直接当作 API Key 发送（必然 401）。
 * 传入 encryptionKey 时自动解密；不传（或值不是密文格式）则原样透传（兼容旧明文数据/测试）。
 */
function rowToLegacyProvider(
  row: typeof schema.providers.$inferSelect,
  encryptionKey?: string,
): LegacyProviderConfig {
  let models: string[] = [];
  let capabilities: string[] = [];
  try {
    const parsed = JSON.parse(row.models) as unknown;
    if (Array.isArray(parsed)) models = parsed.map(String);
  } catch {
    models = [];
  }
  try {
    const parsed = JSON.parse(row.capabilities ?? '["text"]') as unknown;
    if (Array.isArray(parsed)) capabilities = parsed.map(String);
  } catch {
    capabilities = ['text'];
  }
  let apiKey = row.apiKey;
  if (encryptionKey && isEncrypted(apiKey)) {
    try {
      apiKey = decrypt(apiKey, encryptionKey);
    } catch (cause) {
      // P0-13b/P0-14 修复：解密失败 → ProviderCredentialError 停止执行。
      // 绝不把密文当 API Key 继续发送（否则必然 401，且用户无法定位是密钥损坏）。
      // 单 provider 请求（buildRuntimeForProvider）会抛给调用方；
      // buildAllRuntimes 在循环内 catch 后跳过损坏 provider。
      throw new ProviderCredentialError(row.name || row.id, cause);
    }
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    apiKey,
    baseUrl: row.baseUrl ?? '',
    defaultModel: models[0] ?? '',
    models,
    capabilities,
  };
}

/**
 * Build a ModelRuntime for the given provider id from the providers table.
 * Returns null when the provider does not exist.
 * P0-13：需要 config.encryptionKey 才能正确解密 provider 的 API Key。
 * P0-007：经 ProviderRuntimeRegistry 返回 provider 级实例（同一 providerId
 * 复用同一 runtime/transport/circuitBreaker），使熔断状态跨请求累积。
 */
export function buildRuntimeForProvider(
  db: Db,
  providerId: string,
  encryptionKey?: string,
): ProviderRuntimeEntry | null {
  const row = db.select().from(schema.providers).where(eq(schema.providers.id, providerId)).get();
  if (!row) return null;
  // 解密失败在此抛出（ProviderCredentialError）—— 缓存不受影响
  const config = rowToLegacyProvider(row, encryptionKey);
  return getOrCreateProviderRuntime(config);
}

/**
 * Convenience: build a runtime AND register its models into the given registry.
 * Returns the runtime, or null when the provider is unknown.
 * P0-007：模型注册不进缓存（registry 由调用方持有，可随时新建），
 * 但 runtime 实例与 buildRuntimeForProvider 共享同一个 provider 级条目。
 */
export function buildRuntimeAndRegister(
  db: Db,
  registry: ModelRegistry,
  providerId: string,
  encryptionKey?: string,
): ModelRuntime | null {
  const built = buildRuntimeForProvider(db, providerId, encryptionKey);
  if (!built) return null;
  registerProviderModels(registry, built.config);
  return built.runtime;
}

/**
 * Build runtimes for ALL providers in the table, registering each provider's
 * models into the registry. Returns a Map<providerId, runtime>.
 *
 * P0-007：返回值仍每次新建 Map（调用方按请求使用），但其中的 runtime 实例
 * 全部来自 ProviderRuntimeRegistry —— 丢弃返回值不会导致熔断器重建。
 */
export function buildAllRuntimes(
  db: Db,
  registry: ModelRegistry,
  encryptionKey?: string,
): Map<string, ModelRuntime> {
  const rows = db.select().from(schema.providers).all();
  const runtimes = new Map<string, ModelRuntime>();
  for (const row of rows) {
    try {
      const config = rowToLegacyProvider(row, encryptionKey);
      const entry = getOrCreateProviderRuntime(config);
      registerProviderModels(registry, config);
      runtimes.set(row.id, entry.runtime);
    } catch (err) {
      // P0-14: 单个 provider 凭据损坏不应拖垮全部 provider 的 runtime 构建
      const name = row.name || row.id;
      console.warn(`[ModelRuntimeBridge] 跳过凭据损坏的 provider "${name}":`, err instanceof Error ? err.message : String(err));
    }
  }
  return runtimes;
}