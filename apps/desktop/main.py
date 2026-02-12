#!/usr/bin/env python3

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import sys
import threading
import time
from urllib.request import urlopen
from typing import Any, List

try:
    import webview
except Exception as e:  # pragma: no cover
    print("Missing dependency: pywebview")
    print("Install with: python3 -m pip install pywebview")
    print(f"Details: {e}")
    raise SystemExit(2)

from http.server import ThreadingHTTPServer

from apps.app_meta import APP_NAME
from apps.server.datasets import DatasetStore
from apps.server.profiles import ProfileStore
from apps.server.server import AppHandler


HOST = "127.0.0.1"
WINDOW_SIZE = (1540, 980)
MIN_WINDOW_SIZE = (1100, 760)


class DesktopBridge:
    def __init__(self) -> None:
        self._window: Any = None

    def attach_window(self, window: Any) -> None:
        self._window = window

    @staticmethod
    def _normalize_dialog_result(raw: Any) -> List[str]:
        if raw is None:
            return []
        if isinstance(raw, (list, tuple)):
            return [str(x) for x in raw if str(x or "").strip()]
        s = str(raw).strip()
        return [s] if s else []

    def is_desktop(self) -> bool:
        return True

    def pick_files(self) -> List[str]:
        if self._window is None:
            return []
        try:
            raw = self._window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=True)
        except Exception:
            return []
        return self._normalize_dialog_result(raw)

    def pick_folder(self) -> List[str]:
        if self._window is None:
            return []
        try:
            raw = self._window.create_file_dialog(webview.FOLDER_DIALOG, allow_multiple=False)
        except Exception:
            return []
        return self._normalize_dialog_result(raw)

    def pick_proto_file(self) -> List[str]:
        if self._window is None:
            return []
        try:
            raw = self._window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=False)
        except Exception:
            return []
        out = self._normalize_dialog_result(raw)
        if not out:
            return []
        p = Path(out[0])
        if p.suffix.lower() != ".proto":
            return []
        return out


def app_support_dir() -> Path:
    return (Path.home() / "Library" / "Application Support" / APP_NAME).resolve()


def local_registry_path() -> Path:
    return app_support_dir() / "registry.local.json"


def resolve_root(raw_root: str, root: Path) -> Path:
    p = Path(str(raw_root)).expanduser()
    if p.is_absolute():
        return p.resolve()
    return (root / p).resolve()


def root_exists(raw_root: str, root: Path) -> bool:
    try:
        return resolve_root(raw_root, root).exists()
    except Exception:
        return False


