import { memo, useMemo, Children, isValidElement, ReactNode } from 'react';
import { CodeTableView } from './CodeTableView';

/**
 * OpenCodeStyleCodeBlock — Streamdown 自定义 pre 渲染组件
 *
 * 将 Streamdown 解析出的 markdown 代码围栏（` ``` `）渲染为表格风格代码展示：
 * - 表格行号 + 代码文本
 * - 语言徽章 + 统计信息
 * - 折叠/展开
 * - 复制按钮
 * - 深色背景（与工具结果卡风格一致）
 *
 * 用法：<Streamdown components={{ pre: OpenCodeStyleCodeBlock }}>{content}</Streamdown>
 */
export const OpenCodeStyleCodeBlock = memo(({ children, className }: {
  children?: ReactNode;
  className?: string;
  node?: any;
  [key: string]: any;
}) => {
  // 从 className 提取语言（react-markdown 给 pre 的 className 如 "language-js"）
  const lang = useMemo(() => {
    if (!className) return 'text';
    const match = className.match(/language-(\w+)/);
    return match ? match[1] : 'text';
  }, [className]);

  // 提取代码文本（从 <code> 的子元素中递归提取文本）
  const code = useMemo(() => {
    const extractText = (node: ReactNode): string => {
      if (typeof node === 'string') return node;
      if (typeof node === 'number') return String(node);
      if (isValidElement(node)) {
        const childArr = Children.toArray((node.props as any)?.children || []);
        const text = childArr.map(extractText).join('');
        return text;
      }
      if (Array.isArray(node)) {
        return node.map(extractText).join('');
      }
      return '';
    };
    return extractText(children);
  }, [children]);

  // 没有代码内容时回退到默认渲染
  if (!code?.trim()) {
    return <pre className={className}>{children}</pre>;
  }

  // 使用表格风格代码展示组件
  return (
    <CodeTableView
      code={code}
      language={lang}
      showLineNumbers={true}
    />
  );
});

OpenCodeStyleCodeBlock.displayName = 'OpenCodeStyleCodeBlock';