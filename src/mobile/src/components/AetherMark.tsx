// Aether Brand Mark — 极简几何标识（替代 generic AI / Sparkles）
// 品牌蓝渐变四角星（指挥中心/信号 意象），克制、无发光
interface Props {
  size?: number;
  className?: string;
}

export default function AetherMark({ size = 44, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      aria-label="Aether"
      role="img"
    >
      <defs>
        <linearGradient id="aether-mark-g" x1="6" y1="6" x2="42" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#54a0ee" />
          <stop offset="1" stopColor="#3d7fd6" />
        </linearGradient>
      </defs>
      {/* 四角星（棱形旋转 45°） */}
      <path
        d="M24 4 C26 18 30 22 44 24 C30 26 26 30 24 44 C22 30 18 26 4 24 C18 22 22 18 24 4 Z"
        fill="url(#aether-mark-g)"
      />
      {/* 中心信号点 */}
      <circle cx="24" cy="24" r="4.5" fill="rgba(255,255,255,0.92)" />
    </svg>
  );
}