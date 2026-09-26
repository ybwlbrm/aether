/**
 * 统一工具执行器 — 替换 agents/index.ts 和 conversations/index.ts 中的 if/else 链
 * 参考 DeepSeek Harness 的 ToolRuntime 调度模式
 *
 * ask-user 支持：options.onApproval 存在时，Level 1（只读）模式的敏感工具
 * （写文件/命令/删除等）在执行前会回调 onApproval；若回调返回 approved 才执行，
 * 否则返回「用户未批准」文本（对齐 harness interaction 能力）。
 */
import { callMcpTool, type McpServerEntry } from './mcp-client.js';
import { executeFileTool } from './files.js';
import { executeCommand, addCommandHistory } from './command.js';
import { executeGrep, executeGlob, executeWebSearch, executeWebFetch } from './search-tools.js';
import { executeLspDiagnostics } from './lsp-client.js';
import { executeRunTests } from './test-runner.js';
import { executeCodeReview } from './code-review.js';
import { findToolDefinition } from './tool-registry.js';
import { executeTodoWrite } from './todo-tools.js';
import { requiresApproval, summarizeArgs, type ApprovalDecision } from './approval.js';

/** 工具参数（来自 LLM 工具调用 —— 不可信输入，全部按 unknown 接收后收窄） */
export type ToolArgs = Record<string, unknown>;

/** 工具执行结果 */
export interface ToolExecResult {
  name: string;
  args: ToolArgs;
  result: string;
  error?: string;
  durationMs: number;
}

/** 审批回调：返回 approved/rejected/timeout/aborted（P0-08: aborted = Run Cancel 打断） */
export type ApprovalHook = (
  toolName: string,
  args: ToolArgs,
  argsSummary: string,
) => Promise<{ approved: boolean; decision: ApprovalDecision }>;

