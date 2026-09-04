import { useRef, useEffect, useCallback } from 'react';

/**
 * 审计修复：安全 setTimeout hook — 组件卸载时自动清理所有 pending 定时器
 * 解决事件处理函数中 setTimeout(() => setState(...), N) 在组件卸载后仍执行的内存泄漏
 */
export function useSafeTimeout() {
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const setSafeTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      fn();
      timers.current.delete(id);
    }, ms);
    timers.current.add(id);
  }, []);

  useEffect(() => () => {
    timers.current.forEach(id => clearTimeout(id));
    timers.current.clear();
  }, []);

  return setSafeTimeout;
}
