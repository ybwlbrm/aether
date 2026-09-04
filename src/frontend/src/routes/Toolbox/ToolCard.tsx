import { motion } from 'framer-motion';
import type { ConvertOption } from './types';

interface ToolCardProps {
  option: ConvertOption;
  index: number;
  onSelect: (o: ConvertOption) => void;
  activeCategory: string;
}

export function ToolCard({ option, index, onSelect, activeCategory }: ToolCardProps) {
  return (
    <motion.button
      key={option.label}
      onClick={() => onSelect(option)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      className="glass-card"
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.98 }}
      style={{ padding: '20px', textAlign: 'center', cursor: 'pointer', minHeight: '110px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}
    >
      <div className="flex items-center justify-center flex-shrink-0" style={{ width: 40, height: 40, borderRadius: 'var(--radius-md)', background: `${option.color}18` }}>
        <span style={{ color: option.color }}>{option.icon}</span>
      </div>
      <div style={{ fontSize: 'var(--font-base)', fontWeight: 600, color: 'var(--text-primary)', textAlign: 'center' }}>{option.label}</div>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)', textAlign: 'center', lineHeight: 1.4 }}>{option.desc}</div>
    </motion.button>
  );
}