import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { api } from '../api/client';
import type { RepairReport, RepairStep, SelfCheckItem } from '../api/client';
import {
  Shield,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/** 自检状态 → 图标 + 强调色（success 用设计 token，warn/error 用语义色）。 */
const STATUS_COLOR: Record<SelfCheckItem['status'], string> = {
  ok: 'var(--color-success)',
  warn: '#f59e0b',
  error: '#ef4444',
};

const STATUS_BG: Record<SelfCheckItem['status'], string> = {
  ok: 'rgba(52,211,153,0.15)',
  warn: 'rgba(245,158,11,0.15)',
  error: 'rgba(239,68,68,0.15)',
};

const STATUS_LABEL: Record<SelfCheckItem['status'], string> = {
  ok: '通过',
  warn: '警告',
  error: '错误',
};

/** 修复步骤结果 → 图标 / 强调色 / 底色 / 中文标签。 */
const OUTCOME_META: Record<
  RepairStep['outcome'],
  { icon: LucideIcon; color: string; bg: string; label: string }
> = {
  fixed: { icon: CheckCircle2, color: 'var(--color-success)', bg: 'rgba(52,211,153,0.15)', label: '已修复' },
  'already-healthy': { icon: CheckCircle2, color: '#38bdf8', bg: 'rgba(56,189,248,0.15)', label: '已健康' },
  skipped: { icon: AlertTriangle, color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', label: '已跳过' },
  failed: { icon: XCircle, color: '#ef4444', bg: 'rgba(239,68,68,0.15)', label: '失败' },
};

function statusIcon(status: SelfCheckItem['status']) {
  switch (status) {
    case 'ok': return <CheckCircle2 size={16} style={{ color: STATUS_COLOR.ok }} />;
    case 'warn': return <AlertTriangle size={16} style={{ color: STATUS_COLOR.warn }} />;
    case 'error': return <XCircle size={16} style={{ color: STATUS_COLOR.error }} />;
  }
}

/**
 * 修复结果面板 —— 逐条展示后端 repair-steps 的执行结果。
 * 纯展示组件（无状态、无副作用），便于在无 DOM 环境下直接断言渲染结果。
 */
export function RepairResultPanel({ report }: { report: RepairReport }) {
  const { summary } = report;
  return (
    <div className="glass-card" style={{ padding: 20, marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Wrench size={16} style={{ color: 'var(--color-accent)' }} />
        <span style={{ fontSize: 15, fontWeight: 700 }}>修复结果</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12 }}>
        共 {summary.total} 步 · 已修复 {summary.fixed} · 已健康 {summary.alreadyHealthy} · 已跳过 {summary.skipped} · 失败 {summary.failed}
      </div>
      <div className="space-y-2">
        {report.steps.map((step) => {
          const meta = OUTCOME_META[step.outcome];
          const Icon = meta.icon;
          return (
            <div key={step.id} style={{
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              borderRadius: 8,
              borderLeft: `3px solid ${meta.color}`,
              background: 'var(--bg-elevated)',
            }}>
              <Icon size={16} style={{ color: meta.color }} />
              <div className="flex-1">
                <div style={{ fontSize: 14, fontWeight: 600 }}>{step.label}</div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{step.detail}</div>
              </div>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 4,
                background: meta.bg, color: meta.color, whiteSpace: 'nowrap',
              }}>
                {meta.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SelfCheck() {
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.runSelfCheck>> | null>(null);
  const [repairReport, setRepairReport] = useState<RepairReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [repairing, setRepairing] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const res = await api.runSelfCheck();
      setResult(res);
    } catch (_e: unknown) { console.warn("[SilentCatch]", _e); }
    setLoading(false);
  };
  useEffect(() => { run(); }, []);

  /** 一键修复：后端回传修复报告 + 修复后自检报告，同一响应即可刷新总览。 */
  const repair = async () => {
    setRepairing(true);
    try {
      const res = await api.runRepair();
      setRepairReport(res);
      setResult(res.selfcheck);
    } catch (_e: unknown) { console.warn("[SilentCatch]", _e); }
    finally { setRepairing(false); }
  };

  // 未配置同步是「用户还没开功能」而非故障 —— 给用户明确的下一步引导
  const syncCheck = result?.checks.find(c => c.name === '远程同步');
  const needsSyncSetup = syncCheck !== undefined && syncCheck.status !== 'ok';

  const busy = loading || repairing;

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
        <PageHeader title="AI 自检系统" description="检查项目完整性、数据一致性、依赖状态" icon={<Shield size={22} />} color="#10b981"
          action={<>
            <button className="btn btn-ghost" onClick={repair} disabled={busy}>
              <Wrench size={18} className={repairing ? 'animate-spin' : ''} /> {repairing ? '修复中...' : '一键修复'}
            </button>
            <button className="btn btn-primary" onClick={run} disabled={busy}>
              <RefreshCw size={18} className={loading ? 'animate-spin' : ''} /> {loading ? '检查中...' : '重新检查'}
            </button>
          </>}
        />

        {loading && (
          <div className="glass-card" style={{ padding: 24, marginBottom: 16, textAlign: 'center' }}>
            <div className="spinner" style={{ margin: '0 auto' }} />
            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-tertiary)' }}>正在检查系统状态...</div>
          </div>
        )}

        {repairing && (
          <div className="glass-card" style={{ padding: 24, marginBottom: 16, textAlign: 'center' }}>
            <div className="spinner" style={{ margin: '0 auto' }} />
            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-tertiary)' }}>正在修复：落盘、孤立数据、陈旧运行、缓存与同步监听...</div>
          </div>
        )}

        {result && (
          <>
            {/* 总览卡片 */}
            <div className="glass-card" style={{ padding: 24, marginBottom: 16, textAlign: 'center' }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>
                {result.summary.passed ? <CheckCircle2 size={48} style={{ color: 'var(--color-success)', margin: '0 auto' }} /> :
                  result.summary.error > 0 ? <XCircle size={48} style={{ color: '#ef4444', margin: '0 auto' }} /> :
                  <AlertTriangle size={48} style={{ color: '#f59e0b', margin: '0 auto' }} />}
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
                {result.summary.passed ? '✅ 一切正常' : result.summary.error > 0 ? '❌ 发现错误' : '⚠️ 存在警告'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
                {result.summary.ok} 项通过 · {result.summary.warn} 项警告 · {result.summary.error} 项错误
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                检查时间: {new Date(result.timestamp).toLocaleString()}
              </div>
              {needsSyncSetup && (
                <div style={{ fontSize: 12, color: '#f59e0b', marginTop: 10 }}>
                  远程同步尚未就绪：请到「设置 → 同步」连接 Supabase；已配置但监听未启动时，点「一键修复」可恢复监听。
                </div>
              )}
            </div>

            {/* 修复结果（仅在一键修复后出现） */}
            {repairReport && <RepairResultPanel report={repairReport} />}

            {/* 检查项列表 */}
            <div className="space-y-2" style={{ marginTop: repairReport ? 16 : 0 }}>
              {result.checks.map((check, i) => (
                <div key={i} className="glass-card" style={{
                  padding: '14px 18px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  borderLeft: `3px solid ${STATUS_COLOR[check.status]}`,
                }}>
                  {statusIcon(check.status)}
                  <div className="flex-1">
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{check.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{check.detail}</div>
                  </div>
                  <span style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 4,
                    background: STATUS_BG[check.status],
                    color: STATUS_COLOR[check.status],
                  }}>
                    {STATUS_LABEL[check.status]}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {!loading && !result && (
          <div className="glass-card flex items-center justify-center py-12" style={{ color: 'var(--text-tertiary)' }}>
            <div className="text-center">
              <Shield size={40} style={{ opacity: 0.3, margin: '0 auto 8px' }} />
              <div>检查失败，请重试</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}