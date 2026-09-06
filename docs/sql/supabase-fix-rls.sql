-- ============================================================
-- Aether 安全 RLS 策略 v2（P0-A01 / A02 / A03 / A05 修复）
-- 在 Supabase SQL Editor 中执行此脚本（需先执行 supabase-schema.sql）
--
-- 新安全模型（替代旧的「service_role 全权 + anon 全拒」架构）：
--   • 客户端（手机端）使用「anon key（可公开）+ Supabase Auth 登录」建立身份，
--     不再要求客户端持有 service_role key。
--   • RLS 行级策略：authenticated 用户仅能访问 user_id = auth.uid() 的行。
--   • 桌面端（service_role）全权访问，负责高权限操作与回包写入；
--     处理手机端命令时从 remote_commands.user_id 继承身份。
--   • anon（未登录）对全部同步表拒绝访问。
--
-- 前提：supabase-schema.sql 已为各表增加 user_id 列（UUID REFERENCES auth.users(id)）。
-- 部署后：手机端使用 Anon Key + 邮箱密码登录即可读写自己的数据。
-- ============================================================

-- ============================================================
-- 1. 启用所有同步表的 RLS
-- ============================================================
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. 通用辅助：anon 拒绝策略（每张表各建一份）
-- ============================================================

-- devices
DROP POLICY IF EXISTS "devices_deny_anon" ON devices;
CREATE POLICY "devices_deny_anon" ON devices
  FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- conversations_sync
DROP POLICY IF EXISTS "conversations_deny_anon" ON conversations_sync;
CREATE POLICY "conversations_deny_anon" ON conversations_sync
  FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- messages_sync
DROP POLICY IF EXISTS "messages_deny_anon" ON messages_sync;
CREATE POLICY "messages_deny_anon" ON messages_sync
  FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- remote_commands
DROP POLICY IF EXISTS "remote_commands_deny_anon" ON remote_commands;
CREATE POLICY "remote_commands_deny_anon" ON remote_commands
  FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- sync_log
DROP POLICY IF EXISTS "sync_log_deny_anon" ON sync_log;
CREATE POLICY "sync_log_deny_anon" ON sync_log
  FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- knowledge
DROP POLICY IF EXISTS "knowledge_deny_anon" ON knowledge;
CREATE POLICY "knowledge_deny_anon" ON knowledge
  FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- settings
DROP POLICY IF EXISTS "settings_deny_anon" ON settings;
CREATE POLICY "settings_deny_anon" ON settings
  FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- ============================================================
-- 3. service_role 全权（桌面端/后端：高权限操作经此通道）
-- ============================================================

DROP POLICY IF EXISTS "devices_service_all" ON devices;
CREATE POLICY "devices_service_all" ON devices
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "conversations_service_all" ON conversations_sync;
CREATE POLICY "conversations_service_all" ON conversations_sync
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "messages_service_all" ON messages_sync;
CREATE POLICY "messages_service_all" ON messages_sync
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "remote_commands_service_all" ON remote_commands;
CREATE POLICY "remote_commands_service_all" ON remote_commands
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "sync_log_service_all" ON sync_log;
CREATE POLICY "sync_log_service_all" ON sync_log
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "knowledge_service_all" ON knowledge;
CREATE POLICY "knowledge_service_all" ON knowledge
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "settings_service_all" ON settings;
CREATE POLICY "settings_service_all" ON settings
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================================
-- 4. authenticated 行级隔离：仅能访问 user_id = auth.uid() 的行
--    行级写保护（WITH CHECK）防止伪造他人 user_id 或留空绕过。
-- ============================================================

-- devices：用户可注册/管理自己的设备
DROP POLICY IF EXISTS "devices_user_own" ON devices;
CREATE POLICY "devices_user_own" ON devices
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- conversations_sync：仅自己的对话
DROP POLICY IF EXISTS "conversations_user_own" ON conversations_sync;
CREATE POLICY "conversations_user_own" ON conversations_sync
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- messages_sync：仅自己对话内的消息
DROP POLICY IF EXISTS "messages_user_own" ON messages_sync;
CREATE POLICY "messages_user_own" ON messages_sync
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- remote_commands：仅自己发起的远程命令（高危表：可触发电脑端执行）
DROP POLICY IF EXISTS "remote_commands_user_own" ON remote_commands;
CREATE POLICY "remote_commands_user_own" ON remote_commands
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- sync_log：只读自己的日志（写入由 service_role 完成）
DROP POLICY IF EXISTS "sync_log_user_read" ON sync_log;
CREATE POLICY "sync_log_user_read" ON sync_log
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- knowledge：仅自己的知识库
DROP POLICY IF EXISTS "knowledge_user_own" ON knowledge;
CREATE POLICY "knowledge_user_own" ON knowledge
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- settings：仅自己的设置
DROP POLICY IF EXISTS "settings_user_own" ON settings;
CREATE POLICY "settings_user_own" ON settings
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- 5. Realtime 订阅（手机端实时接收）
--    Realtime 的 postgres_changes 授权检查走 SELECT 策略，
--    authenticated 用户只会收到 user_id = auth.uid() 的行。
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE devices;
ALTER PUBLICATION supabase_realtime ADD TABLE conversations_sync;
ALTER PUBLICATION supabase_realtime ADD TABLE messages_sync;
ALTER PUBLICATION supabase_realtime ADD TABLE remote_commands;
ALTER PUBLICATION supabase_realtime ADD TABLE knowledge;
ALTER PUBLICATION supabase_realtime ADD TABLE settings;

-- ============================================================
-- 6. 数据流说明（重要）
--
--   手机端发起命令：remote_commands.user_id = 手机端用户 uid
--   桌面端处理命令（service_role）：
--     - 从 remote_commands 读取 user_id
--     - 写入 conversations_sync / messages_sync / sync_log 时携带同一 user_id
--     - 手机端即可通过 RLS 读到结果
--   桌面端主动同步本地历史对话（sync-config.json 未配置 userId 时）：
--     - 写入的 user_id 为 NULL，登录用户 RLS 不可见
--     - 如需手机端可见，请在 data/sync-config.json 增加 "userId": "<auth 用户 uuid>"
--
-- 自检查询：
--   SELECT schemaname, tablename, policyname FROM pg_policies
--   WHERE schemaname = 'public' ORDER BY tablename, policyname;
-- ============================================================
