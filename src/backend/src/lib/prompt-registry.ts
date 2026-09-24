/**
 * Prompt Registry（§20-29 统一 Prompt 来源）
 *
 * 问题：此前 customPrompts Map 定义在 orchestration.ts 与 index.ts 各一份，
 * 且普通 Chat（chat-handler）与 Synth 汇总阶段硬编码 SISYPHUS_SYSTEM_PROMPT /
 * SISYPHUS_SYNTH_SYSTEM_PROMPT，不读取 customPrompts —— Prompt 编辑"部分生效"。
 *
 * 本模块提供统一读取入口：
 *   getEffectivePrompt(agentId, fallbackPrompt)
 *   setPrompt(agentId, prompt)
 *   getAllPrompts()
 *
 * 生产路径（普通 Chat / Super Worker / Orchestrator / Synth / Direct Sisyphus）
 * 全部通过本 Registry 读取 —— 任何一处编辑 Prompt，所有路径立即生效。
 *
 * 持久化（§27）：默认进程内 Map（重启丢失）；可由上层注入持久化加载/保存钩子。
 */

const customPrompts = new Map<string, string>();

/**
 * 获取 Agent 生效 Prompt。
 * @param agentId Agent ID（'sisyphus' 等）
 * @param fallbackPrompt 未覆盖时使用的默认 Prompt
 */
export function getEffectivePrompt(agentId: string, fallbackPrompt: string): string {
  return customPrompts.get(agentId) ?? fallbackPrompt;
}

/** 覆盖 Agent Prompt（运行时生效，供所有生产路径统一读取） */
export function setPrompt(agentId: string, prompt: string): void {
  customPrompts.set(agentId, prompt);
}

/** 查看当前全部覆盖 */
export function getAllPrompts(): Map<string, string> {
  return customPrompts;
}

/** 移除覆盖，恢复默认 */
export function clearPrompt(agentId: string): void {
  customPrompts.delete(agentId);
}
