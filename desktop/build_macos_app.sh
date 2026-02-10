#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

APP_NAME="V2X Scene Explorer"
ICON_SRC="${ICON_SRC:-desktop/assets/app-icon-source.png}"
ICON_PATH="${ICON_PATH:-desktop/assets/V2XSceneExplorer.icns}"

python3 -m pip install -r desktop/requirements-macos.txt

rm -rf build dist

./desktop/make_macos_icon.sh "${ICON_SRC}" "${ICON_PATH}"

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
