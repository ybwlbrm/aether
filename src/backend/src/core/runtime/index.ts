/**
 * Core Runtime Module — Transport-Agnostic Runtime Foundation
 *
 * This module provides the core runtime primitives:
 * - Runtime: Abstract base class with lifecycle management and event emission
 * - RuntimeContext: Execution context with abort signal and key-value store
 * - LifecycleManager: Strict state machine for lifecycle transitions
 * - CancellationToken: AbortSignal wrapper with ergonomic cancellation handling
 * - RunStateMachine: Run lifecycle state machine (Aether 2.0)
 * - TaskStateMachine: Task lifecycle state machine (Aether 2.0)
 * - Checkpoint: Run/Task state serialization (Aether 2.0)
 *
 * Zero external runtime dependencies. Pure TypeScript only.
 */

// Runtime base class and events
export {
  Runtime,
  type RuntimeEvent,
  type RuntimeEventListener,
} from './runtime.js';

// Runtime context
export {
  type RuntimeContext,
  type CreateRuntimeContextOptions,
  createRuntimeContext,
} from './runtime-context.js';

// Lifecycle management
export {
  type LifecycleState,
  type LifecycleHooks,
  LifecycleManager,
  withLifecycle,
} from './lifecycle.js';

// Cancellation primitives
export {
  CancellationToken,
  CancellationError,
  isCancellationError,
  withTimeout,
  withCancellation,
} from './cancellation.js';

// Run state machine (Aether 2.0)
export {
  type RunStatus,
  type RunMode,
  type RunEntity,
  RunStateMachine,
} from './run.js';

// Task state machine (Aether 2.0)
export {
  type TaskStatus,
  type TaskEntity,
  TaskStateMachine,
  setChild,
  canStart,
} from './task.js';

// Checkpoint serialization (Aether 2.0)
export {
  type Checkpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
  createCheckpoint,
} from './checkpoint.js';

// Re-export RuntimeError for convenience (used in lifecycle transitions)
export { RuntimeError } from '../errors/index.js';