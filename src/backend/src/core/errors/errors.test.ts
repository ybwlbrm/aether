/**
 * Errors Module Tests
 *
 * Tests for the core/errors module (P1-41..P1-44).
 * Run with: npm run test -w src/backend (after build)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
// 类型侧需要 AetherError 作为注解；值侧走下方 dynamic import（编译后从 dist/ 载入）。
// import type 会被完全擦除，不影响运行时。
import type { AetherError as AetherErrorType } from './index.js';

// Import after build — tests run from dist/
const {
  AetherError,
  RuntimeError,
  ModelError,
  ToolError,
  ExecutionError,
  WorkflowError,
  SyncError,
  ModelTransientError,
  ModelPermanentError,
  ModelTimeoutError,
  ModelStreamError,
  ToolTransientError,
  ToolPermanentError,
  ToolTimeoutError,
  ToolCancelledError,
  VerificationError,
  BudgetExceededError,
  AttemptFailedError,
  RetryError,
  RetryExhaustedError,
  ProviderCredentialError,
  ErrorCode,
  ERROR_CATEGORIES,
  isRetryable,
} = await import('./index.js');

/** Minimal ModelError options for taxonomy probes. */
const modelOpts = { provider: 'openai', model: 'gpt-4' };
/** Minimal ToolError options for taxonomy probes. */
const toolOpts = { toolName: 'python-runner' };

