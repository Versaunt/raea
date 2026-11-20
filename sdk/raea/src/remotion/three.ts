// @remotion/three's ThreeCanvas answered by raea. When the lab captured the canvas in Chrome (gaas-video-lab
// scripts/three-layer.mjs: three.js drawn by WebGL, as Remotion renders it, its pixels kept as a transparent VP9 WebM,
// public/three-layers/<composition folder>/<width>x<height>.webm, one frame for each of the composition's), that layer
// plays in the canvas's box, frame for frame, under the page's own transforms and stacking: the 3D as Chrome drew it.
// Without one, its React Three Fiber scene is read by raea's R3F reader (raea/r3f, docs/r3f.feature R3F1: R3F's
// reconciler runs headless with a stand-in renderer, no WebGL, and the three.js scene becomes raea's parts, drawn by
// Bevy), whose lights, tone mapping and materials aren't three.js's: it says so once.
import { createElement, type CSSProperties, type ReactNode } from "react";
import { R3F } from "@raea/r3f";
import { Video, staticFile } from "../index";
import { useClockState, useLocalTime } from "@raea/app/clock";

type ThreeCanvasProps = { width: number; height: number; children?: ReactNode; style?: CSSProperties; [k: string]: unknown };

const g = globalThis as { __raea_call?: (n: string, a: string) => string | undefined };
const call = (name: string, args: unknown) => {
  const out = g.__raea_call?.(name, JSON.stringify(args));
  return out ? JSON.parse(out) : null;
};

/** The captured layer for a canvas of this size, by its staticFile URL; null when there's none (each size looked up once). */
const layers = new Map<string, string | null>();
function layer(width: number, height: number): string | null {
  const size = `${width}x${height}`;
  if (!layers.has(size)) {
    const comp = call("composition.dir", {}) as { dir: string | null; newest: number | null } | null;
    const name = comp?.dir?.split(/[\\/]/).filter(Boolean).pop();
    const src = name ? staticFile(`three-layers/${name}/${size}.webm`) : null;
    const found = src ? (call("media.find", { src }) as { path: string | null; mtime: number | null } | null) : null;
    if (found?.path && comp?.newest && found.mtime !== null && found.mtime < comp.newest) {
      throw new Error(`ThreeCanvas: ${found.path} was captured before the composition's code last changed: capture it again (node scripts/three-layer.mjs ${name})`);
    }
    if (!found?.path) {
      console.warn(`ThreeCanvas ${size}: no layer captured in Chrome (public/three-layers/${name ?? "?"}/${size}.webm), so raea's R3F reader draws the 3D: its lights, tone mapping and materials aren't three.js's (node scripts/three-layer.mjs ${name ?? "<ad>"} captures it)`);
    }
    layers.set(size, found?.path ? src : null);
  }
  return layers.get(size)!;
}

export function ThreeCanvas({ width, height, children, style, gl: _gl, frameloop: _f, dpr: _d, events: _e, ...config }: ThreeCanvasProps) {
  const src = layer(width, height);
  // the layer's frames are the composition's (a frozen canvas was captured frozen at each): the video starts where
  // the composition's frame less the canvas's own puts it, so it shows the composition's frame
  const local = useLocalTime("ThreeCanvas").frame;
  const frame = useClockState("ThreeCanvas").frame;
  if (src) {
    return createElement("div", { style: { position: "relative", width, height, ...style } },
      createElement(Video as never, { src, startFrom: frame - local, style: { position: "absolute", inset: 0, width, height } } as never));
  }
  return createElement("div", { "data-raea-3d-hole": "", style: { position: "relative", width, height, ...style } }, createElement(R3F as never, config as never, children));
}
export { useVideoTexture, useOffthreadVideoTexture } from "./three-video";
