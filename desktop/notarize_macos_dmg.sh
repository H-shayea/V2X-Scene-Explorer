#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

APP_NAME="${APP_NAME:-V2X Scene Explorer}"
APP_PATH="${APP_PATH:-dist/${APP_NAME}.app}"
DMG_PATH="${DMG_PATH:-dist/${APP_NAME}.dmg}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"
IDENTITY="${DEV_ID_APP:-}"

if [[ ! -f "${DMG_PATH}" ]]; then
  echo "Missing DMG: ${DMG_PATH}"
  echo "Run ./desktop/build_macos_dmg.sh first."
  exit 2
fi

if [[ -n "${IDENTITY}" ]]; then
  echo "Signing DMG with Developer ID..."
  codesign --force --timestamp --sign "${IDENTITY}" "${DMG_PATH}"
fi

echo "Submitting for notarization:"
echo "  ${DMG_PATH}"

if [[ -n "${NOTARY_PROFILE}" ]]; then
  xcrun notarytool submit "${DMG_PATH}" --keychain-profile "${NOTARY_PROFILE}" --wait
else
  APPLE_ID="${APPLE_ID:-}"
  APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
  APPLE_APP_PASSWORD="${APPLE_APP_PASSWORD:-}"
  if [[ -z "${APPLE_ID}" || -z "${APPLE_TEAM_ID}" || -z "${APPLE_APP_PASSWORD}" ]]; then
    echo "Notarization credentials missing."
    echo "Preferred: set NOTARY_PROFILE and use keychain credentials."
    echo "Fallback env vars: APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD"
    exit 2
  fi
  xcrun notarytool submit \
    "${DMG_PATH}" \
    --apple-id "${APPLE_ID}" \
    --team-id "${APPLE_TEAM_ID}" \
    --password "${APPLE_APP_PASSWORD}" \
    --wait
fi

echo "Stapling notarization ticket..."
xcrun stapler staple "${DMG_PATH}"
if [[ -d "${APP_PATH}" ]]; then
  xcrun stapler staple "${APP_PATH}" || true
fi

echo "Validating stapled ticket..."
xcrun stapler validate "${DMG_PATH}"

echo "Notarized artifact:"
echo "  ${DMG_PATH}"
