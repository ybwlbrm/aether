/**
 * 统一工具注册表 — 参考 DeepSeek Harness 的 ToolDefinition 模式
 * 
 * 将 files/command/search-tools/lsp-client/test-runner/code-review/mcp-client
 * 全部统一为 ToolDefinition 格式，方便管理、调度和 UI 渲染。
 */
import type { ToolDefinition } from '@pacc/shared';
import { fileTools } from './files.js';
import { commandTools } from './command.js';
import { searchTools } from './search-tools.js';
import { lspTools } from './lsp-client.js';
import { testTools } from './test-runner.js';
import { codeReviewTools } from './code-review.js';
import { todoTools } from './todo-tools.js';

/** 从 OpenAI function calling 格式提取 ToolDefinition */
function extractDef(tool: any): ToolDefinition {
  const fn = tool.function || tool;
  return {
    name: fn.name,
    description: fn.description || '',
    inputSchema: fn.parameters || { type: 'object', properties: {} },
    enabled: true,
    isConcurrencySafe: false,
    timeoutMs: 60000,
    category: guessCategory(fn.name),
  };
}

/** 根据工具名猜测类别 */
function guessCategory(name: string): ToolDefinition['category'] {
  if (['read_file', 'write_file', 'list_files', 'edit_file', 'delete_file', 'create_directory'].includes(name)) return 'file';
  if (['grep', 'glob', 'web_search', 'web_fetch'].includes(name)) return 'search';
  if (['execute_command'].includes(name)) return 'command';
  if (['run_tests', 'code_review'].includes(name)) return 'code';
  if (['lsp_diagnostics'].includes(name)) return 'lsp';
  if (['todo_write'].includes(name)) return 'other';
  return 'other';
}

/** 全部内置工具（OpenAI function calling 格式） */
export const allBuiltinTools: any[] = [
  ...fileTools,
  ...commandTools,
  ...searchTools,
  ...lspTools,
  ...testTools,
  ...codeReviewTools,
  ...todoTools,
];

/**
 * 构建完整工具列表（内置 + MCP），供各端点复用（消除 conversations/agents 的重复实现）。
 * 返回 OpenAI function calling 格式数组。
 */
export function buildAllTools(mcpTools: Array<{ name: string; description?: string; inputSchema?: unknown }>): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
  return [
    ...allBuiltinTools,
    ...mcpTools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    })),
  ];
}

/**
 * 按网络搜索开关过滤工具列表（webSearch=false 时去除 search 系）。
 * 返回新数组（不修改入参）。
 */
export function filterToolsByWebSearch(
  tools: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: unknown } }>,
  webSearch: boolean,
): Array<{ type: 'function'; function: { name: string; description?: string; parameters?: unknown } }> {
  if (webSearch) return tools;
  return tools.filter(t => !/web_search|web_fetch|browser\./.test(t.function?.name ?? ''));
}

/** 全部内置工具的 ToolDefinition 格式 */
export const toolDefinitions: ToolDefinition[] = allBuiltinTools.map(extractDef);

/** 按名称查找工具定义 */
export function findToolDefinition(name: string): ToolDefinition | undefined {
  return toolDefinitions.find(t => t.name === name);
}

/** 按类别筛选工具 */
export function getToolsByCategory(category: ToolDefinition['category']): ToolDefinition[] {
  return toolDefinitions.filter(t => t.category === category);
}

/** 获取可并发执行的工具列表 */
export function getConcurrencySafeTools(): string[] {
  return toolDefinitions.filter(t => t.isConcurrencySafe).map(t => t.name);
}