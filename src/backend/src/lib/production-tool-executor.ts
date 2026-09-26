/**
 * ProductionToolExecutor — Aether 2.0 统一生产工具执行器（P0-01/P0-06/P0-09 收口）
 *
 * 目标：让生产 Tool Loop（agents/tool-loop.ts + conversations/tool-loop.ts）统一走：
 *   Agent → ToolRuntime(ToolContext) → PolicyEngine → Approval → ToolExecutor → Tool Implementation
 *
 * 本模块是"生产接线层"（transport-agnostic 核心 + 真实审批/权限注入）：
 * - core ToolRegistry 注册全部内置工具（经 tool-runtime-bridge 复用 legacy 实现）
 *   + MCP 工具（包装 callMcpTool）—— MCP 不再是权限盲区（P0-09）
 * - core PolicyEngine 作为唯一安全裁决者（capability `tool.<name>`，默认放行、显式 deny 拦截）
 * - core ToolExecutor 统一执行：Policy → Approval → Timeout → Cancellation
 * - approvals-center 真实审批（apr-xxxx ID + runId/taskId/agentId/toolCallId 绑定 + AbortSignal）
 *
 * 调用方不再直接导入 lib/tool-executor.ts（P0-01：禁止生产代码直接调用旧执行器）。
 * 旧 executeTool 仅作为 AetherTool.execute 的底层实现保留（Adapter 模式）。
 */

import { ToolRegistry } from '../core/tools/tool-registry.js';
import { ToolExecutor } from '../core/tools/tool-executor.js';
import { ToolPolicy, type ToolPolicyRule } from '../core/tools/tool-policy.js';
import type { ToolContext } from '../core/tools/tool-runtime.js';
import type { AetherTool } from '../core/tools/tool-registry.js';
import { PolicyEngine } from '../core/permissions/policy.js';
import { createCapabilitySet } from '../core/permissions/capability.js';
import { successResult, errorResult, cancelledResult } from '../core/tools/tool-result.js';
import type { ToolResult } from '../core/tools/tool-result.js';
import { registerLegacyTools } from './tool-runtime-bridge.js';
import { callMcpTool, type McpServerEntry } from './mcp-client.js';
import { createPendingApproval } from './approvals-center.js';
import { z } from 'zod';
import { logger } from './logger.js';

/** 边界守卫：非数组普通对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 边界守卫：从 ToolContext.metadata 取回 MCP 服务器读取函数。
 * metadata 是 Record<string, unknown>，取值必须经守卫确认是可调用对象，
 * 不能靠断言（metadata 可能被外部 handoff 构造）。
 */
function readMcpServersGetter(
  metadata: Record<string, unknown> | undefined,
): () => McpServerEntry[] {
  const raw = metadata?.getMcpServers;
  return typeof raw === 'function' ? (raw as () => McpServerEntry[]) : () => [];
}

/** 生产工具执行器选项 */
export interface ProductionToolExecutorOptions {
  /** MCP 工具列表（OpenAI function-calling 格式，含 name/description/inputSchema） */
  mcpTools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  /** MCP 服务器读取函数 */
  getMcpServers: () => McpServerEntry[];
  /** 允许的工作目录 */
  allowedDirs: string[];
  /** 权限级别：1=只读（敏感工具需审批）| 2=受限 | 3=超级 */
  permissionLevel: number;
  /** 默认工作目录 */
  defaultDir: string;
  /** 会话 ID（conversationId） */
  sessionId: string;
  /** Run ID（P0-07 审批绑定） */
  runId: string;
  /** Task ID（P0-07 审批绑定） */
  taskId: string;
  /** Agent ID（P0-07 审批绑定） */
  agentId: string;
  /** Run 级 AbortSignal（P0-08 审批打断 + 取消） */
  signal?: AbortSignal;
  /** 审批提示回调（SSE 推送 ask-confirm） */
  onApprovalPrompt?: (payload: { id: string; toolName: string; argsSummary: string }) => void;
  /** 自定义 PolicyEngine（缺省构建：默认放行 tool.*，可覆盖） */
  policyEngine?: PolicyEngine;
}

