import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

// P1-1: 全局 confirm 服务 — 替换原生 window.confirm，返回 Promise<boolean>
interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger';
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
  resolve: ((v: boolean) => void) | null;
}

interface PromptOptions {
  title?: string;
  message: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
}

interface PromptState extends PromptOptions {
  open: boolean;
  resolve: ((v: string | null) => void) | null;
  inputValue: string;
}

const defaultState: ConfirmState = {
  open: false,
  message: '',
  resolve: null,
};

const defaultPromptState: PromptState = {
  open: false,
  message: '',
  resolve: null,
  inputValue: '',
};

let pendingResolve: ((v: boolean) => void) | null = null;
let pendingAlertResolve: (() => void) | null = null;
let pendingPromptResolve: ((v: string | null) => void) | null = null;

// A-05: 焦点恢复 — 记录打开弹窗前的活动元素，关闭时还原
let previousFocus: HTMLElement | null = null;
function captureFocus() { previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; }
function restoreFocus() { previousFocus?.focus?.(); previousFocus = null; }

/** 异步 confirm — 替换 window.confirm，调用方需 await */
export function confirm(options: ConfirmOptions | string): Promise<boolean> {
  const opts = typeof options === 'string' ? { message: options } : options;
  return new Promise<boolean>((resolve) => {
    pendingResolve = resolve;
    window.dispatchEvent(new CustomEvent('__confirm_show', { detail: opts }));
  });
}

/** 异步 alert — 替换原生 window.alert */
export function alert(message: string): Promise<void> {
  return new Promise<void>((resolve) => {
    pendingAlertResolve = resolve;
    window.dispatchEvent(new CustomEvent('__alert_show', { detail: { message } }));
  });
}

/** 异步 prompt — 替换原生 window.prompt（Electron 不支持 window.prompt） */
export function promptDialog(options: PromptOptions | string): Promise<string | null> {
  const opts = typeof options === 'string' ? { message: options } : options;
  return new Promise<string | null>((resolve) => {
    pendingPromptResolve = resolve;
    window.dispatchEvent(new CustomEvent('__prompt_show', { detail: opts }));
  });
}

