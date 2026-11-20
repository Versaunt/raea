// @remotion/fonts' loadFont({ family, url, weight, style }) answered by raea: the face goes to the page as an
// @font-face rule would give it (the `fonts.face` call reads the file: staticFile's /media/..., http(s), data:).
import { addFontFace } from "./face";

type FontOptions = { family: string; url: string; weight?: string | number; style?: string; format?: string; [k: string]: unknown };

export function loadFont(o: FontOptions): Promise<void> {
  if (typeof o !== "object" || o === null || typeof o.url !== "string") throw new TypeError('loadFont() needs { family, url }');
  addFontFace(o.family, o.url, { weight: o.weight, style: o.style });
  return Promise.resolve();
}
