/**
 * Prompt Registry（§20-29 统一 Prompt 来源 + §27/P0-10 持久化）
 *
 * 问题：此前 customPrompts Map 定义在 orchestration.ts 与 index.ts 各一份，
 * 且普通 Chat（chat-handler）与 Synth 汇总阶段硬编码 SISYPHUS_SYSTEM_PROMPT /
 * SISYPHUS_SYNTH_SYSTEM_PROMPT，不读取 customPrompts —— Prompt 编辑"部分生效"；
 * 且纯内存 Map 在 Backend restart 后自定义 Prompt 全部丢失。
 *
 * 本模块提供统一读取入口：
 *   getEffectivePrompt(agentId, fallbackPrompt)
 *   setPrompt(agentId, prompt)      — 写内存 + 持久化到 agent_configs.system_prompt
 *   getAllPrompts()
 *   clearPrompt(agentId)            — 清内存 + 清持久化列
 *   loadPromptsFromDb(db)           — 启动时加载持久化覆盖（重启不丢失）
 *
 * 生产路径（普通 Chat / Super Worker / Orchestrator / Synth / Direct Sisyphus）
 * 全部通过本 Registry 读取 —— 任何一处编辑 Prompt，所有路径立即生效。
 */

import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema/index.js';

const customPrompts = new Map<string, string>();

/**
 * 获取 Agent 生效 Prompt。
 * @param agentId Agent ID（'sisyphus' 等）
 * @param fallbackPrompt 未覆盖时使用的默认 Prompt
 */
export function getEffectivePrompt(agentId: string, fallbackPrompt: string): string {
  return customPrompts.get(agentId) ?? fallbackPrompt;
}

/**
 * 覆盖 Agent Prompt（运行时生效，供所有生产路径统一读取）。
 * §27/P0-10 持久化：同步写 agent_configs.system_prompt —— Backend restart 后不丢失。
 * 若该 Agent 尚无 agent_configs 行，则静默跳过持久化（仅内存生效，避免副作用）。
 */
export function setPrompt(agentId: string, prompt: string): void {
  customPrompts.set(agentId, prompt);
  try {
    const db = getDbSafe();
    if (!db) return;
    const row = db.select({ id: schema.agentConfigs.id })
      .from(schema.agentConfigs)
      .where(eq(schema.agentConfigs.agentId, agentId))
      .get();
    if (row) {
      db.update(schema.agentConfigs)
        .set({ systemPrompt: prompt, updatedAt: new Date().toISOString() })
        .where(eq(schema.agentConfigs.id, row.id))
        .run();
    }
  } catch { /* 持久化失败不阻塞（内存已生效） */ }
}

/** 查看当前全部覆盖 */
export function getAllPrompts(): Map<string, string> {
  return customPrompts;
}

/**
 * 移除覆盖，恢复默认。
 * §27/P0-10 持久化：同步清空 agent_configs.system_prompt。
 */
export function clearPrompt(agentId: string): void {
  customPrompts.delete(agentId);
  try {
    const db = getDbSafe();
    if (!db) return;
    const row = db.select({ id: schema.agentConfigs.id })
      .from(schema.agentConfigs)
      .where(eq(schema.agentConfigs.agentId, agentId))
      .get();
    if (row) {
      db.update(schema.agentConfigs)
        .set({ systemPrompt: null, updatedAt: new Date().toISOString() })
        .where(eq(schema.agentConfigs.id, row.id))
        .run();
    }
  } catch { /* 持久化失败不阻塞（内存已生效） */ }
}

/**
 * §27/P0-10 启动加载：从 agent_configs.system_prompt 恢复自定义 Prompt 覆盖。
 * 返回加载的覆盖数量。在应用 bootstrap（registerAgentRoutes）时调用一次。
 */
export function loadPromptsFromDb(db: SQLJsDatabase<typeof schema>): number {
  let loaded = 0;
  try {
    const rows = db.select().from(schema.agentConfigs).all();
    for (const row of rows) {
      if (row.systemPrompt) {
        customPrompts.set(row.agentId, row.systemPrompt);
        loaded++;
      }
    }
  } catch { /* 加载失败则保持空覆盖（回退默认） */ }
  return loaded;
}

/** 测试辅助：清空内存覆盖（不影响持久化列） */
export function __clearMemoryPromptsForTest(): void {
  customPrompts.clear();
}

// 延迟获取 db（避免模块加载期循环依赖；未初始化时返回 undefined）
function getDbSafe(): SQLJsDatabase<typeof schema> | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require('../db/client.js') as { getDb: () => SQLJsDatabase<typeof schema> };
    return getDb();
  } catch {
    return null;
  }
}
