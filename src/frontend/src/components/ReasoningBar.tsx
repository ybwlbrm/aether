import { memo, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * ReasoningBar — 输入框上方的思考过程横条
 *
 * 设计：仿照 OpenCode/Claude Code 的「思考过程」展示方式：
 * - 固定在输入框上方，作为一条横向滚动条
 * - 思考内容实时追加，始终自动滚动到最新一段
 * - 无思考内容时整个横条隐藏（AnimatePresence 动画淡出）
 * - 应用玻璃效果（backdrop-filter blur + 半透明背景）
 */
export const ReasoningBar = memo(({ content }: { content: string }) => {
  const barRef = useRef<HTMLDivElement | null>(null);
  const hasContent = !!content && content.trim().length > 0;

  // 内容更新时自动滚动到最新（最新始终可见）
  useEffect(() => {
    if (barRef.current && hasContent) {
      barRef.current.scrollTop = barRef.current.scrollHeight;
    }
  }, [content, hasContent]);

  return (
    <AnimatePresence>
      {hasContent && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          style={{ overflow: 'hidden' }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              margin: '6px 8px 2px',
              padding: '6px 10px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-surface)',
              backdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
              WebkitBackdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
              border: '1px solid var(--border-primary)',
              maxHeight: 110,
            }}
          >
            {/* 思考图标 — 旋转动画表示活跃 */}
            <span
              className="flex items-center justify-center flex-shrink-0"
              style={{ width: 20, height: 20, marginTop: 2, color: 'var(--color-accent)' }}
            >
              <motion.span
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                style={{ display: 'inline-flex', fontSize: 14 }}
              >
                🧠
              </motion.span>
            </span>
            {/* 滚动内容区 — 随思考自动滚动，始终最新 */}
            <div
              ref={barRef}
              style={{
                flex: 1,
                fontSize: 12,
                lineHeight: 1.6,
                color: 'var(--text-secondary)',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                maxHeight: 96,
                overflowY: 'auto',
              }}
            >
              {content}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

ReasoningBar.displayName = 'ReasoningBar';