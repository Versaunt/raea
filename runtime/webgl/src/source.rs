//! Texture sources decoded to pixels, and WebGL's unpack rules applied before GL sees them (PROTOCOL.md).

use std::cell::RefCell;
use std::collections::VecDeque;

/// The pixel-store state GL doesn't have.
#[derive(Clone, Copy, Debug)]
pub struct Unpack {
    pub flip_y: bool,
    pub premultiply: bool,
    /// UNPACK_COLORSPACE_CONVERSION_WEBGL: BROWSER_DEFAULT_WEBGL 0x9244 or NONE 0
    pub colorspace: u32,
}

impl Default for Unpack {
    fn default() -> Self {
        Unpack { flip_y: false, premultiply: false, colorspace: 0x9244 }
    }
}

/// A source's pixels: RGBA8, straight alpha, top row first.
#[derive(Clone, Debug)]
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

// formats
const ALPHA: u32 = 0x1906;
const RGB: u32 = 0x1907;
const RGBA: u32 = 0x1908;
const LUMINANCE: u32 = 0x1909;
const LUMINANCE_ALPHA: u32 = 0x190A;
const RED: u32 = 0x1903;
const RG: u32 = 0x8227;
const RED_INTEGER: u32 = 0x8D94;
const RG_INTEGER: u32 = 0x8228;
const RGB_INTEGER: u32 = 0x8D98;
const RGBA_INTEGER: u32 = 0x8D99;
const DEPTH_COMPONENT: u32 = 0x1902;
const DEPTH_STENCIL: u32 = 0x84F9;
// types
const BYTE: u32 = 0x1400;
const UNSIGNED_BYTE: u32 = 0x1401;
const SHORT: u32 = 0x1402;
const UNSIGNED_SHORT: u32 = 0x1403;
const INT: u32 = 0x1404;
const UNSIGNED_INT: u32 = 0x1405;
const FLOAT: u32 = 0x1406;
const HALF_FLOAT: u32 = 0x140B;
const UNSIGNED_SHORT_4_4_4_4: u32 = 0x8033;
const UNSIGNED_SHORT_5_5_5_1: u32 = 0x8034;
const UNSIGNED_SHORT_5_6_5: u32 = 0x8363;
const UNSIGNED_INT_2_10_10_10_REV: u32 = 0x8368;
const UNSIGNED_INT_24_8: u32 = 0x84FA;
const UNSIGNED_INT_10F_11F_11F_REV: u32 = 0x8C3B;
const UNSIGNED_INT_5_9_9_9_REV: u32 = 0x8C3E;
const FLOAT_32_UNSIGNED_INT_24_8_REV: u32 = 0x8DAD;

/// Decoded images by URL, the newest last.
const KEEP: usize = 64;
thread_local! {
    static IMAGES: RefCell<VecDeque<(String, Pixels)>> = const { RefCell::new(VecDeque::new()) };
}

/// A DOM texture source's pixels. kind 1: an image by URL (file://..., data:..., http(s)://, or a plain path), decoded
/// and cached by URL. kind 2: a 2D canvas, `reference` is the JSON {uid, width, height, __canvas2d} that the native
/// call canvas.read takes. (kind 3 is handled by the caller.)
pub fn load(kind: u32, reference: &str) -> Result<Pixels, String> {
    match kind {
        1 => {
            if let Some(px) = IMAGES.with(|c| c.borrow().iter().find(|(u, _)| u == reference).map(|(_, p)| p.clone())) {
                return Ok(px);
            }
            let px = decode(reference)?;
            IMAGES.with(|c| {
                let mut c = c.borrow_mut();
                c.push_back((reference.to_string(), px.clone()));
                while c.len() > KEEP {
                    c.pop_front();
                }
            });
            Ok(px)
        }
        2 => {
            let args: serde_json::Value = serde_json::from_str(reference).map_err(|e| format!("WebGL: a 2D canvas source that isn't JSON: {e}"))?;
            let (width, height, data) = raea_sys_canvas::pixels(&args)?;
            Ok(Pixels { width, height, data })
        }
        _ => Err(format!("WebGL: no texture source of kind {kind}")),
    }
}