describe('core/errors', () => {
  describe('RuntimeError', () => {
    it('JSON serialization round-trip preserves all fields', () => {
      const original = new RuntimeError('Something went wrong', {
        code: 'TEST_ERROR',
        cause: new Error('root cause'),
        context: { key: 'value', count: 42 },
        retryable: true,
      });

      const json = original.toJSON();
      const serialized = JSON.stringify(json);
      const parsed = JSON.parse(serialized);

      assert.equal(parsed.name, 'RuntimeError');
      assert.equal(parsed.message, 'Something went wrong');
      assert.equal(parsed.code, 'TEST_ERROR');
      assert.equal(parsed.retryable, true);
      assert.deepEqual(parsed.context, { key: 'value', count: 42 });
      assert.equal(parsed.cause, 'root cause');
      assert.ok(typeof parsed.stack === 'string');
    });

    it('cause chain preserved via error.cause option', () => {
      const rootCause = new Error('original failure');
      const wrapper = new RuntimeError('wrapped', {
        code: 'WRAPPED',
        cause: rootCause,
      });

      assert.equal(wrapper.cause, rootCause);
      assert.ok(wrapper.cause instanceof Error);
      assert.equal((wrapper.cause as Error).message, 'original failure');
    });

    it('cause can be non-Error values', () => {
      const err = new RuntimeError('failed', {
        code: 'NON_ERROR_CAUSE',
        cause: 'string cause',
      });

      assert.equal(err.cause, 'string cause');
      assert.equal(err.toJSON().cause, 'string cause');
    });

    it('isRuntimeError type guard works', () => {
      const err = new RuntimeError('test', { code: 'TEST' });
      assert.ok(RuntimeError.isRuntimeError(err));
      assert.ok(!RuntimeError.isRuntimeError(new Error('plain')));
      assert.ok(!RuntimeError.isRuntimeError(null));
      assert.ok(!RuntimeError.isRuntimeError({ message: 'obj' }));
    });

    it('defaults: retryable=false, empty context', () => {
      const err = new RuntimeError('minimal', { code: 'MINIMAL' });
      assert.equal(err.retryable, false);
      assert.equal(err.context, undefined);
      assert.equal(err.cause, undefined);
    });
  });

  describe('ModelError', () => {
    it('rate-limit (statusCode 429) => retryable=true', () => {
      const err = new ModelError('Rate limited', {
        provider: 'openai',
        model: 'gpt-4',
        statusCode: 429,
      });

      assert.equal(err.provider, 'openai');
      assert.equal(err.model, 'gpt-4');
      assert.equal(err.statusCode, 429);
      assert.equal(err.retryable, true);
      assert.equal(err.code, 'MODEL_ERROR');
    });

    it('rateLimitReset set => retryable=true', () => {
      const err = new ModelError('Rate limited', {
        provider: 'anthropic',
        rateLimitReset: Date.now() + 60000,
      });

      assert.ok(err.rateLimitReset != null);
      assert.equal(err.retryable, true);
    });

    it('5xx statusCode => retryable=true', () => {
      const err = new ModelError('Internal server error', {
        provider: 'ollama',
        statusCode: 503,
      });

      assert.equal(err.statusCode, 503);
      assert.equal(err.retryable, true);
    });

    it('4xx (non-429) => retryable=false by default', () => {
      const err = new ModelError('Bad request', {
        provider: 'openai',
        statusCode: 400,
      });

      assert.equal(err.statusCode, 400);
      assert.equal(err.retryable, false);
    });

    it('explicit retryable override works', () => {
      const err = new ModelError('Custom', {
        provider: 'test',
        statusCode: 400,
        retryable: true,
      });

      assert.equal(err.retryable, true);
    });

    it('toJSON includes provider/model/rateLimitReset/statusCode', () => {
      const err = new ModelError('Test', {
        provider: 'openai',
        model: 'gpt-4',
        statusCode: 429,
        rateLimitReset: 1234567890,
      });

      const json = err.toJSON();
      assert.equal(json.name, 'ModelError');
      assert.equal(json.provider, 'openai');
      assert.equal(json.model, 'gpt-4');
      assert.equal(json.statusCode, 429);
      assert.equal(json.rateLimitReset, 1234567890);
    });

    it('isModelError type guard works', () => {
      const err = new ModelError('test', { provider: 'test' });
      assert.ok(ModelError.isModelError(err));
      assert.ok(!ModelError.isModelError(new RuntimeError('x', { code: 'X' })));
    });
  });

  describe('ToolError', () => {
    it('carries toolName and exitCode', () => {
      const err = new ToolError('Script failed', {
        toolName: 'python-runner',
        input: { script: 'print(1/0)' },
        exitCode: 1,
      });

      assert.equal(err.toolName, 'python-runner');
      assert.deepEqual(err.input, { script: 'print(1/0)' });
      assert.equal(err.exitCode, 1);
      assert.equal(err.code, 'TOOL_ERROR');
      assert.equal(err.retryable, false);
    });

    it('toJSON includes toolName/input/exitCode', () => {
      const err = new ToolError('Failed', {
        toolName: 'my-tool',
        exitCode: 2,
      });

      const json = err.toJSON();
      assert.equal(json.name, 'ToolError');
      assert.equal(json.toolName, 'my-tool');
      assert.equal(json.exitCode, 2);
    });

    it('isToolError type guard works', () => {
      const err = new ToolError('test', { toolName: 'test' });
      assert.ok(ToolError.isToolError(err));
      assert.ok(!ToolError.isToolError(new RuntimeError('x', { code: 'X' })));
    });
  });

  describe('RetryError', () => {
    it('always retryable=true', () => {
      const err = new RetryError('Transient', {
        attempt: 1,
        maxAttempts: 3,
        backoffMs: 1000,
      });

      assert.equal(err.retryable, true);
      assert.equal(err.attempt, 1);
      assert.equal(err.maxAttempts, 3);
      assert.equal(err.backoffMs, 1000);
      assert.equal(err.code, 'RETRY_ERROR');
    });

    it('isExhausted() returns false before maxAttempts', () => {
      const err = new RetryError('Retry 1 of 3', {
        attempt: 1,
        maxAttempts: 3,
        backoffMs: 1000,
      });

      assert.equal(err.isExhausted(), false);
    });

    it('isExhausted() returns true at maxAttempts', () => {
      const err = new RetryError('Retry 3 of 3', {
        attempt: 3,
        maxAttempts: 3,
        backoffMs: 1000,
      });

      assert.equal(err.isExhausted(), true);
    });

    it('toJSON includes attempt/maxAttempts/backoffMs', () => {
      const err = new RetryError('Retry', {
        attempt: 2,
        maxAttempts: 5,
        backoffMs: 2000,
      });

      const json = err.toJSON();
      assert.equal(json.attempt, 2);
      assert.equal(json.maxAttempts, 5);
      assert.equal(json.backoffMs, 2000);
    });

    it('isRetryError type guard works', () => {
      const err = new RetryError('test', { attempt: 1, maxAttempts: 3, backoffMs: 100 });
      assert.ok(RetryError.isRetryError(err));
      assert.ok(!RetryError.isRetryError(new RuntimeError('x', { code: 'X' })));
    });
  });

  describe('RetryExhaustedError', () => {
    it('retryable=false (terminal)', () => {
      const err = new RetryExhaustedError('All retries failed', {
        maxAttempts: 3,
        backoffMs: 1000,
      });

      assert.equal(err.retryable, false);
      assert.equal(err.attempt, 3);
      assert.equal(err.maxAttempts, 3);
      assert.equal(err.name, 'RetryExhaustedError');
    });

    it('toJSON includes exhausted: true and lastError metadata', () => {
      const lastError = new ModelError('last provider failure', {
        provider: 'openai',
        statusCode: 503,
      })
      const err = new RetryExhaustedError('Done', {
        maxAttempts: 3,
        backoffMs: 1000,
        lastError,
      })

      const json = err.toJSON()
      assert.equal(json.exhausted, true)
      assert.equal(json.retryable, false)
      assert.equal(json.lastError?.message, 'last provider failure')
    })

    it('isRetryExhaustedError type guard works', () => {
      const err = new RetryExhaustedError('test', { maxAttempts: 3, backoffMs: 100 });
      assert.ok(RetryExhaustedError.isRetryExhaustedError(err));
      assert.ok(!RetryExhaustedError.isRetryExhaustedError(new RetryError('x', { attempt: 1, maxAttempts: 3, backoffMs: 100 })));
    });
  });

  describe('isRetryable classification matrix', () => {
    it('RuntimeError with retryable=true => true', () => {
      const err = new RuntimeError('retry me', { code: 'RETRY', retryable: true });
      assert.equal(isRetryable(err), true);
    });

    it('RuntimeError with retryable=false => false', () => {
      const err = new RuntimeError('no retry', { code: 'NO_RETRY', retryable: false });
      assert.equal(isRetryable(err), false);
    });

    it('ModelError rate-limit (429) => true', () => {
      const err = new ModelError('rate limited', { provider: 'test', statusCode: 429 });
      assert.equal(isRetryable(err), true);
    });

    it('ModelError 5xx => true', () => {
      const err = new ModelError('server error', { provider: 'test', statusCode: 500 });
      assert.equal(isRetryable(err), true);
    });

    it('ModelError 4xx (non-429) => false', () => {
      const err = new ModelError('bad request', { provider: 'test', statusCode: 400 });
      assert.equal(isRetryable(err), false);
    });

    it('ModelError with rateLimitReset => true', () => {
      const err = new ModelError('rate limited', { provider: 'test', rateLimitReset: Date.now() + 1000 });
      assert.equal(isRetryable(err), true);
    });

    it('ToolError => false (never retryable by default)', () => {
      const err = new ToolError('tool failed', { toolName: 'test' });
      assert.equal(isRetryable(err), false);
    });

    it('RetryError => true', () => {
      const err = new RetryError('retry', { attempt: 1, maxAttempts: 3, backoffMs: 100 });
      assert.equal(isRetryable(err), true);
    });

    it('RetryExhaustedError => false (terminal)', () => {
      const err = new RetryExhaustedError('exhausted', { maxAttempts: 3, backoffMs: 100 });
      assert.equal(isRetryable(err), false);
    });

    it('plain Error => false', () => {
      assert.equal(isRetryable(new Error('plain')), false);
    });

    it('null/undefined => false', () => {
      assert.equal(isRetryable(null), false);
      assert.equal(isRetryable(undefined), false);
    });

    it('random object => false', () => {
      assert.equal(isRetryable({ message: 'oops' }), false);
    });
  });
});

