import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api/client';
import { Bot, Save, CheckCircle2, Wrench, Brain, Clock, Search, FileText, Database, GitBranch } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { useSafeTimeout } from '../hooks/useSafeTimeout';
import { promptDialog } from '../components/ui/confirm-dialog';

interface AgentItem {
  id: string;
  name: string;
  icon: string;
  role: string;
  description: string;
  capabilities: string[];
  config: { providerId: string; model: string } | null;
}

interface ProviderItem {
  id: string;
  name: string;
  type: string;
  models: string[];
  capabilities: string[];
}

export function AgentSettings() {
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [configs, setConfigs] = useState<Record<string, { providerId: string; model: string }>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  // 审计修复：安全 setTimeout，组件卸载时自动清理
  const safeTimeout = useSafeTimeout();

  const load = async () => {
    try {
      const data = await api.getAgentConfigs();
      setAgents(data.agents || []);
      setProviders(data.providers || []);
      // 初始化配置状态
      const initial: Record<string, { providerId: string; model: string }> = {};
      for (const agent of data.agents || []) {
        if (agent.config) {
          initial[agent.id] = { providerId: agent.config.providerId, model: agent.config.model };
        } else if (data.providers?.length > 0) {
          const first = data.providers[0];
          initial[agent.id] = { providerId: first.id, model: first.models[0] || '' };
        }
      }
      setConfigs(initial);
    } catch (e: unknown) {
      console.error('加载失败', e);
    }
  };

  useEffect(() => { load(); }, []);

  const getModelsForProvider = (providerId: string): string[] => {
    const p = providers.find(p => p.id === providerId);
    return p?.models || [];
  };

  const handleSave = async () => {
    setSaving(true);
    setMsg('');
    let success = 0;
    let fail = 0;
    for (const [agentId, cfg] of Object.entries(configs)) {
      try {
        await api.updateAgentConfig(agentId, cfg);
        success++;
      } catch {
        fail++;
      }
    }
    if (fail === 0) {
      setMsg(`✅ 已保存 ${success} 个 Agent 配置`);
    } else {
      setMsg(`⚠️ 成功 ${success}，失败 ${fail}`);
    }
    setSaving(false);
    safeTimeout(() => setMsg(''), 3000);
  };

  const textProviders = providers.filter(p =>
    p.capabilities.includes('text') || p.capabilities.length === 0
  );

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
        <PageHeader title="Agent 设置" description="为每个 Agent 配置使用的 AI 模型" icon={<Bot size={22} />} color="#a78bfa" />

        <div className="glass-card" style={{ padding: '24px' }}>
          <div className="flex items-center justify-between mb-6">
            <h2 style={{ fontSize: 'var(--font-module-title)', fontWeight: 600, color: 'var(--text-primary)' }}>
              模型配置
            </h2>
            <div className="flex items-center gap-3">
              {msg && (
                <span className="text-sm" style={{ color: msg.includes('✅') ? 'var(--color-success)' : 'var(--color-danger)' }}>
                  {msg}
                </span>
              )}
              <button className="btn btn-primary" onClick={handleSave} disabled={saving || Object.keys(configs).length === 0}>
                <Save size={18} /> {saving ? '保存中...' : '保存全部'}
              </button>
            </div>
          </div>

          {textProviders.length === 0 && (
            <div className="empty-state" style={{ padding: '40px 0' }}>
              <Bot size={40} className="empty-state-icon" />
              <div className="empty-state-title">暂无可用 Provider</div>
              <div className="empty-state-desc">请先在「AI Providers」中添加至少一个支持文本的 Provider</div>
            </div>
          )}

          <div className="space-y-3">
            {agents.map((agent, i) => {
              const cfg = configs[agent.id];
              if (!cfg) return null;
              const availableModels = getModelsForProvider(cfg.providerId);
              return (
                <motion.div
                  key={agent.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="rounded-[14px]"
                  style={{
                    padding: '16px',
                    background: 'var(--card-bg)',
                    border: '1px solid var(--card-border)',
                  }}
                >
                  <div className="flex items-start gap-4">
                    {/* Agent 图标和信息 */}
                    <div className="flex items-center justify-center flex-shrink-0"
                      style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(167,139,250,0.12)', fontSize: 20 }}>
                      {agent.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>{agent.name}</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', background: 'var(--bg-surface)', padding: '2px 8px', borderRadius: 6 }}>
                          {agent.role}
                        </span>
                      </div>
                      <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: 12, lineHeight: 1.5 }}>{agent.description}</p>
                      {/* 配置选择器 */}
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-2">
                          <label style={{ fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Provider:</label>
                          <select
                            className="input select"
                            value={cfg.providerId}
                            onChange={e => {
                              const newPid = e.target.value;
                              const newModels = getModelsForProvider(newPid);
                              setConfigs(prev => ({
                                ...prev,
                                [agent.id]: {
                                  providerId: newPid,
                                  model: newModels[0] || prev[agent.id]?.model || '',
                                },
                              }));
                            }}
                            style={{ minWidth: 160, fontSize: '13px' }}
                          >
                            {textProviders.map(p => (
                              <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                            ))}
                          </select>
                        </div>
                        <div className="flex items-center gap-2">
                          <label style={{ fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Model:</label>
                          <select
                            className="input select"
                            value={cfg.model}
                            onChange={e => setConfigs(prev => ({ ...prev, [agent.id]: { ...prev[agent.id], model: e.target.value } }))}
                            style={{ minWidth: 180, fontSize: '13px' }}
                          >
                            {availableModels.length > 0 ? availableModels.map(m => (
                              <option key={m} value={m}>{m}</option>
                            )) : (
                              <option value="">(无可用模型)</option>
                            )}
                          </select>
                        </div>
                        {cfg.model && availableModels.includes(cfg.model) && (
                          <CheckCircle2 size={16} style={{ color: 'var(--color-success)' }} />
                        )}
                        {/* 提示词管理：查看/编辑系统提示词 */}
                        <button
                          onClick={async () => {
                            try {
                              const res = await api.getAgentPrompt(agent.id);
                              const newPrompt = await promptDialog({
                                title: `编辑 ${agent.name} 系统提示词`,
                                message: '修改后点击保存即可生效（运行时更新，重启后恢复默认）',
                                defaultValue: res.systemPrompt,
                                confirmText: '保存',
                              });
                              if (newPrompt !== null && newPrompt.trim()) {
                                await api.updateAgentPrompt(agent.id, newPrompt.trim());
                                setMsg(`✅ ${agent.name} 提示词已更新`);
                              }
                            } catch (e: unknown) {
                              setMsg(`❌ 提示词更新失败: ${e instanceof Error ? e.message : String(e)}`);
                            }
                          }}
                          style={{ fontSize: 12, padding: '4px 10px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                          title="查看/编辑系统提示词"
                        >
                          📝 提示词
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Agent 能力包总览 */}
        <div className="glass-card" style={{ padding: '24px', marginTop: 20 }}>
          <div className="flex items-center gap-3 mb-6">
            <div className="flex items-center justify-center flex-shrink-0" style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(94,158,255,0.12)' }}>
              <Wrench size={18} style={{ color: 'var(--color-accent)' }} />
            </div>
            <div>
              <h3 style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>Agent 能力包</h3>
              <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: 2 }}>Agent 在执行任务时可按需调用的工具包</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[
              { name: '搜索包', desc: '聚合搜索、网页抓取、本地文件检索', icon: <Search size={18} />, color: 'var(--color-success)', enabled: true },
              { name: '文件包', desc: '读写、编辑、移动本地文件', icon: <FileText size={18} />, color: 'var(--color-accent)', enabled: true },
              { name: '知识包', desc: '收藏夹、备忘录、Wiki 知识库访问', icon: <Database size={18} />, color: '#a78bfa', enabled: true },
              { name: '记忆包', desc: '长期记忆读写、会话上下文', icon: <Brain size={18} />, color: 'var(--color-warning)', enabled: true },
              { name: '工具箱', desc: '格式转换、PDF、图片处理', icon: <Wrench size={18} />, color: 'var(--color-danger)', enabled: true },
              { name: '定时任务', desc: 'Cron 定时触发 Agent 任务（开发中，暂不可用）', icon: <Clock size={18} />, color: '#60a5fa', enabled: false },
              { name: 'MCP 工具', desc: '接入外部 MCP 服务器工具', icon: <GitBranch size={18} />, color: '#94a3b8', enabled: true },
            ].map((pack, i) => (
              <motion.div
                key={pack.name}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                className="rounded-[14px] p-4"
                style={{
                  background: 'var(--bg-surface)',
                  border: `1px solid ${pack.enabled ? `${pack.color}25` : 'var(--border-primary)'}`,
                  opacity: pack.enabled ? 1 : 0.55,
                }}
              >
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center flex-shrink-0" style={{ width: 34, height: 34, borderRadius: 10, background: `${pack.color}15` }}>
                    <span style={{ color: pack.color }}>{pack.icon}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{pack.name}</span>
                      {pack.enabled ? (
                        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(52,211,153,0.12)', color: 'var(--color-success)' }}>可用</span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-surface)', color: 'var(--text-tertiary)' }}>即将推出</span>
                      )}
                    </div>
                    <p className="truncate" style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: 2 }}>{pack.desc}</p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}