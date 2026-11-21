//! The command bytes decoded and run on a context (PROTOCOL.md "Command bytes"): object ids to GL names, the answers.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::LazyLock;

use glow::{HasContext, PixelPackData, PixelUnpackData};
use raea_runtime_jsengine::Ret;
use serde_json::{Value, json};

use crate::source::{self, Pixels};
use crate::{Context, ops};

/// RAEA_WEBGL_DEBUG=1: GL's error checked after every command and logged with the op that raised it.
static DEBUG: LazyLock<bool> = LazyLock::new(|| std::env::var("RAEA_WEBGL_DEBUG").is_ok_and(|v| v == "1"));

const FRAMEBUFFER: u32 = 0x8D40;
const READ_FRAMEBUFFER: u32 = 0x8CA8;
const DRAW_FRAMEBUFFER: u32 = 0x8CA9;
const PIXEL_PACK_BUFFER: u32 = 0x88EB;
const PIXEL_UNPACK_BUFFER: u32 = 0x88EC;
const COLOR_ATTACHMENT0: u32 = 0x8CE0;
const INVALID_ENUM: u32 = 0x0500;
const INVALID_OPERATION: u32 = 0x0502;

/// The page's objects by id, each kind its own map, and the page state GL can't hold for us: the page's framebuffer
/// bindings (0 is the drawing buffer), the pixel-store values, the pixel buffers bound, an error raised here.
#[derive(Default)]
pub struct Objects {
    buffers: HashMap<u32, glow::Buffer>,
    framebuffers: HashMap<u32, glow::Framebuffer>,
    programs: HashMap<u32, glow::Program>,
    queries: HashMap<u32, glow::Query>,
    renderbuffers: HashMap<u32, glow::Renderbuffer>,
    samplers: HashMap<u32, glow::Sampler>,
    /// each shader with its type
    shaders: HashMap<u32, (glow::Shader, u32)>,
    textures: HashMap<u32, glow::Texture>,
    vertex_arrays: HashMap<u32, glow::VertexArray>,
    /// location id to its program's id and the location
    locations: HashMap<u32, (u32, glow::UniformLocation)>,
    read_fb: u32,
    draw_fb: u32,
    unpack: Layout,
    pack: Layout,
    pack_buffer: Option<glow::Buffer>,
    unpack_buffer: Option<glow::Buffer>,
    /// the first error raised here or taken from GL by a check, answered by the next getError
    error: u32,
}

impl Objects {
    /// Every GL object the page made, deleted (textures, buffers, programs, shaders, renderbuffers and samplers live
    /// in the share group and outlive the context otherwise). The context must be current.
    pub fn delete_all(&mut self, gl: &glow::Context) {
        unsafe {
            self.buffers.drain().for_each(|(_, v)| gl.delete_buffer(v));
            self.framebuffers.drain().for_each(|(_, v)| gl.delete_framebuffer(v));
            self.programs.drain().for_each(|(_, v)| gl.delete_program(v));
            self.queries.drain().for_each(|(_, v)| gl.delete_query(v));
            self.renderbuffers.drain().for_each(|(_, v)| gl.delete_renderbuffer(v));
            self.samplers.drain().for_each(|(_, v)| gl.delete_sampler(v));
            self.shaders.drain().for_each(|(_, v)| gl.delete_shader(v.0));
            self.textures.drain().for_each(|(_, v)| gl.delete_texture(v));
            self.vertex_arrays.drain().for_each(|(_, v)| gl.delete_vertex_array(v));
        }
        self.locations.clear();
    }

    fn raise(&mut self, error: u32) {
        if self.error == 0 {
            self.error = error;
        }
    }
}

/// Pixel-store values for one direction (UNPACK_* or PACK_*), and the bytes an image takes under them.
#[derive(Clone, Copy)]
struct Layout {
    alignment: i32,
    row_length: i32,
    image_height: i32,
    skip_pixels: i32,
    skip_rows: i32,
    skip_images: i32,
}

impl Default for Layout {
    fn default() -> Self {
        Layout { alignment: 4, ..Layout::TIGHT }
    }
}

impl Layout {
    const TIGHT: Layout = Layout { alignment: 1, row_length: 0, image_height: 0, skip_pixels: 0, skip_rows: 0, skip_images: 0 };

    /// The values a 2D image reads (IMAGE_HEIGHT and SKIP_IMAGES are for 3D only).
    fn flat(self) -> Layout {
        Layout { image_height: 0, skip_images: 0, ..self }
    }

    /// The bytes GL touches for a `w` x `h` x `d` image of `bpp`-byte pixels, None past 2 GiB (or past u64).
    fn size(&self, w: i32, h: i32, d: i32, bpp: usize) -> Option<usize> {
        if w <= 0 || h <= 0 || d <= 0 {
            return Some(0);
        }
        let (w, h, d, bpp) = (w as u64, h as u64, d as u64, bpp as u64);
        let a = self.alignment.max(1) as u64;
        let row_length = if self.row_length > 0 { self.row_length as u64 } else { w };
        let stride = row_length.checked_mul(bpp)?.div_ceil(a).checked_mul(a)?;
        let rows = if self.image_height > 0 { self.image_height as u64 } else { h };
        let images = (self.skip_images.max(0) as u64 + d - 1).checked_mul(rows)?.checked_mul(stride)?;
        let lines = (self.skip_rows.max(0) as u64 + h - 1).checked_mul(stride)?;
        let last = (self.skip_pixels.max(0) as u64 + w).checked_mul(bpp)?;
        let n = images.checked_add(lines)?.checked_add(last)?;
        usize::try_from(n).ok().filter(|&n| n <= 1 << 31)
    }
}

/// Bytes a pixel of `format`/`type` takes, None for a pair GL doesn't know (GL then refuses the call).
fn pixel_size(format: u32, ty: u32) -> Option<usize> {
    match ty {
        0x8363 | 0x8033 | 0x8034 => return Some(2),
        0x8368 | 0x8C3B | 0x8C3E | 0x84FA => return Some(4),
        0x8DAD => return Some(8),
        _ => {}
    }
    let components = match format {
        0x1903 | 0x8D94 | 0x1906 | 0x1909 | 0x1902 => 1,
        0x8227 | 0x8228 | 0x190A => 2,
        0x1907 | 0x8D98 => 3,
        0x1908 | 0x8D99 => 4,
        _ => return None,
    };
    let size = match ty {
        0x1400 | 0x1401 => 1,
        0x1402 | 0x1403 | 0x140B | 0x8D61 => 2,
        0x1404 | 0x1405 | 0x1406 => 4,
        _ => return None,
    };
    Some(components * size)
}

/// The operands of a command, read in order.
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn word(&mut self) -> Result<[u8; 4], String> {
        let w = self.bytes.get(self.pos..self.pos + 4).ok_or_else(|| format!("the bytes end at {} inside an operand", self.bytes.len()))?;
        self.pos += 4;
        Ok(w.try_into().unwrap())
    }
    fn i(&mut self) -> Result<i32, String> {
        self.word().map(i32::from_le_bytes)
    }
    fn u(&mut self) -> Result<u32, String> {
        self.word().map(u32::from_le_bytes)
    }
    fn f(&mut self) -> Result<f32, String> {
        self.word().map(f32::from_le_bytes)
    }
    fn bool(&mut self) -> Result<bool, String> {
        Ok(self.u()? != 0)
    }
    fn b(&mut self) -> Result<&'a [u8], String> {
        let len = self.u()? as usize;
        let end = self.pos.checked_add(len).map(|e| (e, (e + 3) & !3)).filter(|&(_, padded)| padded <= self.bytes.len());
        let (end, padded) = end.ok_or_else(|| format!("a {len}-byte blob at {} runs past the end ({})", self.pos, self.bytes.len()))?;
        let blob = &self.bytes[self.pos..end];
        self.pos = padded;
        Ok(blob)
    }
    fn s(&mut self) -> Result<&'a str, String> {
        let s = std::str::from_utf8(self.b()?).map_err(|e| format!("a string that isn't UTF-8: {e}"))?;
        if s.contains('\0') {
            return Err("a name with a NUL in it".into());
        }
        Ok(s)
    }
}

/// A blob as 4-byte elements.
fn words<T>(blob: &[u8], from: fn([u8; 4]) -> T) -> Result<Vec<T>, String> {
    if blob.len() % 4 != 0 {
        return Err(format!("a {}-byte blob of 4-byte elements", blob.len()));
    }
    Ok(blob.chunks_exact(4).map(|c| from(c.try_into().unwrap())).collect())
}

fn floats(blob: &[u8]) -> Result<Vec<f32>, String> {
    words(blob, f32::from_le_bytes)
}
fn ints(blob: &[u8]) -> Result<Vec<i32>, String> {
    words(blob, i32::from_le_bytes)
}
fn uints(blob: &[u8]) -> Result<Vec<u32>, String> {
    words(blob, u32::from_le_bytes)
}

/// The page's framebuffer `id`, None for null (the drawing buffer).
fn page_fb(cx: &Context, id: u32) -> Option<glow::Framebuffer> {
    cx.objects.framebuffers.get(&id).copied()
}

/// GL's READ and DRAW framebuffers set to the page's bindings, the drawing buffer for null. Run at the start of every
/// call (a resize remakes the drawing buffer) and after anything of angle.rs that binds its own.
fn rebind(cx: &Context) {
    let draw = page_fb(cx, cx.objects.draw_fb).unwrap_or_else(|| cx.draw_framebuffer());
    let read = page_fb(cx, cx.objects.read_fb).unwrap_or_else(|| cx.draw_framebuffer());
    unsafe {
        cx.gl.bind_framebuffer(DRAW_FRAMEBUFFER, Some(draw));
        cx.gl.bind_framebuffer(READ_FRAMEBUFFER, Some(read));
    }
}

/// Before a read (readPixels, copyTex*, blit source): when the page reads from null, the resolved drawing buffer.
/// `rebind` after it.
fn bind_read_source(cx: &mut Context) {
    if page_fb(cx, cx.objects.read_fb).is_none() {
        let fb = cx.read_framebuffer();
        rebind(cx);
        unsafe { cx.gl.bind_framebuffer(READ_FRAMEBUFFER, Some(fb)) };
    }
}

/// The page's binding for a framebuffer target is null.
fn target_is_null(cx: &Context, target: u32) -> bool {
    let id = if target == READ_FRAMEBUFFER { cx.objects.read_fb } else { cx.objects.draw_fb };
    page_fb(cx, id).is_none()
}

/// A default-framebuffer attachment name (BACK, COLOR, DEPTH, STENCIL) as our drawing buffer's FBO names it.
fn drawing_buffer_attachment(a: u32) -> u32 {
    match a {
        0x0405 | 0x1800 => COLOR_ATTACHMENT0,
        0x1801 => 0x8D00,
        0x1802 => 0x8D20,
        other => other,
    }
}

/// UNPACK state for a tightly packed upload (`tight`), or the page's own values back.
fn tight_unpack(cx: &Context, tight: bool) {
    let l = if tight { Layout::TIGHT } else { cx.objects.unpack };
    unsafe {
        for (pname, v) in [(0x0CF5, l.alignment), (0x0CF2, l.row_length), (0x0CF3, l.skip_rows), (0x0CF4, l.skip_pixels), (0x806E, l.image_height), (0x806D, l.skip_images)] {
            cx.gl.pixel_store_i32(pname, v);
        }
        cx.gl.bind_buffer(PIXEL_UNPACK_BUFFER, if tight { None } else { cx.objects.unpack_buffer });
    }
}

