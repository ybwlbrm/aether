import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useWorkspaceStore } from '../../store/workspace';
import { DESKTOP_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { Workbench } from './Workbench';

/**
 * WorkspaceFrame — 主工作区布局（spec §8.2/§18）+ 响应式（T20）。
 *
 *   桌面（≥1024px）：Main（思考/编辑/阅读） | Workbench（执行）左右分栏
 *   移动（<1024px）：Main 全宽，Workbench 变成底部 sheet（拖拽手柄 / Esc / 关闭按钮收起）
 *
 * 桌面分栏规则保持原样：Workbench 打开时按宽度分栏；maximized 时占满；关闭时 Main 100%。
 * 桌面 Workbench 宽度由 Workbench 自身拖拽决定，store 内 clamp 到 320-960。
 */

/** 移动端 sheet 常态高度（vh） */
const SHEET_HEIGHT_VH = 60;
/** 移动端 sheet 最大化高度（vh） */
const SHEET_MAXIMIZED_HEIGHT_VH = 92;
/** 拖拽超过该位移（px）即判定为「甩下关闭」 */
const SHEET_CLOSE_DRAG_PX = 96;

export function WorkspaceFrame({ children }: { children: ReactNode }) {
  const workbench = useWorkspaceStore((s) => s.workbench);
  const closeWorkbench = useWorkspaceStore((s) => s.closeWorkbench);
  const isDesktop = useMediaQuery(DESKTOP_MEDIA_QUERY);

  // ---- 移动端 sheet 拖拽手势（桌面分支不触发这些 state）----
  const [dragOffset, setDragOffset] = useState(0);
  const dragStartYRef = useRef<number | null>(null);

  // 关闭后复位，避免下次打开时残留位移
  useEffect(() => {
    if (!workbench.open) setDragOffset(0);
  }, [workbench.open]);

  // Esc 关闭移动端 sheet
  useEffect(() => {
    if (isDesktop || !workbench.open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeWorkbench();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDesktop, workbench.open, closeWorkbench]);

  const onHandlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragStartYRef.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onHandlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const startY = dragStartYRef.current;
    if (startY === null) return;
    setDragOffset(Math.max(0, e.clientY - startY));
  }, []);

  const onHandlePointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const startY = dragStartYRef.current;
    dragStartYRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (startY !== null && e.clientY - startY > SHEET_CLOSE_DRAG_PX) {
      setDragOffset(0);
      closeWorkbench();
    }
  }, [closeWorkbench]);

  const frameStyle = {
    display: 'flex' as const,
    flex: 1,
    minHeight: 0,
    position: 'relative' as const,
  };

  const mainStyle = {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: 'auto' as const,
    display: 'flex' as const,
    flexDirection: 'column' as const,
  };

  /* ============================================================
     桌面：Main | Workbench 横向分栏（原有逻辑不动）
     ============================================================ */
  if (isDesktop) {
    return (
      <div className="aether-workspace" style={frameStyle}>
        <main
          className="aether-workspace-main"
          style={{
            ...mainStyle,
            flex: workbench.open && !workbench.maximized ? '1 1 0%' : '1 1 100%',
          }}
        >
          {children}
        </main>

        {/* Workbench 常驻挂载（内部按 workbench.open 返回 null）：其 useEffect 监听
            workbench-open / workbench-toggle 事件——若条件渲染则组件未挂载、事件无人响应 */}
        <div
          className="aether-workspace-wb"
          style={{
            flex: workbench.open && workbench.maximized ? '1 1 100%' : workbench.open ? '0 0 auto' : '0 0 0px',
            width: workbench.maximized ? '100%' : workbench.width,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            visibility: workbench.open ? 'visible' : 'hidden',
          }}
        >
          <Workbench />
          </div>
      </div>
    );
  }

  /* ============================================================
     移动：Main 全宽 + Workbench 底部 sheet
     ============================================================ */
  const sheetHeightVh = workbench.maximized ? SHEET_MAXIMIZED_HEIGHT_VH : SHEET_HEIGHT_VH;

  return (
    <div className="aether-workspace aether-workspace-mobile" style={frameStyle}>
      <main
        className="aether-workspace-main"
        style={{
          ...mainStyle,
          // sheet 固定在底部，主区留出让位空间（内容不被遮住）
          paddingBottom: workbench.open ? `${sheetHeightVh}vh` : 0,
          transition: 'padding-bottom 0.2s var(--anim-ease)',
        }}
      >
        {children}
      </main>

      <AnimatePresence>
        {workbench.open && (
          <motion.section
            data-slot="workbench-sheet"
            className="aether-workbench-sheet"
            role="dialog"
            aria-label="Workbench"
            initial={{ y: '100%' }}
            animate={{ y: dragOffset }}
            exit={{ y: '100%' }}
            transition={{ type: 'tween', duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            style={{
              position: 'fixed',
              left: 0,
              right: 0,
              bottom: 0,
              height: `${sheetHeightVh}vh`,
              zIndex: 'var(--z-fixed)',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              overflow: 'hidden',
              background: 'var(--surface-shell)',
              borderTop: '1px solid var(--border-primary)',
            }}
          >
            {/* 拖拽关闭手柄 */}
            <div
              data-slot="workbench-sheet-handle"
              role="button"
              tabIndex={0}
              aria-label="Close Workbench"
              onPointerDown={onHandlePointerDown}
              onPointerMove={onHandlePointerMove}
              onPointerUp={onHandlePointerUp}
              onPointerCancel={onHandlePointerUp}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') closeWorkbench(); }}
              style={{
                flex: '0 0 auto',
                display: 'flex',
                justifyContent: 'center',
                padding: '8px 0 4px',
                cursor: 'grab',
                touchAction: 'none',
                userSelect: 'none',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 36,
                  height: 4,
                  borderRadius: 'var(--radius-pill)',
                  background: 'var(--border-primary)',
                }}
              />
            </div>

            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <Workbench />
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}
