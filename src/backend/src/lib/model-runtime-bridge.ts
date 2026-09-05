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
 * No Fastify/SSE imports — pure TypeScript over drizzle sql-js.
 */

import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import * as schema from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import {
  buildModelRuntime,
  registerProviderModels,
  type LegacyProviderConfig,
} from '../core/models/index.js';
import { ModelRegistry } from '../core/models/index.js';

type Db = SQLJsDatabase<typeof schema>;

/** Read a provider row and shape it into the LegacyProviderConfig the core factory expects */
function rowToLegacyProvider(row: typeof schema.providers.$inferSelect): LegacyProviderConfig {
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
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    apiKey: row.apiKey,
    baseUrl: row.baseUrl ?? '',
    defaultModel: models[0] ?? '',
    models,
    capabilities,
  };
}

/**
 * Build a ModelRuntime for the given provider id from the providers table.
 * Returns null when the provider does not exist.
 */
export function buildRuntimeForProvider(
  db: Db,
  providerId: string,
): { runtime: ReturnType<typeof buildModelRuntime>; config: LegacyProviderConfig } | null {
  const row = db.select().from(schema.providers).where(eq(schema.providers.id, providerId)).get();
  if (!row) return null;
  const config = rowToLegacyProvider(row);
  return { runtime: buildModelRuntime(config), config };
}

/**
 * Convenience: build a runtime AND register its models into the given registry.
 * Returns the runtime, or null when the provider is unknown.
 */
export function buildRuntimeAndRegister(
  db: Db,
  registry: ModelRegistry,
  providerId: string,
): ReturnType<typeof buildModelRuntime> | null {
  const built = buildRuntimeForProvider(db, providerId);
  if (!built) return null;
  registerProviderModels(registry, built.config);
  return built.runtime;
}

/**
 * Build runtimes for ALL providers in the table, registering each provider's
 * models into the registry. Returns a Map<providerId, runtime>.
 */
export function buildAllRuntimes(
  db: Db,
  registry: ModelRegistry,
): Map<string, ReturnType<typeof buildModelRuntime>> {
  const rows = db.select().from(schema.providers).all();
  const runtimes = new Map<string, ReturnType<typeof buildModelRuntime>>();
  for (const row of rows) {
    const config = rowToLegacyProvider(row);
    const runtime = buildModelRuntime(config);
    registerProviderModels(registry, config);
    runtimes.set(row.id, runtime);
  }
  return runtimes;
}