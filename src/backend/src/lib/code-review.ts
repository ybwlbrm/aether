/**
 * 代码审查工具 — 供 Momus Agent 审查代码质量
 * 分析代码中的常见问题：未使用变量、缺失类型、潜在 bug、代码风格等
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, parse } from 'node:path';
import { isPathSafe } from './path-guard.js';

export const codeReviewTools = [
  {
    type: 'function',
    function: {
      name: 'code_review',
      description: '审查代码文件或代码片段，返回质量问题、潜在 bug 和改进建议',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '要审查的文件路径（与 code 二选一）' },
          code: { type: 'string', description: '要审查的代码文本（与 filePath 二选一）' },
          language: { type: 'string', description: '代码语言（如 typescript, python, go，可选，自动检测）' },
        },
      },
    },
  },
];

/** path-guard.ts 提供的 isPathSafe（W4-3 统一实现） */

/** 从文件名推断语言 */
function detectLanguage(filePath: string): string {
  const ext = parse(filePath).ext.toLowerCase();
  const langMap: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
    '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
    '.kt': 'kotlin', '.scala': 'scala', '.dart': 'dart', '.lua': 'lua',
    '.css': 'css', '.scss': 'scss', '.html': 'html', '.xml': 'xml',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.md': 'markdown',
    '.sh': 'shell', '.bat': 'batch', '.ps1': 'powershell',
    '.sql': 'sql', '.graphql': 'graphql',
  };
  return langMap[ext] || 'unknown';
}

/** 审查单行代码的模式 */
interface ReviewIssue {
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  suggestion?: string;
}

/** 对 TypeScript/JavaScript 代码进行静态分析 */
function reviewTypeScript(lines: string[]): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const variableDeclarations = new Map<string, { line: number; kind: string }>();
  const functionDeclarations = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // 跳过空行、注释、字符串
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // 检查 console.log 残留
    if (/console\.(log|debug|info)\(/.test(trimmed) && !trimmed.includes('//')) {
      issues.push({
        line: lineNum,
        severity: 'warning',
        message: '可能遗留了 console.log 调试代码',
        suggestion: '生产环境建议移除或替换为日志库',
      });
    }

    // 检查 any 类型
    if (/:\s*any\b/.test(trimmed) && !trimmed.includes('//') && !trimmed.includes('@ts')) {
      issues.push({
        line: lineNum,
        severity: 'warning',
        message: '使用了 any 类型，会丧失类型检查',
        suggestion: '建议替换为更具体的类型，或使用 unknown',
      });
    }

    // 检查 @ts-ignore
    if (/@ts-ignore/.test(trimmed)) {
      issues.push({
        line: lineNum,
        severity: 'error',
        message: '使用了 @ts-ignore，会跳过类型检查',
        suggestion: '建议使用 @ts-expect-error 并注明原因',
      });
    }

    // 检查空 catch 块
    if (/catch\s*\([^)]*\)\s*\{/.test(trimmed) && lines[i + 1]?.trim() === '}' && lines[i + 2]?.trim() === '}') {
      issues.push({
        line: lineNum,
        severity: 'error',
        message: '空的 catch 块会静默吞掉错误',
        suggestion: '建议至少记录错误：console.error(err)',
      });
    }

    // 检查 TODO/FIXME
    if (/TODO|FIXME|HACK|XXX/.test(trimmed) && !trimmed.startsWith('//') && trimmed.includes('//')) {
      issues.push({
        line: lineNum,
        severity: 'info',
        message: '代码中存在待办标记',
        suggestion: '建议在提交前处理',
      });
    }

    // 收集变量声明
    const varMatch = trimmed.match(/(?:const|let|var)\s+(\w+)/);
    if (varMatch) {
      variableDeclarations.set(varMatch[1], { line: lineNum, kind: varMatch[0].split(/\s+/)[0] });
    }

    // 收集函数声明
    const funcMatch = trimmed.match(/(?:function\s+|const\s+\w+\s*=\s*(?:async\s*)?\()(\w+)/);
    if (funcMatch) {
      functionDeclarations.add(funcMatch[1]);
    }

    // 检查过长行
    if (trimmed.length > 120) {
      issues.push({
        line: lineNum,
        severity: 'warning',
        message: `行过长（${trimmed.length} 字符），建议不超过 120 字符`,
        suggestion: '考虑换行或提取变量',
      });
    }

    // 检查 var 使用
    if (/^var\s+/.test(trimmed)) {
      issues.push({
        line: lineNum,
        severity: 'warning',
        message: '使用了 var，建议使用 const/let',
        suggestion: 'var 有函数作用域问题，const/let 更安全',
      });
    }
  }

  return issues;
}

