//! A WebGL canvas's finished frames, from the JS thread that drew them (raea-runtime-webgl's snapshot) to the page
//! that shows them (raea-sys-page-ops, on a canvas's `__webgl` prop). Each is kept under its context and generation
//! until the page takes it, so a frame drawn ahead of the compositor is never shown early.

use std::collections::HashMap;
use std::sync::Mutex;

/// A canvas's pixels: RGBA8, top row first.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    /// Whether the color is already multiplied by alpha (a context with premultipliedAlpha, the default).
    pub premultiplied: bool,
    pub data: Vec<u8>,
}

static FRAMES: Mutex<Option<HashMap<(u32, u64), Frame>>> = Mutex::new(None);

/// Keeps `frame` as context `ctx`'s generation `generation`.
pub fn put(ctx: u32, generation: u64, frame: Frame) {
    FRAMES.lock().unwrap().get_or_insert_default().insert((ctx, generation), frame);
}

/// Context `ctx`'s generation `generation`, handed over; its earlier generations are dropped (nothing shows them now).
pub fn take(ctx: u32, generation: u64) -> Option<Frame> {
    let mut frames = FRAMES.lock().unwrap();
    let frames = frames.get_or_insert_default();
    frames.retain(|&(c, g), _| c != ctx || g >= generation);
    frames.remove(&(ctx, generation))
}

/// Context `ctx` is gone: its frames nobody took are dropped.
pub fn forget(ctx: u32) {
    if let Some(frames) = FRAMES.lock().unwrap().as_mut() {
        frames.retain(|&(c, _), _| c != ctx);
    }
}
