//! ANGLE loaded and a context on it (PROTOCOL.md "ANGLE"): the EGL display, a context and its drawing buffer.
//!
//! ANGLE's libGLESv2 and libEGL are loaded once a process from `RAEA_ANGLE_DIR` or `vendor/angle/<platform>`
//! (scripts/fetch-angle.sh), with one EGL display: SwiftShader's Vulkan on Linux, Metal on macOS. Each WebGL context
//! is its own ES 3.0 EGL context in WebGL-compatibility mode, current on the thread that made it, drawing into our own
//! framebuffer (the drawing buffer), not its 1x1 pbuffer. The helpers here that touch GL put back every bit of state
//! the page could see.

use std::collections::HashSet;
use std::ffi::{CString, c_char, c_void};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use glow::{HasContext, NativeFramebuffer, NativeRenderbuffer};
use khronos_egl as egl;
use serde_json::{Map, Value, json};

use crate::{Attrs, exec, source};

const PLATFORM: &str = if cfg!(target_os = "macos") { "mac-arm64" } else { "linux-x64" };
const LIB_EXT: &str = if cfg!(target_os = "macos") { "dylib" } else { "so" };
const MISSING: &str = "WebGL needs ANGLE: run scripts/fetch-angle.sh";

// EGL_ANGLE_platform_angle and ANGLE's context attributes
const PLATFORM_ANGLE: u32 = 0x3202;
const PLATFORM_ANGLE_TYPE: i32 = 0x3203;
const PLATFORM_ANGLE_DEVICE_TYPE: i32 = 0x3209;
const TYPE_OPENGL: i32 = 0x320D;
const TYPE_VULKAN: i32 = 0x3450;
const TYPE_METAL: i32 = 0x3489;
const DEVICE_SWIFTSHADER: i32 = 0x3487;
const CONTEXT_MAJOR_VERSION: i32 = 0x3098;
const CONTEXT_MINOR_VERSION: i32 = 0x30FB;
const WEBGL_COMPATIBILITY: i32 = 0x33AC;
const EXTENSIONS_ENABLED: i32 = 0x345F;
const BACKWARDS_COMPATIBLE: i32 = 0x3483;
const CLIENT_ARRAYS_ENABLED: i32 = 0x3452;
const ROBUST_RESOURCE_INITIALIZATION: i32 = 0x3453;

const REQUESTABLE_EXTENSIONS: u32 = 0x93A8;
const MAX_TEXTURE_MAX_ANISOTROPY: u32 = 0x84FF;

/// What every context is made with: ES 3.0 exactly (not the 3.1 ANGLE would give), WebGL's rules, extensions only when
/// the page asks, no client-side vertex arrays (an offset is never read as a pointer), resources zeroed before first
/// use (as WebGL requires and Chrome asks ANGLE for).
#[rustfmt::skip]
const CONTEXT_ATTRS: &[i32] = &[
    CONTEXT_MAJOR_VERSION, 3,
    CONTEXT_MINOR_VERSION, 0,
    WEBGL_COMPATIBILITY, 1,
    EXTENSIONS_ENABLED, 0,
    BACKWARDS_COMPATIBLE, 0,
    CLIENT_ARRAYS_ENABLED, 0,
    ROBUST_RESOURCE_INITIALIZATION, 1,
    egl::NONE,
];

const PBUFFER_ATTRS: &[i32] = &[egl::WIDTH, 1, egl::HEIGHT, 1, egl::NONE];

/// Each WebGL extension a page may get and the ANGLE extensions behind it (none: always there, done in JS).
const EXTENSIONS: &[(&str, &[&str])] = &[
    ("EXT_color_buffer_float", &["GL_EXT_color_buffer_float"]),
    ("EXT_color_buffer_half_float", &["GL_EXT_color_buffer_half_float"]),
    ("EXT_float_blend", &["GL_EXT_float_blend"]),
    ("EXT_texture_filter_anisotropic", &["GL_EXT_texture_filter_anisotropic"]),
    ("EXT_texture_norm16", &["GL_EXT_texture_norm16"]),
    ("OES_texture_float_linear", &["GL_OES_texture_float_linear"]),
    ("OES_draw_buffers_indexed", &["GL_OES_draw_buffers_indexed"]),
    ("WEBGL_clip_cull_distance", &["GL_ANGLE_clip_cull_distance"]),
    ("WEBGL_compressed_texture_s3tc", &["GL_EXT_texture_compression_dxt1", "GL_ANGLE_texture_compression_dxt3", "GL_ANGLE_texture_compression_dxt5"]),
    ("WEBGL_compressed_texture_s3tc_srgb", &["GL_EXT_texture_compression_s3tc_srgb"]),
    ("WEBGL_compressed_texture_etc", &["GL_ANGLE_compressed_texture_etc"]),
    ("WEBGL_compressed_texture_etc1", &["GL_OES_compressed_ETC1_RGB8_texture"]),
    ("WEBGL_compressed_texture_astc", &["GL_KHR_texture_compression_astc_ldr"]),
    ("WEBGL_compressed_texture_pvrtc", &["GL_IMG_texture_compression_pvrtc"]),
    ("EXT_texture_compression_bptc", &["GL_EXT_texture_compression_bptc"]),
    ("EXT_texture_compression_rgtc", &["GL_EXT_texture_compression_rgtc"]),
    ("WEBGL_debug_renderer_info", &[]),
    ("WEBGL_lose_context", &[]),
];

/// The limits `getParameter` answers from `Info.params` that are one integer, the same for every context.
const LIMITS: &[u32] = &[
    0x0D33, // MAX_TEXTURE_SIZE
    0x851C, // MAX_CUBE_MAP_TEXTURE_SIZE
    0x8073, // MAX_3D_TEXTURE_SIZE
    0x88FF, // MAX_ARRAY_TEXTURE_LAYERS
    0x84E8, // MAX_RENDERBUFFER_SIZE
    0x8872, // MAX_TEXTURE_IMAGE_UNITS
    0x8B4C, // MAX_VERTEX_TEXTURE_IMAGE_UNITS
    0x8B4D, // MAX_COMBINED_TEXTURE_IMAGE_UNITS
    0x8869, // MAX_VERTEX_ATTRIBS
    0x8DFB, // MAX_VERTEX_UNIFORM_VECTORS
    0x8DFD, // MAX_FRAGMENT_UNIFORM_VECTORS
    0x8DFC, // MAX_VARYING_VECTORS
    0x8D57, // MAX_SAMPLES
    0x8824, // MAX_DRAW_BUFFERS
    0x8CDF, // MAX_COLOR_ATTACHMENTS
    0x8A2F, // MAX_UNIFORM_BUFFER_BINDINGS
    0x0D50, // SUBPIXEL_BITS
];
/// The drawing buffer's own, read with it bound: RED/GREEN/BLUE/ALPHA/DEPTH/STENCIL_BITS, SAMPLE_BUFFERS, SAMPLES.
const BUFFER_PARAMS: &[u32] = &[0x0D52, 0x0D53, 0x0D54, 0x0D55, 0x0D56, 0x0D57, 0x80A8, 0x80A9];

