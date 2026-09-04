"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * 共享 Tabs 组件（W4-6：统一 Settings/Knowledge/Chat 各处手写 tab 条）
 * 用例：
 *   <Tabs>
 *     <TabList><TabTrigger value="a">会话</TabTrigger><TabTrigger value="b">设置</TabTrigger></TabList>
 *     <TabContent value="a">…</TabContent>
 *     <TabContent value="b">…</TabContent>
 *   </Tabs>
 */

interface TabsContextValue {
  value: string;
  onValueChange: (v: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  children: React.ReactNode;
  className?: string;
}

export function Tabs({ value, defaultValue = '', onValueChange, children, className }: TabsProps) {
  const [internal, setInternal] = React.useState(defaultValue);
  const current = value ?? internal;
  const setValue = (v: string) => {
    setInternal(v);
    onValueChange?.(v);
  };
  return (
    <TabsContext.Provider value={{ value: current, onValueChange: setValue }}>
      <div data-slot="tabs" className={cn('flex flex-col gap-2', className)}>{children}</div>
    </TabsContext.Provider>
  );
}

function useTabs(): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error('TabList/TabTrigger/TabContent 必须在 <Tabs> 内使用');
  return ctx;
}

/** 默认值无需受控；uncontrolled 时内部轨迹 */
export function TabList({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="tablist" data-slot="tab-list" className={cn('flex items-center gap-1', className)} {...props}>
      {children}
    </div>
  );
}

interface TabTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export function TabTrigger({ value, className, children, ...props }: TabTriggerProps) {
  const { value: current, onValueChange } = useTabs();
  const active = current === value;

  // A-02: 方向键导航 — 左右切换 tab，Home/End 跳首尾
  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (props.onKeyDown) props.onKeyDown(e);
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const list = e.currentTarget.closest('[role="tablist"]');
    if (!list) return;
    const triggers = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    if (triggers.length === 0) return;
    const currentIdx = triggers.indexOf(e.currentTarget);
    let nextIdx = currentIdx;
    if (e.key === 'ArrowLeft') nextIdx = currentIdx <= 0 ? triggers.length - 1 : currentIdx - 1;
    if (e.key === 'ArrowRight') nextIdx = currentIdx >= triggers.length - 1 ? 0 : currentIdx + 1;
    if (e.key === 'Home') nextIdx = 0;
    if (e.key === 'End') nextIdx = triggers.length - 1;
    e.preventDefault();
    triggers[nextIdx]?.click();
    triggers[nextIdx]?.focus();
  };

  return (
    <button
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-slot="tab-trigger"
      data-active={active || undefined}
      onClick={() => onValueChange(value)}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-sm font-medium transition-colors outline-none',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50',
        active
          ? 'bg-[var(--color-accent)]/12 text-[var(--color-accent)]'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

interface TabContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabContent({ value, className, children, ...props }: TabContentProps) {
  const { value: current } = useTabs();
  if (current !== value) return null;
  return (
    <div role="tabpanel" data-slot="tab-content" className={cn('min-w-0', className)} {...props}>
      {children}
    </div>
  );
}