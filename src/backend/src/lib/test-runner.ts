/**
 * 测试运行器工具 — 供 AI Agent 通过 function calling 运行测试命令并解析结果
 * 本质上是 execute_command 的包装，添加了测试输出解析（PASS/FAIL/ERROR）
 */
import { executeCommand } from './command.js';

export const testTools = [
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: '运行测试命令并返回解析后的测试结果（PASS/FAIL/ERROR）',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '测试命令（如 npm test, pytest, npx vitest run 等）' },
          path: { type: 'string', description: '项目路径（可选，默认工作目录）' },
          timeout: { type: 'number', description: '超时时间毫秒（默认 60000，最大 120000）' },
        },
        required: ['command'],
      },
    },
  },
];

/**
 * 解析测试输出中的关键信息
 */
function parseTestOutput(output: string): { summary: string; passCount: number; failCount: number; errorCount: number } {
  const lower = output.toLowerCase();
  let passCount = 0;
  let failCount = 0;
  let errorCount = 0;

  // 匹配常见的测试框架输出格式
  // Jest / Vitest: "Tests:       6 passed, 6 total"
  const jestPassMatch = output.match(/(\d+)\s*passed/);
  const jestFailMatch = output.match(/(\d+)\s*failed/);
  if (jestPassMatch) passCount = parseInt(jestPassMatch[1], 10);
  if (jestFailMatch) failCount = parseInt(jestFailMatch[1], 10);

  // pytest: "collected 6 items / 3 passed, 2 failed, 1 error"
  const pytestPassMatch = output.match(/(\d+)\s*passed/);
  const pytestFailMatch = output.match(/(\d+)\s*failed/);
  const pytestErrorMatch = output.match(/(\d+)\s*error/);
  if (pytestPassMatch && !jestPassMatch) passCount = parseInt(pytestPassMatch[1], 10);
  if (pytestFailMatch && !jestFailMatch) failCount = parseInt(pytestFailMatch[1], 10);
  if (pytestErrorMatch) errorCount = parseInt(pytestErrorMatch[1], 10);

  // 兜底：统计行中的 PASS/FAIL/ERROR 关键字
  if (passCount === 0 && failCount === 0 && errorCount === 0) {
    const lines = output.split('\n');
    for (const line of lines) {
      if (/✓|PASS|passed|ok\b/i.test(line) && !/FAIL/i.test(line)) passCount++;
      if (/✗|FAIL|failed/i.test(line)) failCount++;
      if (/ERROR|error/i.test(line) && !/error:/i.test(line)) errorCount++;
    }
  }

  // 生成摘要
  const parts: string[] = [];
  if (passCount > 0) parts.push(`${passCount} 通过`);
  if (failCount > 0) parts.push(`${failCount} 失败`);
  if (errorCount > 0) parts.push(`${errorCount} 错误`);
  const summary = parts.length > 0 ? parts.join('，') : '无法解析测试结果';

  return { summary, passCount, failCount, errorCount };
}

/**
 * 运行测试命令并返回解析结果
 */
export async function executeRunTests(
  command: string,
  path?: string,
  timeout?: number,
  allowedDirs?: string[],
  permissionLevel?: number,
  defaultDir?: string,
): Promise<string> {
  const effectiveTimeout = Math.min(timeout || 60000, 120000);

  const rawOutput = await executeCommand(
    command,
    path,
    effectiveTimeout,
    allowedDirs,
    permissionLevel,
    defaultDir,
  );

  // 如果命令执行出错，直接返回原始输出
  if (rawOutput.startsWith('错误:') || rawOutput.startsWith('安全限制') || rawOutput.startsWith('权限不足') || rawOutput.startsWith('命令执行异常')) {
    return rawOutput;
  }

  const parsed = parseTestOutput(rawOutput);
  const exitCode = rawOutput.includes('退出码 0') ? 0 : 1;

  const result = [
    `═══════ 测试结果 ═══════`,
    `状态: ${exitCode === 0 ? '✅ 通过' : '❌ 失败'}`,
    `摘要: ${parsed.summary}`,
    `────────────────────────`,
    rawOutput,
  ].join('\n');

  return result;
}