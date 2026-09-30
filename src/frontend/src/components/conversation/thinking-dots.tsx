/** 「处理中」三点脉冲（Chat / CodingHome 同一实现） */
import { motion } from 'framer-motion';

export function ThinkingDots() {
  return (
    <div style={{ display: 'flex', gap: 4, padding: '12px 16px' }}>
      {[0, 1, 2].map(index => (
        <motion.div
          key={index}
          style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)' }}
          animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 1, repeat: Infinity, delay: index * 0.2 }}
        />
      ))}
    </div>
  );
}
