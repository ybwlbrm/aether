/**
 * Runtime Tests
 *
 * Tests for the core/runtime module (P1-02).
 * Run with: npm run test -w src/backend (after build)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// Import after build — tests run from dist/
const { Runtime } = await import('./index.js');
const { RuntimeError } = await import('../errors/index.js');

// Concrete implementation for testing
class TestRuntime extends Runtime {
  startCalled = false;
  stopCalled = false;

  protected async onStart(): Promise<void> {
    this.startCalled = true;
  }

  protected async onStop(): Promise<void> {
    this.stopCalled = true;
  }
}

describe('core/runtime', () => {
  describe('Runtime', () => {
    it('start once ok', async () => {
      const runtime = new TestRuntime('test-runtime');
      assert.equal(runtime.state, 'created');
      assert.equal(runtime.isRunning, false);

      await runtime.start();

      assert.equal(runtime.state, 'running');
      assert.equal(runtime.isRunning, true);
      assert.equal(runtime.startCalled, true);
    });

    it('double start throws RuntimeError', async () => {
      const runtime = new TestRuntime('test-runtime');
      await runtime.start();

      await assert.rejects(
        runtime.start(),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'RUNTIME_ALREADY_STARTED');
          return true;
        },
        'Expected RuntimeError on double start'
      );
    });

    it('stop before start throws RuntimeError', async () => {
      const runtime = new TestRuntime('test-runtime');

      await assert.rejects(
        runtime.stop(),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'RUNTIME_NOT_RUNNING');
          return true;
        },
        'Expected RuntimeError on stop before start'
      );
    });

    it('onStart/onStop called in order', async () => {
      const runtime = new TestRuntime('test-runtime');
      const callOrder: string[] = [];

      class OrderedRuntime extends Runtime {
        protected async onStart(): Promise<void> {
          callOrder.push('onStart');
        }

        protected async onStop(): Promise<void> {
          callOrder.push('onStop');
        }
      }

      const orderedRuntime = new OrderedRuntime('ordered-runtime');
      await orderedRuntime.start();
      await orderedRuntime.stop();

      assert.deepEqual(callOrder, ['onStart', 'onStop']);
    });

    it('emit() delivered to registered onEvent listener', async () => {
      const runtime = new TestRuntime('test-runtime');
      const events: Array<{ type: string; payload?: unknown }> = [];

      const unsubscribe = runtime.onEvent((event) => {
        events.push({ type: event.type, payload: event.payload });
      });

      await runtime.start();
      // Emit a custom event via protected method - we need to test via subclass
      class EmittingRuntime extends Runtime {
        async emitTestEvent(): Promise<void> {
          this.emit({ type: 'custom:event', payload: { data: 'test' } });
        }

        protected async onStart(): Promise<void> {}
        protected async onStop(): Promise<void> {}
      }

      const emittingRuntime = new EmittingRuntime('emitting-runtime');
      const emittedEvents: Array<{ type: string; payload?: unknown }> = [];
      emittingRuntime.onEvent((event) => {
        emittedEvents.push({ type: event.type, payload: event.payload });
      });

      await emittingRuntime.start();
      await emittingRuntime.emitTestEvent();
      await emittingRuntime.stop();

      assert.ok(emittedEvents.some((e) => e.type === 'custom:event' && (e.payload as Record<string, unknown>)?.data === 'test'));
    });

    it('listener unregister works (return an unsubscribe fn from onEvent)', async () => {
      const runtime = new TestRuntime('test-runtime');
      const events: string[] = [];

      const unsubscribe = runtime.onEvent((event) => {
        events.push(event.type);
      });

      await runtime.start();
      await runtime.stop();

      // Unsubscribe and verify no more events
      unsubscribe();

      class EmittingRuntime2 extends Runtime {
        async emitTestEvent(): Promise<void> {
          this.emit({ type: 'custom:event2' });
        }

        protected async onStart(): Promise<void> {}
        protected async onStop(): Promise<void> {}
      }

      const emittingRuntime2 = new EmittingRuntime2('emitting-runtime2');
      const emittedEvents2: string[] = [];
      const unsubscribe2 = emittingRuntime2.onEvent((event) => {
        emittedEvents2.push(event.type);
      });

      await emittingRuntime2.start();
      unsubscribe2(); // Unsubscribe before emitting
      await emittingRuntime2.emitTestEvent();
      await emittingRuntime2.stop();

      assert.ok(!emittedEvents2.includes('custom:event2'));
    });

    it('lifecycle events emitted in correct order', async () => {
      const runtime = new TestRuntime('lifecycle-test');
      const lifecycleEvents: string[] = [];

      runtime.onEvent((event) => {
        if (event.type.startsWith('runtime:')) {
          lifecycleEvents.push(event.type);
        }
      });

      await runtime.start();
      await runtime.stop();

      assert.deepEqual(lifecycleEvents, [
        'runtime:starting',
        'runtime:started',
        'runtime:stopping',
        'runtime:stopped',
      ]);
    });

    it('start failure transitions to stopped and emits start-failed', async () => {
      class FailingRuntime extends Runtime {
        protected async onStart(): Promise<void> {
          throw new Error('Start failed');
        }

        protected async onStop(): Promise<void> {}
      }

      const runtime = new FailingRuntime('failing-runtime');
      const events: string[] = [];

      runtime.onEvent((event) => {
        if (event.type.startsWith('runtime:')) {
          events.push(event.type);
        }
      });

      await assert.rejects(runtime.start(), /Start failed/);
      assert.equal(runtime.state, 'stopped');
      assert.ok(events.includes('runtime:starting'));
      assert.ok(events.includes('runtime:start-failed'));
      assert.ok(!events.includes('runtime:started'));
    });

    it('stop failure transitions to stopped and emits stop-failed', async () => {
      class FailingStopRuntime extends Runtime {
        protected async onStart(): Promise<void> {}
        protected async onStop(): Promise<void> {
          throw new Error('Stop failed');
        }
      }

      const runtime = new FailingStopRuntime('failing-stop-runtime');
      const events: string[] = [];

      runtime.onEvent((event) => {
        if (event.type.startsWith('runtime:')) {
          events.push(event.type);
        }
      });

      await runtime.start();
      await assert.rejects(runtime.stop(), /Stop failed/);
      assert.equal(runtime.state, 'stopped');
      assert.ok(events.includes('runtime:stopping'));
      assert.ok(events.includes('runtime:stop-failed'));
      assert.ok(!events.includes('runtime:stopped'));
    });

    it('name is included in emitted events', async () => {
      const runtime = new TestRuntime('named-runtime');
      const eventNames: string[] = [];

      runtime.onEvent((event) => {
        eventNames.push(event.runtimeName ?? 'undefined');
      });

      await runtime.start();
      await runtime.stop();

      assert.ok(eventNames.every((name) => name === 'named-runtime'));
    });
  });
});