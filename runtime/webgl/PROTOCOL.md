# WebGL in raea: the contract every part codes against

A page's `canvas.getContext("webgl2")` is a TypeScript `WebGL2RenderingContext` (sdk/raea/src/webgl) that writes GL
calls into a byte buffer. One native, `__raea_gl`, hands the buffer to Rust (runtime/webgl), which runs each call on
ANGLE (Google's GL ES, the one Chrome uses for WebGL), loaded from `libEGL` + `libGLESv2`. Everything runs on the JS
thread: GL contexts are thread-bound. The canvas's pixels reach the page the way a 2D canvas's do.

```
three.js -> WebGL2RenderingContext (TS) -> command bytes -> __raea_gl -> exec.rs -> glow -> ANGLE
                                                                          snapshot -> raea_sys_canvas::frames
canvas element prop __webgl {ctx, gen, w, h} -> page-ops takes the frame -> RasterImageData -> Vello
```

## Files and who owns them

| File | What |
|---|---|
| `runtime/webgl/ops.tsv`, `gen.mjs` | the op table; `node runtime/webgl/gen.mjs` writes `src/ops.rs` and `sdk/raea/src/webgl/ops.ts`. Add an op here only |
| `runtime/webgl/src/lib.rs` | the native, the `webgl.*` calls, the thread's contexts |
| `runtime/webgl/src/angle.rs` | ANGLE loaded, the EGL display, a context and its drawing buffer, resize, snapshot, read-back |
| `runtime/webgl/src/exec.rs` | the command bytes decoded and run; object ids to GL names; the answers |
| `runtime/webgl/src/source.rs` | texture sources decoded to pixels; WebGL's unpack rules |
| `systems/canvas/src/frames.rs` | finished frames handed from the JS thread to the page |
| `sdk/raea/src/webgl/context.ts`, `constants.ts`, `objects.ts` | the `WebGL2RenderingContext` interface |
| `sdk/raea/src/remotion/canvas.ts`, `document.ts` | `getContext("webgl2")` on page and off-page canvases, delivery |
| `sdk/raea/src/remotion/three.ts` | `@remotion/three`'s ThreeCanvas on the real context |
| `runtime/jsengine` | natives that take and return bytes |

Crates: `glow` 0.17, `khronos-egl` 6 (feature `dynamic`) and `libloading` 0.8 are already in Cargo.lock (wgpu uses
them). Use those; add no other crate.

## ANGLE

- Found in `RAEA_ANGLE_DIR`, else `vendor/angle/<platform>` beside the workspace (`linux-x64`, `mac-arm64`), looked
  up from the running binary (`target/release/raea` → `../../vendor/angle/...`) and from the current directory.
  Missing: every `webgl.create` fails with `WebGL needs ANGLE: run scripts/fetch-angle.sh`. Nothing else is tried.
- Display: `eglGetPlatformDisplayEXT(EGL_PLATFORM_ANGLE_ANGLE 0x3202, null, attrs)`. Linux:
  `EGL_PLATFORM_ANGLE_TYPE_ANGLE 0x3203 = VULKAN 0x3450`, `EGL_PLATFORM_ANGLE_DEVICE_TYPE_ANGLE 0x3209 =
  SWIFTSHADER 0x3487`. ANGLE points the Vulkan loader at the `vk_swiftshader_icd.json` beside it while it makes its
  instance; nothing is set for the process, so Bevy's own wgpu device picks its own driver. macOS: type `METAL 0x3489`. `RAEA_ANGLE_BACKEND=metal|vulkan|swiftshader|opengl` overrides.
- One display a process. One EGL context per WebGL context, ES 3.0, all in one share group, each made with
  `EGL_CONTEXT_WEBGL_COMPATIBILITY_ANGLE 0x33AC = 1` (ANGLE then validates and translates shaders by the WebGL 2
  spec, as it does for Chrome) and `EGL_EXTENSIONS_ENABLED_ANGLE 0x345F = 0` (extensions come on only when the page
  asks: `requestExtension`). Also, as Chrome: `EGL_CONTEXT_OPENGL_BACKWARDS_COMPATIBLE_ANGLE 0x3483 = 0` (ES 3.0, not
  3.1), `EGL_CONTEXT_CLIENT_ARRAYS_ENABLED_ANGLE 0x3452 = 0` (an offset with no buffer bound is never read as a
  pointer), `EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE 0x3453 = 1` (textures and buffers start zeroed). A 1x1 pbuffer is the surface; drawing goes to our own framebuffer.
- Drawing buffer (what `bindFramebuffer(target, null)` binds): an FBO of the canvas's size clamped to the smallest of
  MAX_RENDERBUFFER_SIZE, MAX_TEXTURE_SIZE and MAX_VIEWPORT_DIMS (as Chrome clamps it), RGBA8 color (RGB8 when
  `alpha: false`), and as Chrome exposes them: DEPTH_COMPONENT24 on DEPTH_ATTACHMENT for `depth` alone,
  STENCIL_INDEX8 on STENCIL_ATTACHMENT for `stencil` alone, DEPTH24_STENCIL8 for both, nothing for neither. A
  resize makes the new buffers and checks them complete before it frees the old; when that fails the old stay. With `antialias: true` it is multisampled
  (min(4, MAX_SAMPLES)) and resolved into a single-sample FBO before anything reads it (`readPixels`,
  `copyTex*`, `blitFramebuffer` from null, snapshot, `readCanvas`, a texture upload from this canvas).
- Scratch test, Linux, Chrome for Testing 140.0.7339.80: `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)),
  SwiftShader driver-5.0.0)`, `OpenGL ES 3.1.0 (ANGLE 2.1.25846)`, MAX_TEXTURE_SIZE 8192, MAX_SAMPLES 4.

## The native and the calls

`__raea_gl(bytes: Uint8Array, byteLength: number, ctx: number)` → `undefined | number | string | ArrayBuffer`.
Installed on the React thread's engine with `JsEngine::native_bytes`. Runs every command in `bytes[..byteLength]` on
context `ctx`, in order. Its value is the answer of the last command if that command has one. A GL or decode failure
throws an Error naming the op, and so does a `byteLength` that isn't finite, is negative or is more than the bytes.

Through `__raea_call` (JSON, runs on the same thread):

| Call | Args | Answer |
|---|---|---|
| `webgl.create` | `{ width, height, attrs: { alpha, depth, stencil, antialias, premultipliedAlpha, preserveDrawingBuffer, powerPreference?, failIfMajorPerformanceCaveat?, desynchronized? } }` (attrs already defaulted by JS) | `{ ctx: number, info: Info, width: number, height: number }`: `width`/`height` the drawing buffer's, clamped (JS's `drawingBufferWidth`/`Height`) |
| `webgl.resize` | `{ ctx, width, height }` | `{ width: number, height: number }`: the drawing buffer is remade at this size, clamped, and cleared |
| `webgl.destroy` | `{ ctx }` | `null`. Sent when the canvas leaves the page and by `WEBGL_lose_context.loseContext()`; after it `isContextLost()` is true and every call is a no-op |

