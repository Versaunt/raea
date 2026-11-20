// Remotion's API answered by raea, so a Remotion project renders unchanged: `import ... from "remotion"` resolves here
// (engine/bundle edit.rs). raea ships the same names for most of it (AbsoluteFill, Sequence, Series, Loop, Freeze, Img,
// Audio, Video, staticFile, interpolate, spring, Easing, Composition, registerRoot, useCurrentFrame, useVideoConfig);
// this adds the rest: delayRender and continueRender (raea waits for fonts and media itself), OffthreadVideo and the
// Html5 names (raea's Video already decodes off the page), random and interpolateColors with Remotion's exact results,
// Still, Folder, prefetch and the environment calls.
import { createElement, Fragment, type ReactNode } from "react";
import { Composition, interpolate, Video, Audio, type CompositionProps } from "../index";
import { native, hasNative } from "@raea/app/native";

export * from "../index";
export { Video as OffthreadVideo, Video as Html5Video, Audio as Html5Audio };

let handles = 0;
/** raea holds a frame until its fonts and media load, so a delay is a handle and nothing more. */
export const delayRender = (_label?: string, _opts?: unknown): number => ++handles;
export const continueRender = (_handle: number): void => {};
export const cancelRender = (err: unknown): never => {
  throw err instanceof Error ? err : new Error(String(err));
};
export const useDelayRender = () => ({ delayRender, continueRender, cancelRender });

/** The props a render was given: raea's --input file, else none. */
export const getInputProps = (): Record<string, unknown> => {
  const g = globalThis as { __raea_input_props?: Record<string, unknown> };
  return g.__raea_input_props ?? {};
};

const ENV = { isStudio: false, isRendering: true, isPlayer: false, isReadOnlyStudio: false, isClientSideRendering: false };
export const getRemotionEnvironment = () => ENV;
export const useRemotionEnvironment = () => ENV;
export const useCurrentScale = () => 1;
export const usePixelDensity = () => 1;
export const VERSION = "4.0.0-raea";

// random(): Remotion's mulberry32 over a string's hash or a number × 1e10, so the same seed gives the same value
function mulberry32(a: number): number {
  let t = a + 1831565813;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
export function random(seed: number | string | null, dummy?: unknown): number {
  if (dummy !== undefined) throw new TypeError("random() takes only one argument");
  if (seed === null) return Math.random();
  if (typeof seed === "string") return mulberry32(hashCode(seed));
  if (typeof seed === "number") return mulberry32(seed * 10000000000);
  throw new Error("random() argument must be a number or a string");
}

// interpolateColors(): channels interpolated in RGBA, clamped, rounded as Remotion rounds them (alpha to 3 places)
const NAMED: Record<string, string> = {
  transparent: "#0000", black: "#000", white: "#fff", red: "#f00", lime: "#0f0", green: "#008000", blue: "#00f",
  yellow: "#ff0", cyan: "#0ff", aqua: "#0ff", magenta: "#f0f", fuchsia: "#f0f", gray: "#808080", grey: "#808080",
  silver: "#c0c0c0", maroon: "#800000", olive: "#808000", purple: "#800080", teal: "#008080", navy: "#000080",
  orange: "#ffa500", pink: "#ffc0cb", gold: "#ffd700", indigo: "#4b0082", violet: "#ee82ee", brown: "#a52a2a",
  coral: "#ff7f50", crimson: "#dc143c", salmon: "#fa8072", tomato: "#ff6347", khaki: "#f0e68c", beige: "#f5f5dc",
};
function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 360;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
export function parseColor(input: string): [number, number, number, number] {
  const c = (NAMED[input.trim().toLowerCase()] ?? input).trim();
  const hex = c.match(/^#([0-9a-f]{3,8})$/i)?.[1];
  if (hex) {
    const x = hex.length <= 4 ? [...hex].map((d) => d + d).join("") : hex;
    return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16), x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1];
  }
  const fn = c.match(/^(rgba?|hsla?)\((.*)\)$/i);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    const num = (p: string, scale: number) => (p.endsWith("%") ? (parseFloat(p) / 100) * scale : parseFloat(p));
    const a = parts[3] !== undefined ? num(parts[3], 1) : 1;
    if (fn[1].toLowerCase().startsWith("rgb")) return [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255), a];
    const [r, g, b] = hsl2rgb(parseFloat(parts[0]), num(parts[1], 1) / (parts[1].endsWith("%") ? 1 : 100), num(parts[2], 1) / (parts[2].endsWith("%") ? 1 : 100));
    return [r, g, b, a];
  }
  throw new Error(`interpolateColors: can't read the colour ${JSON.stringify(input)}`);
}
type ColorOpts = { easing?: (t: number) => number; posterize?: number };
export function interpolateColors(input: number, inputRange: readonly number[], outputRange: readonly string[], options?: ColorOpts): string {
  if (inputRange.length !== outputRange.length) throw new TypeError("inputRange and outputRange must have the same length");
  const cs = outputRange.map(parseColor);
  const ch = (i: number) => {
    const v = interpolate(input, inputRange as number[], cs.map((c) => (i === 3 ? c[3] : Math.round(c[i]))), { easing: options?.easing, extrapolateLeft: "clamp", extrapolateRight: "clamp" } as never) as number;
    return i === 3 ? Number(v.toFixed(3)) : Math.round(v);
  };
  return `rgba(${ch(0)}, ${ch(1)}, ${ch(2)}, ${ch(3)})`;
}

/** A one-frame composition. */
export function Still(props: Omit<CompositionProps, "durationInFrames" | "fps"> & { fps?: number; durationInFrames?: number }) {
  return createElement(Composition as never, { fps: 30, ...props, durationInFrames: 1 } as never);
}
/** A folder in Remotion's studio: its compositions as they are. */
export function Folder(props: { name: string; children?: ReactNode }) {
  return createElement(Fragment, null, props.children);
}
/** raea loads every file a frame uses before drawing it: a prefetch is a no-op that resolves to its src. */
export const prefetch = (src: string, _o?: unknown) => ({ free: () => {}, waitUntilDone: () => Promise.resolve(src) });
export const getStaticFiles = () => [];
export const watchStaticFile = () => ({ cancel: () => {} });

/** `remotion/no-react` and the font loaders' internals: a font's data is its URL (raea fetches it, `fonts.face`). */
export const NoReactInternals = {
  ENABLE_V5_BREAKING_CHANGES: false,
  fetchFontData: (url: string) => Promise.resolve(url),
  registerFontFace: (_: unknown) => {},
};
export const Internals = { ...NoReactInternals };

/** A font face for the page, as @font-face gives one: `src` a URL (staticFile, http) or the URL fetchFontData handed back. */
export function addFontFace(family: string, src: string, descriptors: { weight?: string | number; style?: string } = {}): void {
  if (!hasNative()) return;
  const url = String(src).replace(/^url\((['"]?)(.*)\1\)(\s+format\(.*\))?$/, "$2");
  native("fonts.face" as never, { family, url, weight: String(descriptors.weight ?? "400"), style: descriptors.style ?? "normal" } as never);
}
