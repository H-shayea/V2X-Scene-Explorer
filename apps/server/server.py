#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import posixpath
import signal
import subprocess
import sys
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    # Preferred when running as a module: `python -m apps.server.server`
    from apps.server.datasets import DatasetStore
except ModuleNotFoundError:
    # Fallback when running as a script: `python apps/server/server.py`
    from datasets import DatasetStore  # type: ignore


def json_bytes(obj: object) -> bytes:
    return (json.dumps(obj, ensure_ascii=True, indent=2) + "\n").encode("utf-8")


def clamp_int(s: str, default: int, min_v: int, max_v: int) -> int:
    try:
        v = int(s)
    except Exception:
        return default
    return max(min_v, min(max_v, v))


def _reload_watch_files(repo_root: Path) -> list[Path]:
    out: list[Path] = []
    out.extend(sorted((repo_root / "apps" / "server").rglob("*.py")))
    # Registry changes affect dataset discovery.
    out.append(repo_root / "dataset" / "registry.json")
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
    server_version = "TrajExplorer/0.1"

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
    def web_root(self) -> Path:
        return self.server.web_root  # type: ignore[attr-defined]

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # Same-origin by default, but allowing CORS helps local dev.
        self.send_header("Access-Control-Allow-Origin", "*")
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