def discover_valid_roots(root: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    reg = (root / "dataset" / "registry.json").resolve()
    if not reg.exists():
        return out
    try:
        raw = json.loads(reg.read_text(encoding="utf-8"))
    except Exception:
        return out
    datasets = raw.get("datasets")
    if not isinstance(datasets, list):
        return out
    for d in datasets:
        if not isinstance(d, dict):
            continue
        did = str(d.get("id") or "").strip()
        raw_root = str(d.get("root") or "").strip()
        if not did or not raw_root:
            continue
        try:
            rp = resolve_root(raw_root, root)
        except Exception:
            continue
        if rp.exists():
            out[did] = str(rp)
    return out


def ensure_local_registry_template(path: Path, root: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    placeholders = {
        "v2x-traj": "~/datasets/v2x-traj",
        "consider-it-cpm": "~/datasets/Consider-It",
    }
    valid_roots = discover_valid_roots(root)
    template_roots = {
        "v2x-traj": valid_roots.get("v2x-traj", placeholders["v2x-traj"]),
        "consider-it-cpm": valid_roots.get("consider-it-cpm", placeholders["consider-it-cpm"]),
    }

    existing: dict = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            existing = {}

    items_raw = existing.get("datasets") if isinstance(existing, dict) else None
    items = items_raw if isinstance(items_raw, list) else []

    by_id: dict[str, dict] = {}
    ordered_ids: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        did = str(item.get("id") or "").strip()
        if not did or did in by_id:
            continue
        by_id[did] = dict(item)
        ordered_ids.append(did)

    changed = not path.exists()
    project_dataset_dir = (root / "dataset").resolve()
    legacy_consider_it_names = {"ConsiderIt", "ConsiderI-It"}

    for did in ("v2x-traj", "consider-it-cpm"):
        if did not in by_id:
            by_id[did] = {"id": did}
            ordered_ids.append(did)
            changed = True

        cur_root = str(by_id[did].get("root") or "").strip()
        has_cur = bool(cur_root)
        cur_ok = has_cur and root_exists(cur_root, root)
        if not has_cur:
            by_id[did]["root"] = template_roots[did]
            changed = True
            continue

        # Normalize known legacy in-repo Consider.it folder names to canonical Consider-It.
        if did == "consider-it-cpm":
            try:
                cur_resolved = resolve_root(cur_root, root)
            except Exception:
                cur_resolved = None
            canonical_raw = str(template_roots.get(did) or "").strip()
            canonical_ok = bool(canonical_raw) and root_exists(canonical_raw, root)
            if cur_resolved is not None and canonical_ok:
                try:
                    canonical_resolved = resolve_root(canonical_raw, root)
                except Exception:
                    canonical_resolved = None
                if (
                    canonical_resolved is not None
                    and cur_resolved.parent == project_dataset_dir
                    and cur_resolved.name in legacy_consider_it_names
                    and cur_resolved != canonical_resolved
                ):
                    by_id[did]["root"] = str(canonical_resolved)
                    changed = True
                    continue

        # Auto-heal stale placeholder roots only when we can resolve a valid local path.
        if not cur_ok and did in valid_roots and by_id[did].get("root") != valid_roots[did]:
            by_id[did]["root"] = valid_roots[did]
            changed = True

    if not changed:
        return

    payload = {"datasets": [by_id[did] for did in ordered_ids]}
    path.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")


def repo_root() -> Path:
    # PyInstaller one-dir/one-file exposes bundled data under sys._MEIPASS.
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass).resolve()
    return Path(__file__).resolve().parents[2]


def choose_port(host: str = HOST) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return int(s.getsockname()[1])


def wait_for_health(url: str, timeout_s: float = 8.0) -> bool:
    t0 = time.time()
    while (time.time() - t0) < timeout_s:
        try:
            with urlopen(url, timeout=1.5) as resp:
                return int(resp.status) == 200
        except Exception:
            time.sleep(0.12)
    return False


def build_server(root: Path, host: str, port: int) -> ThreadingHTTPServer:
    web_root = (root / "apps" / "web").resolve()
    profile_store = ProfileStore(root)
    store = DatasetStore(root)
    if not store.specs:
        raise RuntimeError("No datasets configured. Check registry.json / registry.local.json paths.")

    server = ThreadingHTTPServer((host, port), AppHandler)
    server.store = store  # type: ignore[attr-defined]
    server.profile_store = profile_store  # type: ignore[attr-defined]
    server.web_root = web_root  # type: ignore[attr-defined]
    server.repo_root = root  # type: ignore[attr-defined]
    return server


def main() -> int:
    root = repo_root()
    reg_local = local_registry_path()
    ensure_local_registry_template(reg_local, root)

    # Desktop app keeps writable user config outside the app bundle.
    os.environ.setdefault("TRAJ_DESKTOP_APP", "1")
    os.environ.setdefault("TRAJ_REGISTRY_LOCAL", str(reg_local))

    port = choose_port(HOST)
    url = f"http://{HOST}:{port}"
    health_url = f"{url}/api/health"

    try:
        server = build_server(root, HOST, port)
    except Exception as e:
        print(f"Failed to start server: {e}")
        return 2

    th = threading.Thread(target=server.serve_forever, daemon=True)
    th.start()

    if not wait_for_health(health_url, timeout_s=8.0):
        server.shutdown()
        server.server_close()
        print("Server did not become healthy in time.")
        return 3

    bridge = DesktopBridge()
    window = None
    try:
        window = webview.create_window(
            APP_NAME,
            url=url,
            width=WINDOW_SIZE[0],
            height=WINDOW_SIZE[1],
            min_size=MIN_WINDOW_SIZE,
            js_api=bridge,
        )
        bridge.attach_window(window)
        webview.start(debug=False)
    finally:
        server.shutdown()
        server.server_close()
        th.join(timeout=2.0)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
