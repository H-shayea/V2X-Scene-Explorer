#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

APP_NAME="V2X Scene Explorer"
APP_PATH="dist/${APP_NAME}.app"
DMG_PATH="dist/${APP_NAME}.dmg"
VOL_NAME="${APP_NAME}"
STAGE_DIR="$(mktemp -d /tmp/v2x-dmg-stage.XXXXXX)"

cleanup() {
  rm -rf "${STAGE_DIR}"
}
trap cleanup EXIT

if [[ ! -d "${APP_PATH}" ]]; then
  echo "Missing app bundle: ${APP_PATH}"
  echo "Run ./desktop/build_macos_app.sh first."
  exit 2
fi

rm -f "${DMG_PATH}"

# Build a staging folder that includes both the app and an Applications symlink.
cp -R "${APP_PATH}" "${STAGE_DIR}/"
ln -s /Applications "${STAGE_DIR}/Applications"

hdiutil create \
  -volname "${VOL_NAME}" \
  -srcfolder "${STAGE_DIR}" \
  -ov \
  -format UDZO \
  "${DMG_PATH}"

echo "Built DMG:"
echo "  ${DMG_PATH}"
