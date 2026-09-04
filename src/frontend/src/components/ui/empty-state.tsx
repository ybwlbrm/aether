import type { ReactNode } from 'react';

/**
 * 统一空状态组件（W4-6：消除 Chat/CodingHome/Knowledge/Projects 等页面的重复空状态实现）
 */
interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={`glass-card ${className || ''}`}>
      <div className="empty-state">
        {icon && <div className="empty-state-icon">{icon}</div>}
        <div className="empty-state-title">{title}</div>
        {description && <div className="empty-state-desc">{description}</div>}
        {action}
      </div>
    </div>
  );
}