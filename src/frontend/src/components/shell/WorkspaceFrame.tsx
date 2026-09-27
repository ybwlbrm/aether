import type { ReactNode } from 'react';
import { useWorkspaceStore } from '../../store/workspace';
import { Workbench } from './Workbench';

/**
 * WorkspaceFrame — 主工作区布局（spec §8.2/§18）。
 *
 *   Main（思考/编辑/阅读） | Workbench（执行）
 *
 * Workbench 打开时按宽度分栏；maximized 时占满；关闭时 Main 100%。
 */

export function WorkspaceFrame({ children }: { children: ReactNode }) {
  const workbench = useWorkspaceStore((s) => s.workbench);

  return (
    <div
      className="aether-workspace"
      style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        position: 'relative',
      }}
    >
      {/* Main */}
      <main
        className="aether-workspace-main"
        style={{
          flex: workbench.open && !workbench.maximized ? '1 1 0%' : '1 1 100%',
          minWidth: 0,
          minHeight: 0,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </main>

      {/* Workbench */}
      {workbench.open && (
        <div
          className="aether-workspace-wb"
          style={{
            flex: workbench.maximized ? '1 1 100%' : '0 0 auto',
            width: workbench.maximized ? '100%' : workbench.width,
            minWidth: 0,
            minHeight: 0,
            borderLeft: '1px solid var(--border-primary)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Workbench />
        </div>
      )}
    </div>
  );
}
