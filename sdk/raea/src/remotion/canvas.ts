// A <canvas> on the page drawn the web's way: `ref.current.getContext("2d")` is raea's own CanvasRenderingContext2D
// (sdk/ui: text, gradients, images, transforms, clips, shadows, compositing), not bevy-react's small recorder. Its
// display list goes to the element as its `__canvas2d` prop, which raea's page draws into the canvas's bitmap
// (systems/page-ops, systems/canvas) and shows in its box, as a Blitz page shows a DOM canvas. The bitmap is the
// element's width x height props (300 x 150 unless given), read off bevy-react's op batches (its bridge tap).
// `getContext("webgl2")` is raea's WebGL 2 (sdk/raea/src/webgl, runtime/webgl/PROTOCOL.md): a microtask after it draws
// into its drawing buffer, the buffer is snapshot as the canvas's next frame and the element's `__webgl` prop names it
// ({ ctx, gen, w, h }), which page-ops takes from raea_sys_canvas::frames as the node's picture.
import { BevyCanvasElement } from "bevy-react";
import { __installBridgeTap, flush, push } from "../../node_modules/bevy-react/src/bridge";
import { CanvasRenderingContext2D_ } from "../../ui/canvas";
import { WebGL2RenderingContext_ } from "../webgl";
import { CANVAS, Style, glDataUrl } from "./document";

const sizes = new Map<number, { w: number; h: number }>();
type Op = { op: string; id?: number; kind?: string; props?: Record<string, unknown>; parent?: number; child?: number };
type El = { id: number; __ctx2d?: CanvasRenderingContext2D_; __gl?: WebGL2RenderingContext_; __style?: Style; toDataURL(): string };

/** The on-page canvases' WebGL contexts by node id, destroyed when their node leaves the page. */
const gls = new Map<number, { el: El; ctx: WebGL2RenderingContext_ }>();
/** Each node's parent as the ops put it, so a canvas inside a removed subtree is found (React removes only the
 *  subtree's top). Removed tops wait in `gone` until the entries under them are pruned. */
const parents = new Map<number, number>();
const gone = new Set<number>();

const size = (id: number) => sizes.get(id) ?? { w: 300, h: 150 };

function destroy(id: number) {
  const g = gls.get(id);
  if (!g) return;
  gls.delete(id);
  sizes.delete(id);
  g.el.__gl = undefined;
  g.ctx._destroy();
}

/** Node `id` is off the page: the WebGL contexts of the canvases in it are destroyed. */
function removed(id: number) {
  for (const cid of [...gls.keys()]) {
    for (let n: number | undefined = cid; n !== undefined; n = parents.get(n)) {
      if (n === id) { destroy(cid); break; }
    }
  }
  parents.delete(id);
  gone.add(id);
  if (gone.size < 256) return;
  for (const k of [...parents.keys()]) {
    let n = k;
    while (parents.has(n)) n = parents.get(n)!;
    if (gone.has(n)) parents.delete(k);
  }
  gone.clear();
}

