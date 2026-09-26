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
import { eq } from 'drizzle-orm';
import { makeTestConfig } from '../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../config/index.js';
import { providers } from '../db/schema/index.js';
import {
  buildRuntimeForProvider,
  buildRuntimeAndRegister,
  buildAllRuntimes,
  resetProviderRuntimeRegistry,
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

  it('P0-14: 解密失败 → ProviderCredentialError（绝不保留密文当 API Key 发送）', () => {
    const enc = encrypt('sk-must-not-leak-999', TEST_ENC_KEY);
    seedProvider('bad-creds', ['m1'], ['text'], enc);
    assert.throws(
      () => buildRuntimeForProvider(getDb(), 'bad-creds', 'wrong-key-00000000000000000000'),
      (err: unknown) => {
        assert.match(String((err as Error).message), /凭据无法解密|credential/i, 'should be a credential error');
        return true;
      },
    );
  });

  it('P0-14: buildAllRuntimes 跳过损坏 provider（一个坏不拖垮全部）', () => {
    seedProvider('bad-creds-bulk', ['m1'], ['text'], encrypt('x', TEST_ENC_KEY));
    const registry = new ModelRegistry();
    const runtimes = buildAllRuntimes(getDb(), registry, 'wrong-key-bulk-0000000000000');
    assert.equal(runtimes.has('bad-creds-bulk'), false, '损坏 provider 应被跳过，不进入 runtime 集合');
    assert.ok(runtimes.size >= 1, '正常 provider 仍应构建');
  });

  // ── P0-007：provider 级熔断器生命周期 ──
  // 旧实现每次调用都新建 runtime/adapter/transport/circuitBreaker，
  // consecutiveFailures 永远到不了阈值 5 → CIRCUIT_OPEN 不可达（死代码）。

  it('P0-007: 同一 providerId 两次构建返回同一 runtime 实例（引用相等）', () => {
    resetProviderRuntimeRegistry();
    seedProvider('reuse-provider', ['m1'], ['text']);
    const first = buildRuntimeForProvider(getDb(), 'reuse-provider');
    const second = buildRuntimeForProvider(getDb(), 'reuse-provider');

    assert.ok(first && second);
    assert.equal(first!.runtime, second!.runtime, '同一 provider 必须复用同一 runtime/transport');
  });

  it('P0-007: 同一 providerId 复用同一 circuitBreaker（连续失败跨请求累积）', () => {
    resetProviderRuntimeRegistry();
    seedProvider('breaker-provider', ['m1'], ['text']);
    const first = buildRuntimeForProvider(getDb(), 'breaker-provider');
    const second = buildRuntimeForProvider(getDb(), 'breaker-provider');

    assert.ok(first && second);
    assert.equal(first!.circuitBreaker, second!.circuitBreaker, '熔断器必须是 provider 级实例');
    first!.circuitBreaker.recordFailure();
    assert.equal(second!.circuitBreaker.consecutiveFailures, 1, '失败计数必须跨请求累积（否则永远不熔断）');
  });

  it('P0-007: buildAllRuntimes 与 buildRuntimeForProvider 共享同一 runtime 实例', () => {
    resetProviderRuntimeRegistry();
    seedProvider('shared-provider', ['m1'], ['text']);
    const direct = buildRuntimeForProvider(getDb(), 'shared-provider');
    const bulk = buildAllRuntimes(getDb(), new ModelRegistry());

    assert.ok(direct);
    assert.equal(bulk.get('shared-provider'), direct!.runtime, '两条构建路径必须落到同一 provider 级实例');
  });

  it('P0-007: 连接配置变更（API Key 轮换）→ 重建 runtime，不复用陈旧凭据', () => {
    resetProviderRuntimeRegistry();
    seedProvider('rotate-provider', ['m1'], ['text'], 'sk-old');
    const before = buildRuntimeForProvider(getDb(), 'rotate-provider');
    assert.ok(before);
    assert.equal(before!.config.apiKey, 'sk-old');

    getDb().update(providers).set({ apiKey: 'sk-new' }).where(eq(providers.id, 'rotate-provider')).run();
    const after = buildRuntimeForProvider(getDb(), 'rotate-provider');

    assert.ok(after);
    assert.notEqual(after!.runtime, before!.runtime, '凭据变更后必须重建（否则继续用旧 Key）');
    assert.equal(after!.config.apiKey, 'sk-new');
  });

  it('P0-007: 解密失败不写缓存 —— 凭据修正后仍可构建', () => {
    resetProviderRuntimeRegistry();
    const enc = encrypt('sk-recoverable', TEST_ENC_KEY);
    seedProvider('recover-provider', ['m1'], ['text'], enc);

    assert.throws(() => buildRuntimeForProvider(getDb(), 'recover-provider', 'wrong-key-000000000000000000'));

    const recovered = buildRuntimeForProvider(getDb(), 'recover-provider', TEST_ENC_KEY);
    assert.ok(recovered, '解密失败不得把 provider 永久钉死在失败状态');
    assert.equal(recovered!.config.apiKey, 'sk-recoverable');
  });

  it('P0-007: resetProviderRuntimeRegistry 清空注册表（配置变更/测试隔离）', () => {
    seedProvider('reset-provider', ['m1'], ['text']);
    const before = buildRuntimeForProvider(getDb(), 'reset-provider');
    assert.ok(before);

    resetProviderRuntimeRegistry();
    const after = buildRuntimeForProvider(getDb(), 'reset-provider');

    assert.ok(after);
    assert.notEqual(after!.runtime, before!.runtime, 'reset 后必须重新构建');
  });
});