/// An image file decoded as Chrome hands it to WebGL: straight-alpha RGBA8 in the file's own sRGB values. Embedded
/// ICC profiles are ignored (UNPACK_COLORSPACE_CONVERSION only differs from NONE for those), and so is a JPEG's EXIF
/// orientation.
fn decode(url: &str) -> Result<Pixels, String> {
    use bevy::asset::RenderAssetUsages;
    use bevy::image::{CompressedImageFormats, Image, ImageSampler, ImageType};
    use bevy::render::render_resource::TextureFormat;
    let (mime, bytes) = if url.starts_with("data:") {
        raea_io_net::data_url(url).ok_or_else(|| format!("WebGL: an image data: URL that doesn't read: {}", short(url)))?
    } else {
        let bytes = if url.starts_with("http://") || url.starts_with("https://") {
            raea_io_net::cache::read(url).map_err(|e| format!("WebGL: image {url}: {e}"))?
        } else {
            let path = url.strip_prefix("file://").unwrap_or(url);
            std::fs::read(path).map_err(|e| format!("WebGL: image {path}: {e}"))?
        };
        let mime = raea_sys_canvas::image_mime(&bytes, url).ok_or_else(|| format!("WebGL: image {url}: not an image raea decodes"))?;
        (mime.to_string(), bytes)
    };
    if mime == "image/svg+xml" {
        let opt = raea_sys_canvas::page_options();
        let size = raea_sys_canvas::svg::natural_size(&bytes, &opt).ok_or_else(|| format!("WebGL: svg image {} doesn't parse", short(url)))?;
        let (width, height) = (size.x.round().max(1.0) as u32, size.y.round().max(1.0) as u32);
        let doc = std::str::from_utf8(&bytes).map_err(|_| format!("WebGL: svg image {} isn't UTF-8", short(url)))?;
        let data = raea_sys_canvas::svg::raster_with(doc, bevy::math::UVec2::new(width, height), &opt).ok_or_else(|| format!("WebGL: svg image {} doesn't draw", short(url)))?;
        return Ok(Pixels { width, height, data });
    }
    let img = Image::from_buffer(&bytes, ImageType::MimeType(&mime), CompressedImageFormats::NONE, true, ImageSampler::Default, RenderAssetUsages::RENDER_WORLD)
        .map_err(|e| format!("WebGL: image {}: {e}", short(url)))?;
    let img = img.convert(TextureFormat::Rgba8UnormSrgb).ok_or_else(|| format!("WebGL: image {}: no RGBA8 conversion", short(url)))?;
    let (width, height) = (img.width(), img.height());
    let data = img.data.ok_or_else(|| format!("WebGL: image {} decoded to nothing", short(url)))?;
    Ok(Pixels { width, height, data })
}

/// A URL for an error message: a data: URL cut short.
fn short(url: &str) -> &str {
    &url[..url.char_indices().nth(64).map_or(url.len(), |(i, _)| i)]
}

/// The bytes glTexImage2D/glTexSubImage2D take for `px` under WebGL's rules: tightly packed (alignment 1), first row =
/// the source's top row unless unpack.flip_y (then its bottom row first), color multiplied by alpha when
/// unpack.premultiply, converted to `format`/`ty`.
pub fn for_upload(px: &Pixels, unpack: &Unpack, format: u32, ty: u32) -> Result<Vec<u8>, String> {
    let (w, h) = (px.width as usize, px.height as usize);
    if w.checked_mul(h).and_then(|n| n.checked_mul(4)) != Some(px.data.len()) {
        return Err(format!("WebGL: a {w}x{h} source with {} bytes", px.data.len()));
    }
    let emit: fn(&mut Vec<u8>, [u8; 4]) = match (format, ty) {
        (RGBA | RGBA_INTEGER, UNSIGNED_BYTE) => |o, c| o.extend_from_slice(&c),
        (RGB | RGB_INTEGER, UNSIGNED_BYTE) => |o, c| o.extend_from_slice(&c[..3]),
        (RG | RG_INTEGER, UNSIGNED_BYTE) => |o, c| o.extend_from_slice(&c[..2]),
        (RED | RED_INTEGER | LUMINANCE, UNSIGNED_BYTE) => |o, c| o.push(c[0]),
        (LUMINANCE_ALPHA, UNSIGNED_BYTE) => |o, c| o.extend_from_slice(&[c[0], c[3]]),
        (ALPHA, UNSIGNED_BYTE) => |o, c| o.push(c[3]),
        (RGB, UNSIGNED_SHORT_5_6_5) => |o, c| {
            let v = (c[0] as u16 >> 3) << 11 | (c[1] as u16 >> 2) << 5 | c[2] as u16 >> 3;
            o.extend_from_slice(&v.to_le_bytes())
        },
        (RGBA, UNSIGNED_SHORT_4_4_4_4) => |o, c| {
            let v = (c[0] as u16 >> 4) << 12 | (c[1] as u16 >> 4) << 8 | (c[2] as u16 >> 4) << 4 | c[3] as u16 >> 4;
            o.extend_from_slice(&v.to_le_bytes())
        },
        (RGBA, UNSIGNED_SHORT_5_5_5_1) => |o, c| {
            let v = (c[0] as u16 >> 3) << 11 | (c[1] as u16 >> 3) << 6 | (c[2] as u16 >> 3) << 1 | c[3] as u16 >> 7;
            o.extend_from_slice(&v.to_le_bytes())
        },
        // floats: the normalized value, multiplied by alpha in float when premultiplying (as Chrome does), no sRGB
        // decoding (an SRGB8_ALPHA8 internal format makes GL decode)
        (RGBA | RGB | RG | RED, FLOAT | HALF_FLOAT) => return floats(px, unpack, channels(format), ty == HALF_FLOAT),
        _ => return Err(format!("WebGL: a DOM source can't be uploaded as format 0x{format:X} type 0x{ty:X}")),
    };
    let row = |y: usize| {
        let y = if unpack.flip_y { h - 1 - y } else { y };
        &px.data[y * w * 4..(y + 1) * w * 4]
    };
    if matches!((format, ty), (RGBA | RGBA_INTEGER, UNSIGNED_BYTE)) && !unpack.premultiply {
        if !unpack.flip_y {
            return Ok(px.data.clone());
        }
        let mut out = Vec::with_capacity(px.data.len());
        (0..h).for_each(|y| out.extend_from_slice(row(y)));
        return Ok(out);
    }
    let mut out = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for c in row(y).chunks_exact(4) {
            let a = c[3];
            let c = if unpack.premultiply { [mul8(c[0], a), mul8(c[1], a), mul8(c[2], a), a] } else { [c[0], c[1], c[2], a] };
            emit(&mut out, c);
        }
    }
    Ok(out)
}

