import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { providerSupportsThinking, type ResolvedProvider, selectProviderByCapability } from './provider.js';

function p(id: string, capabilities: string[], overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id, name: id, type: 'openai',
    apiKey: 'k', baseUrl: 'https://api.example.com/v1',
    defaultModel: 'm', models: ['m'], capabilities,
    isDefault: false,
    ...overrides,
  };
}

describe('providerSupportsThinking 真值表', () => {
  it('deepseek baseUrl → true', () => {
    assert.equal(providerSupportsThinking(p('x', ['text'], { baseUrl: 'https://api.deepseek.com' })), true);
  });

  it('openai baseUrl + gpt-4o → false', () => {
    assert.equal(providerSupportsThinking(p('x', ['text'], { baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o'] })), false);
  });

  it('模型名含 reasoner → true', () => {
    assert.equal(providerSupportsThinking(p('x', ['text'], { baseUrl: 'https://sandbox.example.com', models: ['deepseek-reasoner-r1-0528'] })), true);
  });

  it('模型名含 r1 → true', () => {
    assert.equal(providerSupportsThinking(p('x', ['text'], { baseUrl: 'https://sandbox.example.com', models: ['awesomemodel-r1'] })), true);
  });

  it('显式传入 model 参数覆盖默认模型判断', () => {
    assert.equal(providerSupportsThinking(p('x', ['text'], { baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o'] }), 'deepseek-v4-thinking'), true);
  });

  it('null provider → false', () => {
    assert.equal(providerSupportsThinking(null), false);
  });

  it('sensenova 平台 + deepseek-v4-flash 模型 → true', () => {
    assert.equal(providerSupportsThinking(p('x', ['text'], { baseUrl: 'https://token.sensenova.cn/v1', models: ['deepseek-v4-flash'] })), true);
  });

  it('sensenova 平台 + glm-5.2 → false', () => {
    assert.equal(providerSupportsThinking(p('x', ['text'], { baseUrl: 'https://token.sensenova.cn/v1', models: ['glm-5.2'] })), false);
  });
});

describe('selectProviderByCapability（Wave0-PV：能力过滤优先 / 拒绝悄悄 fallback / isDefault）', () => {
  const textP = p('text-p', ['text']);
  const imgP = p('img-p', ['image']);
  const videoP = p('vid-p', ['video']);

  it('REGRESSION-FIX: defaultProviders[capability] 指向能力不符的 provider 时不再被返回（先过滤后选默认）', () => {
    // 用户把默认 text provider 设成了 image provider —— 请求 text 不得返回它
    const result = selectProviderByCapability([textP, imgP], 'text', { text: 'img-p' });
    assert.ok(result, '仍有 text capability 的 provider');
    assert.equal(result!.id, 'text-p', '必须返回能力匹配的 provider，而非默认设置但能力不符的');
  });

  it('REGRESSION-FIX: 无匹配 capability 返回 null（拒绝悄悄 fallback 到任意 provider）', () => {
    assert.equal(selectProviderByCapability([textP], 'video', {}), null);
    assert.equal(selectProviderByCapability([], 'text', {}), null);
  });

  it('defaultProviders 指向能力匹配的 provider → 优先返回', () => {
    const a = p('a', ['text']);
    const b = p('b', ['text']);
    assert.equal(selectProviderByCapability([a, b], 'text', { text: 'b' })!.id, 'b');
  });

  it('isDefault 标记优先（P1-19 映射后真实生效）', () => {
    const a = p('a', ['text']);
    const d = p('d', ['text'], { isDefault: true });
    const result = selectProviderByCapability([a, d], 'text', {});
    assert.equal(result!.id, 'd');
  });

  it('默认无 isDefault 时返回第一个能力匹配项', () => {
    assert.equal(selectProviderByCapability([textP, imgP], 'text', {})!.id, 'text-p');
  });
});