`Info`: `{ version, shadingLanguageVersion, vendor, renderer, unmaskedVendor, unmaskedRenderer, extensions: string[]
(WebGL names the page may get), params: Record<number, number | number[]> }`. `params` holds every constant limit
`getParameter` answers without a round trip: MAX_TEXTURE_SIZE, MAX_CUBE_MAP_TEXTURE_SIZE, MAX_3D_TEXTURE_SIZE,
MAX_ARRAY_TEXTURE_LAYERS, MAX_RENDERBUFFER_SIZE, MAX_TEXTURE_IMAGE_UNITS, MAX_VERTEX_TEXTURE_IMAGE_UNITS,
MAX_COMBINED_TEXTURE_IMAGE_UNITS, MAX_VERTEX_ATTRIBS, MAX_VERTEX_UNIFORM_VECTORS, MAX_FRAGMENT_UNIFORM_VECTORS,
MAX_VARYING_VECTORS, MAX_SAMPLES, MAX_DRAW_BUFFERS, MAX_COLOR_ATTACHMENTS, MAX_VIEWPORT_DIMS, ALIASED_LINE_WIDTH_RANGE,
ALIASED_POINT_SIZE_RANGE, MAX_TEXTURE_MAX_ANISOTROPY_EXT, MAX_UNIFORM_BUFFER_BINDINGS, MAX_ELEMENT_INDEX,
SUBPIXEL_BITS, RED/GREEN/BLUE/ALPHA/DEPTH/STENCIL_BITS, SAMPLES, SAMPLE_BUFFERS. `VERSION` reads `WebGL 2.0 (<gl
version>)`, `SHADING_LANGUAGE_VERSION` `WebGL GLSL ES 3.00 (<gl glsl version>)`, as Chrome words them.

