// Public facade for conversations module
// Re-exports the main registration function and shared utilities

export { registerConversationRoutes } from './routes.js';
// BE-V-01: 移除 fetchWithRetry 反向导出 — 外部统一从 lib/fetch-retry.js 导入，避免分层倒置
export { activeRequests } from './state.js';