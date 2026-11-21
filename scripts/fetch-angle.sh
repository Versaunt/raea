#!/usr/bin/env bash
# ANGLE for WebGL (runtime/webgl/PROTOCOL.md "ANGLE"): libEGL and libGLESv2, and on Linux SwiftShader's Vulkan beside
# them, taken from a pinned Chrome for Testing build into vendor/angle/<platform>, where raea looks for them.
#
#   scripts/fetch-angle.sh            # nothing to do when vendor/angle/<platform> already has them
#   scripts/fetch-angle.sh --force    # fetch again
#
# The zip (about 170 MB) is checked against its pinned sha256 and deleted after. These versions are pinned because
# newer Chrome for Testing builds (152+ on mac, 152+ on linux) link ANGLE statically and ship only 230 KB stubs of
# libEGL and libGLESv2.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
case "$(uname -s)-$(uname -m)" in
Linux-x86_64)
	platform=linux-x64
	url=https://storage.googleapis.com/chrome-for-testing-public/140.0.7339.80/linux64/chrome-linux64.zip
	pinned=7184052e2155f270dd49503b1c9c7163204f3a7bc0fba9bd9e746dde04eb0546
	files=(libEGL.so libGLESv2.so libvk_swiftshader.so vk_swiftshader_icd.json libvulkan.so.1)
	inside() { echo "chrome-linux64/$1"; }
	;;
Darwin-arm64)
	platform=mac-arm64
	url=https://storage.googleapis.com/chrome-for-testing-public/150.0.7871.250/mac-arm64/chrome-mac-arm64.zip
	pinned=TODO_PIN_ON_MAC
	files=(libEGL.dylib libGLESv2.dylib)
	inside() { echo "chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/*/Libraries/$1"; }
	;;
*)
	echo "fetch-angle: no ANGLE build pinned for $(uname -s) $(uname -m)" >&2
	exit 1
	;;
esac

dest="$root/vendor/angle/$platform"
if [[ "${1:-}" != --force && -f "$dest/${files[0]}" && -f "$dest/${files[1]}" ]]; then
	echo "fetch-angle: $dest already has ANGLE (--force to fetch again)"
	exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "fetch-angle: $url"
curl -fL --retry 3 -o "$tmp/chrome.zip" "$url"
if command -v sha256sum >/dev/null; then
	hash="$(sha256sum "$tmp/chrome.zip" | cut -d' ' -f1)"
else
	hash="$(shasum -a 256 "$tmp/chrome.zip" | cut -d' ' -f1)"
fi
echo "fetch-angle: sha256 $hash"
if [[ "$pinned" == TODO_PIN_ON_MAC ]]; then
	echo "fetch-angle: the $platform zip's sha256 isn't pinned yet. If the download is the one you expect, set" >&2
	echo "  pinned=$hash" >&2
	echo "in scripts/fetch-angle.sh ($platform) and run it again." >&2
	exit 1
fi
if [[ "$hash" != "$pinned" ]]; then
	echo "fetch-angle: sha256 mismatch: expected $pinned" >&2
	exit 1
fi

members=()
for f in "${files[@]}"; do members+=("$(inside "$f")"); done
unzip -q "$tmp/chrome.zip" "${members[@]}" -d "$tmp/out"
rm "$tmp/chrome.zip"
mkdir -p "$dest"
for f in "${files[@]}"; do
	# the mac framework's Versions/Current is a link to the one real version: take the regular file
	found="$(find "$tmp/out" -type f -name "$f" | head -n 1)"
	[[ -n "$found" ]] || { echo "fetch-angle: $f isn't in the zip" >&2; exit 1; }
	cp "$found" "$dest/$f"
done
echo "fetch-angle: ANGLE in $dest"
