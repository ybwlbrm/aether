/**
 * Lifecycle Tests
 *
 * Tests for the core/runtime lifecycle module (P1-04).
 * Run with: npm run test -w src/backend (after build)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// Import after build — tests run from dist/
const {
  LifecycleManager,
  withLifecycle,
} = await import('./index.js');
const { RuntimeError } = await import('../errors/index.js');
import type { LifecycleState, LifecycleHooks } from './lifecycle.js';

describe('core/runtime/lifecycle', () => {
  describe('LifecycleManager', () => {
    it('state transitions created->starting->running->stopping->stopped valid', async () => {
      const manager = new LifecycleManager();

      assert.equal(manager.state, 'created');

      await manager.transition('starting');
      assert.equal(manager.state, 'starting');

      await manager.transition('running');
      assert.equal(manager.state, 'running');
      assert.equal(manager.isRunning, true);

      await manager.transition('stopping');
      assert.equal(manager.state, 'stopping');

      await manager.transition('stopped');
      assert.equal(manager.state, 'stopped');
      assert.equal(manager.isTerminal, true);
    });

    it('starting->running->starting throws RuntimeError', async () => {
      const manager = new LifecycleManager();

      await manager.transition('starting');
      await manager.transition('running');

      await assert.rejects(
        manager.transition('starting'),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_LIFECYCLE_TRANSITION');
          return true;
        },
        'Expected RuntimeError on invalid transition running->starting'
      );
    });

    it('failed state set on onStart throw', async () => {
      const hooks: LifecycleHooks = {
        onStart: () => {
          throw new Error('Start hook failed');
        },
      };
      const manager = new LifecycleManager(hooks);

      await assert.rejects(manager.start(), /Start hook failed/);
      assert.equal(manager.state, 'failed');
      assert.equal(manager.isTerminal, true);
    });

    it('failed state set on onStop throw', async () => {
      const hooks: LifecycleHooks = {
        onStart: () => {},
        onStop: () => {
          throw new Error('Stop hook failed');
        },
      };
      const manager = new LifecycleManager(hooks);

      await manager.start();
      await assert.rejects(manager.stop(), /Stop hook failed/);
      assert.equal(manager.state, 'failed');
      assert.equal(manager.isTerminal, true);
    });

    it('onError hook called on fail()', async () => {
      const error = new Error('Test error');
      let onErrorCalled = false;
      let receivedError: unknown;

      const hooks: LifecycleHooks = {
        onError: (err) => {
          onErrorCalled = true;
          receivedError = err;
        },
      };
      const manager = new LifecycleManager(hooks);

      await manager.fail(error);

      assert.ok(onErrorCalled);
      assert.equal(receivedError, error);
      assert.equal(manager.state, 'failed');
    });

    it('start() calls onStart then transitions to running', async () => {
      const callOrder: string[] = [];
      const hooks: LifecycleHooks = {
        onStart: () => { callOrder.push('onStart'); },
      };
      const manager = new LifecycleManager(hooks);

      await manager.start();

      assert.deepEqual(callOrder, ['onStart']);
      assert.equal(manager.state, 'running');
    });

    it('stop() calls onStop then transitions to stopped', async () => {
      const callOrder: string[] = [];
      const hooks: LifecycleHooks = {
        onStart: () => { callOrder.push('onStart'); },
        onStop: () => { callOrder.push('onStop'); },
      };
      const manager = new LifecycleManager(hooks);

      await manager.start();
      await manager.stop();

      assert.deepEqual(callOrder, ['onStart', 'onStop']);
      assert.equal(manager.state, 'stopped');
    });

    it('reset() works from stopped state', async () => {
      const manager = new LifecycleManager();
      await manager.start();
      await manager.stop();

      manager.reset();
      assert.equal(manager.state, 'created');
    });

    it('reset() works from failed state', async () => {
      const manager = new LifecycleManager();
      await manager.fail(new Error('test'));

      manager.reset();
      assert.equal(manager.state, 'created');
    });

    it('reset() throws from non-terminal state', async () => {
      const manager = new LifecycleManager();
      await manager.start();

      assert.throws(
        () => manager.reset(),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'LIFECYCLE_CANNOT_RESET');
          return true;
        }
      );
    });

    it('transition to failed from any state works', async () => {
      const manager = new LifecycleManager();

      // From created
      await manager.fail(new Error('fail from created'));
      assert.equal(manager.state, 'failed');

      // Reset and try from running
      manager.reset();
      await manager.start();
      await manager.fail(new Error('fail from running'));
      assert.equal(manager.state, 'failed');
    });
  });

  describe('withLifecycle helper', () => {
    it('wraps target object with lifecycle methods', async () => {
      const target = { value: 42 };
      const wrapped = withLifecycle(target);

      assert.equal(wrapped.value, 42);
      assert.ok(wrapped.lifecycle instanceof LifecycleManager);
      assert.ok(typeof wrapped.start === 'function');
      assert.ok(typeof wrapped.stop === 'function');
    });

    it('withLifecycle invokes hooks', async () => {
      const callOrder: string[] = [];
      const hooks: LifecycleHooks = {
        onStart: () => { callOrder.push('onStart'); },
        onStop: () => { callOrder.push('onStop'); },
      };

      const wrapped = withLifecycle({ data: 'test' }, hooks);

      await wrapped.start();
      await wrapped.stop();

      assert.deepEqual(callOrder, ['onStart', 'onStop']);
      assert.equal(wrapped.lifecycle.state, 'stopped');
    });

    it('withLifecycle preserves target properties', () => {
      const target = {
        name: 'test',
        count: 10,
        nested: { value: true },
        method() {
          return 'original';
        },
      };

      const wrapped = withLifecycle(target);

      assert.equal(wrapped.name, 'test');
      assert.equal(wrapped.count, 10);
      assert.deepEqual(wrapped.nested, { value: true });
      assert.equal(wrapped.method(), 'original');
    });

    it('withLifecycle start/stop delegate to lifecycle manager', async () => {
      const wrapped = withLifecycle({});

      await wrapped.start();
      assert.equal(wrapped.lifecycle.state, 'running');

      await wrapped.stop();
      assert.equal(wrapped.lifecycle.state, 'stopped');
    });
  });

  describe('LifecycleState type', () => {
    it('includes all expected states', () => {
      const states: LifecycleState[] = [
        'created',
        'starting',
        'running',
        'stopping',
        'stopped',
        'failed',
      ];

      // This is a compile-time check - if it compiles, the type is correct
      assert.equal(states.length, 6);
    });
  });
});