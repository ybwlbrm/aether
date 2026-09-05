/**
 * Core Module — Transport-Agnostic Runtime Foundation
 *
 * This module contains ONLY pure TypeScript types and utilities with ZERO
 * external runtime dependencies (no Fastify, no SSE, no React, no zod-for-runtime).
 *
 * Wave 1 (P1-01 + P1-41..P1-44): Only the `errors` submodule is implemented.
 * Wave 2+ will populate the remaining 8 scaffold barrels:
 *   - runtime   (P1-02)
 *   - events    (P1-03)
 *   - models    (P1-04)
 *   - agents    (P1-05)
 *   - tools     (P1-06)
 *   - permissions (P1-07)
 *   - memory    (P1-08)
 *   - artifacts (P1-09)
 *
 * Each sub-barrel currently exports an empty namespace (`export {}`) as a
 * placeholder. The root barrel only star-exports `./errors/index.js` to avoid
 * TypeScript "exported variable has or is using private name" errors on empty modules.
 */
export * from './errors/index.js';
export * from './runtime/index.js';

// Placeholder re-exports for future waves — uncomment when each submodule is implemented:
// export * from './events/index.js';
// export * from './models/index.js';
// export * from './agents/index.js';
// export * from './tools/index.js';
// export * from './permissions/index.js';
// export * from './memory/index.js';
// export * from './artifacts/index.js';