`ctx` ids are unique in the process (one counter), so the page can name a frame by it.

## Command bytes

Little-endian, every value 4-byte aligned. A command is `u32 op` followed by its operands in the order of its letters
in `ops.tsv`:

| Letter | Bytes | Meaning |
|---|---|---|
| `i` | i32 | a GLint, GLenum, GLsizei, GLbitfield, boolean (0/1), byte offset. Unsigned values are written as their bits |
| `f` | f32 | a float |
| `o` | u32 | an object id; 0 is null |
| `l` | u32 | a uniform location id; never 0 on the wire (JS drops a uniform call on a null location, as WebGL does) |
| `b` | u32 byteLength, bytes, zero-padded to 4 | a blob: the bytes of the typed array or ArrayBuffer passed, after JS applied any srcOffset/length. The element type is the op's (f32 for `uniform*fv`, i32 for `drawBuffers`...) |
| `s` | as `b`, UTF-8 | a string |

Answer letter: `-` none, `n` a number, `s` a string, `j` a string of JSON, `B` an ArrayBuffer. An op with an answer
must be the last command of its buffer: JS flushes what is pending, with that op at the end, in one `__raea_gl` call.

Object ids: JS allocates them, counting from 1, one counter per kind per context (buffer, framebuffer, program, query,
renderbuffer, sampler, shader, texture, vertexArray, uniformLocation). `create*` sends the new id; Rust maps it to
the GL name it makes; `delete*` drops it. The op says which kind an `o` operand is. `getUniformLocation(program, id,
name)` answers 1 and binds `id` when the uniform exists, else 0 (JS returns null and reuses nothing).

Ops that are not plain GL:

- `bindFramebuffer(target, 0)`: the context's drawing buffer.
- `bufferDataSize(target, size, usage)`: `bufferData` with a size.
- `pixelStorei`: `UNPACK_FLIP_Y_WEBGL 0x9240`, `UNPACK_PREMULTIPLY_ALPHA_WEBGL 0x9241` and
  `UNPACK_COLORSPACE_CONVERSION_WEBGL 0x9243` are kept in Rust (source.rs) and never reach GL; the rest go to GL.
