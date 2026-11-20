// A <canvas> on the page drawn the web's way: `ref.current.getContext("2d")` is raea's own CanvasRenderingContext2D
// (sdk/ui: text, gradients, images, transforms, clips, shadows, compositing), not bevy-react's small recorder. Its
// display list goes to the element as its `__canvas2d` prop, which raea's page draws into the canvas's bitmap
// (systems/page-ops, systems/canvas) and shows in its box, as a Blitz page shows a DOM canvas. The bitmap is the
// element's width x height props (300 x 150 unless given), read off bevy-react's op batches (its bridge tap).
import { BevyCanvasElement } from "bevy-react";
import { __installBridgeTap, flush, push } from "../../node_modules/bevy-react/src/bridge";
import { CanvasRenderingContext2D_ } from "../../ui/canvas";

const sizes = new Map<number, { w: number; h: number }>();
type Op = { op: string; id?: number; kind?: string; props?: Record<string, unknown> };

export function installPageCanvas() {
  const proto = BevyCanvasElement.prototype as unknown as { getContext(kind?: string): unknown; __raea2d?: boolean };
  if (proto.__raea2d) return;
  proto.__raea2d = true;
  __installBridgeTap({
    flush(batch: Op[]) {
      for (const op of batch) {
        if ((op.op !== "create" && op.op !== "update") || op.kind !== "canvas" || op.id === undefined || !op.props) continue;
        const s = sizes.get(op.id) ?? { w: 300, h: 150 };
        if (op.props.width != null) s.w = Number(op.props.width) || 0;
        if (op.props.height != null) s.h = Number(op.props.height) || 0;
        sizes.set(op.id, s);
      }
    },
    emit() {}, request() {}, outbound() {}, wrapStart() {}, wrapEnd() {},
  } as never);
  const own = proto.getContext;
  proto.getContext = function (this: { id: number; __ctx2d?: CanvasRenderingContext2D_ }, kind?: string) {
    if (kind !== "2d") return own.call(this);
    if (this.__ctx2d) return this.__ctx2d;
    const id = this.id;
    const host = {
      __wid: id,
      _wired: true,
      get width() { return sizes.get(id)?.w ?? 300; },
      get height() { return sizes.get(id)?.h ?? 150; },
      getAttribute: (k: string) => (k === "width" ? String(sizes.get(id)?.w ?? 300) : k === "height" ? String(sizes.get(id)?.h ?? 150) : null),
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
}