// ===========================================================================
// AEX-P1-003 / 084 / 085 — 统一错误分类（Error Taxonomy）
//
// 规范：AetherError → ModelError / ToolError / ExecutionError / WorkflowError
//       / SyncError；每个错误暴露 code / retryable / category / cause /
//       message / metadata；控制流一律用 code，禁止 message.includes。
// ===========================================================================

describe('core/errors taxonomy — AetherError 单一根', () => {
  it('ERROR_CATEGORIES 覆盖规范要求的 5 个分类', () => {
    for (const required of ['model', 'tool', 'execution', 'workflow', 'sync'] as const) {
      assert.ok(ERROR_CATEGORIES.includes(required), `missing category: ${required}`);
    }
  });

  it('所有分类错误都是 AetherError 实例（instanceof 链完整）', () => {
    const every: AetherErrorType[] = [
      new RuntimeError('r', { code: 'R' }),
      new ModelError('m', modelOpts),
      new ModelTransientError('mt', modelOpts),
      new ModelPermanentError('mp', modelOpts),
      new ModelTimeoutError('mto', modelOpts),
      new ModelStreamError('ms', modelOpts),
      new ToolError('t', toolOpts),
      new ToolTransientError('tt', toolOpts),
      new ToolPermanentError('tp', toolOpts),
      new ToolTimeoutError('tto', toolOpts),
      new ToolCancelledError('tc', toolOpts),
      new ExecutionError('e', {}),
      new VerificationError('v', {}),
      new BudgetExceededError('b', {}),
      new AttemptFailedError('a', {}),
      new WorkflowError('w', {}),
      new SyncError('s', {}),
      new RetryError('r', { attempt: 1, maxAttempts: 3, backoffMs: 1 }),
      new RetryExhaustedError('re', { maxAttempts: 3 }),
      new ProviderCredentialError('openai'),
    ];

    for (const err of every) {
      assert.ok(err instanceof AetherError, `${err.name} is not an AetherError`);
      assert.ok(err instanceof Error);
      assert.equal(typeof err.code, 'string');
      assert.equal(typeof err.category, 'string');
      assert.equal(typeof err.retryable, 'boolean');
      assert.ok(err.message.length > 0);
    }
  });

  it('isAetherError 拒绝非 Aether 错误', () => {
    assert.ok(AetherError.isAetherError(new ModelError('m', modelOpts)));
    assert.equal(AetherError.isAetherError(new Error('plain')), false);
    assert.equal(AetherError.isAetherError(null), false);
    assert.equal(AetherError.isAetherError({ code: 'X' }), false);
  });

  it('子类保留既有 instanceof 格（向后兼容：ModelError/ToolError 仍是 RuntimeError）', () => {
    assert.ok(new ModelError('m', modelOpts) instanceof RuntimeError);
    assert.ok(new ModelStreamError('ms', modelOpts) instanceof ModelError);
    assert.ok(new ToolError('t', toolOpts) instanceof RuntimeError);
    assert.ok(new ToolTimeoutError('tto', toolOpts) instanceof ToolError);
    assert.ok(new VerificationError('v', {}) instanceof ExecutionError);
    assert.ok(new VerificationError('v', {}) instanceof RuntimeError);
    assert.ok(RuntimeError.isRuntimeError(new ModelError('m', modelOpts)));
  });

  it('name 反映具体子类，便于日志与前端展示', () => {
    assert.equal(new ModelStreamError('ms', modelOpts).name, 'ModelStreamError');
    assert.equal(new ToolTimeoutError('t', toolOpts).name, 'ToolTimeoutError');
    assert.equal(new BudgetExceededError('b', {}).name, 'BudgetExceededError');
    assert.equal(new WorkflowError('w', {}).name, 'WorkflowError');
    assert.equal(new SyncError('s', {}).name, 'SyncError');
  });
});