/// Components a format has (the unpacked ones).
fn channels(format: u32) -> usize {
    match format {
        RGBA | RGBA_INTEGER => 4,
        RGB | RGB_INTEGER => 3,
        RG | RG_INTEGER | LUMINANCE_ALPHA => 2,
        _ => 1,
    }
}

/// `px` as `n` float or half-float components a pixel.
fn floats(px: &Pixels, unpack: &Unpack, n: usize, half: bool) -> Result<Vec<u8>, String> {
    let (w, h) = (px.width as usize, px.height as usize);
    let size = [w, h, n, if half { 2 } else { 4 }].into_iter().try_fold(1usize, usize::checked_mul);
    let mut out = Vec::with_capacity(size.ok_or_else(|| format!("WebGL: a {w}x{h} float upload's size overflows"))?);
    for y in 0..h {
        let sy = if unpack.flip_y { h - 1 - y } else { y };
        for c in px.data[sy * w * 4..(sy + 1) * w * 4].chunks_exact(4) {
            let a = c[3] as f32 / 255.0;
            for (i, &v) in c[..n].iter().enumerate() {
                let mut f = v as f32 / 255.0;
                if unpack.premultiply && i < 3 {
                    f *= a;
                }
                if half {
                    out.extend_from_slice(&to_half(f).to_le_bytes());
                } else {
                    out.extend_from_slice(&f.to_le_bytes());
                }
            }
        }
    }
    Ok(out)
}

/// `c` times `a`, 8-bit, rounded as Skia rounds.
fn mul8(c: u8, a: u8) -> u8 {
    ((c as u32 * a as u32 + 127) / 255) as u8
}

/// Bytes a pixel of `format`/`ty` takes (the ES 3.0 table), None for a pair GL doesn't take.
fn pixel_bytes(format: u32, ty: u32) -> Option<usize> {
    let size = match ty {
        BYTE | UNSIGNED_BYTE => 1,
        SHORT | UNSIGNED_SHORT | HALF_FLOAT => 2,
        INT | UNSIGNED_INT | FLOAT => 4,
        UNSIGNED_SHORT_4_4_4_4 | UNSIGNED_SHORT_5_5_5_1 | UNSIGNED_SHORT_5_6_5 => return Some(2),
        UNSIGNED_INT_2_10_10_10_REV | UNSIGNED_INT_24_8 | UNSIGNED_INT_10F_11F_11F_REV | UNSIGNED_INT_5_9_9_9_REV => return Some(4),
        FLOAT_32_UNSIGNED_INT_24_8_REV => return Some(8),
        _ => return None,
    };
    let n = match format {
        RGBA | RGBA_INTEGER => 4,
        RGB | RGB_INTEGER => 3,
        RG | RG_INTEGER | LUMINANCE_ALPHA => 2,
        RED | RED_INTEGER | ALPHA | LUMINANCE | DEPTH_COMPONENT | DEPTH_STENCIL => 1,
        _ => return None,
    };
    Some(n * size)
}