export function installPageCanvas() {
  const proto = BevyCanvasElement.prototype as unknown as Record<string | symbol, unknown> & { getContext(kind?: string, attrs?: Record<string, unknown>): unknown; __raea2d?: boolean };
  if (proto.__raea2d) return;
  proto.__raea2d = true;
  proto[CANVAS] = true;
  __installBridgeTap({
    flush(batch: Op[]) {
      for (const op of batch) {
        if (op.op === "reset") { for (const id of [...gls.keys()]) destroy(id); parents.clear(); gone.clear(); continue; }
        if ((op.op === "append" || op.op === "insert") && op.child !== undefined && op.parent !== undefined) { parents.set(op.child, op.parent); continue; }
        if (op.op === "remove" && op.child !== undefined) { removed(op.child); continue; }
        if ((op.op !== "create" && op.op !== "update") || op.kind !== "canvas" || op.id === undefined || !op.props) continue;
        if (op.props.width == null && op.props.height == null && sizes.has(op.id)) continue;
        const was = size(op.id);
        const s = { ...was };
        if (op.props.width != null) s.w = Number(op.props.width) || 0;
        if (op.props.height != null) s.h = Number(op.props.height) || 0;
        sizes.set(op.id, s);
        // the WebGL drawing buffer follows the element's size (three's setSize, or React's width and height props)
        if (was.w !== s.w || was.h !== s.h) gls.get(op.id)?.ctx._resize(s.w, s.h);
      }
    },
    emit() {}, request() {}, outbound() {}, wrapStart() {}, wrapEnd() {},
  } as never);
  const own = proto.getContext;
  proto.getContext = function (this: El, kind?: string, attrs?: Record<string, unknown>) {
    // a canvas has one kind of context, as in a browser: asked for the other kind, it answers null
    if (kind === "webgl2") return this.__ctx2d ? null : (this.__gl ?? webgl(this, attrs));
    // no WebGL 1: three r178 is WebGL 2 only, and matching Chrome's WebGL 1 isn't a goal
    if (kind === "webgl" || kind === "experimental-webgl") return null;
    if (kind !== "2d") return own.call(this);
    if (this.__gl) return null;
    if (this.__ctx2d) return this.__ctx2d;
    const id = this.id;
    const host = {
      __wid: id,
      _wired: true,
      get width() { return size(id).w; },
      get height() { return size(id).h; },
      getAttribute: (k: string) => (k === "width" ? String(size(id).w) : k === "height" ? String(size(id).h) : null),
    };
    const ctx = new CanvasRenderingContext2D_(host as never);
    // what's drawn goes to the element at the next microtask (sdk/ui sends it over its own DOM wire)
    const c = ctx as unknown as { pending: boolean; gen: number; size: [number, number]; list: unknown[]; send(): void };
    c.send = function () {
      if (c.pending) return;
      c.pending = true;
      queueMicrotask(() => {
        c.pending = false;
        push({ op: "update", id, kind: "canvas", props: { __canvas2d: { gen: c.gen, w: c.size[0], h: c.size[1], ops: c.list.slice() } } } as never);
        flush();
      });
    };
    return (this.__ctx2d = ctx);
  };

  // what three.js and R3F read and write on a canvas element: its bitmap's size (the width and height props, set
  // through the bridge), a style, events, its box, its pixels
  const def = (k: string, d: PropertyDescriptor) => Object.defineProperty(proto, k, { configurable: true, ...d });
  const dim = (k: "w" | "h") => ({
    get(this: El) { return size(this.id)[k]; },
    set(this: El, v: number) {
      const n = Math.max(0, Math.floor(Number(v)) || 0);
      if (n === size(this.id)[k]) return;
      // (the tap takes the new size from the op and resizes the WebGL drawing buffer)
      push({ op: "update", id: this.id, kind: "canvas", props: { [k === "w" ? "width" : "height"]: n } } as never);
      flush();
      this.__ctx2d?._reset();
    },
  });
  def("width", dim("w"));
  def("height", dim("h"));
  def("clientWidth", { get(this: El) { return size(this.id).w; } });
  def("clientHeight", { get(this: El) { return size(this.id).h; } });
  // a style kept on the element, not sent: the page lays the canvas out from React's props
  if (!("style" in proto)) def("style", { get(this: El) { return (this.__style ??= new Style()); } });
  for (const k of ["addEventListener", "removeEventListener"]) if (!(k in proto)) def(k, { value() {} });
  if (!("dispatchEvent" in proto)) def("dispatchEvent", { value() { return true; } });
  if (!("getBoundingClientRect" in proto)) def("getBoundingClientRect", { value(this: El) { const { w, h } = size(this.id); return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON() { return this; } }; } });
  if (!("ownerDocument" in proto)) def("ownerDocument", { get() { return (globalThis as { document?: unknown }).document; } });
  if (!("getRootNode" in proto)) def("getRootNode", { value() { return (globalThis as { document?: unknown }).document; } });
  // (always PNG, whatever type is asked)
  def("toDataURL", { value(this: El) { const { w, h } = size(this.id); return this.__gl ? glDataUrl(this.__gl, w, h) : this.__ctx2d ? this.__ctx2d._dataUrl() : "data:,"; } });
  // a WebGL canvas drawn onto a 2D canvas (drawImage draws a source's currentSrc): its pixels as a PNG data URL
  def("currentSrc", { get(this: El) { return this.__gl ? this.toDataURL() : ""; } });
}

/** The element's WebGL 2 context: a microtask after it draws, its buffer goes to the page as the canvas's next frame. */
function webgl(el: El, attrs?: Record<string, unknown>): WebGL2RenderingContext_ {
  const id = el.id;
  let gen = 0;
  let queued = false;
  const host = {
    get width() { return size(id).w; },
    get height() { return size(id).h; },
    _gldrawn() {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (gls.get(id)?.ctx !== ctx) return;
        ctx._snapshot(++gen);
        const { w, h } = size(id);
        push({ op: "update", id, kind: "canvas", props: { __webgl: { ctx: ctx._ctx, gen, w, h } } } as never);
        flush();
      });
    },
  };
  const ctx = new WebGL2RenderingContext_(el, host, attrs);
  gls.set(id, { el, ctx });
  return (el.__gl = ctx);
}
