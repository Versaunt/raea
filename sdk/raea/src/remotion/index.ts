// Remotion's API answered by raea, so a Remotion project renders unchanged: `import ... from "remotion"` resolves here
// (engine/bundle edit.rs). raea ships the same names for most of it (AbsoluteFill, Sequence, Series, Loop, Freeze, Img,
// Audio, Video, staticFile, interpolate, spring, Easing, Composition, registerRoot, useCurrentFrame, useVideoConfig);
// this adds the rest: delayRender and continueRender (on raea's frame hold), OffthreadVideo and the
// Html5 names (raea's Video already decodes off the page), random and interpolateColors with Remotion's exact results,
// Still, Folder, prefetch and the environment calls.
import { createElement, Fragment, useEffect, useReducer, type ReactNode } from "react";
import { Composition as RaeaComposition, interpolate, Video, Audio, type CompositionProps } from "../index";
import { installDocument } from "./document";
import { installPageCanvas } from "./canvas";

export * from "../index";
export { Video as OffthreadVideo, Video as Html5Video, Audio as Html5Audio };

let handles = 0;
/** raea holds a frame until its fonts and media load, so a delay is a handle and nothing more. */
// raea's frame hold (runtime/bundle entry.rs HOLD, the one sdk/r3f's Suspense uses): a frame isn't taken while a
// handle is open, and the last one let go draws the frame again (an ad that mounts its scene once its fonts load)
type Hold = { n: number; wake: Set<() => void> };
const HOLD = ((globalThis as { __raeaHold?: Hold }).__raeaHold ??= { n: 0, wake: new Set() });
const open = new Set<number>();
let timedOut: string | null = null;
const onTimeout = new Set<() => void>();
export const delayRender = (label?: string, opts?: { timeoutInMilliseconds?: number }): number => {
  const h = ++handles;
  open.add(h);
  HOLD.n++;
  // Remotion's timeout (30 s unless given): a handle never let go fails the render, as in Remotion, not hold it for ever
  const ms = opts?.timeoutInMilliseconds ?? 30000;
  if (typeof setTimeout === "function") setTimeout(() => {
    if (!open.has(h)) return;
    // Remotion fails the render here; so does raea (a frame taken without it was a blank film that looked done): the
    // hold let go, the composition throws when it's drawn again (Composition below)
    timedOut = `delayRender("${label ?? ""}") wasn't let go after ${ms} ms (Remotion's timeout): the render can't take a frame without it`;
    for (const f of [...onTimeout]) f();
    continueRender(h);
  }, ms);
  return h;
};
export const continueRender = (handle: number): void => {
  if (!open.delete(handle)) return;
  HOLD.n = Math.max(0, HOLD.n - 1);
  if (HOLD.n === 0) for (const w of [...HOLD.wake]) w();
};
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
/** Composition, its component failing the render once a delayRender has timed out (as Remotion's render fails) */
const guarded = new WeakMap<object, unknown>();
function guard(c: unknown): unknown {
  if (typeof c !== "function" && (typeof c !== "object" || c === null)) return c;
  let g = guarded.get(c as object);
  if (!g) {
    g = (props: Record<string, unknown>) => {
      const [, bump] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        onTimeout.add(bump);
        return () => void onTimeout.delete(bump);
      }, []);
      if (timedOut) throw new Error(timedOut);
      return createElement(c as never, props as never);
    };
    guarded.set(c as object, g);
  }
  return g;
}
export function Composition(props: CompositionProps) {
  const p = props as CompositionProps & { component?: unknown };
  return createElement(RaeaComposition as never, ("component" in p ? { ...p, component: guard(p.component) } : p) as never);
}

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
// HTML-in-canvas (Remotion's experimental <HtmlInCanvas>, behind @remotion/transitions' dissolve/swap/book-flip and
// @remotion/motion-blur's HtmlInCanvasMotionBlur): not supported here, as in a browser without it. The packages read
// these at load, so CameraMotionBlur and the other presentations import fine; a presentation that needs it says so.
export const HTML_IN_CANVAS_UNSUPPORTED_MESSAGE = "HTML-in-canvas isn't supported by raea's renderer";
export const getHtmlInCanvasUnsupportedMessage = () => HTML_IN_CANVAS_UNSUPPORTED_MESSAGE;
export const isHtmlInCanvasSupported = () => false;
export const HtmlInCanvas = Object.assign(({ children }: { children?: ReactNode }) => createElement(Fragment, null, children), { isSupported: () => false });
const passthrough = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children);
/** Remotion's Studio-editable wrappers: drawn as their children (the schemas are the Studio's) */
type Schema = Record<string, { default?: unknown } | undefined>;
export const Interactive = Object.assign(passthrough, {
  baseSchema: {},
  premountSchema: {},
  /** the component with its schema's defaults under the props it's given */
  withSchema: ({ Component, schema }: { Component: (p: Record<string, unknown>) => ReactNode; schema?: Schema }) => {
    const defaults = Object.fromEntries(Object.entries(schema ?? {}).filter(([, v]) => v && "default" in v).map(([k, v]) => [k, v!.default]));
    return (props: Record<string, unknown>) => createElement(Component as never, { ...defaults, ...props } as never);
  },
});
export const Internals = {
  ...NoReactInternals,
  HtmlInCanvasFallback: ({ children, style }: { children?: ReactNode; style?: Record<string, unknown> }) => createElement("div", { style }, children),
  DisableSequenceRegistrationProvider: passthrough,
  useHtmlInCanvasUnsupportedMessage: getHtmlInCanvasUnsupportedMessage,
};

export { addFontFace } from "./face";

// the browser globals Remotion code reaches for off the page (document.createElement("canvas"), document.fonts,
// FontFace): installed once, where there is no document
installDocument();
// a <canvas> on the page drawn through raea's own Canvas 2D (getContext("2d"))
installPageCanvas();
