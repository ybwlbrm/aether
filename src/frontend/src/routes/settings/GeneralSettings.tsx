import { useState, useEffect, useCallback } from 'react';
import { FolderOpen, Trash2, Plus, Star, FileText, Image, Upload, Download, RefreshCw, Link2, Unlink, Wrench, Search, BookOpen, Workflow, FolderKanban, Database, KeyRound, Globe, Activity, Shield, Compass, Palette } from 'lucide-react';
import { api } from '../../api/client';
import { confirm as confirmDialog } from '../../components/ui/confirm-dialog';
import { useAppStore } from '../../store/app';
import { useNavigate } from 'react-router-dom';

interface GeneralSettingsProps {
  port: number;
  setPort: (port: number) => void;
  allowedDirs: string[];
  setAllowedDirs: (dirs: string[]) => void;
  defaultDir: string;
  setDefaultDir: (dir: string) => void;
  newDir: string;
  setNewDir: (dir: string) => void;
  filePickerRef: React.RefObject<HTMLInputElement | null>;
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleAddDir: () => void;
  handleRemoveDir: (dir: string) => Promise<void>;
  handleSetDefault: (dir: string) => Promise<void>;
  uiMode: string;
  navigate: (path: string) => void;
}

const featureGroups = [
  { label: '工具', items: [
    { label: '工具箱', icon: Wrench, path: '/toolbox', color: 'var(--color-warning)' },
    { label: '搜索引擎', icon: Search, path: '/search', color: 'var(--color-success)' },
    { label: '知识库', icon: BookOpen, path: '/knowledge', color: 'var(--color-danger)' },
    { label: '工作流', icon: Workflow, path: '/workflows', color: '#60a5fa' },
  ]},
  { label: 'AI', items: [
    { label: 'AI Studio', icon: Palette, path: '/media', color: '#a78bfa' },
    { label: '文档生成', icon: FileText, path: '/documents', color: 'var(--color-success)' },
    { label: '项目管理', icon: FolderKanban, path: '/projects', color: 'var(--color-danger)' },
  ]},
  { label: '资源', items: [
    { label: '媒体库', icon: Database, path: '/library', color: '#60a5fa' },
    { label: '密码库', icon: KeyRound, path: '/vault', color: 'var(--color-warning)' },
    { label: '浏览器', icon: Globe, path: '/browser', color: 'var(--color-accent)' },
  ]},
  { label: '系统', items: [
    { label: '系统监控', icon: Activity, path: '/monitoring', color: 'var(--color-accent)' },
    { label: 'AI 自检', icon: Shield, path: '/selfcheck', color: '#a78bfa' },
  ]},
];

export function GeneralSettings({
  port,
  setPort,
  allowedDirs,
  setAllowedDirs,
  defaultDir,
  setDefaultDir,
  newDir,
  setNewDir,
  filePickerRef,
  handleFileChange,
  handleAddDir,
  handleRemoveDir,
  handleSetDefault,
  uiMode,
  navigate,
}: GeneralSettingsProps) {
  return (
    <>
      <div className="glass-card">
        <h2 style={{ fontSize: 'var(--font-module-title)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20 }}>General</h2>
        <div className="space-y-5">
          <div>
            <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>Port</label>
            <input className="input" type="number" min={1} max={65535} value={port} onChange={e => {
              const raw = parseInt(e.target.value, 10);
              if (Number.isFinite(raw)) setPort(Math.min(65535, Math.max(1, raw)));
            }} />
          </div>
          <div>
            <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>可访问目录 (Allowed Dirs)</label>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)', marginBottom: 10 }}>
              Agent 和 AI 工作流只能在这些目录内读写文件。添加后立即生效。
            </p>
            <div className="space-y-2">
              {allowedDirs.map(dir => (
                <div key={dir} className="flex items-center gap-2 p-2 rounded-lg"
                  style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }}>
                  <FolderOpen size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                  <span className="flex-1 text-sm font-mono break-all" style={{ color: 'var(--text-primary)' }}>{dir}</span>
                  <button className="btn btn-ghost flex-shrink-0" onClick={() => handleSetDefault(dir)} title="设为默认工作目录"
                    style={{ color: defaultDir === dir ? 'var(--color-warning)' : 'var(--text-tertiary)' }}>
                    <Star size={15} fill={defaultDir === dir ? 'var(--color-warning)' : 'none'} />
                  </button>
                  <button className="btn btn-ghost flex-shrink-0" onClick={() => handleRemoveDir(dir)} title="删除该目录">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              {allowedDirs.length === 0 && (
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                  未配置可访问目录，AI 无法读写文件。请添加一个目录（如 D:\workspace）
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <input className="input" type="text" placeholder="输入目录路径，如 D:\projects"
                value={newDir}
                onChange={e => setNewDir(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) handleAddDir(); }} />
              <input ref={(el) => { filePickerRef.current = el; if (el) el.webkitdirectory = true; }}
                type="file" className="hidden" onChange={handleFileChange} />
              <button className="btn btn-secondary flex-shrink-0" onClick={() => filePickerRef.current?.click()}>
                <FolderOpen size={18} /> 浏览
              </button>
              <button className="btn btn-primary flex-shrink-0" onClick={handleAddDir}>
                <Plus size={18} /> 添加
              </button>
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>
              ① 直接输入路径（如 D:\projects）→ 点击「添加」  ② 或点击「浏览」选文件夹 → 再点击「添加」
            </p>
          </div>
        </div>
      </div>

      {/* Coding 模式：功能导航 */}
      {uiMode === 'coding' && (
        <div className="glass-card" style={{ padding: '24px', marginTop: 24 }}>
          <div className="flex items-center gap-3">
            <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(94,158,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Compass size={18} style={{ color: 'var(--color-accent)' }} />
            </div>
            <div>
              <h2 style={{ fontSize: 'var(--font-module-title)', fontWeight: 600, color: 'var(--text-primary)' }}>功能导航</h2>
              <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: 2 }}>Coding 模式下未在侧边栏展示的功能，点击卡片快速进入</p>
            </div>
          </div>
          <div className="space-y-5" style={{ marginTop: 20 }}>
            {featureGroups.map(group => (
              <div key={group.label}>
                <div className="flex items-center gap-2 mb-3">
                  <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{group.label}</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--border-primary)' }} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {group.items.map(item => {
                    const Icon = item.icon;
                    return (
                      <button key={item.label} onClick={() => navigate(item.path)}
                        className="glass-card"
                        style={{
                          padding: '14px 16px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          cursor: 'pointer',
                          border: '1px solid var(--card-border)',
                          borderRadius: 12,
                          textAlign: 'left',
                          transition: 'transform 0.15s ease, border-color 0.15s ease',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = item.color; }}
                        onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = 'var(--card-border)'; }}>
                        <span style={{ width: 32, height: 32, borderRadius: 9, background: `${item.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Icon size={16} style={{ color: item.color }} />
                        </span>
                        <span className="truncate text-sm" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}