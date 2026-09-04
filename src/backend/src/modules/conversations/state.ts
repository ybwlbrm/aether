// Shared module-level state for conversations domain
// Extracted from old index.ts during module split to avoid circular deps

export const activeRequests = new Map<string, AbortController>();