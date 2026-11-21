// WebGL2RenderingContext: each GL call is written into a command buffer (runtime/webgl/PROTOCOL.md "Command bytes")
// that `__raea_gl` hands to Rust, which runs it on ANGLE. Everything a page asks back that JS can know by watching its
// own calls (bindings, viewport, blend/depth/stencil state, pixel store, enable flags) is answered here, with no round
// trip; the rest is an op with an answer, sent last in its buffer. The hot calls (uniform*, bind*, draw*) write
// straight into typed arrays over the buffer: no allocation per call.
import { GL, type GLConstants } from "./constants";
import { OP } from "./ops";
import {
  WebGLActiveInfo_, WebGLBuffer_, WebGLFramebuffer_, WebGLObject_, WebGLProgram_, WebGLQuery_, WebGLRenderbuffer_,
  WebGLRenderingContext_, WebGLSampler_, WebGLShader_, WebGLShaderPrecisionFormat_, WebGLTexture_, WebGLUniformLocation_,
  WebGLVertexArrayObject_,
} from "./objects";

type Native = (bytes: Uint8Array, byteLength: number, ctx: number) => unknown;
const g = globalThis as unknown as {
  __raea_gl?: Native;
  __raea_call?: (name: string, json: string) => string | undefined;
  __raea_webgl_debug?: unknown;
  process?: { env?: Record<string, string | undefined> };
};

export interface GLHost { readonly width: number; readonly height: number; _gldrawn(): void }

type Info = {
  version: string; shadingLanguageVersion: string; vendor: string; renderer: string; unmaskedVendor: string;
  unmaskedRenderer: string; extensions: string[]; params: Record<string, number | number[]>;
};
type Buf = WebGLBuffer_ | null;
type Tex = WebGLTexture_ | null;
type Fb = WebGLFramebuffer_ | null;
type Rb = WebGLRenderbuffer_ | null;
type Prog = WebGLProgram_ | null;
type Loc = WebGLUniformLocation_ | null;
type Nums = ArrayLike<number>;
type View = ArrayBufferView;

/** pending words (8 MB) past which the buffer is sent before the next command */
const FLUSH_WORDS = 2 << 20;
/** blob element kinds for number lists */
const F32 = 0, I32 = 1, U32 = 2;
const COMPLETION_STATUS_KHR = 0x91b1;
const UNMASKED_VENDOR = 0x9245, UNMASKED_RENDERER = 0x9246;

/** WebGL 2 names with no op yet: each throws when called */
const TODO = [
  "createTransformFeedback", "deleteTransformFeedback", "isTransformFeedback", "bindTransformFeedback",
  "beginTransformFeedback", "endTransformFeedback", "pauseTransformFeedback", "resumeTransformFeedback",
  "transformFeedbackVaryings", "getTransformFeedbackVarying", "fenceSync", "isSync", "deleteSync", "clientWaitSync",
  "waitSync", "getSyncParameter", "getUniform", "getVertexAttrib", "getVertexAttribOffset", "getActiveUniforms",
  "getActiveUniformBlockParameter", "getActiveUniformBlockName", "getUniformIndices", "compressedTexImage3D",
  "compressedTexSubImage3D", "getIndexedParameter", "getSamplerParameter", "getFragDataLocation",
] as const;
type Todo = { [K in (typeof TODO)[number]]: (...args: unknown[]) => never };

const todo = (name: string) => new Error(`WebGL: ${name} isn't in raea yet`);

/** the extensions' constants (the ones with functions are made in getExtension) */
const EXT_CONSTANTS: Record<string, Record<string, number>> = {
  EXT_texture_filter_anisotropic: { TEXTURE_MAX_ANISOTROPY_EXT: 0x84fe, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff },
  WEBGL_debug_renderer_info: { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 },
  EXT_color_buffer_half_float: { RGBA16F_EXT: 0x881a, RGB16F_EXT: 0x881b, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT: 0x8211, UNSIGNED_NORMALIZED_EXT: 0x8c17 },
  WEBGL_compressed_texture_s3tc: { COMPRESSED_RGB_S3TC_DXT1_EXT: 0x83f0, COMPRESSED_RGBA_S3TC_DXT1_EXT: 0x83f1, COMPRESSED_RGBA_S3TC_DXT3_EXT: 0x83f2, COMPRESSED_RGBA_S3TC_DXT5_EXT: 0x83f3 },
  WEBGL_compressed_texture_s3tc_srgb: { COMPRESSED_SRGB_S3TC_DXT1_EXT: 0x8c4c, COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT: 0x8c4d, COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT: 0x8c4e, COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT: 0x8c4f },
  WEBGL_compressed_texture_etc: {
    COMPRESSED_R11_EAC: 0x9270, COMPRESSED_SIGNED_R11_EAC: 0x9271, COMPRESSED_RG11_EAC: 0x9272, COMPRESSED_SIGNED_RG11_EAC: 0x9273,
    COMPRESSED_RGB8_ETC2: 0x9274, COMPRESSED_SRGB8_ETC2: 0x9275, COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9276,
    COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9277, COMPRESSED_RGBA8_ETC2_EAC: 0x9278, COMPRESSED_SRGB8_ALPHA8_ETC2_EAC: 0x9279,
  },
  WEBGL_compressed_texture_etc1: { COMPRESSED_RGB_ETC1_WEBGL: 0x8d64 },
  WEBGL_compressed_texture_pvrtc: { COMPRESSED_RGB_PVRTC_4BPPV1_IMG: 0x8c00, COMPRESSED_RGB_PVRTC_2BPPV1_IMG: 0x8c01, COMPRESSED_RGBA_PVRTC_4BPPV1_IMG: 0x8c02, COMPRESSED_RGBA_PVRTC_2BPPV1_IMG: 0x8c03 },
  EXT_texture_compression_bptc: { COMPRESSED_RGBA_BPTC_UNORM_EXT: 0x8e8c, COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT: 0x8e8d, COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT: 0x8e8e, COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT: 0x8e8f },
  EXT_texture_compression_rgtc: { COMPRESSED_RED_RGTC1_EXT: 0x8dbb, COMPRESSED_SIGNED_RED_RGTC1_EXT: 0x8dbc, COMPRESSED_RED_GREEN_RGTC2_EXT: 0x8dbd, COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT: 0x8dbe },
  EXT_texture_norm16: { R16_EXT: 0x822a, RG16_EXT: 0x822c, RGB16_EXT: 0x8054, RGBA16_EXT: 0x805b, R16_SNORM_EXT: 0x8f98, RG16_SNORM_EXT: 0x8f99, RGB16_SNORM_EXT: 0x8f9a, RGBA16_SNORM_EXT: 0x8f9b },
  EXT_texture_mirror_clamp_to_edge: { MIRROR_CLAMP_TO_EDGE_EXT: 0x8743 },
  EXT_depth_clamp: { DEPTH_CLAMP_EXT: 0x864f },
  EXT_disjoint_timer_query_webgl2: { QUERY_COUNTER_BITS_EXT: 0x8864, TIME_ELAPSED_EXT: 0x88bf, TIMESTAMP_EXT: 0x8e28, GPU_DISJOINT_EXT: 0x8fbb },
  KHR_parallel_shader_compile: { COMPLETION_STATUS_KHR: 0x91b1 },
  EXT_clip_control: { LOWER_LEFT_EXT: 0x8ca1, UPPER_LEFT_EXT: 0x8ca2, NEGATIVE_ONE_TO_ONE_EXT: 0x935e, ZERO_TO_ONE_EXT: 0x935f, CLIP_ORIGIN_EXT: 0x935c, CLIP_DEPTH_MODE_EXT: 0x935d },
  EXT_polygon_offset_clamp: { POLYGON_OFFSET_CLAMP_EXT: 0x8e1b },
  WEBGL_provoking_vertex: { FIRST_VERTEX_CONVENTION_WEBGL: 0x8e4d, LAST_VERTEX_CONVENTION_WEBGL: 0x8e4e, PROVOKING_VERTEX_WEBGL: 0x8e4f },
};
const ASTC_SIZES = ["4x4", "5x4", "5x5", "6x5", "6x6", "8x5", "8x6", "8x8", "10x5", "10x6", "10x8", "10x10", "12x10", "12x12"];
ASTC_SIZES.forEach((s, i) => {
  const e = (EXT_CONSTANTS.WEBGL_compressed_texture_astc ??= {});
  e[`COMPRESSED_RGBA_ASTC_${s}_KHR`] = 0x93b0 + i;
  e[`COMPRESSED_SRGB8_ALPHA8_ASTC_${s}_KHR`] = 0x93d0 + i;
});

/** getParameter answers that never change (limits): a round trip's answer for one of these is kept */
const LIMITS = new Set<number>(
  Object.entries(GL).filter(([k]) => k.startsWith("MAX_") || k === "MIN_PROGRAM_TEXEL_OFFSET" || k === "UNIFORM_BUFFER_OFFSET_ALIGNMENT").map(([, v]) => v),
);

const DEFAULT_ATTRS = {
  alpha: true, depth: true, stencil: false, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false,
  powerPreference: "default", failIfMajorPerformanceCaveat: false, desynchronized: false,
};

/** bytes per texel of format/type (a blank canvas uploaded by texSubImage2D) */
function texelBytes(format: number, type: number): number {
  switch (type) {
    case GL.UNSIGNED_SHORT_5_6_5: case GL.UNSIGNED_SHORT_4_4_4_4: case GL.UNSIGNED_SHORT_5_5_5_1: return 2;
    case GL.UNSIGNED_INT_2_10_10_10_REV: case GL.UNSIGNED_INT_10F_11F_11F_REV: case GL.UNSIGNED_INT_5_9_9_9_REV: case GL.UNSIGNED_INT_24_8: return 4;
    case GL.FLOAT_32_UNSIGNED_INT_24_8_REV: return 8;
  }
  const size = type === GL.BYTE || type === GL.UNSIGNED_BYTE ? 1 : type === GL.SHORT || type === GL.UNSIGNED_SHORT || type === GL.HALF_FLOAT ? 2 : 4;
  switch (format) {
    case GL.RED: case GL.RED_INTEGER: case GL.ALPHA: case GL.LUMINANCE: case GL.DEPTH_COMPONENT: return size;
    case GL.RG: case GL.RG_INTEGER: case GL.LUMINANCE_ALPHA: case GL.DEPTH_STENCIL: return size * 2;
    case GL.RGB: case GL.RGB_INTEGER: case GL.SRGB: return size * 3;
  }
  return size * 4;
}