describe('core/errors taxonomy — category 矩阵', () => {
  const cases: ReadonlyArray<readonly [string, AetherErrorType, string]> = [
    ['ModelError', new ModelError('m', modelOpts), 'model'],
    ['ModelTransientError', new ModelTransientError('m', modelOpts), 'model'],
    ['ModelPermanentError', new ModelPermanentError('m', modelOpts), 'model'],
    ['ModelTimeoutError', new ModelTimeoutError('m', modelOpts), 'model'],
    ['ModelStreamError', new ModelStreamError('m', modelOpts), 'model'],
    ['ToolError', new ToolError('t', toolOpts), 'tool'],
    ['ToolTransientError', new ToolTransientError('t', toolOpts), 'tool'],
    ['ToolPermanentError', new ToolPermanentError('t', toolOpts), 'tool'],
    ['ToolTimeoutError', new ToolTimeoutError('t', toolOpts), 'tool'],
    ['ToolCancelledError', new ToolCancelledError('t', toolOpts), 'tool'],
    ['ExecutionError', new ExecutionError('e', {}), 'execution'],
    ['VerificationError', new VerificationError('v', {}), 'execution'],
    ['BudgetExceededError', new BudgetExceededError('b', {}), 'execution'],
    ['AttemptFailedError', new AttemptFailedError('a', {}), 'execution'],
    ['RetryError', new RetryError('r', { attempt: 1, maxAttempts: 2, backoffMs: 1 }), 'execution'],
    ['RetryExhaustedError', new RetryExhaustedError('r', { maxAttempts: 2 }), 'execution'],
    ['WorkflowError', new WorkflowError('w', {}), 'workflow'],
    ['SyncError', new SyncError('s', {}), 'sync'],
    ['ProviderCredentialError', new ProviderCredentialError('openai'), 'model'],
  ];

  for (const [label, err, expected] of cases) {
    it(`${label} => category='${expected}'`, () => {
      assert.equal(err.category, expected);
      assert.ok(ERROR_CATEGORIES.includes(err.category));
    });
  }

  it('裸 RuntimeError 落在 legacy "runtime" 桶（既有 thrower 未分类，不伪报分类）', () => {
    assert.equal(new RuntimeError('legacy', { code: 'L' }).category, 'runtime');
  });

  it('RuntimeError 显式传 category 时采用传入值', () => {
    const err = new RuntimeError('typed', { code: 'L', category: 'workflow' });
    assert.equal(err.category, 'workflow');
  });
});

