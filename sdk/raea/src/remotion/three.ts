// @remotion/three's ThreeCanvas answered by raea: real three.js and React Three Fiber, drawing on the canvas's real
// WebGL 2 context (sdk/raea/src/webgl, ANGLE in Rust: runtime/webgl/PROTOCOL.md). A <canvas> goes on the page; R3F's
// own root is made on it and configured as R3F's <Canvas> would be (R3F builds the THREE.WebGLRenderer from `gl`), at
// the canvas's size, dpr 1, frameloop "never", no events, nothing measured. Each frame the children are rendered into
// that root synchronously, inside every context from outside (so useCurrentFrame, useVideoConfig and Sequence offsets
// read the same in the scene), and advance() runs its useFrame callbacks and draws once. What's drawn goes to the page
// by itself (the context hands the canvas its frame when a draw lands in its drawing buffer).
//
// Time: R3F's clock is the frame's, local frame / fps, never the wall clock. The scene steps frame by frame from 0 as
// it plays, as raea's R3F reader does (sdk/r3f session.ts), so state a useFrame keeps is the same whichever frame came
// before: the next frame (playing) goes on from the last one; any other (a render of one frame, a jump ahead, a seek
// back) starts the scene again from frame 0 and steps to it with three's drawing turned off (React and useFrame run,
// gl.render and gl.clear do nothing), on the same renderer, drawing only the frame asked for. A jump ahead starts
// again too because the frames between are stepped with the frame asked for's children: going on from the last frame
// kept the objects its children had mounted (R3F only remakes an object whose `args` changed when a later sibling
// updates in the same commit), so a frame came out differently after another than alone, as Chrome draws it.
import { Component, createElement, useContext, useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import * as THREE from "three";
import { _roots, advance, context, createRoot, extend, flushSync, reconciler, type ReconcilerRoot, type RenderProps, type RootState, type RootStore } from "@react-three/fiber";
import { ClockContext, LocalTimeContext } from "@raea/app/clock";
import { FiberOf, useBridge } from "@raea/r3f/input/bridge";
import { Held, useWake } from "@raea/r3f/input/hold";
import { continueRender, delayRender, Sequence, useCurrentFrame, useVideoConfig } from "./index";

// R3F's <Canvas> fills the catalogue (<mesh>, <boxGeometry>...) as it renders; a root of our own does it here
extend(THREE as unknown as Parameters<typeof extend>[0]);

type ThreeCanvasProps = Omit<RenderProps<HTMLCanvasElement>, "size"> & {
  width: number;
  height: number;
  children?: ReactNode;
  style?: CSSProperties;
  /** as Remotion's: the canvas shows from this frame of its parent, for this many frames */
  from?: number;
  durationInFrames?: number;
  [k: string]: unknown;
};

/** One ThreeCanvas's R3F root and where its scene is in time */
interface Live {
  root: ReconcilerRoot<HTMLCanvasElement>;
  store: RootStore;
  fiber: Parameters<typeof reconciler.updateContainer>[1];
  /** R3F has made its renderer (a `gl` function may make it later) */
  ready: boolean;
  ended: boolean;
  /** what failed: R3F making its renderer, or the scene (thrown from ThreeCanvas, so the render fails) */
  error: unknown;
  /** the last local frame stepped, -1 before the first */
  frame: number;
  /** its useFrame callbacks when it last stepped: more on a redraw means part of it mounted late (it suspended) */
  subs: number;
  late: boolean;
  /** its Math.random's state, and the seed it starts again from */
  rand: number;
  seed: number;
  created: boolean;
  onCreated?: (state: RootState) => void;
  /** the frame drawn with what ThreeCanvas last rendered: for a renderer made later */
  draw: () => void;
}

const seedOf = (key: string) => [...key].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) | 0;

/** Math.random as the root's own generator (mulberry32) while `fn` runs, as sdk/r3f session.ts does: drei's phases,
 *  three's uuids, a scene's own Math.random() come out the same each time it is stepped from frame 0 */
