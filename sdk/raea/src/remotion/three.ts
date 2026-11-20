// @remotion/three's ThreeCanvas answered by raea: its React Three Fiber scene read by raea's R3F reader (raea/r3f,
// docs/r3f.feature R3F1: R3F's reconciler runs headless with a stand-in renderer, no WebGL, and the three.js scene
// becomes raea's parts, drawn by Bevy), in a box of the canvas's size where the page puts it.
import { createElement, type CSSProperties, type ReactNode } from "react";
import { R3F } from "@raea/r3f";

type ThreeCanvasProps = { width: number; height: number; children?: ReactNode; style?: CSSProperties; [k: string]: unknown };

export function ThreeCanvas({ width, height, children, style, gl: _gl, frameloop: _f, dpr: _d, events: _e, ...config }: ThreeCanvasProps) {
  return createElement("div", { style: { position: "relative", width, height, ...style } }, createElement(R3F as never, config as never, children));
}
export { useVideoTexture, useOffthreadVideoTexture } from "./three-video";
