#!/usr/bin/env python3

from __future__ import annotations

import argparse
from collections import OrderedDict
import json
import mimetypes
import os
import posixpath
import re
import signal
import subprocess
import sys
import threading
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

try:
    # Preferred when running as a module: `python -m apps.server.server`
    from apps.app_meta import APP_NAME, APP_VERSION, DEFAULT_UPDATE_REPO
    from apps.server.datasets import DatasetStore
except ModuleNotFoundError:
    # Fallback when running as a script: `python apps/server/server.py`
    APP_NAME = "V2X Scene Explorer"
    APP_VERSION = str(os.environ.get("TRAJ_APP_VERSION") or "0.2.0").strip() or "0.2.0"
    DEFAULT_UPDATE_REPO = str(os.environ.get("TRAJ_UPDATE_REPO") or "H-shayea/V2X-Scene-Explorer").strip()
    from datasets import DatasetStore  # type: ignore


_TILE_CACHE_MAX = 512
_tile_cache: "OrderedDict[str, tuple[bytes, str]]" = OrderedDict()
_tile_cache_lock = threading.Lock()

_UPDATE_CACHE_TTL_S = 5 * 60
_update_cache_lock = threading.Lock()
_update_cache_key = ""
_update_cache_ts = 0.0
_update_cache_payload: dict[str, object] | None = None
_SEMVER_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$")


def json_bytes(obj: object) -> bytes:
    return (json.dumps(obj, ensure_ascii=True, indent=2) + "\n").encode("utf-8")


def clamp_int(s: str, default: int, min_v: int, max_v: int) -> int:
    try:
        v = int(s)
    except Exception:
        return default
    return max(min_v, min(max_v, v))


def _now_utc_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _update_repo() -> str:
    return str(os.environ.get("TRAJ_UPDATE_REPO") or DEFAULT_UPDATE_REPO or "").strip()


def _normalize_ver(s: str) -> str:
    return str(s or "").strip().lstrip("vV")


def _parse_semver(s: str) -> tuple[int, int, int] | None:
    m = _SEMVER_RE.match(str(s or "").strip())
    if not m:
        return None
    try:
        return int(m.group(1)), int(m.group(2)), int(m.group(3))
    except Exception:
        return None


def _is_update_available(current_version: str, latest_tag: str) -> tuple[bool, bool, str]:
    """
    Returns:
      (update_available, comparison_confident, comparison_mode)
    """
    cur = _normalize_ver(current_version)
    latest = _normalize_ver(latest_tag)
    if not latest:
        return False, False, "missing_latest"
    if latest == cur:
        return False, True, "equal"

    cur_sv = _parse_semver(cur)
    latest_sv = _parse_semver(latest)
    if cur_sv is None or latest_sv is None:
        # If we can't compare semver safely, do not auto-claim an update.
        return False, False, "unknown"
    return latest_sv > cur_sv, True, "semver"


def _pick_release_download_url(release: dict) -> str | None:
    assets = release.get("assets")
    if isinstance(assets, list):
        for a in assets:
            if not isinstance(a, dict):
                continue
            name = str(a.get("name") or "")
            url = str(a.get("browser_download_url") or "")
            if url and name.lower().endswith(".dmg"):
                return url
    rel = str(release.get("html_url") or "").strip()
    return rel or None


def _fetch_update_payload_uncached() -> dict[str, object]:
    repo = _update_repo()
    base: dict[str, object] = {
        "ok": True,
        "checked_at": _now_utc_iso(),
        "app_name": APP_NAME,
        "app_version": APP_VERSION,
        "update_repo": repo or None,
        "releases_url": f"https://github.com/{repo}/releases" if repo else None,
        "desktop": str(os.environ.get("TRAJ_DESKTOP_APP") or "0") == "1",
        "latest_tag": None,
        "latest_version": None,
        "update_available": False,
        "comparison_confident": False,
        "comparison_mode": "not_configured",
        "release_name": None,
        "release_url": None,
        "download_url": None,
        "published_at": None,
        "error": None,
    }
    if not repo:
        return base

    url = f"https://api.github.com/repos/{repo}/releases/latest"
    try:
        req = Request(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": f"TrajExplorer/{APP_VERSION}",
            },
        )
        with urlopen(req, timeout=8) as resp:
            raw = json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception as e:
        base["ok"] = False
        base["error"] = str(e)
        base["comparison_mode"] = "error"
        return base

    if not isinstance(raw, dict):
        base["ok"] = False
        base["error"] = "invalid response from release API"
        base["comparison_mode"] = "error"
        return base

    latest_tag = str(raw.get("tag_name") or "").strip()
    latest_version = _normalize_ver(latest_tag)
    update_available, confident, mode = _is_update_available(APP_VERSION, latest_tag)

    base["latest_tag"] = latest_tag or None
    base["latest_version"] = latest_version or None
    base["update_available"] = bool(update_available)
    base["comparison_confident"] = bool(confident)
    base["comparison_mode"] = mode
    base["release_name"] = str(raw.get("name") or "").strip() or None
    base["release_url"] = str(raw.get("html_url") or "").strip() or None
    base["download_url"] = _pick_release_download_url(raw)
    base["published_at"] = str(raw.get("published_at") or "").strip() or None
    return base


