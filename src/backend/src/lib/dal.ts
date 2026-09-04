/**
 * Data Access Layer — JSON file-based persistence
 * Manages ./data/settings.json, ./data/projects.json, ./data/memory.json, ./data/chat_history.json
 * Thread-safe with file locks via atomic writes (write to temp, rename)
 */
// Re-export all public API from split modules
export * from './dal/index.js';