/// The bytes of a texImage/texSubImage from a typed array, checked against what GL will read under the UNPACK state
/// and with FLIP_Y / PREMULTIPLY applied (2D only: WebGL 2 refuses them for 3D uploads from typed arrays).
fn unpack_bytes<'a>(cx: &Context, blob: &'a [u8], w: i32, h: i32, d: Option<i32>, format: u32, ty: u32) -> Result<Cow<'a, [u8]>, String> {
    if cx.objects.unpack_buffer.is_some() {
        return Err("pixels from an array while a PIXEL_UNPACK_BUFFER is bound".into());
    }
    let Some(bpp) = pixel_size(format, ty) else { return Ok(Cow::Borrowed(blob)) };
    let layout = if d.is_some() { cx.objects.unpack } else { cx.objects.unpack.flat() };
    let need = layout.size(w, h, d.unwrap_or(1), bpp).ok_or("an image over 2 GiB")?;
    if blob.len() < need {
        return Err(format!("{} bytes given, {need} needed for {w}x{h} under the UNPACK state", blob.len()));
    }
    if !(cx.unpack.flip_y || cx.unpack.premultiply) {
        return Ok(Cow::Borrowed(blob));
    }
    if d.is_some() {
        return Err("UNPACK_FLIP_Y_WEBGL or UNPACK_PREMULTIPLY_ALPHA_WEBGL set for a 3D upload from an array (INVALID_OPERATION in WebGL 2)".into());
    }
    let l = cx.objects.unpack;
    let (alignment, row_length, skip_pixels, skip_rows) = (l.alignment as u32, l.row_length as u32, l.skip_pixels as u32, l.skip_rows as u32);
    Ok(match source::flip_premultiply(blob, w as u32, h as u32, format, ty, &cx.unpack, alignment, row_length, skip_pixels, skip_rows)? {
        Some(v) => Cow::Owned(v),
        None => Cow::Borrowed(blob),
    })
}

/// A 2D upload from a typed array: its bytes as given (under the page's UNPACK state), or flipped/premultiplied bytes
/// cut to the image and tightly packed (uploaded under a tight UNPACK state, the page's put back after).
fn upload_2d(cx: &Context, data: Option<&Cow<[u8]>>, call: impl FnOnce(&glow::Context, Option<&[u8]>)) {
    let tight = matches!(data, Some(Cow::Owned(_)));
    if tight {
        tight_unpack(cx, true);
    }
    call(&cx.gl, data.map(|d| &**d));
    if tight {
        tight_unpack(cx, false);
    }
}

/// A DOM source's pixels for texImage2DSource / texSubImage2DSource, cut to `w` x `h` (0: the source's size) and
/// converted for GL: the bytes and their size.
fn source_bytes(cx: &mut Context, id: u32, kind: u32, reference: &str, w: i32, h: i32, format: u32, ty: u32) -> Result<(Vec<u8>, i32, i32), String> {
    let px = if kind == 3 { canvas_pixels(cx, id, reference)? } else { source::load(kind, reference)? };
    let w = if w == 0 { px.width } else { u32::try_from(w).map_err(|_| format!("width {w}"))? };
    let h = if h == 0 { px.height } else { u32::try_from(h).map_err(|_| format!("height {h}"))? };
    if w > px.width || h > px.height {
        return Err(format!("{w}x{h} asked of a {}x{} source", px.width, px.height));
    }
    let px = if (w, h) == (px.width, px.height) {
        px
    } else {
        let row = px.width as usize * 4;
        let data = px.data.chunks_exact(row).take(h as usize).flat_map(|r| &r[..w as usize * 4]).copied().collect();
        Pixels { width: w, height: h, data }
    };
    let data = source::for_upload(&px, &cx.unpack, format, ty)?;
    if let Some(bpp) = pixel_size(format, ty) {
        let need = Layout::TIGHT.size(w as i32, h as i32, 1, bpp).ok_or("an image over 2 GiB")?;
        if data.len() < need {
            return Err(format!("the source converted to {} bytes, {need} needed", data.len()));
        }
    }
    Ok((data, w as i32, h as i32))
}

/// Another WebGL canvas's pixels (kind 3, `reference` its ctx id), read on its own context, then `cx` current again.
fn canvas_pixels(cx: &mut Context, id: u32, reference: &str) -> Result<Pixels, String> {
    let other: u32 = reference.trim().parse().map_err(|_| format!("a WebGL canvas source named {reference:?}"))?;
    if other == id {
        let data = cx.read_canvas(true);
        rebind(cx);
        return Ok(Pixels { width: cx.width, height: cx.height, data });
    }
    let read = (|| {
        let o = crate::context(other)?;
        let mut o = o.try_borrow_mut().map_err(|_| format!("WebGL context {other} is busy"))?;
        o.make_current()?;
        let data = o.read_canvas(true);
        rebind(&o);
        Ok::<_, String>(Pixels { width: o.width, height: o.height, data })
    })();
    cx.make_current()?;
    rebind(cx);
    read
}

/// The getParameter pnames that answer one integer: ES 3.0's and those of the extensions a page may turn on
/// (WEBGL_clip_cull_distance).
#[rustfmt::skip]
const SINGLE_INTEGERS: &[u32] = &[
    0x84E0, 0x0D55, 0x8894, 0x80CA, 0x80C8, 0x883D, 0x8009, 0x80CB, 0x80C9, 0x0D54, 0x8F36, 0x8F37, 0x0B45, 0x8B8D,
    0x0D56, 0x0B74, 0x8CA6, 0x8895, 0x8B8B, 0x0B46, 0x8192, 0x0D53, 0x8B9B, 0x8B9A, 0x821B, 0x8073, 0x88FF, 0x8CDF,
    0x8B4D, 0x8A2E, 0x851C, 0x8824, 0x80E9, 0x80E8, 0x9125, 0x8A2D, 0x8B49, 0x8DFD, 0x8905, 0x84E8, 0x8D57, 0x8872,
    0x0D33, 0x8C8A, 0x8C8B, 0x8C80, 0x8A2F, 0x8B4B, 0x8DFC, 0x8869, 0x8B4C, 0x9122, 0x8A2B, 0x8B4A, 0x8DFB, 0x8904,
    0x821C, 0x86A2, 0x821D, 0x87FE, 0x8DF9, 0x0D05, 0x0D02, 0x0D04, 0x0D03, 0x88ED, 0x88EF, 0x0C02, 0x8CAA, 0x0D52,
    0x8CA7, 0x80A8, 0x80A9, 0x8919, 0x8801, 0x8800, 0x8802, 0x8803, 0x8CA3, 0x0D57, 0x0B91, 0x0B94, 0x0B92, 0x0B95,
    0x0B96, 0x0B97, 0x0D50, 0x8069, 0x8C1D, 0x806A, 0x8514, 0x8E25, 0x8C8F, 0x8A28, 0x8A34, 0x0CF5, 0x806E, 0x0CF2,
    0x806D, 0x0CF4, 0x0CF3, 0x85B5,
    // DRAW_BUFFER0..15
    0x8825, 0x8826, 0x8827, 0x8828, 0x8829, 0x882A, 0x882B, 0x882C, 0x882D, 0x882E, 0x882F, 0x8830, 0x8831, 0x8832,
    0x8833, 0x8834,
    // MAX_CLIP_DISTANCES, MAX_CULL_DISTANCES, MAX_COMBINED_CLIP_AND_CULL_DISTANCES
    0x0D32, 0x82F9, 0x82FA,
];

/// getParameter's answer for any pname: strings, the array-valued and float/bool pnames by table, the one-integer
/// pnames of SINGLE_INTEGERS; anything else, or a pname GL refuses, answers null.
fn parameter(cx: &mut Context, pname: u32) -> Value {
    if cx.objects.error == 0 {
        cx.objects.error = unsafe { cx.gl.get_error() };
    }
    let gl = &cx.gl;
    let value = unsafe {
        let f = |n: usize| {
            let mut v = vec![0f32; n];
            gl.get_parameter_f32_slice(pname, &mut v);
            json!(v)
        };
        let i = |n: usize| {
            let mut v = vec![0i32; n];
            gl.get_parameter_i32_slice(pname, &mut v);
            json!(v)
        };
        match pname {
            0x1F02 => json!(format!("WebGL 2.0 ({})", gl.get_parameter_string(pname))),
            0x8B8C => json!(format!("WebGL GLSL ES 3.00 ({})", gl.get_parameter_string(pname))),
            0x1F00 | 0x1F01 => json!(gl.get_parameter_string(pname)),
            // UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL
            0x9245 => json!(gl.get_parameter_string(0x1F00)),
            0x9246 => json!(gl.get_parameter_string(0x1F01)),
            // COLOR_CLEAR_VALUE, BLEND_COLOR
            0x0C22 | 0x8005 => f(4),
            // DEPTH_RANGE, ALIASED_LINE_WIDTH_RANGE, ALIASED_POINT_SIZE_RANGE
            0x0B70 | 0x846E | 0x846D => f(2),
            // VIEWPORT, SCISSOR_BOX
            0x0BA2 | 0x0C10 => i(4),
            // MAX_VIEWPORT_DIMS
            0x0D3A => i(2),
            // COLOR_WRITEMASK
            0x0C23 => json!(gl.get_parameter_bool_array::<4>(pname)),
            // COMPRESSED_TEXTURE_FORMATS
            0x86A3 => i(gl.get_parameter_i32(0x86A2).max(0) as usize),
            // LINE_WIDTH, POLYGON_OFFSET_FACTOR/UNITS, SAMPLE_COVERAGE_VALUE, DEPTH_CLEAR_VALUE, MAX_TEXTURE_LOD_BIAS,
            // MAX_TEXTURE_MAX_ANISOTROPY_EXT
            0x0B21 | 0x8038 | 0x2A00 | 0x80AA | 0x0B73 | 0x84FD | 0x84FF => json!(gl.get_parameter_f32(pname)),
            // DEPTH_WRITEMASK, SAMPLE_COVERAGE_INVERT, the enable caps, TRANSFORM_FEEDBACK_ACTIVE/PAUSED
            0x0B72 | 0x80AB | 0x0BE2 | 0x0B44 | 0x0B71 | 0x0BD0 | 0x8037 | 0x809E | 0x80A0 | 0x0C11 | 0x0B90 | 0x8C89 | 0x8E24 | 0x8E23 => {
                json!(gl.get_parameter_bool(pname))
            }
            0x9240 => json!(cx.unpack.flip_y),
            0x9241 => json!(cx.unpack.premultiply),
            0x9243 => json!(cx.unpack.colorspace),
            // MAX_ELEMENT_INDEX, MAX_SERVER_WAIT_TIMEOUT, MAX_UNIFORM_BLOCK_SIZE, MAX_COMBINED_*_UNIFORM_COMPONENTS
            0x8D6B | 0x9111 | 0x8A30 | 0x8A31 | 0x8A33 => json!(gl.get_parameter_i64(pname)),
            // STENCIL_WRITEMASK, STENCIL_BACK_WRITEMASK, STENCIL_VALUE_MASK, STENCIL_BACK_VALUE_MASK
            0x0B98 | 0x8CA5 | 0x0B93 | 0x8CA4 => json!(gl.get_parameter_i32(pname) as u32),
            _ if SINGLE_INTEGERS.contains(&pname) => json!(gl.get_parameter_i32(pname)),
            // anything else may answer more than one value: WebGL's INVALID_ENUM, never a one-value read
            _ => {
                cx.objects.raise(INVALID_ENUM);
                return Value::Null;
            }
        }
    };
    let e = unsafe { cx.gl.get_error() };
    if e != 0 {
        cx.objects.raise(e);
        return Value::Null;
    }
    value
}

