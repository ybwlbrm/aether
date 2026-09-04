/**
 * Apple iOS-26 Liquid Glass SVG filter —— SDF 边缘折射 + RGB 通道色散
 *
 * 与桌面端 EXE 完全一致的实现：
 * - SDF (Signed Distance Field) displacement map 让边缘产生液态折射
 * - RGB 三通道分别以不同 scale 位移，产生彩边（色散）
 * - Chromium（Android WebView）完整支持 backdrop-filter: url(#)
 * - 不支持的浏览器自动降级为 blur + saturate
 */
export function LiquidGlassFilter() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
    >
      <defs>
        <filter id="liquid-lens" colorInterpolationFilters="sRGB" x="-20%" y="-20%" width="140%" height="140%">
          {/* SDF displacement map —— 以中性灰(128,128)为基准位移，边缘产生液态放大效果 */}
          <feImage href="liquid-lens-map.png" preserveAspectRatio="none" x="0" y="0" width="100%" height="100%" result="map" />

          {/* 红通道色散：R 通道位移 scale -44 */}
          <feDisplacementMap in="SourceGraphic" in2="map" scale="-44" xChannelSelector="R" yChannelSelector="G" result="shiftR" />
          <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" in="shiftR" result="dR" />

          {/* 绿通道色散：scale -38 */}
          <feDisplacementMap in="SourceGraphic" in2="map" scale="-38" xChannelSelector="R" yChannelSelector="G" result="shiftG" />
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" in="shiftG" result="dG" />

          {/* 蓝通道色散：scale -32 */}
          <feDisplacementMap in="SourceGraphic" in2="map" scale="-32" xChannelSelector="R" yChannelSelector="G" result="shiftB" />
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" in="shiftB" result="dB" />

          <feBlend in="dR" in2="dG" mode="screen" result="dRG" />
          <feBlend in="dRG" in2="dB" mode="screen" />
        </filter>
      </defs>
    </svg>
  );
}