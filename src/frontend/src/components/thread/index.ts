/**
 * T17 —— Codex 风格 Thread 组件集。
 *
 * 全部组件零内部状态、零副作用：capability 与展开态一律经 props 传入，
 * 因此可在无 jsdom 的环境下用 renderToStaticMarkup 直接断言折叠/展开/11 态等渲染分支。
 * 业务模块（store / hooks / api / lib）在本目录只被**只读消费**。
 */
export * from "./ApprovalPrompt"
export * from "./RunStatusStrip"
export * from "./Thread"
export * from "./ThreadEmpty"
export * from "./ThreadMessage"
export * from "./ToolActivity"
