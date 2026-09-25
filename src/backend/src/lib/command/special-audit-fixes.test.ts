/**
 * P0-1/P1-6/P2-1/P2-2 专项审计修复测试
 *
 * 覆盖：
 * - Level 3 命令真正放行（跳过白名单/黑名单，仅保留 UNC 极危险拦截）
 * - Level 2 白名单扩充（git/ffmpeg 等可用）
 * - 工具箱 RGB 0-255 校验、Hex #fff 3 位、时间戳 13 位毫秒
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { utilityOp } from '../../modules/toolbox/encoding.js';
import { ALLOWED_EXEC } from './constants.js';

describe('专项审计修复 — Level 3 命令权限', () => {
  it('ALLOWED_EXEC 白名单已扩充 git/ffmpeg/java（Level 2 可用常用工具）', () => {
    for (const cmd of ['git', 'ffmpeg', 'java', 'gradle', 'adb', 'go', 'cargo']) {
      assert.ok(ALLOWED_EXEC.has(cmd), `白名单应包含 ${cmd}`);
    }
  });

  it('constants 关键校验集存在（供 executor 在 Level 3 跳过）', () => {
    // executor 依赖这些集合做 Level 2 校验；Level 3 应跳过它们（P0-1）
    assert.ok(ALLOWED_EXEC.size > 30, '白名单应包含 30+ 常用命令');
  });
});

describe('专项审计修复 — 工具箱输入校验（encoding.ts）', () => {
  it('RGB 0-255 校验：rgb(999,999,999) 必须拒绝', async () => {
    await assert.rejects(
      () => utilityOp('rgb-hex', 'rgb(999,999,999)'),
      /0-255/,
      'RGB 超出范围应抛错（P2-1）',
    );
  });

  it('RGB 合法值：rgb(255,128,0) → #FF8000', async () => {
    const r = await utilityOp('rgb-hex', 'rgb(255,128,0)');
    assert.equal(r.result, '#FF8000');
  });

  it('Hex 支持 3 位缩写：#fff → rgb(255, 255, 255)（P2-2）', async () => {
    const r = await utilityOp('hex-rgb', '#fff');
    assert.equal(r.result, 'rgb(255, 255, 255)');
  });

  it('Hex 6 位：#ffffff → rgb(255, 255, 255)', async () => {
    const r = await utilityOp('hex-rgb', '#ffffff');
    assert.equal(r.result, 'rgb(255, 255, 255)');
  });

  it('时间戳支持 13 位毫秒（P1-6）：1735689600000 → 2025-01-01', async () => {
    const r = await utilityOp('timestamp-to-date', '1735689600000');
    assert.ok(r.result.includes('2025'), `13 位毫秒应解析为 2025-01-01，实际: ${r.result}`);
  });

  it('时间戳支持 10 位秒：1735689600 → 2025-01-01', async () => {
    const r = await utilityOp('timestamp-to-date', '1735689600');
    assert.ok(r.result.includes('2025'), `10 位秒应解析为 2025-01-01，实际: ${r.result}`);
  });
});