/** MCP 工具引用（listMcpTools 的产物） */
export interface McpToolRef {
  readonly name: string;
  readonly serverName: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

/* ── 边界收口工具：args 来自 LLM（不可信），按类型收窄后再下发给具体实现 ── */

function str(args: ToolArgs, key: string): string {
  return typeof args[key] === 'string' ? args[key] : '';
}

function optStr(args: ToolArgs, key: string): string | undefined {
  return typeof args[key] === 'string' ? args[key] : undefined;
}

function optNum(args: ToolArgs, key: string): number | undefined {
  return typeof args[key] === 'number' ? args[key] : undefined;
}

function todoArgs(args: ToolArgs): { action?: string; text?: string; id?: number; done?: boolean } {
  const out: { action?: string; text?: string; id?: number; done?: boolean } = {};
  const action = optStr(args, 'action');
  if (action !== undefined) out.action = action;
  const text = optStr(args, 'text');
  if (text !== undefined) out.text = text;
  const id = optNum(args, 'id');
  if (id !== undefined) out.id = id;
  if (typeof args.done === 'boolean') out.done = args.done;
  return out;
}

/** 执行单个工具，统一错误处理，返回标准化结果 */
export async function executeTool(
  funcName: string,
  args: ToolArgs,
  options: {
    mcpTools: McpToolRef[];
    getMcpServers: () => McpServerEntry[];
    allowedDirs: string[];
    permissionLevel: number;
    defaultDir: string;
    sessionId?: string;
    /** ask-user 审批回调（可选；提供时 Level 1 敏感工具执行前询问用户） */
    onApproval?: ApprovalHook;
    /** 可选的 AbortSignal，用于在客户端断连时取消工具执行 (BE-05) */
    signal?: AbortSignal;
  },
): Promise<ToolExecResult> {
  const start = Date.now();
  const def = findToolDefinition(funcName);
  const timeoutMs = def?.timeoutMs ?? 60000;

  // BE-05: 检查 abort signal，若已中止则立即返回
  if (options.signal?.aborted) {
    const reason = '请求已取消 (aborted)';
    return { name: funcName, args, result: `已停止：${reason}`, error: reason, durationMs: Date.now() - start };
  }

  // ask-user：Level 1（只读）敏感工具在执行前请求用户确认
  // P0-08: decision === 'aborted' 表示 Run 已被取消 —— 工具执行立即终止
  if (options.onApproval && requiresApproval(funcName, options.permissionLevel)) {
    const { approved, decision } = await options.onApproval(funcName, args, summarizeArgs(args));
    if (!approved) {
      const reason = decision === 'timeout'
        ? '审批超时（60 秒未确认）'
        : decision === 'aborted'
          ? '运行已取消（aborted）'
          : '用户未批准本次工具调用';
      return { name: funcName, args, result: `已停止：${reason}`, error: reason, durationMs: Date.now() - start };
    }
  }

  // BE-05: 审批后再次检查 abort signal
  if (options.signal?.aborted) {
    const reason = '请求已取消 (aborted)';
    return { name: funcName, args, result: `已停止：${reason}`, error: reason, durationMs: Date.now() - start };
  }

  try {
    // MCP 工具优先
    const mcpTool = options.mcpTools.find(t => t.name === funcName);
    if (mcpTool) {
      const result = await callMcpTool(
        mcpTool.serverName,
        funcName.slice(mcpTool.serverName.length + 1),
        args,
        options.getMcpServers,
        options.permissionLevel,
      );
      return { name: funcName, args, result, durationMs: Date.now() - start };
    }

    // 内置工具统一调度
    let result: string;
    const { allowedDirs, permissionLevel, defaultDir } = options;

    switch (funcName) {
      case 'execute_command':
        // P1-21: signal 透传到子进程（Run Cancel → taskkill 进程树）
        result = await executeCommand(str(args, 'command'), optStr(args, 'workdir'), optNum(args, 'timeout'), allowedDirs, permissionLevel, defaultDir, options.signal);
        addCommandHistory({ command: str(args, 'command'), output: result, duration: 0, success: !result.startsWith('错误:'), source: 'agent' });
        break;
      case 'grep':
        result = executeGrep(str(args, 'pattern'), optStr(args, 'path'), optStr(args, 'include'), optNum(args, 'maxResults'), allowedDirs, permissionLevel, defaultDir);
        break;
      case 'glob':
        result = executeGlob(str(args, 'pattern'), optStr(args, 'path'), allowedDirs, permissionLevel, defaultDir);
        break;
      case 'web_search':
        result = await executeWebSearch(str(args, 'query'), optNum(args, 'maxResults'));
        break;
      case 'web_fetch':
        result = await executeWebFetch(str(args, 'url'), optStr(args, 'format'), allowedDirs, permissionLevel, defaultDir);
        break;
      case 'lsp_diagnostics':
        result = await executeLspDiagnostics(str(args, 'filePath'), allowedDirs, permissionLevel, defaultDir);
        break;
      case 'run_tests':
        result = await executeRunTests(str(args, 'command'), optStr(args, 'path'), optNum(args, 'timeout'), allowedDirs, permissionLevel, defaultDir);
        break;
      case 'code_review':
        result = executeCodeReview(optStr(args, 'filePath'), optStr(args, 'code'), optStr(args, 'language'), allowedDirs, permissionLevel, defaultDir);
        break;
      case 'todo_write': {
        const todoResult = executeTodoWrite(todoArgs(args), { sessionId: options.sessionId ?? 'default' });
        result = todoResult.result;
        break;
      }
      default:
        result = await executeFileTool(funcName, args, allowedDirs, defaultDir, permissionLevel);
        break;
    }

    return { name: funcName, args, result, durationMs: Date.now() - start };
  } catch (e: unknown) {
    const errMsg = (e instanceof Error ? e.message : String(e)) || '工具执行失败';
    return { name: funcName, args, result: `错误: ${errMsg}`, error: errMsg, durationMs: Date.now() - start };
  }
}