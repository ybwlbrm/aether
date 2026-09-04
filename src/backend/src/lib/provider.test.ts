import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { providerSupportsThinking, type ResolvedProvider } from './provider.js';

function p(baseUrl: string, models: string[] = ['test-model']): ResolvedProvider {
  return {
    id: 'x', name: 'x', type: 'openai',
    apiKey: 'k', baseUrl, defaultModel: models[0], models,
    capabilities: ['text'],
  };
}

describe('providerSupportsThinking 真值表', () => {
  it('deepseek baseUrl → true', () => {
    assert.equal(providerSupportsThinking(p('https://api.deepseek.com', ['deepseek-chat'])), true);
  });

  it('openai baseUrl + gpt-4o → false', () => {
    assert.equal(providerSupportsThinking(p('https://api.openai.com/v1', ['gpt-4o'])), false);
  });

  it('模型名含 reasoner → true（即使 baseUrl 非 deepseek）', () => {
    assert.equal(providerSupportsThinking(p('https://sandbox.example.com', ['deepseek-reasoner-r1-0528'])), true);
  });

  it('模型名含 r1 → true', () => {
    assert.equal(providerSupportsThinking(p('https://sandbox.example.com', ['awesomemodel-r1'])), true);
  });

  it('显式传入 model 参数覆盖默认模型判断', () => {
    assert.equal(providerSupportsThinking(p('https://api.openai.com/v1', ['gpt-4o']), 'deepseek-v4-thinking'), true);
  });

  it('null provider → false', () => {
    assert.equal(providerSupportsThinking(null), false);
  });

  it('sensenova 平台 + deepseek-v4-flash 模型 → true', () => {
    assert.equal(providerSupportsThinking(p('https://token.sensenova.cn/v1', ['deepseek-v4-flash'])), true);
  });

  it('sensenova 平台 + glm-5.2 → false', () => {
    assert.equal(providerSupportsThinking(p('https://token.sensenova.cn/v1', ['glm-5.2'])), false);
  });
});