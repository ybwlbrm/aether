/**
 * Shared conversation cascade-deletion helper.
 *
 * P0-21 fix: deleting a conversation must remove every FK-dependent row first,
 * otherwise sql.js raises "FOREIGN KEY constraint failed".
 *
 * FK dependency chain (see db/schema/index.ts and db/migrate.ts):
 *   conversations <- messages (conversationId)
 *   conversations <- activity_events (conversationId)
 *   conversations <- runs (conversationId, nullable)
 *   runs <- tasks (runId)
 *   runs <- events (runId)
 *
 * workflow_runs only references workflows (no conversation_id column) and
 * artifacts live in an in-memory store (no DB table), so neither is affected.
 */
import { eq, inArray } from 'drizzle-orm';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import * as schema from '../../db/schema/index.js';

type Db = SQLJsDatabase<typeof schema>;

/** Delete a conversation and all rows that reference it, children first. */
export function deleteConversationCascade(db: Db, conversationId: string): void {
  // 1. Collect every run belonging to this conversation first.
  const convRuns = db.select({ id: schema.runs.id }).from(schema.runs)
    .where(eq(schema.runs.conversationId, conversationId)).all();
  const runIds = convRuns.map((r) => r.id);

  if (runIds.length > 0) {
    // 2. Delete tasks and events owned by those runs (children of runs).
    db.delete(schema.tasks).where(inArray(schema.tasks.runId, runIds)).run();
    db.delete(schema.events).where(inArray(schema.events.runId, runIds)).run();
    // 3. Delete the runs themselves (children of conversations).
    db.delete(schema.runs).where(inArray(schema.runs.id, runIds)).run();
  }

  // 4. Delete activity_events (children of conversations).
  db.delete(schema.activityEvents).where(eq(schema.activityEvents.conversationId, conversationId)).run();
  // 5. Delete messages (children of conversations).
  db.delete(schema.messages).where(eq(schema.messages.conversationId, conversationId)).run();
  // 6. Finally delete the conversation itself.
  db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId)).run();
}
