// A font face given to the page by URL, as an @font-face rule gives one (the `fonts.face` native call).
import { native, hasNative } from "@raea/app/native";

/** A font face for the page, as @font-face gives one: `src` a URL (staticFile, http) or the URL fetchFontData handed back. */
export function addFontFace(family: string, src: string, descriptors: { weight?: string | number; style?: string } = {}): void {
  if (!hasNative()) return;
  const url = String(src).replace(/^url\((['"]?)(.*)\1\)(\s+format\(.*\))?$/, "$2");
  native("fonts.face" as never, { family, url, weight: String(descriptors.weight ?? "400"), style: descriptors.style ?? "normal" } as never);
}
