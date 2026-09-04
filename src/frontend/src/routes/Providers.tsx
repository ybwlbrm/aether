import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api/client';
import { Plus, Trash2, RefreshCw, Bot, Cable, Check, CheckCircle2, Star, X, Eye, Copy, KeyRound, Calendar, Link2, Cpu, Tag } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';
import { useSafeTimeout } from '../hooks/useSafeTimeout';

export function Providers() {
  const safeTimeout = useSafeTimeout();
const [providers, setProviders] = useState<any[]>([]);
const [showForm, setShowForm] = useState(false);
const [creating, setCreating] = useState(false); // P1-15：创建防连点
const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; statusCode: number; statusText: string; message: string; quotaStatus?: string; bodyDetail?: string; rateLimit?: { remaining: string; limit: string; reset: string } } | null>(null);
  const [defaultProviders, setDefaultProviders] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ name: '', type: 'openai', apiKey: '', baseUrl: '', models: '', capabilities: [] as string[], isDefault: false });
  const [detail, setDetail] = useState<{ id: string; name: string; type: string; apiKey: string; apiKeyLength?: number; baseUrl: string | null; models: string[]; capabilities: string[]; isDefault: boolean; createdAt: string; updatedAt: string } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [plaintextApiKey, setPlaintextApiKey] = useState<string | null>(null);
  const [fetchingKey, setFetchingKey] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const capabilityOptions: { value: string; label: string }[] = [
    { value: 'text', label: '文本' },
    { value: 'image', label: '图片' },
    { value: 'video', label: '视频' },
    { value: 'audio', label: '音频' },
  ];
  const capabilityLabels: Record<string, string> = { text: '文本', image: '图片', video: '视频', audio: '音频' };

  const load = async () => {
    try {
      const data = await api.getProviders();
      setProviders(Array.isArray(data) ? data : []);
    } catch { setProviders([]); }
    try {
      const dp = await api.getDefaultProviders();
      setDefaultProviders(dp || {});
    } catch (_e: unknown) { /* ignore - intentional */ }
  };
  useEffect(() => { load(); }, []);

  const handleSetDefault = async (capability: string, providerId: string) => {
    try {
      const updated = { ...defaultProviders, [capability]: providerId };
      await api.setDefaultProviders({ [capability]: providerId });
      setDefaultProviders(updated);
    } catch (e: unknown) { alert('设置默认 Provider 失败: ' + (e instanceof Error ? e.message : String(e))); }
  };

  const handleCreate = async () => {
    if (creating) return; // P1-15 修复：防连点
    const models = form.models.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (!form.name.trim()) { alert('请输入 Provider 名称'); return; } // P1-15：表单必填校验
    if (!form.apiKey.trim()) { alert('请输入 API Key'); return; }
    setCreating(true);
    try {
      await api.createProvider({
        name: form.name,
        type: form.type,
        apiKey: form.apiKey,
        baseUrl: form.baseUrl || `https://api.${form.type}.com/v1`,
        models: models.length > 0 ? models : ['gpt-4o'],
        capabilities: form.capabilities.length > 0 ? form.capabilities : ['text'],
        isDefault: form.isDefault,
      });
      setShowForm(false);
      setForm({ name: '', type: 'openai', apiKey: '', baseUrl: '', models: '', capabilities: [], isDefault: false });
      load();
    } catch (e: unknown) { alert('创建失败: ' + (e instanceof Error ? e.message : String(e))); }
    setCreating(false);
  };

  const handleDelete = async (id: string) => {
    if (await confirmDialog('确定删除此 Provider？')) {
      try {
        await api.deleteProvider(id);
        load();
      } catch (e: unknown) { alert('删除失败: ' + (e instanceof Error ? e.message : String(e))); }
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult(null)
    try {
      const result = await api.testProvider(id);
      setTestResult({ id, ...result });
    } catch (e: unknown) {
      setTestResult({ id, statusCode: 0, statusText: '错误', message: (e instanceof Error ? e.message : String(e)), quotaStatus: '❌ 测试失败' });
    }
    setTestingId(null);
  };

  const handleViewDetail = async (id: string) => {
    setDetailLoading(true);
    setShowApiKey(false);
    setPlaintextApiKey(null);
    try {
      const data = await api.getProviderDetail(id);
      setDetail(data);
    } catch (e: unknown) {
      alert('加载详情失败: ' + (e instanceof Error ? e.message : String(e)));
    }
    setDetailLoading(false);
  };

  // P0-11: 按需获取明文 API Key — 不再长期持有明文
  const handleShowApiKey = async () => {
    if (!detail) return;
    if (showApiKey) { setShowApiKey(false); return; }
    if (plaintextApiKey) { setShowApiKey(true); return; }
    setFetchingKey(true);
    try {
      // P2-12 修复：改用 POST 请求（需 X-Requested-With CSRF header）获取明文 Key
      const res = await fetch(`/api/providers/${detail.id}/apikey`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      const data = await res.json();
      setPlaintextApiKey(data.apiKey || '');
      setShowApiKey(true);
    } catch (_e: unknown) { /* ignore - intentional */ }
    setFetchingKey(false);
  };

  // P0-11: 复制时也按需获取明文
  const handleCopyApiKey = async () => {
    if (!detail) return;
    let keyToCopy = plaintextApiKey;
    if (!keyToCopy) {
      const res = await fetch(`/api/providers/${detail.id}/apikey`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      keyToCopy = (await res.json()).apiKey || '';
    }
    if (keyToCopy) {
      navigator.clipboard.writeText(keyToCopy);
      setCopiedField('apiKey');
      safeTimeout(() => setCopiedField(null), 1500);
    }
  };

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    safeTimeout(() => setCopiedField(null), 1500);
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
        <PageHeader title="AI Providers" description="管理 AI 模型连接" icon={<Cable size={22} />} color="var(--color-accent)" action={<button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>{showForm ? <X size={18} /> : <Plus size={18} />}{showForm ? '关闭' : '添加 Provider'}</button>} />

        {showForm && (
          <motion.div className="glass-card mb-6" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <h2 style={{ fontSize: 'var(--font-module-title)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 24 }}>添加 AI Provider</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>名称</label>
                <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="例如: GPT-4" />
              </div>
              <div>
                <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>类型</label>
                <select className="input select" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                  <option value="openai">OpenAI</option><option value="anthropic">Anthropic Claude</option>
                  <option value="google">Google Gemini</option><option value="deepseek">DeepSeek</option>
                  <option value="openrouter">OpenRouter</option><option value="custom">自定义</option>
                </select>
              </div>
              <div>
                <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>API Key</label>
                <input className="input" type="password" value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} placeholder="sk-..." />
              </div>
              <div>
                <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>Base URL</label>
                <input className="input" value={form.baseUrl} onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))} placeholder="https://api.openai.com/v1" />
              </div>
              <div>
                <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>模型列表 (逗号分隔)</label>
                <input className="input" value={form.models} onChange={e => setForm(f => ({ ...f, models: e.target.value }))} placeholder="gpt-4, gpt-3.5-turbo" />
              </div>
              <div>
                <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>能力类型</label>
                <div className="flex flex-wrap gap-4">
                  {capabilityOptions.map(opt => (
                    <label key={opt.value} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        className="checkbox"
                        style={{ width: 16, height: 16, accentColor: 'var(--color-accent)' }}
                        checked={form.capabilities.includes(opt.value)}
                        onChange={e => setForm(f => ({
                          ...f,
                          capabilities: e.target.checked
                            ? [...f.capabilities, opt.value]
                            : f.capabilities.filter(v => v !== opt.value),
                        }))}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-8">
              <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>{creating ? '保存中...' : <><Check size={18} /> 保存</>}</button>
              <button className="btn btn-ghost" onClick={() => setShowForm(false)}>取消</button>
            </div>
          </motion.div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {providers.map((p, i) => (
            <motion.div key={p.id} className="glass-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-[14px] flex items-center justify-center flex-shrink-0" style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent)' }}>
                    <Bot size={20} />
                  </div>
<div className="min-w-0">
                        <h3 className="truncate" style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</h3>
                        <span className="badge badge-accent mt-1">{p.type || p.provider}</span>
                      </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button className="btn btn-ghost" style={{ width: 44, height: 44, padding: 0 }} onClick={() => handleViewDetail(p.id)} disabled={detailLoading} title="查看详情">
                    <Eye size={18} />
                  </button>
                  <button className="btn btn-ghost" style={{ width: 44, height: 44, padding: 0 }} onClick={() => handleTest(p.id)} disabled={testingId === p.id} title="测试连接">
                    <RefreshCw size={18} className={testingId === p.id ? 'animate-spin' : ''} />
                  </button>
                  <button className="btn btn-ghost" style={{ width: 44, height: 44, padding: 0, color: 'var(--color-danger)' }} onClick={() => handleDelete(p.id)} title="删除">
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-4">
                {(Array.isArray(p.capabilities) ? p.capabilities : ['text']).map((c: string) => (
                  <span key={c} className="badge badge-success">{capabilityLabels[c] || c}</span>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {(Array.isArray(p.models) ? p.models : [p.defaultModel || 'No model']).slice(0, 3).map((m: string) => (
                  <span key={m} className="tag">{m}</span>
                ))}
              </div>
            </motion.div>
          ))}
          {providers.length === 0 && (
            <div className="glass-card col-span-2 empty-state">
              <Bot size={40} className="empty-state-icon" />
              <div className="empty-state-title">还没有添加 AI Provider</div>
              <div className="empty-state-desc">点击右上角「添加 Provider」开始配置</div>
            </div>
          )}
        </div>

        {/* ===== 默认 Provider 设置 ===== */}
        {providers.length > 0 && (
          <div className="glass-card mt-8">
            <h3 style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>
              <Star size={18} className="inline mr-2" style={{ color: 'var(--color-warning)' }} />
              默认 Provider 设置
            </h3>
            <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-tertiary)', marginBottom: 16 }}>
              为每种能力类型选择默认的 Provider，AI Studio 将自动使用对应的默认 Provider
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {capabilityOptions.map(opt => (
                <div key={opt.value} className="settings-row" style={{ padding: '12px 16px' }}>
                  <div className="settings-row-info">
                    <div className="settings-row-label">{opt.label}</div>
                    <div className="settings-row-desc">默认 {opt.label} Provider</div>
                  </div>
                  <div className="settings-row-control">
                    <select
                      className="input select"
                      style={{ width: 240 }}
                      value={defaultProviders[opt.value] || ''}
                      onChange={e => handleSetDefault(opt.value, e.target.value)}
                    >
                      <option value="">未设置</option>
                      {providers.filter(p => (Array.isArray(p.capabilities) ? p.capabilities : ['text']).includes(opt.value)).map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ===== Provider 详情弹窗 ===== */}
        {detail && (
          <>
            <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md" onClick={() => { setDetail(null); setShowApiKey(false); setPlaintextApiKey(null); }} />
            <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center">
              <div className="glass-card pointer-events-auto" style={{ maxWidth: '520px', width: '100%', margin: '0 1rem', padding: '24px', maxHeight: '85vh', overflowY: 'auto' }}>
            <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-[14px] flex items-center justify-center flex-shrink-0" style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent)' }}>
                      <Bot size={20} />
                    </div>
                    <div>
                      <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>{detail.name}</h3>
                      <span className="badge badge-accent">{detail.type}</span>
                      {detail.isDefault && <span className="badge badge-warning ml-1">默认</span>}
                    </div>
                  </div>
                  <button className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-white/[0.06]" style={{ color: 'var(--text-tertiary)' }} onClick={() => { setDetail(null); setShowApiKey(false); setPlaintextApiKey(null); }}><X size={14} /></button>
                </div>

                <div className="space-y-3">
                  {/* API Key */}
                  <div className="rounded-lg p-3" style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.15)' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <KeyRound size={14} style={{ color: 'var(--color-warning)' }} />
                      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>API Key</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate" style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', background: 'var(--bg-surface)', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-primary)' }}>
                        {/* P0-11: 默认显示 masked key，仅在用户主动点击"显示"时按需获取明文 */}
                        {showApiKey && plaintextApiKey ? plaintextApiKey : detail.apiKey}
                      </code>
                      <button className="btn btn-ghost btn-sm" style={{ width: 32, height: 32, padding: 0 }} onClick={handleShowApiKey} disabled={fetchingKey} title={showApiKey ? '隐藏' : '显示'}>
                        {fetchingKey ? <div className="spinner spinner-sm" /> : <Eye size={14} style={{ opacity: showApiKey ? 1 : 0.5 }} />}
                      </button>
                      <button className="btn btn-ghost btn-sm" style={{ width: 32, height: 32, padding: 0, color: copiedField === 'apiKey' ? 'var(--color-success)' : 'var(--text-tertiary)' }} onClick={handleCopyApiKey} title="复制">
                        {copiedField === 'apiKey' ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                      </button>
                    </div>
                  </div>

                  {/* Base URL */}
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-primary)' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Link2 size={14} style={{ color: 'var(--text-tertiary)' }} />
                      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Base URL</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate" style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                        {detail.baseUrl || '(默认)'}
                      </code>
                      <button className="btn btn-ghost btn-sm" style={{ width: 28, height: 28, padding: 0, color: copiedField === 'baseUrl' ? 'var(--color-success)' : 'var(--text-tertiary)' }} onClick={() => copyToClipboard(detail.baseUrl || '', 'baseUrl')} title="复制">
                        {copiedField === 'baseUrl' ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                  </div>

                  {/* Models */}
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-primary)' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Cpu size={14} style={{ color: 'var(--text-tertiary)' }} />
                      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>模型列表 ({detail.models.length})</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {detail.models.map((m, i) => (
                        <span key={i} className="tag" style={{ fontSize: '11px' }}>{m}</span>
                      ))}
                    </div>
                  </div>

                  {/* Capabilities */}
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-primary)' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Tag size={14} style={{ color: 'var(--text-tertiary)' }} />
                      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>能力类型</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {detail.capabilities.map((c, i) => (
                        <span key={i} className="badge badge-success" style={{ fontSize: '11px' }}>{capabilityLabels[c] || c}</span>
                      ))}
                    </div>
                  </div>

                  {/* Timestamps */}
                  <div className="rounded-lg p-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-primary)' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Calendar size={14} style={{ color: 'var(--text-tertiary)' }} />
                      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>时间信息</span>
                    </div>
                    <div className="space-y-1" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                      <div>创建: {new Date(detail.createdAt).toLocaleString('zh-CN')}</div>
                      <div>更新: {new Date(detail.updatedAt).toLocaleString('zh-CN')}</div>
                    </div>
                  </div>
                </div>

                <button className="btn btn-primary w-full mt-5" onClick={() => { setDetail(null); setShowApiKey(false); setPlaintextApiKey(null); }}>关闭</button>
              </div>
            </div>
          </>
        )}

        {/* 测试结果弹窗 */}
        {testResult && (
          <>
            <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md" onClick={() => setTestResult(null)} />
            <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center">
              <div className="glass-card pointer-events-auto" style={{ maxWidth: '420px', width: '100%', margin: '0 1rem', padding: '24px' }}>
                <div className="flex items-center justify-between mb-4">
                  <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>测试结果</h3>
                  <button className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-white/[0.06]" style={{ color: 'var(--text-tertiary)' }} onClick={() => setTestResult(null)}><X size={14} /></button>
                </div>
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 rounded-lg" style={{ background: testResult.statusCode === 200 ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)' }}>
                    <span style={{ fontSize: 24, color: testResult.statusCode === 200 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                      {testResult.statusCode === 200 ? '✅' : '❌'}
                    </span>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
                        HTTP {testResult.statusCode} {testResult.statusText}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: 2 }}>{testResult.message}</div>
                    </div>
                  </div>
                  {testResult.quotaStatus && (
                    <div className="p-3 rounded-lg" style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.2)' }}>
                      <div style={{ fontSize: '13px', color: testResult.quotaStatus.includes('❌') ? 'var(--color-danger)' : testResult.quotaStatus.includes('⚠️') ? 'var(--color-warning)' : 'var(--color-success)' }}>
                        {testResult.quotaStatus}
                      </div>
                    </div>
                  )}
                  {testResult.rateLimit && testResult.rateLimit.remaining !== '未知' && (
                    <div className="flex justify-between text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      <span>剩余额度: <strong>{testResult.rateLimit.remaining}</strong> / {testResult.rateLimit.limit}</span>
                      <span>重置: {testResult.rateLimit.reset}</span>
                    </div>
                  )}
                  {testResult.bodyDetail && (
                    <div className="p-3 rounded-lg" style={{ background: 'var(--bg-surface)' }}>
                      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: 4 }}>详细信息:</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{testResult.bodyDetail}</div>
                    </div>
                  )}
                </div>
                <button className="btn btn-primary w-full mt-4" onClick={() => setTestResult(null)}>关闭</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
