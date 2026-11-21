//! WebGL 2 for a page's canvases (PROTOCOL.md): the page's WebGL2RenderingContext (sdk/raea/src/webgl) writes its GL
//! calls as bytes, `__raea_gl` runs them here on ANGLE, on the JS thread that made the context, and a finished frame
//! waits in raea_sys_canvas::frames for the page.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, Ordering};

use raea_runtime_jsengine::JsEngine;
use serde_json::{Value, json};

mod angle;
mod exec;
pub mod ops;
mod source;

pub use angle::Context;

/// A context's creation attributes, each already defaulted by the page's side.
#[derive(Clone, Copy, Debug)]
pub struct Attrs {
    pub alpha: bool,
    pub depth: bool,
    pub stencil: bool,
    pub antialias: bool,
    pub premultiplied_alpha: bool,
    pub preserve_drawing_buffer: bool,
}

/// Context ids: one counter a process, so a frame is named by its context wherever it was drawn.
static NEXT: AtomicU32 = AtomicU32::new(1);

thread_local! {
    /// This JS thread's contexts.
    static CONTEXTS: RefCell<HashMap<u32, Rc<RefCell<Context>>>> = RefCell::new(HashMap::new());
}

/// Context `id` of this thread.
pub(crate) fn context(id: u32) -> Result<Rc<RefCell<Context>>, String> {
    CONTEXTS.with(|c| c.borrow().get(&id).cloned()).ok_or_else(|| format!("no WebGL context {id} on this thread"))
}

/// `__raea_gl` on the engine and the `webgl.*` calls in the registry (PROTOCOL.md).
pub fn install(js: &mut dyn JsEngine) -> Result<(), String> {
    js.native_bytes(
        "__raea_gl",
        Box::new(|bytes, nums| {
            let len = (nums.first().copied().unwrap_or(0.0) as usize).min(bytes.len());
            let id = nums.get(1).copied().unwrap_or(0.0) as u32;
            let cx = context(id)?;
            let mut cx = cx.try_borrow_mut().map_err(|_| format!("WebGL context {id} is already running a call"))?;
            cx.make_current()?;
            exec::run(&mut cx, id, &bytes[..len])
        }),
    )?;
    let flag = |v: &Value, k: &str, default: bool| v["attrs"][k].as_bool().unwrap_or(default);
    let size = |v: &Value, k: &str| v[k].as_u64().unwrap_or(0).max(1) as u32;
    let id = |v: &Value| v["ctx"].as_u64().unwrap_or(0) as u32;
    raea_native::register("webgl.create", "{ width: number; height: number; attrs: Record<string, unknown> }", "{ ctx: number; info: unknown }", "a WebGL 2 context on ANGLE for a canvas of this size: its id and what getParameter and getExtension answer (runtime/webgl/PROTOCOL.md)", move |v| {
        let attrs = Attrs {
            alpha: flag(v, "alpha", true),
            depth: flag(v, "depth", true),
            stencil: flag(v, "stencil", false),
            antialias: flag(v, "antialias", true),
            premultiplied_alpha: flag(v, "premultipliedAlpha", true),
            preserve_drawing_buffer: flag(v, "preserveDrawingBuffer", false),
        };
        let cx = angle::create(size(v, "width"), size(v, "height"), attrs)?;
        let info = cx.info();
        let ctx = NEXT.fetch_add(1, Ordering::Relaxed);
        CONTEXTS.with(|c| c.borrow_mut().insert(ctx, Rc::new(RefCell::new(cx))));
        Ok(json!({ "ctx": ctx, "info": info }))
    });
    raea_native::register("webgl.resize", "{ ctx: number; width: number; height: number }", "null", "a WebGL context's drawing buffer remade at a new size, cleared", move |v| {
        let cx = context(id(v))?;
        let mut cx = cx.borrow_mut();
        cx.make_current()?;
        cx.resize(size(v, "width"), size(v, "height"))?;
        Ok(Value::Null)
    });
    raea_native::register("webgl.destroy", "{ ctx: number }", "null", "a WebGL context and everything it made, freed", move |v| {
        let ctx = id(v);
        CONTEXTS.with(|c| c.borrow_mut().remove(&ctx));
        raea_sys_canvas::frames::forget(ctx);
        Ok(Value::Null)
    });
    Ok(())
}