describe('core/errors taxonomy — code + retryable 默认值矩阵', () => {
  const cases: ReadonlyArray<readonly [string, AetherErrorType, string, boolean]> = [
    ['ModelTransientError', new ModelTransientError('m', modelOpts), 'MODEL_TRANSIENT', true],
    ['ModelPermanentError', new ModelPermanentError('m', modelOpts), 'MODEL_PERMANENT', false],
    ['ModelTimeoutError', new ModelTimeoutError('m', modelOpts), 'MODEL_TIMEOUT', true],
    // wire code 保持 STREAM_CLOSED：retry-policy.defaultRetryable / execution-retry 按该字面量分类
    ['ModelStreamError', new ModelStreamError('m', modelOpts), 'STREAM_CLOSED', true],
    ['ToolTransientError', new ToolTransientError('t', toolOpts), 'TOOL_TRANSIENT', true],
    ['ToolPermanentError', new ToolPermanentError('t', toolOpts), 'TOOL_PERMANENT', false],
    ['ToolTimeoutError', new ToolTimeoutError('t', toolOpts), 'TOOL_TIMEOUT', true],
    ['ToolCancelledError', new ToolCancelledError('t', toolOpts), 'TOOL_CANCELLED', false],
    ['ExecutionError', new ExecutionError('e', {}), 'EXECUTION_ERROR', false],
    // verdict='failed' = 判定为不通过 → 重跑同一次尝试没有意义 → 不可重试
    ['VerificationError(failed)', new VerificationError('v', {}), 'VERIFICATION_FAILED', false],
    // verdict='indeterminate' = 验证本身没跑完（外部依赖抖动）→ 可重试
    ['VerificationError(indeterminate)', new VerificationError('v', { verdict: 'indeterminate' }), 'VERIFICATION_FAILED', true],
    ['BudgetExceededError', new BudgetExceededError('b', {}), 'BUDGET_EXCEEDED', false],
    ['AttemptFailedError', new AttemptFailedError('a', {}), 'ATTEMPT_FAILED', true],
    ['WorkflowError', new WorkflowError('w', {}), 'WORKFLOW_ERROR', false],
    ['SyncError', new SyncError('s', {}), 'SYNC_ERROR', false],
  ];

  for (const [label, err, code, retryable] of cases) {
    it(`${label} => code='${code}' retryable=${retryable}`, () => {
      assert.equal(err.code, code);
      assert.equal(err.retryable, retryable);
    });
  }

  it('显式 retryable 覆盖子类默认值（双向）', () => {
    assert.equal(new ModelPermanentError('m', { ...modelOpts, retryable: true }).retryable, true);
    assert.equal(new ModelStreamError('m', { ...modelOpts, retryable: false }).retryable, false);
    assert.equal(new ToolTimeoutError('t', { ...toolOpts, retryable: false }).retryable, false);
  });

  it('显式 code 覆盖子类默认 code（供按 code 分流）', () => {
    const err = new ModelTimeoutError('m', { ...modelOpts, code: 'PROVIDER_SLOW' });
    assert.equal(err.code, 'PROVIDER_SLOW');
  });

  it('ModelError 保留既有 statusCode 推导：4xx 不可重试 / 429·5xx 可重试', () => {
    assert.equal(new ModelError('m', { ...modelOpts, statusCode: 400 }).retryable, false);
    assert.equal(new ModelError('m', { ...modelOpts, statusCode: 429 }).retryable, true);
    assert.equal(new ModelError('m', { ...modelOpts, statusCode: 503 }).retryable, true);
  });
});

