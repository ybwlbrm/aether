/**
 * 统一工具执行器 — 替换 agents/index.ts 和 conversations/index.ts 中的 if/else 链
 * 参考 DeepSeek Harness 的 ToolRuntime 调度模式
 *
 * ask-user 支持：options.onApproval 存在时，Level 1（只读）模式的敏感工具
 * （写文件/命令/删除等）在执行前会回调 onApproval；若回调返回 approved 才执行，
 * 否则返回「用户未批准」文本（对齐 harness interaction 能力）。
 */
import { callMcpTool } from './mcp-client.js';
import { executeFileTool } from './files.js';
import { executeCommand, addCommandHistory } from './command.js';
import { executeGrep, executeGlob, executeWebSearch, executeWebFetch } from './search-tools.js';
import { executeLspDiagnostics } from './lsp-client.js';
import { executeRunTests } from './test-runner.js';
import { executeCodeReview } from './code-review.js';
import { findToolDefinition } from './tool-registry.js';
import { executeTodoWrite } from './todo-tools.js';
import { requiresApproval, summarizeArgs, type ApprovalDecision } from './approval.js';

export interface ToolExecResult {
  name: string;
  args: any;
  result: string;
  error?: string;
  durationMs: number;
}

/** 审批回调：返回 approved/rejected/timeout */
export type ApprovalHook = (
  toolName: string,
  args: any,
  argsSummary: string,
) => Promise<{ approved: boolean; decision: ApprovalDecision }>;

/** 执行单个工具，统一错误处理，返回标准化结果 */
export async function executeTool(
  funcName: string,
  args: any,
  options: {
    mcpTools: any[];
    getMcpServers: () => any[];
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
  if (options.onApproval && requiresApproval(funcName, options.permissionLevel)) {
    const { approved, decision } = await options.onApproval(funcName, args, summarizeArgs(args));
    if (!approved) {
      const reason = decision === 'timeout' ? '审批超时（60 秒未确认）' : '用户未批准本次工具调用';
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
        result = await executeCommand(args.command, args.workdir, args.timeout, allowedDirs, permissionLevel, defaultDir);
        addCommandHistory({ command: args.command || '', output: result, duration: 0, success: !result.startsWith('错误:'), source: 'agent' });
        break;
      case 'grep':
        result = executeGrep(args.pattern, args.path, args.include, args.maxResults, allowedDirs, permissionLevel, defaultDir);
        break;
      case 'glob':
        result = executeGlob(args.pattern, args.path, allowedDirs, permissionLevel, defaultDir);
        break;
      case 'web_search':
        result = await executeWebSearch(args.query, args.maxResults);
        break;
      case 'web_fetch':
        result = await executeWebFetch(args.url, args.format, allowedDirs, permissionLevel, defaultDir);
        break;
      case 'lsp_diagnostics':
        result = await executeLspDiagnostics(args.filePath, allowedDirs, permissionLevel, defaultDir);
        break;
      case 'run_tests':
        result = await executeRunTests(args.command, args.path, args.timeout, allowedDirs, permissionLevel, defaultDir);
        break;
      case 'code_review':
        result = executeCodeReview(args.filePath, args.code, args.language, allowedDirs, permissionLevel, defaultDir);
        break;
      case 'todo_write': {
        const todoResult = executeTodoWrite(args, { sessionId: (options as any).sessionId ?? 'default' });
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