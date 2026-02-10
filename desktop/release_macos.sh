#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

./desktop/build_macos_app.sh
./desktop/sign_macos_app.sh
./desktop/build_macos_dmg.sh
./desktop/notarize_macos_dmg.sh

echo "Release pipeline completed."
