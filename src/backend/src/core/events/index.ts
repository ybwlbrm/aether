/**
 * Aether 2.0 — Core Events Module
 *
 * Transport-agnostic event bus and event store for AgentEvent distribution and persistence.
 * No Fastify, SSE, or network imports — pure in-process interfaces + in-memory implementations.
 */

export {
  EventBus,
  createInMemoryEventBus,
} from './event-bus.js';

export {
  EventStoreEvent,
  EventStore,
  InMemoryEventStore,
} from './event-store.js';

export {
  SqliteEventStore,
} from './event-store.sqlite.js';

export {
  EventReplayOptions,
  StreamingReplayOptions,
  replay,
  replayFrom,
  replayStream,
} from './event-replay.js';

export {
  SequenceAllocator,
  type SequenceAllocatorOptions,
} from './event-sequence.js';

export {
  Projector,
  ProjectorRegistry,
  type ProjectOptions,
  project,
} from './event-projector.js';

export {
  DbSequenceAllocator,
  type DbSequenceAllocatorOptions,
} from './sequence-allocator.db.js';

export {
  type SseWritableTarget,
  type EventTransport,
  formatSseEvent,
  SseTransport,
  InMemorySseTransport,
} from './sse-transport.js';

export {
  PACKABLE_EVENT_TYPES,
  PACK_MAX_CHUNKS,
  PACK_MAX_BYTES,
  type PackedChunk,
  isPackable,
  queuePack,
  shouldFlushPack,
  buildPackedPayload,
  unpackPackedPayload,
  packedRowSeq,
} from './chunk-packer.js';

export {
  type LegacyEventRow,
  type LegacyEmitParams,
  toLegacyRow,
  fromLegacyRow,
  syncLegacyToNew,
  syncNewToLegacy,
} from './legacy-adapter.js';