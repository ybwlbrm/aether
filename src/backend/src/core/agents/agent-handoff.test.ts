/**
 * HandoffProtocol tests (P1-25)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HandoffProtocol } from './agent-handoff.js';
import { RuntimeError } from '../errors/index.js';

describe('agent-handoff', () => {
  it('request creates a requested record with id and createdAt', () => {
    const protocol = new HandoffProtocol();
    protocol.request({ fromAgentId: 'a1', toAgentId: 'a2', reason: 'needs expert' });

    const records = protocol.list();
    assert.equal(records.length, 1);
    assert.ok(records[0].id.length > 0);
    assert.equal(records[0].status, 'requested');
    assert.equal(records[0].fromAgentId, 'a1');
    assert.equal(records[0].toAgentId, 'a2');
    assert.ok(!Number.isNaN(Date.parse(records[0].createdAt)));
  });

  it('accept sets acceptedAt and status accepted', () => {
    const protocol = new HandoffProtocol();
    protocol.request({ fromAgentId: 'a1', toAgentId: 'a2', reason: 'handoff' });
    const id = protocol.list()[0].id;

    const accepted = protocol.accept(id);
    assert.equal(accepted.status, 'accepted');
    assert.ok(accepted.acceptedAt !== undefined);
    assert.ok(!Number.isNaN(Date.parse(accepted.acceptedAt!)));
  });

  it('accept unknown id throws HANDOFF_NOT_FOUND', () => {
    const protocol = new HandoffProtocol();
    assert.throws(
      () => protocol.accept('missing-id'),
      (err: unknown) => err instanceof RuntimeError && err.code === 'HANDOFF_NOT_FOUND',
    );
  });

  it('reject sets rejected status and rejectReason', () => {
    const protocol = new HandoffProtocol();
    protocol.request({ fromAgentId: 'a1', toAgentId: 'a2', reason: 'handoff' });
    const id = protocol.list()[0].id;

    protocol.reject(id, 'not now');
    const records = protocol.list();
    assert.equal(records[0].status, 'rejected');
    assert.equal(records[0].rejectReason, 'not now');
  });

  it('reject unknown id throws HANDOFF_NOT_FOUND', () => {
    const protocol = new HandoffProtocol();
    assert.throws(
      () => protocol.reject('missing-id'),
      (err: unknown) => err instanceof RuntimeError && err.code === 'HANDOFF_NOT_FOUND',
    );
  });

  it('list returns records in creation order', () => {
    const protocol = new HandoffProtocol();
    protocol.request({ fromAgentId: 'a1', toAgentId: 'a2', reason: 'first' });
    protocol.request({ fromAgentId: 'a3', toAgentId: 'a4', reason: 'second' });

    const records = protocol.list();
    assert.equal(records.length, 2);
    assert.equal(records[0].reason, 'first');
    assert.equal(records[1].reason, 'second');
  });

  it('list returns copies (mutating result does not affect protocol)', () => {
    const protocol = new HandoffProtocol();
    protocol.request({ fromAgentId: 'a1', toAgentId: 'a2', reason: 'x' });
    const copy = protocol.list();
    copy[0].status = 'accepted';
    assert.equal(protocol.list()[0].status, 'requested');
  });
});