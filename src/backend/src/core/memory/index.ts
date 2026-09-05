/**
 * Core Memory Module
 *
 * Memory store (P1-37) and memory runtime (P1-36 interface) exports.
 * Do not import from outside core/ in this module.
 */

export {
  type MemoryEntry,
  type MemoryQuery,
  type MemoryScope,
  type MemoryStore,
  InMemoryMemoryStore,
} from './memory-store.js';

export {
  type MemoryRuntime,
  InMemoryMemoryRuntime,
  isMemoryRuntime,
} from './memory-runtime.js';

export {
  type RetrievalStrategy,
  type RetrievalResult,
  type RetrieveQuery,
  MemoryRetriever,
} from './memory-retriever.js';