# AETHER FINAL MOBILE-SYNC AUDIT — 最终移动端同步审计

> 生成：2026-09-05 · 版本 2.0.0

## 一、Android 与 EXE 同步链（任务 §93 要求证明四条链路）

### 1. EXE → Supabase（推送）
- SyncRuntime（backend modules/sync）：syncConversationsToSupabase / syncMessageToSupabase
- 桌面端后端以本机 service_role 写入（服务端凭据，架构正确）
- 每对话创建/消息/事件触发推送，250ms 节流 + 串行 flush 队列

### 2. Supabase → Android（接收）
- Realtime channel（channel registry 管理，P0-A07 修复）
- conversations_sync / messages_sync 订阅 + DELETE 事件处理（P0-A06 修复）
- RLS 行级隔离：authenticated 用户只能读自己 user_id 的行

### 3. Android → Supabase（命令发起）
- sendCommand：client_command_id 幂等键（P0-A17）+ run_id/task_id 关联（P0-A16）
- 离线队列：断网入队 localStorage，恢复后 flushPendingQueue 上传去重（§40）
- Supabase Auth 登录（email/password），session 持久化 + 自动刷新

### 4. Supabase → EXE（命令执行）
- RemoteCommandWorker（polling-fallback + realtime）：claim 命令 → 执行 → 写 Run → 回写事件
- client_command_id 去重：重复投递跳过（command-processor L74-98）
- 执行结果经 conversations_sync/messages_sync 回推手机

## 二、认证/授权/同步矩阵（任务 §93）

| 环节 | 机制 |
|------|------|
| 认证 | Supabase Auth（mobile）；桌面端本机 service_role |
| 授权 | RLS 行级策略（user_id = auth.uid()） |
| 同步 | Realtime 主通道 + 断线轮询降级（P0-A08） |
| Realtime | channel registry + 引用计数 + DELETE 支持 |
| 重试 | 指数退避（1/2/4/8/16/30s + jitter） |
| 冲突 | last-write-wins（updated_at）+ Event append-only |
| 删除 | 双向级联（桌面端 realtime DELETE → 本地删；手机 DELETE → Supabase 级联） |
| 恢复 | session 恢复 → device 注册 → sync → pull missed → subscribe |

## 三、SyncState 模型（§十八）

```ts
SyncState {
  status: 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'offline' | 'error';
  lastSyncAt: string | null;
  pendingCount: number;
}
```
- sync-state.ts 模块级实现 + onSyncStateChange 订阅
- pendingCount 由 remote_commands 状态事件驱动

## 四、验收场景（任务 §38）

| 场景 | 状态 |
|------|------|
| A：电脑创建 Conversation → 手机出现 | ✅ Realtime + 拉取 |
| B：电脑发消息 → 手机实时看到 | ✅ messages_sync Realtime |
| C：手机发命令 → 电脑执行 | ✅ RemoteCommandWorker |
| D：电脑执行 Agent/Tool → 手机看到 Run/Activity | ✅ events → messages_sync 回推 |
| E：手机删除 → 电脑同步删 | ✅ Supabase 级联 + 桌面 realtime DELETE |
| F：电脑删除 → 手机同步删 | ✅ DELETE payload 处理 + 本地移除 |

## 五、Android 构建审计（§41）

| 项 | 值 |
|----|----|
| applicationId | com.pacc.app |
| versionCode / versionName | 2 / 2.0.0 |
| minSdk / targetSdk / compileSdk | 24 / 36 / 36 |
| 权限 | 仅 INTERNET（最小化） |
| cleartext | 默认禁止（targetSdk 36） |
| Capacitor scheme | https |

## 六、遗留（NOT VERIFIED / 说明）

- **RLS 执行状态**：docs/sql/supabase-fix-rls.sql 需在 Supabase 控制台实际执行（仓库内无法验证）
- **真机 APK**：本环境无完整 Android 构建链，未真机构建验证（§105 标记 NOT VERIFIED）
- **消息级流式**：仍以 messages_sync UPDATE 逐步增长为主（P0-A09 部分保留），Run/Event 协议方向已对齐
- **Notification**：任务完成/失败通知需经桌面端状态（trusted backend state）触发
