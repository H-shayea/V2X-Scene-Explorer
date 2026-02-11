#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

usage() {
  cat <<'EOF'
Usage:
  ./dev.sh [mode] [extra args]

Modes:
  web        Run web server in reload mode (default)
  desktop    Run native macOS desktop app (dev)
  build      Build macOS .app bundle
  dmg        Build macOS .dmg (requires built app)
  help       Show this help

Environment (web mode):
  HOST=127.0.0.1
  PORT=8000

Examples:
  ./dev.sh
  ./dev.sh web
  PORT=9000 ./dev.sh web
  ./dev.sh desktop
  ./dev.sh build
  ./dev.sh dmg
EOF
}

MODE="${1:-web}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "${MODE}" in
  web)
    HOST="${HOST:-127.0.0.1}"
    PORT="${PORT:-8000}"
    exec python3 -m apps.server.server --host "${HOST}" --port "${PORT}" --reload "$@"
    ;;
  desktop)
    exec python3 -m apps.desktop.main "$@"
    ;;
  build)
    exec ./desktop/build_macos_app.sh "$@"
    ;;
  dmg)
    exec ./desktop/build_macos_dmg.sh "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown mode: ${MODE}" >&2
    echo >&2
    usage
    exit 2
    ;;
esac

