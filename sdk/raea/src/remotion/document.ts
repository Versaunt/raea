// The browser globals a Remotion composition reaches for off the page, where a raea composition has none (its React
// draws into raea's page, not a DOM): `document.createElement("canvas")` with a real 2D context (raea's own Canvas 2D,
// sdk/ui: its pixels and text drawn by the host, systems/canvas), so text is measured, pictures are made and read back
// (measureText, getImageData, toDataURL) as in Chrome; `document.fonts` and `FontFace`, whose faces go to the page as
// @font-face would give them (`fonts.face`); and a head and body that take what's appended. Installed once, only where
// there's no document: a host that has one (raea app's DOM mode) keeps its own. `new Image()` reads its file through raea.
// A canvas's getContext("webgl2") is raea's WebGL 2 (sdk/raea/src/webgl), drawn off the page: nothing shows it, so it
// never snapshots; toDataURL and drawImage read its drawing buffer when asked. createElementNS is createElement (three
// makes its canvases and images with it).
import { CanvasRenderingContext2D_, Path2D_, ImageData_ } from "../../ui/canvas";
import { base64, encodePng } from "../../ui/canvas/png";
import { WebGL2RenderingContext_, installWebGLGlobals } from "../webgl";
import { addFontFace } from "./face";

const g = globalThis as Record<string, unknown> & { __raea_call?: (n: string, a: string) => string | undefined };

/** The host's synchronous calls as sdk/ui's wire asks them (`__ui_sync`), answered by raea's native calls. */
function syncByNative(name: string, json: string): string {
  try {
    const out = g.__raea_call?.(name, json);
    return JSON.stringify({ ok: out === undefined || out === "" ? null : JSON.parse(out) });
  } catch (e) {
    return JSON.stringify({ err: String((e as Error)?.message ?? e) });
  }
}

export class Style {
  [k: string]: unknown;
  setProperty(k: string, v: string) { this[k] = v; }
  getPropertyValue(k: string) { return String(this[k] ?? ""); }
  removeProperty(k: string) { delete this[k]; }
}

/** An element nobody puts on the page: attributes, a style, children kept, events ignored. */
class OffElement {
  readonly tagName: string;
  readonly nodeName: string;
  readonly style = new Style();
  readonly children: OffElement[] = [];
  readonly attrs: Record<string, string> = {};
  textContent = "";
  innerHTML = "";
  className = "";
  id = "";
  parentNode: OffElement | null = null;
  constructor(tag: string) { this.tagName = tag.toUpperCase(); this.nodeName = this.tagName; }
  getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  removeAttribute(k: string) { delete this.attrs[k]; }
  hasAttribute(k: string) { return k in this.attrs; }
  appendChild<T extends OffElement>(c: T): T { this.children.push(c); c.parentNode = this; return c; }
  removeChild<T extends OffElement>(c: T): T { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  insertBefore<T extends OffElement>(c: T): T { return this.appendChild(c); }
  remove() { this.parentNode?.removeChild(this); }
  private listeners?: Map<string, Set<(e: unknown) => void>>;
  addEventListener(type: string, fn: (e: unknown) => void) {
    if (typeof fn !== "function") return;
    const all = (this.listeners ??= new Map());
    if (!all.has(type)) all.set(type, new Set());
    all.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void) { this.listeners?.get(type)?.delete(fn); }
  /** an event's `on<type>` handler and listeners called (`new Image()`'s load and error, which three's ImageLoader
   *  listens for) */
  dispatchEvent(e?: { type?: string }) {
    if (!e?.type) return true;
    const ev = Object.assign(Object.create(null), { type: e.type, target: this, currentTarget: this });
    const h = (this as unknown as Record<string, unknown>)["on" + e.type];
    if (typeof h === "function") h.call(this, ev);
    for (const fn of [...(this.listeners?.get(e.type) ?? [])]) fn.call(this, ev);
    return true;
  }
  get innerText() { return this.textContent; }
  set innerText(v: string) { this.textContent = String(v); }
  /** Its box as text lays out: a line of its text in its style's font (the canvas's advances: the page's faces),
   *  as @remotion/layout-utils measures a span; empty for anything else. */
  getBoundingClientRect() {
    const box = (width: number, height: number) => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() { return this; } });
    const text = this.textContent;
    if (!text) return box(0, 0);
    const st = this.style as Record<string, string | undefined>;
    const size = parseFloat(String(st.fontSize ?? "16")) || 16;
    const font = `${st.fontStyle ?? "normal"} ${st.fontWeight ?? "400"} ${size}px ${st.fontFamily ?? "sans-serif"}`;
    const ctx = measurer();
    ctx.font = font;
    const transform = st.textTransform === "uppercase" ? text.toUpperCase() : st.textTransform === "lowercase" ? text.toLowerCase() : text;
    const lines = transform.split("\n");
    const spacing = parseFloat(String(st.letterSpacing ?? "0")) || 0;
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width + spacing * [...l].length));
    return box(width, lines.length * size * 1.2);
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getElementsByTagName() { return []; }
}

