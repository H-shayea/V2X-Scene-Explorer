#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

SRC_IMAGE="${1:-desktop/assets/app-icon-source.png}"
OUT_ICNS="${2:-desktop/assets/V2XSceneExplorer.icns}"

command -v sips >/dev/null 2>&1 || { echo "Missing required tool: sips"; exit 2; }
command -v iconutil >/dev/null 2>&1 || { echo "Missing required tool: iconutil"; exit 2; }

if [[ ! -f "${SRC_IMAGE}" ]]; then
  if [[ "${SRC_IMAGE}" == "desktop/assets/app-icon-source.png" ]]; then
    python3 ./desktop/generate_app_icon_png.py "${SRC_IMAGE}"
  else
    echo "Source image not found: ${SRC_IMAGE}"
    exit 2
  fi
fi

TMP_DIR="$(mktemp -d /tmp/v2x-icon.XXXXXX)"
ICONSET="${TMP_DIR}/AppIcon.iconset"
SQUARE_SRC="${TMP_DIR}/source-square.png"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

mkdir -p "${ICONSET}"
mkdir -p "$(dirname "${OUT_ICNS}")"

MIN_EDGE="$(sips -g pixelWidth -g pixelHeight "${SRC_IMAGE}" | awk '/pixelWidth/ {w=$2} /pixelHeight/ {h=$2} END {if (w<h) print w; else print h}')"
if [[ -z "${MIN_EDGE}" ]]; then
  echo "Failed to read image dimensions: ${SRC_IMAGE}"
  exit 2
fi

# Crop to centered square so the icon stays proportionate.
sips -c "${MIN_EDGE}" "${MIN_EDGE}" "${SRC_IMAGE}" --out "${SQUARE_SRC}" >/dev/null

render_size() {
  local px="$1"
  local out_name="$2"
  sips -z "${px}" "${px}" "${SQUARE_SRC}" --out "${ICONSET}/${out_name}" >/dev/null
}

render_size 16 "icon_16x16.png"
render_size 32 "icon_16x16@2x.png"
render_size 32 "icon_32x32.png"
render_size 64 "icon_32x32@2x.png"
render_size 128 "icon_128x128.png"
render_size 256 "icon_128x128@2x.png"
render_size 256 "icon_256x256.png"
render_size 512 "icon_256x256@2x.png"
render_size 512 "icon_512x512.png"
render_size 1024 "icon_512x512@2x.png"

iconutil -c icns "${ICONSET}" -o "${OUT_ICNS}"

echo "Created icon:"
echo "  ${OUT_ICNS}"