/// ANGLE, once a process: its libraries, the display, and what every context shares.
struct Angle {
    egl: egl::DynamicInstance<egl::EGL1_5>,
    /// libGLESv2, kept loaded (libEGL is inside `egl`).
    _gles: libloading::Library,
    display: egl::Display,
    config: egl::Config,
    /// Never current after load: it holds the share group every context joins.
    root: egl::Context,
    request_extension: unsafe extern "system" fn(*const c_char),
    color_mask_i: unsafe extern "system" fn(u32, u8, u8, u8, u8),
    /// The GL extensions a context may turn on (on from the start, or requestable).
    available: HashSet<String>,
    /// `Info`, but for the drawing buffer's params.
    info: Value,
    /// The largest drawing buffer, width and height: the smallest of MAX_RENDERBUFFER_SIZE, MAX_TEXTURE_SIZE and
    /// MAX_VIEWPORT_DIMS, as Chrome clamps it.
    max_size: [u32; 2],
}

// The EGL handles are process-wide and EGL is thread-safe; the GL calls made through them are on one thread each.
unsafe impl Send for Angle {}
unsafe impl Sync for Angle {}

static ANGLE: OnceLock<Result<Angle, String>> = OnceLock::new();

fn angle() -> Result<&'static Angle, String> {
    ANGLE.get_or_init(|| unsafe { load() }).as_ref().map_err(Clone::clone)
}

/// The folder holding libEGL and libGLESv2: `RAEA_ANGLE_DIR`, else `vendor/angle/<platform>` in an ancestor of the
/// running binary or of the current directory.
fn angle_dir() -> Result<PathBuf, String> {
    let has = |d: &Path| d.join(format!("libEGL.{LIB_EXT}")).is_file() && d.join(format!("libGLESv2.{LIB_EXT}")).is_file();
    if let Some(dir) = std::env::var_os("RAEA_ANGLE_DIR") {
        let dir = PathBuf::from(dir);
        return if has(&dir) { Ok(dir) } else { Err(format!("{MISSING} (RAEA_ANGLE_DIR={} has no libEGL/libGLESv2)", dir.display())) };
    }
    [std::env::current_exe().ok(), std::env::current_dir().ok()]
        .iter()
        .flatten()
        .flat_map(|p| p.ancestors())
        .map(|a| a.join("vendor/angle").join(PLATFORM))
        .find(|d| has(d))
        .ok_or_else(|| MISSING.to_string())
}

/// The display's attributes: SwiftShader's Vulkan on Linux, Metal on macOS, or `RAEA_ANGLE_BACKEND`'s.
fn backend() -> Result<Vec<i32>, String> {
    let default = if cfg!(target_os = "macos") { "metal" } else { "swiftshader" };
    let name = std::env::var("RAEA_ANGLE_BACKEND").unwrap_or_else(|_| default.into());
    let attrs = match name.as_str() {
        // ANGLE points the Vulkan loader at the vk_swiftshader_icd.json beside it while it makes its instance; nothing
        // is set for the process, so Bevy's own wgpu device picks its own driver
        "swiftshader" => vec![PLATFORM_ANGLE_TYPE, TYPE_VULKAN, PLATFORM_ANGLE_DEVICE_TYPE, DEVICE_SWIFTSHADER],
        "vulkan" => vec![PLATFORM_ANGLE_TYPE, TYPE_VULKAN],
        "metal" => vec![PLATFORM_ANGLE_TYPE, TYPE_METAL],
        "opengl" => vec![PLATFORM_ANGLE_TYPE, TYPE_OPENGL],
        other => return Err(format!("RAEA_ANGLE_BACKEND={other}: not metal, vulkan, swiftshader or opengl")),
    };
    Ok(attrs.into_iter().chain([egl::NONE]).collect())
}

/// A GL or EGL function by name, through eglGetProcAddress; null when ANGLE has none.
fn proc_address(egl: &egl::DynamicInstance<egl::EGL1_5>, name: &str) -> *const c_void {
    egl.get_proc_address(name).map_or(std::ptr::null(), |f| f as *const c_void)
}

/// A glow context over the EGL context current on this thread.
unsafe fn glow_context(egl: &egl::DynamicInstance<egl::EGL1_5>) -> glow::Context {
    unsafe { glow::Context::from_loader_function_cstr(|name| proc_address(egl, name.to_str().unwrap_or(""))) }
}

