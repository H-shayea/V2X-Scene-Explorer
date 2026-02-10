#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

APP_NAME="${APP_NAME:-V2X Scene Explorer}"
APP_PATH="${APP_PATH:-dist/${APP_NAME}.app}"
IDENTITY="${DEV_ID_APP:-}"

if [[ -z "${IDENTITY}" ]]; then
  echo "Missing signing identity."
  echo "Set DEV_ID_APP, for example:"
  echo "  export DEV_ID_APP='Developer ID Application: Your Name (TEAMID)'"
  exit 2
fi

if [[ ! -d "${APP_PATH}" ]]; then
  echo "Missing app bundle: ${APP_PATH}"
  echo "Run ./desktop/build_macos_app.sh first."
  exit 2
fi

echo "Signing app:"
echo "  app: ${APP_PATH}"
echo "  id:  ${IDENTITY}"

codesign \
  --force \
  --deep \
  --options runtime \
  --timestamp \
  --sign "${IDENTITY}" \
  "${APP_PATH}"

echo "Verifying code signature..."
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"

echo "Assessing app with Gatekeeper..."
spctl --assess --type execute --verbose=2 "${APP_PATH}" || true

echo "Signed app:"
echo "  ${APP_PATH}"
