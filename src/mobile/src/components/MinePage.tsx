import { useState, useEffect } from 'react';
import { ChevronRight, LogOut, Palette, User } from 'lucide-react';
import { getCurrentUser, loadConfig } from '../api/supabase';
import { getStoredTheme, applyTheme, type ThemeMode } from '../lib/theme';

interface Props {
  onOpenAppearance: () => void;
  onSignOut: () => void;
}

/**
 * 我的页（§9.3 最小页）
 * - 头像 + 邮箱 + 设备名
 * - 外观入口（AppearanceSettings）
 * - 深色模式 Switch（applyTheme）
 * - 退出登录（danger）
 */
export default function MinePage({ onOpenAppearance, onSignOut }: Props) {
  const [theme, setTheme] = useState<ThemeMode>(() => getStoredTheme() ?? 'dark');
  const user = getCurrentUser();
  const cfg = loadConfig();

  const toggleTheme = () => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  };

  return (
    <div className="mine-page fade-in">
      <div className="mine-header">
        <h1 className="mine-title">我的</h1>
      </div>

      <div className="mine-profile glass-surface">
        <div className="mine-avatar">
          <User size={24} />
        </div>
        <div>
          <div className="mine-email">{user?.email || '未登录'}</div>
          <div className="mine-device">{cfg?.deviceName || 'Aether 手机端'}</div>
        </div>
      </div>

      <div className="mine-list">
        <button className="mine-row" onClick={onOpenAppearance}>
          <Palette size={18} className="mine-row-icon" />
          <span>外观</span>
          <ChevronRight size={16} className="mine-row-chevron" />
        </button>
        <div className="mine-row">
          <span>深色模式</span>
          <button
            className={`switch ${theme === 'dark' ? 'on' : ''}`}
            onClick={toggleTheme}
            aria-label="切换深色模式"
            style={{ marginLeft: 'auto' }}
          />
        </div>
      </div>

      <div className="mine-list" style={{ marginTop: 16 }}>
        <button className="mine-row danger" onClick={onSignOut}>
          <LogOut size={18} className="mine-row-icon" />
          <span>退出登录</span>
        </button>
      </div>
    </div>
  );
}