/** 执行结果（兼容现有 ToolLoop 消费形态） */
export interface ProductionToolResult {
  name: string;
  args: Record<string, unknown>;
  result: string;
  error?: string;
  durationMs: number;
}

/** Level 1 敏感内置工具（需用户确认）—— 对齐旧 requiresApproval 名单 */
const LEVEL1_SENSITIVE = new Set([
  'execute_command', 'write_file', 'edit_file', 'delete_file',
  'create_directory', 'web_fetch',
]);

/** 内置工具 → 工具类能力（P1-22 command capability 映射，供 PolicyEngine 引用） */
const TOOL_CAPABILITY: Record<string, string> = {
  execute_command: 'terminal.execute',
  read_file: 'filesystem.read',
  write_file: 'filesystem.write',
  edit_file: 'filesystem.write',
  delete_file: 'filesystem.delete',
  create_directory: 'filesystem.write',
  list_files: 'filesystem.read',
  web_fetch: 'network.http',
  web_search: 'network.http',
  run_tests: 'terminal.execute',
  code_review: 'terminal.execute',
  lsp_diagnostics: 'terminal.execute',
  todo_write: 'process.launch',
};

/**
 * 构建 Level 对应的 ToolPolicy 规则：
 * - Level 1：敏感内置工具 + 全部 MCP 工具 require-approval（MCP 不再盲区，P0-09）
 * - Level 2/3：默认 allow（对齐现有文件/MCP 语义）
 * P0-06 收口：ToolPolicy 仅作为迁移兼容层保留；生产主裁决由 PolicyEngine 承担
 * （policyEngine 的 approval/deny 规则优先），此处规则仅兜底。
 */
function buildToolPolicyRules(opts: ProductionToolExecutorOptions): ToolPolicyRule[] {
  if (opts.permissionLevel !== 1) {
    return [{ pattern: '*', action: 'allow' }];
  }
  const rules: ToolPolicyRule[] = [];
  for (const name of LEVEL1_SENSITIVE) {
    rules.push({ pattern: name, action: 'require-approval' });
  }
  // Level 1 + 任意 MCP 工具 → require-approval（P0-09：MCP 工具不在旧固定名单内）
  for (const t of opts.mcpTools) {
    rules.push({ pattern: t.name, action: 'require-approval' });
  }
  rules.push({ pattern: '*', action: 'allow' }); // 其余默认放行
  return rules;
}

/**
 * 构建 PolicyEngine（P0-06 唯一裁决者）：
 * - 默认放行所有工具（tool.* allow）
 * - Level 1：敏感内置工具 + 全部 MCP 工具 → approval 效果（需用户审批）
 * - 自定义 policyEngine 优先（调用方注入时完全覆盖）
 */
function buildPolicyEngineFor(opts: ProductionToolExecutorOptions): PolicyEngine {
  if (opts.policyEngine) return opts.policyEngine;
  const engine = new PolicyEngine();
  if (opts.permissionLevel !== 1) {
    // Level 2/3：默认放行（显式 deny 仍可由调用方通过 policyEngine 注入）
    engine.addRule({ id: 'prod-default-allow-tools', capability: 'tool.*', effect: 'allow' });
    return engine;
  }
  // Level 1：敏感工具 + MCP 工具 → approval（P0-09），其余放行
  for (const name of LEVEL1_SENSITIVE) {
    engine.addRule({ id: `prod-approval-${name}`, capability: `tool.${name}` as never, effect: 'approval' });
  }
  for (const t of opts.mcpTools) {
    engine.addRule({ id: `prod-approval-mcp-${t.name}`, capability: `tool.${t.name}` as never, effect: 'approval' });
  }
  engine.addRule({ id: 'prod-default-allow-tools', capability: 'tool.*', effect: 'allow' });
  return engine;
}

