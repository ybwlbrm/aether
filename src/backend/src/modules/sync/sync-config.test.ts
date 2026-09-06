/**
 * sync-config tests (P0-15, P0-16, P1-17, P1-18, P1-35)
 * 纯逻辑层面测试：buildOwnershipFilters、computeConfigFingerprint、buildSyncResponse
 * 不依赖真实 Supabase/数据库
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOwnershipFilters,
  computeConfigFingerprint,
  buildSyncResponse,
  type SyncConfig,
  type OwnershipFilters,
} from './sync-config.js';

describe('sync-config pure logic', () => {
  // ============================================================
  // buildOwnershipFilters tests (P0-15, P1-35)
  // ============================================================

  it('buildOwnershipFilters: returns userId and deviceId from config', () => {
    const cfg: SyncConfig = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseKey: 'test-key',
      deviceId: 'device-123',
      userId: 'user-456',
    };
    const filters = buildOwnershipFilters(cfg);
    assert.deepEqual(filters, { userId: 'user-456', deviceId: 'device-123' });
  });

  it('buildOwnershipFilters: returns null userId when not configured (P0-15: no full-table scan)', () => {
    const cfg: SyncConfig = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseKey: 'test-key',
      deviceId: 'device-123',
      // userId 故意不设置
    };
    const filters = buildOwnershipFilters(cfg);
    assert.deepEqual(filters, { userId: null, deviceId: 'device-123' });
  });

  it('buildOwnershipFilters: returns null for both when config is null', () => {
    const filters = buildOwnershipFilters(null);
    assert.deepEqual(filters, { userId: null, deviceId: null });
  });

  // ============================================================
  // computeConfigFingerprint tests (P1-17)
  // ============================================================

  it('computeConfigFingerprint: includes URL, Key, deviceId only', () => {
    const cfg: SyncConfig = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseKey: 'test-key',
      deviceId: 'device-123',
      deviceName: 'My Device',
      deviceType: 'desktop',
      userId: 'user-456',
    };
    const fp = computeConfigFingerprint(cfg);
    // 指纹不应包含 deviceName/deviceType/userId
    assert.equal(fp, 'https://test.supabase.co|test-key|device-123');
  });

  it('computeConfigFingerprint: changes when URL/Key/deviceId changes', () => {
    const cfg1: SyncConfig = { supabaseUrl: 'https://a.supabase.co', supabaseKey: 'key1', deviceId: 'dev1' };
    const cfg2: SyncConfig = { supabaseUrl: 'https://b.supabase.co', supabaseKey: 'key1', deviceId: 'dev1' };
    const cfg3: SyncConfig = { supabaseUrl: 'https://a.supabase.co', supabaseKey: 'key2', deviceId: 'dev1' };
    const cfg4: SyncConfig = { supabaseUrl: 'https://a.supabase.co', supabaseKey: 'key1', deviceId: 'dev2' };

    assert.notEqual(computeConfigFingerprint(cfg1), computeConfigFingerprint(cfg2));
    assert.notEqual(computeConfigFingerprint(cfg1), computeConfigFingerprint(cfg3));
    assert.notEqual(computeConfigFingerprint(cfg1), computeConfigFingerprint(cfg4));
  });

  it('computeConfigFingerprint: stable when only deviceName/deviceType changes', () => {
    const cfg1: SyncConfig = { supabaseUrl: 'https://a.supabase.co', supabaseKey: 'key1', deviceId: 'dev1', deviceName: 'A', deviceType: 'desktop' };
    const cfg2: SyncConfig = { supabaseUrl: 'https://a.supabase.co', supabaseKey: 'key1', deviceId: 'dev1', deviceName: 'B', deviceType: 'mobile' };
    assert.equal(computeConfigFingerprint(cfg1), computeConfigFingerprint(cfg2));
  });

  it('computeConfigFingerprint: returns "none" for null config', () => {
    assert.equal(computeConfigFingerprint(null), 'none');
  });

  // ============================================================
  // buildSyncResponse tests (P1-18)
  // ============================================================

  it('buildSyncResponse: all success -> success=true, no partial/failed', () => {
    const results = { knowledge: '成功', settings: '成功', conversations: '同步 5 条消息，0 条失败' };
    const resp = buildSyncResponse(results);
    assert.equal(resp.success, true);
    assert.equal(resp.partial, undefined);
    assert.equal(resp.failed, undefined);
    assert.deepEqual(resp.results, results);
  });

  it('buildSyncResponse: any failure -> success=false, partial=true, failed=N', () => {
    const results = { knowledge: '失败: RLS violation', settings: '成功', conversations: '同步 3 条消息，2 条失败' };
    const resp = buildSyncResponse(results);
    assert.equal(resp.success, false);
    assert.equal(resp.partial, true);
    assert.equal(resp.failed, 1); // 只有 knowledge 失败
    assert.deepEqual(resp.results, results);
  });

  it('buildSyncResponse: multiple failures -> failed counts correctly', () => {
    // 只有 knowledge 和 settings 可能以 '失败' 开头，conversations 结果始终以 '同步' 开头
    const results = { knowledge: '失败: error1', settings: '失败: error2', conversations: '同步 0 条消息，5 条失败' };
    const resp = buildSyncResponse(results);
    assert.equal(resp.success, false);
    assert.equal(resp.partial, true);
    assert.equal(resp.failed, 2); // knowledge 和 settings 两项失败
  });

  it('buildSyncResponse: empty results -> success=true', () => {
    const results = {};
    const resp = buildSyncResponse(results);
    assert.equal(resp.success, true);
    assert.equal(resp.partial, undefined);
    assert.equal(resp.failed, undefined);
  });

  // ============================================================
  // P0-16: userId immutability from request body (conceptual test)
  // 实际路由层在 registerSyncConfigRoutes 中实现：保留旧配置的 userId，忽略 body.userId
  // 这里验证 buildOwnershipFilters 不会被外部 userId 污染
  // ============================================================

  it('P0-16: ownership filters derive userId only from config, not from external input', () => {
    // 模拟：配置中已有 userId（来自设备注册/云端身份）
    const cfgWithUser: SyncConfig = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseKey: 'test-key',
      deviceId: 'device-123',
      userId: 'registered-user-789',
    };
    const filters = buildOwnershipFilters(cfgWithUser);
    // 过滤器必须使用配置绑定的 userId
    assert.equal(filters.userId, 'registered-user-789');
    // 即使外部尝试传入不同 userId，纯函数层面不受影响（路由层已拦截）
  });

  // ============================================================
  // P1-35: download filters by both user_id + device_id
  // ============================================================

  it('P1-35: buildOwnershipFilters provides both userId and deviceId for download queries', () => {
    const cfg: SyncConfig = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseKey: 'test-key',
      deviceId: 'device-123',
      userId: 'user-456',
    };
    const filters = buildOwnershipFilters(cfg);
    // 下载查询应同时使用 user_id 和 device_id
    assert.equal(filters.userId, 'user-456');
    assert.equal(filters.deviceId, 'device-123');
  });

  it('P1-35: when userId missing, deviceId still available but queries should return empty (handled by route)', () => {
    const cfg: SyncConfig = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseKey: 'test-key',
      deviceId: 'device-123',
    };
    const filters = buildOwnershipFilters(cfg);
    assert.equal(filters.userId, null);
    assert.equal(filters.deviceId, 'device-123');
    // 路由层会检查 userId 为 null 时直接返回空数组
  });
});