def get_update_payload(force: bool = False) -> dict[str, object]:
    global _update_cache_key, _update_cache_ts, _update_cache_payload
    key = f"{_update_repo()}|{APP_VERSION}"
    now = time.time()
    with _update_cache_lock:
        if (
            not force
            and _update_cache_payload is not None
            and _update_cache_key == key
            and (now - _update_cache_ts) < _UPDATE_CACHE_TTL_S
        ):
            return dict(_update_cache_payload)

    payload = _fetch_update_payload_uncached()
    with _update_cache_lock:
        _update_cache_key = key
        _update_cache_ts = now
        _update_cache_payload = dict(payload)
    return payload


def get_app_meta() -> dict[str, object]:
    repo = _update_repo()
    return {
        "app_name": APP_NAME,
        "app_version": APP_VERSION,
        "desktop": str(os.environ.get("TRAJ_DESKTOP_APP") or "0") == "1",
        "update_repo": repo or None,
        "releases_url": f"https://github.com/{repo}/releases" if repo else None,
    }


def _reload_watch_files(repo_root: Path) -> list[Path]:
    out: list[Path] = []
    out.extend(sorted((repo_root / "apps" / "server").rglob("*.py")))
    # Registry changes affect dataset discovery.
    out.append(repo_root / "dataset" / "registry.json")
    out.append(repo_root / "dataset" / "registry.local.json")
    # Catalog changes affect landing-page metadata.
    out.append(repo_root / "dataset" / "catalog.json")
    return [p for p in out if p.exists()]


def _snapshot_mtime_ns(paths: list[Path]) -> dict[str, int]:
    snap: dict[str, int] = {}
    for p in paths:
        try:
            snap[str(p)] = p.stat().st_mtime_ns
        except FileNotFoundError:
            snap[str(p)] = 0
    return snap


def _diff_snapshot(prev: dict[str, int], cur: dict[str, int]) -> list[str]:
    changed: list[str] = []
    keys = set(prev.keys()) | set(cur.keys())
    for k in sorted(keys):
        if prev.get(k) != cur.get(k):
            changed.append(k)
    return changed


