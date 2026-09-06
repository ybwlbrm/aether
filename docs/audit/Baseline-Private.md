# Baseline — 自用版（PRIVATE）

> 生成时间：2026-09-05
> 路径：`D:\PersonalAICommandCenter`

## 版本识别

| 项 | 值 |
|---|---|
| 目录 | `D:\PersonalAICommandCenter` |
| git | **无 .git 目录（非 git 仓库）** |
| package version | 1.0.0 |
| README | 旧版「个人 AI 指挥中心」（版本 A/B 说明），未反映 Aether 2.0 |
| 私有数据 | `data/`、`src/data/settings.json`、`android/*.jks`、`keystore.properties`、构建产物、日志 |

## 环境

| 项 | 值 |
|---|---|
| node | v24.18.0 |
| npm | 11.16.0 |
| TypeScript | 7.0.2（根）；workspace 内 5.7.x |

## Baseline 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | **PASS**（exit 0） |
| `npm run lint` | **PASS**（exit 0；0 errors / 958 warnings — 大量 no-explicit-any / no-unused-vars，属 P2/P3 级） |
| `npm test` | **PASS**（exit 0；backend 795 pass / 1 skipped、frontend 37 pass、shared 32 pass） |
| `npm run build` | **PASS**（exit 0；shared+backend+frontend 全构建成功，frontend built in 30.36s） |

**结论**：自用版当前处于「可构建、可测试、全绿」状态。README 声称的 864+ 测试 ≈ 795+37+32 = 864，数字真实。**但全绿不代表无 bug** —— 审计已确认 P0 级逻辑缺陷 20+ 项（packed replay、API key 未解密、FK 删除、SSE fire-and-forget 等），现有测试未覆盖这些真实调用链。

## 与开源版差异（源码层面）

- src/ 下 435 个源码文件路径完全一致
- 内容差异仅 4 个：`src/backend/tsconfig.tsbuildinfo`、`src/frontend/tsconfig.tsbuildinfo`、`src/shared/tsconfig.tsbuildinfo`（构建缓存）、**`src/data/settings.json`（私有运行时配置，不应存在于源码树）**
- 根文件差异：`.gitignore`（自用版缺失 `**/data/`、`.env.*`、`*.jks` 通配等条目）、`CHANGELOG.md`
- 开源版独有：`LICENSE`
- 自用版独有（私有）：APK、EXE、日志、QA 截图、签名密钥、keystore.properties、build 产物

## 私有数据泄漏风险（自用版 → 开源版同步时必须排除）

1. `android/aether-release.jks` — Android 签名密钥
2. `android/keystore.properties` — 签名配置（可能含密码）
3. `src/data/settings.json` — 运行时配置
4. `data/` — 数据库与配置
5. `*.log` 系列 — 运行日志（可能含 API 请求信息）
6. `Aether-Mobile.apk` / `Personal-AI-Command-Center-Setup.exe` — 构建产物
7. `qa/` 截图与 SSE 捕获（curl-super-mode.sse 等可能含请求/响应内容）
8. `server_stdout.txt` / `server_stderr.txt`
