/**
 * sync-runtime tests（T4/T5/T6/T7 共享基座）
 *
 * 覆盖 ensureSyncRuntime 的幂等语义与 getSyncRuntimeHealth 的状态聚合：
 * - 未配置时 health 全 false（不抛错，供 status 端点复用）
 * - syncConfig / supabase 客户端缺失 → 返回 false 且不触发监听启动
 * - 重入守卫：并发两次调用只触发一次 setupRealtimeListener
 * - 启动失败向上抛给调用方（由 index.ts 的 fire-and-forget catch 记录日志）
 *
 * setupRealtimeListener 通过 node:test 模块 mock 打桩（避免真实建 channel / 起轮询定时器）；
 * sync-config 使用真实 setter 注入状态（模块级单例，无需 mock）。
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BackendConfig } from '../../config/index.js';
import {
  setSyncConfig,
  setSupabaseClient,
  setRealtimeChannel,
  type SyncConfig,
} from './sync-config.js';

// ---- setupRealtimeListener 打桩 ----
// node:test 的模块 mock 对同一 specifier 只允许注册一次（重复注册抛 ERR_INVALID_STATE），
// 故此处一次性注册可变桩，由 setupCalls 计数器与 setupGate 闸门控制各用例行为。
// 注：运行时推荐 mock.module(spec, { exports })，但仓库锁定的 @types/node 尚未声明该字段，
// 故用类型安全的 namedExports（Node 仍支持，仅有 deprecation 提示）。
let setupCalls = 0;
let setupGate: Promise<void> | null = null;
let setupError: Error | null = null;

mock.module('./realtime.js', {
  namedExports: {
    setupRealtimeListener: async () => {
      setupCalls += 1;
      if (setupError) throw setupError;
      if (setupGate) await setupGate;
    },
  },
});

// 必须在 mock.module 之后动态导入，sync-runtime 的静态 import 才会命中桩
const { ensureSyncRuntime, getSyncRuntimeHealth } = await import('./sync-runtime.js');

function fakeBackendConfig(): BackendConfig {
  return {
    port: 3000,
    host: '127.0.0.1',
    dataDir: './data',
    encryptionKey: 'test-encryption-key',
    dbPath: './data/pacc.db',
    allowedDirs: ['./data'],
    allowedOrigins: ['http://127.0.0.1:3000'],
    enableSwagger: false,
  };
}

function fakeSyncConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    supabaseUrl: 'https://test.supabase.co',
    supabaseKey: 'test-key',
    deviceId: 'device-123',
    ...overrides,
  };
}

/** 仅作占位客户端传入 —— setupRealtimeListener 已打桩，不会真的访问网络 */
function fakeSupabaseClient(): SupabaseClient {
  return {} as unknown as SupabaseClient;
}

/** 手闸门：让桩悬停在指定时机，制造真实的并发窗口 */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

beforeEach(() => {
  setupCalls = 0;
  setupGate = null;
  setupError = null;
  setSyncConfig(null);
  setSupabaseClient(null);
  setRealtimeChannel(null);
});

describe('sync-runtime getSyncRuntimeHealth', () => {
  it('未配置时 health 全为 false（不抛错）', () => {
    assert.deepEqual(getSyncRuntimeHealth(), {
      configured: false,
      connected: false,
      realtimeListening: false,
      userIdBound: false,
    });
  });

  it('配置就绪时 userIdBound 反映 cfg.userId', () => {
    setSyncConfig(fakeSyncConfig({ userId: 'user-456' }));
    setSupabaseClient(fakeSupabaseClient());
    setRealtimeChannel({ unsubscribe: () => {} });

    assert.deepEqual(getSyncRuntimeHealth(), {
      configured: true,
      connected: true,
      realtimeListening: true,
      userIdBound: true,
    });
  });

  it('未绑定身份时 configured=true 但 userIdBound=false', () => {
    setSyncConfig(fakeSyncConfig());
    setSupabaseClient(fakeSupabaseClient());

    const health = getSyncRuntimeHealth();
    assert.equal(health.configured, true);
    assert.equal(health.connected, true);
    assert.equal(health.realtimeListening, false);
    assert.equal(health.userIdBound, false);
  });
});

describe('sync-runtime ensureSyncRuntime', () => {
  it('syncConfig 为 null 时返回 false 且不启动监听', async () => {
    assert.equal(await ensureSyncRuntime(fakeBackendConfig()), false);
    assert.equal(setupCalls, 0, '未配置时不得触发 setupRealtimeListener');
  });

  it('supabase 客户端缺失时返回 false 且不启动监听', async () => {
    setSyncConfig(fakeSyncConfig());

    assert.equal(await ensureSyncRuntime(fakeBackendConfig()), false);
    assert.equal(setupCalls, 0, '无 supabase 客户端时不得触发 setupRealtimeListener');
  });

  it('配置就绪时返回 true 并启动一次监听', async () => {
    setSyncConfig(fakeSyncConfig({ userId: 'user-456' }));
    setSupabaseClient(fakeSupabaseClient());

    assert.equal(await ensureSyncRuntime(fakeBackendConfig()), true);
    assert.equal(setupCalls, 1);
  });

  it('并发两次调用只触发一次 setupRealtimeListener（重入守卫）', async () => {
    const gate = deferred();
    setupGate = gate.promise;

    setSyncConfig(fakeSyncConfig({ userId: 'user-456' }));
    setSupabaseClient(fakeSupabaseClient());

    // 两次调用同时在飞：第二次必须复用第一次的启动 promise
    const first = ensureSyncRuntime(fakeBackendConfig());
    const second = ensureSyncRuntime(fakeBackendConfig());

    gate.release();
    const results = await Promise.all([first, second]);

    assert.equal(setupCalls, 1, '并发调用必须共享同一次启动');
    assert.deepEqual(results, [true, true]);

    // 守卫在启动结束后释放 —— 后续显式调用仍可重新启动（setupRealtimeListener 自身幂等）
    assert.equal(await ensureSyncRuntime(fakeBackendConfig()), true);
    assert.equal(setupCalls, 2, '启动结束后守卫必须释放，后续调用可重启');
  });

  it('启动失败时向上抛错（由调用方 fire-and-forget catch 记录日志）', async () => {
    setupError = new Error('subscribe failed');
    setSyncConfig(fakeSyncConfig());
    setSupabaseClient(fakeSupabaseClient());

    await assert.rejects(
      () => ensureSyncRuntime(fakeBackendConfig()),
      /subscribe failed/,
    );

    // 失败后守卫同样释放，允许后续重试
    setupError = null;
    assert.equal(await ensureSyncRuntime(fakeBackendConfig()), true);
    assert.equal(setupCalls, 2);
  });
});
