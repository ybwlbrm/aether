/**
 * 统一加载指示器（W4-6：替代各处手写 .spinner 内联样式）
 */
interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  style?: React.CSSProperties;
}

export function Spinner({ size = 'md', className = '', style }: SpinnerProps) {
  const classMap = { sm: 'spinner spinner-sm', md: 'spinner', lg: 'spinner spinner-lg' };
  return <div data-slot="spinner" role="status" aria-label="加载中" className={`${classMap[size]} ${className}`} style={style} />;
}