/**
 * 命令执行工具 — 供 AI Agent 通过 function calling 安全执行 shell 命令
 * 安全模型（与 workflows system 节点一致）：
 *  - 命令白名单 ALLOWED_EXEC：仅允许无害常用程序（首词精确匹配）
 *  - 黑名单双重拦截：token 级精确匹配 + 危险组合子串，防 & | ; 拼接注入
 *  - spawn + shell:false 防命令注入；Windows 内建命令改为原生实现，不再经 cmd.exe
 *  - workdir 必须位于 allowedDirs 内（Level 3 例外），敏感路径一律拒绝
 *  - Level 1（只读）拒绝执行；超时上限 60s；输出截断 50000 字符
 */
// Re-export all public API from split modules
export * from './command/index.js';