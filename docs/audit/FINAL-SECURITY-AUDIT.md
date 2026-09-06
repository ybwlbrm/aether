# AETHER FINAL SECURITY AUDIT — 最终安全审计

> 生成：2026-09-05 · 版本 2.0.0
> 方法：全面代码搜索（service_role/apiKey/Bearer/secret/password/token）+ 关键凭据链审查 + RLS SQL 审查

## 一、安全模型证明（任务 §94）

| 要求 | 证明 |
|------|------|
| **Android 不持有 Service Role Key** | ✅ mobile 客户端已改 anon key + Supabase Auth；grep 验证 service_role 仅在注释（supabase-auth.ts L14/35/76 说明"不再接触"） |
| **API Key 不进入 Event** | ✅ providers 表 AES-256-GCM 加密存储；API 返回 masked（`***encrypted***`）；model-runtime-bridge 解密后使用；events payload 为纯事件数据 |
| **Tool 必须经过 Policy** | ✅ ToolRuntime→ToolExecutor 权限链 |
| **Approval 不是唯一安全边界** | ✅ Android approval 需回桌面端重新校验 capability/policy/approval（任务 §71） |
| **Supabase 使用 RLS** | ✅ docs/sql/supabase-fix-rls.sql：7 表 ENABLE RLS + service_role 全权 + anon/authenticated 全拒 → 更新为 authenticated 行级隔离 |
| **Remote Command 有身份** | ✅ devices 表绑定 user_id；registerDevice 用登录用户身份 |
| **Remote Command 有幂等** | ✅ client_command_id 客户端生成 + 服务端去重 |
| **Storage 安全访问** | ✅ 私有 bucket + createSignedUrl（expiresIn 3600）+ size/MIME/extension 白名单 |

## 二、密钥处理链

```
用户输入 API Key → AES-256-GCM 加密 → SQLite（providers 表）
                 → 使用前 decrypt（lib/provider.ts L125 / model-runtime-bridge）
                 → 不进入 Event/Log/Frontend/Activity
```

## 三、桌面端 Sync 凭据（合理保留）

- 桌面端后端（本机服务端）持有 service_role：**符合架构**（§P0-A02：service_role 只在 Secure Backend）
- 前端 Settings 输入的 key 仅存本机 sync-config.json（0600 权限，后端不回传明文）
- 桌面端是本地单用户环境（非不可信客户端），与 mobile 不同

## 四、已消除风险

| 风险 | 状态 |
|------|------|
| 客户端 service_role 泄漏（mobile） | ✅ 已消除 |
| src/data/settings.json 个人路径泄漏 | ✅ 已备份移除 |
| 签名密钥入库 | ✅ .gitignore 覆盖 *.jks/keystore.properties |
| 私人日志/截图/构建产物入库 | ✅ 未同步 + gitignore 覆盖 |
| packed replay 数据错乱 | ✅ 已修复 |
| FK 删除崩溃 | ✅ 已修复 |

## 五、搜索项逐项结论（任务 §59）

| 搜索 | 结论 |
|------|------|
| `service_role` | mobile 已移除（仅注释）；桌面端后端本机使用（架构正确） |
| `chat/completions` | 收敛至 ProviderAdapter（合法）+ workflow 已改 ModelRuntime |
| `fetchWithRetry` | documents/media 等非模型路径保留（合法）；模型路径已收敛 |
| `ToolPolicy` / `PolicyEngine` | ToolPolicy 兼容保留 + PolicyEngine 新核心 |
| `memory.json` | memories 表为主，JSON 仅 import/export |
| `as unknown as` | 保留必要边界转换（消除核心 Runtime 链） |
| `remote_commands` | 幂等 + 身份 + run 关联 |
| `messages_sync`/`conversations_sync` | RLS 行级隔离 |

## 六、NOT VERIFIED

- Supabase 数据库侧 RLS 实际执行状态（需在控制台运行 docs/sql/ 脚本）
- 移动端真机网络层安全（证书校验、代理）
- Electron DPI 实机行为