def _stop_child(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    if proc.poll() is not None:
        return
    try:
        proc.send_signal(signal.SIGINT)
        proc.wait(timeout=3)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def run_with_reload(repo_root: Path, host: str, port: int) -> int:
    """
    Simple dev reloader: restart the server process when backend code changes.
    This keeps the main server implementation dependency-free (stdlib only).
    """
    cmd = [sys.executable, "-m", "apps.server.server", "--host", host, "--port", str(port)]
    env = dict(os.environ)
    proc: subprocess.Popen | None = None

    watch_files = _reload_watch_files(repo_root)
    snap = _snapshot_mtime_ns(watch_files)

    print("Reload mode: watching backend files for changes.")
    try:
        while True:
            if proc is None or proc.poll() is not None:
                proc = subprocess.Popen(cmd, cwd=str(repo_root), env=env)

            time.sleep(0.6)
            watch_files = _reload_watch_files(repo_root)
            cur = _snapshot_mtime_ns(watch_files)
            if cur != snap:
                changed = _diff_snapshot(snap, cur)
                msg = changed[0] if changed else "(unknown file)"
                more = f" (+{len(changed) - 1} more)" if len(changed) > 1 else ""
                print(f"\nReload: change detected in {msg}{more} -> restarting\n")
                _stop_child(proc)
                proc = None
                snap = cur
    except KeyboardInterrupt:
        _stop_child(proc)
        return 0


class AppHandler(BaseHTTPRequestHandler):
    server_version = f"TrajExplorer/{APP_VERSION}"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/"):
            self._handle_api(path, parse_qs(parsed.query))
            return

        self._handle_static(path)

    def log_message(self, fmt: str, *args) -> None:
        # Keep default behavior (stderr) but make it slightly cleaner.
        super().log_message(fmt, *args)

    @property
    def store(self) -> DatasetStore:
        # Set by server init.
        return self.server.store  # type: ignore[attr-defined]

    @property
    def repo_root(self) -> Path:
        return self.server.repo_root  # type: ignore[attr-defined]

    @property
    def web_root(self) -> Path:
        return self.server.web_root  # type: ignore[attr-defined]

    def _send(self, status: int, body: bytes, content_type: str, extra_headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # Same-origin by default, but allowing CORS helps local dev.
        self.send_header("Access-Control-Allow-Origin", "*")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(str(k), str(v))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, obj: object) -> None:
        self._send(status, json_bytes(obj), "application/json; charset=utf-8")

    def _send_error_json(self, status: int, message: str, detail: str | None = None) -> None:
        payload = {"error": message}
        if detail:
            payload["detail"] = detail
        self._send_json(status, payload)

    def _handle_api(self, path: str, qs: dict) -> None:
        try:
            if path == "/api/health":
                self._send_json(200, {"ok": True})
                return

            if path == "/api/app_meta":
                self._send_json(200, get_app_meta())
                return

            if path == "/api/update/check":
                force = (qs.get("force", ["0"])[0] or "0") == "1"
                self._send_json(200, get_update_payload(force=force))
                return

            # Small same-origin tile proxy (helps when adblock/CORS blocks public tile servers).
            if path.startswith("/api/tiles/"):
                self._handle_tiles(path)
                return

            if path == "/api/catalog":
                catalog_path = (self.repo_root / "dataset" / "catalog.json").resolve()
                if not catalog_path.exists():
                    self._send_error_json(404, "not_found", "catalog.json not found")
                    return
                raw = json.loads(catalog_path.read_text(encoding="utf-8"))
                self._send_json(200, raw)
                return

            if path == "/api/datasets":
                self._send_json(200, {"datasets": self.store.list_datasets()})
                return

            # /api/datasets/<id>/...
            parts = path.strip("/").split("/")
            if len(parts) < 3 or parts[0] != "api" or parts[1] != "datasets":
                self._send_error_json(404, "not_found")
                return

            dataset_id = parts[2]
            adapter = self.store.get_adapter(dataset_id)

            # /api/datasets/<id>/intersections?split=train
            if len(parts) == 4 and parts[3] == "intersections":
                split = (qs.get("split", ["train"])[0] or "train").strip()
                self._send_json(200, {"split": split, "items": adapter.list_intersections(split)})
                return

            # /api/datasets/<id>/scenes?split=train&intersect_id=...&limit=200&offset=0
            if len(parts) == 4 and parts[3] == "scenes":
                split = (qs.get("split", ["train"])[0] or "train").strip()
                intersect_id = (qs.get("intersect_id", [None])[0] or None)
                limit = clamp_int((qs.get("limit", ["200"])[0] or "200"), default=200, min_v=1, max_v=5000)
                offset = clamp_int((qs.get("offset", ["0"])[0] or "0"), default=0, min_v=0, max_v=10**9)
                payload = adapter.list_scenes(split, intersect_id=intersect_id, limit=limit, offset=offset)
                payload["split"] = split
                payload["intersect_id"] = intersect_id
                self._send_json(200, payload)
                return

            # /api/datasets/<id>/locate_scene?split=train&scene_id=123
            if len(parts) == 4 and parts[3] == "locate_scene":
                split = (qs.get("split", ["train"])[0] or "train").strip()
                scene_id = (qs.get("scene_id", [""])[0] or "").strip()
                if scene_id == "":
                    self._send_error_json(400, "bad_request", "scene_id is required")
                    return
                payload = adapter.locate_scene(split, scene_id)
                self._send_json(200, payload)
                return

            # /api/datasets/<id>/scene/<split>/<scene_id>/bundle
            if len(parts) == 7 and parts[3] == "scene" and parts[6] == "bundle":
                split = parts[4]
                scene_id = parts[5]
                include_map = (qs.get("include_map", ["1"])[0] or "1") != "0"
                map_clip = (qs.get("map_clip", ["intersection"])[0] or "intersection").strip()
                map_padding = float(qs.get("map_padding", ["60"])[0] or 60)
                map_points_step = clamp_int((qs.get("map_points_step", ["5"])[0] or "5"), default=5, min_v=1, max_v=20)
                max_lanes = clamp_int((qs.get("max_lanes", ["4000"])[0] or "4000"), default=4000, min_v=200, max_v=20000)
                bundle = adapter.load_scene_bundle(
                    split=split,
                    scene_id=scene_id,
                    include_map=include_map,
                    map_padding=map_padding,
                    map_points_step=map_points_step,
                    max_lanes=max_lanes,
                    map_clip=map_clip,
                )
                self._send_json(200, bundle)
                return

            self._send_error_json(404, "not_found")
        except KeyError as e:
            self._send_error_json(404, "not_found", str(e))
        except Exception as e:
            tb = traceback.format_exc(limit=5)
            self._send_error_json(500, "internal_error", f"{e}\n{tb}")

    def _handle_tiles(self, path: str) -> None:
        """
        Same-origin OSM tile proxy.

        Route:
          /api/tiles/osm/{z}/{x}/{y}.png
        """
        parts = path.strip("/").split("/")
        if len(parts) != 6 or parts[0] != "api" or parts[1] != "tiles":
            self._send_error_json(404, "not_found")
            return

        provider = parts[2]
        if provider != "osm":
            self._send_error_json(404, "not_found", f"unknown tile provider: {provider}")
            return

        try:
            z = int(parts[3])
            x = int(parts[4])
            y_part = parts[5]
            if not y_part.endswith(".png"):
                raise ValueError("expected .png")
            y = int(y_part[:-4])
        except Exception:
            self._send_error_json(400, "bad_request", "invalid tile coordinates")
            return

        if z < 0 or z > 22:
            self._send_error_json(400, "bad_request", "z out of range")
            return
        n = 2 ** z
        if x < 0 or x >= n or y < 0 or y >= n:
            self._send_error_json(400, "bad_request", "x/y out of range")
            return

        key = f"osm:{z}/{x}/{y}"
        with _tile_cache_lock:
            cached = _tile_cache.get(key)
            if cached is not None:
                _tile_cache.move_to_end(key)
                body, ctype = cached
                self._send(200, body, ctype, extra_headers={"Cache-Control": "public, max-age=86400"})
                return

        remote = f"https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        try:
            req = Request(
                remote,
                headers={
                    # A descriptive UA helps tile providers; keep it short (local dev tool).
                    "User-Agent": f"{self.server_version} (+local dev)",
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                },
            )
            with urlopen(req, timeout=10) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type") or "image/png"
        except (HTTPError, URLError) as e:
            self._send_error_json(502, "tile_fetch_failed", f"{e}")
            return
        except Exception as e:
            self._send_error_json(502, "tile_fetch_failed", f"{e}")
            return

        if not body:
            self._send_error_json(502, "tile_fetch_failed", "empty tile response")
            return

        with _tile_cache_lock:
            _tile_cache[key] = (body, ctype)
            _tile_cache.move_to_end(key)
            while len(_tile_cache) > _TILE_CACHE_MAX:
                _tile_cache.popitem(last=False)

        self._send(200, body, ctype, extra_headers={"Cache-Control": "public, max-age=86400"})

    def _handle_static(self, path: str) -> None:
        # Default doc
        if path == "/":
            path = "/index.html"

        # Prevent traversal
        path_norm = posixpath.normpath(path)
        if path_norm.startswith("../") or "/../" in path_norm or path_norm.startswith(".."):
            self._send_error_json(400, "bad_request", "invalid path")
            return

        rel = path_norm.lstrip("/")
        full = (self.web_root / rel).resolve()
        if not str(full).startswith(str(self.web_root.resolve())):
            self._send_error_json(400, "bad_request", "invalid path")
            return

        if not full.exists() or not full.is_file():
            self._send_error_json(404, "not_found")
            return

        body = full.read_bytes()
        ctype, _ = mimetypes.guess_type(str(full))
        if not ctype:
            ctype = "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, body, ctype)


def main() -> int:
    ap = argparse.ArgumentParser(description="Traj Explorer server (stdlib HTTP + vanilla web app).")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", default=8000, type=int)
    ap.add_argument("--reload", action="store_true", help="Auto-restart the server when backend files change (dev mode).")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    web_root = (repo_root / "apps" / "web").resolve()

    if args.reload:
        return run_with_reload(repo_root=repo_root, host=args.host, port=args.port)

    store = DatasetStore(repo_root)
    if not store.specs:
        print("No datasets found. Ensure dataset/registry.json exists and points to valid paths.")
        return 2

    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    server.store = store  # type: ignore[attr-defined]
    server.web_root = web_root  # type: ignore[attr-defined]
    server.repo_root = repo_root  # type: ignore[attr-defined]

    print(f"Serving on http://{args.host}:{args.port}")
    print(f"Web root: {web_root}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
