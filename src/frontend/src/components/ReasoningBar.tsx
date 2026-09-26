import { memo, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Brain, ChevronDown } from 'lucide-react';

/**
 * ReasoningBar — 输入框上方的思考过程横条
 *
 * 设计：仿照 OpenCode/Claude Code 的「思考过程」展示方式：
 * - 固定在输入框上方，作为一条横向滚动条
 * - 思考内容实时追加，始终自动滚动到最新一段
 * - 无思考内容时整个横条隐藏（AnimatePresence 动画淡出）
 * - 应用玻璃效果（backdrop-filter blur + 半透明背景）
 *
 * AEX-P0-051/065/045:
 * - 默认紧凑折叠（单行「思考中 · Ns」），点击展开 —— 不抢占最终回答层级
 * - 思考中图标用 Lucide Brain（不再用 emoji 🧠）
 * - 旋转动画在 prefers-reduced-motion 下关闭（useReducedMotion）
 */
export const ReasoningBar = memo(({ content }: { content: string }) => {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const hasContent = !!content && content.trim().length > 0;
  const reduceMotion = useReducedMotion();

  // 内容更新时自动滚动到最新（最新始终可见）
  useEffect(() => {
    if (barRef.current && hasContent && expanded) {
      barRef.current.scrollTop = barRef.current.scrollHeight;
    }
  }, [content, hasContent, expanded]);

  // 新内容到达时自动展开，静默后保留（用户可手动折叠）
  useEffect(() => {
    if (hasContent) setExpanded(true);
  }, [hasContent]);

  return (
    <AnimatePresence>
      {hasContent && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeOut' }}
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
              maxHeight: expanded ? 110 : 32,
              overflow: 'hidden',
              cursor: 'pointer',
            }}
            onClick={() => setExpanded((v) => !v)}
            role="button"
            aria-expanded={expanded}
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v); } }}
          >
            {/* 思考图标 — 旋转动画表示活跃；reduced-motion 下静止 */}
            <span
              className="flex items-center justify-center flex-shrink-0"
              style={{ width: 20, height: 20, marginTop: 2, color: 'var(--color-accent)' }}
            >
              <motion.span
                animate={reduceMotion ? { rotate: 0 } : { rotate: 360 }}
                transition={reduceMotion ? { duration: 0 } : { duration: 2, repeat: Infinity, ease: 'linear' }}
                style={{ display: 'inline-flex' }}
              >
                <Brain size={14} />
              </motion.span>
            </span>
            {/* 折叠态摘要：单行「思考中 · Ns」 */}
            {!expanded ? (
              <div style={{ flex: 1, fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                思考中 · {content.length} 字
              </div>
            ) : (
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
            )}
            <span style={{ display: 'inline-flex', marginTop: 2, color: 'var(--text-tertiary)' }}>
              <ChevronDown size={14} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: reduceMotion ? 'none' : 'transform 0.2s' }} />
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

ReasoningBar.displayName = 'ReasoningBar';