/** ConfirmDialog 组件 — 挂载在 App 根节点 */
export function ConfirmDialog() {
  const [state, setState] = useState<ConfirmState>(defaultState);
  const [promptState, setPromptState] = useState<PromptState>(defaultPromptState);

  const handleClose = useCallback((result: boolean) => {
    setState(defaultState);
    restoreFocus();
    const r = pendingResolve;
    pendingResolve = null;
    r?.(result);
  }, []);

  const handleAlertClose = useCallback(() => {
    setState(defaultState);
    restoreFocus();
    const r = pendingAlertResolve;
    pendingAlertResolve = null;
    r?.();
  }, []);

  const handlePromptClose = useCallback((result: string | null) => {
    setPromptState(defaultPromptState);
    restoreFocus();
    const r = pendingPromptResolve;
    pendingPromptResolve = null;
    r?.(result);
  }, []);

  useEffect(() => {
    const showConfirm = (e: Event) => {
      const ce = e as CustomEvent;
      captureFocus();
      setState({ ...ce.detail, open: true, resolve: pendingResolve });
    };
    const showAlert = (e: Event) => {
      const ce = e as CustomEvent;
      captureFocus();
      setState({ message: ce.detail.message, open: true, resolve: pendingAlertResolve, variant: 'default' });
    };
    const showPrompt = (e: Event) => {
      const ce = e as CustomEvent;
      const detail = ce.detail as PromptOptions;
      captureFocus();
      setPromptState({
        ...detail,
        open: true,
        resolve: pendingPromptResolve,
        inputValue: detail.defaultValue || '',
      });
    };
    window.addEventListener('__confirm_show', showConfirm);
    window.addEventListener('__alert_show', showAlert);
    window.addEventListener('__prompt_show', showPrompt);
    return () => {
      window.removeEventListener('__confirm_show', showConfirm);
      window.removeEventListener('__alert_show', showAlert);
      window.removeEventListener('__prompt_show', showPrompt);
      pendingResolve = null;
      pendingAlertResolve = null;
      pendingPromptResolve = null;
    };
  }, []);

  // P1-1: monkey-patch window.alert
  useEffect(() => {
    const originalAlert = window.alert;
    window.alert = (message: string) => {
      alert(message);
    };
    return () => {
      window.alert = originalAlert;
    };
  }, []);

  // P1-14 修复：Escape 键关闭（键盘可访问性）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (promptState.open) {
        handlePromptClose(null);
        return;
      }
      if (state.open) {
        isAlert() ? handleAlertClose() : handleClose(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [promptState.open, state.open, handleAlertClose, handleClose]);

  const isAlert = () => pendingAlertResolve !== null && !('confirmText' in state);

  // Prompt modal
  if (promptState.open) {
    return createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label={promptState.title || '输入对话框'}
        className="fixed inset-0 flex items-center justify-center"
        style={{ zIndex: 'var(--z-modal-backdrop, 1600)', background: 'rgba(0,0,0,0.5)' }}
        onClick={() => handlePromptClose(null)}
      >
        <div
          className="glass-card rounded-2xl p-6 max-w-lg w-full mx-4"
          onClick={(e) => e.stopPropagation()}
        >
          {promptState.title && <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{promptState.title}</h3>}
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>{promptState.message}</p>
          <textarea
            className="input w-full mb-4"
            style={{ minHeight: 200, fontSize: 13, fontFamily: 'var(--font-mono)', resize: 'vertical' }}
            value={promptState.inputValue}
            onChange={e => setPromptState(prev => ({ ...prev, inputValue: e.target.value }))}
            autoFocus
          />
          <div className="flex gap-3 justify-end">
            <button
              className="px-4 py-2 rounded-lg text-sm transition-colors"
              style={{ background: 'rgba(var(--glass-fill-rgb), 0.15)', color: 'var(--text-secondary)' }}
              onClick={() => handlePromptClose(null)}
            >
              {promptState.cancelText || '取消'}
            </button>
            <button
              className="px-4 py-2 rounded-lg text-sm transition-colors"
              style={{ background: 'var(--color-accent)', color: 'var(--on-accent)' }}
              onClick={() => handlePromptClose(promptState.inputValue)}
            >
              {promptState.confirmText || '保存'}
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  if (!state.open) return null;

  const isDanger = state.variant === 'danger';
  // T-33: 硬编码 blue/red → 主题语义色（--color-accent/--color-danger/--on-accent）
  const confirmBtn = isDanger
    ? { background: 'var(--color-danger)', color: 'var(--on-accent)' }
    : { background: 'var(--color-accent)', color: 'var(--on-accent)' };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={state.title || (isAlert() ? '提示' : '确认对话框')}
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 'var(--z-modal-backdrop, 1600)', background: 'rgba(0,0,0,0.5)' }}
      onClick={() => { isAlert() ? handleAlertClose() : handleClose(false); }}
    >
      <div
        className="glass-card rounded-2xl p-6 max-w-sm w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {state.title && <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{state.title}</h3>}
        <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>{state.message}</p>
        <div className="flex gap-3 justify-end">
          {isAlert() ? (
            <button
              className="px-4 py-2 rounded-lg text-sm transition-colors"
              style={confirmBtn}
              onClick={handleAlertClose}
            >
              {state.confirmText || '确定'}
            </button>
          ) : (
            <>
              <button
                className="px-4 py-2 rounded-lg text-sm transition-colors"
                style={confirmBtn}
                onClick={() => handleClose(true)}
              >
                {state.confirmText || '确认'}
              </button>
              <button
                className="px-4 py-2 rounded-lg text-sm transition-colors"
                style={{ background: 'rgba(var(--glass-fill-rgb), 0.15)', color: 'var(--text-secondary)' }}
                onClick={() => handleClose(false)}
              >
                {state.cancelText || '取消'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
