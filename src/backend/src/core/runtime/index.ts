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
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
  isValidRunTransition,
  type RunStatus,
  type RunMode,
  type RunEntity,
  RunStateMachine,
} from './run.js';

// Run context factory (P0-02: single Run ID across all components)
export {
  type RunContext,
  type CreateRunContextOptions,
  createRunContext,
} from './run-context.js';

// Run lifecycle manager (P0-05: single state-machine writer for runs table)
export {
  RunLifecycleManager,
  getRunLifecycleManager,
  resetRunLifecycleManager,
  type RunAction,
  type CreateRunInput,
  type TransitionOptions,
} from './run-lifecycle-manager.js';

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
export { RuntimeError } from '../errors/index.js'

// Multi-layer retry controllers
export {
  ExecutionRetryController,
  ToolRecoveryController,
  RetryCheckpoint,
  isToolRetryable,
  isToolAutoRetryAllowed,
  TOOL_SIDE_EFFECT_CLASSES,
  DEFAULT_TOOL_SIDE_EFFECT_CLASS,
  type RetryEvent,
  type RetryEventPayload,
  type RetryEventType,
  type RetryLayer,
  type RetryRunOptions,
  type RetrySleep,
  type RetryPredicate,
  type RetryType,
  type ToolSideEffectClass,
  type ExecutionRetryOptions,
  type ToolRecoveryOptions,
  type ToolRecoveryRunOptions,
} from './execution-retry.js'

// Task completion evaluator（AEX-P0-001：Loop 完成判定的唯一权威实现）
export {
  evaluateTaskCompletion,
  type CompletionStatus,
  type CompletionToolCall,
  type CompletionToolResult,
  type CompletionResponse,
  type CompletionVerdict,
  type TaskCompletionEvaluator,
} from './execution-completion.js'
