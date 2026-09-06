/**
 * ModelRuntimeBridge tests (Phase 4-3 — legacy providers table → core ModelRuntime)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/migrate.js';
import { initDb, getDb } from '../db/client.js';
import { makeTestConfig } from '../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../config/index.js';
import { providers } from '../db/schema/index.js';
import {
  buildRuntimeForProvider,
  buildRuntimeAndRegister,
  buildAllRuntimes,
} from './model-runtime-bridge.js';
import { ModelRegistry } from '../core/models/index.js';
import { OpenAICompatibleAdapter } from '../core/models/index.js';
import { encrypt, isEncrypted } from './crypto.js';

let cfg: BackendConfig;
let dir: string;

/** 测试用固定 encryptionKey（与 config 保持一致） */
const TEST_ENC_KEY = 'test-encryption-key-0123456789abcdef';

function seedProvider(id: string, models: string[], capabilities: string[], apiKey?: string): void {
  getDb().insert(providers).values({
    id,
    name: id,
    type: 'openai',
    apiKey: apiKey ?? 'sk-test',
    baseUrl: 'https://api.example.com/v1',
    models: JSON.stringify(models),
    capabilities: JSON.stringify(capabilities),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();
}

describe('lib/model-runtime-bridge', () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pacc-bridge-'));
    cfg = makeTestConfig(dir);
    await runMigrations(cfg as never);
    await initDb(cfg as never);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('buildRuntimeForProvider returns a runtime for an existing provider', () => {
    seedProvider('openai', ['gpt-4', 'gpt-4o'], ['text', 'tool_calling']);
    const built = buildRuntimeForProvider(getDb(), 'openai');

    assert.ok(built, 'provider runtime should resolve');
    assert.ok(built!.runtime instanceof OpenAICompatibleAdapter);
    assert.equal(built!.config.id, 'openai');
    assert.deepEqual(built!.config.models, ['gpt-4', 'gpt-4o']);
    assert.deepEqual(built!.config.capabilities, ['text', 'tool_calling']);
  });

  it('buildRuntimeForProvider returns null for an unknown provider', () => {
    const built = buildRuntimeForProvider(getDb(), 'nope');
    assert.equal(built, null);
  });

  it('buildRuntimeAndRegister builds a runtime and registers its models', () => {
    seedProvider('anthropic', ['claude-3-opus'], ['text', 'vision']);
    const registry = new ModelRegistry();
    const runtime = buildRuntimeAndRegister(getDb(), registry, 'anthropic');

    assert.ok(runtime instanceof OpenAICompatibleAdapter);
    const spec = registry.get('anthropic', 'claude-3-opus');
    assert.ok(spec, 'model should be registered');
    assert.equal(spec!.capabilities.vision, true);
    assert.equal(spec!.capabilities.text, true);
  });

  it('buildRuntimeAndRegister returns null for unknown provider', () => {
    const registry = new ModelRegistry();
    const runtime = buildRuntimeAndRegister(getDb(), registry, 'missing');
    assert.equal(runtime, null);
  });

  it('buildAllRuntimes builds runtimes for every provider row', () => {
    seedProvider('deepseek', ['deepseek-v4'], ['text', 'reasoning']);
    const registry = new ModelRegistry();
    const runtimes = buildAllRuntimes(getDb(), registry);

    // openai + anthropic + deepseek seeded so far
    assert.ok(runtimes.has('openai'));
    assert.ok(runtimes.has('anthropic'));
    assert.ok(runtimes.has('deepseek'));
    assert.equal(runtimes.size, 3);

    // every runtime is a working ModelRuntime with HTTP transport enabled
    for (const runtime of runtimes.values()) {
      assert.ok(runtime instanceof OpenAICompatibleAdapter);
      assert.equal(typeof runtime.complete, 'function');
      assert.equal(typeof runtime.stream, 'function');
    }

    // registry contains all models across providers
    const allModels = registry.list();
    assert.ok(allModels.some((m) => m.providerId === 'deepseek' && m.model.id === 'deepseek-v4'));
  });

  it('P0-13: buildRuntimeForProvider 解密加密的 API Key（密文不当明文用）', () => {
    const plain = 'sk-secret-plain-123';
    const enc = encrypt(plain, TEST_ENC_KEY);
    assert.ok(isEncrypted(enc), 'encrypt 应产出密文格式');
    seedProvider('enc-provider', ['m1'], ['text'], enc);
    const built = buildRuntimeForProvider(getDb(), 'enc-provider', TEST_ENC_KEY);
    assert.ok(built, 'provider runtime should resolve');
    assert.equal(built!.config.apiKey, plain, 'bridge 必须把密文解密为明文 API Key');
    assert.notEqual(built!.config.apiKey, enc, '绝不能用密文当 API Key');
  });

  it('P0-13: 不传 encryptionKey 时密文原样透传（兼容旧调用/测试）', () => {
    const enc = encrypt('sk-old', TEST_ENC_KEY);
    seedProvider('enc-no-key', ['m1'], ['text'], enc);
    const built = buildRuntimeForProvider(getDb(), 'enc-no-key');
    assert.ok(built);
    assert.equal(built!.config.apiKey, enc, '无 key 时不解密（透传），调用方负责处理');
  });
});