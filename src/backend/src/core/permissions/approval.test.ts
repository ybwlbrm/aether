/**
 * ApprovalManager tests (P1-35) — coverage:
 * - request creates pending with id/createdAt
 * - autoApprove true → immediately approved
 * - decide approved sets status/decidedAt/decidedBy
 * - decide unknown id throws APPROVAL_NOT_FOUND
 * - double decide throws APPROVAL_ALREADY_DECIDED
 * - decide rejected works
 * - listPending returns only pending
 * - get returns request or undefined
 * - expireOld marks only stale pending requests expired and returns count
 * - countPending is accurate
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalManager, type ApprovalRequestInput, type ApprovalRequest } from './approval.js';
import { RuntimeError } from '../errors/index.js';

const HOUR_MS = 3_600_000;

function staleIso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function baseInput(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    capability: 'filesystem.read',
    reason: 'needs write access to project dir',
    ...overrides,
  };
}

describe('ApprovalManager', () => {
  it('request creates a pending request with id and createdAt', () => {
    const manager = new ApprovalManager();
    const request = manager.request(baseInput());

    assert.equal(request.status, 'pending');
    assert.equal(typeof request.id, 'string');
    assert.ok(request.id.length > 0, 'id should not be empty');
    assert.ok(!Number.isNaN(Date.parse(request.createdAt)), 'createdAt must be a parseable date');
    assert.equal(request.autoApprove, false);
    assert.equal(request.capability, 'filesystem.read');
    assert.equal(request.reason, 'needs write access to project dir');
  });

  it('autoApprove true immediately approves the request', () => {
    const manager = new ApprovalManager();
    const request = manager.request(baseInput({ autoApprove: true }));

    assert.equal(request.status, 'approved');
    assert.ok(request.decidedAt !== undefined, 'decidedAt should be set on approval');
    assert.equal(manager.countPending(), 0);
  });

  it('decide approved sets status/decidedAt/decidedBy', () => {
    const manager = new ApprovalManager();
    const request = manager.request(baseInput());

    const decided = manager.decide(request.id, { decision: 'approved', decidedBy: 'user-42' });
    assert.equal(decided.status, 'approved');
    assert.equal(decided.decidedBy, 'user-42');
    assert.ok(decided.decidedAt !== undefined, 'decidedAt should be set');
    assert.ok(!Number.isNaN(Date.parse(decided.decidedAt!)), 'decidedAt must be a parseable date');
  });

  it('decide on unknown id throws APPROVAL_NOT_FOUND', () => {
    const manager = new ApprovalManager();
    assert.throws(
      () => manager.decide('no-such-id', { decision: 'approved' }),
      (err: unknown) => err instanceof RuntimeError && err.code === 'APPROVAL_NOT_FOUND',
    );
  });

  it('double decide throws APPROVAL_ALREADY_DECIDED', () => {
    const manager = new ApprovalManager();
    const request = manager.request(baseInput());
    manager.decide(request.id, { decision: 'approved' });

    assert.throws(
      () => manager.decide(request.id, { decision: 'rejected' }),
      (err: unknown) => err instanceof RuntimeError && err.code === 'APPROVAL_ALREADY_DECIDED',
    );
  });

  it('decide rejected works and is terminal', () => {
    const manager = new ApprovalManager();
    const request = manager.request(baseInput());

    const decided = manager.decide(request.id, { decision: 'rejected', decidedBy: 'policy' });
    assert.equal(decided.status, 'rejected');
    assert.equal(decided.decidedBy, 'policy');

    assert.throws(
      () => manager.decide(request.id, { decision: 'approved' }),
      (err: unknown) => err instanceof RuntimeError && err.code === 'APPROVAL_ALREADY_DECIDED',
    );
  });

  it('listPending returns only pending requests', () => {
    const manager = new ApprovalManager();
    const pending = manager.request(baseInput());
    const autoApproved = manager.request(baseInput({ autoApprove: true }));
    const rejected = manager.request(baseInput({ capability: 'network.http' }));
    manager.decide(rejected.id, { decision: 'rejected' });

    const listed = manager.listPending();
    assert.equal(listed.length, 1);
    const only = listed[0];
    assert.ok(only !== undefined);
    assert.equal(only.id, pending.id);

    // returned copy is mutable-safe
    only.status = 'approved' as ApprovalRequest['status'];
    assert.equal(manager.listPending().length, 1, 'mutating returned list must not affect manager');

    // auto-approved never enters pending
    assert.equal(autoApproved.status, 'approved');
  });

  it('get returns the request or undefined', () => {
    const manager = new ApprovalManager();
    const request = manager.request(baseInput());

    const found = manager.get(request.id);
    assert.ok(found !== undefined);
    assert.equal(found.id, request.id);
    assert.equal(manager.get('missing-id'), undefined);
  });

  it('expireOld marks only stale pending requests expired and returns the count', () => {
    const manager = new ApprovalManager();
    const stalePending = manager.request(
      baseInput({ createdAt: staleIso(2 * HOUR_MS) }),
    );
    const freshPending = manager.request(baseInput());
    const staleRejected = manager.request(
      baseInput({ capability: 'network.http', createdAt: staleIso(2 * HOUR_MS) }),
    );
    manager.decide(staleRejected.id, { decision: 'rejected' });

    const expired = manager.expireOld(HOUR_MS);

    assert.equal(expired, 1, 'only the stale pending request expires');
    assert.equal(manager.get(stalePending.id)?.status, 'expired');
    assert.equal(manager.get(freshPending.id)?.status, 'pending', 'fresh request stays pending');
    assert.equal(
      manager.get(staleRejected.id)?.status,
      'rejected',
      'terminal requests are untouched even when stale',
    );
  });

  it('countPending is accurate across the lifecycle', () => {
    const manager = new ApprovalManager();
    assert.equal(manager.countPending(), 0);

    manager.request(baseInput({ createdAt: staleIso(2 * HOUR_MS) }));
    manager.request(baseInput({ capability: 'terminal.execute', createdAt: staleIso(2 * HOUR_MS) }));
    assert.equal(manager.countPending(), 2);

    const third = manager.request(baseInput());
    manager.decide(third.id, { decision: 'approved' });
    assert.equal(manager.countPending(), 2);

    manager.expireOld(HOUR_MS);
    assert.equal(manager.countPending(), 0, 'expireOld clears pending after staleness');
  });
});