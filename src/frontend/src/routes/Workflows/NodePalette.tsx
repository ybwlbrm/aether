import { useRef } from 'react';
import type { NodeType } from './types';
import { PALETTE, NODE_META } from './constants';

interface NodePaletteProps {
  onAddNode: (type: NodeType) => void;
  dragIndex: React.MutableRefObject<number | null>;
}

export function NodePalette({ onAddNode, dragIndex }: NodePaletteProps) {
  const handleDragStart = (e: React.DragEvent, type: NodeType) => {
    e.dataTransfer.setData('application/node-type', type);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleNodeDragStart = (e: React.DragEvent, index: number) => {
    dragIndex.current = index;
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="glass-card" style={{ padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)' }}>节点库</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {PALETTE.map((type) => {
          const meta = NODE_META[type];
          return (
            <div
              key={type}
              draggable
              onDragStart={(e) => handleDragStart(e, type)}
              onClick={() => onAddNode(type)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12,
                border: `1px solid ${meta.color}44`, background: `${meta.color}14`, cursor: 'grab',
                transition: 'transform 0.15s ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateX(2px)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; }}
            >
              <div style={{ width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: meta.color, color: '#fff', flexShrink: 0 }}>
                {meta.icon}
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{meta.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{meta.desc}</div>
              </div>
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 12, lineHeight: 1.6 }}>
        拖拽到画布添加节点，或点击直接追加。节点按从上到下顺序执行。
      </p>
    </div>
  );
}