describe('core/errors taxonomy — metadata / toJSON', () => {
  it('toJSON 含 code/message/category/metadata/retryable', () => {
    const err = new ModelTimeoutError('provider timed out', {
      ...modelOpts,
      metadata: { timeoutMs: 30_000, attempt: 2 },
    });

    const json = err.toJSON();
    assert.equal(json.code, 'MODEL_TIMEOUT');
    assert.equal(json.message, 'provider timed out');
    assert.equal(json.category, 'model');
    assert.equal(json.retryable, true);
    assert.deepEqual(json.metadata, { timeoutMs: 30_000, attempt: 2 });
    assert.equal(json.name, 'ModelTimeoutError');
  });

  it('metadata 与 legacy context 是同一份存储（单一事实源）', () => {
    const viaMetadata = new ToolError('t', { ...toolOpts, metadata: { a: 1 } });
    const viaContext = new ToolError('t', { ...toolOpts, context: { a: 1 } });
    assert.equal(viaMetadata.metadata, viaMetadata.context);
    assert.equal(viaContext.metadata, viaContext.context);
    assert.deepEqual(viaMetadata.toJSON().context, viaMetadata.toJSON().metadata);
  });

  it('同时传 metadata 与 context 时合并，metadata 覆盖同名键', () => {
    const err = new SyncError('s', { context: { a: 1, b: 2 }, metadata: { b: 3, c: 4 } });
    assert.deepEqual(err.metadata, { a: 1, b: 3, c: 4 });
  });

  it('两者都不传时 metadata/context 均为 undefined（不产生空对象噪声）', () => {
    const err = new ToolError('t', toolOpts);
    assert.equal(err.metadata, undefined);
    assert.equal(err.context, undefined);
    assert.equal(err.toJSON().metadata, undefined);
  });

  it('cause 在 toJSON 中被字符串化（避免循环引用）', () => {
    const err = new AttemptFailedError('a', { cause: new Error('root'), metadata: { attempt: 1 } });
    assert.equal(err.toJSON().cause, 'root');
    assert.equal(err.cause instanceof Error, true);
  });

  it('所有子类 toJSON 输出可 JSON.stringify（无循环引用）', () => {
    const all: AetherErrorType[] = [
      new ModelStreamError('ms', modelOpts),
      new ToolCancelledError('tc', { ...toolOpts, input: { script: 'print(1)' } }),
      new BudgetExceededError('b', { metadata: { spentUsd: 12.5, limitUsd: 10 } }),
      new WorkflowError('w', { metadata: { nodeId: 'n1' } }),
      new SyncError('s', {}),
    ];
    for (const err of all) {
      const round = JSON.parse(JSON.stringify(err.toJSON())) as Record<string, unknown>;
      assert.equal(round.category, err.category);
      assert.equal(round.code, err.code);
    }
  });
});

