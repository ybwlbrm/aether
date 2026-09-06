import { useState, useRef } from 'react';
import { Download, Upload } from 'lucide-react';
import { confirm as confirmDialog } from '../../components/ui/confirm-dialog';
import { api } from '../../api/client';

// P2-3: 从 Settings.tsx 拆分出的数据管理组件
export function DataManage() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 收集 localStorage 数据（vault 密码库不导出，安全考虑）
  const collectLocalStorage = () => {
    let syncConfig: { supabaseUrl: string; connected: boolean } | null = null;
    try {
      const raw = localStorage.getItem('syncConfig');
      if (raw) {
        const c = JSON.parse(raw);
        syncConfig = { supabaseUrl: c.supabaseUrl || '', connected: !!c.connected }; // 不含 key
      }
    } catch (_e: unknown) { /* ignore - intentional */ }
    return {
      knowledge_bookmarks: JSON.parse(localStorage.getItem('knowledge_bookmarks') || '[]'),
      knowledge_notes: JSON.parse(localStorage.getItem('knowledge_notes') || '[]'),
      knowledge_wiki: JSON.parse(localStorage.getItem('knowledge_wiki') || '[]'),
      chat_conversations: JSON.parse(localStorage.getItem('chat_conversations') || '[]'),
      search_history: JSON.parse(localStorage.getItem('search_history') || '[]'),
      uiTheme: localStorage.getItem('uiTheme') || 'liquid-glass',
      syncConfig,
    };
  };

  // 一键导出：合并 localStorage + 后端数据，下载为 JSON 备份文件
  const handleExport = async () => {
    setExporting(true); setMsg('');
    try {
      // 全量导出（Wave0-AM: 后端要求 Authorization token，走带 token 的 client）
      const backend = await api.exportAll();
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        frontend: collectLocalStorage(),
        backend,
      };
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pacc-backup-${dateStr}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg('✅ 导出成功');
    } catch (e: unknown) {
      setMsg('❌ 导出失败: ' + (e instanceof Error ? e.message : String(e)));
    }
    setExporting(false);
  };

  // 一键导入：解析备份文件，恢复 localStorage + 调用后端导入
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // P0 修复：导入会覆盖本地+后端全部数据（不可逆），必须先二次确认
    if (!(await confirmDialog('导入将覆盖当前所有数据（知识库、对话、Provider、项目、媒体、文档与设置）。\n此操作不可撤销，建议先导出备份。\n\n确定继续导入吗？'))) {
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      setImporting(true); setMsg('');
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!data || typeof data !== 'object') throw new Error('备份文件格式无效');
        // 恢复 localStorage 数据
        const f = data.frontend || {};
        if (f.knowledge_bookmarks !== undefined) localStorage.setItem('knowledge_bookmarks', JSON.stringify(f.knowledge_bookmarks));
        if (f.knowledge_notes !== undefined) localStorage.setItem('knowledge_notes', JSON.stringify(f.knowledge_notes));
        if (f.knowledge_wiki !== undefined) localStorage.setItem('knowledge_wiki', JSON.stringify(f.knowledge_wiki));
        if (f.chat_conversations !== undefined) localStorage.setItem('chat_conversations', JSON.stringify(f.chat_conversations));
        if (f.search_history !== undefined) localStorage.setItem('search_history', JSON.stringify(f.search_history));
        if (f.uiTheme) {
          localStorage.setItem('uiTheme', f.uiTheme);
          document.documentElement.setAttribute('data-theme', f.uiTheme === 'liquid-glass' ? 'dark' : f.uiTheme);
        }
        // P2-13 修复：导入时剥离 supabaseKey，防止旧备份文件重新引入明文 Key
        if (f.syncConfig && typeof f.syncConfig === 'object') {
          const { supabaseKey: _sk, ...safeConfig } = f.syncConfig;
          localStorage.setItem('syncConfig', JSON.stringify({ ...safeConfig, connected: !!f.syncConfig.connected }));
        }
        // 导入后端数据
        const res = await fetch('/api/import/all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify(data.backend || {}),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || `导入失败: ${res.status}`);
        }
        const result = await res.json();
        // 通知其他页面刷新数据
        localStorage.setItem('sync_data_updated', Date.now().toString());
        window.dispatchEvent(new CustomEvent('sync-data-changed', { detail: { time: Date.now() } }));
        const counts = result.importedCounts || {};
        setMsg(`✅ 导入成功（providers: ${counts.providers ?? 0}, projects: ${counts.projects ?? 0}, conversations: ${counts.conversations ?? 0}, media: ${counts.media ?? 0}, documents: ${counts.documents ?? 0}）`);
      } catch (e: unknown) {
        setMsg('❌ 导入失败: ' + (e instanceof Error ? e.message : String(e)));
      }
      setImporting(false);
      e.target.value = '';
    };
    reader.readAsText(file);
  };

  return (
    <div className="glass-card" style={{ padding: '24px' }}>
      <h2 style={{ fontSize: 'var(--font-module-title)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20 }}>
        <Download size={20} style={{ display: 'inline', marginRight: 8 }} />数据管理
      </h2>
      <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginBottom: 20 }}>
        一键导出 / 导入全部数据：知识库、对话、Provider 配置、项目、媒体、文档与设置。密码库（vault）不导出。
      </p>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary" onClick={handleExport} disabled={exporting}>
          <Download size={18} /> {exporting ? '导出中...' : '一键导出'}
        </button>
        <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImportFile} />
        <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()} disabled={importing}>
          <Upload size={18} /> {importing ? '导入中...' : '一键导入'}
        </button>
      </div>
      {msg && <p className="text-sm mt-3" style={{ color: msg.includes('✅') ? 'var(--color-success)' : msg.includes('❌') ? 'var(--color-danger)' : 'var(--text-secondary)' }}>{msg}</p>}
    </div>
  );
}
