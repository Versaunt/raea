// @remotion/google-fonts/<Family>'s loadFont answered by raea: the faces its package lists (getInfo) for the style,
// weights and subsets asked, each given to the page by URL (`fonts.face`, fetched once through raea's URL cache).
// Only one subset a face: the page has no unicode-range, so each subset of a weight would be the same face to it;
// Latin is taken when it's there, as Remotion's text in our ads is.
import { addFontFace } from "./index";

type Info = { fontFamily: string; fonts: Record<string, Record<string, Record<string, string>>>; unicodeRanges?: Record<string, string> };
type Options = { weights?: string[]; subsets?: string[]; document?: unknown; ignoreTooManyRequestsWarning?: boolean };

export function googleFont(info: Info, style?: string, options?: Options) {
  const styles = style ? [style] : Object.keys(info.fonts);
  for (const s of styles) {
    const weights = info.fonts[s];
    if (!weights) throw new Error(`The font ${info.fontFamily} does not have a style ${s}`);
    for (const w of options?.weights ?? Object.keys(weights)) {
      const subsets = weights[w];
      if (!subsets) throw new Error(`The font ${info.fontFamily} does not have a weight ${w} in style ${s}`);
      const pick = (options?.subsets ?? []).find((x) => x === "latin" && subsets[x]) ?? (subsets.latin ? "latin" : (options?.subsets ?? []).find((x) => subsets[x]) ?? Object.keys(subsets)[0]);
      if (pick) addFontFace(info.fontFamily, subsets[pick], { weight: w, style: s });
    }
  }
  return { fontFamily: info.fontFamily, fonts: info.fonts, unicodeRanges: info.unicodeRanges ?? {}, waitUntilDone: () => Promise.resolve(undefined) };
}