describe('core/errors taxonomy — ErrorCode 常量表（P1-085 控制流入口）', () => {
  it('每个子类默认 code 都能在 ErrorCode 表里查到', () => {
    const codes: ReadonlyArray<readonly [AetherErrorType, string]> = [
      [new ModelTransientError('m', modelOpts), ErrorCode.MODEL_TRANSIENT],
      [new ModelPermanentError('m', modelOpts), ErrorCode.MODEL_PERMANENT],
      [new ModelTimeoutError('m', modelOpts), ErrorCode.MODEL_TIMEOUT],
      [new ModelStreamError('m', modelOpts), ErrorCode.MODEL_STREAM_CLOSED],
      [new ToolTransientError('t', toolOpts), ErrorCode.TOOL_TRANSIENT],
      [new ToolPermanentError('t', toolOpts), ErrorCode.TOOL_PERMANENT],
      [new ToolTimeoutError('t', toolOpts), ErrorCode.TOOL_TIMEOUT],
      [new ToolCancelledError('t', toolOpts), ErrorCode.TOOL_CANCELLED],
      [new ExecutionError('e', {}), ErrorCode.EXECUTION_ERROR],
      [new VerificationError('v', {}), ErrorCode.VERIFICATION_FAILED],
      [new BudgetExceededError('b', {}), ErrorCode.BUDGET_EXCEEDED],
      [new AttemptFailedError('a', {}), ErrorCode.ATTEMPT_FAILED],
      [new WorkflowError('w', {}), ErrorCode.WORKFLOW_ERROR],
      [new SyncError('s', {}), ErrorCode.SYNC_ERROR],
    ];
    for (const [err, code] of codes) {
      assert.equal(err.code, code);
    }
  });

  it('MODEL_STREAM_CLOSED 的 wire 值沿用既有 STREAM_CLOSED 字面量', () => {
    assert.equal(ErrorCode.MODEL_STREAM_CLOSED, 'STREAM_CLOSED');
  });

  it('既有硬编码字面量已被常量表收录（不改变任何 wire 值）', () => {
    assert.equal(ErrorCode.RATE_LIMIT, 'RATE_LIMIT');
    assert.equal(ErrorCode.PROVIDER_UNAVAILABLE, 'PROVIDER_UNAVAILABLE');
    assert.equal(ErrorCode.NETWORK_ERROR, 'NETWORK_ERROR');
    assert.equal(ErrorCode.CIRCUIT_OPEN, 'CIRCUIT_OPEN');
    assert.equal(ErrorCode.AUTH, 'AUTH');
    assert.equal(ErrorCode.CONTEXT_WINDOW, 'CONTEXT_WINDOW');
    assert.equal(ErrorCode.TOOL_NOT_FOUND, 'TOOL_NOT_FOUND');
    assert.equal(ErrorCode.TOOL_DENIED, 'TOOL_DENIED');
    assert.equal(ErrorCode.TOOL_EXISTS, 'TOOL_EXISTS');
    assert.equal(ErrorCode.INVALID_INPUT, 'INVALID_INPUT');
    assert.equal(ErrorCode.RETRY_EXHAUSTED, 'RETRY_EXHAUSTED');
    assert.equal(ErrorCode.PROVIDER_CREDENTIAL_ERROR, 'PROVIDER_CREDENTIAL_ERROR');
    assert.equal(ErrorCode.MODEL_ERROR, 'MODEL_ERROR');
    assert.equal(ErrorCode.TOOL_ERROR, 'TOOL_ERROR');
  });

  it('按 code 分流（替代 message.includes）可用于控制流', () => {
    const err = new ModelTimeoutError('request timeout after 30000ms', modelOpts);
    assert.equal(err.code === ErrorCode.MODEL_TIMEOUT, true);
    assert.equal(err.code === ErrorCode.TOOL_TIMEOUT, false);
  });
});