unsafe fn load() -> Result<Angle, String> {
    let dir = angle_dir()?;
    let attrs = backend()?;
    let open = |name: &str| -> Result<libloading::Library, String> {
        let path = dir.join(format!("{name}.{LIB_EXT}"));
        // global, so libEGL's own dlopen of libGLESv2 finds this one
        let flags = libloading::os::unix::RTLD_NOW | libloading::os::unix::RTLD_GLOBAL;
        let lib = unsafe { libloading::os::unix::Library::open(Some(&path), flags) };
        lib.map(Into::into).map_err(|e| format!("WebGL: loading {}: {e}", path.display()))
    };
    let gles = open("libGLESv2")?;
    let egl = unsafe { egl::DynamicInstance::<egl::EGL1_5>::load_required_from(open("libEGL")?) }
        .map_err(|e| format!("WebGL: libEGL in {}: {e}", dir.display()))?;
    let fail = |what: &str, e: egl::Error| format!("WebGL: {what} on ANGLE: {e}");
    let symbol = |name: &str| {
        let f = proc_address(&egl, name);
        if f.is_null() { Err(format!("WebGL: ANGLE has no {name}")) } else { Ok(f) }
    };

    let get_display: unsafe extern "system" fn(u32, *mut c_void, *const i32) -> *mut c_void =
        unsafe { std::mem::transmute(symbol("eglGetPlatformDisplayEXT")?) };
    let display = unsafe { get_display(PLATFORM_ANGLE, std::ptr::null_mut(), attrs.as_ptr()) };
    if display.is_null() {
        return Err(format!("WebGL: no ANGLE display ({:?})", egl.get_error()));
    }
    let display = unsafe { egl::Display::from_ptr(display) };
    egl.initialize(display).map_err(|e| fail("eglInitialize", e))?;
    #[rustfmt::skip]
    let config_attrs = [
        egl::RENDERABLE_TYPE, egl::OPENGL_ES3_BIT,
        egl::SURFACE_TYPE, egl::PBUFFER_BIT,
        egl::RED_SIZE, 8, egl::GREEN_SIZE, 8, egl::BLUE_SIZE, 8, egl::ALPHA_SIZE, 8,
        egl::NONE,
    ];
    let config = egl
        .choose_first_config(display, &config_attrs)
        .map_err(|e| fail("eglChooseConfig", e))?
        .ok_or("WebGL: ANGLE has no RGBA8 ES 3 pbuffer config")?;
    let root = egl.create_context(display, config, None, CONTEXT_ATTRS).map_err(|e| fail("eglCreateContext", e))?;
    let request_extension: unsafe extern "system" fn(*const c_char) = unsafe { std::mem::transmute(symbol("glRequestExtensionANGLE")?) };
    let color_mask_i: unsafe extern "system" fn(u32, u8, u8, u8, u8) = unsafe { std::mem::transmute(symbol("glColorMaskiOES")?) };

    // What every context shares, read once on the root, current here only for this.
    let surface = egl.create_pbuffer_surface(display, config, PBUFFER_ATTRS).map_err(|e| fail("eglCreatePbufferSurface", e))?;
    egl.make_current(display, Some(surface), Some(surface), Some(root)).map_err(|e| fail("eglMakeCurrent", e))?;
    let (available, info, max_size) = unsafe {
        let gl = glow_context(&egl);
        let mut available = gl.supported_extensions().clone();
        available.extend(gl.get_parameter_string(REQUESTABLE_EXTENSIONS).split_whitespace().map(String::from));
        let extensions: Vec<&str> =
            EXTENSIONS.iter().filter(|(_, names)| names.iter().all(|n| available.contains(*n))).map(|(webgl, _)| *webgl).collect();
        let mut params = Map::new();
        for &p in LIMITS {
            params.insert(p.to_string(), json!(gl.get_parameter_i32(p)));
        }
        params.insert(glow::MAX_ELEMENT_INDEX.to_string(), json!(gl.get_parameter_i64(glow::MAX_ELEMENT_INDEX)));
        let mut dims = [0; 2];
        gl.get_parameter_i32_slice(glow::MAX_VIEWPORT_DIMS, &mut dims);
        params.insert(glow::MAX_VIEWPORT_DIMS.to_string(), json!(dims));
        let side = gl.get_parameter_i32(glow::MAX_RENDERBUFFER_SIZE).min(gl.get_parameter_i32(glow::MAX_TEXTURE_SIZE));
        let max_size = dims.map(|d| d.min(side).max(1) as u32);
        for p in [glow::ALIASED_LINE_WIDTH_RANGE, glow::ALIASED_POINT_SIZE_RANGE] {
            let mut range = [0.0f32; 2];
            gl.get_parameter_f32_slice(p, &mut range);
            params.insert(p.to_string(), json!(range));
        }
        // the root turns anisotropy on to read its limit; a page's context turns it on when the page asks
        if available.contains("GL_EXT_texture_filter_anisotropic") {
            request_extension(c"GL_EXT_texture_filter_anisotropic".as_ptr());
            params.insert(MAX_TEXTURE_MAX_ANISOTROPY.to_string(), json!(gl.get_parameter_f32(MAX_TEXTURE_MAX_ANISOTROPY)));
        }
        let info = json!({
            "version": format!("WebGL 2.0 ({})", gl.get_parameter_string(glow::VERSION)),
            "shadingLanguageVersion": format!("WebGL GLSL ES 3.00 ({})", gl.get_parameter_string(glow::SHADING_LANGUAGE_VERSION)),
            "vendor": "WebKit",
            "renderer": "WebKit WebGL",
            "unmaskedVendor": gl.get_parameter_string(glow::VENDOR),
            "unmaskedRenderer": gl.get_parameter_string(glow::RENDERER),
            "extensions": extensions,
            "params": params,
        });
        (available, info, max_size)
    };
    egl.make_current(display, None, None, None).map_err(|e| fail("eglMakeCurrent", e))?;
    egl.destroy_surface(display, surface).map_err(|e| fail("eglDestroySurface", e))?;
    Ok(Angle { egl, _gles: gles, display, config, root, request_extension, color_mask_i, available, info, max_size })
}

/// The drawing buffer's depth/stencil renderbuffer format and attachment, as Chrome makes them for `depth` and
/// `stencil`: none when neither is asked for.
fn depth_stencil(attrs: Attrs) -> Option<(u32, u32)> {
    match (attrs.depth, attrs.stencil) {
        (true, true) => Some((glow::DEPTH24_STENCIL8, glow::DEPTH_STENCIL_ATTACHMENT)),
        (true, false) => Some((glow::DEPTH_COMPONENT24, glow::DEPTH_ATTACHMENT)),
        (false, true) => Some((glow::STENCIL_INDEX8, glow::STENCIL_ATTACHMENT)),
        (false, false) => None,
    }
}

/// The drawing buffer's GL objects.
#[derive(Clone, Copy)]
struct Buffers {
    /// Multisampled with antialias: what null binds for drawing.
    fbo: NativeFramebuffer,
    color: NativeRenderbuffer,
    depth: Option<NativeRenderbuffer>,
    /// With antialias: the single-sample framebuffer the drawing buffer resolves into, what null binds for reading.
    resolve: Option<(NativeFramebuffer, NativeRenderbuffer)>,
}