/** 把 MCP 工具注册为 AetherTool（包装 callMcpTool，权限检查在 callMcpTool 内） */
function buildMcpAetherTool(entry: { name: string; description?: string; inputSchema?: unknown }): AetherTool {
  const serverToolName = entry.name;
  return {
    id: serverToolName,
    name: serverToolName,
    description: entry.description ?? '',
    inputSchema: z.record(z.unknown()),
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const start = Date.now();
      const serverName = serverToolName.split('_')[0];
      const toolName = serverToolName.slice(serverName.length + 1);
      const getServers = readMcpServersGetter(context.metadata);
      const permLevel = (context.metadata?.permissionLevel as number | undefined) ?? 0;
      try {
        const result = await callMcpTool(serverName, toolName, isRecord(input) ? input : {}, getServers, permLevel);
        return successResult(serverToolName, result, Date.now() - start);
      } catch (err) {
        return errorResult(serverToolName, { message: err instanceof Error ? err.message : String(err) }, Date.now() - start);
      }
    },
  };
}

/**
 * 构建统一生产工具执行器。
 * 返回 { execute, registry, executor } —— execute 为唯一生产入口。
 */
export function createProductionToolExecutor(opts: ProductionToolExecutorOptions) {
  const registry = new ToolRegistry();
  // 注册全部内置工具（复用 legacy 实现）
  registerLegacyTools(registry);
  // 注册 MCP 工具（P0-09：MCP 进入统一 registry + 权限体系）
  for (const t of opts.mcpTools) {
    try {
      registry.register(buildMcpAetherTool(t));
    } catch (err) {
      // 同名工具跳过（registry 防重）
      // AEX-P2-004 分类：recoverable —— 重名只丢弃这一个 MCP 工具，其余工具照常注册。
      logger.warn({ event: 'mcp.tool_register_skipped', err, toolName: t.name }, 'MCP 工具注册跳过（可能重名）');
    }
  }

  const policy = new ToolPolicy({
    rules: buildToolPolicyRules(opts),
    grantedCapabilities: createCapabilitySet(
      opts.permissionLevel >= 2 ? 'terminal.execute' : 'filesystem.read',
      'filesystem.read',
      'network.http',
    ),
    defaultAction: 'allow',
  });

  // P0-06 收口：PolicyEngine 为唯一安全裁决者（approval 效果 → 审批；deny → 拒绝）
  const policyEngine = buildPolicyEngineFor(opts);

  // 审批请求 → promise 映射（pending-approval 时由 execute() 等待）
  const approvalPromises = new Map<string, Promise<{ approved: boolean; decision: 'approved' | 'rejected' | 'timeout' | 'aborted' }>>();

  // 审批请求回调：绑定完整运行上下文（P0-07）+ AbortSignal（P0-08）
  const requestApproval = (params: { toolName: string; argsSummary: string; context: ToolContext }) => {
    const toolName = params.toolName;
    const args = (params.context.metadata?.toolArgs as Record<string, unknown> | undefined) ?? {};
    const { id, promise } = createPendingApproval({
      toolName,
      args,
      conversationId: opts.sessionId,
      runId: opts.runId,
      taskId: opts.taskId,
      agentId: opts.agentId,
      toolCallId: (params.context.metadata?.toolCallId as string | undefined),
      signal: opts.signal,
      prompt: (payload) => opts.onApprovalPrompt?.(payload),
    });
    approvalPromises.set(id, promise as Promise<{ approved: boolean; decision: 'approved' | 'rejected' | 'timeout' | 'aborted' }>);
    return { id, promise: approvalPromises.get(id)! };
  };

  const executor = new ToolExecutor(registry, {
    policy,
    policyEngine,
    enforcePolicyEngine: true,
    defaultTimeoutMs: 60_000,
    requestApproval: requestApproval as never,
  });

  /**
   * 统一生产入口：执行工具。
   * 返回 { result, error? } —— result 为展示文本，error 存在表示执行失败。
   */
  async function execute(funcName: string, args: Record<string, unknown>): Promise<ProductionToolResult> {
    const start = Date.now();
    const context: ToolContext = {
      runId: opts.runId,
      taskId: opts.taskId,
      agentId: opts.agentId,
      permissions: policy.getGrantedCapabilities(),
      policy,
      abortSignal: opts.signal,
      metadata: {
        mcpTools: opts.mcpTools,
        getMcpServers: opts.getMcpServers,
        allowedDirs: opts.allowedDirs,
        permissionLevel: opts.permissionLevel,
        defaultDir: opts.defaultDir,
        toolArgs: args,
      },
      logger: undefined,
    };

    const result = await executor.execute(funcName, args, context);

    switch (result.kind) {
      case 'success': {
        const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
        return { name: funcName, args, result: output, durationMs: result.durationMs };
      }
      case 'error': {
        return { name: funcName, args, result: `错误: ${result.error.message}`, error: result.error.message, durationMs: result.durationMs };
      }
      case 'timeout': {
        const msg = '工具执行超时（60s 未完成）';
        return { name: funcName, args, result: `错误: ${msg}`, error: msg, durationMs: result.durationMs };
      }
      case 'cancelled': {
        const msg = '运行已取消（aborted）';
        return { name: funcName, args, result: `已停止：${msg}`, error: msg, durationMs: result.durationMs };
      }
      case 'pending-approval': {
        // P0-08：审批等待必须可被 Run Cancel（AbortSignal）立即打断
        if (opts.signal?.aborted) {
          const msg = '运行已取消（aborted）';
          return { name: funcName, args, result: `已停止：${msg}`, error: msg, durationMs: Date.now() - start };
        }
        const approvalPromise = approvalPromises.get(result.approvalId);
        if (!approvalPromise) {
          const msg = `审批记录缺失: ${result.approvalId}`;
          return { name: funcName, args, result: `错误: ${msg}`, error: msg, durationMs: Date.now() - start };
        }
        // 等待用户决议（60s 超时 / AbortSignal 打断 / 用户批准或拒绝）
        const { approved, decision } = await approvalPromise;
        if (!approved) {
          const reason = decision === 'timeout'
            ? '审批超时（60 秒未确认）'
            : decision === 'aborted'
              ? '运行已取消（aborted）'
              : '用户未批准本次工具调用';
          return { name: funcName, args, result: `已停止：${reason}`, error: reason, durationMs: Date.now() - start };
        }
        // 用户已批准：直接调用底层工具执行（绕过 policy/approval，保留 timeout/cancel）
        // 整改计划第 5 章：使用受控字段 internalApproved（而非 metadata.approvedByUser，
        // 后者可被外部伪造绕过 PolicyEngine —— 多 Agent handoff 共享同一审批链）
        const approvedContext: ToolContext = {
          ...context,
          internalApproved: true,
        };
        const approvedResult = await executor.execute(funcName, args, approvedContext);
        switch (approvedResult.kind) {
          case 'success': {
            const output = typeof approvedResult.output === 'string' ? approvedResult.output : JSON.stringify(approvedResult.output);
            return { name: funcName, args, result: output, durationMs: approvedResult.durationMs };
          }
          case 'error': {
            return { name: funcName, args, result: `错误: ${approvedResult.error.message}`, error: approvedResult.error.message, durationMs: approvedResult.durationMs };
          }
          case 'timeout': {
            const msg = '工具执行超时（60s 未完成）';
            return { name: funcName, args, result: `错误: ${msg}`, error: msg, durationMs: approvedResult.durationMs };
          }
          case 'cancelled': {
            const msg = '运行已取消（aborted）';
            return { name: funcName, args, result: `已停止：${msg}`, error: msg, durationMs: approvedResult.durationMs };
          }
          case 'pending-approval': {
            // 二次执行仍要求审批（异常情况）—— 直接失败避免死循环
            const msg = '审批后二次执行仍触发审批（异常）';
            return { name: funcName, args, result: `错误: ${msg}`, error: msg, durationMs: Date.now() - start };
          }
          default: {
            const msg = '未知工具执行结果';
            return { name: funcName, args, result: msg, error: msg, durationMs: Date.now() - start };
          }
        }
      }
      default: {
        const msg = '未知工具执行结果';
        return { name: funcName, args, result: msg, error: msg, durationMs: Date.now() - start };
      }
    }
  }

  return { execute, registry, executor };
}

export type ProductionToolExecutor = ReturnType<typeof createProductionToolExecutor>;
