/**
 * Apple iOS-26 Liquid Glass SVG filter — SDF 边缘折射 + 三通道色散
 *
 * 核心原理：
 * - 使用 SDF (Signed Distance Field) displacement map，仅边缘弯曲，中心无扭曲
 * - 三通道色散：RGB 通道分别以不同 scale 位移，产生彩虹边缘
 * - Chromium 完整效果（backdrop-filter: url(#) 支持）
 * - Safari/Firefox 自动降级到 blur + saturate
 *
 * SDF map 由 build/gen-liquid-map.js 生成，radius=24px（对应 14px 圆角）
 */
export function LiquidGlassFilter() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
    >
      <filter id="liquid-lens" colorInterpolationFilters="sRGB" x="-20%" y="-20%" width="140%" height="140%">
        {/* SDF displacement map：中心中性灰(128,128)→零位移，边缘渐变向外→放大镜效果 */}
        <feImage href="/liquid-lens-map.png" preserveAspectRatio="none" x="0" y="0" width="100%" height="100%" result="map" />

        {/* 三通道色散：RGB 分别以不同 scale 位移，再合成 */}
        <feDisplacementMap in="SourceGraphic" in2="map" scale="-44" xChannelSelector="R" yChannelSelector="G" result="shiftR" />
        <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" in="shiftR" result="dR" />

        <feDisplacementMap in="SourceGraphic" in2="map" scale="-38" xChannelSelector="R" yChannelSelector="G" result="shiftG" />
        <feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" in="shiftG" result="dG" />

        <feDisplacementMap in="SourceGraphic" in2="map" scale="-32" xChannelSelector="R" yChannelSelector="G" result="shiftB" />
        <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" in="shiftB" result="dB" />

        <feBlend in="dR" in2="dG" mode="screen" result="dRG" />
        <feBlend in="dRG" in2="dB" mode="screen" />
      </filter>
    </svg>
  );
}