/// Runs every command in `bytes` on `cx` (context `id`, current); the last command's answer.
pub fn run(cx: &mut Context, id: u32, bytes: &[u8]) -> Result<Ret, String> {
    let mut r = Reader { bytes, pos: 0 };
    let mut ret = Ret::Undefined;
    rebind(cx);
    while r.pos < bytes.len() {
        let at = r.pos;
        let op = r.u().map_err(|e| format!("WebGL: {e}"))?;
        let name = ops::TABLE.get(op as usize).map(|t| t.0).filter(|n| !n.is_empty()).ok_or_else(|| format!("WebGL: unknown op {op} at byte {at}"))?;
        ret = command(cx, id, op, &mut r).map_err(|e| format!("WebGL {name} (command at byte {at}): {e}"))?;
        if *DEBUG && op != ops::GET_ERROR {
            let e = unsafe { cx.gl.get_error() };
            if e != 0 {
                eprintln!("raea webgl: {name} raised GL error 0x{e:04X}");
                cx.objects.raise(e);
            }
        }
    }
    Ok(ret)
}

/// One command: its operands read from `r` and run.
fn command(cx: &mut Context, id: u32, op: u32, r: &mut Reader) -> Result<Ret, String> {
    macro_rules! get {
        ($kind:ident, $id:expr) => {
            cx.objects.$kind.get(&$id).copied()
        };
    }
    macro_rules! create {
        ($kind:ident, $make:expr) => {{
            let id = r.u()?;
            let v = $make?;
            cx.objects.$kind.insert(id, v);
        }};
    }
    macro_rules! delete {
        ($kind:ident, $delete:ident) => {{
            if let Some(v) = cx.objects.$kind.remove(&r.u()?) {
                cx.gl.$delete(v);
            }
        }};
    }
    let loc = |cx: &Context, id: u32| cx.objects.locations.get(&id).map(|(_, l)| l.clone());
    let num = |n: f64| Ret::Num(n);
    let mut ret = Ret::Undefined;
    unsafe {
        match op {
            ops::ACTIVE_TEXTURE => cx.gl.active_texture(r.u()?),
            ops::ATTACH_SHADER => {
                if let (Some(p), Some((s, _))) = (get!(programs, r.u()?), get!(shaders, r.u()?)) {
                    cx.gl.attach_shader(p, s)
                }
            }
            ops::BIND_ATTRIB_LOCATION => {
                let (p, index, name) = (get!(programs, r.u()?), r.u()?, r.s()?);
                if let Some(p) = p {
                    cx.gl.bind_attrib_location(p, index, name)
                }
            }
            ops::BIND_BUFFER => {
                let (target, b) = (r.u()?, get!(buffers, r.u()?));
                match target {
                    PIXEL_PACK_BUFFER => cx.objects.pack_buffer = b,
                    PIXEL_UNPACK_BUFFER => cx.objects.unpack_buffer = b,
                    _ => {}
                }
                cx.gl.bind_buffer(target, b)
            }
            ops::BIND_BUFFER_BASE => cx.gl.bind_buffer_base(r.u()?, r.u()?, get!(buffers, r.u()?)),
            ops::BIND_BUFFER_RANGE => cx.gl.bind_buffer_range(r.u()?, r.u()?, get!(buffers, r.u()?), r.i()?, r.i()?),
            ops::BIND_FRAMEBUFFER => {
                let (target, fb) = (r.u()?, r.u()?);
                let fb = if cx.objects.framebuffers.contains_key(&fb) { fb } else { 0 };
                match target {
                    FRAMEBUFFER => (cx.objects.read_fb, cx.objects.draw_fb) = (fb, fb),
                    READ_FRAMEBUFFER => cx.objects.read_fb = fb,
                    DRAW_FRAMEBUFFER => cx.objects.draw_fb = fb,
                    // GL raises INVALID_ENUM
                    _ => cx.gl.bind_framebuffer(target, None),
                }
                rebind(cx)
            }
            ops::BIND_RENDERBUFFER => cx.gl.bind_renderbuffer(r.u()?, get!(renderbuffers, r.u()?)),
            ops::BIND_SAMPLER => cx.gl.bind_sampler(r.u()?, get!(samplers, r.u()?)),
            ops::BIND_TEXTURE => cx.gl.bind_texture(r.u()?, get!(textures, r.u()?)),
            ops::BIND_VERTEX_ARRAY => cx.gl.bind_vertex_array(get!(vertex_arrays, r.u()?)),
            ops::BLEND_COLOR => cx.gl.blend_color(r.f()?, r.f()?, r.f()?, r.f()?),
            ops::BLEND_EQUATION => cx.gl.blend_equation(r.u()?),
            ops::BLEND_EQUATION_SEPARATE => cx.gl.blend_equation_separate(r.u()?, r.u()?),
            ops::BLEND_FUNC => cx.gl.blend_func(r.u()?, r.u()?),
            ops::BLEND_FUNC_SEPARATE => cx.gl.blend_func_separate(r.u()?, r.u()?, r.u()?, r.u()?),
            ops::BLIT_FRAMEBUFFER => {
                let v = [r.i()?, r.i()?, r.i()?, r.i()?, r.i()?, r.i()?, r.i()?, r.i()?];
                let (mask, filter) = (r.u()?, r.u()?);
                bind_read_source(cx);
                cx.gl.blit_framebuffer(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], mask, filter);
                rebind(cx)
            }
            ops::BUFFER_DATA_SIZE => cx.gl.buffer_data_size(r.u()?, r.i()?, r.u()?),
            ops::BUFFER_DATA => cx.gl.buffer_data_u8_slice(r.u()?, r.b()?, r.u()?),
            ops::BUFFER_SUB_DATA => cx.gl.buffer_sub_data_u8_slice(r.u()?, r.i()?, r.b()?),
            ops::CLEAR => cx.gl.clear(r.u()?),
            ops::CLEAR_BUFFERFV | ops::CLEAR_BUFFERIV | ops::CLEAR_BUFFERUIV => {
                let (buffer, draw_buffer, blob) = (r.u()?, r.u()?, r.b()?);
                // COLOR takes 4 values, DEPTH and STENCIL 1
                let need = if buffer == 0x1800 { 16 } else { 4 };
                if blob.len() < need {
                    return Err(format!("{} bytes of values, {need} needed", blob.len()));
                }
                match op {
                    ops::CLEAR_BUFFERFV => cx.gl.clear_buffer_f32_slice(buffer, draw_buffer, &floats(blob)?),
                    ops::CLEAR_BUFFERIV => cx.gl.clear_buffer_i32_slice(buffer, draw_buffer, &ints(blob)?),
                    _ => cx.gl.clear_buffer_u32_slice(buffer, draw_buffer, &uints(blob)?),
                }
            }
            ops::CLEAR_BUFFERFI => cx.gl.clear_buffer_depth_stencil(r.u()?, r.u()?, r.f()?, r.i()?),
            ops::CLEAR_COLOR => cx.gl.clear_color(r.f()?, r.f()?, r.f()?, r.f()?),
            ops::CLEAR_DEPTH => cx.gl.clear_depth_f32(r.f()?),
            ops::CLEAR_STENCIL => cx.gl.clear_stencil(r.i()?),
            ops::COLOR_MASK => cx.gl.color_mask(r.bool()?, r.bool()?, r.bool()?, r.bool()?),
            ops::COMPILE_SHADER => {
                if let Some((s, _)) = get!(shaders, r.u()?) {
                    cx.gl.compile_shader(s)
                }
            }
            ops::COMPRESSED_TEX_IMAGE2_D => {
                let v = (r.u()?, r.i()?, r.i()?, r.i()?, r.i()?, r.i()?, r.b()?);
                if cx.objects.unpack_buffer.is_some() {
                    return Err("pixels from an array while a PIXEL_UNPACK_BUFFER is bound".into());
                }
                cx.gl.compressed_tex_image_2d(v.0, v.1, v.2, v.3, v.4, v.5, v.6.len() as i32, v.6)
            }
            ops::COMPRESSED_TEX_SUB_IMAGE2_D => {
                let v = (r.u()?, r.i()?, r.i()?, r.i()?, r.i()?, r.i()?, r.u()?, r.b()?);
                if cx.objects.unpack_buffer.is_some() {
                    return Err("pixels from an array while a PIXEL_UNPACK_BUFFER is bound".into());
                }
                cx.gl.compressed_tex_sub_image_2d(v.0, v.1, v.2, v.3, v.4, v.5, v.6, glow::CompressedPixelUnpackData::Slice(v.7))
            }
            ops::COPY_BUFFER_SUB_DATA => cx.gl.copy_buffer_sub_data(r.u()?, r.u()?, r.i()?, r.i()?, r.i()?),
            ops::COPY_TEX_IMAGE2_D | ops::COPY_TEX_SUB_IMAGE2_D | ops::COPY_TEX_SUB_IMAGE3_D => {
                let n = if op == ops::COPY_TEX_SUB_IMAGE3_D { 9 } else { 8 };
                let mut v = [0i32; 9];
                for x in v.iter_mut().take(n) {
                    *x = r.i()?;
                }
                bind_read_source(cx);
                match op {
                    ops::COPY_TEX_IMAGE2_D => cx.gl.copy_tex_image_2d(v[0] as u32, v[1], v[2] as u32, v[3], v[4], v[5], v[6], v[7]),
                    ops::COPY_TEX_SUB_IMAGE2_D => cx.gl.copy_tex_sub_image_2d(v[0] as u32, v[1], v[2], v[3], v[4], v[5], v[6], v[7]),
                    _ => cx.gl.copy_tex_sub_image_3d(v[0] as u32, v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]),
                }
                rebind(cx)
            }
            ops::CREATE_BUFFER => create!(buffers, cx.gl.create_buffer()),
            ops::CREATE_FRAMEBUFFER => create!(framebuffers, cx.gl.create_framebuffer()),
            ops::CREATE_PROGRAM => create!(programs, cx.gl.create_program()),
            ops::CREATE_QUERY => create!(queries, cx.gl.create_query()),
            ops::CREATE_RENDERBUFFER => create!(renderbuffers, cx.gl.create_renderbuffer()),
            ops::CREATE_SAMPLER => create!(samplers, cx.gl.create_sampler()),
            ops::CREATE_SHADER => {
                let ty = r.u()?;
                create!(shaders, cx.gl.create_shader(ty).map(|s| (s, ty)))
            }
            ops::CREATE_TEXTURE => create!(textures, cx.gl.create_texture()),
            ops::CREATE_VERTEX_ARRAY => create!(vertex_arrays, cx.gl.create_vertex_array()),
            ops::CULL_FACE => cx.gl.cull_face(r.u()?),
            ops::DELETE_BUFFER => {
                if let Some(b) = cx.objects.buffers.remove(&r.u()?) {
                    for slot in [&mut cx.objects.pack_buffer, &mut cx.objects.unpack_buffer] {
                        if *slot == Some(b) {
                            *slot = None;
                        }
                    }
                    cx.gl.delete_buffer(b)
                }
            }
            ops::DELETE_FRAMEBUFFER => {
                let fb = r.u()?;
                if let Some(v) = cx.objects.framebuffers.remove(&fb) {
                    cx.gl.delete_framebuffer(v);
                    for slot in [&mut cx.objects.read_fb, &mut cx.objects.draw_fb] {
                        if *slot == fb {
                            *slot = 0;
                        }
                    }
                    rebind(cx)
                }
            }
            ops::DELETE_PROGRAM => {
                let p = r.u()?;
                if let Some(v) = cx.objects.programs.remove(&p) {
                    cx.gl.delete_program(v);
                    cx.objects.locations.retain(|_, (owner, _)| *owner != p);
                }
            }
            ops::DELETE_QUERY => delete!(queries, delete_query),
            ops::DELETE_RENDERBUFFER => delete!(renderbuffers, delete_renderbuffer),
            ops::DELETE_SAMPLER => delete!(samplers, delete_sampler),
            ops::DELETE_SHADER => {
                if let Some((s, _)) = cx.objects.shaders.remove(&r.u()?) {
                    cx.gl.delete_shader(s)
                }
            }
            ops::DELETE_TEXTURE => delete!(textures, delete_texture),
            ops::DELETE_VERTEX_ARRAY => delete!(vertex_arrays, delete_vertex_array),
            ops::DEPTH_FUNC => cx.gl.depth_func(r.u()?),
            ops::DEPTH_MASK => cx.gl.depth_mask(r.bool()?),
            ops::DEPTH_RANGE => cx.gl.depth_range_f32(r.f()?, r.f()?),
            ops::DETACH_SHADER => {
                if let (Some(p), Some((s, _))) = (get!(programs, r.u()?), get!(shaders, r.u()?)) {
                    cx.gl.detach_shader(p, s)
                }
            }
            ops::DISABLE => cx.gl.disable(r.u()?),
            ops::DISABLE_VERTEX_ATTRIB_ARRAY => cx.gl.disable_vertex_attrib_array(r.u()?),
            ops::DRAW_ARRAYS => cx.gl.draw_arrays(r.u()?, r.i()?, r.i()?),
            ops::DRAW_ARRAYS_INSTANCED => cx.gl.draw_arrays_instanced(r.u()?, r.i()?, r.i()?, r.i()?),
            ops::DRAW_BUFFERS => {
                let mut v = uints(r.b()?)?;
                if target_is_null(cx, DRAW_FRAMEBUFFER) {
                    v.iter_mut().for_each(|b| *b = drawing_buffer_attachment(*b));
                }
                cx.gl.draw_buffers(&v)
            }
            ops::DRAW_ELEMENTS => cx.gl.draw_elements(r.u()?, r.i()?, r.u()?, r.i()?),
            ops::DRAW_ELEMENTS_INSTANCED => cx.gl.draw_elements_instanced(r.u()?, r.i()?, r.u()?, r.i()?, r.i()?),
            ops::DRAW_RANGE_ELEMENTS => {
                // glow has no glDrawRangeElements; start and end are only a hint, so this is drawElements
                let (mode, _start, _end) = (r.u()?, r.u()?, r.u()?);
                cx.gl.draw_elements(mode, r.i()?, r.u()?, r.i()?)
            }
            ops::ENABLE => cx.gl.enable(r.u()?),
            ops::ENABLE_VERTEX_ATTRIB_ARRAY => cx.gl.enable_vertex_attrib_array(r.u()?),
            ops::FINISH => cx.gl.finish(),
            ops::FLUSH => cx.gl.flush(),
            ops::FRAMEBUFFER_RENDERBUFFER => {
                let (target, attachment, rb_target, rb) = (r.u()?, r.u()?, r.u()?, get!(renderbuffers, r.u()?));
                if target_is_null(cx, target) {
                    cx.objects.raise(INVALID_OPERATION)
                } else {
                    cx.gl.framebuffer_renderbuffer(target, attachment, rb_target, rb)
                }
            }
            ops::FRAMEBUFFER_TEXTURE2_D => {
                let (target, attachment, tex_target, tex, level) = (r.u()?, r.u()?, r.u()?, get!(textures, r.u()?), r.i()?);
                if target_is_null(cx, target) {
                    cx.objects.raise(INVALID_OPERATION)
                } else {
                    cx.gl.framebuffer_texture_2d(target, attachment, tex_target, tex, level)
                }
            }
            ops::FRAMEBUFFER_TEXTURE_LAYER => {
                let (target, attachment, tex, level, layer) = (r.u()?, r.u()?, get!(textures, r.u()?), r.i()?, r.i()?);
                if target_is_null(cx, target) {
                    cx.objects.raise(INVALID_OPERATION)
                } else {
                    cx.gl.framebuffer_texture_layer(target, attachment, tex, level, layer)
                }
            }
            ops::FRONT_FACE => cx.gl.front_face(r.u()?),
            ops::GENERATE_MIPMAP => cx.gl.generate_mipmap(r.u()?),
            ops::HINT => cx.gl.hint(r.u()?, r.u()?),
            ops::INVALIDATE_FRAMEBUFFER => {
                let (target, mut v) = (r.u()?, uints(r.b()?)?);
                if target_is_null(cx, target) {
                    v.iter_mut().for_each(|a| *a = drawing_buffer_attachment(*a));
                }
                cx.gl.invalidate_framebuffer(target, &v)
            }
            ops::LINE_WIDTH => cx.gl.line_width(r.f()?),
            ops::LINK_PROGRAM => {
                if let Some(p) = get!(programs, r.u()?) {
                    cx.gl.link_program(p)
                }
            }
            ops::PIXEL_STOREI => {
                let (pname, v) = (r.u()?, r.i()?);
                match pname {
                    0x9240 => cx.unpack.flip_y = v != 0,
                    0x9241 => cx.unpack.premultiply = v != 0,
                    0x9243 => cx.unpack.colorspace = v as u32,
                    _ => {
                        let (unpack, pack) = (&mut cx.objects.unpack, &mut cx.objects.pack);
                        let slot = match pname {
                            0x0CF5 => Some(&mut unpack.alignment),
                            0x0CF2 => Some(&mut unpack.row_length),
                            0x0CF3 => Some(&mut unpack.skip_rows),
                            0x0CF4 => Some(&mut unpack.skip_pixels),
                            0x806E => Some(&mut unpack.image_height),
                            0x806D => Some(&mut unpack.skip_images),
                            0x0D05 => Some(&mut pack.alignment),
                            0x0D02 => Some(&mut pack.row_length),
                            0x0D03 => Some(&mut pack.skip_rows),
                            0x0D04 => Some(&mut pack.skip_pixels),
                            _ => None,
                        };
                        let valid = if matches!(pname, 0x0CF5 | 0x0D05) { matches!(v, 1 | 2 | 4 | 8) } else { v >= 0 };
                        if let Some(slot) = slot
                            && valid
                        {
                            *slot = v;
                        }
                        cx.gl.pixel_store_i32(pname, v)
                    }
                }
            }
            ops::POLYGON_OFFSET => cx.gl.polygon_offset(r.f()?, r.f()?),
            ops::READ_BUFFER => {
                let src = r.u()?;
                cx.gl.read_buffer(if target_is_null(cx, READ_FRAMEBUFFER) { drawing_buffer_attachment(src) } else { src })
            }
            ops::RENDERBUFFER_STORAGE => cx.gl.renderbuffer_storage(r.u()?, r.u()?, r.i()?, r.i()?),
            ops::RENDERBUFFER_STORAGE_MULTISAMPLE => cx.gl.renderbuffer_storage_multisample(r.u()?, r.i()?, r.u()?, r.i()?, r.i()?),
            ops::REQUEST_EXTENSION => cx.request_extension(r.s()?),
            ops::SAMPLE_COVERAGE => cx.gl.sample_coverage(r.f()?, r.bool()?),
            ops::SAMPLER_PARAMETERF => {
                let (s, pname, v) = (get!(samplers, r.u()?), r.u()?, r.f()?);
                if let Some(s) = s {
                    cx.gl.sampler_parameter_f32(s, pname, v)
                }
            }
            ops::SAMPLER_PARAMETERI => {
                let (s, pname, v) = (get!(samplers, r.u()?), r.u()?, r.i()?);
                if let Some(s) = s {
                    cx.gl.sampler_parameter_i32(s, pname, v)
                }
            }
            ops::SCISSOR => cx.gl.scissor(r.i()?, r.i()?, r.i()?, r.i()?),
            ops::SHADER_SOURCE => {
                let (s, src) = (get!(shaders, r.u()?), std::str::from_utf8(r.b()?).map_err(|e| format!("source isn't UTF-8: {e}"))?);
                if let Some((s, _)) = s {
                    cx.gl.shader_source(s, src)
                }
            }
            ops::STENCIL_FUNC => cx.gl.stencil_func(r.u()?, r.i()?, r.u()?),
            ops::STENCIL_FUNC_SEPARATE => cx.gl.stencil_func_separate(r.u()?, r.u()?, r.i()?, r.u()?),
            ops::STENCIL_MASK => cx.gl.stencil_mask(r.u()?),
            ops::STENCIL_MASK_SEPARATE => cx.gl.stencil_mask_separate(r.u()?, r.u()?),
            ops::STENCIL_OP => cx.gl.stencil_op(r.u()?, r.u()?, r.u()?),
            ops::STENCIL_OP_SEPARATE => cx.gl.stencil_op_separate(r.u()?, r.u()?, r.u()?, r.u()?),
            ops::TEX_IMAGE2_D => {
                let (target, level, internal, w, h, border, format, ty, has, blob) = (r.u()?, r.i()?, r.i()?, r.i()?, r.i()?, r.i()?, r.u()?, r.u()?, r.bool()?, r.b()?);
                let data = if has { Some(unpack_bytes(cx, blob, w, h, None, format, ty)?) } else { None };
                upload_2d(cx, data.as_ref(), |gl, d| gl.tex_image_2d(target, level, internal, w, h, border, format, ty, PixelUnpackData::Slice(d)))
            }
            ops::TEX_IMAGE2_DSOURCE => {
                let (target, level, internal, w, h, format, ty, kind, reference) = (r.u()?, r.i()?, r.i()?, r.i()?, r.i()?, r.u()?, r.u()?, r.u()?, r.s()?);
                let (data, w, h) = source_bytes(cx, id, kind, reference, w, h, format, ty)?;
                tight_unpack(cx, true);
                cx.gl.tex_image_2d(target, level, internal, w, h, 0, format, ty, PixelUnpackData::Slice(Some(&data)));
                tight_unpack(cx, false)
            }
            ops::TEX_IMAGE3_D => {
                let (target, level, internal, w, h, d, border, format, ty, has, blob) = (r.u()?, r.i()?, r.i()?, r.i()?, r.i()?, r.i()?, r.i()?, r.u()?, r.u()?, r.bool()?, r.b()?);
                let data = if has { Some(unpack_bytes(cx, blob, w, h, Some(d), format, ty)?) } else { None };
                cx.gl.tex_image_3d(target, level, internal, w, h, d, border, format, ty, PixelUnpackData::Slice(data.as_deref()))
            }
            ops::TEX_PARAMETERF => cx.gl.tex_parameter_f32(r.u()?, r.u()?, r.f()?),
            ops::TEX_PARAMETERI => cx.gl.tex_parameter_i32(r.u()?, r.u()?, r.i()?),
            ops::TEX_STORAGE2_D => cx.gl.tex_storage_2d(r.u()?, r.i()?, r.u()?, r.i()?, r.i()?),
            ops::TEX_STORAGE3_D => cx.gl.tex_storage_3d(r.u()?, r.i()?, r.u()?, r.i()?, r.i()?, r.i()?),
            ops::TEX_SUB_IMAGE2_D => {
                let (target, level, x, y, w, h, format, ty, blob) = (r.u()?, r.i()?, r.i()?, r.i()?, r.i()?, r.i()?, r.u()?, r.u()?, r.b()?);
                let data = unpack_bytes(cx, blob, w, h, None, format, ty)?;
                upload_2d(cx, Some(&data), |gl, d| gl.tex_sub_image_2d(target, level, x, y, w, h, format, ty, PixelUnpackData::Slice(d)))
            }
            ops::TEX_SUB_IMAGE2_DSOURCE => {
                let (target, level, x, y, w, h, format, ty, kind, reference) = (r.u()?, r.i()?, r.i()?, r.i()?, r.i()?, r.i()?, r.u()?, r.u()?, r.u()?, r.s()?);
                let (data, w, h) = source_bytes(cx, id, kind, reference, w, h, format, ty)?;
                tight_unpack(cx, true);
                cx.gl.tex_sub_image_2d(target, level, x, y, w, h, format, ty, PixelUnpackData::Slice(Some(&data)));
                tight_unpack(cx, false)
            }
            ops::TEX_SUB_IMAGE3_D => {
                let (target, level, x, y, z, w, h, d, format, ty, blob) = (r.u()?, r.i()?, r.i()?, r.i()?, r.i()?, r.i()?, r.i()?, r.i()?, r.u()?, r.u()?, r.b()?);
                let data = unpack_bytes(cx, blob, w, h, Some(d), format, ty)?;
                cx.gl.tex_sub_image_3d(target, level, x, y, z, w, h, d, format, ty, PixelUnpackData::Slice(Some(&data)))
            }
            ops::UNIFORM1F => cx.gl.uniform_1_f32(loc(cx, r.u()?).as_ref(), r.f()?),
            ops::UNIFORM2F => cx.gl.uniform_2_f32(loc(cx, r.u()?).as_ref(), r.f()?, r.f()?),
            ops::UNIFORM3F => cx.gl.uniform_3_f32(loc(cx, r.u()?).as_ref(), r.f()?, r.f()?, r.f()?),
            ops::UNIFORM4F => cx.gl.uniform_4_f32(loc(cx, r.u()?).as_ref(), r.f()?, r.f()?, r.f()?, r.f()?),
            ops::UNIFORM1I => cx.gl.uniform_1_i32(loc(cx, r.u()?).as_ref(), r.i()?),
            ops::UNIFORM2I => cx.gl.uniform_2_i32(loc(cx, r.u()?).as_ref(), r.i()?, r.i()?),
            ops::UNIFORM3I => cx.gl.uniform_3_i32(loc(cx, r.u()?).as_ref(), r.i()?, r.i()?, r.i()?),
            ops::UNIFORM4I => cx.gl.uniform_4_i32(loc(cx, r.u()?).as_ref(), r.i()?, r.i()?, r.i()?, r.i()?),
            ops::UNIFORM1UI => cx.gl.uniform_1_u32(loc(cx, r.u()?).as_ref(), r.u()?),
            ops::UNIFORM2UI => cx.gl.uniform_2_u32(loc(cx, r.u()?).as_ref(), r.u()?, r.u()?),
            ops::UNIFORM3UI => cx.gl.uniform_3_u32(loc(cx, r.u()?).as_ref(), r.u()?, r.u()?, r.u()?),
            ops::UNIFORM4UI => cx.gl.uniform_4_u32(loc(cx, r.u()?).as_ref(), r.u()?, r.u()?, r.u()?, r.u()?),
            ops::UNIFORM1FV..=ops::UNIFORM4UIV => {
                let (l, blob) = (loc(cx, r.u()?), r.b()?);
                let l = l.as_ref();
                match op {
                    ops::UNIFORM1FV => cx.gl.uniform_1_f32_slice(l, &floats(blob)?),
                    ops::UNIFORM2FV => cx.gl.uniform_2_f32_slice(l, &floats(blob)?),
                    ops::UNIFORM3FV => cx.gl.uniform_3_f32_slice(l, &floats(blob)?),
                    ops::UNIFORM4FV => cx.gl.uniform_4_f32_slice(l, &floats(blob)?),
                    ops::UNIFORM1IV => cx.gl.uniform_1_i32_slice(l, &ints(blob)?),
                    ops::UNIFORM2IV => cx.gl.uniform_2_i32_slice(l, &ints(blob)?),
                    ops::UNIFORM3IV => cx.gl.uniform_3_i32_slice(l, &ints(blob)?),
                    ops::UNIFORM4IV => cx.gl.uniform_4_i32_slice(l, &ints(blob)?),
                    ops::UNIFORM1UIV => cx.gl.uniform_1_u32_slice(l, &uints(blob)?),
                    ops::UNIFORM2UIV => cx.gl.uniform_2_u32_slice(l, &uints(blob)?),
                    ops::UNIFORM3UIV => cx.gl.uniform_3_u32_slice(l, &uints(blob)?),
                    _ => cx.gl.uniform_4_u32_slice(l, &uints(blob)?),
                }
            }
            ops::UNIFORM_MATRIX2FV..=ops::UNIFORM_MATRIX4X3FV => {
                let (l, transpose, v) = (loc(cx, r.u()?), r.bool()?, floats(r.b()?)?);
                let l = l.as_ref();
                match op {
                    ops::UNIFORM_MATRIX2FV => cx.gl.uniform_matrix_2_f32_slice(l, transpose, &v),
                    ops::UNIFORM_MATRIX3FV => cx.gl.uniform_matrix_3_f32_slice(l, transpose, &v),
                    ops::UNIFORM_MATRIX4FV => cx.gl.uniform_matrix_4_f32_slice(l, transpose, &v),
                    ops::UNIFORM_MATRIX2X3FV => cx.gl.uniform_matrix_2x3_f32_slice(l, transpose, &v),
                    ops::UNIFORM_MATRIX3X2FV => cx.gl.uniform_matrix_3x2_f32_slice(l, transpose, &v),
                    ops::UNIFORM_MATRIX2X4FV => cx.gl.uniform_matrix_2x4_f32_slice(l, transpose, &v),
                    ops::UNIFORM_MATRIX4X2FV => cx.gl.uniform_matrix_4x2_f32_slice(l, transpose, &v),
                    ops::UNIFORM_MATRIX3X4FV => cx.gl.uniform_matrix_3x4_f32_slice(l, transpose, &v),
                    _ => cx.gl.uniform_matrix_4x3_f32_slice(l, transpose, &v),
                }
            }
            ops::UNIFORM_BLOCK_BINDING => {
                let (p, index, binding) = (get!(programs, r.u()?), r.u()?, r.u()?);
                if let Some(p) = p {
                    cx.gl.uniform_block_binding(p, index, binding)
                }
            }
            ops::USE_PROGRAM => cx.gl.use_program(get!(programs, r.u()?)),
            ops::VALIDATE_PROGRAM => {
                if let Some(p) = get!(programs, r.u()?) {
                    cx.gl.validate_program(p)
                }
            }
            ops::VERTEX_ATTRIB1F => cx.gl.vertex_attrib_1_f32(r.u()?, r.f()?),
            ops::VERTEX_ATTRIB2F => cx.gl.vertex_attrib_2_f32(r.u()?, r.f()?, r.f()?),
            ops::VERTEX_ATTRIB3F => cx.gl.vertex_attrib_3_f32(r.u()?, r.f()?, r.f()?, r.f()?),
            ops::VERTEX_ATTRIB4F => cx.gl.vertex_attrib_4_f32(r.u()?, r.f()?, r.f()?, r.f()?, r.f()?),
            ops::VERTEX_ATTRIB_I4I => cx.gl.vertex_attrib_4_i32(r.u()?, r.i()?, r.i()?, r.i()?, r.i()?),
            ops::VERTEX_ATTRIB_I4UI => cx.gl.vertex_attrib_4_u32(r.u()?, r.u()?, r.u()?, r.u()?, r.u()?),
            ops::VERTEX_ATTRIB_DIVISOR => cx.gl.vertex_attrib_divisor(r.u()?, r.u()?),
            ops::VERTEX_ATTRIB_IPOINTER => cx.gl.vertex_attrib_pointer_i32(r.u()?, r.i()?, r.u()?, r.i()?, r.i()?),
            ops::VERTEX_ATTRIB_POINTER => cx.gl.vertex_attrib_pointer_f32(r.u()?, r.i()?, r.u()?, r.bool()?, r.i()?, r.i()?),
            ops::VIEWPORT => cx.gl.viewport(r.i()?, r.i()?, r.i()?, r.i()?),
            ops::BEGIN_QUERY => {
                let (target, q) = (r.u()?, get!(queries, r.u()?));
                if let Some(q) = q {
                    cx.gl.begin_query(target, q)
                }
            }
            ops::END_QUERY => cx.gl.end_query(r.u()?),
            ops::SNAPSHOT => {
                cx.snapshot(id, r.u()? as u64);
                rebind(cx)
            }
            ops::GET_ERROR => {
                let e = std::mem::take(&mut cx.objects.error);
                ret = num(if e != 0 { e } else { cx.gl.get_error() } as f64)
            }
            ops::CHECK_FRAMEBUFFER_STATUS => ret = num(cx.gl.check_framebuffer_status(r.u()?) as f64),
            ops::GET_SHADER_PARAMETER => {
                let (s, pname) = (get!(shaders, r.u()?), r.u()?);
                if let Some((s, ty)) = s {
                    ret = match pname {
                        // SHADER_TYPE, DELETE_STATUS (a deleted shader has no id), COMPILE_STATUS, COMPLETION_STATUS_KHR
                        0x8B4F => num(ty as f64),
                        0x8B80 => num(0.0),
                        0x8B81 => num(cx.gl.get_shader_compile_status(s) as u8 as f64),
                        0x91B1 => num(cx.gl.get_shader_completion_status(s) as u8 as f64),
                        _ => {
                            cx.objects.raise(INVALID_ENUM);
                            Ret::Undefined
                        }
                    }
                }
            }
            ops::GET_PROGRAM_PARAMETER => {
                let (p, pname) = (get!(programs, r.u()?), r.u()?);
                if let Some(p) = p {
                    ret = num(cx.gl.get_program_parameter_i32(p, pname) as f64)
                }
            }
            ops::GET_SHADER_INFO_LOG => ret = Ret::Str(get!(shaders, r.u()?).map(|(s, _)| cx.gl.get_shader_info_log(s)).unwrap_or_default()),
            ops::GET_PROGRAM_INFO_LOG => ret = Ret::Str(get!(programs, r.u()?).map(|p| cx.gl.get_program_info_log(p)).unwrap_or_default()),
            ops::GET_UNIFORM_LOCATION => {
                let (p, l, name) = (r.u()?, r.u()?, r.s()?);
                let found = get!(programs, p).and_then(|program| cx.gl.get_uniform_location(program, name));
                ret = num(found.is_some() as u8 as f64);
                if let Some(found) = found {
                    cx.objects.locations.insert(l, (p, found));
                }
            }
            ops::GET_ATTRIB_LOCATION => {
                let (p, name) = (get!(programs, r.u()?), r.s()?);
                ret = num(p.and_then(|p| cx.gl.get_attrib_location(p, name)).map_or(-1.0, |l| l as f64))
            }
            ops::GET_ACTIVE_UNIFORM | ops::GET_ACTIVE_ATTRIB => {
                let (p, index) = (get!(programs, r.u()?), r.u()?);
                let active = p.and_then(|p| match op {
                    ops::GET_ACTIVE_UNIFORM => (index < cx.gl.get_active_uniforms(p)).then(|| cx.gl.get_active_uniform(p, index)).flatten().map(|u| (u.name, u.size, u.utype)),
                    _ => (index < cx.gl.get_active_attributes(p)).then(|| cx.gl.get_active_attribute(p, index)).flatten().map(|a| (a.name, a.size, a.atype)),
                });
                ret = Ret::Str(active.map_or(Value::Null, |(name, size, ty)| json!({ "name": name, "size": size, "type": ty })).to_string())
            }
            ops::GET_PARAMETER => ret = Ret::Str(parameter(cx, r.u()?).to_string()),
            ops::GET_SHADER_PRECISION_FORMAT => {
                let f = cx.gl.get_shader_precision_format(r.u()?, r.u()?);
                ret = Ret::Str(f.map_or(Value::Null, |f| json!({ "rangeMin": f.range_min, "rangeMax": f.range_max, "precision": f.precision })).to_string())
            }
            ops::GET_TEX_PARAMETER => {
                let (target, pname) = (r.u()?, r.u()?);
                // TEXTURE_MIN_LOD, TEXTURE_MAX_LOD and TEXTURE_MAX_ANISOTROPY_EXT are floats
                ret = num(match pname {
                    0x813A | 0x813B | 0x84FE => cx.gl.get_tex_parameter_f32(target, pname) as f64,
                    _ => cx.gl.get_tex_parameter_i32(target, pname) as f64,
                })
            }
            ops::GET_RENDERBUFFER_PARAMETER => ret = num(cx.gl.get_renderbuffer_parameter_i32(r.u()?, r.u()?) as f64),
            ops::GET_FRAMEBUFFER_ATTACHMENT_PARAMETER => {
                let (target, mut attachment, pname) = (r.u()?, r.u()?, r.u()?);
                let null = target_is_null(cx, target);
                if null {
                    attachment = drawing_buffer_attachment(attachment);
                }
                let v = cx.gl.get_framebuffer_attachment_parameter_i32(target, attachment, pname);
                ret = num(if pname == 0x8CD1 {
                    // FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: the page's id for the GL name (none for the drawing buffer's)
                    let ty = cx.gl.get_framebuffer_attachment_parameter_i32(target, attachment, 0x8CD0) as u32;
                    let name = v as u32;
                    let page = match ty {
                        _ if null => None,
                        0x1702 => cx.objects.textures.iter().find(|(_, t)| t.0.get() == name).map(|(id, _)| *id),
                        0x8D41 => cx.objects.renderbuffers.iter().find(|(_, b)| b.0.get() == name).map(|(id, _)| *id),
                        _ => None,
                    };
                    page.unwrap_or(0) as f64
                } else {
                    v as f64
                })
            }
            ops::GET_INTERNALFORMAT_PARAMETER => {
                let (target, format, pname) = (r.u()?, r.u()?, r.u()?);
                // SAMPLES answers NUM_SAMPLE_COUNTS values
                let n = if pname == 0x80A9 {
                    let mut n = [0];
                    cx.gl.get_internal_format_i32_slice(target, format, 0x9380, &mut n);
                    n[0].max(0) as usize
                } else {
                    1
                };
                let mut v = vec![0i32; n];
                if n > 0 {
                    cx.gl.get_internal_format_i32_slice(target, format, pname, &mut v);
                }
                ret = Ret::Str(json!(v).to_string())
            }
            ops::GET_UNIFORM_BLOCK_INDEX => {
                let (p, name) = (get!(programs, r.u()?), r.s()?);
                ret = num(p.and_then(|p| cx.gl.get_uniform_block_index(p, name)).unwrap_or(u32::MAX) as f64)
            }
            ops::GET_QUERY_PARAMETER => {
                let (q, pname) = (get!(queries, r.u()?), r.u()?);
                if let Some(q) = q {
                    ret = num(cx.gl.get_query_parameter_u32(q, pname) as f64)
                }
            }
            ops::GET_BUFFER_SUB_DATA => {
                // GL ES has no glGetBufferSubData: the range is mapped for reading (MAP_READ_BIT)
                let (target, offset, len) = (r.u()?, r.i()?, r.i()?);
                let mut out = vec![0u8; usize::try_from(len).map_err(|_| format!("length {len}"))?];
                if len > 0 {
                    let p = cx.gl.map_buffer_range(target, offset, len, 0x0001);
                    if p.is_null() {
                        return Err(format!("the buffer range {offset}+{len} couldn't be read (GL error 0x{:04X})", cx.gl.get_error()));
                    }
                    std::ptr::copy_nonoverlapping(p, out.as_mut_ptr(), out.len());
                    cx.gl.unmap_buffer(target);
                }
                ret = Ret::Bytes(out)
            }
            ops::IS_ENABLED => ret = num(cx.gl.is_enabled(r.u()?) as u8 as f64),
            ops::READ_PIXELS => {
                let (x, y, w, h, format, ty) = (r.i()?, r.i()?, r.i()?, r.i()?, r.u()?, r.u()?);
                if cx.objects.pack_buffer.is_some() {
                    return Err("reading into a PIXEL_PACK_BUFFER isn't in raea yet (the op carries no offset)".into());
                }
                let bpp = pixel_size(format, ty).ok_or_else(|| format!("format 0x{format:04X} type 0x{ty:04X} isn't a readable pair"))?;
                let mut out = vec![0u8; cx.objects.pack.flat().size(w, h, 1, bpp).ok_or("an image over 2 GiB")?];
                bind_read_source(cx);
                cx.gl.read_pixels(x, y, w, h, format, ty, PixelPackData::Slice(Some(&mut out)));
                rebind(cx);
                ret = Ret::Bytes(out)
            }
            ops::READ_CANVAS => {
                ret = Ret::Bytes(cx.read_canvas(true));
                rebind(cx)
            }
            _ => return Err(format!("op {op} has no handler")),
        }
    }
    if matches!(
        op,
        ops::CLEAR
            | ops::CLEAR_BUFFERFV
            | ops::CLEAR_BUFFERIV
            | ops::CLEAR_BUFFERUIV
            | ops::CLEAR_BUFFERFI
            | ops::DRAW_ARRAYS
            | ops::DRAW_ARRAYS_INSTANCED
            | ops::DRAW_ELEMENTS
            | ops::DRAW_ELEMENTS_INSTANCED
            | ops::DRAW_RANGE_ELEMENTS
            | ops::BLIT_FRAMEBUFFER
    ) && target_is_null(cx, DRAW_FRAMEBUFFER)
    {
        cx.mark_drawn();
    }
    Ok(ret)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Attrs, angle};

    const TEXTURE_2D: u32 = 0x0DE1;
    const ARRAY_BUFFER: u32 = 0x8892;
    const STATIC_DRAW: u32 = 0x88E4;
    const RGBA: u32 = 0x1908;
    const RGBA8: u32 = 0x8058;
    const UNSIGNED_BYTE: u32 = 0x1401;
    const FLOAT: u32 = 0x1406;
    const COLOR_BUFFER_BIT: u32 = 0x4000;
    const RENDERBUFFER: u32 = 0x8D41;
    const COMPLETE: f64 = 0x8CD5 as f64;
    const TRIANGLES: u32 = 4;

    /// Command bytes built op by op, as the page's side writes them.
    #[derive(Default)]
    struct Cmds(Vec<u8>);

    impl Cmds {
        fn op(&mut self, op: u32) -> &mut Self {
            self.u(op)
        }
        fn u(&mut self, v: u32) -> &mut Self {
            self.0.extend(v.to_le_bytes());
            self
        }
        fn i(&mut self, v: i32) -> &mut Self {
            self.0.extend(v.to_le_bytes());
            self
        }
        fn f(&mut self, v: f32) -> &mut Self {
            self.0.extend(v.to_le_bytes());
            self
        }
        fn b(&mut self, b: &[u8]) -> &mut Self {
            self.u(b.len() as u32);
            self.0.extend(b);
            self.0.resize(self.0.len().next_multiple_of(4), 0);
            self
        }
        fn s(&mut self, s: &str) -> &mut Self {
            self.b(s.as_bytes())
        }
        fn fs(&mut self, v: &[f32]) -> &mut Self {
            self.b(&v.iter().flat_map(|f| f.to_le_bytes()).collect::<Vec<_>>())
        }
        fn run(&mut self, cx: &mut Context) -> Ret {
            let bytes = std::mem::take(&mut self.0);
            run(cx, 4242, &bytes).unwrap()
        }
    }

    fn context(antialias: bool) -> Context {
        let attrs = Attrs { alpha: true, depth: true, stencil: false, antialias, premultiplied_alpha: true, preserve_drawing_buffer: false };
        let cx = angle::create(64, 64, attrs).unwrap();
        cx.make_current().unwrap();
        cx
    }

    fn num(r: Ret) -> f64 {
        match r {
            Ret::Num(n) => n,
            _ => panic!("not a number"),
        }
    }
    fn text(r: Ret) -> String {
        match r {
            Ret::Str(s) => s,
            _ => panic!("not a string"),
        }
    }
    fn bytes(r: Ret) -> Vec<u8> {
        match r {
            Ret::Bytes(b) => b,
            _ => panic!("not bytes"),
        }
    }

    /// RGBA8 of pixel (x, y) in a readPixels answer `w` wide.
    fn pixel(data: &[u8], w: usize, x: usize, y: usize) -> [u8; 4] {
        data[(y * w + x) * 4..][..4].try_into().unwrap()
    }

    /// Program 1 from shaders 1 and 2, `attribs` bound to locations 0.., linked and used.
    fn program(cx: &mut Context, vs: &str, fs: &str, attribs: &[&str]) {
        let mut c = Cmds::default();
        c.op(ops::CREATE_SHADER).u(0x8B31).u(1).op(ops::SHADER_SOURCE).u(1).s(vs).op(ops::COMPILE_SHADER).u(1);
        c.op(ops::CREATE_SHADER).u(0x8B30).u(2).op(ops::SHADER_SOURCE).u(2).s(fs).op(ops::COMPILE_SHADER).u(2);
        c.op(ops::CREATE_PROGRAM).u(1).op(ops::ATTACH_SHADER).u(1).u(1).op(ops::ATTACH_SHADER).u(1).u(2);
        for (i, a) in attribs.iter().enumerate() {
            c.op(ops::BIND_ATTRIB_LOCATION).u(1).u(i as u32).s(a);
        }
        c.op(ops::LINK_PROGRAM).u(1).op(ops::GET_PROGRAM_PARAMETER).u(1).u(0x8B82);
        if num(c.run(cx)) != 1.0 {
            let logs = [c.op(ops::GET_SHADER_INFO_LOG).u(1).run(cx), c.op(ops::GET_SHADER_INFO_LOG).u(2).run(cx), c.op(ops::GET_PROGRAM_INFO_LOG).u(1).run(cx)];
            panic!("link failed: {:?}", logs.map(text));
        }
        c.op(ops::USE_PROGRAM).u(1).run(cx);
    }

    fn buffer(c: &mut Cmds, id: u32, data: &[f32]) {
        c.op(ops::CREATE_BUFFER).u(id).op(ops::BIND_BUFFER).u(ARRAY_BUFFER).u(id).op(ops::BUFFER_DATA).u(ARRAY_BUFFER).fs(data).u(STATIC_DRAW);
    }

    #[test]
    fn exec_program_uniforms_draw_read_pixels() {
        let mut cx = context(true);
        let vs = "#version 300 es\nin vec2 pos; uniform mat4 m; void main() { gl_Position = m * vec4(pos, 0.0, 1.0); }";
        let fs = "#version 300 es\nprecision highp float; uniform vec4 color; uniform float scale; out vec4 o; void main() { o = color * scale; }";
        program(&mut cx, vs, fs, &["pos"]);
        let mut c = Cmds::default();
        assert_eq!(num(c.op(ops::GET_UNIFORM_LOCATION).u(1).u(1).s("color").run(&mut cx)), 1.0);
        assert_eq!(num(c.op(ops::GET_UNIFORM_LOCATION).u(1).u(2).s("scale").run(&mut cx)), 1.0);
        assert_eq!(num(c.op(ops::GET_UNIFORM_LOCATION).u(1).u(3).s("m").run(&mut cx)), 1.0);
        assert_eq!(num(c.op(ops::GET_UNIFORM_LOCATION).u(1).u(4).s("nope").run(&mut cx)), 0.0);
        assert_eq!(num(c.op(ops::GET_ATTRIB_LOCATION).u(1).s("pos").run(&mut cx)), 0.0);
        let identity = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];
        buffer(&mut c, 1, &[-1., -1., 1., -1., -1., 1.]);
        c.op(ops::ENABLE_VERTEX_ATTRIB_ARRAY).u(0).op(ops::VERTEX_ATTRIB_POINTER).u(0).i(2).u(FLOAT).u(0).i(0).i(0);
        c.op(ops::UNIFORM4FV).u(1).fs(&[0., 0.5, 0., 0.5]).op(ops::UNIFORM1F).u(2).f(2.0).op(ops::UNIFORM_MATRIX4FV).u(3).u(0).fs(&identity);
        c.op(ops::VIEWPORT).i(0).i(0).i(64).i(64).op(ops::CLEAR_COLOR).f(0.).f(0.).f(1.).f(1.).op(ops::CLEAR).u(COLOR_BUFFER_BIT);
        c.op(ops::DRAW_ARRAYS).u(TRIANGLES).i(0).i(3);
        c.op(ops::READ_PIXELS).i(0).i(0).i(64).i(64).u(RGBA).u(UNSIGNED_BYTE);
        let px = bytes(c.run(&mut cx));
        assert_eq!(px.len(), 64 * 64 * 4);
        assert_eq!(pixel(&px, 64, 4, 4), [0, 255, 0, 255]);
        assert_eq!(pixel(&px, 64, 60, 60), [0, 0, 255, 255]);
        assert_eq!(num(c.op(ops::GET_ERROR).run(&mut cx)), 0.0);

        let u: Value = serde_json::from_str(&text(c.op(ops::GET_ACTIVE_ATTRIB).u(1).u(0).run(&mut cx))).unwrap();
        assert_eq!(u, json!({ "name": "pos", "size": 1, "type": 0x8B50 }));
        assert_eq!(text(c.op(ops::GET_ACTIVE_UNIFORM).u(1).u(99).run(&mut cx)), "null");
        assert_eq!(text(c.op(ops::GET_PARAMETER).u(0x0BA2).run(&mut cx)), "[0,0,64,64]");
        assert_eq!(text(c.op(ops::GET_PARAMETER).u(0x0C22).run(&mut cx)), "[0.0,0.0,1.0,1.0]");
        assert_eq!(text(c.op(ops::GET_PARAMETER).u(0x0C23).run(&mut cx)), "[true,true,true,true]");
        assert!(text(c.op(ops::GET_PARAMETER).u(0x1F02).run(&mut cx)).starts_with("\"WebGL 2.0 (OpenGL ES 3.0"));
        let p: Value = serde_json::from_str(&text(c.op(ops::GET_SHADER_PRECISION_FORMAT).u(0x8B30).u(0x8DF2).run(&mut cx))).unwrap();
        assert_eq!(p["precision"], 23);
        assert_eq!(bytes(c.op(ops::GET_BUFFER_SUB_DATA).u(ARRAY_BUFFER).i(8).i(8).run(&mut cx)), [1f32, -1.].iter().flat_map(|f| f.to_le_bytes()).collect::<Vec<_>>());

        // the drawing buffer as the page reads it, and as a frame
        let canvas = bytes(c.op(ops::READ_CANVAS).run(&mut cx));
        assert_eq!((canvas.len(), pixel(&canvas, 64, 4, 63 - 4)), (64 * 64 * 4, [0, 255, 0, 255]));
        c.op(ops::SNAPSHOT).u(7).run(&mut cx);
        let frame = raea_sys_canvas::frames::take(4242, 7).unwrap();
        assert_eq!((frame.width, frame.height, pixel(&frame.data, 64, 60, 3)), (64, 64, [0, 0, 255, 255]));
        // not preserveDrawingBuffer: cleared after the snapshot
        assert_eq!(pixel(&bytes(c.op(ops::READ_PIXELS).i(0).i(0).i(1).i(1).u(RGBA).u(UNSIGNED_BYTE).run(&mut cx)), 1, 0, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn exec_texture_upload_flip_y_and_pack_state() {
        let mut cx = context(false);
        let rows = [255, 0, 0, 255, 0, 255, 0, 255];
        let mut c = Cmds::default();
        c.op(ops::CREATE_FRAMEBUFFER).u(1).op(ops::BIND_FRAMEBUFFER).u(FRAMEBUFFER).u(1);
        let first_pixel = |cx: &mut Context, c: &mut Cmds, tex: u32, flip: bool| {
            c.op(ops::PIXEL_STOREI).u(0x9240).i(flip as i32).op(ops::CREATE_TEXTURE).u(tex).op(ops::BIND_TEXTURE).u(TEXTURE_2D).u(tex);
            c.op(ops::TEX_IMAGE2_D).u(TEXTURE_2D).i(0).i(RGBA8 as i32).i(1).i(2).i(0).u(RGBA).u(UNSIGNED_BYTE).u(1).b(&rows);
            c.op(ops::FRAMEBUFFER_TEXTURE2_D).u(FRAMEBUFFER).u(COLOR_ATTACHMENT0).u(TEXTURE_2D).u(tex).i(0);
            assert_eq!(num(c.op(ops::CHECK_FRAMEBUFFER_STATUS).u(FRAMEBUFFER).run(cx)), COMPLETE);
            pixel(&bytes(c.op(ops::READ_PIXELS).i(0).i(0).i(1).i(2).u(RGBA).u(UNSIGNED_BYTE).run(cx)), 1, 0, 0)
        };
        // GL's row 0 is the bottom: unflipped it is the array's first row, flipped its last
        assert_eq!(first_pixel(&mut cx, &mut c, 1, false), [255, 0, 0, 255]);
        assert_eq!(first_pixel(&mut cx, &mut c, 2, true), [0, 255, 0, 255]);
        assert_eq!(text(c.op(ops::GET_PARAMETER).u(0x9240).run(&mut cx)), "true");
        assert_eq!(num(c.op(ops::GET_FRAMEBUFFER_ATTACHMENT_PARAMETER).u(FRAMEBUFFER).u(COLOR_ATTACHMENT0).u(0x8CD1).run(&mut cx)), 2.0);

        // too few bytes for the image is refused before GL reads past them
        let e = run(&mut cx, 1, c.op(ops::TEX_IMAGE2_D).u(TEXTURE_2D).i(0).i(RGBA8 as i32).i(2).i(2).i(0).u(RGBA).u(UNSIGNED_BYTE).u(1).b(&rows).0.as_slice()).err().unwrap();
        assert!(e.contains("texImage2D") && e.contains("8 bytes given, 16 needed"), "{e}");
        c.0.clear();

        // PACK_ALIGNMENT 8 pads each 1-pixel RGBA row (4 bytes) to 8: 8 + 4 bytes for 2 rows
        c.op(ops::PIXEL_STOREI).u(0x0D05).i(8).op(ops::READ_PIXELS).i(0).i(0).i(1).i(2).u(RGBA).u(UNSIGNED_BYTE);
        let px = bytes(c.run(&mut cx));
        assert_eq!((px.len(), &px[8..12]), (12, &[255u8, 0, 0, 255][..]));
    }

    #[test]
    fn exec_flip_y_with_skips_uploads_the_rectangle() {
        let mut cx = context(false);
        // a 3x3 RGBA array, pixel (x, y) = [100x, 100y, 0, 255], top row first
        let mut img = Vec::new();
        for y in 0..3u8 {
            for x in 0..3u8 {
                img.extend([x * 100, y * 100, 0, 255]);
            }
        }
        let mut c = Cmds::default();
        // ROW_LENGTH 3, SKIP_PIXELS 1, SKIP_ROWS 1, FLIP_Y: the 2x2 from (1, 1), its bottom row first
        c.op(ops::PIXEL_STOREI).u(0x0CF2).i(3).op(ops::PIXEL_STOREI).u(0x0CF4).i(1).op(ops::PIXEL_STOREI).u(0x0CF3).i(1).op(ops::PIXEL_STOREI).u(0x9240).i(1);
        c.op(ops::CREATE_TEXTURE).u(1).op(ops::BIND_TEXTURE).u(TEXTURE_2D).u(1);
        c.op(ops::TEX_IMAGE2_D).u(TEXTURE_2D).i(0).i(RGBA8 as i32).i(2).i(2).i(0).u(RGBA).u(UNSIGNED_BYTE).u(1).b(&img);
        c.op(ops::CREATE_FRAMEBUFFER).u(1).op(ops::BIND_FRAMEBUFFER).u(FRAMEBUFFER).u(1).op(ops::FRAMEBUFFER_TEXTURE2_D).u(FRAMEBUFFER).u(COLOR_ATTACHMENT0).u(TEXTURE_2D).u(1).i(0);
        c.op(ops::READ_PIXELS).i(0).i(0).i(2).i(2).u(RGBA).u(UNSIGNED_BYTE);
        let px = bytes(c.run(&mut cx));
        assert_eq!(px, [100, 200, 0, 255, 200, 200, 0, 255, 100, 100, 0, 255, 200, 100, 0, 255]);
        // texSubImage2D the same way: the 1x1 at SKIP_PIXELS 0, SKIP_ROWS 2 into (1, 1)
        c.op(ops::PIXEL_STOREI).u(0x0CF4).i(0).op(ops::PIXEL_STOREI).u(0x0CF3).i(2);
        c.op(ops::TEX_SUB_IMAGE2_D).u(TEXTURE_2D).i(0).i(1).i(1).i(1).i(1).u(RGBA).u(UNSIGNED_BYTE).b(&img);
        c.op(ops::READ_PIXELS).i(1).i(1).i(1).i(1).u(RGBA).u(UNSIGNED_BYTE);
        assert_eq!(bytes(c.run(&mut cx)), [0, 200, 0, 255]);
        // the page's UNPACK state is back
        unsafe {
            assert_eq!((cx.gl.get_parameter_i32(0x0CF2), cx.gl.get_parameter_i32(0x0CF3), cx.gl.get_parameter_i32(0x0CF5)), (3, 2, 4));
        }
        assert_eq!(num(c.op(ops::GET_ERROR).run(&mut cx)), 0.0);
    }

    #[test]
    fn exec_msaa_renderbuffer_blit_and_drawing_buffer() {
        let mut cx = context(false);
        let mut c = Cmds::default();
        c.op(ops::CREATE_RENDERBUFFER).u(1).op(ops::BIND_RENDERBUFFER).u(RENDERBUFFER).u(1);
        c.op(ops::RENDERBUFFER_STORAGE_MULTISAMPLE).u(RENDERBUFFER).i(4).u(RGBA8).i(64).i(64);
        c.op(ops::CREATE_FRAMEBUFFER).u(1).op(ops::BIND_FRAMEBUFFER).u(FRAMEBUFFER).u(1);
        c.op(ops::FRAMEBUFFER_RENDERBUFFER).u(FRAMEBUFFER).u(COLOR_ATTACHMENT0).u(RENDERBUFFER).u(1);
        assert_eq!(num(c.op(ops::CHECK_FRAMEBUFFER_STATUS).u(FRAMEBUFFER).run(&mut cx)), COMPLETE);
        assert_eq!(num(c.op(ops::GET_RENDERBUFFER_PARAMETER).u(RENDERBUFFER).u(0x8CAB).run(&mut cx)), 4.0);
        c.op(ops::CLEAR_COLOR).f(1.).f(0.).f(0.).f(1.).op(ops::CLEAR).u(COLOR_BUFFER_BIT);
        // resolve into the drawing buffer (DRAW null, READ still the MSAA framebuffer)
        c.op(ops::BIND_FRAMEBUFFER).u(DRAW_FRAMEBUFFER).u(0);
        c.op(ops::BLIT_FRAMEBUFFER).i(0).i(0).i(64).i(64).i(0).i(0).i(64).i(64).u(COLOR_BUFFER_BIT).u(0x2600);
        c.op(ops::BIND_FRAMEBUFFER).u(FRAMEBUFFER).u(0).op(ops::READ_PIXELS).i(10).i(10).i(1).i(1).u(RGBA).u(UNSIGNED_BYTE);
        assert_eq!(bytes(c.run(&mut cx)), [255, 0, 0, 255]);
        // the drawing buffer copied into a texture, read back through a framebuffer
        c.op(ops::CREATE_TEXTURE).u(1).op(ops::BIND_TEXTURE).u(TEXTURE_2D).u(1).op(ops::COPY_TEX_IMAGE2_D).u(TEXTURE_2D).i(0).u(RGBA8).i(0).i(0).i(8).i(8).i(0);
        c.op(ops::CREATE_FRAMEBUFFER).u(2).op(ops::BIND_FRAMEBUFFER).u(FRAMEBUFFER).u(2).op(ops::FRAMEBUFFER_TEXTURE2_D).u(FRAMEBUFFER).u(COLOR_ATTACHMENT0).u(TEXTURE_2D).u(1).i(0);
        c.op(ops::READ_PIXELS).i(7).i(7).i(1).i(1).u(RGBA).u(UNSIGNED_BYTE);
        assert_eq!(bytes(c.run(&mut cx)), [255, 0, 0, 255]);
        // deleting the bound framebuffer leaves the drawing buffer bound
        c.op(ops::DELETE_FRAMEBUFFER).u(2).op(ops::READ_PIXELS).i(30).i(30).i(1).i(1).u(RGBA).u(UNSIGNED_BYTE);
        assert_eq!(bytes(c.run(&mut cx)), [255, 0, 0, 255]);
    }

    #[test]
    fn exec_antialiased_drawing_buffer_reads_resolved() {
        let mut cx = context(true);
        let mut c = Cmds::default();
        c.op(ops::CLEAR_COLOR).f(0.).f(1.).f(0.).f(1.).op(ops::CLEAR).u(COLOR_BUFFER_BIT).op(ops::READ_PIXELS).i(1).i(1).i(1).i(1).u(RGBA).u(UNSIGNED_BYTE);
        assert_eq!(bytes(c.run(&mut cx)), [0, 255, 0, 255]);
        // a second clear makes the resolve stale: the next read sees it
        c.op(ops::CLEAR_COLOR).f(1.).f(1.).f(0.).f(1.).op(ops::CLEAR).u(COLOR_BUFFER_BIT).op(ops::READ_PIXELS).i(1).i(1).i(1).i(1).u(RGBA).u(UNSIGNED_BYTE);
        assert_eq!(bytes(c.run(&mut cx)), [255, 255, 0, 255]);
        assert_eq!(text(c.op(ops::GET_PARAMETER).u(0x80A9).run(&mut cx)), "4");
    }

    #[test]
    fn exec_instanced_draw() {
        let mut cx = context(false);
        let vs = "#version 300 es\nin vec2 pos; in float off; in vec4 color; out vec4 v; void main() { gl_Position = vec4(pos.x + off, pos.y, 0.0, 1.0); v = color; }";
        let fs = "#version 300 es\nprecision mediump float; in vec4 v; out vec4 o; void main() { o = v; }";
        program(&mut cx, vs, fs, &["pos", "off", "color"]);
        let mut c = Cmds::default();
        c.op(ops::CREATE_VERTEX_ARRAY).u(1).op(ops::BIND_VERTEX_ARRAY).u(1);
        buffer(&mut c, 1, &[-1., -1., 0., -1., 0., 1., -1., -1., 0., 1., -1., 1.]);
        c.op(ops::ENABLE_VERTEX_ATTRIB_ARRAY).u(0).op(ops::VERTEX_ATTRIB_POINTER).u(0).i(2).u(FLOAT).u(0).i(0).i(0);
        buffer(&mut c, 2, &[0., 1.]);
        c.op(ops::ENABLE_VERTEX_ATTRIB_ARRAY).u(1).op(ops::VERTEX_ATTRIB_POINTER).u(1).i(1).u(FLOAT).u(0).i(0).i(0).op(ops::VERTEX_ATTRIB_DIVISOR).u(1).u(1);
        buffer(&mut c, 3, &[1., 0., 0., 1., 0., 0., 1., 1.]);
        c.op(ops::ENABLE_VERTEX_ATTRIB_ARRAY).u(2).op(ops::VERTEX_ATTRIB_POINTER).u(2).i(4).u(FLOAT).u(0).i(0).i(0).op(ops::VERTEX_ATTRIB_DIVISOR).u(2).u(1);
        c.op(ops::VIEWPORT).i(0).i(0).i(64).i(64).op(ops::DRAW_ARRAYS_INSTANCED).u(TRIANGLES).i(0).i(6).i(2);
        c.op(ops::READ_PIXELS).i(0).i(0).i(64).i(64).u(RGBA).u(UNSIGNED_BYTE);
        let px = bytes(c.run(&mut cx));
        assert_eq!((pixel(&px, 64, 16, 32), pixel(&px, 64, 48, 32)), ([255, 0, 0, 255], [0, 0, 255, 255]));
        assert_eq!(num(c.op(ops::GET_ERROR).run(&mut cx)), 0.0);
    }

    #[test]
    fn exec_float_render_target() {
        let target = |cx: &mut Context, extension: bool| {
            let mut c = Cmds::default();
            if extension {
                c.op(ops::REQUEST_EXTENSION).s("EXT_color_buffer_float");
            }
            c.op(ops::CREATE_TEXTURE).u(1).op(ops::BIND_TEXTURE).u(TEXTURE_2D).u(1).op(ops::TEX_STORAGE2_D).u(TEXTURE_2D).i(1).u(0x8814).i(4).i(4);
            c.op(ops::CREATE_FRAMEBUFFER).u(1).op(ops::BIND_FRAMEBUFFER).u(FRAMEBUFFER).u(1).op(ops::FRAMEBUFFER_TEXTURE2_D).u(FRAMEBUFFER).u(COLOR_ATTACHMENT0).u(TEXTURE_2D).u(1).i(0);
            num(c.op(ops::CHECK_FRAMEBUFFER_STATUS).u(FRAMEBUFFER).run(cx))
        };
        assert_ne!(target(&mut context(false), false), COMPLETE);
        let mut cx = context(false);
        assert_eq!(target(&mut cx, true), COMPLETE);
        let mut c = Cmds::default();
        c.op(ops::CLEAR_BUFFERFV).u(0x1800).u(0).fs(&[2.5, -1.0, 0.25, 1.0]).op(ops::READ_PIXELS).i(0).i(0).i(1).i(1).u(RGBA).u(FLOAT);
        assert_eq!(floats(&bytes(c.run(&mut cx))).unwrap(), [2.5, -1.0, 0.25, 1.0]);
    }

    #[test]
    fn exec_canvas_source_upload() {
        let mut a = context(false);
        let mut c = Cmds::default();
        c.op(ops::CLEAR_COLOR).f(0.).f(0.).f(1.).f(1.).op(ops::CLEAR).u(COLOR_BUFFER_BIT).run(&mut a);
        crate::CONTEXTS.with(|m| m.borrow_mut().insert(990_001, std::rc::Rc::new(std::cell::RefCell::new(a))));
        let mut b = context(false);
        c.op(ops::CREATE_TEXTURE).u(1).op(ops::BIND_TEXTURE).u(TEXTURE_2D).u(1);
        c.op(ops::TEX_IMAGE2_DSOURCE).u(TEXTURE_2D).i(0).i(RGBA8 as i32).i(4).i(2).u(RGBA).u(UNSIGNED_BYTE).u(3).s("990001");
        c.op(ops::CREATE_FRAMEBUFFER).u(1).op(ops::BIND_FRAMEBUFFER).u(FRAMEBUFFER).u(1).op(ops::FRAMEBUFFER_TEXTURE2_D).u(FRAMEBUFFER).u(COLOR_ATTACHMENT0).u(TEXTURE_2D).u(1).i(0);
        c.op(ops::READ_PIXELS).i(3).i(1).i(1).i(1).u(RGBA).u(UNSIGNED_BYTE);
        assert_eq!(bytes(c.run(&mut b)), [0, 0, 255, 255]);
        crate::CONTEXTS.with(|m| m.borrow_mut().remove(&990_001));
    }

    #[test]
    fn exec_fresh_context_has_no_error() {
        let mut cx = context(true);
        assert_eq!(unsafe { cx.gl.get_error() }, 0, "angle::create left a GL error");
        run(&mut cx, 1, &[]).unwrap();
        assert_eq!(unsafe { cx.gl.get_error() }, 0, "the start of a call left a GL error");
    }

    #[test]
    fn exec_errors_and_bad_bytes() {
        let mut cx = context(false);
        let e = run(&mut cx, 1, &999u32.to_le_bytes()).err().unwrap();
        assert!(e.contains("unknown op 999 at byte 0"), "{e}");
        let e = run(&mut cx, 1, &ops::CLEAR.to_le_bytes()).err().unwrap();
        assert!(e.contains("clear") && e.contains("byte 0"), "{e}");
        let mut c = Cmds::default();
        c.op(ops::BUFFER_DATA).u(ARRAY_BUFFER).u(1000).u(0);
        assert!(run(&mut cx, 1, &c.0).err().unwrap().contains("runs past the end"));
        c.0.clear();

        c.op(ops::BIND_TEXTURE).u(0x1234).u(0).op(ops::GET_ERROR);
        assert_eq!(num(c.run(&mut cx)), INVALID_ENUM as f64);
        assert_eq!(num(c.op(ops::GET_ERROR).run(&mut cx)), 0.0);
        // a framebuffer attachment while the drawing buffer is bound is WebGL's INVALID_OPERATION, not GL's business
        c.op(ops::CREATE_TEXTURE).u(1).op(ops::FRAMEBUFFER_TEXTURE2_D).u(FRAMEBUFFER).u(COLOR_ATTACHMENT0).u(TEXTURE_2D).u(1).i(0).op(ops::GET_ERROR);
        assert_eq!(num(c.run(&mut cx)), INVALID_OPERATION as f64);
        assert_eq!(text(c.op(ops::GET_PARAMETER).u(0x1234).run(&mut cx)), "null");
        assert_eq!(num(c.op(ops::GET_ERROR).run(&mut cx)), INVALID_ENUM as f64);

        c.op(ops::CREATE_SHADER).u(0x8B30).u(1).op(ops::SHADER_SOURCE).u(1).s("#version 300 es\nvoid main() { nope; }").op(ops::COMPILE_SHADER).u(1);
        assert_eq!(num(c.op(ops::GET_SHADER_PARAMETER).u(1).u(0x8B81).run(&mut cx)), 0.0);
        assert_eq!(num(c.op(ops::GET_SHADER_PARAMETER).u(1).u(0x8B4F).run(&mut cx)), 0x8B30 as f64);
        assert!(!text(c.op(ops::GET_SHADER_INFO_LOG).u(1).run(&mut cx)).is_empty());
        // unknown and deleted ids are no-ops
        c.op(ops::DELETE_SHADER).u(1).op(ops::DELETE_SHADER).u(1).op(ops::DELETE_TEXTURE).u(77).op(ops::BIND_BUFFER).u(ARRAY_BUFFER).u(55).op(ops::USE_PROGRAM).u(9);
        c.op(ops::UNIFORM1F).u(12).f(1.0).op(ops::GET_ERROR);
        assert_eq!(num(c.run(&mut cx)), 0.0);
        assert!(matches!(c.op(ops::GET_SHADER_PARAMETER).u(1).u(0x8B81).run(&mut cx), Ret::Undefined));
        assert!(run(&mut cx, 1, c.op(ops::GET_ATTRIB_LOCATION).u(1).s("a\0b").0.as_slice()).err().unwrap().contains("NUL"));
    }
}