impl Buffers {
    /// A `w` x `h` drawing buffer with its storage, attached and complete, or an error and nothing left made. It binds
    /// framebuffers and the renderbuffer: the caller puts them back.
    unsafe fn new(gl: &glow::Context, attrs: Attrs, samples: i32, w: i32, h: i32) -> Result<Buffers, String> {
        unsafe {
            let ds = depth_stencil(attrs);
            let b = Buffers {
                fbo: gl.create_framebuffer()?,
                color: gl.create_renderbuffer()?,
                depth: if ds.is_some() { Some(gl.create_renderbuffer()?) } else { None },
                resolve: if samples > 0 { Some((gl.create_framebuffer()?, gl.create_renderbuffer()?)) } else { None },
            };
            let format = if attrs.alpha { glow::RGBA8 } else { glow::RGB8 };
            // a renderbuffer name is only an object once bound, so each is bound before it is attached
            let attach = |rb, format, samples, attachment| {
                gl.bind_renderbuffer(glow::RENDERBUFFER, Some(rb));
                if samples > 0 {
                    gl.renderbuffer_storage_multisample(glow::RENDERBUFFER, samples, format, w, h);
                } else {
                    gl.renderbuffer_storage(glow::RENDERBUFFER, format, w, h);
                }
                gl.framebuffer_renderbuffer(glow::DRAW_FRAMEBUFFER, attachment, glow::RENDERBUFFER, Some(rb));
            };
            gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(b.fbo));
            attach(b.color, format, samples, glow::COLOR_ATTACHMENT0);
            if let (Some(rb), Some((format, attachment))) = (b.depth, ds) {
                attach(rb, format, samples, attachment);
            }
            let mut status = gl.check_framebuffer_status(glow::DRAW_FRAMEBUFFER);
            if let Some((rfbo, rcolor)) = b.resolve {
                gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(rfbo));
                attach(rcolor, format, 0, glow::COLOR_ATTACHMENT0);
                if status == glow::FRAMEBUFFER_COMPLETE {
                    status = gl.check_framebuffer_status(glow::DRAW_FRAMEBUFFER);
                }
            }
            if status != glow::FRAMEBUFFER_COMPLETE {
                b.delete(gl);
                return Err(format!("WebGL: a {w}x{h} drawing buffer is incomplete (0x{status:x})"));
            }
            Ok(b)
        }
    }

    unsafe fn delete(&self, gl: &glow::Context) {
        unsafe {
            gl.delete_framebuffer(self.fbo);
            gl.delete_renderbuffer(self.color);
            if let Some(depth) = self.depth {
                gl.delete_renderbuffer(depth);
            }
            if let Some((rfbo, rcolor)) = self.resolve {
                gl.delete_framebuffer(rfbo);
                gl.delete_renderbuffer(rcolor);
            }
        }
    }

    /// What null binds for reading: the resolve framebuffer, else the drawing buffer's own.
    fn read_fbo(&self) -> NativeFramebuffer {
        self.resolve.map_or(self.fbo, |(f, _)| f)
    }
}

/// A WebGL context: its GL, its drawing buffer, the page's objects and unpack state.
pub struct Context {
    pub gl: glow::Context,
    pub attrs: Attrs,
    pub width: u32,
    pub height: u32,
    pub objects: exec::Objects,
    pub unpack: source::Unpack,
    angle: &'static Angle,
    context: egl::Context,
    surface: egl::Surface,
    /// The drawing buffer.
    buffers: Buffers,
    samples: i32,
    /// The resolve is behind the drawing buffer.
    stale: bool,
    /// The GL extensions on in this context.
    enabled: HashSet<String>,
    info: Value,
}

/// A WebGL context with a `width` x `height` drawing buffer, clamped to the GL limits (`Context::width`/`height` hold
/// the size it got).
pub fn create(width: u32, height: u32, attrs: Attrs) -> Result<Context, String> {
    let a = angle()?;
    let (width, height) = (width.clamp(1, a.max_size[0]), height.clamp(1, a.max_size[1]));
    let fail = |what: &str, e: egl::Error| format!("WebGL: {what}: {e}");
    let context = a.egl.create_context(a.display, a.config, Some(a.root), CONTEXT_ATTRS).map_err(|e| fail("eglCreateContext", e))?;
    let surface = a.egl.create_pbuffer_surface(a.display, a.config, PBUFFER_ATTRS).map_err(|e| fail("eglCreatePbufferSurface", e));
    let current = surface.clone().and_then(|s| a.egl.make_current(a.display, Some(s), Some(s), Some(context)).map_err(|e| fail("eglMakeCurrent", e)));
    let objects = current.and_then(|()| unsafe {
        let gl = glow_context(&a.egl);
        let samples = if attrs.antialias { gl.get_parameter_i32(glow::MAX_SAMPLES).min(4) } else { 0 };
        let buffers = Buffers::new(&gl, attrs, samples, width as i32, height as i32)?;
        Ok((gl, samples, buffers))
    });
    let (gl, samples, buffers) = match objects {
        Ok(o) => o,
        Err(e) => {
            let _ = a.egl.make_current(a.display, None, None, None);
            if let Ok(s) = surface {
                let _ = a.egl.destroy_surface(a.display, s);
            }
            let _ = a.egl.destroy_context(a.display, context);
            return Err(e);
        }
    };
    unsafe {
        // the page's starting state: null bound for drawing and reading, no renderbuffer, viewport and scissor box the
        // canvas
        gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(buffers.fbo));
        gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(buffers.read_fbo()));
        gl.bind_renderbuffer(glow::RENDERBUFFER, None);
        gl.viewport(0, 0, width as i32, height as i32);
        gl.scissor(0, 0, width as i32, height as i32);
    }
    let enabled = gl.supported_extensions().clone();
    let mut cx = Context {
        gl,
        attrs,
        width,
        height,
        objects: exec::Objects::default(),
        unpack: source::Unpack::default(),
        angle: a,
        context,
        surface: surface.unwrap(),
        buffers,
        samples,
        stale: false,
        enabled,
        info: Value::Null,
    };
    cx.clear();
    // read with the drawing buffer bound for drawing
    let mut info = a.info.clone();
    for &p in BUFFER_PARAMS {
        info["params"][p.to_string()] = json!(unsafe { cx.gl.get_parameter_i32(p) });
    }
    cx.info = info;
    Ok(cx)
}

/// The GL state the page can see that the helpers below change, as the page left it.
struct Saved {
    draw: u32,
    read: u32,
    renderbuffer: u32,
    pack_buffer: u32,
    pack: [i32; 4],
    scissor: bool,
    discard: bool,
    /// Draw buffer 0's, the only one a clear of our one attachment goes through.
    color_mask: [bool; 4],
    depth_mask: bool,
    stencil_mask: [i32; 2],
}

const PACK: [u32; 4] = [glow::PACK_ALIGNMENT, glow::PACK_ROW_LENGTH, glow::PACK_SKIP_ROWS, glow::PACK_SKIP_PIXELS];

