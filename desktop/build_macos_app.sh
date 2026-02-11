#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

APP_NAME="V2X Scene Explorer"
ICON_SRC="${ICON_SRC:-desktop/assets/app-icon-source.png}"
ICON_PATH="${ICON_PATH:-desktop/assets/V2XSceneExplorer.icns}"

python3 -m pip install -r desktop/requirements-macos.txt

rm -rf build dist

# Some macOS setups fail iconutil conversion. Keep the previous .icns as fallback
# so app builds are not blocked when the icon source is unchanged.
ICON_BAK=""
if [[ -f "${ICON_PATH}" ]]; then
  ICON_BAK="${ICON_PATH}.bak"
  cp "${ICON_PATH}" "${ICON_BAK}"
fi

if ! ./desktop/make_macos_icon.sh "${ICON_SRC}" "${ICON_PATH}"; then
  echo "Warning: icon regeneration failed; using existing icon file."
  if [[ -n "${ICON_BAK}" && -f "${ICON_BAK}" ]]; then
    mv "${ICON_BAK}" "${ICON_PATH}"
  elif [[ ! -f "${ICON_PATH}" ]]; then
    echo "Error: no icon file available at ${ICON_PATH}"
    exit 2
  fi
fi

if [[ -n "${ICON_BAK}" && -f "${ICON_BAK}" ]]; then
  rm -f "${ICON_BAK}"
fi

python3 -m PyInstaller \
  --noconfirm \
  --windowed \
  --name "${APP_NAME}" \
  --icon "${ICON_PATH}" \
  --add-data "apps/web:apps/web" \
  --add-data "dataset/registry.json:dataset" \
  --add-data "dataset/catalog.json:dataset" \
  --add-data "dataset/profiles/v2x-traj:dataset/profiles/v2x-traj" \
  apps/desktop/main.py

echo "Built app bundle:"
echo "  dist/${APP_NAME}.app"
