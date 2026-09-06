# Baseline — 开源版（OPEN SOURCE）

> 生成时间：2026-09-05
> 路径：`D:\Aether-OpenSource`

## 版本识别

| 项 | 值 |
|---|---|
| 目录 | `D:\Aether-OpenSource` |
| git remote | `https://github.com/ybwlbrm/aether.git` |
| branch | master |
| HEAD | `095104a` docs: README 重构 — 突出 Aether 2.0 亮点（本地优先/11 Agent/864测试），验证所有数字与文件 |
| 工作树 | clean |
| package version | 1.0.0（README 徽章声称 2.0 — **版本不一致**） |
| LICENSE | MIT |

## 环境

| 项 | 值 |
|---|---|
| node | v24.18.0 |
| npm | 11.16.0 |

## Baseline 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 待运行（与自用版同一份代码） |
| `npm run lint` | 待运行 |
| `npm test` | 待运行 |
| `npm run build` | 待运行 |

## 与自用版差异

- src/ 源码与自用版一致（435 文件，仅 tsbuildinfo 缓存 + settings.json 不同）
- `.gitignore` 更完善（`**/data/`、`*.jks`、`keystore.properties`、`.env.*`、`supabase-fix-rls.sql`、`supabase-schema.sql`、`**/dist/` 等）
- 独有 LICENSE、README（Aether 2.0 新版）

## 注意

- README 声称「864+ 自动化测试全绿」「本地优先 绝不上云」—— 前者需真实跑测试验证，后者与 Supabase 同步功能矛盾，需按任务 §50 修正 README 表述
- 版本需统一为 2.0.0（或 2.0.0-alpha.x），当前 package.json 仍是 1.0.0
