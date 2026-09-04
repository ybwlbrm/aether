import { describe, it, expect } from 'vitest';
import {
  classifyTool,
  deriveSummary,
  formatToolRow,
  buildToolRowModel,
  type ToolCallKind,
} from '../lib/tool-models';

describe('classifyTool', () => {
  it('文件工具分类正确', () => {
    expect(classifyTool('read_file')).toBe('read');
    expect(classifyTool('write_file')).toBe('edit');
    expect(classifyTool('edit_file')).toBe('edit');
    expect(classifyTool('list_files')).toBe('read');
  });

  it('搜索工具分类正确', () => {
    expect(classifyTool('grep')).toBe('search');
    expect(classifyTool('glob')).toBe('search');
    expect(classifyTool('web_search')).toBe('search');
  });

  it('命令工具分类正确', () => {
    expect(classifyTool('execute_command')).toBe('execute');
  });

  it('代码工具分类正确', () => {
    expect(classifyTool('run_tests')).toBe('execute');
    expect(classifyTool('code_review')).toBe('read');
  });

  it('MCP 工具前缀匹配', () => {
    expect(classifyTool('filesystem_read_file')).toBe('read');
    expect(classifyTool('browser_navigate')).toBe('search');
  });

  it('未知工具回退 other', () => {
    expect(classifyTool('unknown_tool')).toBe('other');
  });
});

describe('deriveSummary', () => {
  it('从 path 参数提取摘要', () => {
    expect(deriveSummary('read_file', '{"path":"/tmp/test.txt"}')).toBe('/tmp/test.txt');
  });

  it('从 command 参数提取摘要', () => {
    expect(deriveSummary('execute_command', '{"command":"ls -la"}')).toBe('ls -la');
  });

  it('从 query 参数提取摘要', () => {
    expect(deriveSummary('web_search', '{"query":"hello world"}')).toBe('hello world');
  });

  it('非 JSON 参数回退原始字符串', () => {
    expect(deriveSummary('read_file', 'some/raw/path')).toBe('some/raw/path');
  });

  it('空参数返回原始字符串', () => {
    expect(deriveSummary('read_file', '{}')).toBe('{}');
  });
});

describe('formatToolRow', () => {
  it('完成状态格式化为 ✓ 开头', () => {
    const model = buildToolRowModel('read_file', '/tmp/test.txt', 'file content', undefined);
    expect(formatToolRow(model)).toMatch(/^✓ Read/);
    expect(formatToolRow(model)).toContain('/tmp/test.txt');
  });

  it('错误状态格式化为 ✕ 开头', () => {
    const model = buildToolRowModel('edit_file', 'test.ts', undefined, 'file not found');
    expect(formatToolRow(model)).toMatch(/^✕ Edit/);
  });

  it('运行中状态格式化为 ● 开头', () => {
    const model = buildToolRowModel('read_file', 'test.ts', undefined, undefined);
    model.state = 'running' as any;
    expect(formatToolRow(model)).toMatch(/^● Read/);
  });

  it('未知工具映射为 Tool', () => {
    const model = buildToolRowModel('unknown_custom_thing', 'some args', 'ok', undefined);
    expect(formatToolRow(model)).toContain('Tool');
  });
});

describe('buildToolRowModel', () => {
  it('成功时 state 为 ok', () => {
    const model = buildToolRowModel('read_file', 'test.ts', 'file content', undefined);
    expect(model.state).toBe('ok');
    expect(model.variant).toBe('read');
    expect(model.title).toBe('Read');
  });

  it('错误时 state 为 error', () => {
    const model = buildToolRowModel('edit_file', 'test.ts', undefined, 'permission denied');
    expect(model.state).toBe('error');
    expect(model.output).toBeNull();
  });

  it('有结果时 output 不为空', () => {
    const model = buildToolRowModel('read_file', 'test.ts', 'file content', undefined);
    expect(model.output).toBe('file content');
  });
});