/// FLIP_Y and PREMULTIPLY applied to a typed-array upload: the `width` x `height` rectangle the UNPACK layout selects
/// (rows of `row_length` pixels, 0 = width, padded to `alignment`, starting `skip_rows` rows and `skip_pixels` pixels
/// in) cut out, flipped and premultiplied, and returned tightly packed (alignment 1, no row length or skips). None when
/// neither flag changes anything or the array is too short for the layout (upload as is: a short array is GL's own
/// error). An error when the layout's size overflows.
#[allow(clippy::too_many_arguments)]
pub fn flip_premultiply(
    bytes: &[u8],
    width: u32,
    height: u32,
    format: u32,
    ty: u32,
    unpack: &Unpack,
    alignment: u32,
    row_length: u32,
    skip_pixels: u32,
    skip_rows: u32,
) -> Result<Option<Vec<u8>>, String> {
    let premultiply: Option<fn(&mut [u8])> = match (unpack.premultiply, format, ty) {
        (false, ..) => None,
        (true, RGBA, UNSIGNED_BYTE) => Some(|r| r.chunks_exact_mut(4).for_each(|p| (0..3).for_each(|i| p[i] = mul8(p[i], p[3])))),
        (true, LUMINANCE_ALPHA, UNSIGNED_BYTE) => Some(|r| r.chunks_exact_mut(2).for_each(|p| p[0] = mul8(p[0], p[1]))),
        (true, RGBA, UNSIGNED_SHORT_4_4_4_4) => Some(|r| {
            for p in r.chunks_exact_mut(2) {
                let v = u16::from_le_bytes([p[0], p[1]]);
                let a = v & 0xF;
                let m = |s: u16| ((v >> s & 0xF) * a + 7) / 15;
                p.copy_from_slice(&(m(12) << 12 | m(8) << 8 | m(4) << 4 | a).to_le_bytes());
            }
        }),
        (true, RGBA, UNSIGNED_SHORT_5_5_5_1) => Some(|r| {
            for p in r.chunks_exact_mut(2) {
                if p[0] & 1 == 0 {
                    p.copy_from_slice(&[0, 0]);
                }
            }
        }),
        (true, RGBA, FLOAT) => Some(|r| {
            for p in r.chunks_exact_mut(16) {
                let f = |i: usize| f32::from_le_bytes(p[i * 4..i * 4 + 4].try_into().unwrap());
                let a = f(3);
                let v = [f(0) * a, f(1) * a, f(2) * a];
                for (i, v) in v.iter().enumerate() {
                    p[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
                }
            }
        }),
        (true, RGBA, HALF_FLOAT) => Some(|r| {
            for p in r.chunks_exact_mut(8) {
                let f = |i: usize| from_half(u16::from_le_bytes([p[i * 2], p[i * 2 + 1]]));
                let a = f(3);
                let v = [f(0) * a, f(1) * a, f(2) * a];
                for (i, v) in v.iter().enumerate() {
                    p[i * 2..i * 2 + 2].copy_from_slice(&to_half(*v).to_le_bytes());
                }
            }
        }),
        (true, ..) => None,
    };
    if !unpack.flip_y && premultiply.is_none() {
        return Ok(None);
    }
    let Some(bpp) = pixel_bytes(format, ty) else { return Ok(None) };
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return Ok(None);
    }
    let over = || format!("WebGL: a {w}x{h} upload's size under the UNPACK state overflows");
    let align = alignment.max(1) as usize;
    let row = w.checked_mul(bpp).ok_or_else(over)?;
    let stride = (if row_length > 0 { row_length as usize } else { w }).checked_mul(bpp).and_then(|n| n.div_ceil(align).checked_mul(align));
    let stride = stride.ok_or_else(over)?;
    // where row y of the rectangle starts
    let start = |y: usize| (skip_rows as usize).checked_add(y)?.checked_mul(stride)?.checked_add((skip_pixels as usize).checked_mul(bpp)?);
    let end = start(h - 1).and_then(|s| s.checked_add(row)).ok_or_else(over)?;
    if bytes.len() < end {
        return Ok(None);
    }
    let mut out = Vec::with_capacity(row.checked_mul(h).ok_or_else(over)?);
    for y in 0..h {
        // every start is at most the last row's, which didn't overflow
        let s = start(if unpack.flip_y { h - 1 - y } else { y }).unwrap();
        out.extend_from_slice(&bytes[s..s + row]);
    }
    if let Some(f) = premultiply {
        out.chunks_exact_mut(row).for_each(f);
    }
    Ok(Some(out))
}

/// An f32 as IEEE half, rounded to nearest even.
fn to_half(v: f32) -> u16 {
    let x = v.to_bits();
    let sign = (x >> 16 & 0x8000) as u16;
    let exp = (x >> 23 & 0xFF) as i32;
    let man = x & 0x7F_FFFF;
    if exp == 0xFF {
        return sign | 0x7C00 | if man != 0 { 0x200 } else { 0 };
    }
    let e = exp - 112;
    if e >= 0x1F {
        return sign | 0x7C00;
    }
    let (r, rem, half) = if e <= 0 {
        if e < -10 {
            return sign;
        }
        let m = man | 0x80_0000;
        let shift = (14 - e) as u32;
        (m >> shift, m & ((1 << shift) - 1), 1 << (shift - 1))
    } else {
        ((e as u32) << 10 | man >> 13, man & 0x1FFF, 0x1000)
    };
    let r = if rem > half || (rem == half && r & 1 == 1) { r + 1 } else { r };
    sign | r as u16
}

