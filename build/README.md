# Aether 构建与打包

> 日期：2026-09-26 ｜ 版本：2.3.0
> 本文档记录全部构建目标、命令、产物与验证方式。

---

## 1. 构建目标总览

| 目标 | 命令 | 产物 | 备注 |
|---|---|---|---|
| Shared 共享包 | `npm run build -w src/shared` | `src/shared/dist/` | 所有 workspace 依赖 |
| Backend | `npm run build -w src/backend` | `src/backend/dist/` | tsc 编译 |
| Frontend | `npm run build -w src/frontend` | `src/frontend/dist/` | tsc + vite build |
| Mobile | `npm run build -w src/mobile` | `src/mobile/dist/` | vite build |
| 全量（shared+backend+frontend） | `npm run build` | 各 workspace dist | 先 clean |
| Backend bundle（单文件） | `node build/bundle-backend.js` | `build/backend-bundle.js` | Electron 用 |
| EXE 便携版 + NSIS 安装包 | `npm run build:exe` | `dist_exe/` + `dist_electron/` | 需 electron-builder |
| Android APK | `npm run build:apk` | `android/app/build/outputs/apk/release/app-release.apk` | 需 JDK 21 + Android SDK |
| 一键全流程 | `npm run release:all` | 全部产物 + 同步 + 发布 | 见 release-all.js |

---

## 2. 构建顺序依赖

```
shared ──► backend ──► bundle-backend.js ──► Electron (main.js + backend-bundle.js)
   └────► frontend ──► Electron (src/frontend/dist) / APK 静态资源
   └────► mobile ──► Capacitor sync ──► Android gradle
```

关键点：
- `build/backend-bundle.js` 是 Electron 实际运行的后端（单文件 esbuild bundle）
- `build/sql-wasm.wasm/.js` 为 sql.js 运行时所需（SQLite）
- Electron 打包 files 清单见 `electron/electron-builder.yml`
- `@napi-rs/canvas` / `sharp` / `koffi` 为原生模块，需显式列入打包 files

---

## 3. 验证门（build 成功 ≠ release 成功）

每次发布前必须逐项验证：

| # | 门 | 验证命令/方式 |
|---|---|---|
| 1 | typecheck | `npm run typecheck` — 0 错误 |
| 2 | lint | `npm run lint` — 0 新增错误 |
| 3 | shared 测试 | `npm run test -w src/shared` |
| 4 | backend 测试 | `npm run build -w src/backend && npm run test -w src/backend` |
| 5 | frontend 测试 | `npm run test -w src/frontend` |
| 6 | mobile 测试 | `npm run test -w src/mobile` |
| 7 | 全量 build | `npm run build` — 各 dist 产物存在 |
| 8 | backend bundle | `node build/bundle-backend.js` 后 `node -e "require('./build/backend-bundle.js')"` 冒烟 |
| 9 | EXE 便携版 | 运行 `dist_exe/启动应用.bat` → 健康检查通过（`/api/health` 返回 app=aether） |
| 10 | NSIS 安装包 | 安装 → 启动 → 数据目录 `%USERPROFILE%\Documents\AICommandCenter\` 生成 |
| 11 | APK | 安装到 Android 设备 → 登录 → 连接桌面端 → 新建会话 → 流式响应 |

> ⚠️ 当前状态：EXE/APK 产物已构建但**未执行安装冒烟**（见 docs/TEST_MATRIX.md §5）。

---

## 4. release-all.js 流程

`npm run release:all` 完成：build 全部 → EXE → NSIS → APK → 同步开源版（D:\Aether-OpenSource）→ push GitHub → 发布 Release + 上传产物 + SHA256。

⚠️ 已知限制（RL-01/02）：
- `release-all.js:26-29` 硬编码 `D:\Aether-OpenSource` 路径与 JDK 路径（本机专用）
- NSIS 打包失败时 `build-exe.js:292-302` 为 warn-and-continue（可能产出不完整安装包）

---

## 5. 环境要求

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | 18+（推荐 20/22 LTS） | 全部构建 |
| JDK | 21 | Android gradle |
| Android SDK | 平台 34+ | APK 构建 |
| Windows | 10/11 | EXE/NSIS（electron-builder 目标） |

---

## 6. CI（.github/workflows/ci.yml）

| Job | 内容 |
|---|---|
| quality-gate | lockfile 校验 → shared build → typecheck → lint → 全量测试 → 生产 build |
| mobile-gate | mobile typecheck + test + build |

⚠️ 缺口（BD-04）：CI **无 Android/Gradle 与 Windows EXE 构建 job**——APK/EXE 仅在本地构建，CI 无法捕获打包回归。
