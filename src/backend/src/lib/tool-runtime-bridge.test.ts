/**
 * ToolRuntimeBridge tests (Phase 6 — legacy builtin tools → core ToolRegistry)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAetherTool,
  registerLegacyTools,
  buildRegistryFromLegacyTools,
  buildZodFromJsonSchema,
  type LegacyExecuteOptions,
} from './tool-runtime-bridge.js';
import { ToolRegistry, createToolContext, type ToolContext } from '../core/tools/index.js';
import { ToolPolicy } from '../core/tools/index.js';

function sampleLegacyEntry() {
  return {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容（文本文件）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
      },
    },
  };
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return createToolContext({
    runId: 'run-1',
    policy: new ToolPolicy(),
    ...overrides,
  });
}

describe('lib/tool-runtime-bridge', () => {
  it('buildAetherTool maps a legacy entry into an AetherTool', () => {
    const tool = buildAetherTool(sampleLegacyEntry());

    assert.equal(tool.id, 'read_file');
    assert.equal(tool.name, 'read_file');
    assert.equal(tool.description, '读取文件内容（文本文件）');
    assert.equal(typeof tool.execute, 'function');
    // inputSchema is a Zod type
    assert.equal(typeof tool.inputSchema.safeParse, 'function');
  });

  it('buildAetherTool.execute returns an errorResult when the legacy executor errors', async () => {
    const tool = buildAetherTool(sampleLegacyEntry());
    const context = makeContext({
      metadata: {
        mcpTools: [],
        getMcpServers: () => [],
        allowedDirs: [],
        permissionLevel: 2,
        defaultDir: '',
      } as LegacyExecuteOptions & Record<string, unknown>,
    });

    // No allowedDirs → read_file will fail with a path error
    const result = await tool.execute({ path: 'nonexistent.txt' }, context);
    assert.equal(result.kind, 'error');
    assert.equal(result.toolName, 'read_file');
  });

  it('registerLegacyTools registers every builtin tool', () => {
    const registry = new ToolRegistry();
    const count = registerLegacyTools(registry);
    assert.ok(count > 0, 'builtin tools should exist');

    const list = registry.list();
    assert.equal(list.length, count);
    // read_file is among the builtins
    assert.ok(registry.get('read_file'));
    assert.ok(registry.get('execute_command'));
  });

  it('buildRegistryFromLegacyTools creates a pre-populated registry', () => {
    const registry = buildRegistryFromLegacyTools();
    assert.ok(registry.get('read_file'));
    assert.ok(registry.get('grep'));
    assert.ok(registry.get('glob'));
    assert.ok(registry.get('web_search'));
    assert.ok(registry.get('lsp_diagnostics'));
  });

  it('buildZodFromJsonSchema builds a passthrough object schema', () => {
    const schema = buildZodFromJsonSchema(sampleLegacyEntry().function.parameters);
    const parsed = schema.safeParse({ path: '/tmp/x', extra: 1 });
    assert.ok(parsed.success, 'valid input parses');
    assert.equal((parsed.data as { path: string }).path, '/tmp/x');
  });

  it('buildZodFromJsonSchema falls back for missing parameters', () => {
    const schema = buildZodFromJsonSchema(undefined);
    assert.ok(schema.safeParse({ anything: 'goes' }).success);
  });

  it('registered tool executes against a metadata-free context (uses defaults)', async () => {
    const registry = buildRegistryFromLegacyTools();
    const tool = registry.get('read_file');
    assert.ok(tool);
    const context = makeContext(); // no metadata → legacy defaults
    const result = await tool!.execute({ path: 'no-such-file.txt' }, context);
    // read_file with empty allowedDirs → error (path not allowed), never a network call
    assert.equal(result.kind, 'error');
  });
});