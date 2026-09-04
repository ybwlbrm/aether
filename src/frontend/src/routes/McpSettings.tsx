import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { api } from '../api/client';
import { Server, Plus, Trash2, Play, Power, PowerOff, ExternalLink, Terminal, Download, BookOpen, CheckCircle2, XCircle, Eye } from 'lucide-react';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';
import { useAutosaveDraft } from '../hooks/useAutosaveDraft';
import { useSafeTimeout } from '../hooks/useSafeTimeout';

export function McpSettings() {
  const safeTimeout = useSafeTimeout();
  const [servers, setServers] = useState<any[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // 审计修复：加载错误状态（替代静默 catch(() => {})）
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [saving, setSaving] = useState(false); // P1-15：保存防连点
  const [testResult, setTestResult] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [activeTab, setActiveTab] = useState<'mcp' | 'skills'>('mcp');
  // P1-1 修复：接入 useAutosaveDraft，意外刷新时恢复输入
  const [form, setForm, clearFormDraft] = useAutosaveDraft('mcp_form_draft', {
    name: '', type: 'local' as 'local' | 'remote',
    command: '', cwd: '', environment: '',
    url: '', enabled: true, timeout: 5000, headers: '',
    visionApiKey: '', visionBaseUrl: '', visionModel: '',
  });

  const load = () => {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      api.getMcpServers().then(setServers).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'MCP 服务器加载失败')),
      api.getSkills().then(setSkills).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : '技能列表加载失败')),
    ]).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const resetForm = () => {
    setForm({ name: '', type: 'local', command: '', cwd: '', environment: '', url: '', enabled: true, timeout: 5000, headers: '', visionApiKey: '', visionBaseUrl: '', visionModel: '' });
    clearFormDraft();
    setEditing(null);
    setShowForm(false);
    setTestResult(null);
  };

  const openEdit = (s: any) => {
    // 从环境变量中解析视觉配置（如存在）
    let vision: Record<string, string> = {};
    if (s.environment) {
      try {
        const env = JSON.parse(s.environment);
        vision = {
          visionApiKey: env.NUPHUS_MCP_VISION_API_KEY || '',
          visionBaseUrl: env.NUPHUS_MCP_VISION_BASE_URL || '',
          visionModel: env.NUPHUS_MCP_VISION_MODEL || '',
        };
      } catch (_e: unknown) { console.warn("[SilentCatch]", _e); }
    }
    setForm({
      name: s.name, type: s.type,
      command: s.command ? (() => { try { return JSON.parse(s.command).join(' '); } catch { return s.command; } })() : '',
      cwd: s.cwd || '', environment: s.environment ? (() => { try { return Object.entries(JSON.parse(s.environment)).map(([k,v]) => `${k}=${v}`).join('\n'); } catch { return s.environment; } })() : '',
      url: s.url || '', enabled: s.enabled, timeout: s.timeout || 5000, headers: s.headers ? (() => { try { return JSON.stringify(JSON.parse(s.headers), null, 2); } catch { return s.headers; } })() : '',
      visionApiKey: vision.visionApiKey, visionBaseUrl: vision.visionBaseUrl, visionModel: vision.visionModel,
    });
    setEditing(s);
    setShowForm(true);
    setTestResult(null);
  };

  const handleSave = async () => {
    if (saving) return; // P1-15 修复：防连点
    // P1-15：表单必填校验
    if (!form.name.trim()) { alert('请输入服务器名称'); return; }
    if (form.type === 'local' && !form.command.trim()) { alert('本地类型需配置启动命令'); return; }
    if (form.type === 'remote' && !form.url.trim()) { alert('远程类型需配置 URL'); return; }
    setSaving(true);
    const data: any = {
      name: form.name, type: form.type, enabled: form.enabled, timeout: form.timeout || 5000,
    };
    if (form.type === 'local') {
      data.command = form.command.split(/\s+/).filter(Boolean);
      data.cwd = form.cwd || undefined;
      // 合并通用环境变量 + 视觉配置
      const env: Record<string, string> = {};
      if (form.environment.trim()) {
        form.environment.split('\n').filter(Boolean).forEach(line => {
          const eqIdx = line.indexOf('=');
          if (eqIdx > 0) env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
        });
      }
      // 视觉专用字段（非空则覆盖）
      if (form.visionApiKey.trim()) env.NUPHUS_MCP_VISION_API_KEY = form.visionApiKey.trim();
      if (form.visionBaseUrl.trim()) env.NUPHUS_MCP_VISION_BASE_URL = form.visionBaseUrl.trim();
      if (form.visionModel.trim()) env.NUPHUS_MCP_VISION_MODEL = form.visionModel.trim();
      data.environment = env;
    } else {
      data.url = form.url;
      if (form.headers.trim()) {
        try { data.headers = JSON.parse(form.headers); } catch { data.headers = form.headers; }
      }
    }
    try {
      if (editing) { await api.updateMcpServer(editing.id, data); }
      else { await api.createMcpServer(data); }
      resetForm();
      load();
    } catch (e: unknown) { alert('保存失败: ' + (e instanceof Error ? e.message : String(e))); }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog('确定删除此 MCP 服务器？'))) return;
    try { await api.deleteMcpServer(id); load(); } catch (e: unknown) { alert('删除失败: ' + (e instanceof Error ? e.message : String(e))); }
  };

  const handleToggle = async (s: any) => {
    try { await api.updateMcpServer(s.id, { enabled: !s.enabled }); load(); } catch (e: unknown) { alert('更新失败: ' + (e instanceof Error ? e.message : String(e))); }
  };

  const handleTest = async (id: string) => {
    setTestResult('测试中...');
    try {
      const res = await api.testMcpServer(id);
      setTestResult(res.success ? `✅ ${res.message}` : `❌ ${res.message}`);
    } catch (e: unknown) { setTestResult(`❌ ${(e instanceof Error ? e.message : String(e))}`); }
    safeTimeout(() => setTestResult(null), 5000);
  };

  const handleImport = async () => {
    setImporting(true);
    setImportResult(null);
    try {
      const res = await (await fetch('/api/mcp/import', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } })).json();
      const msg = `✅ 导入成功: ${res.imported?.join(', ') || '无'}` + (res.errors?.length ? `\n❌ 错误: ${res.errors.join(', ')}` : '');
      setImportResult(msg);
      load();
    } catch (e: unknown) { setImportResult(`❌ 导入失败: ${(e instanceof Error ? e.message : String(e))}`); }
    setImporting(false);
    safeTimeout(() => setImportResult(null), 8000);
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
        <PageHeader title="MCP & Skill 管理中心" description="管理 MCP 服务器与 Skill 技能" icon={<Server size={22} />} color="#8b5cf6"
          action={<div className="flex gap-2">
            <button className="btn btn-ghost" onClick={handleImport} disabled={importing}>
              <Download size={18} /> {importing ? '导入中...' : '从 OpenCode 导入'}
            </button>
            <button className="btn btn-primary" onClick={() => { resetForm(); setShowForm(true); }}><Plus size={18} /> 添加</button>
          </div>}
        />

        {importResult && (
          <div className="glass-card" style={{ padding: '12px 16px', marginBottom: 16, fontSize: 13, whiteSpace: 'pre-wrap' }}>
            {importResult}
          </div>
        )}

        {testResult && (
          <div className="glass-card" style={{ padding: '12px 16px', marginBottom: 16, fontSize: 13 }}>
            {testResult}
          </div>
        )}

        {/* Tab 切换 */}
        <div className="flex gap-1 mb-4" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          <button onClick={() => setActiveTab('mcp')} style={{
            padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            color: activeTab === 'mcp' ? '#8b5cf6' : 'var(--text-tertiary)',
            borderBottom: activeTab === 'mcp' ? '2px solid #8b5cf6' : '2px solid transparent',
            background: 'none',
          }}>MCP 服务器</button>
          <button onClick={() => setActiveTab('skills')} style={{
            padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            color: activeTab === 'skills' ? '#8b5cf6' : 'var(--text-tertiary)',
            borderBottom: activeTab === 'skills' ? '2px solid #8b5cf6' : '2px solid transparent',
            background: 'none',
          }}>Skill 技能</button>
        </div>

        {showForm && activeTab === 'mcp' && (
          <div className="glass-card" style={{ padding: 24, marginBottom: 24 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>{editing ? '编辑 MCP 服务器' : '添加 MCP 服务器'}</h3>
            <div className="grid grid-cols-2 gap-4" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>名称</label>
                <input className="input w-full" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="如 nuphus-mcp" />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>类型</label>
                <select className="input w-full" value={form.type} onChange={e => setForm({ ...form, type: e.target.value as any })}>
                  <option value="local">Local（本地进程）</option>
                  <option value="remote">Remote（HTTP/S）</option>
                </select>
              </div>
              {form.type === 'local' ? (
                <>
                  <div className="col-span-2" style={{ gridColumn: 'span 2' }}>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>命令（空格分隔）</label>
                    <input className="input w-full" value={form.command} onChange={e => setForm({ ...form, command: e.target.value })} placeholder="node D:/app/mcp-server/index.js" />
                  </div>
                  <div><label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>工作目录</label>
                    <input className="input w-full" value={form.cwd} onChange={e => setForm({ ...form, cwd: e.target.value })} placeholder="可选" /></div>
                  <div><label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>超时 (ms)</label>
                    <input className="input w-full" type="number" value={form.timeout} onChange={e => setForm({ ...form, timeout: Number(e.target.value) })} /></div>
                  <div className="col-span-2" style={{ gridColumn: 'span 2' }}>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>环境变量（每行 KEY=VALUE）</label>
                    <textarea className="input w-full" rows={3} value={form.environment} onChange={e => setForm({ ...form, environment: e.target.value })} placeholder="KEY=VALUE" /></div>
                  {/* 视觉模型 API 专用配置 */}
                  <div className="col-span-2" style={{ gridColumn: 'span 2', padding: 16, borderRadius: 12, background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.2)' }}>
                    <div className="flex items-center gap-2 mb-2" style={{ fontSize: 13, fontWeight: 600, color: '#8b5cf6' }}>
                      <Eye size={14} /> 视觉模型 API（nuphus-mcp 屏幕识别用）
                    </div>
                    <div className="grid grid-cols-3 gap-3" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                      <div>
                        <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 3, display: 'block' }}>VISION API Key</label>
                        <input className="input w-full" type="password" value={form.visionApiKey}
                          onChange={e => setForm({ ...form, visionApiKey: e.target.value })}
                          placeholder="sk-..." />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 3, display: 'block' }}>VISION Base URL</label>
                        <input className="input w-full" value={form.visionBaseUrl}
                          onChange={e => setForm({ ...form, visionBaseUrl: e.target.value })}
                          placeholder="https://apihub.agnes-ai.com/v1" />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 3, display: 'block' }}>VISION Model</label>
                        <input className="input w-full" value={form.visionModel}
                          onChange={e => setForm({ ...form, visionModel: e.target.value })}
                          placeholder="agnes-2.5-flash" />
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="col-span-2" style={{ gridColumn: 'span 2' }}>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>URL</label>
                    <input className="input w-full" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/mcp" /></div>
                  <div className="col-span-2" style={{ gridColumn: 'span 2' }}>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Headers（JSON）</label>
                    <textarea className="input w-full" rows={3} value={form.headers} onChange={e => setForm({ ...form, headers: e.target.value })} placeholder='{"Authorization": "Bearer xxx"}' /></div>
                </>
              )}
            </div>
            <div className="flex gap-2 mt-4">
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? '保存中...' : (editing ? '保存' : '创建')}</button>
              <button className="btn btn-ghost" onClick={resetForm}>取消</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12"><div className="spinner" /></div>
        ) : loadError ? (
          <div className="glass-card flex flex-col items-center justify-center py-12">
            <div style={{ color: 'var(--color-danger)', marginBottom: 8 }}>⚠️ {loadError}</div>
            <button className="btn btn-ghost" onClick={() => load()} style={{ fontSize: '13px' }}>重试</button>
          </div>
        ) : activeTab === 'mcp' ? (
          servers.length === 0 ? (
            <div className="glass-card flex items-center justify-center py-12" style={{ color: 'var(--text-tertiary)' }}>
              <div className="text-center">
                <Server size={40} style={{ opacity: 0.3, margin: '0 auto 8px' }} />
                <div>暂无 MCP 服务器配置</div>
                <div style={{ fontSize: 12 }}>点击「从 OpenCode 导入」一键添加，或手动添加</div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {servers.map(s => (
                <div key={s.id} className="glass-card" style={{ padding: '16px 20px' }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div style={{ width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: s.enabled ? 'rgba(139,92,246,0.15)' : 'rgba(100,100,100,0.1)',
                        color: s.enabled ? '#8b5cf6' : 'var(--text-tertiary)' }}>
                        {s.type === 'local' ? <Terminal size={18} /> : <ExternalLink size={18} />}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                          {s.type === 'local'
                            ? (s.command ? (() => { try { return JSON.parse(s.command).join(' '); } catch { return s.command; } })() : '未配置')
                            : s.url}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="btn btn-ghost" style={{ width: 32, height: 32, padding: 0 }} onClick={() => handleTest(s.id)} title="测试连接"><Play size={14} /></button>
                      {s.name === 'nuphus-mcp' && (
                        <button className="btn btn-ghost" style={{ width: 32, height: 32, padding: 0, color: '#8b5cf6' }} onClick={() => openEdit(s)} title="配置视觉模型 API"><Eye size={14} /></button>
                      )}
                      <button className="btn btn-ghost" style={{ width: 32, height: 32, padding: 0 }} onClick={() => openEdit(s)} title="编辑"><Server size={14} /></button>
                      <button className="btn btn-ghost" style={{ width: 32, height: 32, padding: 0, color: s.enabled ? 'var(--color-success)' : 'var(--text-tertiary)' }} onClick={() => handleToggle(s)} title={s.enabled ? '禁用' : '启用'}>
                        {s.enabled ? <Power size={14} /> : <PowerOff size={14} />}</button>
                      <button className="btn btn-ghost" style={{ width: 32, height: 32, padding: 0, color: '#ef4444' }} onClick={() => handleDelete(s.id)} title="删除"><Trash2 size={14} /></button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          /* Skills 面板 */
          <div className="space-y-3">
            <div className="glass-card" style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-tertiary)' }}>
              扫描自: ~/.config/opencode/skills/、~/.codex/skills/、项目 skills/（来源为 skills 的本地技能可删除）
            </div>
            {skills.length === 0 ? (
              <div className="glass-card flex items-center justify-center py-12" style={{ color: 'var(--text-tertiary)' }}>
                <div className="text-center">
                  <BookOpen size={40} style={{ opacity: 0.3, margin: '0 auto 8px' }} />
                  <div>未找到 Skill 技能</div>
                  <div style={{ fontSize: 12 }}>请先在 OpenCode 或 Codex 中安装技能</div>
                </div>
              </div>
            ) : skills.map((skill, i) => (
              <div key={i} className="glass-card" style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div className="flex items-center gap-3" style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(139,92,246,0.12)', color: '#8b5cf6' }}>
                    <BookOpen size={16} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{skill.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{skill.description || skill.name}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2" style={{ fontSize: 11, flexShrink: 0 }}>
                  <span style={{ background: 'rgba(52,211,153,0.12)', color: 'var(--color-success)', padding: '2px 8px', borderRadius: 4 }}>
                    {skill.source}
                  </span>
                  {skill.hasYaml && <span style={{ background: 'rgba(59,130,246,0.12)', color: '#3b82f6', padding: '2px 8px', borderRadius: 4 }}>UI</span>}
                  <button className="btn btn-ghost" style={{ width: 30, height: 30, padding: 0, color: '#ef4444' }} title="删除此技能"
                    onClick={async () => {
                      if (!(await confirmDialog(`确定删除技能 "${skill.name}"？\n删除位置: ${skill.path}\n此操作不可恢复！`))) return;
                      try {
                        await api.deleteSkill(skill.name);
                        load();
                      } catch (e: unknown) { alert('删除失败: ' + (e instanceof Error ? e.message : String(e))); }
                    }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}