describe('core/errors taxonomy — isRetryable 覆盖新子类', () => {
  it('可重试子类 => true', () => {
    assert.equal(isRetryable(new ModelStreamError('m', modelOpts)), true);
    assert.equal(isRetryable(new ModelTransientError('m', modelOpts)), true);
    assert.equal(isRetryable(new ModelTimeoutError('m', modelOpts)), true);
    assert.equal(isRetryable(new ToolTransientError('t', toolOpts)), true);
    assert.equal(isRetryable(new ToolTimeoutError('t', toolOpts)), true);
    assert.equal(isRetryable(new AttemptFailedError('a', {})), true);
    assert.equal(isRetryable(new VerificationError('v', { verdict: 'indeterminate' })), true);
  });

  it('不可重试子类 => false', () => {
    assert.equal(isRetryable(new ModelPermanentError('m', modelOpts)), false);
    assert.equal(isRetryable(new ToolPermanentError('t', toolOpts)), false);
    assert.equal(isRetryable(new ToolCancelledError('t', toolOpts)), false);
    assert.equal(isRetryable(new BudgetExceededError('b', {})), false);
    assert.equal(isRetryable(new VerificationError('v', {})), false);
    assert.equal(isRetryable(new WorkflowError('w', {})), false);
    assert.equal(isRetryable(new SyncError('s', {})), false);
  });

  it('RetryExhaustedError 仍是终态（不可重试）', () => {
    assert.equal(isRetryable(new RetryExhaustedError('r', { maxAttempts: 3 })), false);
  });
});

describe('core/errors taxonomy — 向后兼容', () => {
  it('既有 RuntimeError 两参数构造方式不变', () => {
    const err = new RuntimeError('Something went wrong', {
      code: 'TEST_ERROR',
      cause: new Error('root cause'),
      context: { key: 'value', count: 42 },
      retryable: true,
    });
    assert.equal(err.code, 'TEST_ERROR');
    assert.equal(err.retryable, true);
    assert.equal(err.category, 'runtime');
    assert.deepEqual(err.context, { key: 'value', count: 42 });
    assert.equal(err.cause instanceof Error, true);
  });

  it('既有 ModelError 构造与 rateLimit 推导不变', () => {
    const err = new ModelError('Rate limited', {
      provider: 'openai',
      model: 'gpt-4',
      statusCode: 429,
      rateLimitReset: 1234567890,
    });
    assert.equal(err.code, 'MODEL_ERROR');
    assert.equal(err.retryable, true);
    assert.equal(err.category, 'model');
    assert.equal(err.rateLimitReset, 1234567890);
    assert.equal(err.toJSON().provider, 'openai');
  });

  it('既有 ToolError 构造与字段不变', () => {
    const err = new ToolError('Script failed', {
      toolName: 'python-runner',
      input: { script: 'print(1/0)' },
      exitCode: 1,
    });
    assert.equal(err.code, 'TOOL_ERROR');
    assert.equal(err.retryable, false);
    assert.equal(err.category, 'tool');
    assert.equal(err.exitCode, 1);
  });

  it('既有 RetryError / RetryExhaustedError 构造不变', () => {
    const retry = new RetryError('Transient', { attempt: 1, maxAttempts: 3, backoffMs: 1000 });
    assert.equal(retry.code, 'RETRY_ERROR');
    assert.equal(retry.retryable, true);
    assert.equal(retry.attempt, 1);

    const exhausted = new RetryExhaustedError('Done', { maxAttempts: 3, backoffMs: 1000 });
    assert.equal(exhausted.retryable, false);
    assert.equal(exhausted.attempt, 3);
  });

  it('既有 ProviderCredentialError 构造不变', () => {
    const err = new ProviderCredentialError('openai', new Error('bad key'));
    assert.equal(err.code, 'PROVIDER_CREDENTIAL_ERROR');
    assert.equal(err.retryable, false);
    assert.equal(err.category, 'model');
    assert.ok(err.message.includes('openai'));
  });

  it('既有 RetryError category 可被显式覆盖（provider 层用 model）', () => {
    const err = new RetryError('r', {
      attempt: 1,
      maxAttempts: 2,
      backoffMs: 1,
      category: 'model',
    });
    assert.equal(err.category, 'model');
  });
});
