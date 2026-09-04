/**
 * 搜索工具 — grep / glob / web_search / web_fetch，供 AI Agent 通过 function calling 使用
 * 安全限制：
 *  - 本地搜索（grep/glob）：只能在 allowedDirs 目录内操作（Level 3 超级权限除外），
 *    跳过 node_modules/.git/dist 等目录，不跟随符号链接（防止逃逸出允许目录）
 *  - 网络工具（web_search/web_fetch）：SSRF 防护，禁止抓取本地/内网/云元数据地址
 * 实现约束：仅使用 Node.js 内置模块（fs/path/os），无第三方依赖，无 shell 命令
 */
// Re-export all public API from split modules
export * from './search-tools/index.js';