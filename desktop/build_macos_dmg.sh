#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

APP_NAME="V2X Scene Explorer"
APP_PATH="dist/${APP_NAME}.app"
DMG_PATH="dist/${APP_NAME}.dmg"
VOL_NAME="${APP_NAME}"

if [[ ! -d "${APP_PATH}" ]]; then
  echo "Missing app bundle: ${APP_PATH}"
  echo "Run ./desktop/build_macos_app.sh first."
  exit 2
fi

rm -f "${DMG_PATH}"

hdiutil create \
  -volname "${VOL_NAME}" \
  -srcfolder "${APP_PATH}" \
  -ov \
  -format UDZO \
  "${DMG_PATH}"

echo "Built DMG:"
echo "  ${DMG_PATH}"
