/**
 * GradientShimmer — 21st.dev 组件（gradient-shimmer.tsx 从 1.txt 集成）
 * 渐变高光扫过文字，Web-Animations-API 驱动，零运行时依赖，无需 CSS import。
 */
"use client";

import {
  createElement,
  type CSSProperties,
  type ElementType,
  type HTMLAttributes,
  useEffect,
  useMemo,
  useRef,
} from "react";

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

/** A single stop in the highlight band, positioned 0..1 across the sweep. */
export interface GradientStop {
  position: number;
  color: string;
}

export type GradientPresetName =
  | "sunrise"
  | "bubble"
  | "peach"
  | "tonic"
  | "mint"
  | "spring"
  | "twilight"
  | "bay";

/** Either an explicit multi-stop gradient or a built-in preset name. */
export type GradientInput = GradientStop[] | GradientPresetName;

/** Named easing presets for the sweep (no raw cubic-bezier in the public API). */
export type EasingPreset = "smooth" | "gentle" | "snappy";

export interface GradientShimmerProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children"
> {
  /** The text to shimmer. Plain string only — the gradient sweeps over it. */
  children: string;
  /** Multi-stop gradient or a preset name. Defaults to `"sunrise"`. */
  gradient?: GradientInput;
  /** Sweep curve. Defaults to `"smooth"`. */
  easing?: EasingPreset;
  /** Reference sweep speed. Defaults to `1.45`. */
  duration?: number;
  /** Highlight band width in px per character; scales with font size. Defaults to `3`. */
  spread?: number;
  /** Gradient angle in degrees. Defaults to `105`. */
  angle?: number;
  /** Idle gap (ms) after each sweep before the next one. Defaults to `1000`. */
  pauseBetween?: number;
  /** Base text color the band fades into. Defaults to `"currentColor"`. */
  baseColor?: string;
  /** Pause the sweep while the page is scrolling. Defaults to `true`. */
  pauseOnScroll?: boolean;
  /** Pause while outside the viewport. Defaults to `true`. */
  pauseWhenOffscreen?: boolean;
  /** Render a static gradient (no sweep) under `prefers-reduced-motion`. Defaults to `true`. */
  respectReducedMotion?: boolean;
  /** Element to render. Defaults to `"span"`. */
  as?: ElementType;
}

/* -------------------------------------------------------------------------- */
/*  Built-in presets                                                           */
/* -------------------------------------------------------------------------- */

export const gradientPresets: Record<GradientPresetName, GradientStop[]> = {
  sunrise: [
    { color: "#B6D3EF", position: 0 },
    { color: "#CAD1D7", position: 0.153 },
    { color: "#D7CFC8", position: 0.252 },
    { color: "#E1CDB9", position: 0.341 },
    { color: "#EAC6A5", position: 0.424 },
    { color: "#EDB185", position: 0.505 },
    { color: "#EF9B62", position: 0.586 },
    { color: "#F18F60", position: 0.669 },
    { color: "#F48D7A", position: 0.758 },
    { color: "#F78A94", position: 0.857 },
    { color: "#F888A0", position: 1 },
  ],
  bubble: [
    { color: "#F5EBD9", position: 0 },
    { color: "#F2D4DB", position: 0.31 },
    { color: "#EBBDDE", position: 0.5 },
    { color: "#CCBAE3", position: 0.65 },
    { color: "#8CBFF0", position: 0.82 },
    { color: "#78B0FF", position: 1 },
  ],
  peach: [
    { color: "#D9F5FA", position: 0 },
    { color: "#FCD9D6", position: 0.31 },
    { color: "#FCBAC9", position: 0.61 },
    { color: "#F0B3F5", position: 1 },
  ],
  tonic: [
    { color: "#E3EDF0", position: 0 },
    { color: "#E8EBB8", position: 0.27 },
    { color: "#F0DEA3", position: 0.43 },
    { color: "#E8B078", position: 0.75 },
    { color: "#F29682", position: 1 },
  ],
  mint: [
    { color: "#DECEE8", position: 0 },
    { color: "#CBBAEE", position: 0.21 },
    { color: "#7DC0FB", position: 0.46 },
    { color: "#00C7A6", position: 1 },
  ],
  spring: [
    { color: "#F7D5C5", position: 0.07 },
    { color: "#46A8C0", position: 0.58 },
    { color: "#43AE7D", position: 1 },
  ],
  twilight: [
    { color: "#E3CCE6", position: 0 },
    { color: "#4E8CD5", position: 0.35 },
    { color: "#6068C2", position: 0.64 },
    { color: "#38364E", position: 1 },
  ],
  bay: [
    { color: "#DBE3D0", position: 0 },
    { color: "#8DB8A7", position: 0.23 },
    { color: "#2D8E9A", position: 0.42 },
    { color: "#076492", position: 0.59 },
    { color: "#154288", position: 0.79 },
    { color: "#262C81", position: 1 },
  ],
};