/** What marks a canvas element, off the page (OffCanvas) or on it (bevy-react's BevyCanvasElement, canvas.ts):
 *  `x instanceof HTMLCanvasElement` asks it. */
export const CANVAS = Symbol.for("raea.canvas");

/** A WebGL canvas's drawing buffer as a PNG data URL (toDataURL, and drawImage with it as the source). */
export function glDataUrl(gl: WebGL2RenderingContext_, w: number, h: number): string {
  if (!w || !h) return "data:,";
  return `data:image/png;base64,${base64(encodePng(w, h, gl._readCanvas()))}`;
}

/** A canvas off the page: its bitmap is width x height (300 x 150 unless set), drawn by raea's Canvas 2D or WebGL 2. */
class OffCanvas extends OffElement {
  _ctx?: CanvasRenderingContext2D_;
  __gl?: WebGL2RenderingContext_;
  constructor() { super("canvas"); }
  get width(): number { const v = parseInt(this.getAttribute("width") ?? "", 10); return Number.isFinite(v) && v >= 0 ? v : 300; }
  set width(v: number) { const was = this.width; this.setAttribute("width", String(Math.max(0, Math.floor(v)))); this._ctx?._reset(); this.resized(was, this.height); }
  get height(): number { const v = parseInt(this.getAttribute("height") ?? "", 10); return Number.isFinite(v) && v >= 0 ? v : 150; }
  set height(v: number) { const was = this.height; this.setAttribute("height", String(Math.max(0, Math.floor(v)))); this._ctx?._reset(); this.resized(this.width, was); }
  /** the WebGL drawing buffer remade at the new size (not when the size is the same) */
  private resized(w: number, h: number) { if (this.__gl && (w !== this.width || h !== this.height)) this.__gl._resize(this.width, this.height); }
  get clientWidth() { return this.width; }
  get clientHeight() { return this.height; }
  getContext(kind: string, attrs?: Record<string, unknown>) {
    // a canvas has one kind of context, as in a browser: asked for the other kind, it answers null. No WebGL 1: three
    // r178 is WebGL 2 only, and matching Chrome's WebGL 1 isn't a goal
    if (kind === "webgl2") return this._ctx ? null : (this.__gl ??= new WebGL2RenderingContext_(this, this, attrs));
    if (kind !== "2d" || this.__gl) return null;
    return (this._ctx ??= new CanvasRenderingContext2D_(this as never));
  }
  /** (the WebGL host's: off the page nothing shows a frame) */
  _gldrawn() {}
  // (always PNG, whatever type is asked)
  toDataURL() { return this.__gl ? glDataUrl(this.__gl, this.width, this.height) : (this.getContext("2d") as CanvasRenderingContext2D_)._dataUrl(); }
  /** a WebGL canvas drawn onto a 2D canvas (drawImage draws a source's currentSrc): its pixels as a PNG data URL */
  get currentSrc() { return this.__gl ? this.toDataURL() : ""; }
  toBlob(cb: (b: unknown) => void) { cb(null); }
  getBoundingClientRect() { const [width, height] = [this.width, this.height]; return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() { return this; } }; }
}
(OffCanvas.prototype as unknown as Record<symbol, boolean>)[CANVAS] = true;

/** HTMLCanvasElement for `instanceof` (three.js asks it of a texture's image): true of a canvas on or off the page. */
class HTMLCanvasElement_ {
  static [Symbol.hasInstance](x: unknown) { return !!x && !!(x as Record<symbol, unknown>)[CANVAS]; }
}

/** `new Image()`: an img nobody puts on the page */
class ImageOff extends OffElement {
  onload: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  crossOrigin: string | null = null;
  decoding = "auto";
  private size: [number, number] | null = null;
  private url = "";
  private done = false;
  private waiting: (() => void)[] = [];
  constructor(w?: number, h?: number) {
    super("img");
    if (w !== undefined) this.setAttribute("width", String(w));
    if (h !== undefined) this.setAttribute("height", String(h));
  }
  get src() { return this.getAttribute("src") ?? ""; }
  set src(v: string) {
    v = String(v);
    this.setAttribute("src", v);
    this.done = false;
    let ok = false;
    try {
      const out = g.__raea_call?.("image.read", JSON.stringify({ src: v }));
      const r = out ? (JSON.parse(out) as { width: number; height: number; url: string }) : null;
      if (r) [this.size, this.url, ok] = [[r.width, r.height], r.url, true];
    } catch {
      this.size = null;
    }
    setTimeout(() => {
      this.done = true;
      this.dispatchEvent({ type: ok ? "load" : "error" });
      for (const w of this.waiting.splice(0)) w();
    }, 0);
  }
  get currentSrc() { return this.done && this.size ? this.url : ""; }
  get naturalWidth() { return this.done && this.size ? this.size[0] : 0; }
  get naturalHeight() { return this.done && this.size ? this.size[1] : 0; }
  get complete() { return this.done || !this.getAttribute("src"); }
  get width() { return Number(this.getAttribute("width") ?? (this.size ? this.size[0] : 0)); }
  set width(v: number) { this.setAttribute("width", String(v)); }
  get height() { return Number(this.getAttribute("height") ?? (this.size ? this.size[1] : 0)); }
  set height(v: number) { this.setAttribute("height", String(v)); }
  decode() {
    return new Promise<void>((res, rej) => {
      const settle = () => (this.size ? res() : rej(new Error("decode")));
      if (this.done) settle();
      else this.waiting.push(settle);
    });
  }
}

