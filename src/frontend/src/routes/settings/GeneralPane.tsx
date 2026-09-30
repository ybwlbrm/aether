import { useEffect, useRef, useState } from 'react';
import { Save } from 'lucide-react';
import { api } from '../../api/client';
import { useSafeTimeout } from '../../hooks/useSafeTimeout';
import { confirm as confirmDialog } from '../../components/ui/confirm-dialog';
import { GeneralSettings } from './GeneralSettings';
import { DataSettings } from './DataSettings';

/**
 * GeneralPane — General tab 的**容器**（T25a）。
 *
 * T25 之前这段状态（port / allowedDirs / defaultDir / Save）与 500 行旧 glass/wallpaper
 * 实现混在 routes/Settings.tsx 里，双轨并存。本文件只保留「与外观无关」的服务端设置：
 *   - port            → POST /api/settings
 *   - allowedDirs / defaultDir → POST /api/settings/security（P0-6：不能走 /api/settings，会 403）
 * 外观（theme / material / wallpaper）已整体归 appearance store + AppearanceSettings，
 * 此处不再持有任何 glass / 背景状态。
 */

/** /api/settings 载荷 —— 只声明本容器真正读写的字段，其余一律忽略 */
interface ServerSettings {
  port?: number;
  theme?: string;
  allowedDirs?: string[];
  defaultDir?: string;
}

interface GeneralPaneProps {
  navigate: (path: string) => void;
}

export function GeneralPane({ navigate }: GeneralPaneProps) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  // 审计修复：安全 setTimeout，组件卸载时自动清理
  const safeTimeout = useSafeTimeout();
  const [port, setPort] = useState(3000);
  const [theme, setTheme] = useState('dark');
  const [allowedDirs, setAllowedDirs] = useState<string[]>([]);
  const [defaultDir, setDefaultDir] = useState<string>('');
  const [newDir, setNewDir] = useState('');
  const filePickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = (await api.getSettings()) as ServerSettings | null;
        if (!data) return;
        if (data.port) setPort(data.port);
        if (data.theme) setTheme(data.theme);
        if (Array.isArray(data.allowedDirs)) setAllowedDirs(data.allowedDirs);
        if (data.defaultDir) setDefaultDir(data.defaultDir);
      } catch {
        /* ignore - intentional */
      }
    })();
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const relPath = file.webkitRelativePath;
    setNewDir(relPath ? relPath.split('/')[0] : file.name);
    e.target.value = '';
  };

  const handleAddDir = async () => {
    const dir = newDir.trim();
    if (!dir) return;
    if (allowedDirs.includes(dir)) { setNewDir(''); return; }
    const prevDirs = allowedDirs;
    const prevDefault = defaultDir;
    const updated = [...allowedDirs, dir];
    // 如果是第一个目录，自动设为默认工作目录
    const newDefaultDir = allowedDirs.length === 0 ? dir : defaultDir;
    setAllowedDirs(updated);
    setDefaultDir(newDefaultDir);
    setNewDir('');
    // P0-6 修复：allowedDirs/defaultDir 必须走 /api/settings/security 端点，不能走 /api/settings（会被 403 拒绝）
    // 审计修复：保存失败时回滚乐观更新并提示用户，不再静默吞错
    try {
      await api.saveSettings({ port, theme });
      await api.saveSecuritySettings({ allowedDirs: updated, defaultDir: newDefaultDir });
    } catch (e: unknown) {
      setAllowedDirs(prevDirs);
      setDefaultDir(prevDefault);
      setMsg(`❌ 目录保存失败: ${e instanceof Error ? e.message : '网络错误'}`);
    }
  };

  const handleRemoveDir = async (dir: string) => {
    // P0-4 修复：删除可访问目录前二次确认
    if (!(await confirmDialog('确定删除此可访问目录？AI 将无法再访问该目录。'))) return;
    const prevDirs = allowedDirs;
    const prevDefault = defaultDir;
    const updated = allowedDirs.filter((d) => d !== dir);
    setAllowedDirs(updated);
    // 如果删除的是默认目录，用第一个剩余目录或清空
    const newDefaultDir = defaultDir === dir ? (updated[0] ?? '') : defaultDir;
    setDefaultDir(newDefaultDir);
    // 审计修复：保存失败时回滚乐观更新并提示用户
    try {
      await api.saveSettings({ port, theme });
      await api.saveSecuritySettings({ allowedDirs: updated, defaultDir: newDefaultDir });
    } catch (e: unknown) {
      setAllowedDirs(prevDirs);
      setDefaultDir(prevDefault);
      setMsg(`❌ 目录删除失败: ${e instanceof Error ? e.message : '网络错误'}`);
    }
  };

  const handleSetDefault = async (dir: string) => {
    const prevDefault = defaultDir;
    setDefaultDir(dir);
    // 审计修复：保存失败时回滚乐观更新并提示用户
    try {
      await api.saveSettings({ port, theme });
      await api.saveSecuritySettings({ allowedDirs, defaultDir: dir });
    } catch (e: unknown) {
      setDefaultDir(prevDefault);
      setMsg(`❌ 默认目录设置失败: ${e instanceof Error ? e.message : '网络错误'}`);
    }
  };

  const handleSave = async () => {
    setSaving(true); setMsg('');
    try {
      // P0-6 修复：allowedDirs/defaultDir 必须走 /api/settings/security，不能走 /api/settings（会 403）
      await api.saveSettings({ port, theme });
      await api.saveSecuritySettings({ allowedDirs, defaultDir });
      setMsg('✅ Saved');
    } catch {
      setMsg('❌ Error');
    }
    setSaving(false);
    safeTimeout(() => setMsg(''), 3000);
  };

  return (
    <>
      <GeneralSettings
        port={port}
        setPort={setPort}
        allowedDirs={allowedDirs}
        setAllowedDirs={setAllowedDirs}
        defaultDir={defaultDir}
        setDefaultDir={setDefaultDir}
        newDir={newDir}
        setNewDir={setNewDir}
        filePickerRef={filePickerRef}
        handleFileChange={handleFileChange}
        handleAddDir={handleAddDir}
        handleRemoveDir={handleRemoveDir}
        handleSetDefault={handleSetDefault}
        navigate={navigate}
      />

      <div style={{ marginTop: 24 }}>
        <DataSettings />
      </div>

      <div className="flex items-center gap-3 pt-4">
        <button onClick={handleSave} disabled={saving} className="btn btn-primary">
          <Save size={18} /> {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {msg && <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{msg}</span>}
      </div>
    </>
  );
}