/** what a texture source is, for the "isn't in raea yet" message */
function what(src: unknown): string {
  const o = src as { tagName?: string; constructor?: { name?: string } } | null;
  const tag = String(o?.tagName ?? "").toUpperCase();
  if (tag === "VIDEO") return "a video";
  const name = o?.constructor?.name;
  if (name === "ImageBitmap") return "an ImageBitmap";
  if (name === "OffscreenCanvas") return "an OffscreenCanvas";
  if (name === "VideoFrame") return "a VideoFrame";
  return src === null ? "null" : name ? `a ${name}` : typeof src;
}

export class WebGL2RenderingContext_ {
  readonly canvas: unknown;
  readonly _ctx: number;
  drawingBufferColorSpace = "srgb";
  unpackColorSpace = "srgb";
  private host: GLHost;
  private attrs: typeof DEFAULT_ATTRS;
  private info: Info;
  private w: number;
  private h: number;
  private dead = false;
  private debugEnv: boolean;
  // the command buffer: p and cap count 4-byte words
  private ab: ArrayBuffer;
  private u8: Uint8Array;
  private i32: Int32Array;
  private u32: Uint32Array;
  private f32: Float32Array;
  private p = 0;
  private cap = 0;
  private lim = 0;
  // ids, one counter per kind
  private nBuf = 0; private nFb = 0; private nProg = 0; private nQuery = 0; private nRb = 0; private nSampler = 0;
  private nShader = 0; private nTex = 0; private nVao = 0; private nLoc = 0;
  // state JS tracks
  private consts = new Map<number, unknown>();
  private exts = new Map<string, object>();
  private precision = new Map<number, WebGLShaderPrecisionFormat_>();
  private unit = 0;
  private t2d: Tex[]; private tCube: Tex[]; private t3d: Tex[]; private t2dArray: Tex[];
  private samplers: (WebGLSampler_ | null)[];
  private arrayBuf: Buf = null;
  private elem0: Buf = null;
  private bufs: Record<number, Buf> = {};
  private vao: WebGLVertexArrayObject_ | null = null;
  private drawFb: Fb = null;
  private readFb: Fb = null;
  private rb: Rb = null;
  private program: Prog = null;
  private queries: Record<number, WebGLQuery_ | null> = {};
  private vp = new Int32Array(4);
  private sc = new Int32Array(4);
  private clearRGBA = new Float32Array(4);
  private blendRGBA = new Float32Array(4);
  private depthR = new Float32Array([0, 1]);
  private clearZ = 1;
  private clearS = 0;
  private mask = [true, true, true, true];
  private depthW = true;
  private depthF: number = GL.LESS;
  private eqRGB: number = GL.FUNC_ADD; private eqA: number = GL.FUNC_ADD;
  private srcRGB: number = GL.ONE; private dstRGB: number = GL.ZERO; private srcA: number = GL.ONE; private dstA: number = GL.ZERO;
  private cull: number = GL.BACK;
  private front: number = GL.CCW;
  private lineW = 1;
  private polyF = 0; private polyU = 0;
  private covV = 1; private covI = false;
  // stencil, front then back: func, ref, value mask, write mask, fail, depth fail, depth pass
  private sf = [GL.ALWAYS as number, 0, 0xffffffff, 0xffffffff, GL.KEEP as number, GL.KEEP as number, GL.KEEP as number];
  private sb = [GL.ALWAYS as number, 0, 0xffffffff, 0xffffffff, GL.KEEP as number, GL.KEEP as number, GL.KEEP as number];
  private caps: Record<number, boolean> = {
    [GL.BLEND]: false, [GL.CULL_FACE]: false, [GL.DEPTH_TEST]: false, [GL.DITHER]: true, [GL.POLYGON_OFFSET_FILL]: false,
    [GL.SAMPLE_ALPHA_TO_COVERAGE]: false, [GL.SAMPLE_COVERAGE]: false, [GL.SCISSOR_TEST]: false, [GL.STENCIL_TEST]: false,
    [GL.RASTERIZER_DISCARD]: false,
  };
  private hints: Record<number, number> = { [GL.GENERATE_MIPMAP_HINT]: GL.DONT_CARE, [GL.FRAGMENT_SHADER_DERIVATIVE_HINT]: GL.DONT_CARE };
  private pix: Record<number, number> = {
    [GL.PACK_ALIGNMENT]: 4, [GL.UNPACK_ALIGNMENT]: 4, [GL.UNPACK_FLIP_Y_WEBGL]: 0, [GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL]: 0,
    [GL.UNPACK_COLORSPACE_CONVERSION_WEBGL]: GL.BROWSER_DEFAULT_WEBGL, [GL.PACK_ROW_LENGTH]: 0, [GL.PACK_SKIP_PIXELS]: 0,
    [GL.PACK_SKIP_ROWS]: 0, [GL.UNPACK_ROW_LENGTH]: 0, [GL.UNPACK_IMAGE_HEIGHT]: 0, [GL.UNPACK_SKIP_PIXELS]: 0,
    [GL.UNPACK_SKIP_ROWS]: 0, [GL.UNPACK_SKIP_IMAGES]: 0,
  };

  constructor(canvas: unknown, host: GLHost, attrs?: Record<string, unknown>) {
    this.canvas = canvas;
    this.host = host;
    const a = { ...DEFAULT_ATTRS };
    for (const k of Object.keys(a) as (keyof typeof a)[]) {
      const v = attrs?.[k];
      if (v !== undefined) (a as Record<string, unknown>)[k] = k === "powerPreference" ? String(v) : !!v;
    }
    this.attrs = a;
    if (!g.__raea_call || !g.__raea_gl) throw new Error("WebGL isn't available here (no __raea_gl)");
    this.w = Math.max(1, Math.floor(host.width) || 0);
    this.h = Math.max(1, Math.floor(host.height) || 0);
    const out = g.__raea_call("webgl.create", JSON.stringify({ width: this.w, height: this.h, attrs: a }));
    const r = JSON.parse(String(out)) as { ctx: number; info: Info };
    this._ctx = r.ctx;
    this.info = r.info;
    for (const [k, v] of Object.entries(r.info.params ?? {})) {
      const n = Number(k);
      this.consts.set(n, Array.isArray(v) ? (n === GL.ALIASED_LINE_WIDTH_RANGE || n === GL.ALIASED_POINT_SIZE_RANGE ? new Float32Array(v) : new Int32Array(v)) : v);
    }
    this.debugEnv = g.process?.env?.RAEA_WEBGL_DEBUG === "1";
    const units = Number(this.consts.get(GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS)) || 32;
    this.t2d = new Array(units).fill(null);
    this.tCube = new Array(units).fill(null);
    this.t3d = new Array(units).fill(null);
    this.t2dArray = new Array(units).fill(null);
    this.samplers = new Array(units).fill(null);
    this.vp.set([0, 0, this.w, this.h]);
    this.sc.set([0, 0, this.w, this.h]);
    this.ab = new ArrayBuffer(64 << 10);
    this.u8 = new Uint8Array(this.ab);
    this.i32 = new Int32Array(this.ab);
    this.u32 = new Uint32Array(this.ab);
    this.f32 = new Float32Array(this.ab);
    this.cap = this.ab.byteLength >> 2;
    this.lim = Math.min(this.cap, FLUSH_WORDS);
  }

  get drawingBufferWidth() { return this.w; }
  get drawingBufferHeight() { return this.h; }
  get drawingBufferFormat() { return GL.RGBA8; }

  // -------- the buffer

