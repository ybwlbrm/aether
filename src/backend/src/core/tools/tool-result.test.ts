/**
 * ToolResult unit tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolResult,
  ToolSuccessResult,
  ToolErrorResult,
  ToolPendingApprovalResult,
  ToolTimeoutResult,
  ToolCancelledResult,
  successResult,
  errorResult,
  pendingApprovalResult,
  timeoutResult,
  cancelledResult,
  isSuccessResult,
  isErrorResult,
  isPendingApprovalResult,
  isTimeoutResult,
  isCancelledResult,
} from './tool-result.js';

describe('tool-result', () => {
  describe('successResult', () => {
    test('creates a success result with correct structure', () => {
      const result = successResult('test-tool', { foo: 'bar' }, 100);

      assert.equal(result.kind, 'success');
      assert.equal(result.toolName, 'test-tool');
      assert.deepEqual(result.output, { foo: 'bar' });
      assert.equal(result.durationMs, 100);
    });

    test('type guard isSuccessResult returns true for success', () => {
      const result = successResult('test-tool', 'output', 50);
      assert.equal(isSuccessResult(result), true);
    });

    test('type guard isSuccessResult returns false for other kinds', () => {
      assert.equal(isSuccessResult(errorResult('t', { message: 'e' }, 1)), false);
      assert.equal(isSuccessResult(pendingApprovalResult('t', 'a', 1)), false);
      assert.equal(isSuccessResult(timeoutResult('t', 1)), false);
      assert.equal(isSuccessResult(cancelledResult('t', 1)), false);
    });
  });

  describe('errorResult', () => {
    test('creates an error result with message only', () => {
      const result = errorResult('test-tool', { message: 'Something went wrong' }, 200);

      assert.equal(result.kind, 'error');
      assert.equal(result.toolName, 'test-tool');
      assert.equal(result.error.message, 'Something went wrong');
      assert.equal(result.error.code, undefined);
      assert.equal(result.durationMs, 200);
    });

    test('creates an error result with message and code', () => {
      const result = errorResult('test-tool', { message: 'Failed', code: 'TOOL_ERROR' }, 200);

      assert.equal(result.error.code, 'TOOL_ERROR');
    });

    test('type guard isErrorResult returns true for error', () => {
      const result = errorResult('test-tool', { message: 'e' }, 1);
      assert.equal(isErrorResult(result), true);
    });
  });

  describe('pendingApprovalResult', () => {
    test('creates a pending approval result', () => {
      const result = pendingApprovalResult('test-tool', 'approval-123', 50);

      assert.equal(result.kind, 'pending-approval');
      assert.equal(result.toolName, 'test-tool');
      assert.equal(result.approvalId, 'approval-123');
      assert.equal(result.durationMs, 50);
    });

    test('type guard isPendingApprovalResult returns true for pending-approval', () => {
      const result = pendingApprovalResult('test-tool', 'a', 1);
      assert.equal(isPendingApprovalResult(result), true);
    });
  });

  describe('timeoutResult', () => {
    test('creates a timeout result', () => {
      const result = timeoutResult('test-tool', 5000);

      assert.equal(result.kind, 'timeout');
      assert.equal(result.toolName, 'test-tool');
      assert.equal(result.durationMs, 5000);
    });

    test('type guard isTimeoutResult returns true for timeout', () => {
      const result = timeoutResult('test-tool', 1);
      assert.equal(isTimeoutResult(result), true);
    });
  });

  describe('cancelledResult', () => {
    test('creates a cancelled result', () => {
      const result = cancelledResult('test-tool', 100);

      assert.equal(result.kind, 'cancelled');
      assert.equal(result.toolName, 'test-tool');
      assert.equal(result.durationMs, 100);
    });

    test('type guard isCancelledResult returns true for cancelled', () => {
      const result = cancelledResult('test-tool', 1);
      assert.equal(isCancelledResult(result), true);
    });
  });

  describe('discriminated union narrowing', () => {
    test('kind field narrows type correctly', () => {
      const results: ToolResult[] = [
        successResult('t', 'o', 1),
        errorResult('t', { message: 'e' }, 1),
        pendingApprovalResult('t', 'a', 1),
        timeoutResult('t', 1),
        cancelledResult('t', 1),
      ];

      for (const result of results) {
        switch (result.kind) {
          case 'success':
            assert.equal(result.output, 'o');
            break;
          case 'error':
            assert.equal(typeof result.error.message, 'string');
            break;
          case 'pending-approval':
            assert.equal(typeof result.approvalId, 'string');
            break;
          case 'timeout':
            assert.equal(typeof result.durationMs, 'number');
            break;
          case 'cancelled':
            assert.equal(typeof result.durationMs, 'number');
            break;
        }
      }
    });
  });
});