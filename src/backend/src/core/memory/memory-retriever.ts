/**
 * Memory Retriever — Ranking-based retrieval over MemoryStore
 *
 * P1-38. This wave uses a keyword scorer (case-insensitive term overlap)
 * as a stand-in for semantic embeddings; the architecture keeps the
 * `RetrievalStrategy` seam so a real embedding pipeline can slot in later.
 *
 * Scoring:
 * - keyword:  (# matching query words) / (# query words)
 * - hybrid:   keywordScore * (0.5 + importance * 0.5)
 */

import type { MemoryEntry, MemoryScope, MemoryStore } from './memory-store.js';

export type RetrievalStrategy = 'keyword' | 'semantic' | 'hybrid';

export interface RetrievalResult {
  entry: MemoryEntry;
  score: number;
}

export interface RetrieveQuery {
  text: string;
  scope?: MemoryScope;
  type?: string;
  topK?: number;
  minScore?: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
}

/**
 * Keyword-based retriever over any MemoryStore implementation.
 */
export class MemoryRetriever {
  private readonly store: MemoryStore;
  private readonly strategy: RetrievalStrategy;
  private readonly defaultTopK: number;

  constructor(store: MemoryStore, opts?: { strategy?: RetrievalStrategy; topK?: number }) {
    this.store = store;
    this.strategy = opts?.strategy ?? 'keyword';
    this.defaultTopK = opts?.topK ?? 10;
  }

  private scoreEntry(entry: MemoryEntry, queryWords: string[]): number {
    if (queryWords.length === 0) return 0;
    const content = entry.content.toLowerCase();
    let hits = 0;
    for (const word of queryWords) {
      if (word.length > 0 && content.includes(word)) hits += 1;
    }
    const keywordScore = hits / queryWords.length;
    if (this.strategy === 'hybrid') {
      const importance = entry.importance ?? 0.5;
      return keywordScore * (0.5 + importance * 0.5);
    }
    // 'semantic' currently proxies the keyword scorer (documented seam)
    return keywordScore;
  }

  async retrieve(query: RetrieveQuery): Promise<RetrievalResult[]> {
    const words = tokenize(query.text);
    const topK = query.topK ?? this.defaultTopK;
    const minScore = query.minScore ?? 0;

    // Pull a generous candidate window from the store (respecting scope/type filters).
    const candidates = await this.store.query({
      scope: query.scope,
      type: query.type,
      limit: Math.max(100, topK * 5),
    });

    const scored: RetrievalResult[] = [];
    for (const entry of candidates) {
      const score = this.scoreEntry(entry, words);
      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const filtered = minScore > 0 ? scored.filter((r) => r.score >= minScore) : scored;
    return filtered.slice(0, topK);
  }
}