let measuring: CanvasRenderingContext2D_ | undefined;
function measurer(): CanvasRenderingContext2D_ {
  return (measuring ??= new OffCanvas().getContext("2d") as CanvasRenderingContext2D_);
}

/** FontFace: a face by URL (or the URL Remotion's fetchFontData handed back), given to the page when it's added. */
class FontFace_ {
  family: string;
  status = "unloaded";
  readonly loaded: Promise<FontFace_>;
  private src: unknown;
  private d: { weight?: string | number; style?: string };
  constructor(family: string, src: unknown, descriptors: { weight?: string | number; style?: string } = {}) {
    this.family = family.replace(/^["']|["']$/g, "");
    this.src = src;
    this.d = descriptors;
    this.loaded = Promise.resolve(this);
  }
  load() { this.status = "loaded"; return this.loaded; }
  /** given to the page (document.fonts.add) */
  _add() {
    if (typeof this.src === "string") addFontFace(this.family, this.src, this.d);
    this.status = "loaded";
  }
}

const faces = new Set<FontFace_>();
const fonts = {
  ready: Promise.resolve(undefined as unknown),
  status: "loaded",
  add(f: FontFace_) { faces.add(f); f._add?.(); return fonts; },
  delete(f: FontFace_) { return faces.delete(f); },
  has(f: FontFace_) { return faces.has(f); },
  clear() { faces.clear(); },
  // raea holds a frame until the faces it uses are in: a load is done when it's asked
  load(_font: string, _text?: string) { return Promise.resolve([...faces]); },
  check() { return true; },
  forEach(cb: (f: FontFace_) => void) { faces.forEach(cb); },
  addEventListener() {},
  removeEventListener() {},
  [Symbol.iterator]() { return faces.values(); },
};

const createElement = (tag: string) => { const t = String(tag).toLowerCase(); return t === "canvas" ? new OffCanvas() : t === "img" ? new ImageOff() : new OffElement(String(tag)); };

export function installDocument() {
  if (typeof g.document !== "undefined") return;
  const head = new OffElement("head");
  const body = new OffElement("body");
  const html = new OffElement("html");
  html.appendChild(head);
  html.appendChild(body);
  g.document = {
    head,
    body,
    documentElement: html,
    fonts,
    createElement,
    createElementNS: (_ns: string, tag: string) => createElement(tag),
    createTextNode: (text: string) => Object.assign(new OffElement("#text"), { textContent: text }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: (t: string) => (t === "head" ? [head] : t === "body" ? [body] : []),
    addEventListener() {},
    removeEventListener() {},
  };
  // window: the global object, as in a browser, with the few readings code off the page makes
  if (typeof g.window === "undefined") {
    g.window = g;
    g.devicePixelRatio ??= 1;
    g.getComputedStyle ??= (el: OffElement) => el?.style ?? new Style();
    g.addEventListener ??= () => {};
    g.removeEventListener ??= () => {};
  }
  g.FontFace ??= FontFace_;
  // new Image(): an img off the page whose file raea reads (image.read): its natural size, and its bytes as a data:
  // URL in currentSrc, which drawImage decodes; load (or error) fires a task later, as in a browser
  g.Image ??= ImageOff;
  g.HTMLImageElement ??= ImageOff;
  g.Path2D ??= Path2D_;
  g.ImageData ??= ImageData_;
  g.CanvasRenderingContext2D ??= CanvasRenderingContext2D_;
  installWebGLGlobals(g);
  // (no OffscreenCanvas: three makes one only where it's defined)
  g.HTMLCanvasElement ??= HTMLCanvasElement_;
  // frames come from raea's clock, not a display: a callback runs a task later, given the time
  if (typeof g.requestAnimationFrame === "undefined") {
    const now = () => (g.performance as { now(): number } | undefined)?.now() ?? Date.now();
    g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(now()), 16);
    g.cancelAnimationFrame = (h: ReturnType<typeof setTimeout>) => clearTimeout(h);
  }
  g.__ui_sync ??= syncByNative;
}
