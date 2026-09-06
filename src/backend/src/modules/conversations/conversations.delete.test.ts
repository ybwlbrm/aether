/**
 * P0-21: Conversation cascade-delete integration test.
 *
 * Verifies that DELETE /api/conversations/:id removes every FK-dependent row
 * (messages / activity_events / runs / tasks / events) in the correct order,
 * so sql.js never raises "FOREIGN KEY constraint failed".
 *
 * Uses fastify app.inject() — no listening port required.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../db/migrate.js';
import { initDb, flushDbSync, getDb } from '../../db/client.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { registerConversationRoutes } from './index.js';
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js';
import { encrypt } from '../../lib/crypto.js';
import { providers, conversations, messages, runs, tasks, events, activityEvents } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import type { BackendConfig } from '../../config/index.js';

let app: FastifyInstance;
let cfg: BackendConfig;
let dir: string;

const PROVIDER_ID = 'del-test-provider';

function countRows(table: any, column: any, value: string): number {
  const db = getDb();
  return db.select().from(table).where(eq(column, value)).all().length;
}

/** 准备一条带完整关联链的 conversation：1 message + 1 run + 1 task + 1 event + 1 activity_event */
function seedConversationWithRelations(): { convId: string; runId: string } {
  const db = getDb();
  const now = new Date().toISOString();
  const convId = randomUUID();
  const runId = randomUUID();
  db.insert(conversations).values({
    id: convId, title: 'del-test', providerId: PROVIDER_ID, model: 'm',
    createdAt: now, updatedAt: now,
  }).run();
  db.insert(messages).values({
    id: randomUUID(), conversationId: convId, role: 'user', content: 'hi', createdAt: now,
  }).run();
  db.insert(runs).values({
    id: runId, conversationId: convId, status: 'completed', mode: 'normal', createdAt: now,
  }).run();
  db.insert(tasks).values({
    id: randomUUID(), runId, status: 'completed', agentId: 'main', createdAt: now,
  }).run();
  db.insert(events).values({
    id: randomUUID(), runId, seq: 1, eventType: 'agent.message', eventVersion: 1,
    payload: '{}', createdAt: now,
  }).run();
  db.insert(activityEvents).values({
    id: randomUUID(), conversationId: convId, taskId: runId, eventType: 'task.started',
    seq: 1, agentId: 'main', createdAt: now,
  }).run();
  return { convId, runId };
}

function deleteConversation(convId: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'DELETE', url: `/api/conversations/${convId}` });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pacc-del-itest-'));
  cfg = makeTestConfig(dir);
  await runMigrations(cfg);
  await initDb(cfg);
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerConversationRoutes(app, cfg);
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(providers).values({
    id: PROVIDER_ID, name: 'del-mock', type: 'openai',
    apiKey: encrypt('mock-key', cfg.encryptionKey),
    baseUrl: 'http://127.0.0.1:1/v1', models: JSON.stringify(['m']),
    capabilities: JSON.stringify(['text']), isDefault: false,
    createdAt: now, updatedAt: now,
  }).run();
});

after(async () => {
  flushDbSync(cfg);
  if (app) await app.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('DELETE /api/conversations/:id — P0-21 级联删除', () => {
  it('删除带 messages/runs/tasks/events/activity_events 的 conversation：返回 200 且全部关联行被删', async () => {
    const { convId, runId } = seedConversationWithRelations();

    const res = await deleteConversation(convId);
    assert.equal(res.statusCode, 200, `DELETE 应返回 200，实际 ${res.statusCode}: ${res.body}`);

    assert.equal(countRows(conversations, conversations.id, convId), 0, 'conversation 应被删除');
    assert.equal(countRows(messages, messages.conversationId, convId), 0, 'messages 应被删除');
    assert.equal(countRows(activityEvents, activityEvents.conversationId, convId), 0, 'activity_events 应被删除');
    assert.equal(countRows(runs, runs.conversationId, convId), 0, 'runs 应被删除');
    assert.equal(countRows(tasks, tasks.runId, runId), 0, 'tasks 应被删除');
    assert.equal(countRows(events, events.runId, runId), 0, 'events 应被删除');
  });

  it('删除无关联数据的 conversation 仍返回 200（幂等）', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const convId = randomUUID();
    db.insert(conversations).values({
      id: convId, title: 'bare', providerId: PROVIDER_ID, model: 'm',
      createdAt: now, updatedAt: now,
    }).run();

    const res = await deleteConversation(convId);
    assert.equal(res.statusCode, 200, `DELETE 应返回 200，实际 ${res.statusCode}: ${res.body}`);
    assert.equal(countRows(conversations, conversations.id, convId), 0, 'conversation 应被删除');
  });

  it('删除不存在的 conversation 返回 200（现有幂等行为不回归）', async () => {
    const res = await deleteConversation('no-such-conversation');
    assert.equal(res.statusCode, 200, `DELETE 应返回 200，实际 ${res.statusCode}: ${res.body}`);
  });
});