- `texImage2D(target, level, internalformat, width, height, border, format, type, hasPixels, pixels)`: `hasPixels`
  0 is a null upload (the blob is empty). FLIP_Y and PREMULTIPLY apply to the bytes, as WebGL says: the rectangle
  the UNPACK row length, alignment and skips select is cut out, flipped/premultiplied and uploaded tightly packed
  (the page's UNPACK state put back after).
- `texImage2DSource(target, level, internalformat, width, height, format, type, kind, ref)` and
  `texSubImage2DSource(target, level, xoffset, yoffset, width, height, format, type, kind, ref)`: a DOM source.
  `width`/`height` 0 means the source's own size. `kind` 1: an image, `ref` its URL as `image.read` gave it
  (`file://`, `data:`, http(s)), decoded in Rust and cached by URL. `kind` 2: a 2D canvas, `ref` the JSON
  `{ uid, width, height, __canvas2d }` that `canvas.read` takes (replayed in Rust by raea_sys_canvas). `kind` 3:
  another WebGL canvas, `ref` its ctx id in decimal; JS sends it at once (flushes), so the source is read at the
  call, before its drawing buffer is cleared after its next snapshot. `ImageData` and typed arrays go through `texImage2D`.
  Sources are straight-alpha RGBA8, top row first; FLIP_Y, PREMULTIPLY and the conversion to `format`/`type` are
  done in Rust (source.rs).
- `requestExtension(name)`: the WebGL extension name; Rust enables the ANGLE extension(s) behind it.
- `readPixels(x, y, width, height, format, type)`: the bytes as GL packs them under the PACK state (JS copies them
  into the caller's array at its dstOffset). From the drawing buffer it reads the resolved image.
- `getParameter(pname)`: for what JS neither holds in `Info.params` nor tracks itself. JSON: a number, an array of
  numbers, a string, or an object id as `{ "id": n }` is not needed (JS tracks every binding itself). Integers are
  read only for the pnames known to answer one (exec.rs `SINGLE_INTEGERS`); any other pname answers `null`.
- `getActiveUniform`/`getActiveAttrib`: `{ "name", "size", "type" }` or `null`.
- `getShaderPrecisionFormat`: `{ "rangeMin", "rangeMax", "precision" }`.
- `getError`: answers GL's error. JS answers 0 without a round trip unless `RAEA_WEBGL_DEBUG=1`, when Rust also
  checks `glGetError` after every command and logs the op that raised it.
- `snapshot(gen)`: the drawing buffer (resolved) read back and put in `raea_sys_canvas::frames` under `(ctx, gen)`,
  top row first, with whether it is premultiplied (`premultipliedAlpha`). When `preserveDrawingBuffer` is false the
  buffer is then cleared to transparent black (depth 1, stencil 0), as a browser does after compositing.
- `readCanvas()`: the drawing buffer (resolved) as RGBA8, top row first, straight alpha (un-premultiplied when the
  context is premultiplied): what `toDataURL`, `drawImage(canvas)` and a `kind` 3 upload read.

WebGL 2 names with no op (transform feedback, uniform blocks beyond `uniformBlockBinding`/`getUniformBlockIndex`, sync
objects, `getUniform`, `getVertexAttrib`, 3D compressed textures): the JS method throws
`WebGL: <name> isn't in raea yet`. Add the op when something needs it.

## Delivery to the page

- JS: an op that draws into the drawing buffer (`clear`, `draw*`, `blitFramebuffer`, `clearBuffer*` while the DRAW
  framebuffer binding is null) calls `host._gldrawn()` once. The canvas glue (canvas.ts) then queues one microtask
  that: flushes with `snapshot(gen)` at the end (`gen` counts up per canvas), and pushes the element prop
  `__webgl: { ctx, gen, w, h }` through bevy-react's bridge, as `__canvas2d` is pushed. Off-page canvases never
  snapshot.
- Rust, main thread (systems/page-ops): a canvas whose `__webgl` prop changed takes `frames::take(ctx, gen)` and sets
  the node's `RasterImageData`, as for `__canvas2d`. Each `(ctx, gen)` is its own pixels, so React rendering a frame
  ahead of the compositor can't show frame f+1's 3D on frame f.
- `frames::Frame { width, height, premultiplied, data }`: RGBA8, top row first.

## Rust shapes (lib.rs holds them; each file fills its part)

```rust
pub struct Attrs { alpha, depth, stencil, antialias, premultiplied_alpha, preserve_drawing_buffer: bool }
// angle.rs
pub struct Context { pub gl: glow::Context, pub attrs: Attrs, pub width: u32, pub height: u32, pub objects: exec::Objects, pub unpack: source::Unpack, .. }
pub fn create(width: u32, height: u32, attrs: Attrs) -> Result<Context, String>;
impl Context {
    pub fn make_current(&self) -> Result<(), String>;
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), String>;
    pub fn info(&self) -> serde_json::Value;                 // Info
    pub fn request_extension(&mut self, webgl_name: &str);
    pub fn draw_framebuffer(&self) -> glow::Framebuffer;     // what null binds for drawing
    pub fn read_framebuffer(&mut self) -> glow::Framebuffer; // resolved, what null binds for reading
    pub fn mark_drawn(&mut self);                            // the resolve is stale
    pub fn read_canvas(&mut self, straight: bool) -> Vec<u8>; // RGBA8, top row first
    pub fn snapshot(&mut self, ctx: u32, generation: u64);
}
// exec.rs
pub struct Objects { .. }
pub fn run(cx: &mut Context, id: u32, bytes: &[u8]) -> Result<raea_runtime_jsengine::Ret, String>;
// source.rs
pub struct Unpack { pub flip_y: bool, pub premultiply: bool, pub colorspace: u32 }
pub struct Pixels { pub width: u32, pub height: u32, pub data: Vec<u8> }   // RGBA8 straight, top row first
pub fn load(kind: u32, reference: &str) -> Result<Pixels, String>;
pub fn for_upload(px: &Pixels, unpack: &Unpack, format: u32, ty: u32) -> Result<Vec<u8>, String>; // tightly packed bytes for glTexImage2D
pub fn flip_premultiply(bytes: &[u8], width: u32, height: u32, format: u32, ty: u32, unpack: &Unpack, alignment: u32, row_length: u32, skip_pixels: u32, skip_rows: u32) -> Result<Option<Vec<u8>>, String>; // FLIP_Y / PREMULTIPLY on a typed-array upload: the rectangle the skips select, tightly packed; None: as is
```
