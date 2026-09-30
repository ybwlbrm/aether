import { motion } from 'framer-motion';
import { GradientShimmer } from './ui/gradient-shimmer';

interface PageHeaderProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  color?: string;
}

export function PageHeader({ title, description, action, icon, color }: PageHeaderProps) {
  const iconColor = color || 'var(--color-accent)';

  return (
    <motion.div
      className="flex items-center justify-between mb-[var(--space-8)]"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
    >
      <div className="flex items-center gap-4">
        {icon && (
          <div
            className="p-3 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{
              background: `linear-gradient(135deg, ${iconColor}, ${iconColor}cc)`,
              color: 'var(--on-accent)',
              boxShadow: `0 8px 32px ${iconColor}40`,
            }}
          >
            {icon}
          </div>
        )}
        <div>
          <h1
            style={{
              fontSize: 'var(--font-page-title)',
              fontWeight: 700,
              letterSpacing: 'var(--letter-spacing-tight)',
              lineHeight: 1.1,
            }}
          >
            <GradientShimmer gradient="mint" duration={2} pauseBetween={2000} baseColor="var(--text-primary)">
              {title}
            </GradientShimmer>
          </h1>
          {description && (
            <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' /* P1-6: 4px 网格替代 2px */ }}>
              {description}
            </p>
          )}
        </div>
      </div>
      {action && <div className="flex items-center gap-3">{action}</div>}
    </motion.div>
  );
}