impl Context {
    /// This context current on the calling thread.
    pub fn make_current(&self) -> Result<(), String> {
        let a = self.angle;
        if a.egl.get_current_context() == Some(self.context) {
            return Ok(());
        }
        a.egl.make_current(a.display, Some(self.surface), Some(self.surface), Some(self.context)).map_err(|e| format!("WebGL: eglMakeCurrent: {e}"))
    }

    /// The drawing buffer remade at `width` x `height`, clamped to the GL limits, and cleared. When it can't be made
    /// the previous one stays, at its size.
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), String> {
        let (width, height) = (width.clamp(1, self.angle.max_size[0]), height.clamp(1, self.angle.max_size[1]));
        let old = self.buffers;
        unsafe {
            let mut saved = self.save();
            let made = Buffers::new(&self.gl, self.attrs, self.samples, width as i32, height as i32);
            if let Ok(new) = &made {
                // the old drawing buffer bound becomes the new one
                let moved = |b: u32| match b {
                    _ if b == old.fbo.0.get() => new.fbo.0.get(),
                    _ if b == old.read_fbo().0.get() => new.read_fbo().0.get(),
                    _ => b,
                };
                (saved.draw, saved.read) = (moved(saved.draw), moved(saved.read));
            }
            self.restore(&saved);
            self.buffers = made?;
            old.delete(&self.gl);
        }
        self.width = width;
        self.height = height;
        self.clear();
        Ok(())
    }

    pub fn info(&self) -> Value {
        self.info.clone()
    }

    /// The ANGLE extensions behind WebGL extension `webgl_name` (one `info().extensions` lists) turned on.
    pub fn request_extension(&mut self, webgl_name: &str) {
        let Some((_, names)) = EXTENSIONS.iter().find(|(n, _)| *n == webgl_name) else { return };
        for name in names.iter().filter(|n| self.angle.available.contains(**n)) {
            if self.enabled.insert(name.to_string()) {
                let name = CString::new(*name).unwrap();
                unsafe { (self.angle.request_extension)(name.as_ptr()) };
            }
        }
        // EXT_color_buffer_float turns EXT_float_blend on with it, as the WebGL spec asks
        if webgl_name == "EXT_color_buffer_float" {
            self.request_extension("EXT_float_blend");
        }
    }

    pub fn draw_framebuffer(&self) -> glow::Framebuffer {
        self.buffers.fbo
    }

    /// The drawing buffer to read from, resolved first if it is multisampled and behind.
    pub fn read_framebuffer(&mut self) -> glow::Framebuffer {
        let Some((rfbo, _)) = self.buffers.resolve else { return self.buffers.fbo };
        if self.stale {
            let (w, h) = (self.width as i32, self.height as i32);
            unsafe {
                let saved = self.save();
                self.neutral(&saved);
                self.gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(self.buffers.fbo));
                self.gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(rfbo));
                self.gl.blit_framebuffer(0, 0, w, h, 0, 0, w, h, glow::COLOR_BUFFER_BIT, glow::NEAREST);
                self.restore(&saved);
            }
            self.stale = false;
        }
        rfbo
    }

    pub fn mark_drawn(&mut self) {
        self.stale = true;
    }

    /// The drawing buffer as RGBA8, top row first: straight alpha when `straight`, else as stored.
    pub fn read_canvas(&mut self, straight: bool) -> Vec<u8> {
        let mut data = self.read();
        if straight && self.attrs.premultiplied_alpha && self.attrs.alpha {
            for px in data.chunks_exact_mut(4) {
                let a = px[3] as u32;
                for c in &mut px[..3] {
                    *c = if a == 0 { 0 } else { ((*c as u32 * 255 + a / 2) / a).min(255) as u8 };
                }
            }
        }
        data
    }

    /// The drawing buffer handed to the page as `(ctx, generation)`, then cleared unless preserveDrawingBuffer.
    pub fn snapshot(&mut self, ctx: u32, generation: u64) {
        let data = self.read();
        let frame = raea_sys_canvas::frames::Frame { width: self.width, height: self.height, premultiplied: self.attrs.premultiplied_alpha, data };
        raea_sys_canvas::frames::put(ctx, generation, frame);
        if !self.attrs.preserve_drawing_buffer {
            self.clear();
        }
    }

    /// The drawing buffer, resolved, read back top row first.
    fn read(&mut self) -> Vec<u8> {
        let from = self.read_framebuffer();
        let (w, h) = (self.width as usize, self.height as usize);
        let mut data = vec![0u8; w * h * 4];
        unsafe {
            let saved = self.save();
            self.neutral(&saved);
            self.gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(from));
            self.gl.read_pixels(0, 0, w as i32, h as i32, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelPackData::Slice(Some(&mut data)));
            self.restore(&saved);
        }
        let row = w * 4;
        for y in 0..h / 2 {
            let (top, bottom) = data.split_at_mut((h - 1 - y) * row);
            top[y * row..(y + 1) * row].swap_with_slice(&mut bottom[..row]);
        }
        data
    }

    /// The drawing buffer cleared to transparent black, depth 1, stencil 0.
    fn clear(&mut self) {
        unsafe {
            let saved = self.save();
            self.neutral(&saved);
            self.gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(self.buffers.fbo));
            self.gl.clear_buffer_f32_slice(glow::COLOR, 0, &[0.0; 4]);
            match depth_stencil(self.attrs).map(|(_, attachment)| attachment) {
                Some(glow::DEPTH_STENCIL_ATTACHMENT) => self.gl.clear_buffer_depth_stencil(glow::DEPTH_STENCIL, 0, 1.0, 0),
                Some(glow::DEPTH_ATTACHMENT) => self.gl.clear_buffer_f32_slice(glow::DEPTH, 0, &[1.0]),
                Some(_) => self.gl.clear_buffer_i32_slice(glow::STENCIL, 0, &[0]),
                None => {}
            }
            self.restore(&saved);
        }
        self.stale = true;
    }

    unsafe fn save(&self) -> Saved {
        let gl = &self.gl;
        unsafe {
            Saved {
                draw: gl.get_parameter_i32(glow::DRAW_FRAMEBUFFER_BINDING) as u32,
                read: gl.get_parameter_i32(glow::READ_FRAMEBUFFER_BINDING) as u32,
                renderbuffer: gl.get_parameter_i32(glow::RENDERBUFFER_BINDING) as u32,
                pack_buffer: gl.get_parameter_i32(glow::PIXEL_PACK_BUFFER_BINDING) as u32,
                pack: PACK.map(|p| gl.get_parameter_i32(p)),
                scissor: gl.is_enabled(glow::SCISSOR_TEST),
                discard: gl.is_enabled(glow::RASTERIZER_DISCARD),
                color_mask: gl.get_parameter_bool_array::<4>(glow::COLOR_WRITEMASK),
                depth_mask: gl.get_parameter_bool(glow::DEPTH_WRITEMASK),
                stencil_mask: [gl.get_parameter_i32(glow::STENCIL_WRITEMASK), gl.get_parameter_i32(glow::STENCIL_BACK_WRITEMASK)],
            }
        }
    }

    /// Everything that would change a clear, blit or read of the drawing buffer set to let it all through.
    unsafe fn neutral(&self, saved: &Saved) {
        let gl = &self.gl;
        unsafe {
            gl.bind_buffer(glow::PIXEL_PACK_BUFFER, None);
            for (p, v) in PACK.into_iter().zip([4, 0, 0, 0]) {
                gl.pixel_store_i32(p, v);
            }
            gl.disable(glow::SCISSOR_TEST);
            gl.disable(glow::RASTERIZER_DISCARD);
            self.color_mask([true; 4], saved.color_mask);
            gl.depth_mask(true);
            gl.stencil_mask(!0);
        }
    }

    unsafe fn restore(&self, s: &Saved) {
        let gl = &self.gl;
        unsafe {
            gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, NonZeroU32::new(s.draw).map(NativeFramebuffer));
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, NonZeroU32::new(s.read).map(NativeFramebuffer));
            gl.bind_renderbuffer(glow::RENDERBUFFER, NonZeroU32::new(s.renderbuffer).map(NativeRenderbuffer));
            gl.bind_buffer(glow::PIXEL_PACK_BUFFER, NonZeroU32::new(s.pack_buffer).map(glow::NativeBuffer));
            for (p, v) in PACK.into_iter().zip(s.pack) {
                gl.pixel_store_i32(p, v);
            }
            if s.scissor {
                gl.enable(glow::SCISSOR_TEST);
            }
            if s.discard {
                gl.enable(glow::RASTERIZER_DISCARD);
            }
            self.color_mask(s.color_mask, [true; 4]);
            gl.depth_mask(s.depth_mask);
            gl.stencil_mask_separate(glow::FRONT, s.stencil_mask[0] as u32);
            gl.stencil_mask_separate(glow::BACK, s.stencil_mask[1] as u32);
        }
    }

    /// Draw buffer 0's color mask set to `mask` (it was `was`), the other draw buffers' left alone when the page has
    /// OES_draw_buffers_indexed (without it they all have draw buffer 0's).
    unsafe fn color_mask(&self, mask: [bool; 4], was: [bool; 4]) {
        if mask == was {
            return;
        }
        let [r, g, b, a] = mask;
        if self.enabled.contains("GL_OES_draw_buffers_indexed") {
            unsafe { (self.angle.color_mask_i)(0, r as u8, g as u8, b as u8, a as u8) };
        } else {
            unsafe { self.gl.color_mask(r, g, b, a) };
        }
    }
}

