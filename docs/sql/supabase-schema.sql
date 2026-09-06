-- ============================================================
-- Aether 远程同步 & 命令表结构
-- 在 Supabase SQL Editor 中执行此脚本
-- ============================================================

-- 1. 设备注册表
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '未知设备',
    type TEXT NOT NULL DEFAULT 'desktop' CHECK (type IN ('desktop', 'mobile')),
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 为 devices 启用 Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE devices;

-- 2. 同步的对话记录
CREATE TABLE IF NOT EXISTS conversations_sync (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    title TEXT NOT NULL DEFAULT '新对话',
    model TEXT,
    message_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 为 conversations_sync 启用 Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE conversations_sync;

CREATE INDEX idx_conversations_sync_device ON conversations_sync(device_id);
CREATE INDEX idx_conversations_sync_updated ON conversations_sync(updated_at DESC);

-- 3. 同步的消息记录
CREATE TABLE IF NOT EXISTS messages_sync (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations_sync(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    tool_calls TEXT, -- JSON
    tool_results TEXT, -- JSON
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 为 messages_sync 启用 Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE messages_sync;

CREATE INDEX idx_messages_sync_conv ON messages_sync(conversation_id);
CREATE INDEX idx_messages_sync_created ON messages_sync(created_at ASC);

-- 4. 远程命令表（手机→桌面）
CREATE TABLE IF NOT EXISTS remote_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT NOT NULL REFERENCES devices(id),
    conversation_id TEXT, -- 如果回复已有对话，填此 ID
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    error TEXT,
    result_summary TEXT,
    client_command_id TEXT, -- P0-A17: 移动端客户端幂等键（UUID），桌面端据此去重离线补传
    run_id TEXT,            -- P0-A16: 桌面端本次执行 run 标识（处理中回填）
    task_id TEXT,           -- P0-A16: 桌面端任务标识（处理中回填）
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 为 remote_commands 启用 Realtime（桌面端监听此表）
ALTER PUBLICATION supabase_realtime ADD TABLE remote_commands;

CREATE INDEX idx_remote_commands_status ON remote_commands(status);
CREATE INDEX idx_remote_commands_device ON remote_commands(device_id);
CREATE INDEX idx_remote_commands_created ON remote_commands(created_at DESC);

-- 5. 同步日志表（兼容现有代码）
CREATE TABLE IF NOT EXISTS sync_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'success',
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_log_device ON sync_log(device_id);
CREATE INDEX idx_sync_log_created ON sync_log(created_at DESC);

-- 6. 知识库同步表（兼容现有代码）
CREATE TABLE IF NOT EXISTS knowledge (
    device_id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER PUBLICATION supabase_realtime ADD TABLE knowledge;

-- 7. 设置同步表（兼容现有代码）
CREATE TABLE IF NOT EXISTS settings (
    device_id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER PUBLICATION supabase_realtime ADD TABLE settings;

-- 给 device_id 默认值（方便首次插入）
CREATE OR REPLACE FUNCTION get_or_create_device(p_id TEXT, p_name TEXT, p_type TEXT)
RETURNS TEXT AS $$
BEGIN
    INSERT INTO devices (id, name, type, last_seen_at)
    VALUES (p_id, p_name, p_type, NOW())
    ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW()
    RETURNING id;
    RETURN p_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 8. 安全架构迁移（P0-A01 / A02 / A03 / A05 修复，2026-09-06）
--
-- 新安全模型：
--   - 客户端（手机端）使用「anon key + Supabase Auth 登录」建立身份，
--     禁止在客户端持有/使用 service_role key。
--   - 所有同步表增加 user_id 列，绑定 Supabase Auth 用户；
--     RLS 行级策略按 user_id = auth.uid() 隔离（见 supabase-fix-rls.sql）。
--   - 桌面端（service_role）绕过 RLS 全权访问；处理手机端命令时
--     从 remote_commands.user_id 继承身份写入回包数据。
--   - 触发器：authenticated 客户端 INSERT 时自动写入 auth.uid()；
--     service_role 写入时 auth.uid() 为 NULL，行保持 user_id = NULL
--     （桌面端主动同步的老数据对登录用户兼容可见性由 RLS 策略控制）。
--
-- 可重复执行（全部使用 IF NOT EXISTS / OR REPLACE / DROP IF EXISTS）。
-- ============================================================

-- 8.1 增加 user_id 列（UUID 关联 auth.users）
ALTER TABLE devices ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE conversations_sync ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE messages_sync ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE settings ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);

-- 8.2 user_id 查询索引
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_sync_user ON conversations_sync(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_sync_user ON messages_sync(user_id);
CREATE INDEX IF NOT EXISTS idx_remote_commands_user ON remote_commands(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_user ON sync_log(user_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_user ON knowledge(user_id);
CREATE INDEX IF NOT EXISTS idx_settings_user ON settings(user_id);

-- 8.4 迁移：已有库（CREATE TABLE IF NOT EXISTS 不生效时）补列 P0-A16/A17
ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS client_command_id TEXT;
ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS task_id TEXT;
CREATE INDEX IF NOT EXISTS idx_remote_commands_client_command_id ON remote_commands(client_command_id);

-- 8.3 触发器：INSERT/UPDATE 时若 user_id 为空则绑定当前登录用户。
--     注意：service_role / anon 下 auth.uid() 返回 NULL，桌面端行不受影响。
CREATE OR REPLACE FUNCTION set_sync_row_user_id()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id IS NULL THEN
        NEW.user_id := auth.uid();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_devices_user_id ON devices;
CREATE TRIGGER trg_devices_user_id
    BEFORE INSERT OR UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION set_sync_row_user_id();

DROP TRIGGER IF EXISTS trg_conversations_sync_user_id ON conversations_sync;
CREATE TRIGGER trg_conversations_sync_user_id
    BEFORE INSERT OR UPDATE ON conversations_sync
    FOR EACH ROW EXECUTE FUNCTION set_sync_row_user_id();

DROP TRIGGER IF EXISTS trg_messages_sync_user_id ON messages_sync;
CREATE TRIGGER trg_messages_sync_user_id
    BEFORE INSERT OR UPDATE ON messages_sync
    FOR EACH ROW EXECUTE FUNCTION set_sync_row_user_id();

DROP TRIGGER IF EXISTS trg_remote_commands_user_id ON remote_commands;
CREATE TRIGGER trg_remote_commands_user_id
    BEFORE INSERT OR UPDATE ON remote_commands
    FOR EACH ROW EXECUTE FUNCTION set_sync_row_user_id();

DROP TRIGGER IF EXISTS trg_sync_log_user_id ON sync_log;
CREATE TRIGGER trg_sync_log_user_id
    BEFORE INSERT OR UPDATE ON sync_log
    FOR EACH ROW EXECUTE FUNCTION set_sync_row_user_id();

DROP TRIGGER IF EXISTS trg_knowledge_user_id ON knowledge;
CREATE TRIGGER trg_knowledge_user_id
    BEFORE INSERT OR UPDATE ON knowledge
    FOR EACH ROW EXECUTE FUNCTION set_sync_row_user_id();

DROP TRIGGER IF EXISTS trg_settings_user_id ON settings;
CREATE TRIGGER trg_settings_user_id
    BEFORE INSERT OR UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION set_sync_row_user_id();