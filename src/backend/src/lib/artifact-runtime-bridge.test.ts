/**
 * ArtifactRuntimeBridge tests (Phase 8 — generated files → core ArtifactStore)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerFileArtifact,
  sha256,
  registerExistingFiles,
  buildArtifactRuntimeWithFiles,
} from './artifact-runtime-bridge.js';
import { InMemoryArtifactStore, ArtifactRuntime } from '../core/artifacts/index.js';

let dir: string;
let samplePath: string;
let secondPath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pacc-art-bridge-'));
  samplePath = join(dir, 'report.docx');
  writeFileSync(samplePath, 'sample artifact content');
  secondPath = join(dir, 'image.png');
  writeFileSync(secondPath, 'fake png bytes');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('lib/artifact-runtime-bridge', () => {
  it('sha256 computes a hex digest of a file', () => {
    const hash = sha256(samplePath);
    assert.equal(typeof hash, 'string');
    assert.match(hash, /^[0-9a-f]{64}$/, 'sha256 is 64 hex chars');
  });

  it('registerFileArtifact stores a record with size and hash computed from disk', async () => {
    const store = new InMemoryArtifactStore();
    const record = await registerFileArtifact(store, {
      name: 'report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      path: samplePath,
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'agent-1',
    });

    assert.equal(record.name, 'report.docx');
    assert.equal(record.runId, 'run-1');
    assert.equal(record.taskId, 'task-1');
    assert.equal(record.agentId, 'agent-1');
    assert.equal(record.size, 'sample artifact content'.length);
    assert.equal(record.hash, sha256(samplePath));
    assert.ok(record.id, 'id auto-generated');
    assert.ok(record.createdAt > 0, 'createdAt populated');
  });

  it('registerFileArtifact respects an explicit size override', async () => {
    const store = new InMemoryArtifactStore();
    const record = await registerFileArtifact(store, {
      name: 'x.bin',
      mimeType: 'application/octet-stream',
      path: samplePath,
      size: 999,
    });
    assert.equal(record.size, 999);
  });

  it('registerExistingFiles registers on-disk files and skips missing ones', async () => {
    const store = new InMemoryArtifactStore();
    const count = await registerExistingFiles(store, [
      { name: 'report.docx', mimeType: 'docx', path: samplePath, runId: 'r' },
      { name: 'image.png', mimeType: 'png', path: secondPath, runId: 'r' },
      { name: 'missing.pdf', mimeType: 'pdf', path: join(dir, 'missing.pdf'), runId: 'r' },
    ]);

    assert.equal(count, 2, 'missing file is skipped');
    const list = await store.list({ runId: 'r' });
    assert.equal(list.length, 2);
  });

  it('store.list filters by runId and agentId', async () => {
    const store = new InMemoryArtifactStore();
    await registerFileArtifact(store, { name: 'a.txt', mimeType: 'text/plain', path: samplePath, runId: 'run-a', agentId: 'agent-x' });
    await registerFileArtifact(store, { name: 'b.txt', mimeType: 'text/plain', path: secondPath, runId: 'run-b', agentId: 'agent-y' });

    const runA = await store.list({ runId: 'run-a' });
    assert.equal(runA.length, 1);
    assert.equal(runA[0].name, 'a.txt');

    const agentY = await store.list({ agentId: 'agent-y' });
    assert.equal(agentY.length, 1);
    assert.equal(agentY[0].name, 'b.txt');
  });

  it('buildArtifactRuntimeWithFiles wires an ArtifactRuntime over the registered files', async () => {
    const { runtime, store, count } = await buildArtifactRuntimeWithFiles([
      { name: 'report.docx', mimeType: 'docx', path: samplePath },
      { name: 'image.png', mimeType: 'png', path: secondPath },
    ]);

    assert.ok(runtime instanceof ArtifactRuntime);
    assert.equal(count, 2);
    assert.equal((await store.list()).length, 2);
  });
});