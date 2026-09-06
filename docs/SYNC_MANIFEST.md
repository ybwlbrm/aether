# SYNC_MANIFEST — 自用版 → 开源版同步记录

> 生成：2026-09-05（Aether 2.0 整改完成日）
> 来源：`D:\PersonalAICommandCenter`（自用版）
> 目标：`D:\Aether-OpenSource`（开源版）
> 同步方式：**文件级差异分类合并**（非整目录覆盖，§54）

## 同步内容分类

| 分类 | 内容 | 处理 |
|------|------|------|
| COMMON | src/ 下 430 个源码文件（含本次修复 + 新增测试/模块） | ✅ 已同步 |
| COMMON | package.json、README.md、eslint.config.js、tsconfig*.json、capacitor.config.ts、.gitignore、CHANGELOG.md | ✅ 已同步 |
| COMMON | electron/main.js（P1-17/18/19 修复） | ✅ 已同步 |
| COMMON | android/app/build.gradle（versionCode 2 / versionName 2.0.0） | ✅ 已同步 |
| COMMON | data/supabase-schema.sql、supabase-fix-rls.sql（RLS 安全架构） | ✅ 已同步 |
| COMMON | docs/audit/（Baseline + AUDIT-FINDINGS + FIX-PLAN） | ✅ 已同步 |
| OPEN_SOURCE_ONLY | LICENSE | ✅ 保留开源版 |
| PRIVATE_ONLY | data/（个人数据库/配置）、qa/（截图/SSE）、日志、签名密钥（*.jks/keystore.properties）、构建产物（dist*/build 产物/APK/EXE）、docs/architecture/BASELINE-2.0.md | ⛔ 未同步 |

## 本次同步的关键修复（2.0.0）

| 领域 | 修复 |
|------|------|
| Event | P0-05 packed replay 按逻辑 seq 过滤；P0-06 幽灵 __seq_claim 过滤 |
| DB | P0-21 全部 FK 加 onDelete（cascade/set null）+ migrate v13 + 删除路由级联 |
| Model | P0-13 model-runtime-bridge 解密 API Key；P0-12/22 Workflow 接入 ModelRuntime |
| SSE | P0-14/15 streamClient Promise 正确 reject + await 完整流 |
| 前端 | P0-08 跨 Run 去重；P0-18 agent.completed 不误判 task；P1-02 reasoning 按 agent 隔离；P1-13 移除 clearConv 清历史 |
| Electron | P1-17 health poll 判 Ready；P1-18 EADDRINUSE 验证 Aether；P1-19 recovery scan + /api/runs/recover |
| Mobile | P0-A01~A03 anon key + Supabase Auth（移除客户端 service_role）；P0-A05 device UUID；P0-A06 DELETE 处理；P0-A07 channel registry；P0-A08 polling 降级；P0-A16/A17 幂等键 + run 关联；P0-A22 私有桶 signed URL |
| 版本 | 统一 2.0.0（package.json + Android） |
| README | §50 修正「绝不上云」表述，真实描述联网行为 |

## 验证状态

- 自用版：typecheck ✅ / lint ✅（0 errors）/ test ✅（886）/ build ✅ + 手工 QA PASS
- 开源版：typecheck ✅ / test ✅ / build ✅ + 安全审查（无 service_role 泄漏、无私有数据）
