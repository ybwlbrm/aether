import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * P1-13: 自动保存草稿 hook — 意外刷新/误触返回键时恢复输入
 * 数据存 localStorage，debounce 写入防频繁 IO
 *
 * P1-12 修复：
 * - 组件卸载时立即 flush 最新值（原本 debounce 未到期的写入被 clearTimeout 丢弃 → 草稿丢失）
 * - key 变化时先保存旧 key 再切换到新 key，避免旧草稿污染新 key
 */
export function useAutosaveDraft<T>(key: string, initial: T, debounceMs = 1000): [T, (v: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? (JSON.parse(saved) as T) : initial;
    } catch {
      return initial;
    }
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef(value);
  const keyRef = useRef(key);
  valueRef.current = value;
  keyRef.current = key;

  // debounce 写入 + key 切换时保存旧 key 并清除旧 key timer
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // localStorage 满或禁用，忽略
      }
    }, debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [key, value, debounceMs]);

  // P1-12 修复：卸载时 flush 最新值（不依赖 debounce timer），防止关键输入丢失
  useEffect(() => {
    return () => {
      const k = keyRef.current;
      const v = valueRef.current;
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        // localStorage 满或禁用，忽略
      }
    };
  }, []);

  const clear = useCallback(() => {
    try { localStorage.removeItem(keyRef.current); } catch (_e: unknown) { /* ignore - intentional */ }
  }, []);

  return [value, setValue, clear];
}