/// An IEEE half as f32.
fn from_half(h: u16) -> f32 {
    let sign = (h as u32 & 0x8000) << 16;
    let (e, m) = ((h >> 10 & 0x1F) as u32, (h & 0x3FF) as u32);
    match e {
        0 => (if sign != 0 { -1.0 } else { 1.0 }) * m as f32 * (2f32).powi(-24),
        31 => f32::from_bits(sign | 0x7F80_0000 | m << 13),
        _ => f32::from_bits(sign | (e + 112) << 23 | m << 13),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2x2: red opaque, green at alpha 128; blue at alpha 64, white opaque. Top row first.
    fn img() -> Pixels {
        Pixels { width: 2, height: 2, data: vec![255, 0, 0, 255, 0, 200, 0, 128, 0, 0, 100, 64, 255, 255, 255, 255] }
    }
    const PLAIN: Unpack = Unpack { flip_y: false, premultiply: false, colorspace: 0x9244 };
    const FLIP: Unpack = Unpack { flip_y: true, premultiply: false, colorspace: 0x9244 };
    const PREMUL: Unpack = Unpack { flip_y: false, premultiply: true, colorspace: 0x9244 };
    const BOTH: Unpack = Unpack { flip_y: true, premultiply: true, colorspace: 0 };

    #[test]
    fn rgba_bytes_plain_flipped_premultiplied() {
        let px = img();
        assert_eq!(for_upload(&px, &PLAIN, RGBA, UNSIGNED_BYTE).unwrap(), px.data);
        assert_eq!(for_upload(&px, &FLIP, RGBA, UNSIGNED_BYTE).unwrap(), [0, 0, 100, 64, 255, 255, 255, 255, 255, 0, 0, 255, 0, 200, 0, 128]);
        // 200 * 128 / 255 = 100.4 -> 100; 100 * 64 / 255 = 25.1 -> 25
        assert_eq!(for_upload(&px, &PREMUL, RGBA, UNSIGNED_BYTE).unwrap(), [255, 0, 0, 255, 0, 100, 0, 128, 0, 0, 25, 64, 255, 255, 255, 255]);
        assert_eq!(for_upload(&px, &PREMUL, RGBA_INTEGER, UNSIGNED_BYTE).unwrap()[5], 100);
        assert_eq!(for_upload(&px, &BOTH, RGBA, UNSIGNED_BYTE).unwrap()[..8], [0, 0, 25, 64, 255, 255, 255, 255]);
    }

    #[test]
    fn byte_formats() {
        let px = img();
        assert_eq!(for_upload(&px, &PLAIN, RGB, UNSIGNED_BYTE).unwrap(), [255, 0, 0, 0, 200, 0, 0, 0, 100, 255, 255, 255]);
        assert_eq!(for_upload(&px, &PLAIN, RGB_INTEGER, UNSIGNED_BYTE).unwrap().len(), 12);
        assert_eq!(for_upload(&px, &PLAIN, RG, UNSIGNED_BYTE).unwrap(), [255, 0, 0, 200, 0, 0, 255, 255]);
        assert_eq!(for_upload(&px, &PLAIN, RG_INTEGER, UNSIGNED_BYTE).unwrap().len(), 8);
        assert_eq!(for_upload(&px, &PLAIN, RED, UNSIGNED_BYTE).unwrap(), [255, 0, 0, 255]);
        assert_eq!(for_upload(&px, &PLAIN, RED_INTEGER, UNSIGNED_BYTE).unwrap(), [255, 0, 0, 255]);
        assert_eq!(for_upload(&px, &FLIP, LUMINANCE, UNSIGNED_BYTE).unwrap(), [0, 255, 255, 0]);
        assert_eq!(for_upload(&px, &PLAIN, LUMINANCE_ALPHA, UNSIGNED_BYTE).unwrap(), [255, 255, 0, 128, 0, 64, 255, 255]);
        assert_eq!(for_upload(&px, &PLAIN, ALPHA, UNSIGNED_BYTE).unwrap(), [255, 128, 64, 255]);
        // premultiplied, then the color channels taken
        assert_eq!(for_upload(&px, &PREMUL, RGB, UNSIGNED_BYTE).unwrap()[3..9], [0, 100, 0, 0, 0, 25]);
        assert_eq!(for_upload(&px, &BOTH, LUMINANCE_ALPHA, UNSIGNED_BYTE).unwrap()[..2], [0, 64]);
    }

    #[test]
    fn packed_formats() {
        let px = img();
        let u16s = |v: Vec<u8>| v.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>();
        assert_eq!(u16s(for_upload(&px, &PLAIN, RGB, UNSIGNED_SHORT_5_6_5).unwrap()), [0xF800, (200 >> 2) << 5, 100 >> 3, 0xFFFF]);
        assert_eq!(u16s(for_upload(&px, &PLAIN, RGBA, UNSIGNED_SHORT_4_4_4_4).unwrap()), [0xF00F, 0x0C08, 0x0064, 0xFFFF]);
        assert_eq!(u16s(for_upload(&px, &PLAIN, RGBA, UNSIGNED_SHORT_5_5_5_1).unwrap()), [0xF801, (200 >> 3) << 6 | 1, (100 >> 3) << 1, 0xFFFF]);
        assert_eq!(u16s(for_upload(&px, &PREMUL, RGBA, UNSIGNED_SHORT_4_4_4_4).unwrap())[1], 0x0608);
        assert_eq!(u16s(for_upload(&px, &FLIP, RGB, UNSIGNED_SHORT_5_6_5).unwrap())[3], (200 >> 2) << 5);
    }

    #[test]
    fn float_formats() {
        let px = img();
        let f32s = |v: Vec<u8>| v.chunks(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect::<Vec<_>>();
        let f = f32s(for_upload(&px, &PLAIN, RGBA, FLOAT).unwrap());
        assert_eq!(f.len(), 16);
        assert_eq!(&f[..4], &[1.0, 0.0, 0.0, 1.0]);
        assert!((f[5] - 200.0 / 255.0).abs() < 1e-6 && (f[7] - 128.0 / 255.0).abs() < 1e-6);
        let p = f32s(for_upload(&px, &PREMUL, RGBA, FLOAT).unwrap());
        assert!((p[5] - 200.0 / 255.0 * 128.0 / 255.0).abs() < 1e-6 && (p[7] - 128.0 / 255.0).abs() < 1e-6);
        assert_eq!(f32s(for_upload(&px, &FLIP, RED, FLOAT).unwrap()), [0.0, 1.0, 1.0, 0.0]);
        assert_eq!(f32s(for_upload(&px, &PLAIN, RG, FLOAT).unwrap()).len(), 8);
        assert_eq!(f32s(for_upload(&px, &PLAIN, RGB, FLOAT).unwrap()).len(), 12);
        let halves = |v: Vec<u8>| v.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>();
        let hf = halves(for_upload(&px, &PLAIN, RGBA, HALF_FLOAT).unwrap());
        assert_eq!(&hf[..4], &[0x3C00, 0, 0, 0x3C00]);
        assert!((from_half(hf[5]) - 200.0 / 255.0).abs() < 1e-3);
        assert_eq!(halves(for_upload(&px, &PLAIN, RED, HALF_FLOAT).unwrap()), [0x3C00, 0, 0, 0x3C00]);
        assert_eq!(for_upload(&px, &PLAIN, RGB, HALF_FLOAT).unwrap().len(), 24);
        assert_eq!(for_upload(&px, &PLAIN, RG, HALF_FLOAT).unwrap().len(), 16);
    }

    #[test]
    fn other_pairs_are_refused() {
        let e = for_upload(&img(), &PLAIN, RGBA, UNSIGNED_SHORT_5_6_5).unwrap_err();
        assert!(e.contains("0x1908") && e.contains("0x8363"), "{e}");
        assert!(for_upload(&img(), &PLAIN, LUMINANCE, FLOAT).is_err());
    }

    #[test]
    fn halves_round_trip() {
        for v in [0.0f32, 1.0, 0.5, 0.25, 1.0 / 3.0, 65504.0, 1e-5, 6.1e-5] {
            assert!((from_half(to_half(v)) - v).abs() <= v * 1e-3 + 6e-8, "{v}");
        }
        assert_eq!(to_half(1.0), 0x3C00);
        assert_eq!(to_half(-2.0), 0xC000);
        assert_eq!(to_half(1e9), 0x7C00);
    }

    #[test]
    fn typed_arrays_flipped_with_padded_rows() {
        // RGB 3x2 at alignment 4: rows of 9 bytes padded to 12; the last row needs no padding
        let mut bytes: Vec<u8> = (1..=9).collect();
        bytes.extend([0xEE; 3]);
        bytes.extend(11..=19);
        assert_eq!(fp(&bytes, 3, 2, RGB, UNSIGNED_BYTE, &PLAIN, 4, 0), None);
        // flipped and tightly packed: 9-byte rows
        let out = fp(&bytes, 3, 2, RGB, UNSIGNED_BYTE, &FLIP, 4, 0).unwrap();
        assert_eq!(out.len(), 18);
        assert_eq!(&out[..9], (11..=19).collect::<Vec<u8>>().as_slice());
        assert_eq!(&out[9..], (1..=9).collect::<Vec<u8>>().as_slice());
        // RGB has no alpha: premultiply alone leaves it as is
        assert_eq!(fp(&bytes, 3, 2, RGB, UNSIGNED_BYTE, &PREMUL, 4, 0), None);
        // too short for its layout: GL's error, not ours
        assert_eq!(fp(&bytes[..20], 3, 2, RGB, UNSIGNED_BYTE, &FLIP, 4, 0), None);
        // row_length 4 at alignment 1: 12-byte rows, 3 pixels used
        let rl: Vec<u8> = (0..24).collect();
        let out = fp(&rl, 3, 2, RGB, UNSIGNED_BYTE, &FLIP, 1, 4).unwrap();
        assert_eq!(&out[..9], &rl[12..21]);
        assert_eq!(&out[9..], &rl[..9]);
    }

    /// flip_premultiply with no skips, unwrapped.
    #[allow(clippy::too_many_arguments)]
    fn fp(bytes: &[u8], w: u32, h: u32, format: u32, ty: u32, unpack: &Unpack, alignment: u32, row_length: u32) -> Option<Vec<u8>> {
        flip_premultiply(bytes, w, h, format, ty, unpack, alignment, row_length, 0, 0).unwrap()
    }

    #[test]
    fn typed_arrays_skips_select_the_rectangle() {
        // a 4x3 RGBA image, pixel (x, y) = [x, y, 9, 255] except alpha 0 at (2, 1); a 2x2 rectangle from (1, 1)
        let mut img = Vec::new();
        for y in 0..3u8 {
            for x in 0..4u8 {
                img.extend([x, y, 9, if (x, y) == (2, 1) { 0 } else { 255 }]);
            }
        }
        let out = flip_premultiply(&img, 2, 2, RGBA, UNSIGNED_BYTE, &FLIP, 4, 4, 1, 1).unwrap().unwrap();
        // the rectangle's rows 2 then 1, tightly packed
        assert_eq!(out, [1, 2, 9, 255, 2, 2, 9, 255, 1, 1, 9, 255, 2, 1, 9, 0]);
        let out = flip_premultiply(&img, 2, 2, RGBA, UNSIGNED_BYTE, &BOTH, 4, 4, 1, 1).unwrap().unwrap();
        assert_eq!(&out[8..], [1, 1, 9, 255, 0, 0, 0, 0]);
        // RGB rows padded to 4 with a skip: 2 pixels of 3 bytes from pixel 1 of row 1, 8-byte stride (row_length 2)
        let rgb: Vec<u8> = (0..24).collect();
        let out = flip_premultiply(&rgb, 1, 2, RGB, UNSIGNED_BYTE, &FLIP, 4, 2, 1, 1).unwrap().unwrap();
        assert_eq!(out, [19, 20, 21, 11, 12, 13]);
        // the selection running past the array is GL's error; sizes past usize are ours
        assert_eq!(flip_premultiply(&img, 2, 2, RGBA, UNSIGNED_BYTE, &FLIP, 4, 4, 3, 1).unwrap(), None);
        assert!(flip_premultiply(&img, 2, 2, RGBA, UNSIGNED_BYTE, &FLIP, 4, u32::MAX, 0, u32::MAX).is_err());
    }

    #[test]
    fn typed_arrays_premultiplied() {
        let rgba = [200u8, 100, 50, 128, 10, 20, 30, 255];
        assert_eq!(fp(&rgba, 2, 1, RGBA, UNSIGNED_BYTE, &PREMUL, 4, 0).unwrap(), [100, 50, 25, 128, 10, 20, 30, 255]);
        assert_eq!(fp(&[200, 128, 7, 0], 2, 1, LUMINANCE_ALPHA, UNSIGNED_BYTE, &PREMUL, 4, 0).unwrap(), [100, 128, 0, 0]);
        let s = |v: &[u16]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
        assert_eq!(fp(&s(&[0xFFF5]), 1, 1, RGBA, UNSIGNED_SHORT_4_4_4_4, &PREMUL, 4, 0).unwrap(), s(&[0x5555]));
        assert_eq!(fp(&s(&[0xFFFE, 0xFFFF]), 2, 1, RGBA, UNSIGNED_SHORT_5_5_5_1, &PREMUL, 4, 0).unwrap(), s(&[0, 0xFFFF]));
        let f: Vec<u8> = [0.8f32, 0.4, 1.0, 0.5].iter().flat_map(|v| v.to_le_bytes()).collect();
        let out = fp(&f, 1, 1, RGBA, FLOAT, &PREMUL, 4, 0).unwrap();
        assert_eq!(out, [0.4f32, 0.2, 0.5, 0.5].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>());
        let hf = s(&[to_half(0.8), to_half(1.0), 0, to_half(0.5)]);
        let out = fp(&hf, 1, 1, RGBA, HALF_FLOAT, &PREMUL, 4, 0).unwrap();
        assert_eq!(out, s(&[to_half(0.4), to_half(0.5), 0, to_half(0.5)]));
        // flipped and premultiplied: 2 rows of 1 RGBA pixel
        assert_eq!(fp(&[255, 255, 255, 0, 10, 20, 30, 255], 1, 2, RGBA, UNSIGNED_BYTE, &BOTH, 4, 0).unwrap(), [10, 20, 30, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn bytes_per_pixel() {
        assert_eq!(pixel_bytes(RGBA, FLOAT), Some(16));
        assert_eq!(pixel_bytes(RG_INTEGER, SHORT), Some(4));
        assert_eq!(pixel_bytes(RGB, HALF_FLOAT), Some(6));
        assert_eq!(pixel_bytes(RGBA_INTEGER, UNSIGNED_INT), Some(16));
        assert_eq!(pixel_bytes(RGBA, UNSIGNED_INT_2_10_10_10_REV), Some(4));
        assert_eq!(pixel_bytes(RGB, UNSIGNED_INT_10F_11F_11F_REV), Some(4));
        assert_eq!(pixel_bytes(RGB, UNSIGNED_INT_5_9_9_9_REV), Some(4));
        assert_eq!(pixel_bytes(DEPTH_STENCIL, UNSIGNED_INT_24_8), Some(4));
        assert_eq!(pixel_bytes(DEPTH_STENCIL, FLOAT_32_UNSIGNED_INT_24_8_REV), Some(8));
        assert_eq!(pixel_bytes(DEPTH_COMPONENT, UNSIGNED_SHORT), Some(2));
        assert_eq!(pixel_bytes(RED, BYTE), Some(1));
        assert_eq!(pixel_bytes(RED, INT), Some(4));
        // RG32F 4x2 flipped: 32-byte rows swapped
        let b: Vec<u8> = (0..64).collect();
        let out = fp(&b, 4, 2, RG, FLOAT, &FLIP, 4, 0).unwrap();
        assert_eq!(&out[..32], &b[32..]);
        assert_eq!(&out[32..], &b[..32]);
    }

    /// A PNG of RGBA8 pixels, its deflate stream stored (uncompressed).
    fn png(w: u32, rgba: &[u8]) -> Vec<u8> {
        fn crc(data: &[u8]) -> u32 {
            let mut c = !0u32;
            for &b in data {
                c ^= b as u32;
                for _ in 0..8 {
                    c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
                }
            }
            !c
        }
        fn chunk(out: &mut Vec<u8>, kind: &[u8], data: &[u8]) {
            out.extend((data.len() as u32).to_be_bytes());
            let mut body = kind.to_vec();
            body.extend(data);
            out.extend(&body);
            out.extend(crc(&body).to_be_bytes());
        }
        let mut raw = Vec::new();
        for row in rgba.chunks(w as usize * 4) {
            raw.push(0);
            raw.extend(row);
        }
        let (mut a, mut b) = (1u32, 0u32);
        for &x in &raw {
            a = (a + x as u32) % 65521;
            b = (b + a) % 65521;
        }
        let mut z = vec![0x78, 0x01, 1];
        z.extend((raw.len() as u16).to_le_bytes());
        z.extend((!(raw.len() as u16)).to_le_bytes());
        z.extend(&raw);
        z.extend((b << 16 | a).to_be_bytes());
        let h = (rgba.len() / (w as usize * 4)) as u32;
        let mut ihdr = Vec::new();
        ihdr.extend(w.to_be_bytes());
        ihdr.extend(h.to_be_bytes());
        ihdr.extend([8, 6, 0, 0, 0]);
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        chunk(&mut out, b"IHDR", &ihdr);
        chunk(&mut out, b"IDAT", &z);
        chunk(&mut out, b"IEND", &[]);
        out
    }

    #[test]
    fn images_from_a_file_and_a_data_url() {
        let px = img();
        let bytes = png(2, &px.data);
        let path = std::env::temp_dir().join(format!("raea-webgl-source-{}.png", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let url = format!("file://{}", path.display());
        let got = load(1, &url).unwrap();
        assert_eq!((got.width, got.height), (2, 2));
        assert_eq!(got.data, px.data, "straight alpha, top row first");
        // cached by URL: read again after the file is gone
        std::fs::remove_file(&path).unwrap();
        assert_eq!(load(1, &url).unwrap().data, px.data);
        assert!(load(1, "/nonexistent/raea-webgl.png").is_err());

        const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut enc = String::new();
        for c in bytes.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            for i in 0..4 {
                enc.push(if i <= c.len() { B64[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
            }
        }
        let got = load(1, &format!("data:image/png;base64,{enc}")).unwrap();
        assert_eq!(got.data, px.data);

        let svg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='3'%3E%3Crect width='4' height='3' fill='%23ff0000'/%3E%3C/svg%3E";
        let got = load(1, svg).unwrap();
        assert_eq!((got.width, got.height), (4, 3));
        assert_eq!(&got.data[..4], &[255, 0, 0, 255]);
    }

    #[test]
    fn a_2d_canvas() {
        // what sdk/ui/src/canvas/context.ts sends for fillRect(0, 0, 2, 1) in red on a 2x2 canvas
        let st = serde_json::json!({"ts": [1, 0, 0, 1, 0, 0], "alpha": 1, "comp": "source-over", "clip": [], "shadow": null});
        let rect = serde_json::json!([0, 0, 0, 1, 2, 0, 1, 2, 1, 1, 0, 1, 4]);
        let canvas = serde_json::json!({"uid": 990_001, "width": 2, "height": 2, "__canvas2d": {"gen": 1, "ops": [["fill", rect, "nonzero", [255, 0, 0, 1], st]]}});
        let got = load(2, &canvas.to_string()).unwrap();
        assert_eq!((got.width, got.height), (2, 2));
        assert_eq!(got.data, [255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
        let flipped = for_upload(&got, &FLIP, RGBA, UNSIGNED_BYTE).unwrap();
        assert_eq!(&flipped[8..], &[255, 0, 0, 255, 255, 0, 0, 255]);
        let blank = load(2, r#"{"width": 3, "height": 1}"#).unwrap();
        assert_eq!(blank.data, [0; 12]);
        assert!(load(2, "not json").is_err());
    }
}