/** Named easing presets mapped to their cubic-bezier curves. */
export const easingPresets: Record<EasingPreset, string> = {
  smooth: "cubic-bezier(0.45, 0, 0.55, 1)",
  gentle: "cubic-bezier(0.76, 0, 0.24, 1)",
  snappy: "cubic-bezier(0.3, 0, 0.2, 1)",
};

/* -------------------------------------------------------------------------- */
/*  Band gradient builder                                                      */
/* -------------------------------------------------------------------------- */

const BAND_CORE_RATIO = 0.44;

export function buildBandGradient(
  stops: GradientStop[],
  angle: number,
): string {
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const first = sorted[0]?.color ?? "white";
  const last = sorted[sorted.length - 1]?.color ?? "white";

  const core = sorted
    .map((stop) => {
      const factor = (stop.position - 0.5) * 2 * BAND_CORE_RATIO;
      return `${stop.color} calc(50% + var(--gs-spread-mid) * ${factor.toFixed(4)})`;
    })
    .join(", ");

  return [
    `linear-gradient(${angle}deg`,
    `var(--gs-base) calc(50% - var(--gs-spread))`,
    `color-mix(in oklab, var(--gs-base) 42%, ${first}) calc(50% - var(--gs-spread-mid))`,
    core,
    `color-mix(in oklab, var(--gs-base) 42%, ${last}) calc(50% + var(--gs-spread-mid))`,
    `var(--gs-base) calc(50% + var(--gs-spread)))`,
  ].join(", ");
}

/* -------------------------------------------------------------------------- */
/*  Visibility / capability gates (SSR-safe)                                   */
/* -------------------------------------------------------------------------- */

function supportsBackgroundClipText(): boolean {
  if (typeof window === "undefined") return true;
  if (typeof window.CSS?.supports !== "function") return false;
  return (
    window.CSS.supports("background-clip", "text") ||
    window.CSS.supports("-webkit-background-clip", "text")
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

interface GateOptions {
  pauseOnScroll: boolean;
  pauseWhenOffscreen: boolean;
}

const VIEWPORT_ROOT_MARGIN = "160px";
const SCROLL_IDLE_MS = 120;

function observeShimmerActive(
  el: Element,
  { pauseOnScroll, pauseWhenOffscreen }: GateOptions,
  onChange: (active: boolean) => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  let inViewport =
    !pauseWhenOffscreen || typeof IntersectionObserver === "undefined";
  let pageVisible = typeof document === "undefined" ? true : !document.hidden;
  let notScrolling = true;
  const compute = () => onChange(inViewport && pageVisible && notScrolling);

  let io: IntersectionObserver | undefined;
  if (pauseWhenOffscreen && typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        inViewport = entry.isIntersecting;
        compute();
      },
      { rootMargin: VIEWPORT_ROOT_MARGIN },
    );
    io.observe(el);
  }

  const onVisibility = () => {
    pageVisible = !document.hidden;
    compute();
  };
  document.addEventListener("visibilitychange", onVisibility);

  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  const onScroll = () => {
    notScrolling = false;
    compute();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      notScrolling = true;
      compute();
    }, SCROLL_IDLE_MS);
  };
  const scrollOpts = { passive: true, capture: true } as const;
  if (pauseOnScroll) window.addEventListener("scroll", onScroll, scrollOpts);

  compute();

  return () => {
    io?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    if (pauseOnScroll)
      window.removeEventListener("scroll", onScroll, { capture: true });
    clearTimeout(scrollTimer);
  };
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                  */
/* -------------------------------------------------------------------------- */

const FALLBACK_TEXT_WIDTH_PX = 96;
const MAX_SPREAD_PX = 48;
const SPREAD_MID_RATIO = 0.72;
const BASE_FONT_PX = 14;
const DEFAULT_DURATION_SECONDS = 1.45;
const DEFAULT_SPREAD = 3;
const DEFAULT_ANGLE = 105;

