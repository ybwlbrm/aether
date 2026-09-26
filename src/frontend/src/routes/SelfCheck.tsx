import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { api } from '../api/client';
import { Shield, CheckCircle2, XCircle, AlertTriangle, RefreshCw } from 'lucide-react';

interface SelfCheckItem {
  status: 'ok' | 'warn' | 'error';
  name: string;
  detail: string;
}

interface SelfCheckResult {
  summary?: { ok: number; warn: number; error: number; passed?: boolean };
  checks?: SelfCheckItem[];
  timestamp?: string;
}

function parseSelfCheck(value: unknown): SelfCheckResult | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const summary = obj.summary as Record<string, unknown> | undefined;
  const checks = Array.isArray(obj.checks) ? obj.checks : undefined;
  return {
    summary: summary
      ? {
          ok: typeof summary.ok === 'number' ? summary.ok : 0,
          warn: typeof summary.warn === 'number' ? summary.warn : 0,
          error: typeof summary.error === 'number' ? summary.error : 0,
          passed: typeof summary.passed === 'boolean' ? summary.passed : undefined,
        }
      : undefined,
    checks: checks?.map((c) => {
      const item = c as Record<string, unknown>;
      return {
        status: item.status === 'warn' || item.status === 'error' ? item.status : 'ok',
        name: typeof item.name === 'string' ? item.name : '未知检查项',
        detail: typeof item.detail === 'string' ? item.detail : '',
      };
    }),
    timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined,
  };
}

export function SelfCheck() {
  const [result, setResult] = useState<SelfCheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.runSelfCheck();
      setResult(parseSelfCheck(res));
    } catch (e: unknown) {
      // Recoverable: 自检失败不阻塞页面，展示可重试错误态（与"空结果"区分）。
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };
  useEffect(() => { run(); }, []);

  const statusIcon = (status: string) => {
    switch (status) {
      case 'ok': return <CheckCircle2 size={16} style={{ color: 'var(--color-success)' }} />;
      case 'warn': return <AlertTriangle size={16} style={{ color: '#f59e0b' }} />;
      case 'error': return <XCircle size={16} style={{ color: '#ef4444' }} />;
      default: return null;
    }
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: 'var(--content-standard)', margin: '0 auto', padding: '0 24px' }}>
        <PageHeader title="AI 自检系统" description="检查项目完整性、数据一致性、依赖状态" icon={<Shield size={22} />} color="#10b981"
          action={<button className="btn btn-primary" onClick={run} disabled={loading}>
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} /> {loading ? '检查中...' : '重新检查'}
          </button>}
        />

        {loading && (
          <div className="glass-card" style={{ padding: 24, marginBottom: 16, textAlign: 'center' }}>
            <div className="spinner" style={{ margin: '0 auto' }} />
            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-tertiary)' }}>正在检查系统状态...</div>
          </div>
        )}

        {error && !loading && (
          <div className="glass-card" style={{ padding: 24, marginBottom: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
            <div className="empty-state-title">自检失败</div>
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)', margin: '6px 0 14px', overflowWrap: 'anywhere' }}>{error}</div>
            <button className="btn btn-primary" onClick={run}>重试</button>
          </div>
        )}

        {result && !loading && (
          <>
            {/* 总览卡片 */}
            <div className="glass-card" style={{ padding: 24, marginBottom: 16, textAlign: 'center' }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>
                {result.summary?.passed ? <CheckCircle2 size={48} style={{ color: 'var(--color-success)', margin: '0 auto' }} /> :
                  (result.summary?.error ?? 0) > 0 ? <XCircle size={48} style={{ color: '#ef4444', margin: '0 auto' }} /> :
                  <AlertTriangle size={48} style={{ color: '#f59e0b', margin: '0 auto' }} />}
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
                {result.summary?.passed ? '✅ 一切正常' : (result.summary?.error ?? 0) > 0 ? '❌ 发现错误' : '⚠️ 存在警告'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
                {result.summary?.ok} 项通过 · {result.summary?.warn} 项警告 · {result.summary?.error} 项错误
              </div>
              {result.timestamp ? (
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                  检查时间: {new Date(result.timestamp).toLocaleString()}
                </div>
              ) : null}
            </div>

            {/* 检查项列表 */}
            <div className="space-y-2">
              {(result.checks ?? []).map((check, i) => (
                <div key={`${check.name}-${i}`} className="glass-card" style={{
                  padding: '14px 18px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  borderLeft: `3px solid ${
                    check.status === 'ok' ? 'var(--color-success)' :
                    check.status === 'warn' ? '#f59e0b' : '#ef4444'
                  }`,
                }}>
                  {statusIcon(check.status)}
                  <div className="flex-1">
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{check.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{check.detail}</div>
                  </div>
                  <span style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 4,
                    background: check.status === 'ok' ? 'rgba(52,211,153,0.15)' :
                      check.status === 'warn' ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)',
                    color: check.status === 'ok' ? 'var(--color-success)' :
                      check.status === 'warn' ? '#f59e0b' : '#ef4444',
                  }}>
                    {check.status === 'ok' ? '通过' : check.status === 'warn' ? '警告' : '错误'}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {!loading && !result && !error && (
          <div className="glass-card flex items-center justify-center py-12" style={{ color: 'var(--text-tertiary)' }}>
            <div className="text-center">
              <Shield size={40} style={{ opacity: 0.3, margin: '0 auto 8px' }} />
              <div>暂无自检数据</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