function seeded<T>(s: Live, fn: () => T): T {
  const was = Math.random;
  Math.random = () => {
    let t = (s.rand = (s.rand + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return fn();
  } finally {
    Math.random = was;
  }
}

/** What R3F's root is configured with: the ad's <Canvas> settings, at the canvas's size, stepped by raea */
function settings(width: number, height: number, config: Record<string, unknown>): RenderProps<HTMLCanvasElement> {
  const { onCreated: _c, frameloop: _f, dpr: _d, events: _e, eventSource: _s, eventPrefix: _p, resize: _r, fallback: _b, ...rest } = config;
  return { ...(rest as RenderProps<HTMLCanvasElement>), size: { width, height, top: 0, left: 0 }, dpr: 1, frameloop: "never", events: undefined };
}

/** The scene's errors caught inside R3F's root (its reconciler would only log them), for ThreeCanvas to throw */
class Catch extends Component<{ s: Live; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    this.props.s.error ??= e;
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** R3F's Provider: the store to the scene, and once it has mounted the root marked active and onCreated called (once) */
function Provide({ s, children }: { s: Live; children?: ReactNode }) {
  useLayoutEffect(() => {
    const state = s.store.getState();
    state.set((st) => ({ internal: { ...st.internal, active: true } }));
    if (!s.created) {
      s.created = true;
      s.onCreated?.(state);
    }
  }, [s]);
  return createElement(context.Provider, { value: s.store }, createElement(Catch, { s }, children));
}

/** `node` rendered into the root now, not at R3F's next microtask as root.render does (null unmounts the scene) */
function put(s: Live, node: ReactNode) {
  const el = node === null ? null : createElement(Provide, { s }, node);
  seeded(s, () => flushSync(() => reconciler.updateContainer(el, s.fiber, null, () => {})));
  if (s.error) throw s.error;
}

const subsOf = (s: Live) => s.store.getState().internal.subscribers.length;

/** useFrame run at local frame `i`, and three drawing only when `draw` */
function tick(s: Live, i: number, fps: number, draw: boolean) {
  const state = s.store.getState();
  const gl = state.gl as unknown as Record<"render" | "clear", unknown>;
  const { render, clear } = gl;
  if (!draw) gl.render = gl.clear = () => {};
  try {
    seeded(s, () => advance(i / fps, true, state));
  } finally {
    if (!draw) Object.assign(gl, { render, clear });
  }
  if (s.error) throw s.error;
  s.frame = i;
  s.subs = subsOf(s);
}

/** the scene unmounted, its clock and random numbers back at frame 0, to be stepped from there again */
function restart(s: Live) {
  put(s, null);
  const clock = s.store.getState().clock;
  clock.elapsedTime = clock.oldTime = 0;
  s.rand = s.seed;
  s.frame = -1;
  s.subs = 0;
}

/** The scene at local frame `frame` (fps a second) drawn, `scene(i)` rendered for each frame stepped */
function drawTo(s: Live, frame: number, fps: number, scene: (i: number) => ReactNode) {
  if (frame < s.frame || (s.frame >= 0 && frame > s.frame + 1)) restart(s);
  // the same frame again (a load it waited on came, the page rendered it again): its clock stays, it draws again.
  // Parts that mounted only now (they suspended while the frames were stepped) never ran their useFrame: the scene
  // starts again from frame 0 with them there, once
  if (frame === s.frame) {
    put(s, scene(frame));
    if (subsOf(s) <= s.subs || s.late) return tick(s, frame, fps, true);
    s.late = true;
    restart(s);
  }
  for (let i = s.frame + 1; i <= frame; i++) {
    put(s, scene(i));
    tick(s, i, fps, i === frame);
  }
}

/** R3F's root made on the canvas and configured; the frame held until its renderer is made when `gl` is a function */
function start(canvas: HTMLCanvasElement, key: string, width: number, height: number, config: Record<string, unknown>): Live {
  const root = createRoot(canvas);
  const made = _roots.get(canvas)!;
  const seed = seedOf(key);
  const s: Live = {
    root, store: made.store, fiber: made.fiber, ready: false, ended: false, error: null, frame: -1, subs: 0, late: false,
    rand: seed, seed, created: false, onCreated: config.onCreated as Live["onCreated"], draw: () => {},
  };
  const configured = root.configure(settings(width, height, config));
  // with `gl` a WebGLRenderer's parameters (or a renderer) configure has run to its end when it returns: nothing in it
  // waits. A `gl` function is awaited: the frame is held until the renderer is made and the frame drawn on it
  if (typeof config.gl !== "function") {
    s.ready = true;
    return s;
  }
  const hold = delayRender("ThreeCanvas: R3F making its renderer");
  configured
    .then(
      () => {
        s.ready = true;
        if (s.ended) return void s.store.getState().gl.dispose();
        try {
          s.draw();
        } catch (e) {
          s.error ??= e;
        }
      },
      (e) => void (s.error ??= e),
    )
    .finally(() => continueRender(hold));
  return s;
}

/** the scene unmounted and the renderer's GL objects freed (the canvas's context goes with the canvas) */
function end(s: Live) {
  s.ended = true;
  if (!s.ready) return;
  put(s, null);
  s.store.getState().gl.dispose();
  // R3F's own unmount: forgets the canvas and disposes what's left of the scene
  s.root.unmount();
}

type InnerProps = ThreeCanvasProps & { fiber: Parameters<typeof useBridge>[0] };

function Inner({ fiber, width, height, style, children, ...config }: InnerProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const clock = useContext(ClockContext);
  const local = useContext(LocalTimeContext);
  const bridge = useBridge(fiber);
  // rendered again when a load the scene waited on comes (its Suspense held the frame: sdk/r3f hold.tsx)
  useWake();
  const key = useId();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const live = useRef<Live | null>(null);
  // the scene at local frame i: raea's clock as it was then (a copy: the Clock's own state moves on in place, and its
  // readers would subscribe to it), inside every context from outside
  const scene = (i: number) => {
    const c = clock ? { ...clock, frame: clock.frame - frame + i } : null;
    const l = local ? { ...local, frame: i } : null;
    return bridge(createElement(ClockContext, { value: c }, createElement(LocalTimeContext, { value: l }, createElement(Held, null, children))));
  };
  // every commit: the frame drawn before raea takes it (the canvas is on the page by now)
  useLayoutEffect(() => {
    const s = (live.current ??= start(canvas.current!, key, width, height, config));
    if (s.error) throw s.error;
    s.draw = () => drawTo(s, frame, fps, scene);
    if (!s.ready) return;
    // configured again with this render's props, as R3F's <Canvas> does each render
    if (s.frame >= 0) void s.root.configure(settings(width, height, config));
    s.draw();
  });
  useLayoutEffect(() => () => {
    if (live.current) end(live.current);
    live.current = null;
  }, []);
  return createElement("div", { style: { position: "relative", width, height, overflow: "hidden", ...style } },
    createElement("canvas", { ref: canvas, width, height, style: { display: "block", width, height } }));
}

export function ThreeCanvas({ from, durationInFrames, ...props }: ThreeCanvasProps) {
  const canvas = createElement(FiberOf, { children: (fiber) => createElement(Inner, { ...props, fiber } as InnerProps) });
  if (from === undefined && durationInFrames === undefined) return canvas;
  return createElement(Sequence, { from, durationInFrames, layout: "none", name: "<ThreeCanvas>" }, canvas);
}
export { useVideoTexture, useOffthreadVideoTexture } from "./three-video";