/** 对 Python 代码进行静态分析 */
function reviewPython(lines: string[]): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (/print\(/.test(trimmed) && !trimmed.includes('#')) {
      issues.push({
        line: lineNum, severity: 'warning',
        message: '可能遗留了 print 调试代码',
        suggestion: '建议使用 logging 模块',
      });
    }
    if (/except\s*:\s*$/.test(trimmed) || /except:\s*$/.test(trimmed)) {
      issues.push({
        line: lineNum, severity: 'error',
        message: '裸 except 会捕获所有异常，包括 SystemExit',
        suggestion: '建议指定异常类型：except Exception:',
      });
    }
    if (trimmed.length > 100) {
      issues.push({
        line: lineNum, severity: 'warning',
        message: `行过长（${trimmed.length} 字符）`,
        suggestion: 'PEP 8 建议每行不超过 79 字符',
      });
    }
  }
  return issues;
}

/** 审查代码 */
export function executeCodeReview(
  filePath?: string,
  code?: string,
  language?: string,
  allowedDirs?: string[],
  permissionLevel?: number,
  defaultDir?: string,
): string {
  try {
    let content = code || '';
    let lang = language || 'unknown';
    let sourceName = '代码片段';

    if (filePath) {
      const resolvedPath = resolve(filePath);
      if (!isPathSafe(resolvedPath, allowedDirs, permissionLevel)) {
        return '错误: 文件路径不在允许的目录内';
      }
      if (!existsSync(resolvedPath)) {
        return `错误: 文件不存在: ${resolvedPath}`;
      }
      const stat = statSync(resolvedPath);
      if (!stat.isFile()) return `错误: 不是文件: ${resolvedPath}`;
      if (stat.size > 1024 * 1024) return `错误: 文件过大（>1MB），无法审查`;

      content = readFileSync(resolvedPath, 'utf-8');
      sourceName = resolvedPath;
      lang = language || detectLanguage(resolvedPath);
    } else if (!code) {
      return '错误: 请提供 filePath 或 code 参数';
    }

    const lines = content.split('\n');
    if (lines.length > 2000) {
      return `错误: 代码过长（${lines.length} 行），最多支持 2000 行`;
    }

    let issues: ReviewIssue[] = [];
    if (['typescript', 'javascript', 'tsx', 'jsx'].includes(lang)) {
      issues = reviewTypeScript(lines);
    } else if (lang === 'python') {
      issues = reviewPython(lines);
    } else {
      return `代码审查暂不支持 ${lang} 语言，支持：TypeScript、JavaScript、Python`;
    }

    if (issues.length === 0) {
      return `✅ ${sourceName} — 代码审查通过，未发现问题`;
    }

    const errors = issues.filter(i => i.severity === 'error');
    const warnings = issues.filter(i => i.severity === 'warning');
    const infos = issues.filter(i => i.severity === 'info');

    const parts = [
      `═══════ 代码审查报告 ═══════`,
      `文件: ${sourceName}`,
      `语言: ${lang}`,
      `行数: ${lines.length}`,
      `问题: ${errors.length} 个错误, ${warnings.length} 个警告, ${infos.length} 个建议`,
      `────────────────────────`,
    ];

    for (const issue of issues) {
      const severityLabel = issue.severity === 'error' ? '❌' : issue.severity === 'warning' ? '⚠️' : '💡';
      parts.push(`${severityLabel} 第 ${issue.line} 行: ${issue.message}`);
      if (issue.suggestion) parts.push(`   建议: ${issue.suggestion}`);
    }

    return parts.join('\n');
  } catch (e: unknown) {
    return `工具执行错误: ${e instanceof Error ? e.message : String(e)}`;
  }
}