  /** n words reserved for a new command; their first index. Everything before is whole commands, so this is where
   *  ~8 MB pending is sent. */
  private r(n: number): number {
    if (this.p + n > this.lim) {
      if (this.p && this.p + n > FLUSH_WORDS) this._flush();
      if (this.p + n > this.cap) this.grow(n);
    }
    const at = this.p;
    this.p += n;
    return at;
  }
  /** n more words for the command being written (its blob, string or trailing operands) */
  private rc(n: number): number {
    if (this.p + n > this.cap) this.grow(n);
    const at = this.p;
    this.p += n;
    return at;
  }
  private grow(n: number) {
    let cap = this.cap;
    while (this.p + n > cap) cap *= 2;
    const ab = new ArrayBuffer(cap << 2);
    const u8 = new Uint8Array(ab);
    u8.set(this.u8.subarray(0, this.p << 2));
    this.ab = ab;
    this.u8 = u8;
    this.i32 = new Int32Array(ab);
    this.u32 = new Uint32Array(ab);
    this.f32 = new Float32Array(ab);
    this.cap = cap;
    this.lim = Math.min(cap, FLUSH_WORDS);
  }
  /** Sends what's pending; the native's answer (the last command's, if it has one). */
  _flush(): unknown {
    const n = this.p << 2;
    this.p = 0;
    if (!n || this.dead) return undefined;
    return g.__raea_gl!(this.u8, n, this._ctx);
  }
  private c0(op: number) { this.i32[this.r(1)] = op; }
  private c1(op: number, a: number) { const p = this.r(2), m = this.i32; m[p] = op; m[p + 1] = a; }
  private c2(op: number, a: number, b: number) { const p = this.r(3), m = this.i32; m[p] = op; m[p + 1] = a; m[p + 2] = b; }
  private c3(op: number, a: number, b: number, c: number) { const p = this.r(4), m = this.i32; m[p] = op; m[p + 1] = a; m[p + 2] = b; m[p + 3] = c; }
  private c4(op: number, a: number, b: number, c: number, d: number) { const p = this.r(5), m = this.i32; m[p] = op; m[p + 1] = a; m[p + 2] = b; m[p + 3] = c; m[p + 4] = d; }
  private c5(op: number, a: number, b: number, c: number, d: number, e: number) { const p = this.r(6), m = this.i32; m[p] = op; m[p + 1] = a; m[p + 2] = b; m[p + 3] = c; m[p + 4] = d; m[p + 5] = e; }
  private c6(op: number, a: number, b: number, c: number, d: number, e: number, f: number) { const p = this.r(7), m = this.i32; m[p] = op; m[p + 1] = a; m[p + 2] = b; m[p + 3] = c; m[p + 4] = d; m[p + 5] = e; m[p + 6] = f; }
  /** an op then n i32 operands from a list (the long ones) */
  private cn(op: number, ...v: number[]) { const p = this.r(1 + v.length), m = this.i32; m[p] = op; for (let k = 0; k < v.length; k++) m[p + 1 + k] = v[k]; }
  private f4(op: number, a: number, b: number, c: number, d: number) { const p = this.r(5), f = this.f32; this.i32[p] = op; f[p + 1] = a; f[p + 2] = b; f[p + 3] = c; f[p + 4] = d; }
  /** a blob: len bytes of buf from byte off, zero-padded to 4 */
  private blob(buf: ArrayBufferLike, off: number, len: number) {
    if (len < 0) len = 0;
    const n = (len + 3) >> 2, a = this.rc(1 + n);
    this.u32[a] = len;
    if (n) {
      this.u32[a + n] = 0;
      this.u8.set(new Uint8Array(buf, off, len), (a + 1) << 2);
    }
  }
  /** a typed array or ArrayBuffer as a blob, from srcOffset elements on, length elements (0: the rest) */
  private view(v: View | ArrayBuffer, srcOffset = 0, length = 0) {
    if (!ArrayBuffer.isView(v)) return this.blob(v as ArrayBuffer, 0, (v as ArrayBuffer).byteLength);
    const bpe = (v as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT || 1;
    const off = srcOffset * bpe;
    this.blob(v.buffer, v.byteOffset + off, length ? length * bpe : v.byteLength - off);
  }
  /** a list of numbers as a blob of f32/i32/u32 */
  private nums(d: Nums, kind: number, srcOffset = 0, length = 0) {
    let n = length ? length : d.length - srcOffset;
    if (n < 0) n = 0;
    const a = this.rc(1 + n);
    this.u32[a] = n << 2;
    const t = kind === F32 ? this.f32 : kind === I32 ? this.i32 : this.u32;
    if (srcOffset === 0 && n === d.length) t.set(d, a + 1);
    else if (ArrayBuffer.isView(d)) t.set((d as unknown as Float32Array).subarray(srcOffset, srcOffset + n), a + 1);
    else for (let k = 0; k < n; k++) t[a + 1 + k] = d[srcOffset + k];
  }
  /** a string as UTF-8 */
  private str(s: string) {
    s = String(s);
    const len = s.length, a = this.rc(1 + ((len * 3 + 3) >> 2)), u8 = this.u8, start = (a + 1) << 2;
    let q = start;
    for (let i = 0; i < len; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) { u8[q++] = c; continue; }
      if (c < 0x800) { u8[q++] = 0xc0 | (c >> 6); u8[q++] = 0x80 | (c & 63); continue; }
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < len) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d < 0xe000) {
          i++;
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          u8[q++] = 0xf0 | (c >> 18); u8[q++] = 0x80 | ((c >> 12) & 63); u8[q++] = 0x80 | ((c >> 6) & 63); u8[q++] = 0x80 | (c & 63);
          continue;
        }
      }
      if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
      u8[q++] = 0xe0 | (c >> 12); u8[q++] = 0x80 | ((c >> 6) & 63); u8[q++] = 0x80 | (c & 63);
    }
    this.u32[a] = q - start;
    while (q & 3) u8[q++] = 0;
    this.p = q >> 2;
  }
  /** after an op that draws into the drawing buffer */
  private drawn() { if (this.drawFb === null) this.host._gldrawn(); }
  private mine(o: WebGLObject_ | null | undefined): o is WebGLObject_ { return !!o && o._gl === this && !o._deleted; }

  // -------- the glue's

  _snapshot(gen: number) { this.c1(OP.snapshot, gen); this._flush(); }
  _readCanvas(): Uint8Array {
    this.c0(OP.readCanvas);
    const r = this._flush();
    return r instanceof ArrayBuffer ? new Uint8Array(r) : new Uint8Array(this.w * this.h * 4);
  }
  _resize(width: number, height: number) {
    if (this.dead) return;
    this._flush();
    const w = Math.max(1, Math.floor(width) || 0), h = Math.max(1, Math.floor(height) || 0);
    g.__raea_call!("webgl.resize", JSON.stringify({ ctx: this._ctx, width: w, height: h }));
    this.w = w;
    this.h = h;
  }
  _destroy() {
    if (this.dead) return;
    this._flush();
    this.dead = true;
    g.__raea_call!("webgl.destroy", JSON.stringify({ ctx: this._ctx }));
  }

  // -------- context

  getContextAttributes() { return this.dead ? null : { ...this.attrs }; }
  isContextLost() { return false; }
  makeXRCompatible() { return Promise.resolve(); }
  getSupportedExtensions() { return this.info.extensions.slice(); }
  getExtension(name: string): object | null {
    const have = this.exts.get(name);
    if (have) return have;
    if (!this.info.extensions.includes(name)) return null;
    const e: Record<string, unknown> = { ...EXT_CONSTANTS[name] };
    if (name === "WEBGL_lose_context") Object.assign(e, { loseContext() {}, restoreContext() {} });
    else if (name === "WEBGL_compressed_texture_astc") e.getSupportedProfiles = () => ["ldr"];
    else if (name === "EXT_disjoint_timer_query_webgl2") e.queryCounterEXT = () => { throw todo("queryCounterEXT"); };
    else if (name === "EXT_clip_control") e.clipControlEXT = () => { throw todo("clipControlEXT"); };
    else if (name === "EXT_polygon_offset_clamp") e.polygonOffsetClampEXT = () => { throw todo("polygonOffsetClampEXT"); };
    else if (name === "WEBGL_provoking_vertex") e.provokingVertexWEBGL = () => { throw todo("provokingVertexWEBGL"); };
    else if (name === "WEBGL_multi_draw") Object.assign(e, this.multiDraw());
    this.exts.set(name, e);
    this.str2(OP.requestExtension, name);
    return e;
  }
  private str2(op: number, s: string) { this.i32[this.r(1)] = op; this.str(s); }
  /** WEBGL_multi_draw as a run of single draws */
  private multiDraw() {
    const gl = this;
    const at = (l: Nums, o: number, k: number) => l[o + k];
    return {
      multiDrawArraysWEBGL(mode: number, firsts: Nums, fo: number, counts: Nums, co: number, n: number) {
        for (let k = 0; k < n; k++) gl.drawArrays(mode, at(firsts, fo, k), at(counts, co, k));
      },
      multiDrawElementsWEBGL(mode: number, counts: Nums, co: number, type: number, offsets: Nums, oo: number, n: number) {
        for (let k = 0; k < n; k++) gl.drawElements(mode, at(counts, co, k), type, at(offsets, oo, k));
      },
      multiDrawArraysInstancedWEBGL(mode: number, firsts: Nums, fo: number, counts: Nums, co: number, inst: Nums, io: number, n: number) {
        for (let k = 0; k < n; k++) gl.drawArraysInstanced(mode, at(firsts, fo, k), at(counts, co, k), at(inst, io, k));
      },
      multiDrawElementsInstancedWEBGL(mode: number, counts: Nums, co: number, type: number, offsets: Nums, oo: number, inst: Nums, io: number, n: number) {
        for (let k = 0; k < n; k++) gl.drawElementsInstanced(mode, at(counts, co, k), type, at(offsets, oo, k), at(inst, io, k));
      },
    };
  }
  getError(): number {
    if (!(g.__raea_webgl_debug || this.debugEnv)) return 0;
    this.c0(OP.getError);
    return Number(this._flush()) || 0;
  }

  // -------- getParameter: JS's own answers, then a round trip

  getParameter(p: number): unknown {
    switch (p) {
      case GL.VERSION: return this.info.version;
      case GL.SHADING_LANGUAGE_VERSION: return this.info.shadingLanguageVersion;
      case GL.VENDOR: return "WebKit";
      case GL.RENDERER: return "WebKit WebGL";
      case UNMASKED_VENDOR: return this.info.unmaskedVendor;
      case UNMASKED_RENDERER: return this.info.unmaskedRenderer;
      case GL.ARRAY_BUFFER_BINDING: return this.arrayBuf;
      case GL.ELEMENT_ARRAY_BUFFER_BINDING: return this.vao ? this.vao._element : this.elem0;
      case GL.COPY_READ_BUFFER_BINDING: case GL.COPY_WRITE_BUFFER_BINDING: return this.bufs[p] ?? null;
      case GL.PIXEL_PACK_BUFFER_BINDING: return this.bufs[GL.PIXEL_PACK_BUFFER] ?? null;
      case GL.PIXEL_UNPACK_BUFFER_BINDING: return this.bufs[GL.PIXEL_UNPACK_BUFFER] ?? null;
      case GL.UNIFORM_BUFFER_BINDING: return this.bufs[GL.UNIFORM_BUFFER] ?? null;
      case GL.TRANSFORM_FEEDBACK_BUFFER_BINDING: return this.bufs[GL.TRANSFORM_FEEDBACK_BUFFER] ?? null;
      case GL.TRANSFORM_FEEDBACK_BINDING: return null;
      case GL.TRANSFORM_FEEDBACK_ACTIVE: case GL.TRANSFORM_FEEDBACK_PAUSED: return false;
      case GL.DRAW_FRAMEBUFFER_BINDING: return this.drawFb;
      case GL.READ_FRAMEBUFFER_BINDING: return this.readFb;
      case GL.RENDERBUFFER_BINDING: return this.rb;
      case GL.TEXTURE_BINDING_2D: return this.t2d[this.unit];
      case GL.TEXTURE_BINDING_CUBE_MAP: return this.tCube[this.unit];
      case GL.TEXTURE_BINDING_3D: return this.t3d[this.unit];
      case GL.TEXTURE_BINDING_2D_ARRAY: return this.t2dArray[this.unit];
      case GL.SAMPLER_BINDING: return this.samplers[this.unit];
      case GL.CURRENT_PROGRAM: return this.program;
      case GL.VERTEX_ARRAY_BINDING: return this.vao;
      case GL.ACTIVE_TEXTURE: return GL.TEXTURE0 + this.unit;
      case GL.VIEWPORT: return this.vp.slice();
      case GL.SCISSOR_BOX: return this.sc.slice();
      case GL.COLOR_CLEAR_VALUE: return this.clearRGBA.slice();
      case GL.BLEND_COLOR: return this.blendRGBA.slice();
      case GL.DEPTH_RANGE: return this.depthR.slice();
      case GL.DEPTH_CLEAR_VALUE: return this.clearZ;
      case GL.STENCIL_CLEAR_VALUE: return this.clearS;
      case GL.COLOR_WRITEMASK: return this.mask.slice();
      case GL.DEPTH_WRITEMASK: return this.depthW;
      case GL.DEPTH_FUNC: return this.depthF;
      case GL.BLEND_EQUATION_RGB: return this.eqRGB;
      case GL.BLEND_EQUATION_ALPHA: return this.eqA;
      case GL.BLEND_SRC_RGB: return this.srcRGB;
      case GL.BLEND_DST_RGB: return this.dstRGB;
      case GL.BLEND_SRC_ALPHA: return this.srcA;
      case GL.BLEND_DST_ALPHA: return this.dstA;
      case GL.CULL_FACE_MODE: return this.cull;
      case GL.FRONT_FACE: return this.front;
      case GL.LINE_WIDTH: return this.lineW;
      case GL.POLYGON_OFFSET_FACTOR: return this.polyF;
      case GL.POLYGON_OFFSET_UNITS: return this.polyU;
      case GL.SAMPLE_COVERAGE_VALUE: return this.covV;
      case GL.SAMPLE_COVERAGE_INVERT: return this.covI;
      case GL.STENCIL_FUNC: return this.sf[0];
      case GL.STENCIL_REF: return this.sf[1];
      case GL.STENCIL_VALUE_MASK: return this.sf[2];
      case GL.STENCIL_WRITEMASK: return this.sf[3];
      case GL.STENCIL_FAIL: return this.sf[4];
      case GL.STENCIL_PASS_DEPTH_FAIL: return this.sf[5];
      case GL.STENCIL_PASS_DEPTH_PASS: return this.sf[6];
      case GL.STENCIL_BACK_FUNC: return this.sb[0];
      case GL.STENCIL_BACK_REF: return this.sb[1];
      case GL.STENCIL_BACK_VALUE_MASK: return this.sb[2];
      case GL.STENCIL_BACK_WRITEMASK: return this.sb[3];
      case GL.STENCIL_BACK_FAIL: return this.sb[4];
      case GL.STENCIL_BACK_PASS_DEPTH_FAIL: return this.sb[5];
      case GL.STENCIL_BACK_PASS_DEPTH_PASS: return this.sb[6];
      case GL.UNPACK_FLIP_Y_WEBGL: case GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL: return !!this.pix[p];
    }
    const c = this.consts.get(p);
    if (c !== undefined) return ArrayBuffer.isView(c) ? (c as Int32Array).slice() : c;
    const v = this.pix[p] ?? this.hints[p];
    if (v !== undefined) return v;
    const cap = this.caps[p];
    if (cap !== undefined) return cap;
    this.c1(OP.getParameter, p);
    const out = this._flush();
    if (typeof out !== "string") return null;
    let r = JSON.parse(out) as unknown;
    if (p === GL.COMPRESSED_TEXTURE_FORMATS) r = new Uint32Array((r as number[]) ?? []);
    else if (Array.isArray(r)) r = new Int32Array(r);
    if (LIMITS.has(p)) this.consts.set(p, r);
    return r;
  }
  isEnabled(cap: number): boolean {
    const v = this.caps[cap];
    if (v !== undefined) return v;
    this.c1(OP.isEnabled, cap);
    return !!this._flush();
  }

  // -------- state

  activeTexture(t: number) { this.unit = t - GL.TEXTURE0; this.c1(OP.activeTexture, t); }
  enable(cap: number) { this.caps[cap] = true; this.c1(OP.enable, cap); }
  disable(cap: number) { this.caps[cap] = false; this.c1(OP.disable, cap); }
  viewport(x: number, y: number, w: number, h: number) { const v = this.vp; v[0] = x; v[1] = y; v[2] = w; v[3] = h; this.c4(OP.viewport, x, y, w, h); }
  scissor(x: number, y: number, w: number, h: number) { const v = this.sc; v[0] = x; v[1] = y; v[2] = w; v[3] = h; this.c4(OP.scissor, x, y, w, h); }
  clearColor(r: number, g: number, b: number, a: number) { const v = this.clearRGBA; v[0] = r; v[1] = g; v[2] = b; v[3] = a; this.f4(OP.clearColor, r, g, b, a); }
  blendColor(r: number, g: number, b: number, a: number) { const v = this.blendRGBA; v[0] = r; v[1] = g; v[2] = b; v[3] = a; this.f4(OP.blendColor, r, g, b, a); }
  clearDepth(d: number) { this.clearZ = Math.min(1, Math.max(0, d)); const p = this.r(2); this.i32[p] = OP.clearDepth; this.f32[p + 1] = d; }
  clearStencil(s: number) { this.clearS = s | 0; this.c1(OP.clearStencil, s); }
  colorMask(r: boolean, g: boolean, b: boolean, a: boolean) {
    const m = this.mask; m[0] = !!r; m[1] = !!g; m[2] = !!b; m[3] = !!a;
    this.c4(OP.colorMask, +!!r, +!!g, +!!b, +!!a);
  }
  depthMask(f: boolean) { this.depthW = !!f; this.c1(OP.depthMask, +!!f); }
  depthFunc(f: number) { this.depthF = f; this.c1(OP.depthFunc, f); }
  depthRange(n: number, f: number) {
    this.depthR[0] = Math.min(1, Math.max(0, n)); this.depthR[1] = Math.min(1, Math.max(0, f));
    const p = this.r(3); this.i32[p] = OP.depthRange; this.f32[p + 1] = n; this.f32[p + 2] = f;
  }
  blendEquation(m: number) { this.eqRGB = this.eqA = m; this.c1(OP.blendEquation, m); }
  blendEquationSeparate(rgb: number, a: number) { this.eqRGB = rgb; this.eqA = a; this.c2(OP.blendEquationSeparate, rgb, a); }
  blendFunc(s: number, d: number) { this.srcRGB = this.srcA = s; this.dstRGB = this.dstA = d; this.c2(OP.blendFunc, s, d); }
  blendFuncSeparate(sr: number, dr: number, sa: number, da: number) {
    this.srcRGB = sr; this.dstRGB = dr; this.srcA = sa; this.dstA = da;
    this.c4(OP.blendFuncSeparate, sr, dr, sa, da);
  }
  cullFace(m: number) { this.cull = m; this.c1(OP.cullFace, m); }
  frontFace(m: number) { this.front = m; this.c1(OP.frontFace, m); }
  lineWidth(w: number) { this.lineW = w; const p = this.r(2); this.i32[p] = OP.lineWidth; this.f32[p + 1] = w; }
  polygonOffset(f: number, u: number) { this.polyF = f; this.polyU = u; const p = this.r(3); this.i32[p] = OP.polygonOffset; this.f32[p + 1] = f; this.f32[p + 2] = u; }
  sampleCoverage(v: number, inv: boolean) { this.covV = v; this.covI = !!inv; const p = this.r(3); this.i32[p] = OP.sampleCoverage; this.f32[p + 1] = v; this.i32[p + 2] = +!!inv; }
  hint(target: number, mode: number) { this.hints[target] = mode; this.c2(OP.hint, target, mode); }
  pixelStorei(pname: number, param: number | boolean) {
    const v = typeof param === "boolean" ? +param : param | 0;
    this.pix[pname] = v;
    this.c2(OP.pixelStorei, pname, v);
  }
  stencilFunc(f: number, ref: number, mask: number) { this.stFunc(this.sf, f, ref, mask); this.stFunc(this.sb, f, ref, mask); this.c3(OP.stencilFunc, f, ref, mask); }
  stencilFuncSeparate(face: number, f: number, ref: number, mask: number) {
    if (face !== GL.BACK) this.stFunc(this.sf, f, ref, mask);
    if (face !== GL.FRONT) this.stFunc(this.sb, f, ref, mask);
    this.c4(OP.stencilFuncSeparate, face, f, ref, mask);
  }
  private stFunc(s: number[], f: number, ref: number, mask: number) { s[0] = f; s[1] = ref | 0; s[2] = mask >>> 0; }
  stencilMask(m: number) { this.sf[3] = this.sb[3] = m >>> 0; this.c1(OP.stencilMask, m); }
  stencilMaskSeparate(face: number, m: number) {
    if (face !== GL.BACK) this.sf[3] = m >>> 0;
    if (face !== GL.FRONT) this.sb[3] = m >>> 0;
    this.c2(OP.stencilMaskSeparate, face, m);
  }
  stencilOp(f: number, zf: number, zp: number) { this.stOp(this.sf, f, zf, zp); this.stOp(this.sb, f, zf, zp); this.c3(OP.stencilOp, f, zf, zp); }
  stencilOpSeparate(face: number, f: number, zf: number, zp: number) {
    if (face !== GL.BACK) this.stOp(this.sf, f, zf, zp);
    if (face !== GL.FRONT) this.stOp(this.sb, f, zf, zp);
    this.c4(OP.stencilOpSeparate, face, f, zf, zp);
  }
  private stOp(s: number[], f: number, zf: number, zp: number) { s[4] = f; s[5] = zf; s[6] = zp; }
  readBuffer(src: number) { this.c1(OP.readBuffer, src); }
  drawBuffers(bufs: Nums) { this.i32[this.r(1)] = OP.drawBuffers; this.nums(bufs, I32); }
  finish() { this.c0(OP.finish); }
  flush() { this.c0(OP.flush); }

  // -------- objects

  createBuffer() { const o = new WebGLBuffer_(++this.nBuf, this); this.c1(OP.createBuffer, o.id); return o; }
  createFramebuffer() { const o = new WebGLFramebuffer_(++this.nFb, this); this.c1(OP.createFramebuffer, o.id); return o; }
  createRenderbuffer() { const o = new WebGLRenderbuffer_(++this.nRb, this); this.c1(OP.createRenderbuffer, o.id); return o; }
  createTexture() { const o = new WebGLTexture_(++this.nTex, this); this.c1(OP.createTexture, o.id); return o; }
  createVertexArray() { const o = new WebGLVertexArrayObject_(++this.nVao, this); this.c1(OP.createVertexArray, o.id); return o; }
  createQuery() { const o = new WebGLQuery_(++this.nQuery, this); this.c1(OP.createQuery, o.id); return o; }
  createSampler() { const o = new WebGLSampler_(++this.nSampler, this); o._bound = true; this.c1(OP.createSampler, o.id); return o; }
  createProgram() { const o = new WebGLProgram_(++this.nProg, this); o._bound = true; this.c1(OP.createProgram, o.id); return o; }
  createShader(type: number) { const o = new WebGLShader_(++this.nShader, this, type); o._bound = true; this.c2(OP.createShader, type, o.id); return o; }

  /** marks o deleted and sends the op; false when there's nothing to delete */
  private del(o: WebGLObject_ | null | undefined, op: number): boolean {
    if (!this.mine(o)) return false;
    o._deleted = true;
    this.c1(op, o.id);
    return true;
  }
  deleteBuffer(b: Buf) {
    if (!this.del(b, OP.deleteBuffer)) return;
    if (this.arrayBuf === b) this.arrayBuf = null;
    if (this.elem0 === b) this.elem0 = null;
    if (this.vao && this.vao._element === b) this.vao._element = null;
    for (const k in this.bufs) if (this.bufs[k] === b) this.bufs[k] = null;
  }
  deleteFramebuffer(f: Fb) {
    if (!this.del(f, OP.deleteFramebuffer)) return;
    if (this.drawFb === f) this.drawFb = null;
    if (this.readFb === f) this.readFb = null;
  }
  deleteRenderbuffer(r: Rb) { if (this.del(r, OP.deleteRenderbuffer) && this.rb === r) this.rb = null; }
  deleteTexture(t: Tex) {
    if (!this.del(t, OP.deleteTexture)) return;
    for (const list of [this.t2d, this.tCube, this.t3d, this.t2dArray]) for (let k = 0; k < list.length; k++) if (list[k] === t) list[k] = null;
  }
  deleteVertexArray(v: WebGLVertexArrayObject_ | null) { if (this.del(v, OP.deleteVertexArray) && this.vao === v) this.vao = null; }
  deleteQuery(q: WebGLQuery_ | null) {
    if (!this.del(q, OP.deleteQuery)) return;
    for (const k in this.queries) if (this.queries[k] === q) this.queries[k] = null;
  }
  deleteSampler(s: WebGLSampler_ | null) {
    if (!this.del(s, OP.deleteSampler)) return;
    for (let k = 0; k < this.samplers.length; k++) if (this.samplers[k] === s) this.samplers[k] = null;
  }
  deleteProgram(p: Prog) { this.del(p, OP.deleteProgram); }
  deleteShader(s: WebGLShader_ | null) { this.del(s, OP.deleteShader); }

  private alive(o: unknown, kind: abstract new (...a: never[]) => WebGLObject_): boolean {
    return o instanceof kind && o._gl === this && o._bound && !o._deleted;
  }
  isBuffer(o: unknown) { return this.alive(o, WebGLBuffer_); }
  isFramebuffer(o: unknown) { return this.alive(o, WebGLFramebuffer_); }
  isRenderbuffer(o: unknown) { return this.alive(o, WebGLRenderbuffer_); }
  isTexture(o: unknown) { return this.alive(o, WebGLTexture_); }
  isVertexArray(o: unknown) { return this.alive(o, WebGLVertexArrayObject_); }
  isQuery(o: unknown) { return this.alive(o, WebGLQuery_); }
  isSampler(o: unknown) { return this.alive(o, WebGLSampler_); }
  isProgram(o: unknown) { return this.alive(o, WebGLProgram_); }
  isShader(o: unknown) { return this.alive(o, WebGLShader_); }

  // -------- bindings

  bindBuffer(target: number, b: Buf) {
    if (target === GL.ARRAY_BUFFER) this.arrayBuf = b;
    else if (target === GL.ELEMENT_ARRAY_BUFFER) { if (this.vao) this.vao._element = b; else this.elem0 = b; }
    else this.bufs[target] = b;
    if (b) b._bound = true;
    this.c2(OP.bindBuffer, target, b ? b.id : 0);
  }
  bindBufferBase(target: number, index: number, b: Buf) {
    this.bufs[target] = b;
    if (b) b._bound = true;
    this.c3(OP.bindBufferBase, target, index, b ? b.id : 0);
  }
  bindBufferRange(target: number, index: number, b: Buf, offset: number, size: number) {
    this.bufs[target] = b;
    if (b) b._bound = true;
    this.c5(OP.bindBufferRange, target, index, b ? b.id : 0, offset, size);
  }
  bindFramebuffer(target: number, f: Fb) {
    if (target === GL.READ_FRAMEBUFFER) this.readFb = f;
    else if (target === GL.DRAW_FRAMEBUFFER) this.drawFb = f;
    else this.drawFb = this.readFb = f;
    if (f) f._bound = true;
    this.c2(OP.bindFramebuffer, target, f ? f.id : 0);
  }
  bindRenderbuffer(target: number, r: Rb) {
    this.rb = r;
    if (r) r._bound = true;
    this.c2(OP.bindRenderbuffer, target, r ? r.id : 0);
  }
  bindTexture(target: number, t: Tex) {
    const u = this.unit;
    switch (target) {
      case GL.TEXTURE_2D: this.t2d[u] = t; break;
      case GL.TEXTURE_CUBE_MAP: this.tCube[u] = t; break;
      case GL.TEXTURE_3D: this.t3d[u] = t; break;
      case GL.TEXTURE_2D_ARRAY: this.t2dArray[u] = t; break;
    }
    if (t) t._bound = true;
    this.c2(OP.bindTexture, target, t ? t.id : 0);
  }
  bindSampler(unit: number, s: WebGLSampler_ | null) { this.samplers[unit] = s; this.c2(OP.bindSampler, unit, s ? s.id : 0); }
  bindVertexArray(v: WebGLVertexArrayObject_ | null) {
    this.vao = v;
    if (v) v._bound = true;
    this.c1(OP.bindVertexArray, v ? v.id : 0);
  }
  useProgram(p: Prog) { this.program = p; this.c1(OP.useProgram, p ? p.id : 0); }

  // -------- buffers

  bufferData(target: number, data: number | View | ArrayBuffer | null, usage: number, srcOffset = 0, length = 0) {
    if (typeof data === "number") return this.c3(OP.bufferDataSize, target, data, usage);
    if (data == null) return;
    const p = this.r(2);
    this.i32[p] = OP.bufferData;
    this.i32[p + 1] = target;
    this.view(data, srcOffset, length);
    this.i32[this.rc(1)] = usage;
  }
  bufferSubData(target: number, dstByteOffset: number, data: View | ArrayBuffer, srcOffset = 0, length = 0) {
    if (data == null) return;
    this.c2(OP.bufferSubData, target, dstByteOffset);
    this.view(data, srcOffset, length);
  }
  copyBufferSubData(read: number, write: number, readOffset: number, writeOffset: number, size: number) {
    this.c5(OP.copyBufferSubData, read, write, readOffset, writeOffset, size);
  }
  getBufferSubData(target: number, srcByteOffset: number, dst: View, dstOffset = 0, length = 0) {
    const bpe = (dst as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT || 1;
    const off = dstOffset * bpe, len = length ? length * bpe : dst.byteLength - off;
    this.c3(OP.getBufferSubData, target, srcByteOffset, len);
    const r = this._flush();
    if (r instanceof ArrayBuffer) new Uint8Array(dst.buffer, dst.byteOffset + off, Math.min(len, r.byteLength)).set(new Uint8Array(r, 0, Math.min(len, r.byteLength)));
  }

  // -------- vertex attributes

  enableVertexAttribArray(i: number) { this.c1(OP.enableVertexAttribArray, i); }
  disableVertexAttribArray(i: number) { this.c1(OP.disableVertexAttribArray, i); }
  vertexAttribPointer(i: number, size: number, type: number, normalized: boolean, stride: number, offset: number) {
    this.c6(OP.vertexAttribPointer, i, size, type, +!!normalized, stride, offset);
  }
  vertexAttribIPointer(i: number, size: number, type: number, stride: number, offset: number) { this.c5(OP.vertexAttribIPointer, i, size, type, stride, offset); }
  vertexAttribDivisor(i: number, d: number) { this.c2(OP.vertexAttribDivisor, i, d); }
  vertexAttrib1f(i: number, x: number) { const p = this.r(3), f = this.f32; this.i32[p] = OP.vertexAttrib1f; this.i32[p + 1] = i; f[p + 2] = x; }
  vertexAttrib2f(i: number, x: number, y: number) { const p = this.r(4), f = this.f32; this.i32[p] = OP.vertexAttrib2f; this.i32[p + 1] = i; f[p + 2] = x; f[p + 3] = y; }
  vertexAttrib3f(i: number, x: number, y: number, z: number) { const p = this.r(5), f = this.f32; this.i32[p] = OP.vertexAttrib3f; this.i32[p + 1] = i; f[p + 2] = x; f[p + 3] = y; f[p + 4] = z; }
  vertexAttrib4f(i: number, x: number, y: number, z: number, w: number) { const p = this.r(6), f = this.f32; this.i32[p] = OP.vertexAttrib4f; this.i32[p + 1] = i; f[p + 2] = x; f[p + 3] = y; f[p + 4] = z; f[p + 5] = w; }
  vertexAttrib1fv(i: number, v: Nums) { this.vertexAttrib1f(i, v[0]); }
  vertexAttrib2fv(i: number, v: Nums) { this.vertexAttrib2f(i, v[0], v[1]); }
  vertexAttrib3fv(i: number, v: Nums) { this.vertexAttrib3f(i, v[0], v[1], v[2]); }
  vertexAttrib4fv(i: number, v: Nums) { this.vertexAttrib4f(i, v[0], v[1], v[2], v[3]); }
  vertexAttribI4i(i: number, x: number, y: number, z: number, w: number) { this.c5(OP.vertexAttribI4i, i, x, y, z, w); }
  vertexAttribI4ui(i: number, x: number, y: number, z: number, w: number) { this.c5(OP.vertexAttribI4ui, i, x, y, z, w); }
  vertexAttribI4iv(i: number, v: Nums) { this.c5(OP.vertexAttribI4i, i, v[0], v[1], v[2], v[3]); }
  vertexAttribI4uiv(i: number, v: Nums) { this.c5(OP.vertexAttribI4ui, i, v[0], v[1], v[2], v[3]); }

  // -------- drawing

  clear(mask: number) { this.c1(OP.clear, mask); this.drawn(); }
  drawArrays(mode: number, first: number, count: number) { this.c3(OP.drawArrays, mode, first, count); this.drawn(); }
  drawElements(mode: number, count: number, type: number, offset: number) { this.c4(OP.drawElements, mode, count, type, offset); this.drawn(); }
  drawArraysInstanced(mode: number, first: number, count: number, n: number) { this.c4(OP.drawArraysInstanced, mode, first, count, n); this.drawn(); }
  drawElementsInstanced(mode: number, count: number, type: number, offset: number, n: number) { this.c5(OP.drawElementsInstanced, mode, count, type, offset, n); this.drawn(); }
  drawRangeElements(mode: number, start: number, end: number, count: number, type: number, offset: number) { this.c6(OP.drawRangeElements, mode, start, end, count, type, offset); this.drawn(); }
  clearBufferfv(buffer: number, drawbuffer: number, values: Nums, srcOffset = 0) { this.c2(OP.clearBufferfv, buffer, drawbuffer); this.nums(values, F32, srcOffset); this.drawn(); }
  clearBufferiv(buffer: number, drawbuffer: number, values: Nums, srcOffset = 0) { this.c2(OP.clearBufferiv, buffer, drawbuffer); this.nums(values, I32, srcOffset); this.drawn(); }
  clearBufferuiv(buffer: number, drawbuffer: number, values: Nums, srcOffset = 0) { this.c2(OP.clearBufferuiv, buffer, drawbuffer); this.nums(values, U32, srcOffset); this.drawn(); }
  clearBufferfi(buffer: number, drawbuffer: number, depth: number, stencil: number) {
    const p = this.r(5);
    this.i32[p] = OP.clearBufferfi; this.i32[p + 1] = buffer; this.i32[p + 2] = drawbuffer; this.f32[p + 3] = depth; this.i32[p + 4] = stencil;
    this.drawn();
  }
  blitFramebuffer(sx0: number, sy0: number, sx1: number, sy1: number, dx0: number, dy0: number, dx1: number, dy1: number, mask: number, filter: number) {
    this.cn(OP.blitFramebuffer, sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter);
    this.drawn();
  }

  // -------- framebuffers and renderbuffers

  private fbFor(target: number): Fb { return target === GL.READ_FRAMEBUFFER ? this.readFb : this.drawFb; }
  private attach(target: number, attachment: number, o: WebGLTexture_ | WebGLRenderbuffer_ | null) {
    const f = this.fbFor(target);
    if (!f) return;
    const m = (f._att ??= new Map());
    const at = attachment === GL.DEPTH_STENCIL_ATTACHMENT ? [GL.DEPTH_ATTACHMENT, GL.STENCIL_ATTACHMENT, attachment] : [attachment];
    for (const a of at) o ? m.set(a, o) : m.delete(a);
  }
  framebufferTexture2D(target: number, attachment: number, textarget: number, t: Tex, level: number) {
    this.attach(target, attachment, t);
    this.c5(OP.framebufferTexture2D, target, attachment, textarget, t ? t.id : 0, level);
  }
  framebufferTextureLayer(target: number, attachment: number, t: Tex, level: number, layer: number) {
    this.attach(target, attachment, t);
    this.c5(OP.framebufferTextureLayer, target, attachment, t ? t.id : 0, level, layer);
  }
  framebufferRenderbuffer(target: number, attachment: number, rbTarget: number, r: Rb) {
    this.attach(target, attachment, r);
    this.c4(OP.framebufferRenderbuffer, target, attachment, rbTarget, r ? r.id : 0);
  }
  renderbufferStorage(target: number, format: number, w: number, h: number) { this.c4(OP.renderbufferStorage, target, format, w, h); }
  renderbufferStorageMultisample(target: number, samples: number, format: number, w: number, h: number) { this.c5(OP.renderbufferStorageMultisample, target, samples, format, w, h); }
  invalidateFramebuffer(target: number, attachments: Nums) { this.c1(OP.invalidateFramebuffer, target); this.nums(attachments, I32); }
  invalidateSubFramebuffer(target: number, attachments: Nums, _x: number, _y: number, _w: number, _h: number) { this.invalidateFramebuffer(target, attachments); }
  checkFramebufferStatus(target: number): number { this.c1(OP.checkFramebufferStatus, target); return Number(this._flush()) || 0; }
  getFramebufferAttachmentParameter(target: number, attachment: number, pname: number): unknown {
    const f = this.fbFor(target);
    if (f && pname === GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME) return f._att?.get(attachment) ?? null;
    this.c3(OP.getFramebufferAttachmentParameter, target, attachment, pname);
    return Number(this._flush());
  }
  getRenderbufferParameter(target: number, pname: number): number { this.c2(OP.getRenderbufferParameter, target, pname); return Number(this._flush()); }
  getInternalformatParameter(target: number, format: number, pname: number): Int32Array | null {
    this.c3(OP.getInternalformatParameter, target, format, pname);
    const r = this._flush();
    if (typeof r !== "string") return null;
    const v = JSON.parse(r) as number[] | number | null;
    return v == null ? null : new Int32Array(Array.isArray(v) ? v : [v]);
  }

  // -------- textures

  generateMipmap(target: number) { this.c1(OP.generateMipmap, target); }
  texParameteri(target: number, pname: number, v: number) { this.c3(OP.texParameteri, target, pname, v); }
  texParameterf(target: number, pname: number, v: number) { const p = this.r(4); this.i32[p] = OP.texParameterf; this.i32[p + 1] = target; this.i32[p + 2] = pname; this.f32[p + 3] = v; }
  getTexParameter(target: number, pname: number): unknown {
    this.c2(OP.getTexParameter, target, pname);
    const r = Number(this._flush());
    return pname === GL.TEXTURE_IMMUTABLE_FORMAT ? !!r : r;
  }
  texStorage2D(target: number, levels: number, format: number, w: number, h: number) { this.c5(OP.texStorage2D, target, levels, format, w, h); }
  texStorage3D(target: number, levels: number, format: number, w: number, h: number, d: number) { this.c6(OP.texStorage3D, target, levels, format, w, h, d); }
  copyTexImage2D(target: number, level: number, format: number, x: number, y: number, w: number, h: number, border: number) {
    this.cn(OP.copyTexImage2D, target, level, format, x, y, w, h, border);
  }
  copyTexSubImage2D(target: number, level: number, xo: number, yo: number, x: number, y: number, w: number, h: number) {
    this.cn(OP.copyTexSubImage2D, target, level, xo, yo, x, y, w, h);
  }
  copyTexSubImage3D(target: number, level: number, xo: number, yo: number, zo: number, x: number, y: number, w: number, h: number) {
    this.cn(OP.copyTexSubImage3D, target, level, xo, yo, zo, x, y, w, h);
  }
  compressedTexImage2D(target: number, level: number, format: number, w: number, h: number, border: number, data: View | number, srcOffset = 0, length = 0) {
    if (typeof data === "number") throw todo("compressedTexImage2D from a PIXEL_UNPACK_BUFFER");
    this.c6(OP.compressedTexImage2D, target, level, format, w, h, border);
    this.view(data, srcOffset, length);
  }
  compressedTexSubImage2D(target: number, level: number, x: number, y: number, w: number, h: number, format: number, data: View | number, srcOffset = 0, length = 0) {
    if (typeof data === "number") throw todo("compressedTexSubImage2D from a PIXEL_UNPACK_BUFFER");
    this.cn(OP.compressedTexSubImage2D, target, level, x, y, w, h, format);
    this.view(data, srcOffset, length);
  }
  /** texImage2D(target, level, internalformat, format, type, source), or (target, level, internalformat, width,
   *  height, border, format, type, pixels | source, srcOffset?) */
  texImage2D(target: number, level: number, ifmt: number, a: number, b: number, c: unknown, d?: number, e?: number, src?: unknown, srcOffset = 0) {
    if (arguments.length <= 6) return this.source(false, target, level, ifmt, 0, 0, 0, a, b, c, "texImage2D");
    const [w, h, format, type] = [a, b, Number(d), Number(e)];
    if (src == null) return this.tex2D(target, level, ifmt, w, h, Number(c), format, type, null, 0);
    if (ArrayBuffer.isView(src)) return this.tex2D(target, level, ifmt, w, h, Number(c), format, type, src, srcOffset);
    if (typeof src === "number") throw todo("texImage2D from a PIXEL_UNPACK_BUFFER");
    this.source(false, target, level, ifmt, 0, w, h, format, type, src, "texImage2D");
  }
  /** texSubImage2D(target, level, x, y, format, type, source), or (target, level, x, y, width, height, format, type,
   *  pixels | source, srcOffset?) */
  texSubImage2D(target: number, level: number, x: number, y: number, a: number, b: number, c: unknown, d?: number, src?: unknown, srcOffset = 0) {
    if (arguments.length <= 7) return this.source(true, target, level, x, y, 0, 0, a, b, c, "texSubImage2D");
    const [w, h, format, type] = [a, b, Number(c), Number(d)];
    if (ArrayBuffer.isView(src)) {
      this.cn(OP.texSubImage2D, target, level, x, y, w, h, format, type);
      return this.view(src, srcOffset);
    }
    if (typeof src === "number") throw todo("texSubImage2D from a PIXEL_UNPACK_BUFFER");
    if (src == null) throw new TypeError("texSubImage2D: no pixels");
    this.source(true, target, level, x, y, w, h, format, type, src, "texSubImage2D");
  }
  private tex2D(target: number, level: number, ifmt: number, w: number, h: number, border: number, format: number, type: number, px: View | null, srcOffset: number) {
    this.cn(OP.texImage2D, target, level, ifmt, w, h, border, format, type, px ? 1 : 0);
    if (px) this.view(px, srcOffset);
    else this.u32[this.rc(1)] = 0;
  }
  /** A DOM source (or ImageData) uploaded: texImage2D (sub false: x is the internal format) or texSubImage2D. w/h 0
   *  mean the source's own size. */
  private source(sub: boolean, target: number, level: number, x: number, y: number, w: number, h: number, format: number, type: number, src: unknown, fn: string) {
    const s = src as Record<string, unknown> | null;
    if (s == null || typeof s !== "object") throw new TypeError(`${fn}: no source`);
    // ImageData: its bytes
    if (s.data instanceof Uint8ClampedArray && typeof s.width === "number" && typeof s.height === "number") {
      if (format !== GL.RGBA || type !== GL.UNSIGNED_BYTE) throw todo(`${fn} from ImageData as anything but RGBA/UNSIGNED_BYTE`);
      const [sw, sh] = [s.width, s.height as number];
      if (sub) {
        this.cn(OP.texSubImage2D, target, level, x, y, sw, sh, format, type);
        this.view(s.data);
      } else this.tex2D(target, level, x, sw, sh, 0, format, type, s.data, 0);
      return;
    }
    let kind = 0, ref = "";
    const gl = (s.__gl ?? s._ctx) as unknown;
    const c2 = (s.__ctx2d ?? s._ctx) as { _source?: () => string } | undefined;
    const tag = String(s.tagName ?? "").toUpperCase();
    if (gl instanceof WebGL2RenderingContext_) {
      gl._flush();
      [kind, ref] = [3, String(gl._ctx)];
    } else if (c2 && typeof c2._source === "function") {
      [kind, ref] = [2, c2._source()];
    } else if (tag === "CANVAS" || (typeof s.getContext === "function" && tag !== "VIDEO")) {
      // a canvas nothing has drawn on: transparent black of its size
      const [sw, sh] = [w || Number(s.width) || 0, h || Number(s.height) || 0];
      if (!sub) return this.tex2D(target, level, x, sw, sh, 0, format, type, null, 0);
      const al = this.pix[GL.UNPACK_ALIGNMENT] || 4, row = Math.ceil((sw * texelBytes(format, type)) / al) * al;
      this.cn(OP.texSubImage2D, target, level, x, y, sw, sh, format, type);
      return this.view(new Uint8Array(row * sh));
    } else if (tag === "IMG" || "naturalWidth" in s) {
      ref = String(s.currentSrc || s.src || "");
      if (!ref) {
        if (!sub) this.tex2D(target, level, x, 0, 0, 0, format, type, null, 0);
        return;
      }
      kind = 1;
    } else throw todo(`${fn} from ${what(src)}`);
    if (sub) this.cn(OP.texSubImage2DSource, target, level, x, y, w, h, format, type, kind);
    else this.cn(OP.texImage2DSource, target, level, x, w, h, format, type, kind);
    this.str(ref);
  }
  texImage3D(target: number, level: number, ifmt: number, w: number, h: number, d: number, border: number, format: number, type: number, src: View | null | number, srcOffset = 0) {
    if (typeof src === "number") throw todo("texImage3D from a PIXEL_UNPACK_BUFFER");
    if (src != null && !ArrayBuffer.isView(src)) throw todo(`texImage3D from ${what(src)}`);
    this.cn(OP.texImage3D, target, level, ifmt, w, h, d, border, format, type, src ? 1 : 0);
    if (src) this.view(src, srcOffset);
    else this.u32[this.rc(1)] = 0;
  }
  texSubImage3D(target: number, level: number, x: number, y: number, z: number, w: number, h: number, d: number, format: number, type: number, src: View | null | number, srcOffset = 0) {
    if (typeof src === "number") throw todo("texSubImage3D from a PIXEL_UNPACK_BUFFER");
    if (src == null) throw new TypeError("texSubImage3D: no pixels");
    if (!ArrayBuffer.isView(src)) throw todo(`texSubImage3D from ${what(src)}`);
    this.cn(OP.texSubImage3D, target, level, x, y, z, w, h, d, format, type);
    this.view(src, srcOffset);
  }

  // -------- samplers and queries

  samplerParameteri(s: WebGLSampler_, pname: number, v: number) { this.c3(OP.samplerParameteri, s ? s.id : 0, pname, v); }
  samplerParameterf(s: WebGLSampler_, pname: number, v: number) { const p = this.r(4); this.i32[p] = OP.samplerParameterf; this.i32[p + 1] = s ? s.id : 0; this.i32[p + 2] = pname; this.f32[p + 3] = v; }
  beginQuery(target: number, q: WebGLQuery_) {
    if (q) q._bound = true;
    this.queries[target] = q;
    this.c2(OP.beginQuery, target, q ? q.id : 0);
  }
  endQuery(target: number) { this.queries[target] = null; this.c1(OP.endQuery, target); }
  getQuery(target: number, pname: number) { return pname === GL.CURRENT_QUERY ? this.queries[target] ?? null : null; }
  getQueryParameter(q: WebGLQuery_, pname: number): unknown {
    this.c2(OP.getQueryParameter, q ? q.id : 0, pname);
    const r = Number(this._flush());
    return pname === GL.QUERY_RESULT_AVAILABLE ? !!r : r;
  }

  // -------- shaders and programs

  shaderSource(s: WebGLShader_, src: string) {
    if (!s) return;
    s._source = String(src);
    this.c1(OP.shaderSource, s.id);
    this.str(s._source);
  }
  getShaderSource(s: WebGLShader_) { return s ? s._source : null; }
  compileShader(s: WebGLShader_) { this.c1(OP.compileShader, s ? s.id : 0); }
  attachShader(p: WebGLProgram_, s: WebGLShader_) {
    if (p && s && !p._shaders.includes(s)) p._shaders.push(s);
    this.c2(OP.attachShader, p ? p.id : 0, s ? s.id : 0);
  }
  detachShader(p: WebGLProgram_, s: WebGLShader_) {
    if (p) p._shaders = p._shaders.filter((x) => x !== s);
    this.c2(OP.detachShader, p ? p.id : 0, s ? s.id : 0);
  }
  getAttachedShaders(p: WebGLProgram_) { return p ? p._shaders.slice() : null; }
  linkProgram(p: WebGLProgram_) {
    if (p) p._locs.clear();
    this.c1(OP.linkProgram, p ? p.id : 0);
  }
  validateProgram(p: WebGLProgram_) { this.c1(OP.validateProgram, p ? p.id : 0); }
  bindAttribLocation(p: WebGLProgram_, index: number, name: string) { this.c2(OP.bindAttribLocation, p ? p.id : 0, index); this.str(name); }
  getShaderParameter(s: WebGLShader_, pname: number): unknown {
    if (!s) return null;
    if (pname === GL.DELETE_STATUS) return s._deleted;
    if (pname === GL.SHADER_TYPE) return s._type;
    if (pname === COMPLETION_STATUS_KHR) return true;
    this.c2(OP.getShaderParameter, s.id, pname);
    const r = Number(this._flush());
    return pname === GL.COMPILE_STATUS ? !!r : r;
  }
  getProgramParameter(p: WebGLProgram_, pname: number): unknown {
    if (!p) return null;
    if (pname === GL.DELETE_STATUS) return p._deleted;
    if (pname === GL.ATTACHED_SHADERS) return p._shaders.length;
    if (pname === COMPLETION_STATUS_KHR) return true;
    this.c2(OP.getProgramParameter, p.id, pname);
    const r = Number(this._flush());
    return pname === GL.LINK_STATUS || pname === GL.VALIDATE_STATUS ? !!r : r;
  }
  getShaderInfoLog(s: WebGLShader_): string | null { if (!s) return null; this.c1(OP.getShaderInfoLog, s.id); return String(this._flush() ?? ""); }
  getProgramInfoLog(p: WebGLProgram_): string | null { if (!p) return null; this.c1(OP.getProgramInfoLog, p.id); return String(this._flush() ?? ""); }
  getShaderPrecisionFormat(shaderType: number, precision: number) {
    const key = shaderType * 65536 + precision;
    const have = this.precision.get(key);
    if (have) return have;
    this.c2(OP.getShaderPrecisionFormat, shaderType, precision);
    const r = this._flush();
    const v = typeof r === "string" ? (JSON.parse(r) as { rangeMin: number; rangeMax: number; precision: number } | null) : null;
    if (!v) return null;
    const out = new WebGLShaderPrecisionFormat_(v.rangeMin, v.rangeMax, v.precision);
    this.precision.set(key, out);
    return out;
  }
  private active(op: number, p: WebGLProgram_, index: number) {
    if (!p) return null;
    this.c2(op, p.id, index);
    const r = this._flush();
    const v = typeof r === "string" ? (JSON.parse(r) as { name: string; size: number; type: number } | null) : null;
    return v ? new WebGLActiveInfo_(v.name, v.size, v.type) : null;
  }
  getActiveUniform(p: WebGLProgram_, index: number) { return this.active(OP.getActiveUniform, p, index); }
  getActiveAttrib(p: WebGLProgram_, index: number) { return this.active(OP.getActiveAttrib, p, index); }
  getAttribLocation(p: WebGLProgram_, name: string): number {
    if (!p) return -1;
    this.c1(OP.getAttribLocation, p.id);
    this.str(name);
    return Number(this._flush());
  }
  getUniformLocation(p: WebGLProgram_, name: string): Loc {
    if (!p) return null;
    name = String(name);
    const have = p._locs.get(name);
    if (have !== undefined) return have;
    const id = ++this.nLoc;
    this.c2(OP.getUniformLocation, p.id, id);
    this.str(name);
    const loc = Number(this._flush()) === 1 ? new WebGLUniformLocation_(id, p) : null;
    p._locs.set(name, loc);
    return loc;
  }
  getUniformBlockIndex(p: WebGLProgram_, name: string): number {
    this.c1(OP.getUniformBlockIndex, p ? p.id : 0);
    this.str(name);
    return Number(this._flush()) >>> 0;
  }
  uniformBlockBinding(p: WebGLProgram_, index: number, binding: number) { this.c3(OP.uniformBlockBinding, p ? p.id : 0, index, binding); }

  // -------- uniforms (a null location drops the call)

  uniform1f(l: Loc, x: number) { if (!l) return; const p = this.r(3), f = this.f32; this.i32[p] = OP.uniform1f; this.u32[p + 1] = l.id; f[p + 2] = x; }
  uniform2f(l: Loc, x: number, y: number) { if (!l) return; const p = this.r(4), f = this.f32; this.i32[p] = OP.uniform2f; this.u32[p + 1] = l.id; f[p + 2] = x; f[p + 3] = y; }
  uniform3f(l: Loc, x: number, y: number, z: number) { if (!l) return; const p = this.r(5), f = this.f32; this.i32[p] = OP.uniform3f; this.u32[p + 1] = l.id; f[p + 2] = x; f[p + 3] = y; f[p + 4] = z; }
  uniform4f(l: Loc, x: number, y: number, z: number, w: number) { if (!l) return; const p = this.r(6), f = this.f32; this.i32[p] = OP.uniform4f; this.u32[p + 1] = l.id; f[p + 2] = x; f[p + 3] = y; f[p + 4] = z; f[p + 5] = w; }
  uniform1i(l: Loc, x: number) { if (l) this.c2(OP.uniform1i, l.id, x); }
  uniform2i(l: Loc, x: number, y: number) { if (l) this.c3(OP.uniform2i, l.id, x, y); }
  uniform3i(l: Loc, x: number, y: number, z: number) { if (l) this.c4(OP.uniform3i, l.id, x, y, z); }
  uniform4i(l: Loc, x: number, y: number, z: number, w: number) { if (l) this.c5(OP.uniform4i, l.id, x, y, z, w); }
  uniform1ui(l: Loc, x: number) { if (l) this.c2(OP.uniform1ui, l.id, x); }
  uniform2ui(l: Loc, x: number, y: number) { if (l) this.c3(OP.uniform2ui, l.id, x, y); }
  uniform3ui(l: Loc, x: number, y: number, z: number) { if (l) this.c4(OP.uniform3ui, l.id, x, y, z); }
  uniform4ui(l: Loc, x: number, y: number, z: number, w: number) { if (l) this.c5(OP.uniform4ui, l.id, x, y, z, w); }
  private uv(op: number, l: Loc, d: Nums, kind: number, srcOffset: number, length: number) {
    if (!l) return;
    const p = this.r(2);
    this.i32[p] = op;
    this.u32[p + 1] = l.id;
    this.nums(d, kind, srcOffset, length);
  }
  uniform1fv(l: Loc, d: Nums, o = 0, n = 0) { this.uv(OP.uniform1fv, l, d, F32, o, n); }
  uniform2fv(l: Loc, d: Nums, o = 0, n = 0) { this.uv(OP.uniform2fv, l, d, F32, o, n); }
  uniform3fv(l: Loc, d: Nums, o = 0, n = 0) { this.uv(OP.uniform3fv, l, d, F32, o, n); }
  uniform4fv(l: Loc, d: Nums, o = 0, n = 0) { this.uv(OP.uniform4fv, l, d, F32, o, n); }
  uniform1iv(l: Loc, d: Nums, o = 0, n = 0) { this.uv(OP.uniform1iv, l, d, I32, o, n); }
  uniform2iv(l: Loc, d: Nums, o = 0, n = 0) { this.uv(OP.uniform2iv, l, d, I32, o, n); }
  uniform3iv(l: Loc, d: Nums, o = 0, n = 0) { this.uv(OP.uniform3iv, l, d, I32, o, n); }
  uniform4iv(l: Loc, d: Nums, o = 0, n = 0) { this.uv(OP.uniform4iv, l, d, I32, o, n); }
  uniform1uiv(l: Loc, d: Nums, o = 0, n = 0) { this.uv(OP.uniform1uiv, l, d, U32, o, n); }
  uniform2uiv(l: Loc, d: Nums, o = 0, n = 0) { this.uv(OP.uniform2uiv, l, d, U32, o, n); }
  uniform3uiv(l: Loc, d: Nums, o = 0, n = 0) { this.uv(OP.uniform3uiv, l, d, U32, o, n); }
  uniform4uiv(l: Loc, d: Nums, o = 0, n = 0) { this.uv(OP.uniform4uiv, l, d, U32, o, n); }
  private um(op: number, l: Loc, t: boolean, d: Nums, srcOffset: number, length: number) {
    if (!l) return;
    const p = this.r(3);
    this.i32[p] = op;
    this.u32[p + 1] = l.id;
    this.i32[p + 2] = +!!t;
    this.nums(d, F32, srcOffset, length);
  }
  uniformMatrix2fv(l: Loc, t: boolean, d: Nums, o = 0, n = 0) { this.um(OP.uniformMatrix2fv, l, t, d, o, n); }
  uniformMatrix3fv(l: Loc, t: boolean, d: Nums, o = 0, n = 0) { this.um(OP.uniformMatrix3fv, l, t, d, o, n); }
  uniformMatrix4fv(l: Loc, t: boolean, d: Nums, o = 0, n = 0) { this.um(OP.uniformMatrix4fv, l, t, d, o, n); }
  uniformMatrix2x3fv(l: Loc, t: boolean, d: Nums, o = 0, n = 0) { this.um(OP.uniformMatrix2x3fv, l, t, d, o, n); }
  uniformMatrix3x2fv(l: Loc, t: boolean, d: Nums, o = 0, n = 0) { this.um(OP.uniformMatrix3x2fv, l, t, d, o, n); }
  uniformMatrix2x4fv(l: Loc, t: boolean, d: Nums, o = 0, n = 0) { this.um(OP.uniformMatrix2x4fv, l, t, d, o, n); }
  uniformMatrix4x2fv(l: Loc, t: boolean, d: Nums, o = 0, n = 0) { this.um(OP.uniformMatrix4x2fv, l, t, d, o, n); }
  uniformMatrix3x4fv(l: Loc, t: boolean, d: Nums, o = 0, n = 0) { this.um(OP.uniformMatrix3x4fv, l, t, d, o, n); }
  uniformMatrix4x3fv(l: Loc, t: boolean, d: Nums, o = 0, n = 0) { this.um(OP.uniformMatrix4x3fv, l, t, d, o, n); }

  // -------- reading

  readPixels(x: number, y: number, w: number, h: number, format: number, type: number, dst: View | number | null, dstOffset = 0) {
    if (typeof dst === "number") throw todo("readPixels into a PIXEL_PACK_BUFFER");
    if (dst == null) throw new TypeError("readPixels: no destination");
    this.c6(OP.readPixels, x, y, w, h, format, type);
    const r = this._flush();
    if (!(r instanceof ArrayBuffer)) return;
    const bpe = (dst as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT || 1;
    const off = dstOffset * bpe, n = Math.min(r.byteLength, dst.byteLength - off);
    if (n > 0) new Uint8Array(dst.buffer, dst.byteOffset + off, n).set(new Uint8Array(r, 0, n));
  }
}

export interface WebGL2RenderingContext_ extends GLConstants, Todo {}

Object.assign(WebGL2RenderingContext_.prototype, GL);
Object.assign(WebGL2RenderingContext_, GL);
Object.assign(WebGLRenderingContext_.prototype, GL);
Object.assign(WebGLRenderingContext_, GL);
for (const name of TODO) {
  Object.defineProperty(WebGL2RenderingContext_.prototype, name, {
    value() { throw todo(name); },
    writable: true,
    configurable: true,
  });
}

/** The WebGL globals a page (three.js) reaches for, where not already defined. */
export function installWebGLGlobals(g: Record<string, unknown>) {
  const all: Record<string, unknown> = {
    WebGL2RenderingContext: WebGL2RenderingContext_,
    WebGLRenderingContext: WebGLRenderingContext_,
    WebGLBuffer: WebGLBuffer_,
    WebGLFramebuffer: WebGLFramebuffer_,
    WebGLProgram: WebGLProgram_,
    WebGLQuery: WebGLQuery_,
    WebGLRenderbuffer: WebGLRenderbuffer_,
    WebGLSampler: WebGLSampler_,
    WebGLShader: WebGLShader_,
    WebGLTexture: WebGLTexture_,
    WebGLVertexArrayObject: WebGLVertexArrayObject_,
    WebGLUniformLocation: WebGLUniformLocation_,
    WebGLActiveInfo: WebGLActiveInfo_,
    WebGLShaderPrecisionFormat: WebGLShaderPrecisionFormat_,
  };
  for (const [k, v] of Object.entries(all)) if (g[k] === undefined) g[k] = v;
}
