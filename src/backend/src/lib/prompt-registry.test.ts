/**
 * Prompt Registry tests (§26/§27)
 *
 * 验证：
 * - getEffectivePrompt 回退默认 Prompt
 * - setPrompt 后所有生产路径（普通 Chat / Super Worker / Synth / Direct）读取同一覆盖
 * - clearPrompt 恢复默认
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getEffectivePrompt,
  setPrompt,
  getAllPrompts,
  clearPrompt,
} from './prompt-registry.js';

describe('lib/prompt-registry', () => {
  it('§26: 未覆盖时回退默认 Prompt', () => {
    assert.equal(getEffectivePrompt('sisyphus', 'DEFAULT'), 'DEFAULT');
    assert.equal(getEffectivePrompt('oracle', 'ORACLE_DEFAULT'), 'ORACLE_DEFAULT');
  });

  it('§26: setPrompt 后 getEffectivePrompt 返回覆盖（所有路径读取同一实例）', () => {
    setPrompt('sisyphus', 'CUSTOM_SISYPHUS');
    // 普通 Chat 路径、Synth 路径、Direct 路径、Worker 路径都经 getEffectivePrompt
    assert.equal(getEffectivePrompt('sisyphus', 'DEFAULT'), 'CUSTOM_SISYPHUS');
    assert.equal(getEffectivePrompt('sisyphus', 'OTHER_FALLBACK'), 'CUSTOM_SISYPHUS');
  });

  it('§26: 不同 agent 覆盖互不干扰', () => {
    setPrompt('sisyphus', 'S1');
    setPrompt('oracle', 'O1');
    assert.equal(getEffectivePrompt('sisyphus', 'D'), 'S1');
    assert.equal(getEffectivePrompt('oracle', 'D'), 'O1');
    assert.equal(getEffectivePrompt('librarian', 'D'), 'D', '未覆盖 agent 回退默认');
  });

  it('§27: getAllPrompts 返回同一共享实例（与生产路径一致）', () => {
    setPrompt('hephaestus', 'H1');
    const all = getAllPrompts();
    assert.equal(all.get('hephaestus'), 'H1');
  });

  it('§27: clearPrompt 恢复默认', () => {
    setPrompt('sisyphus', 'TEMP');
    clearPrompt('sisyphus');
    assert.equal(getEffectivePrompt('sisyphus', 'DEFAULT'), 'DEFAULT');
  });
});