function resolveStops(gradient: GradientInput | undefined): GradientStop[] {
  if (!gradient) return gradientPresets.sunrise;
  if (typeof gradient === "string")
    return gradientPresets[gradient] ?? gradientPresets.sunrise;
  return gradient;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function revealNormalText(el: HTMLElement) {
  el.style.removeProperty("background-image");
  el.style.removeProperty("-webkit-text-fill-color");
}

export function GradientShimmer({
  children,
  gradient,
  easing = "smooth",
  duration = DEFAULT_DURATION_SECONDS,
  spread = DEFAULT_SPREAD,
  angle = DEFAULT_ANGLE,
  pauseBetween = 1000,
  baseColor = "currentColor",
  pauseOnScroll = true,
  pauseWhenOffscreen = true,
  respectReducedMotion = true,
  as = "span",
  className,
  style,
  ...restProps
}: GradientShimmerProps) {
  const ref = useRef<HTMLElement | null>(null);
  const safeDuration = Math.max(
    0.001,
    finiteOr(duration, DEFAULT_DURATION_SECONDS),
  );
  const safeSpread = Math.max(0, finiteOr(spread, DEFAULT_SPREAD));
  const safeAngle = finiteOr(angle, DEFAULT_ANGLE);
  const stops = useMemo(() => resolveStops(gradient), [gradient]);
  const backgroundImage = useMemo(
    () => buildBandGradient(stops, safeAngle),
    [stops, safeAngle],
  );
  const easingValue = easingPresets[easing] ?? easingPresets.smooth;

  const initialSpread = Math.min(children.length * safeSpread, MAX_SPREAD_PX);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const textWidth =
        el.getBoundingClientRect().width || FALLBACK_TEXT_WIDTH_PX;
      const fontSize =
        Number.parseFloat(getComputedStyle(el).fontSize) || BASE_FONT_PX;
      const fontScale = fontSize / BASE_FONT_PX;
      const spreadPx = Math.min(
        children.length * safeSpread * fontScale,
        MAX_SPREAD_PX * fontScale,
      );
      const layerWidth = Math.max(1, textWidth + spreadPx * 2);
      const start = -spreadPx - layerWidth / 2;
      const end = textWidth + spreadPx - layerWidth / 2;
      const durationMs = safeDuration * 1000;
      el.style.setProperty("--gs-spread", `${spreadPx}px`);
      el.style.setProperty(
        "--gs-spread-mid",
        `${spreadPx * SPREAD_MID_RATIO}px`,
      );
      el.style.backgroundSize = `${layerWidth}px 100%`;
      return { start, end, durationMs };
    };

    if (!supportsBackgroundClipText()) {
      revealNormalText(el);
      return;
    }

    measure();

    if (respectReducedMotion && prefersReducedMotion()) return;
    if (typeof el.animate !== "function") return;

    let anim: Animation | null = null;
    let pauseTimer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    let cancelled = false;

    const runSweep = () => {
      if (cancelled) return;
      const { start, end, durationMs } = measure();
      const next = el.animate(
        [
          { backgroundPosition: `${start}px center` },
          { backgroundPosition: `${end}px center` },
        ],
        { duration: durationMs, easing: easingValue, fill: "forwards" },
      );
      if (!active) next.pause();
      anim?.cancel();
      anim = next;
      next.onfinish = () => {
        pauseTimer = setTimeout(runSweep, Math.max(0, pauseBetween));
      };
    };

    const stopVisibility = observeShimmerActive(
      el,
      { pauseOnScroll, pauseWhenOffscreen },
      (next) => {
        active = next;
        if (anim) {
          if (active) anim.play();
          else anim.pause();
        }
      },
    );

    runSweep();

    return () => {
      cancelled = true;
      anim?.cancel();
      clearTimeout(pauseTimer);
      stopVisibility();
    };
  }, [
    children,
    safeSpread,
    safeDuration,
    easingValue,
    pauseBetween,
    pauseOnScroll,
    pauseWhenOffscreen,
    respectReducedMotion,
  ]);

  const mergedStyle: CSSProperties = {
    position: "relative",
    display: "inline-block",
    backgroundImage,
    backgroundRepeat: "no-repeat",
    backgroundSize: "100% 100%",
    backgroundColor: "var(--gs-base)",
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    WebkitTextFillColor: "transparent",
    ["--gs-base" as string]: baseColor,
    ["--gs-spread" as string]: `${initialSpread}px`,
    ["--gs-spread-mid" as string]: `${initialSpread * SPREAD_MID_RATIO}px`,
    ...style,
  };

  return createElement(
    as,
    { ...restProps, ref, className, style: mergedStyle },
    children,
  );
}

export default GradientShimmer;