import { useEffect, useState, useRef } from 'react';
import { PageHeader } from '../components/PageHeader';
import { api } from '../api/client';
import { Activity, Cpu, MemoryStick, Network, Bot, Coins, RefreshCw } from 'lucide-react';

export function Monitoring() {
  const [system, setSystem] = useState<any>(null);
  const [models, setModels] = useState<any[]>([]);
  const [agents, setAgents] = useState<any>(null);
  const [tokens, setTokens] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(() => {
    // 持久化自动刷新状态，切换页面回来不重置
    try { return localStorage.getItem('monitorAutoRefresh') !== 'false'; } catch { return true; }
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // P1 修复：竞态守卫 — 轮询与手动刷新并发时，旧请求返回不再覆盖新数据
  const loadSeqRef = useRef(0);

  const load = async (showLoading = false) => {
    const seq = ++loadSeqRef.current;
    if (showLoading) setLoading(true);
    try {
      const [sys, mods, ag, tok] = await Promise.all([
        api.getSystemStats(), api.getModelHealth(), api.getAgentStats(), api.getTokenStats(),
      ]);
      // 仅当仍是最新请求时才写入（旧响应直接丢弃）
      if (seq !== loadSeqRef.current) return;
      if (sys) setSystem(sys);
      if (Array.isArray(mods)) setModels(mods);
      if (ag) setAgents(ag);
      if (tok) setTokens(tok);
    } catch (_e: unknown) { console.warn("[SilentCatch]", _e); }
    if (showLoading && seq === loadSeqRef.current) setLoading(false);
  };

  useEffect(() => {
    load(true);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // 自动轮询：每 5 秒刷新
  useEffect(() => {
    try { localStorage.setItem('monitorAutoRefresh', String(autoRefresh)); } catch (_e: unknown) { console.warn("[SilentCatch]", _e); }
    if (autoRefresh) {
      timerRef.current = setInterval(() => load(false), 5000);
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [autoRefresh]);

  const StatCard = ({ icon, label, value, sub, color }: { icon: any; label: string; value: string; sub?: string; color?: string }) => (
    <div className="glass-card" style={{ padding: '16px 20px', flex: 1, minWidth: 180 }}>
      <div className="flex items-center gap-3 mb-2">
        <div style={{
          width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: (color || 'var(--color-accent)') + '15',
          color: color || 'var(--color-accent)',
        }}>
          {icon}
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{sub}</div>}
    </div>
  );

  const statusColor = (status: string) => {
    switch (status) {
      case 'ok': return 'var(--color-success)';
      case 'quota_low': return '#f59e0b';
      case 'error': return '#ef4444';
      default: return 'var(--text-tertiary)';
    }
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
        <PageHeader title="系统监控" description="实时监控系统资源、模型健康与 Token 消耗（每 5 秒自动刷新）" icon={<Activity size={22} />} color="#10b981"
          action={<div className="flex gap-2">
            <button className="btn btn-ghost" onClick={() => setAutoRefresh(!autoRefresh)}>
              {autoRefresh ? '⏸ 暂停' : '▶ 自动刷新'}
            </button>
            <button className="btn btn-primary" onClick={() => load(true)} disabled={loading}><RefreshCw size={18} /> 刷新</button>
          </div>}
        />

        {loading ? (
          <div className="flex items-center justify-center py-12"><div className="spinner" /></div>
        ) : (
          <>
            {/* 系统资源 */}
            <h3 className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 600, margin: '16px 0 12px' }}>
              <Cpu size={16} /> 系统资源
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {system && <>
                <StatCard icon={<Cpu size={16} />} label="CPU 使用率" value={`${system.cpu?.usagePercent || '0'}%`} sub={`${system.cpu?.cores} 核 · ${system.cpu?.model?.slice(0, 30)}`} color="#8b5cf6" />
                <StatCard icon={<MemoryStick size={16} />} label="内存" value={`${system.memory?.usedGB || '0'}/${system.memory?.totalGB || '0'} GB`} sub={`${system.memory?.usagePercent || '0'}% 已用`} color="#3b82f6" />
                <StatCard icon={<Activity size={16} />} label="运行时间" value={`${Math.floor((system.uptime || 0) / 3600)}h`} sub={`${system.hostname || ''}`} color="#10b981" />
                <StatCard icon={<Network size={16} />} label="网络接口" value={`${Object.keys(system.network || {}).length} 个`} sub="127.0.0.1 等" color="#f59e0b" />
              </>}
            </div>

            {/* 模型健康 */}
            <h3 className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 600, margin: '24px 0 12px' }}>
              <Bot size={16} /> 模型健康
            </h3>
            <div className="space-y-2">
              {models.length === 0 ? (
                <div className="glass-card" style={{ padding: 16, fontSize: 13, color: 'var(--text-tertiary)' }}>暂无 Provider 配置</div>
              ) : models.map(m => (
                <div key={m.id} className="glass-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div className="flex items-center gap-3">
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: statusColor(m.status) }} />
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{m.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                        {m.baseUrl} · {Array.isArray(m.models) ? m.models.slice(0, 2).join(', ') : m.models}
                        {Array.isArray(m.models) && m.models.length > 2 ? ` +${m.models.length - 2}` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                    <span>{m.latency ? `${m.latency}ms` : ''}</span>
                    <span style={{ color: statusColor(m.status) }}>
                      {m.status === 'ok' ? '正常' : m.status === 'quota_low' ? '额度不足' : m.error ? `错误: ${m.error.slice(0, 30)}` : '未知'}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Agent 与 Token 统计 */}
            <div className="flex gap-3 flex-wrap" style={{ display: 'flex', gap: 12, marginTop: 24 }}>
              {agents && <>
                <StatCard icon={<Bot size={16} />} label="MCP 服务器" value={`${agents.mcp?.enabled || 0}/${agents.mcp?.total || 0}`} sub={`${agents.mcp?.local || 0} local · ${agents.mcp?.remote || 0} remote`} color="#8b5cf6" />
                <StatCard icon={<Activity size={16} />} label="活跃对话" value={`${agents.activeConversations || 0}`} sub={`24h 消息: ${agents.recentMessages24h || 0}`} color="#3b82f6" />
              </>}
              {tokens && <>
                <StatCard icon={<Coins size={16} />} label="今日 Token" value={(tokens.today || 0).toLocaleString()} sub={`30天: ${(tokens.month30 || 0).toLocaleString()}`} color="#f59e0b" />
                <StatCard icon={<Coins size={16} />} label="总计 Token" value={(tokens.total || 0).toLocaleString()} sub={`自 ${tokens.since ? new Date(tokens.since).toLocaleDateString() : '无数据'}`} color="#ef4444" />
              </>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}