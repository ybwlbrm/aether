/**
 * 轮询状态机的显式 UI（整改计划第 3 章 P0）。
 *
 * 两条路由此前各写一份，且 CodingHome 只把轮询错误塞进 loadError、完全不读
 * pollStatus / pollErrorInfo / retry —— 失败与重试入口因此在 CodingHome 丢失。
 * 收敛到本组件后两处渲染完全一致，且都消费 3 个返回值。
 */
import type { PollErrorInfo, PollStatus } from '../../hooks/useMessagePolling';

export interface PollStatusBannerProps {
  readonly status: PollStatus;
  readonly errorInfo: PollErrorInfo | null;
  readonly onRetry: () => void;
  /** inline = 会话滚动区内（Chat）；banner = 页面顶部横幅（CodingHome） */
  readonly layout: 'inline' | 'banner';
}

const SOURCE_LABEL: Readonly<Record<PollErrorInfo['type'], string>> = {
  message: '消息轮询',
  activity: '活动事件轮询',
};

export function PollStatusBanner({ status, errorInfo, onRetry, layout }: PollStatusBannerProps) {
  if ((status !== 'error' && status !== 'retrying') || !errorInfo) return null;
  const failed = status === 'error';
  // D6：type 现在真的描述"是哪条轮询在失败"（此前两条通道共用一个计数器，type 是假的）
  const text = `${failed ? '⚠️' : '🔄'} ${SOURCE_LABEL[errorInfo.type]}${failed ? '失败' : '重试中'}：${errorInfo.message}`;
  const lastSuccess = errorInfo.lastSuccessAt
    ? `（最后成功 ${new Date(errorInfo.lastSuccessAt).toLocaleTimeString()}，${Math.round(errorInfo.retryInMs / 1000)}s 后重试）`
    : '';

  if (layout === 'banner') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '0 24px 8px' }}>
        <div style={{ width: '100%', maxWidth: 720, padding: '8px 16px', borderRadius: 8, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--color-warning)', fontSize: 13, textAlign: 'center' }}>
          {text}
          {lastSuccess && <span style={{ opacity: 0.7 }}>{lastSuccess}</span>}
          {failed && (
            <button type="button" onClick={onRetry} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}>
              立即重试
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '6px 0', fontSize: 12, color: 'var(--color-warning)' }}>
      {text}
      {errorInfo.lastSuccessAt && <span style={{ opacity: 0.7 }}>（最后成功 {new Date(errorInfo.lastSuccessAt).toLocaleTimeString()}）</span>}
      {failed && (
        <button className="btn btn-ghost" onClick={onRetry} style={{ fontSize: 12, padding: '2px 10px' }}>
          立即重试
        </button>
      )}
    </div>
  );
}