/// The EGL context and the drawing buffer freed. The page's objects live in the share group, so exec frees them.
impl Drop for Context {
    fn drop(&mut self) {
        let a = self.angle;
        if self.make_current().is_ok() {
            // the page's objects live in the share group, so they outlive the context unless deleted here
            self.objects.delete_all(&self.gl);
            unsafe { self.buffers.delete(&self.gl) };
        }
        let _ = a.egl.make_current(a.display, None, None, None);
        let _ = a.egl.destroy_surface(a.display, self.surface);
        let _ = a.egl.destroy_context(a.display, self.context);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attrs(antialias: bool) -> Attrs {
        Attrs { alpha: true, depth: true, stencil: false, antialias, premultiplied_alpha: true, preserve_drawing_buffer: false }
    }

    /// The lower-left half of the drawing buffer drawn in `color` over `clear`, through a #version 300 es program;
    /// everything it makes is deleted after.
    fn triangle(cx: &mut Context, clear: [f32; 4], color: [f32; 4]) {
        cx.make_current().unwrap();
        let gl = &cx.gl;
        unsafe {
            let shader = |kind, src: &str| {
                let s = gl.create_shader(kind).unwrap();
                gl.shader_source(s, src);
                gl.compile_shader(s);
                assert!(gl.get_shader_compile_status(s), "{}", gl.get_shader_info_log(s));
                s
            };
            let vs = shader(glow::VERTEX_SHADER, "#version 300 es\nin vec2 p;\nvoid main() { gl_Position = vec4(p, 0.0, 1.0); }");
            let fs = shader(glow::FRAGMENT_SHADER, "#version 300 es\nprecision mediump float;\nuniform vec4 c;\nout vec4 o;\nvoid main() { o = c; }");
            let program = gl.create_program().unwrap();
            gl.attach_shader(program, vs);
            gl.attach_shader(program, fs);
            gl.bind_attrib_location(program, 0, "p");
            gl.link_program(program);
            assert!(gl.get_program_link_status(program), "{}", gl.get_program_info_log(program));
            gl.use_program(Some(program));
            gl.uniform_4_f32(gl.get_uniform_location(program, "c").as_ref(), color[0], color[1], color[2], color[3]);
            let vao = gl.create_vertex_array().unwrap();
            gl.bind_vertex_array(Some(vao));
            let buffer = gl.create_buffer().unwrap();
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(buffer));
            let points: Vec<u8> = [-1.0f32, -1.0, 1.0, -1.0, -1.0, 1.0].iter().flat_map(|f| f.to_le_bytes()).collect();
            gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, &points, glow::STATIC_DRAW);
            gl.enable_vertex_attrib_array(0);
            gl.vertex_attrib_pointer_f32(0, 2, glow::FLOAT, false, 0, 0);
            gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(cx.draw_framebuffer()));
            gl.clear_color(clear[0], clear[1], clear[2], clear[3]);
            gl.clear(glow::COLOR_BUFFER_BIT | glow::DEPTH_BUFFER_BIT);
            gl.draw_arrays(glow::TRIANGLES, 0, 3);
            assert_eq!(gl.get_error(), glow::NO_ERROR);
            gl.bind_vertex_array(None);
            gl.bind_buffer(glow::ARRAY_BUFFER, None);
            gl.use_program(None);
            gl.delete_vertex_array(vao);
            gl.delete_buffer(buffer);
            gl.delete_program(program);
            gl.delete_shader(vs);
            gl.delete_shader(fs);
        }
        cx.mark_drawn();
    }

    /// Pixel (x, y) of an RGBA8 image `width` wide, y from the top.
    fn pixel(data: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * width + x) * 4) as usize;
        data[i..i + 4].try_into().unwrap()
    }

    const RED: [f32; 4] = [1.0, 0.0, 0.0, 1.0];
    const BLUE: [f32; 4] = [0.0, 0.0, 1.0, 1.0];

    #[test]
    fn angle_draws_a_triangle() {
        for antialias in [false, true] {
            let mut cx = create(64, 64, attrs(antialias)).unwrap();
            triangle(&mut cx, BLUE, RED);
            let px = cx.read_canvas(false);
            assert_eq!(px.len(), 64 * 64 * 4);
            assert_eq!(pixel(&px, 64, 8, 56), [255, 0, 0, 255], "inside, near the bottom left (antialias {antialias})");
            assert_eq!(pixel(&px, 64, 56, 8), [0, 0, 255, 255], "outside, near the top right");
            // a pixel the edge runs through the middle of: half its samples with antialias, all or none without
            let edge = pixel(&px, 64, 20, 20);
            if antialias {
                assert!((64..=192).contains(&edge[0]) && (64..=192).contains(&edge[2]), "edge {edge:?}");
            } else {
                assert!(edge == [255, 0, 0, 255] || edge == [0, 0, 255, 255], "edge {edge:?}");
            }
        }
    }

    #[test]
    fn angle_reads_straight_or_premultiplied() {
        let mut cx = create(16, 16, attrs(true)).unwrap();
        triangle(&mut cx, [0.0; 4], [0.5, 0.0, 0.0, 0.5]);
        let stored = pixel(&cx.read_canvas(false), 16, 2, 13);
        assert!(stored[0].abs_diff(128) <= 1 && stored[3].abs_diff(128) <= 1, "{stored:?}");
        let straight = pixel(&cx.read_canvas(true), 16, 2, 13);
        assert!(straight[0] >= 254 && straight[3].abs_diff(128) <= 1, "{straight:?}");
        assert_eq!(pixel(&cx.read_canvas(true), 16, 13, 2), [0, 0, 0, 0]);

        let mut opaque = create(16, 16, Attrs { alpha: false, ..attrs(false) }).unwrap();
        triangle(&mut opaque, [0.0; 4], [0.0, 1.0, 0.0, 0.0]);
        let px = opaque.read_canvas(true);
        assert_eq!(pixel(&px, 16, 2, 13), [0, 255, 0, 255]);
        assert_eq!(pixel(&px, 16, 13, 2), [0, 0, 0, 255]);
        assert_eq!(opaque.info()["params"][glow::ALPHA_BITS.to_string()], 0);
    }

    #[test]
    fn angle_resizes() {
        let mut cx = create(64, 64, attrs(true)).unwrap();
        triangle(&mut cx, BLUE, RED);
        cx.resize(32, 16).unwrap();
        assert_eq!((cx.width, cx.height), (32, 16));
        let px = cx.read_canvas(false);
        assert_eq!(px.len(), 32 * 16 * 4);
        assert!(px.iter().all(|&b| b == 0), "cleared");
        unsafe { cx.gl.viewport(0, 0, 32, 16) };
        triangle(&mut cx, BLUE, RED);
        let px = cx.read_canvas(false);
        assert_eq!(pixel(&px, 32, 2, 13), [255, 0, 0, 255]);
        assert_eq!(pixel(&px, 32, 29, 2), [0, 0, 255, 255]);
    }

    #[test]
    fn angle_snapshot_puts_a_frame_and_keeps_the_page_state() {
        let mut cx = create(64, 64, attrs(true)).unwrap();
        triangle(&mut cx, BLUE, RED);
        let gl = &cx.gl;
        let pack = unsafe {
            gl.enable(glow::SCISSOR_TEST);
            gl.scissor(1, 2, 3, 4);
            gl.color_mask(true, false, true, false);
            gl.depth_mask(false);
            gl.stencil_mask_separate(glow::FRONT, 0x0F);
            gl.pixel_store_i32(glow::PACK_ALIGNMENT, 8);
            gl.pixel_store_i32(glow::PACK_ROW_LENGTH, 100);
            let pack = gl.create_buffer().unwrap();
            gl.bind_buffer(glow::PIXEL_PACK_BUFFER, Some(pack));
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, None);
            pack
        };
        cx.snapshot(900_001, 7);
        let frame = raea_sys_canvas::frames::take(900_001, 7).expect("a frame");
        assert_eq!((frame.width, frame.height, frame.premultiplied), (64, 64, true));
        assert_eq!(pixel(&frame.data, 64, 8, 56), [255, 0, 0, 255]);
        assert_eq!(pixel(&frame.data, 64, 56, 8), [0, 0, 255, 255]);
        let gl = &cx.gl;
        unsafe {
            assert!(gl.is_enabled(glow::SCISSOR_TEST));
            let mut b = [0; 4];
            gl.get_parameter_i32_slice(glow::SCISSOR_BOX, &mut b);
            assert_eq!(b, [1, 2, 3, 4]);
            assert_eq!(gl.get_parameter_bool_array::<4>(glow::COLOR_WRITEMASK), [true, false, true, false]);
            assert!(!gl.get_parameter_bool(glow::DEPTH_WRITEMASK));
            assert_eq!(gl.get_parameter_i32(glow::STENCIL_WRITEMASK), 0x0F);
            assert_eq!(gl.get_parameter_i32(glow::STENCIL_BACK_WRITEMASK) as u32, !0);
            assert_eq!(gl.get_parameter_i32(glow::PACK_ALIGNMENT), 8);
            assert_eq!(gl.get_parameter_i32(glow::PACK_ROW_LENGTH), 100);
            assert_eq!(gl.get_parameter_buffer(glow::PIXEL_PACK_BUFFER_BINDING), Some(pack));
            assert_eq!(gl.get_parameter_framebuffer(glow::READ_FRAMEBUFFER_BINDING), None);
            assert_eq!(gl.get_parameter_framebuffer(glow::DRAW_FRAMEBUFFER_BINDING), Some(cx.draw_framebuffer()));
            gl.bind_buffer(glow::PIXEL_PACK_BUFFER, None);
            gl.delete_buffer(pack);
            gl.pixel_store_i32(glow::PACK_ROW_LENGTH, 0);
            assert_eq!(gl.get_error(), glow::NO_ERROR);
        }
        // not preserveDrawingBuffer: cleared after
        assert!(cx.read_canvas(false).iter().all(|&b| b == 0));

        let mut kept = create(16, 16, Attrs { preserve_drawing_buffer: true, ..attrs(false) }).unwrap();
        triangle(&mut kept, BLUE, RED);
        kept.snapshot(900_002, 1);
        assert!(raea_sys_canvas::frames::take(900_002, 1).is_some());
        assert_eq!(pixel(&kept.read_canvas(false), 16, 2, 13), [255, 0, 0, 255]);
    }

    #[test]
    fn angle_two_contexts_at_once() {
        let mut a = create(32, 32, attrs(true)).unwrap();
        let mut b = create(32, 32, attrs(false)).unwrap();
        triangle(&mut a, BLUE, RED);
        triangle(&mut b, RED, BLUE);
        a.make_current().unwrap();
        assert_eq!(pixel(&a.read_canvas(false), 32, 2, 29), [255, 0, 0, 255]);
        b.make_current().unwrap();
        assert_eq!(pixel(&b.read_canvas(false), 32, 2, 29), [0, 0, 255, 255]);
        a.make_current().unwrap();
        assert_eq!(pixel(&a.read_canvas(false), 32, 29, 2), [0, 0, 255, 255]);
        drop(b);
        a.make_current().unwrap();
        assert_eq!(pixel(&a.read_canvas(false), 32, 2, 29), [255, 0, 0, 255]);
    }

    #[test]
    fn angle_info_and_extensions() {
        let mut cx = create(8, 8, attrs(true)).unwrap();
        let info = cx.info();
        let version = info["version"].as_str().unwrap();
        assert!(version.starts_with("WebGL 2.0 (OpenGL ES 3.0"), "{version}");
        assert!(info["shadingLanguageVersion"].as_str().unwrap().starts_with("WebGL GLSL ES 3.00 ("));
        assert!(info["unmaskedRenderer"].as_str().unwrap().contains("ANGLE"));
        let extensions: Vec<&str> = info["extensions"].as_array().unwrap().iter().map(|e| e.as_str().unwrap()).collect();
        for e in ["WEBGL_debug_renderer_info", "WEBGL_lose_context", "EXT_color_buffer_float", "EXT_texture_filter_anisotropic"] {
            assert!(extensions.contains(&e), "{e} in {extensions:?}");
        }
        assert!(!extensions.iter().any(|e| e.contains("parallel_shader_compile") || e.contains("multisampled_render_to_texture")));
        let params = &info["params"];
        assert!(params[glow::MAX_TEXTURE_SIZE.to_string()].as_i64().unwrap() >= 4096);
        assert_eq!(params[glow::SAMPLES.to_string()], 4);
        // depth without stencil, as asked
        assert_eq!(params[glow::DEPTH_BITS.to_string()], 24);
        assert_eq!(params[glow::STENCIL_BITS.to_string()], 0);
        assert!(params[MAX_TEXTURE_MAX_ANISOTROPY.to_string()].as_f64().unwrap() >= 1.0);
        assert_eq!(params[glow::MAX_VIEWPORT_DIMS.to_string()].as_array().unwrap().len(), 2);

        let on = |cx: &Context| unsafe {
            (0..cx.gl.get_parameter_i32(glow::NUM_EXTENSIONS) as u32).map(|i| cx.gl.get_parameter_indexed_string(glow::EXTENSIONS, i)).collect::<Vec<_>>()
        };
        assert!(!on(&cx).iter().any(|e| e == "GL_EXT_color_buffer_float"), "off until asked");
        cx.request_extension("EXT_color_buffer_float");
        let now = on(&cx);
        assert!(now.iter().any(|e| e == "GL_EXT_color_buffer_float") && now.iter().any(|e| e == "GL_EXT_float_blend"), "{now:?}");
    }

    #[test]
    fn angle_contexts_are_made_and_dropped() {
        // each 256x256 antialiased context holds about 2.3 MB of drawing buffer
        for _ in 0..50 {
            let mut cx = create(256, 256, attrs(true)).unwrap();
            triangle(&mut cx, BLUE, RED);
            assert_eq!(pixel(&cx.read_canvas(false), 256, 8, 248), [255, 0, 0, 255]);
        }
    }

    #[test]
    fn angle_depth_and_stencil_as_asked() {
        let bits = |depth, stencil, antialias| {
            let mut cx = create(8, 8, Attrs { depth, stencil, ..attrs(antialias) }).unwrap();
            // a resize makes the same kind of buffer, and the clear after a snapshot clears what is there
            cx.resize(9, 7).unwrap();
            cx.snapshot(900_003, 1);
            raea_sys_canvas::frames::take(900_003, 1).unwrap();
            let gl = &cx.gl;
            unsafe {
                gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(cx.draw_framebuffer()));
                assert_eq!(gl.get_error(), glow::NO_ERROR);
                let p = &cx.info()["params"];
                let info = (p[glow::DEPTH_BITS.to_string()].as_i64().unwrap(), p[glow::STENCIL_BITS.to_string()].as_i64().unwrap());
                assert_eq!((gl.get_parameter_i32(glow::DEPTH_BITS) as i64, gl.get_parameter_i32(glow::STENCIL_BITS) as i64), info, "after resize");
                info
            }
        };
        for antialias in [false, true] {
            assert_eq!(bits(true, false, antialias), (24, 0));
            assert_eq!(bits(false, true, antialias), (0, 8));
            assert_eq!(bits(true, true, antialias), (24, 8));
            assert_eq!(bits(false, false, antialias), (0, 0));
        }
    }

    #[test]
    fn angle_clamps_the_drawing_buffer() {
        let max = angle().unwrap().max_size;
        let mut cx = create(max[0] + 1000, 3, attrs(false)).unwrap();
        assert_eq!((cx.width, cx.height), (max[0], 3));
        cx.resize(5, max[1] + 1).unwrap();
        assert_eq!((cx.width, cx.height), (5, max[1]));
        cx.resize(0, 0).unwrap();
        assert_eq!((cx.width, cx.height), (1, 1));
    }
}
