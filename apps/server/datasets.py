from __future__ import annotations

import csv
import datetime as _dt
import json
import math
import os
import re
import threading
import xml.etree.ElementTree as ET
from collections import Counter, OrderedDict, defaultdict
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    from apps.server.domain import SUPPORTED_DATASET_FAMILIES
    from apps.server.profiles import load_profile_dataset_entries
except ModuleNotFoundError:
    from domain import SUPPORTED_DATASET_FAMILIES  # type: ignore
    from profiles import load_profile_dataset_entries  # type: ignore


def safe_float(x: Any) -> Optional[float]:
    if x is None:
        return None
    try:
        s = str(x).strip()
    except Exception:
        return None
    if s == "":
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    if v != v:  # NaN
        return None
    if v in (float("inf"), float("-inf")):
        return None
    return v


def parse_ts_100ms(ts: str) -> Optional[int]:
    """
    Parse an epoch timestamp string with 0.1s resolution into an integer key.
    We use integer 100ms ticks so timestamps join reliably across modalities.
    """
    if ts is None:
        return None
    s = str(ts).strip()
    if s == "":
        return None
    try:
        d = Decimal(s) * Decimal(10)
        # Dataset is 10Hz-ish; quantize gives stable int conversion.
        return int(d.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError):
        return None


def ts_100ms_to_float(ts_100ms: int) -> float:
    return float(ts_100ms) / 10.0


def parse_intersect_to_map_id(intersect_id: str) -> Optional[int]:
    if not intersect_id:
        return None
    m = re.search(r"#(\d+)", intersect_id)
    if m:
        return int(m.group(1))
    return None


def intersection_label(intersect_id: Optional[str]) -> Optional[str]:
    """
    Return a clear, human-readable intersection name for UI display.
    Example: yizhuang#4-1_po -> Intersection 04
    """
    if not intersect_id:
        return None
    map_id = parse_intersect_to_map_id(intersect_id)
    if map_id is None:
        return intersect_id
    return f"Intersection {map_id:02d}"


def parse_point_xy(p: Any) -> Optional[Tuple[float, float]]:
    """
    Map JSON often stores points as strings like "(x, y)".
    Accepts "(x, y)" strings and (x, y) sequences.
    """
    if p is None:
        return None
    if isinstance(p, (list, tuple)) and len(p) >= 2:
        x = safe_float(p[0])
        y = safe_float(p[1])
        if x is None or y is None:
            return None
        return x, y
    if isinstance(p, str):
        s = p.strip()
        if s.startswith("(") and s.endswith(")"):
            s = s[1:-1]
        parts = s.split(",")
        if len(parts) < 2:
            return None
        x = safe_float(parts[0])
        y = safe_float(parts[1])
        if x is None or y is None:
            return None
        return x, y
    return None


def bbox_init() -> Dict[str, float]:
    return {"min_x": float("inf"), "min_y": float("inf"), "max_x": float("-inf"), "max_y": float("-inf")}


def bbox_update(b: Dict[str, float], x: float, y: float) -> None:
    if x < b["min_x"]:
        b["min_x"] = x
    if x > b["max_x"]:
        b["max_x"] = x
    if y < b["min_y"]:
        b["min_y"] = y
    if y > b["max_y"]:
        b["max_y"] = y


def bbox_is_valid(b: Dict[str, float]) -> bool:
    return b["min_x"] != float("inf") and b["max_x"] != float("-inf")


def bbox_update_from_bbox(dst: Dict[str, float], src: Dict[str, float]) -> None:
    if not bbox_is_valid(src):
        return
    bbox_update(dst, src["min_x"], src["min_y"])
    bbox_update(dst, src["max_x"], src["max_y"])


def bbox_pad(b: Dict[str, float], pad: float) -> Dict[str, float]:
    return {
        "min_x": b["min_x"] - pad,
        "min_y": b["min_y"] - pad,
        "max_x": b["max_x"] + pad,
        "max_y": b["max_y"] + pad,
    }


def bbox_intersects(a: Dict[str, float], b: Dict[str, float]) -> bool:
    return not (a["max_x"] < b["min_x"] or a["min_x"] > b["max_x"] or a["max_y"] < b["min_y"] or a["min_y"] > b["max_y"])


def read_png_size(path: Path) -> Optional[Tuple[int, int]]:
    """
    Read PNG width/height from IHDR chunk without external deps.
    """
    try:
        with path.open("rb") as f:
            raw = f.read(24)
    except Exception:
        return None
    if len(raw) < 24:
        return None
    # PNG signature + IHDR length/type.
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    if raw[12:16] != b"IHDR":
        return None
    try:
        w = int.from_bytes(raw[16:20], "big", signed=False)
        h = int.from_bytes(raw[20:24], "big", signed=False)
    except Exception:
        return None
    if w <= 0 or h <= 0:
        return None
    return (w, h)


@dataclass(frozen=True)
class DatasetSpec:
    id: str
    title: str
    family: str
    root: Path
    profile: Optional[Path] = None
    scenes: Optional[Path] = None
    # Optional role/path mappings from profile-based dataset connections.
    bindings: Optional[Dict[str, Any]] = None
    # Optional scene policy from profile-based dataset connections.
    scene_strategy: Optional[Dict[str, Any]] = None
    # Optional basemap config for datasets that are in a local sensor frame but have a known geo origin.
    # Origin is (lat, lon) in degrees and corresponds to world (x=0, y=0) for that dataset.
    geo_origin: Optional[Tuple[float, float]] = None
    # Optional per-group origin overrides (group == intersect_id in the API; for CPM Objects this is the sensor_id).
    geo_origin_by_intersect: Optional[Dict[str, Tuple[float, float]]] = None
    basemap_tile_url: Optional[str] = None
    basemap_attribution: Optional[str] = None


@dataclass
class SceneSummary:
    scene_id: str
    split: str
    city: Optional[str]
    intersect_id: Optional[str]
    intersect_label: Optional[str]
    by_modality: Dict[str, Dict[str, Any]]


@dataclass
class _IndTrackMeta:
    track_id: int
    initial_frame: int
    final_frame: int
    width: Optional[float]
    length: Optional[float]
    cls: str


@dataclass
class _IndRecordingIndex:
    recording_id: str
    recording_id_num: int
    location_id: str
    location_label: str
    frame_rate: float
    duration_s: float
    lat_location: Optional[float]
    lon_location: Optional[float]
    x_utm_origin: Optional[float]
    y_utm_origin: Optional[float]
    tracks_path: Path
    tracks_meta_path: Path
    recording_meta_path: Path
    background_path: Optional[Path]
    ortho_px_to_meter: float
    tracks_meta: Dict[int, _IndTrackMeta]
    tracks_meta_list: List[_IndTrackMeta]
    max_frame: int
    offsets_by_track: Optional[Dict[int, Tuple[int, int]]] = None
    csv_columns: Optional[Dict[str, int]] = None


@dataclass
class _IndSceneRef:
    scene_id: str
    split: str
    recording_id: str
    location_id: str
    location_label: str
    window_i: int
    frame_start: int
    frame_end: int
    min_ts: float
    max_ts: float
    rows: int
    unique_agents: int


@dataclass
class _SindScenarioRef:
    scene_id: str
    split: str
    city_id: str
    city_label: str
    scenario_id: str
    scenario_label: str
    veh_path: Optional[Path]
    ped_path: Optional[Path]
    tl_path: Optional[Path]
    map_path: Optional[Path]
    background_path: Optional[Path]


def _split_from_table_name(name: str) -> str:
    parts = name.replace("\\", "/").split("/")
    for p in parts:
        if p in ("train", "val", "test"):
            return p
    return "unknown"


def _modality_from_table_name(name: str) -> str:
    if name.startswith("ego-trajectories/"):
        return "ego"
    if name.startswith("infrastructure-trajectories/"):
        return "infra"
    if name.startswith("vehicle-trajectories/"):
        return "vehicle"
    if name.startswith("traffic-light/"):
        return "traffic_light"
    return "unknown"


class V2XTrajAdapter:
    def __init__(self, spec: DatasetSpec) -> None:
        self.spec = spec
        self._bindings = spec.bindings if isinstance(spec.bindings, dict) else {}
        scenes_csv = spec.scenes or self._binding_file("scenes_index")

        self._scene_index: Dict[str, Dict[str, SceneSummary]] = {"train": {}, "val": {}}
        self._intersections: Dict[str, Counter] = {"train": Counter(), "val": Counter()}
        if scenes_csv is not None and scenes_csv.exists() and scenes_csv.is_file():
            self._load_scenes_csv(scenes_csv)
        else:
            self._load_scenes_from_dirs()

        # Precompute stable scene ordering and indices for paging/jump-to-scene UX.
        self._sorted_scene_ids: Dict[str, List[str]] = {"train": [], "val": []}
        self._scene_id_to_index: Dict[str, Dict[str, int]] = {"train": {}, "val": {}}
        self._sorted_scene_ids_by_intersect: Dict[str, Dict[str, List[str]]] = {"train": {}, "val": {}}
        self._scene_id_to_index_by_intersect: Dict[str, Dict[str, Dict[str, int]]] = {"train": {}, "val": {}}
        self._build_scene_indices()

        if not self._scene_index["train"] and not self._scene_index["val"]:
            raise ValueError("v2x-traj adapter could not discover any scenes from index or trajectory folders")

        self._map_cache: Dict[Tuple[int, int], Dict[str, Any]] = {}
        self._csv_cache: _LRUCache = _LRUCache(max_items=24)

    def _binding_obj(self, role: str) -> Dict[str, Any]:
        v = self._bindings.get(role) if isinstance(self._bindings, dict) else None
        return v if isinstance(v, dict) else {}

    def _binding_path(self, role: str) -> Optional[Path]:
        obj = self._binding_obj(role)
        raw = obj.get("path")
        if raw is None and isinstance(self._bindings.get(role), str):
            raw = self._bindings.get(role)
        if not raw:
            return None
        try:
            return Path(str(raw)).expanduser().resolve()
        except Exception:
            return None

    def _binding_file(self, role: str) -> Optional[Path]:
        p = self._binding_path(role)
        if p and p.exists() and p.is_file():
            return p
        return p

    def _binding_dir(self, role: str) -> Optional[Path]:
        p = self._binding_path(role)
        if p and p.exists() and p.is_dir():
            return p
        return p

    @staticmethod
    def _resolve_scene_csv_from_base(base: Path, split: str, scene_id: str) -> Path:
        filename = f"{scene_id}.csv"
        candidates = [base / split / "data" / filename, base / split / filename, base / filename]
        for p in candidates:
            if p.exists():
                return p
        return candidates[0]

    @staticmethod
    def _scene_sort_key(scene_id: str) -> Tuple[int, str]:
        try:
            return int(scene_id), scene_id
        except ValueError:
            return (10**18), scene_id

    def _build_scene_indices(self) -> None:
        for split, scenes_by_id in self._scene_index.items():
            # Global stable ordering (same as list_scenes()).
            ids = list(scenes_by_id.keys())
            ids.sort(key=self._scene_sort_key)
            self._sorted_scene_ids[split] = ids
            self._scene_id_to_index[split] = {sid: i for i, sid in enumerate(ids)}

            # Stable ordering per intersection, derived from the global ordering.
            by_intersect: Dict[str, List[str]] = defaultdict(list)
            for sid in ids:
                s = scenes_by_id.get(sid)
                if not s or not s.intersect_id:
                    continue
                by_intersect[s.intersect_id].append(sid)
            self._sorted_scene_ids_by_intersect[split] = dict(by_intersect)
            self._scene_id_to_index_by_intersect[split] = {iid: {sid: i for i, sid in enumerate(lst)} for iid, lst in by_intersect.items()}

    def _load_scenes_csv(self, scenes_csv: Path) -> None:
        with scenes_csv.open("r", newline="") as f:
            r = csv.DictReader(f)
            for row in r:
                table = row.get("table", "")
                split = _split_from_table_name(table)
                if split not in self._scene_index:
                    continue

                modality = _modality_from_table_name(table)
                scene_id = row.get("scene_id", "")
                if scene_id == "":
                    continue

                scenes = self._scene_index[split]
                s = scenes.get(scene_id)
                if s is None:
                    s = SceneSummary(
                        scene_id=scene_id,
                        split=split,
                        city=row.get("city") or None,
                        intersect_id=row.get("intersect_id") or None,
                        intersect_label=intersection_label(row.get("intersect_id") or None),
                        by_modality={},
                    )
                    scenes[scene_id] = s

                s.city = s.city or (row.get("city") or None)
                s.intersect_id = s.intersect_id or (row.get("intersect_id") or None)
                s.intersect_label = s.intersect_label or intersection_label(s.intersect_id)

                s.by_modality[modality] = {
                    "rows": int(row.get("rows") or 0),
                    "min_ts": safe_float(row.get("min_ts")),
                    "max_ts": safe_float(row.get("max_ts")),
                    "unique_ts": int(row.get("unique_ts") or 0),
                    "duration_s": safe_float(row.get("duration_s")),
                    "unique_agents": int(row.get("unique_agents") or 0) if (row.get("unique_agents") not in (None, "")) else None,
                }

        for split, scenes in self._scene_index.items():
            for s in scenes.values():
                if s.intersect_id:
                    self._intersections[split][s.intersect_id] += 1

    @staticmethod
    def _iter_scene_csv_files(base: Path, split: str) -> List[Path]:
        out: List[Path] = []
        roots = [base / split / "data", base / split]
        seen: set[str] = set()
        for root in roots:
            if not root.exists() or not root.is_dir():
                continue
            files = list(root.glob("*.csv"))
            # Fallback for uncommon nested layouts.
            if not files:
                files = list(root.rglob("*.csv"))
            for p in files:
                if not p.is_file():
                    continue
                k = str(p)
                if k in seen:
                    continue
                seen.add(k)
                out.append(p)
        out.sort(key=lambda p: p.name)
        return out

    @staticmethod
    def _read_scene_meta_from_file(path: Path) -> Tuple[Optional[str], Optional[str]]:
        try:
            with path.open("r", newline="") as f:
                r = csv.DictReader(f)
                row = next(r, None)
        except Exception:
            return None, None
        if not isinstance(row, dict):
            return None, None
        city = str(row.get("city") or "").strip() or None
        intersect_id = str(row.get("intersect_id") or "").strip() or None
        return city, intersect_id

    def _load_scenes_from_dirs(self) -> None:
        base = self.spec.root
        modality_roots: Dict[str, Optional[Path]] = {
            "ego": self._binding_dir("traj_ego") or (base / "ego-trajectories"),
            "infra": self._binding_dir("traj_infra") or (base / "infrastructure-trajectories"),
            "vehicle": self._binding_dir("traj_vehicle") or (base / "vehicle-trajectories"),
            "traffic_light": self._binding_dir("traffic_light") or (base / "traffic-light"),
        }

        for split in ("train", "val"):
            scenes = self._scene_index[split]
            for modality, mod_root in modality_roots.items():
                if mod_root is None or not mod_root.exists() or not mod_root.is_dir():
                    continue
                for p in self._iter_scene_csv_files(mod_root, split):
                    scene_id = str(p.stem or "").strip()
                    if not scene_id:
                        continue
                    s = scenes.get(scene_id)
                    if s is None:
                        s = SceneSummary(
                            scene_id=scene_id,
                            split=split,
                            city=None,
                            intersect_id=None,
                            intersect_label=None,
                            by_modality={},
                        )
                        scenes[scene_id] = s

                    if s.city is None or s.intersect_id is None:
                        city, intersect_id = self._read_scene_meta_from_file(p)
                        if s.city is None and city:
                            s.city = city
                        if s.intersect_id is None and intersect_id:
                            s.intersect_id = intersect_id
                            s.intersect_label = intersection_label(intersect_id)

                    s.by_modality[modality] = {
                        "rows": 0,
                        "min_ts": None,
                        "max_ts": None,
                        "unique_ts": 0,
                        "duration_s": None,
                        "unique_agents": None,
                    }

        for split, scenes in self._scene_index.items():
            for s in scenes.values():
                if s.intersect_id:
                    self._intersections[split][s.intersect_id] += 1

    def list_intersections(self, split: str) -> List[Dict[str, Any]]:
        c = self._intersections.get(split, Counter())
        return [{"intersect_id": k, "intersect_label": intersection_label(k), "count": v} for k, v in c.most_common()]

    def _scene_included_in_list(self, s: SceneSummary, include_tl_only: bool) -> bool:
        # Base behavior: include every indexed scene.
        return True

    @staticmethod
    def _availability_from_scenes(scenes: List[SceneSummary]) -> Dict[str, Any]:
        by_modality: Counter = Counter()
        for s in scenes:
            for m in (s.by_modality or {}).keys():
                by_modality[str(m)] += 1
        return {
            "scene_count": len(scenes),
            "by_modality": dict(by_modality),
        }

    def list_scenes(
        self,
        split: str,
        intersect_id: Optional[str] = None,
        limit: int = 200,
        offset: int = 0,
        include_tl_only: bool = False,
    ) -> Dict[str, Any]:
        scenes = list(self._scene_index.get(split, {}).values())
        if intersect_id:
            scenes = [s for s in scenes if s.intersect_id == intersect_id]
        scenes = [s for s in scenes if self._scene_included_in_list(s, include_tl_only=include_tl_only)]
        scenes.sort(key=lambda s: self._scene_sort_key(s.scene_id))
        total = len(scenes)
        slice_ = scenes[offset : offset + limit]

        items = []
        for s in slice_:
            items.append(
                {
                    "scene_id": s.scene_id,
                    "split": s.split,
                    "city": s.city,
                    "intersect_id": s.intersect_id,
                    "intersect_label": s.intersect_label,
                    "by_modality": s.by_modality,
                }
            )

        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "items": items,
            "availability": self._availability_from_scenes(scenes),
            "include_tl_only": bool(include_tl_only),
        }

    def locate_scene(self, split: str, scene_id: str) -> Dict[str, Any]:
        scene_id = str(scene_id)
        scenes_by_id = self._scene_index.get(split, {})
        s = scenes_by_id.get(scene_id)
        if s is None:
            return {"split": split, "scene_id": scene_id, "found": False}

        iid = s.intersect_id
        idx_all = self._scene_id_to_index.get(split, {}).get(scene_id)
        idx_in = None
        total_in = None
        if iid:
            idx_in = self._scene_id_to_index_by_intersect.get(split, {}).get(iid, {}).get(scene_id)
            total_in = len(self._sorted_scene_ids_by_intersect.get(split, {}).get(iid, []))

        return {
            "split": split,
            "scene_id": scene_id,
            "found": True,
            "city": s.city,
            "intersect_id": iid,
            "intersect_label": s.intersect_label,
            "index_all": idx_all,
            "total_all": len(self._sorted_scene_ids.get(split, [])),
            "index_in_intersection": idx_in,
            "total_in_intersection": total_in,
        }

    def _scene_file(self, modality: str, split: str, scene_id: str) -> Path:
        base = self.spec.root
        if modality == "ego":
            bound = self._binding_dir("traj_ego")
            if bound:
                return self._resolve_scene_csv_from_base(bound, split, scene_id)
            return base / "ego-trajectories" / split / "data" / f"{scene_id}.csv"
        if modality == "infra":
            bound = self._binding_dir("traj_infra")
            if bound:
                return self._resolve_scene_csv_from_base(bound, split, scene_id)
            return base / "infrastructure-trajectories" / split / "data" / f"{scene_id}.csv"
        if modality == "vehicle":
            bound = self._binding_dir("traj_vehicle")
            if bound:
                return self._resolve_scene_csv_from_base(bound, split, scene_id)
            return base / "vehicle-trajectories" / split / "data" / f"{scene_id}.csv"
        if modality == "traffic_light":
            bound = self._binding_dir("traffic_light")
            if bound:
                return self._resolve_scene_csv_from_base(bound, split, scene_id)
            return base / "traffic-light" / split / "data" / f"{scene_id}.csv"
        raise ValueError(f"unknown modality: {modality}")

    def _load_traj_csv(self, path: Path) -> Tuple[Dict[int, List[Dict[str, Any]]], Dict[str, float], Dict[str, Any]]:
        by_ts: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        extent = bbox_init()
        meta: Dict[str, Any] = {"city": None, "intersect_id": None}

        if not path.exists():
            return {}, extent, meta

        with path.open("r", newline="") as f:
            r = csv.DictReader(f)
            for row in r:
                ts_key = parse_ts_100ms(row.get("timestamp"))
                if ts_key is None:
                    continue
                x = safe_float(row.get("x"))
                y = safe_float(row.get("y"))
                if x is not None and y is not None:
                    bbox_update(extent, x, y)

                if meta["city"] is None:
                    meta["city"] = (row.get("city") or None)
                if meta["intersect_id"] is None:
                    meta["intersect_id"] = (row.get("intersect_id") or None)

                rec = {
                    "id": row.get("id"),
                    "type": row.get("type"),
                    "sub_type": row.get("sub_type"),
                    "tag": row.get("tag"),
                    "x": x,
                    "y": y,
                    "z": safe_float(row.get("z")),
                    "length": safe_float(row.get("length")),
                    "width": safe_float(row.get("width")),
                    "height": safe_float(row.get("height")),
                    "theta": safe_float(row.get("theta")),
                    "v_x": safe_float(row.get("v_x")),
                    "v_y": safe_float(row.get("v_y")),
                }
                by_ts[ts_key].append(rec)

        return by_ts, extent, meta

    def _load_traffic_light_csv(self, path: Path) -> Tuple[Dict[int, List[Dict[str, Any]]], Dict[str, float], Dict[str, Any]]:
        by_ts: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        extent = bbox_init()
        meta: Dict[str, Any] = {"city": None, "intersect_id": None}

        if not path.exists():
            return {}, extent, meta

        with path.open("r", newline="") as f:
            r = csv.DictReader(f)
            for row in r:
                ts_key = parse_ts_100ms(row.get("timestamp"))
                if ts_key is None:
                    continue
                x = safe_float(row.get("x"))
                y = safe_float(row.get("y"))
                if x is not None and y is not None:
                    bbox_update(extent, x, y)

                if meta["city"] is None:
                    meta["city"] = (row.get("city") or None)
                if meta["intersect_id"] is None:
                    meta["intersect_id"] = (row.get("intersect_id") or None)

                rec = {
                    "x": x,
                    "y": y,
                    "direction": row.get("direction"),
                    "lane_id": row.get("lane_id"),
                    "color_1": row.get("color_1"),
                    "remain_1": safe_float(row.get("remain_1")),
                    "color_2": row.get("color_2"),
                    "remain_2": safe_float(row.get("remain_2")),
                    "color_3": row.get("color_3"),
                    "remain_3": safe_float(row.get("remain_3")),
                }
                by_ts[ts_key].append(rec)

        return by_ts, extent, meta

    def _load_csv_cached(
        self, kind: str, path: Path
    ) -> Tuple[Dict[int, List[Dict[str, Any]]], Dict[str, float], Dict[str, Any]]:
        """
        Cache parsed CSVs so UI tweaks (map padding/step/clip, playback) don't re-read from disk.
        kind: "traj" or "traffic_light"
        """
        key = (kind, str(path))
        cached = self._csv_cache.get(key)
        if cached is not None:
            return cached
        if kind == "traj":
            val = self._load_traj_csv(path)
        elif kind == "traffic_light":
            val = self._load_traffic_light_csv(path)
        else:
            raise ValueError(f"unknown csv kind: {kind}")
        self._csv_cache.set(key, val)
        return val

    def _load_map_parsed(self, map_id: int, points_step: int) -> Dict[str, Any]:
        key = (map_id, points_step)
        cached = self._map_cache.get(key)
        if cached is not None:
            return cached

        maps_dir = self._binding_dir("maps_dir") or (self.spec.root / "maps")
        candidates = list(maps_dir.glob(f"*hdmap{map_id}.json"))
        if not candidates:
            raise FileNotFoundError(f"map file for map_id={map_id} not found in {maps_dir}")
        map_path = candidates[0]

        data = json.loads(map_path.read_text())
        counts = {
            "LANE": len(data.get("LANE") or {}),
            "STOPLINE": len(data.get("STOPLINE") or {}),
            "CROSSWALK": len(data.get("CROSSWALK") or {}),
            "JUNCTION": len(data.get("JUNCTION") or {}),
        }

        def parse_polyline(points: Any) -> List[Tuple[float, float]]:
            if not isinstance(points, list):
                return []
            if not points:
                return []

            # Downsample, but keep small features intact (stoplines/crosswalks/junction polygons)
            # and always keep endpoints so geometry doesn't get truncated.
            if points_step <= 1 or len(points) <= max(12, points_step * 2):
                idxs = list(range(len(points)))
            else:
                idxs = list(range(0, len(points), points_step))
                last = len(points) - 1
                if idxs[-1] != last:
                    idxs.append(last)

            out: List[Tuple[float, float]] = []
            for i in idxs:
                xy = parse_point_xy(points[i])
                if xy is None:
                    continue
                out.append(xy)

            # Ensure we can actually draw a line if the source had >= 2 points.
            if len(out) == 1 and len(points) >= 2:
                xy_last = parse_point_xy(points[-1])
                if xy_last is not None and xy_last != out[0]:
                    out.append(xy_last)

            return out

        def feature_bbox(points: List[Tuple[float, float]]) -> Dict[str, float]:
            b = bbox_init()
            for x, y in points:
                bbox_update(b, x, y)
            return b

        def lane_polygon(left: List[Tuple[float, float]], right: List[Tuple[float, float]]) -> List[Tuple[float, float]]:
            if len(left) < 2 or len(right) < 2:
                return []
            poly = list(left) + list(reversed(right))
            if len(poly) < 3:
                return []
            if poly[0] != poly[-1]:
                poly.append(poly[0])
            return poly

        lanes_out: List[Dict[str, Any]] = []
        for lane_id, lane in (data.get("LANE") or {}).items():
            if not isinstance(lane, dict):
                continue
            cl = parse_polyline(lane.get("centerline"))
            if not cl:
                continue
            left = parse_polyline(lane.get("left_boundary"))
            right = parse_polyline(lane.get("right_boundary"))
            poly = parse_polyline(lane.get("polygon"))
            if len(poly) < 3:
                poly = lane_polygon(left, right)
            lane_geom = poly if len(poly) >= 3 else cl
            lanes_out.append(
                {
                    "id": lane_id,
                    "lane_type": lane.get("lane_type"),
                    "turn_direction": lane.get("turn_direction"),
                    "is_intersection": lane.get("is_intersection"),
                    "has_traffic_control": lane.get("has_traffic_control"),
                    "centerline": cl,
                    "left_boundary": left,
                    "right_boundary": right,
                    "polygon": poly,
                    "bbox": feature_bbox(lane_geom),
                }
            )

        stoplines_out: List[Dict[str, Any]] = []
        for sid, obj in (data.get("STOPLINE") or {}).items():
            if not isinstance(obj, dict):
                continue
            cl = parse_polyline(obj.get("centerline"))
            if not cl:
                continue
            stoplines_out.append({"id": sid, "centerline": cl, "bbox": feature_bbox(cl)})

        crosswalks_out: List[Dict[str, Any]] = []
        for cid, obj in (data.get("CROSSWALK") or {}).items():
            if not isinstance(obj, dict):
                continue
            poly = parse_polyline(obj.get("polygon"))
            if not poly:
                continue
            crosswalks_out.append({"id": cid, "polygon": poly, "bbox": feature_bbox(poly)})

        junctions_out: List[Dict[str, Any]] = []
        for jid, obj in (data.get("JUNCTION") or {}).items():
            if not isinstance(obj, dict):
                continue
            poly = parse_polyline(obj.get("polygon"))
            if not poly:
                continue
            junctions_out.append({"id": jid, "polygon": poly, "bbox": feature_bbox(poly)})

        parsed = {
            "map_id": map_id,
            "map_file": map_path.name,
            "counts": counts,
            "lanes": lanes_out,
            "stoplines": stoplines_out,
            "crosswalks": crosswalks_out,
            "junctions": junctions_out,
        }

        # Overall bbox from all parsed features (in world coords)
        map_bbox = bbox_init()
        for lane in lanes_out:
            bbox_update_from_bbox(map_bbox, lane["bbox"])
        for feat in stoplines_out:
            bbox_update_from_bbox(map_bbox, feat["bbox"])
        for feat in crosswalks_out:
            bbox_update_from_bbox(map_bbox, feat["bbox"])
        for feat in junctions_out:
            bbox_update_from_bbox(map_bbox, feat["bbox"])
        parsed["bbox"] = map_bbox if bbox_is_valid(map_bbox) else None

        self._map_cache[key] = parsed
        return parsed

    def _clip_map_features(
        self,
        parsed_map: Dict[str, Any],
        extent: Dict[str, float],
        max_lanes: int,
        focus_xy: Optional[Tuple[float, float]] = None,
    ) -> Dict[str, Any]:
        lanes = [lane for lane in parsed_map["lanes"] if bbox_intersects(lane["bbox"], extent)]

        lanes_truncated = False
        if max_lanes and len(lanes) > max_lanes:
            # Keep the lanes closest to the focus point (defaults to clip extent center).
            if focus_xy:
                cx, cy = focus_xy
            else:
                cx = (extent["min_x"] + extent["max_x"]) / 2.0
                cy = (extent["min_y"] + extent["max_y"]) / 2.0

            def dist2(l: Dict[str, Any]) -> float:
                b = l["bbox"]
                mx = (b["min_x"] + b["max_x"]) / 2.0
                my = (b["min_y"] + b["max_y"]) / 2.0
                dx = mx - cx
                dy = my - cy
                return dx * dx + dy * dy

            lanes.sort(key=dist2)
            lanes = lanes[:max_lanes]
            lanes_truncated = True

        def clip_features(key: str) -> List[Dict[str, Any]]:
            out = []
            for feat in parsed_map[key]:
                if bbox_intersects(feat["bbox"], extent):
                    out.append(feat)
            return out

        return {
            "map_id": parsed_map["map_id"],
            "map_file": parsed_map["map_file"],
            "lanes_truncated": lanes_truncated,
            "lanes": [
                {
                    "id": l["id"],
                    "lane_type": l["lane_type"],
                    "turn_direction": l["turn_direction"],
                    "is_intersection": l["is_intersection"],
                    "has_traffic_control": l["has_traffic_control"],
                    "centerline": l["centerline"],
                    "left_boundary": l.get("left_boundary") or [],
                    "right_boundary": l.get("right_boundary") or [],
                    "polygon": l.get("polygon") or [],
                }
                for l in lanes
            ],
            "stoplines": [{"id": s["id"], "centerline": s["centerline"]} for s in clip_features("stoplines")],
            "crosswalks": [{"id": c["id"], "polygon": c["polygon"]} for c in clip_features("crosswalks")],
            "junctions": [{"id": j["id"], "polygon": j["polygon"]} for j in clip_features("junctions")],
        }

    def load_scene_bundle(
        self,
        split: str,
        scene_id: str,
        include_map: bool = True,
        map_padding: float = 60.0,
        map_points_step: int = 5,
        max_lanes: int = 4000,
        map_clip: str = "intersection",
    ) -> Dict[str, Any]:
        warnings: List[str] = []
        ego_path = self._scene_file("ego", split, scene_id)
        infra_path = self._scene_file("infra", split, scene_id)
        veh_path = self._scene_file("vehicle", split, scene_id)
        tl_path = self._scene_file("traffic_light", split, scene_id)

        if not ego_path.exists():
            warnings.append("ego_missing_file")
        if not infra_path.exists():
            warnings.append("infra_missing_file")
        if not veh_path.exists():
            warnings.append("vehicle_missing_file")

        ego_by_ts, ego_extent, ego_meta = self._load_csv_cached("traj", ego_path)
        infra_by_ts, infra_extent, infra_meta = self._load_csv_cached("traj", infra_path)
        veh_by_ts, veh_extent, veh_meta = self._load_csv_cached("traj", veh_path)
        tl_by_ts, tl_extent, tl_meta = self._load_csv_cached("traffic_light", tl_path)

        # Meta resolution: prefer ego, then infra/vehicle/traffic-light.
        city = ego_meta.get("city") or infra_meta.get("city") or veh_meta.get("city") or tl_meta.get("city")
        intersect_id = ego_meta.get("intersect_id") or infra_meta.get("intersect_id") or veh_meta.get("intersect_id") or tl_meta.get("intersect_id")

        intersect_by_modality = {
            "ego": ego_meta.get("intersect_id"),
            "infra": infra_meta.get("intersect_id"),
            "vehicle": veh_meta.get("intersect_id"),
            "traffic_light": tl_meta.get("intersect_id"),
        }
        uniq_intersects = {v for v in intersect_by_modality.values() if v}
        if len(uniq_intersects) > 1:
            warnings.append("intersect_id_mismatch_across_modalities")
        map_id = parse_intersect_to_map_id(intersect_id or "")

        # Extent union
        extent = bbox_init()
        for b in [ego_extent, infra_extent, veh_extent, tl_extent]:
            if bbox_is_valid(b):
                bbox_update(extent, b["min_x"], b["min_y"])
                bbox_update(extent, b["max_x"], b["max_y"])

        if not bbox_is_valid(extent):
            extent = {"min_x": 0.0, "min_y": 0.0, "max_x": 1.0, "max_y": 1.0}
            warnings.append("extent_missing: could not compute extent from scene files")

        # Union timestamps (100ms ticks)
        ts_keys = set(ego_by_ts.keys()) | set(infra_by_ts.keys()) | set(veh_by_ts.keys()) | set(tl_by_ts.keys())
        ts_sorted = sorted(ts_keys)

        # If there are no timestamps, avoid crash.
        if not ts_sorted:
            warnings.append("no_timestamps: scene appears empty across all modalities")

        frames = []
        for k in ts_sorted:
            frames.append(
                {
                    "ego": ego_by_ts.get(k, []),
                    "infra": infra_by_ts.get(k, []),
                    "vehicle": veh_by_ts.get(k, []),
                    "traffic_light": tl_by_ts.get(k, []),
                }
            )

        timestamps = [ts_100ms_to_float(k) for k in ts_sorted]
        t0 = timestamps[0] if timestamps else None

        def stats_for(by_ts: Dict[int, List[Dict[str, Any]]]) -> Dict[str, Any]:
            if not by_ts:
                return {"rows": 0, "unique_ts": 0, "min_ts": None, "max_ts": None}
            keys = sorted(by_ts.keys())
            rows = sum(len(v) for v in by_ts.values())
            return {
                "rows": rows,
                "unique_ts": len(keys),
                "min_ts": ts_100ms_to_float(keys[0]),
                "max_ts": ts_100ms_to_float(keys[-1]),
            }

        modality_stats = {
            "ego": stats_for(ego_by_ts),
            "infra": stats_for(infra_by_ts),
            "vehicle": stats_for(veh_by_ts),
            "traffic_light": stats_for(tl_by_ts),
        }

        if not tl_path.exists():
            warnings.append("traffic_light_missing_file")
        elif modality_stats["traffic_light"]["rows"] == 0:
            warnings.append("traffic_light_empty")

        # Common issue: traffic light timestamps start/end offset by ~0.1s vs trajectories.
        ref_mod = None
        for candidate in ["ego", "vehicle", "infra"]:
            if modality_stats.get(candidate, {}).get("min_ts") is not None:
                ref_mod = candidate
                break
        if ref_mod and modality_stats.get("traffic_light", {}).get("min_ts") is not None:
            a = modality_stats[ref_mod]
            b = modality_stats["traffic_light"]
            d_min = round(float(b["min_ts"]) - float(a["min_ts"]), 3)
            d_max = round(float(b["max_ts"]) - float(a["max_ts"]), 3)
            if abs(d_min) >= 0.05:
                warnings.append(f"traffic_light_min_ts_offset_vs_{ref_mod}:{d_min}s")
            if abs(d_max) >= 0.05:
                warnings.append(f"traffic_light_max_ts_offset_vs_{ref_mod}:{d_max}s")

        out: Dict[str, Any] = {
            "dataset_id": self.spec.id,
            "split": split,
            "scene_id": scene_id,
            "city": city,
            "intersect_id": intersect_id,
            "intersect_label": intersection_label(intersect_id),
            "intersect_by_modality": intersect_by_modality,
            "map_id": map_id,
            "t0": t0,
            "timestamps": timestamps,
            "extent": extent,
            "modality_stats": modality_stats,
            "frames": frames,
            "warnings": warnings,
        }

        if include_map and map_id is not None:
            try:
                parsed_map = self._load_map_parsed(map_id=map_id, points_step=map_points_step)

                clip_mode = (map_clip or "intersection").strip().lower()
                if clip_mode not in ("scene", "intersection"):
                    clip_mode = "intersection"

                if clip_mode == "scene":
                    clip_extent = bbox_pad(extent, map_padding)
                else:
                    # Prefer full intersection context by default.
                    base = parsed_map.get("bbox")
                    clip_extent = bbox_pad(base, map_padding) if base else bbox_pad(extent, map_padding)

                focus_xy = ((extent["min_x"] + extent["max_x"]) / 2.0, (extent["min_y"] + extent["max_y"]) / 2.0)
                out["map"] = self._clip_map_features(parsed_map, clip_extent, max_lanes=max_lanes, focus_xy=focus_xy)
                out["map"]["clip_mode"] = clip_mode
                out["map"]["clip_extent"] = clip_extent
                out["map"]["points_step"] = map_points_step
                out["map"]["bbox"] = parsed_map.get("bbox")
                out["map"]["counts"] = parsed_map.get("counts")
                out["map"]["map_file"] = parsed_map.get("map_file")

                map_bbox = parsed_map.get("bbox")
                if map_bbox and bbox_is_valid(map_bbox):
                    if not bbox_intersects(map_bbox, extent):
                        warnings.append("scene_outside_map_bbox")
                    # Center-in-bbox check helps debug bad map_id mapping.
                    cx, cy = focus_xy
                    if not (map_bbox["min_x"] <= cx <= map_bbox["max_x"] and map_bbox["min_y"] <= cy <= map_bbox["max_y"]):
                        warnings.append("scene_center_outside_map_bbox")
            except Exception as e:
                warnings.append(f"map_load_failed: {e}")

        return out


class V2XSeqAdapter(V2XTrajAdapter):
    """
    Adapter for V2X-Seq trajectory forecasting subset.

    Notes:
    - This dataset family is kept separate from V2X-Traj.
    - We discover trajectory / traffic-light roles by schema so directory
      name inconsistencies do not break loading.
    - Scene unit is the native CSV clip (scene_id = file stem).
    """

    _SPLITS = ("train", "val")

    def __init__(self, spec: DatasetSpec) -> None:
        self._scene_files: Dict[str, Dict[str, Dict[str, Path]]] = {"train": {}, "val": {}}
        self._roots_by_modality: Dict[str, List[Path]] = {"ego": [], "infra": [], "vehicle": [], "traffic_light": []}
        self._csv_kind_cache: Dict[str, str] = {}
        self._tl_scene_path_cache: Dict[Tuple[str, str], Optional[Path]] = {}
        super().__init__(spec)

    @staticmethod
    def _norm_col(s: Any) -> str:
        return re.sub(r"[^a-z0-9]+", "", str(s or "").strip().lower())

    def _detect_csv_kind(self, path: Path) -> str:
        """
        Return one of: trajectory, traffic_light, unknown.
        """
        key = str(path)
        cached = self._csv_kind_cache.get(key)
        if cached is not None:
            return cached

        kind = "unknown"
        try:
            with path.open("r", newline="") as f:
                r = csv.reader(f)
                header = next(r, [])
            cols = {self._norm_col(x) for x in header}
            if {"timestamp", "id", "type", "x", "y", "vx", "vy"}.issubset(cols):
                kind = "trajectory"
            elif {"timestamp", "laneid", "color1", "remain1"}.issubset(cols):
                kind = "traffic_light"
        except Exception:
            kind = "unknown"

        self._csv_kind_cache[key] = kind
        return kind

    def _sample_scene_csv_files(self, root: Path, split: str, limit: int = 4) -> List[Path]:
        out: List[Path] = []
        if limit <= 0:
            return out
        seen: set[str] = set()
        roots = [root / split / "data", root / split]
        for base in roots:
            if not base.exists() or not base.is_dir():
                continue

            found_direct = False
            for p in base.glob("*.csv"):
                if not p.is_file():
                    continue
                found_direct = True
                k = str(p)
                if k in seen:
                    continue
                seen.add(k)
                out.append(p)
                if len(out) >= limit:
                    return out

            # Fall back to nested search only when this split folder has no direct files.
            if found_direct:
                continue
            for p in base.rglob("*.csv"):
                if not p.is_file():
                    continue
                k = str(p)
                if k in seen:
                    continue
                seen.add(k)
                out.append(p)
                if len(out) >= limit:
                    return out
        return out

    @staticmethod
    def _scene_file_in_roots(roots: List[Path], split: str, scene_id: str) -> Optional[Path]:
        filename = f"{scene_id}.csv"
        for root in roots:
            candidates = [root / split / "data" / filename, root / split / filename, root / filename]
            for p in candidates:
                if p.exists() and p.is_file():
                    return p
        return None

    def _infer_dir_kind(self, root: Path) -> str:
        if not root.exists() or not root.is_dir():
            return "unknown"
        counts: Counter = Counter()
        # Sample a small set per split (fast and sufficient for schema detection).
        for split in self._SPLITS:
            for p in self._sample_scene_csv_files(root, split, limit=4):
                counts[self._detect_csv_kind(p)] += 1
        if not counts:
            return "unknown"
        kind, n = counts.most_common(1)[0]
        if kind == "unknown" or n <= 0:
            return "unknown"
        return str(kind)

    def _resolve_modality_roots(self) -> Dict[str, List[Path]]:
        root = self.spec.root
        raw_candidates: List[Tuple[Optional[str], Optional[Path]]] = [
            ("ego", self._binding_dir("traj_cooperative")),
            ("infra", self._binding_dir("traj_infra")),
            ("vehicle", self._binding_dir("traj_vehicle")),
            ("traffic_light", self._binding_dir("traffic_light")),
            ("infra", root / "single-infrastructure" / "trajectories"),
            ("vehicle", root / "single-vehicle" / "trajectories"),
            ("ego", root / "cooperative-vehicle-infrastructure" / "cooperative-trajectories"),
            # Some local copies split cooperative data into infra/vehicle dirs.
            ("ego", root / "cooperative-vehicle-infrastructure" / "infrastructure-trajectories"),
            ("ego", root / "cooperative-vehicle-infrastructure" / "vehicle-trajectories"),
            ("traffic_light", root / "single-infrastructure" / "traffic-light"),
            # In some local copies this folder contains trajectory clips.
            ("ego", root / "cooperative-vehicle-infrastructure" / "traffic-light"),
        ]

        out: Dict[str, List[Path]] = {"ego": [], "infra": [], "vehicle": [], "traffic_light": []}
        seen: set[str] = set()
        for hinted_modality, p in raw_candidates:
            if p is None:
                continue
            try:
                rp = p.resolve()
            except Exception:
                continue
            if not rp.exists() or not rp.is_dir():
                continue
            k = str(rp)
            if k in seen:
                continue
            seen.add(k)

            kind = self._infer_dir_kind(rp)
            if kind == "trajectory":
                target = hinted_modality if hinted_modality in ("ego", "infra", "vehicle") else "ego"
                # Keep V2X-Seq modality semantics aligned with official subsets:
                # cooperative / single-infrastructure / single-vehicle.
                if "cooperative-vehicle-infrastructure" in k.lower():
                    target = "ego"
                out[target].append(rp)
            elif kind == "traffic_light":
                out["traffic_light"].append(rp)

        return out

    def _load_scenes_from_dirs(self) -> None:
        self._roots_by_modality = self._resolve_modality_roots()
        tl_roots = list(self._roots_by_modality.get("traffic_light", []))

        for split in self._SPLITS:
            scenes = self._scene_index[split]
            self._scene_files[split] = {}
            scene_files = self._scene_files[split]

            # Index trajectory scene clips first; this is the primary scene universe.
            for modality in ("ego", "infra", "vehicle"):
                for mod_root in self._roots_by_modality.get(modality, []):
                    for p in self._iter_scene_csv_files(mod_root, split):
                        scene_id = str(p.stem or "").strip()
                        if not scene_id:
                            continue
                        if self._detect_csv_kind(p) != "trajectory":
                            continue

                        files_for_scene = scene_files.setdefault(scene_id, {})
                        if modality not in files_for_scene:
                            files_for_scene[modality] = p

                        s = scenes.get(scene_id)
                        if s is None:
                            s = SceneSummary(
                                scene_id=scene_id,
                                split=split,
                                city=None,
                                intersect_id=None,
                                intersect_label=None,
                                by_modality={},
                            )
                            scenes[scene_id] = s

                        if modality not in s.by_modality:
                            s.by_modality[modality] = {
                                "rows": 0,
                                "min_ts": None,
                                "max_ts": None,
                                "unique_ts": 0,
                                "duration_s": None,
                                "unique_agents": None,
                            }

            # Attach traffic-light modality only for already indexed scenes.
            for scene_id, s in scenes.items():
                tl_path = self._scene_file_in_roots(tl_roots, split, scene_id)
                self._tl_scene_path_cache[(split, scene_id)] = tl_path
                if tl_path is None:
                    continue
                scene_files.setdefault(scene_id, {})["traffic_light"] = tl_path
                if "traffic_light" not in s.by_modality:
                    s.by_modality["traffic_light"] = {
                        "rows": 0,
                        "min_ts": None,
                        "max_ts": None,
                        "unique_ts": 0,
                        "duration_s": None,
                        "unique_agents": None,
                    }

            # Read metadata at most once per scene from one available clip.
            for scene_id, s in scenes.items():
                if s.city is not None and s.intersect_id is not None:
                    continue
                files_for_scene = scene_files.get(scene_id, {})
                sample = (
                    files_for_scene.get("infra")
                    or files_for_scene.get("ego")
                    or files_for_scene.get("vehicle")
                    or files_for_scene.get("traffic_light")
                )
                if sample is None:
                    continue
                city, intersect_id = self._read_scene_meta_from_file(sample)
                if s.city is None and city:
                    s.city = city
                if s.intersect_id is None and intersect_id:
                    s.intersect_id = intersect_id
                    s.intersect_label = intersection_label(intersect_id)

        for split, scenes in self._scene_index.items():
            for s in scenes.values():
                if s.intersect_id:
                    self._intersections[split][s.intersect_id] += 1

    def _scene_included_in_list(self, s: SceneSummary, include_tl_only: bool) -> bool:
        mods = set((s.by_modality or {}).keys())
        if include_tl_only:
            return "traffic_light" in mods
        return bool({"ego", "infra", "vehicle"} & mods)

    def _scene_file(self, modality: str, split: str, scene_id: str) -> Path:
        p = self._scene_files.get(split, {}).get(scene_id, {}).get(modality)
        if p is not None:
            return p
        if modality == "traffic_light":
            key = (split, scene_id)
            if key not in self._tl_scene_path_cache:
                tl_roots = list(self._roots_by_modality.get("traffic_light", []))
                self._tl_scene_path_cache[key] = self._scene_file_in_roots(tl_roots, split, scene_id)
            cached = self._tl_scene_path_cache.get(key)
            if cached is not None:
                self._scene_files.setdefault(split, {}).setdefault(scene_id, {})["traffic_light"] = cached
                return cached
        return self.spec.root / "__missing__" / split / f"{scene_id}_{modality}.csv"

    def load_scene_bundle(
        self,
        split: str,
        scene_id: str,
        include_map: bool = True,
        map_padding: float = 60.0,
        map_points_step: int = 5,
        max_lanes: int = 4000,
        map_clip: str = "intersection",
    ) -> Dict[str, Any]:
        warnings: List[str] = []

        ego_path = self._scene_file("ego", split, scene_id)
        infra_path = self._scene_file("infra", split, scene_id)
        veh_path = self._scene_file("vehicle", split, scene_id)
        tl_path = self._scene_file("traffic_light", split, scene_id)

        traj_paths = (ego_path, infra_path, veh_path)
        if not any(p.exists() for p in traj_paths):
            warnings.append("no_trajectory_modalities")

        ego_by_ts, ego_extent, ego_meta = self._load_csv_cached("traj", ego_path)
        infra_by_ts, infra_extent, infra_meta = self._load_csv_cached("traj", infra_path)
        veh_by_ts, veh_extent, veh_meta = self._load_csv_cached("traj", veh_path)
        tl_by_ts, tl_extent, tl_meta = self._load_csv_cached("traffic_light", tl_path)

        city = ego_meta.get("city") or infra_meta.get("city") or veh_meta.get("city") or tl_meta.get("city")
        intersect_id = (
            ego_meta.get("intersect_id")
            or infra_meta.get("intersect_id")
            or veh_meta.get("intersect_id")
            or tl_meta.get("intersect_id")
        )

        intersect_by_modality = {
            "ego": ego_meta.get("intersect_id"),
            "infra": infra_meta.get("intersect_id"),
            "vehicle": veh_meta.get("intersect_id"),
            "traffic_light": tl_meta.get("intersect_id"),
        }
        uniq_intersects = {v for v in intersect_by_modality.values() if v}
        if len(uniq_intersects) > 1:
            warnings.append("intersect_id_mismatch_across_modalities")
        map_id = parse_intersect_to_map_id(intersect_id or "")

        extent = bbox_init()
        for b in [ego_extent, infra_extent, veh_extent, tl_extent]:
            if bbox_is_valid(b):
                bbox_update(extent, b["min_x"], b["min_y"])
                bbox_update(extent, b["max_x"], b["max_y"])

        if not bbox_is_valid(extent):
            extent = {"min_x": 0.0, "min_y": 0.0, "max_x": 1.0, "max_y": 1.0}
            warnings.append("extent_missing: could not compute extent from scene files")

        ts_keys = set(ego_by_ts.keys()) | set(infra_by_ts.keys()) | set(veh_by_ts.keys()) | set(tl_by_ts.keys())
        ts_sorted = sorted(ts_keys)
        if not ts_sorted:
            warnings.append("no_timestamps: scene appears empty across all modalities")

        frames = []
        for k in ts_sorted:
            frames.append(
                {
                    "ego": ego_by_ts.get(k, []),
                    "infra": infra_by_ts.get(k, []),
                    "vehicle": veh_by_ts.get(k, []),
                    "traffic_light": tl_by_ts.get(k, []),
                }
            )

        timestamps = [ts_100ms_to_float(k) for k in ts_sorted]
        t0 = timestamps[0] if timestamps else None

        def stats_for(by_ts: Dict[int, List[Dict[str, Any]]]) -> Dict[str, Any]:
            if not by_ts:
                return {"rows": 0, "unique_ts": 0, "min_ts": None, "max_ts": None}
            keys = sorted(by_ts.keys())
            rows = sum(len(v) for v in by_ts.values())
            return {
                "rows": rows,
                "unique_ts": len(keys),
                "min_ts": ts_100ms_to_float(keys[0]),
                "max_ts": ts_100ms_to_float(keys[-1]),
            }

        modality_stats = {
            "ego": stats_for(ego_by_ts),
            "infra": stats_for(infra_by_ts),
            "vehicle": stats_for(veh_by_ts),
            "traffic_light": stats_for(tl_by_ts),
        }

        if not tl_path.exists():
            warnings.append("traffic_light_missing_file")
        elif modality_stats["traffic_light"]["rows"] == 0:
            warnings.append("traffic_light_empty")

        ref_mod = None
        for candidate in ["ego", "infra", "vehicle"]:
            if modality_stats.get(candidate, {}).get("min_ts") is not None:
                ref_mod = candidate
                break
        if ref_mod and modality_stats.get("traffic_light", {}).get("min_ts") is not None:
            a = modality_stats[ref_mod]
            b = modality_stats["traffic_light"]
            d_min = round(float(b["min_ts"]) - float(a["min_ts"]), 3)
            d_max = round(float(b["max_ts"]) - float(a["max_ts"]), 3)
            if abs(d_min) >= 0.05:
                warnings.append(f"traffic_light_min_ts_offset_vs_{ref_mod}:{d_min}s")
            if abs(d_max) >= 0.05:
                warnings.append(f"traffic_light_max_ts_offset_vs_{ref_mod}:{d_max}s")

        out: Dict[str, Any] = {
            "dataset_id": self.spec.id,
            "split": split,
            "scene_id": scene_id,
            "city": city,
            "intersect_id": intersect_id,
            "intersect_label": intersection_label(intersect_id),
            "intersect_by_modality": intersect_by_modality,
            "map_id": map_id,
            "t0": t0,
            "timestamps": timestamps,
            "extent": extent,
            "modality_stats": modality_stats,
            "frames": frames,
            "warnings": warnings,
        }

        if include_map and map_id is not None:
            try:
                parsed_map = self._load_map_parsed(map_id=map_id, points_step=map_points_step)

                clip_mode = (map_clip or "intersection").strip().lower()
                if clip_mode not in ("scene", "intersection"):
                    clip_mode = "intersection"

                if clip_mode == "scene":
                    clip_extent = bbox_pad(extent, map_padding)
                else:
                    base = parsed_map.get("bbox")
                    clip_extent = bbox_pad(base, map_padding) if base else bbox_pad(extent, map_padding)

                focus_xy = ((extent["min_x"] + extent["max_x"]) / 2.0, (extent["min_y"] + extent["max_y"]) / 2.0)
                out["map"] = self._clip_map_features(parsed_map, clip_extent, max_lanes=max_lanes, focus_xy=focus_xy)
                out["map"]["clip_mode"] = clip_mode
                out["map"]["clip_extent"] = clip_extent
                out["map"]["points_step"] = map_points_step
                out["map"]["bbox"] = parsed_map.get("bbox")
                out["map"]["counts"] = parsed_map.get("counts")
                out["map"]["map_file"] = parsed_map.get("map_file")

                map_bbox = parsed_map.get("bbox")
                if map_bbox and bbox_is_valid(map_bbox):
                    if not bbox_intersects(map_bbox, extent):
                        warnings.append("scene_outside_map_bbox")
                    cx, cy = focus_xy
                    if not (map_bbox["min_x"] <= cx <= map_bbox["max_x"] and map_bbox["min_y"] <= cy <= map_bbox["max_y"]):
                        warnings.append("scene_center_outside_map_bbox")
            except Exception as e:
                warnings.append(f"map_load_failed: {e}")

        return out


class InDAdapter:
    """
    Adapter for inD (drone) trajectories.

    Scene model:
    - split is always "all"
    - group/intersection is inD locationId
    - scene is a fixed-duration time window inside one recording
    """

    DEFAULT_WINDOW_S = 60
    _SPLIT = "all"
    _DEFAULT_BACKGROUND_SCALE_DOWN = 12.0

    def __init__(self, spec: DatasetSpec, window_s: int | None = None) -> None:
        self.spec = spec
        self._bindings = spec.bindings if isinstance(spec.bindings, dict) else {}
        strategy = spec.scene_strategy if isinstance(spec.scene_strategy, dict) else {}
        strategy_window = strategy.get("window_s")
        self.window_s = int(window_s or strategy_window or self.DEFAULT_WINDOW_S)
        self.window_s = max(10, min(600, self.window_s))
        self.background_scale_down = safe_float(strategy.get("background_scale_down"))
        if self.background_scale_down is None or not (self.background_scale_down > 0):
            self.background_scale_down = self._DEFAULT_BACKGROUND_SCALE_DOWN
        self._lanelet_maps_by_location = self._discover_lanelet_maps()
        self._lanelet_map_cache: Dict[Tuple[str, float, float, int], Dict[str, Any]] = {}

        self._recordings: Dict[str, _IndRecordingIndex] = {}
        self._scenes: Dict[str, _IndSceneRef] = {}
        self._scene_ids_sorted: Dict[str, List[str]] = {self._SPLIT: []}
        self._scene_ids_by_location: Dict[str, Dict[str, List[str]]] = {self._SPLIT: {}}
        self._scene_index: Dict[str, Dict[str, int]] = {self._SPLIT: {}}
        self._scene_index_by_location: Dict[str, Dict[str, Dict[str, int]]] = {self._SPLIT: {}}

        self._build_index()
        if not self._scenes:
            raise ValueError("inD adapter could not discover any scenes")

    def _binding_obj(self, role: str) -> Dict[str, Any]:
        v = self._bindings.get(role) if isinstance(self._bindings, dict) else None
        return v if isinstance(v, dict) else {}

    def _binding_dir(self, role: str) -> Optional[Path]:
        obj = self._binding_obj(role)
        raw = obj.get("path")
        if raw is None and isinstance(self._bindings.get(role), str):
            raw = self._bindings.get(role)
        if not raw:
            return None
        try:
            p = Path(str(raw)).expanduser().resolve()
        except Exception:
            return None
        if p.exists() and p.is_dir():
            return p
        return p

    @staticmethod
    def _location_label(location_id: str) -> str:
        s = str(location_id or "").strip()
        if s.isdigit():
            return f"Location {int(s):02d}"
        return f"Location {s or '?'}"

    @staticmethod
    def _as_int(raw: Any) -> Optional[int]:
        v = safe_float(raw)
        if v is None:
            return None
        try:
            return int(v)
        except Exception:
            return None

    @staticmethod
    def _as_num_str(path: Path) -> Optional[Tuple[str, int]]:
        m = re.match(r"^(\d+)_tracks\.csv$", path.name)
        if not m:
            return None
        num_s = m.group(1)
        try:
            num = int(num_s)
        except Exception:
            return None
        return num_s, num

    def _discover_data_dir(self) -> Optional[Path]:
        bound = self._binding_dir("data_dir")
        if bound and bound.exists() and bound.is_dir():
            return bound
        root_data = (self.spec.root / "data").resolve()
        if root_data.exists() and root_data.is_dir():
            return root_data
        if self.spec.root.exists() and self.spec.root.is_dir():
            return self.spec.root
        return None

    def _discover_maps_dir(self) -> Optional[Path]:
        bound = self._binding_dir("maps_dir")
        candidates: List[Path] = []
        if bound is not None:
            candidates.append((bound / "lanelets").resolve())
            candidates.append(bound.resolve())
        candidates.append((self.spec.root / "maps" / "lanelets").resolve())
        candidates.append((self.spec.root / "maps").resolve())
        for p in candidates:
            if p.exists() and p.is_dir():
                return p
        return None

    def _discover_lanelet_maps(self) -> Dict[str, Dict[str, Path]]:
        root = self._discover_maps_dir()
        if root is None or not root.exists() or not root.is_dir():
            return {}
        files = sorted([p.resolve() for p in root.rglob("*.osm") if p.is_file()])
        out: Dict[str, Dict[str, Path]] = {}
        for p in files:
            stem = p.stem.lower()
            m = re.search(r"location\s*([0-9]+)", stem)
            if not m:
                continue
            loc_id = str(int(m.group(1)))
            bucket = out.setdefault(loc_id, {})
            key = "construction" if "construction" in stem else "default"
            if key not in bucket:
                bucket[key] = p
        return out

    def _lanelet_map_path_for_recording(self, rec: _IndRecordingIndex) -> Optional[Path]:
        loc = str(rec.location_id or "").strip()
        if not loc:
            return None
        bucket = self._lanelet_maps_by_location.get(loc, {})
        if not bucket:
            return None
        # inD note: location 1 uses a dedicated construction map for recordings 11..17.
        if loc == "1" and rec.recording_id_num in {11, 12, 13, 14, 15, 16, 17}:
            p = bucket.get("construction")
            if p is not None:
                return p
        return bucket.get("default") or bucket.get("construction")

    @staticmethod
    def _utm_zone_from_lon(lon: float) -> int:
        z = int((float(lon) + 180.0) / 6.0) + 1
        return max(1, min(60, z))

    @staticmethod
    def _lat_lon_to_utm(lat: float, lon: float, zone: int) -> Tuple[float, float]:
        # WGS84 -> UTM forward projection (no external dependency).
        a = 6378137.0
        f = 1.0 / 298.257223563
        e2 = f * (2.0 - f)
        ep2 = e2 / (1.0 - e2)
        k0 = 0.9996

        phi = math.radians(float(lat))
        lam = math.radians(float(lon))
        lam0 = math.radians((int(zone) - 1) * 6 - 180 + 3)

        sin_phi = math.sin(phi)
        cos_phi = math.cos(phi)
        tan_phi = math.tan(phi)
        n = a / math.sqrt(1.0 - e2 * sin_phi * sin_phi)
        t = tan_phi * tan_phi
        c = ep2 * cos_phi * cos_phi
        a_ = cos_phi * (lam - lam0)

        m = a * (
            (1.0 - e2 / 4.0 - 3.0 * e2 * e2 / 64.0 - 5.0 * e2 * e2 * e2 / 256.0) * phi
            - (3.0 * e2 / 8.0 + 3.0 * e2 * e2 / 32.0 + 45.0 * e2 * e2 * e2 / 1024.0) * math.sin(2.0 * phi)
            + (15.0 * e2 * e2 / 256.0 + 45.0 * e2 * e2 * e2 / 1024.0) * math.sin(4.0 * phi)
            - (35.0 * e2 * e2 * e2 / 3072.0) * math.sin(6.0 * phi)
        )

        easting = k0 * n * (
            a_
            + (1.0 - t + c) * (a_ ** 3) / 6.0
            + (5.0 - 18.0 * t + t * t + 72.0 * c - 58.0 * ep2) * (a_ ** 5) / 120.0
        ) + 500000.0

        northing = k0 * (
            m
            + n * tan_phi * (
                (a_ ** 2) / 2.0
                + (5.0 - t + 9.0 * c + 4.0 * c * c) * (a_ ** 4) / 24.0
                + (61.0 - 58.0 * t + t * t + 600.0 * c - 330.0 * ep2) * (a_ ** 6) / 720.0
            )
        )
        if float(lat) < 0.0:
            northing += 10000000.0
        return easting, northing

    def _lanelet_local_xy(self, rec: _IndRecordingIndex, lat: float, lon: float) -> Optional[Tuple[float, float]]:
        x0 = rec.x_utm_origin
        y0 = rec.y_utm_origin
        if x0 is None or y0 is None:
            return None
        zone_hint = self._utm_zone_from_lon(rec.lon_location if rec.lon_location is not None else lon)
        try:
            x_utm, y_utm = self._lat_lon_to_utm(lat, lon, zone=zone_hint)
        except Exception:
            return None
        return (float(x_utm) - float(x0), float(y_utm) - float(y0))

    @staticmethod
    def _resample_polyline(points: List[Tuple[float, float]], n_out: int) -> List[Tuple[float, float]]:
        if n_out <= 1:
            return points[:1]
        if len(points) <= 1:
            return points[:]
        if len(points) == n_out:
            return points[:]
        out: List[Tuple[float, float]] = []
        span = float(len(points) - 1)
        for i in range(n_out):
            t = span * (float(i) / float(n_out - 1))
            j0 = int(math.floor(t))
            j1 = min(len(points) - 1, j0 + 1)
            a = t - float(j0)
            x0, y0 = points[j0]
            x1, y1 = points[j1]
            out.append(((1.0 - a) * x0 + a * x1, (1.0 - a) * y0 + a * y1))
        return out

    @staticmethod
    def _downsample_polyline(points: List[Tuple[float, float]], step: int) -> List[Tuple[float, float]]:
        s = max(1, int(step))
        if s <= 1 or len(points) <= max(12, s * 2):
            return points
        idxs = list(range(0, len(points), s))
        last = len(points) - 1
        if idxs[-1] != last:
            idxs.append(last)
        out: List[Tuple[float, float]] = [points[i] for i in idxs]
        if len(out) < 2 and len(points) >= 2:
            out = [points[0], points[-1]]
        return out

    @staticmethod
    def _polyline_bbox(points: List[Tuple[float, float]]) -> Optional[Dict[str, float]]:
        if not points:
            return None
        b = bbox_init()
        for x, y in points:
            bbox_update(b, x, y)
        return b if bbox_is_valid(b) else None

    def _load_lanelet_map_parsed(self, rec: _IndRecordingIndex, points_step: int) -> Optional[Dict[str, Any]]:
        map_path = self._lanelet_map_path_for_recording(rec)
        if map_path is None or not map_path.exists() or not map_path.is_file():
            return None
        if rec.x_utm_origin is None or rec.y_utm_origin is None:
            return None

        step = max(1, int(points_step))
        key = (str(map_path), round(float(rec.x_utm_origin), 3), round(float(rec.y_utm_origin), 3), step)
        cached = self._lanelet_map_cache.get(key)
        if cached is not None:
            return cached

        tree = ET.parse(map_path)
        root = tree.getroot()

        nodes: Dict[str, Tuple[float, float]] = {}
        for n in root.findall("node"):
            nid = str(n.attrib.get("id") or "").strip()
            lat = safe_float(n.attrib.get("lat"))
            lon = safe_float(n.attrib.get("lon"))
            if not nid or lat is None or lon is None:
                continue
            nodes[nid] = (float(lat), float(lon))

        ways: Dict[str, List[str]] = {}
        for w in root.findall("way"):
            wid = str(w.attrib.get("id") or "").strip()
            if not wid:
                continue
            refs = [str(nd.attrib.get("ref") or "").strip() for nd in w.findall("nd")]
            ways[wid] = [r for r in refs if r]

        def _way_points(wid: Optional[str]) -> List[Tuple[float, float]]:
            if wid is None:
                return []
            refs = ways.get(wid, [])
            out_pts: List[Tuple[float, float]] = []
            for rid in refs:
                ll = nodes.get(rid)
                if ll is None:
                    continue
                xy = self._lanelet_local_xy(rec, ll[0], ll[1])
                if xy is None:
                    continue
                x, y = xy
                if out_pts and abs(x - out_pts[-1][0]) < 1e-9 and abs(y - out_pts[-1][1]) < 1e-9:
                    continue
                out_pts.append((x, y))
            return out_pts

        lanes: List[Dict[str, Any]] = []
        map_bbox = bbox_init()
        for rel in root.findall("relation"):
            tags = {str(t.attrib.get("k") or ""): str(t.attrib.get("v") or "") for t in rel.findall("tag")}
            if tags.get("type") != "lanelet":
                continue

            left_id: Optional[str] = None
            right_id: Optional[str] = None
            for m in rel.findall("member"):
                if str(m.attrib.get("type") or "") != "way":
                    continue
                role = str(m.attrib.get("role") or "")
                ref = str(m.attrib.get("ref") or "").strip()
                if not ref:
                    continue
                if role == "left":
                    left_id = ref
                elif role == "right":
                    right_id = ref

            left = _way_points(left_id)
            right = _way_points(right_id)

            center: List[Tuple[float, float]] = []
            if len(left) >= 2 and len(right) >= 2:
                d_same = (left[0][0] - right[0][0]) ** 2 + (left[0][1] - right[0][1]) ** 2
                d_same += (left[-1][0] - right[-1][0]) ** 2 + (left[-1][1] - right[-1][1]) ** 2
                d_rev = (left[0][0] - right[-1][0]) ** 2 + (left[0][1] - right[-1][1]) ** 2
                d_rev += (left[-1][0] - right[0][0]) ** 2 + (left[-1][1] - right[0][1]) ** 2
                if d_rev < d_same:
                    right = list(reversed(right))
                n = max(len(left), len(right))
                l2 = self._resample_polyline(left, n)
                r2 = self._resample_polyline(right, n)
                center = [((lp[0] + rp[0]) * 0.5, (lp[1] + rp[1]) * 0.5) for lp, rp in zip(l2, r2)]
            elif len(left) >= 2:
                center = left
            elif len(right) >= 2:
                center = right

            left = self._downsample_polyline(left, step)
            right = self._downsample_polyline(right, step)
            center = self._downsample_polyline(center, step)
            if len(center) < 2:
                continue

            polygon: List[Tuple[float, float]] = []
            if len(left) >= 2 and len(right) >= 2:
                polygon = left + list(reversed(right))
                if len(polygon) >= 3 and polygon[0] != polygon[-1]:
                    polygon.append(polygon[0])

            b = self._polyline_bbox(polygon if len(polygon) >= 3 else center)
            if b is None:
                continue
            bbox_update_from_bbox(map_bbox, b)
            lanes.append(
                {
                    "id": str(rel.attrib.get("id") or f"lane_{len(lanes)+1}"),
                    "lane_type": tags.get("subtype") or "road",
                    "turn_direction": None,
                    "is_intersection": bool((tags.get("subtype") or "").lower() in ("intersection",)),
                    "has_traffic_control": False,
                    "centerline": center,
                    "left_boundary": left,
                    "right_boundary": right,
                    "polygon": polygon,
                    "bbox": b,
                }
            )

        parsed = {
            "map_id": map_path.stem,
            "map_file": map_path.name,
            "counts": {"LANE": len(lanes), "STOPLINE": 0, "CROSSWALK": 0, "JUNCTION": 0},
            "lanes": lanes,
            "stoplines": [],
            "crosswalks": [],
            "junctions": [],
            "bbox": map_bbox if bbox_is_valid(map_bbox) else None,
        }
        self._lanelet_map_cache[key] = parsed
        return parsed

    def _clip_lanelet_map(
        self,
        parsed_map: Dict[str, Any],
        extent: Dict[str, float],
        max_lanes: int,
        focus_xy: Optional[Tuple[float, float]] = None,
    ) -> Dict[str, Any]:
        lanes: List[Dict[str, Any]] = []
        for lane in parsed_map.get("lanes", []) or []:
            b = lane.get("bbox") if isinstance(lane, dict) else None
            if not isinstance(b, dict):
                continue
            try:
                if bbox_intersects(b, extent):
                    lanes.append(lane)
            except Exception:
                continue
        lanes_truncated = False
        if max_lanes and len(lanes) > max_lanes:
            if focus_xy:
                cx, cy = focus_xy
            else:
                cx = (extent["min_x"] + extent["max_x"]) * 0.5
                cy = (extent["min_y"] + extent["max_y"]) * 0.5

            def _dist2(l: Dict[str, Any]) -> float:
                b = l.get("bbox") or {}
                mx = (float(b.get("min_x", 0.0)) + float(b.get("max_x", 0.0))) * 0.5
                my = (float(b.get("min_y", 0.0)) + float(b.get("max_y", 0.0))) * 0.5
                dx = mx - cx
                dy = my - cy
                return dx * dx + dy * dy

            lanes.sort(key=_dist2)
            lanes = lanes[: int(max_lanes)]
            lanes_truncated = True

        return {
            "map_id": parsed_map.get("map_id"),
            "map_file": parsed_map.get("map_file"),
            "lanes_truncated": lanes_truncated,
            "lanes": [
                {
                    "id": l.get("id"),
                    "lane_type": l.get("lane_type"),
                    "turn_direction": l.get("turn_direction"),
                    "is_intersection": l.get("is_intersection"),
                    "has_traffic_control": l.get("has_traffic_control"),
                    "centerline": l.get("centerline") or [],
                    "left_boundary": l.get("left_boundary") or [],
                    "right_boundary": l.get("right_boundary") or [],
                    "polygon": l.get("polygon") or [],
                }
                for l in lanes
            ],
            "stoplines": [],
            "crosswalks": [],
            "junctions": [],
        }

    def _read_recording_meta(self, path: Path) -> Dict[str, Any]:
        try:
            with path.open("r", newline="") as f:
                row = next(csv.DictReader(f), None)
        except Exception:
            row = None
        return row if isinstance(row, dict) else {}

    def _read_tracks_meta(self, path: Path) -> Tuple[Dict[int, _IndTrackMeta], List[_IndTrackMeta], int]:
        out: Dict[int, _IndTrackMeta] = {}
        seq: List[_IndTrackMeta] = []
        max_frame = -1
        try:
            with path.open("r", newline="") as f:
                r = csv.DictReader(f)
                for row in r:
                    tid = self._as_int(row.get("trackId"))
                    if tid is None:
                        continue
                    i0 = self._as_int(row.get("initialFrame"))
                    i1 = self._as_int(row.get("finalFrame"))
                    if i0 is None or i1 is None:
                        continue
                    tm = _IndTrackMeta(
                        track_id=tid,
                        initial_frame=int(i0),
                        final_frame=int(i1),
                        width=safe_float(row.get("width")),
                        length=safe_float(row.get("length")),
                        cls=str(row.get("class") or "").strip().lower(),
                    )
                    out[tid] = tm
                    seq.append(tm)
                    if tm.final_frame > max_frame:
                        max_frame = tm.final_frame
        except Exception:
            pass
        seq.sort(key=lambda x: x.track_id)
        return out, seq, int(max_frame)

    def _discover_recordings(self) -> List[_IndRecordingIndex]:
        data_dir = self._discover_data_dir()
        if data_dir is None or not data_dir.exists() or not data_dir.is_dir():
            return []

        tracks_files = sorted([p.resolve() for p in data_dir.glob("*_tracks.csv") if p.is_file()])
        out: List[_IndRecordingIndex] = []

        for tracks_path in tracks_files:
            parsed = self._as_num_str(tracks_path)
            if parsed is None:
                continue
            rec_s, rec_num = parsed
            tracks_meta_path = (data_dir / f"{rec_s}_tracksMeta.csv").resolve()
            recording_meta_path = (data_dir / f"{rec_s}_recordingMeta.csv").resolve()
            if not tracks_meta_path.exists() or not recording_meta_path.exists():
                continue

            rec_meta = self._read_recording_meta(recording_meta_path)
            frame_rate = safe_float(rec_meta.get("frameRate")) or 25.0
            if not (frame_rate > 0):
                frame_rate = 25.0
            duration_s = safe_float(rec_meta.get("duration")) or 0.0
            location_id = str(rec_meta.get("locationId") or "").strip() or "0"
            location_label = self._location_label(location_id)
            lat_location = safe_float(rec_meta.get("latLocation"))
            lon_location = safe_float(rec_meta.get("lonLocation"))
            x_utm_origin = safe_float(rec_meta.get("xUtmOrigin"))
            y_utm_origin = safe_float(rec_meta.get("yUtmOrigin"))
            ortho_px_to_meter = safe_float(rec_meta.get("orthoPxToMeter"))
            if ortho_px_to_meter is None or not (ortho_px_to_meter > 0):
                ortho_px_to_meter = 1.0

            tmeta, tmeta_list, max_frame = self._read_tracks_meta(tracks_meta_path)
            if max_frame < 0 and duration_s > 0:
                max_frame = max(0, int(round(duration_s * frame_rate)) - 1)
            if max_frame < 0:
                continue

            bg = (data_dir / f"{rec_s}_background.png").resolve()
            bg_path = bg if bg.exists() and bg.is_file() else None

            out.append(
                _IndRecordingIndex(
                    recording_id=rec_s,
                    recording_id_num=rec_num,
                    location_id=location_id,
                    location_label=location_label,
                    frame_rate=float(frame_rate),
                    duration_s=float(duration_s),
                    lat_location=lat_location,
                    lon_location=lon_location,
                    x_utm_origin=x_utm_origin,
                    y_utm_origin=y_utm_origin,
                    tracks_path=tracks_path,
                    tracks_meta_path=tracks_meta_path,
                    recording_meta_path=recording_meta_path,
                    background_path=bg_path,
                    ortho_px_to_meter=float(ortho_px_to_meter),
                    tracks_meta=tmeta,
                    tracks_meta_list=tmeta_list,
                    max_frame=int(max_frame),
                )
            )

        out.sort(key=lambda x: x.recording_id_num)
        return out

    def _window_stats(self, rec: _IndRecordingIndex, frame_start: int, frame_end: int) -> Tuple[int, int]:
        rows = 0
        unique_agents = 0
        for tm in rec.tracks_meta_list:
            lo = max(frame_start, tm.initial_frame)
            hi = min(frame_end, tm.final_frame)
            if hi < lo:
                continue
            unique_agents += 1
            rows += (hi - lo + 1)
        return rows, unique_agents

    def _build_index(self) -> None:
        split = self._SPLIT
        by_location: Dict[str, List[str]] = defaultdict(list)
        scene_n = 1
        for rec in self._discover_recordings():
            self._recordings[rec.recording_id] = rec
            window_frames = max(1, int(round(float(self.window_s) * float(rec.frame_rate))))
            max_frame = int(rec.max_frame)

            if max_frame < 0:
                continue

            start = 0
            wi = 0
            while start <= max_frame:
                end = min(max_frame, start + window_frames - 1)
                scene_id = str(scene_n)
                scene_n += 1
                rows, unique_agents = self._window_stats(rec, start, end)
                min_ts = float(start) / float(rec.frame_rate)
                max_ts = float(end) / float(rec.frame_rate)

                ref = _IndSceneRef(
                    scene_id=scene_id,
                    split=split,
                    recording_id=rec.recording_id,
                    location_id=rec.location_id,
                    location_label=rec.location_label,
                    window_i=wi,
                    frame_start=int(start),
                    frame_end=int(end),
                    min_ts=min_ts,
                    max_ts=max_ts,
                    rows=int(rows),
                    unique_agents=int(unique_agents),
                )
                self._scenes[scene_id] = ref
                self._scene_ids_sorted[split].append(scene_id)
                by_location[rec.location_id].append(scene_id)

                wi += 1
                start = end + 1

        self._scene_ids_by_location[split] = dict(by_location)
        self._scene_index[split] = {sid: i for i, sid in enumerate(self._scene_ids_sorted[split])}
        self._scene_index_by_location[split] = {
            lid: {sid: i for i, sid in enumerate(ids)}
            for lid, ids in self._scene_ids_by_location[split].items()
        }

    def list_intersections(self, split: str) -> List[Dict[str, Any]]:
        split = self._SPLIT
        items = []
        by_loc = self._scene_ids_by_location.get(split, {})
        for loc_id, ids in by_loc.items():
            items.append(
                {
                    "intersect_id": str(loc_id),
                    "intersect_label": self._location_label(loc_id),
                    "count": int(len(ids)),
                }
            )

        def _loc_key(it: Dict[str, Any]) -> Tuple[int, str]:
            s = str(it.get("intersect_id") or "")
            return (int(s), s) if s.isdigit() else (10**9, s)

        items.sort(key=_loc_key)
        return items

    def _list_scene_ids(self, intersect_id: Optional[str]) -> List[str]:
        split = self._SPLIT
        if intersect_id:
            return list(self._scene_ids_by_location.get(split, {}).get(str(intersect_id), []))
        return list(self._scene_ids_sorted.get(split, []))

    @staticmethod
    def _scene_label(ref: _IndSceneRef) -> str:
        dur = max(0.0, float(ref.max_ts) - float(ref.min_ts))
        return f"Recording {ref.recording_id} · Window {ref.window_i + 1} · {dur:.1f}s"

    def list_scenes(
        self,
        split: str,
        intersect_id: Optional[str] = None,
        limit: int = 200,
        offset: int = 0,
        include_tl_only: bool = False,
    ) -> Dict[str, Any]:
        split = self._SPLIT
        ids = self._list_scene_ids(intersect_id=intersect_id)
        total = len(ids)
        slice_ids = ids[offset : offset + limit]

        items = []
        for sid in slice_ids:
            ref = self._scenes[sid]
            duration_s = max(0.0, ref.max_ts - ref.min_ts)
            items.append(
                {
                    "scene_id": ref.scene_id,
                    "scene_label": self._scene_label(ref),
                    "recording_id": ref.recording_id,
                    "window_index": int(ref.window_i),
                    "split": split,
                    "city": None,
                    "intersect_id": ref.location_id,
                    "intersect_label": ref.location_label,
                    "by_modality": {
                        "infra": {
                            "rows": int(ref.rows),
                            "min_ts": float(ref.min_ts),
                            "max_ts": float(ref.max_ts),
                            "unique_ts": int(max(0, ref.frame_end - ref.frame_start + 1)),
                            "duration_s": duration_s,
                            "unique_agents": int(ref.unique_agents),
                        }
                    },
                }
            )

        return {
            "total": total,
            "limit": int(limit),
            "offset": int(offset),
            "items": items,
            "availability": {"scene_count": total, "by_modality": {"infra": total}},
            "include_tl_only": bool(include_tl_only),
        }

    def locate_scene(self, split: str, scene_id: str) -> Dict[str, Any]:
        split = self._SPLIT
        sid = str(scene_id or "")
        ref = self._scenes.get(sid)
        if ref is None:
            return {"split": split, "scene_id": sid, "found": False}

        idx_all = self._scene_index.get(split, {}).get(sid)
        idx_loc = self._scene_index_by_location.get(split, {}).get(ref.location_id, {}).get(sid)
        total_loc = len(self._scene_ids_by_location.get(split, {}).get(ref.location_id, []))

        return {
            "split": split,
            "scene_id": sid,
            "found": True,
            "city": None,
            "intersect_id": ref.location_id,
            "intersect_label": ref.location_label,
            "recording_id": ref.recording_id,
            "window_index": int(ref.window_i),
            "index_all": idx_all,
            "total_all": len(self._scene_ids_sorted.get(split, [])),
            "index_in_intersection": idx_loc,
            "total_in_intersection": total_loc,
        }

    @staticmethod
    def _class_to_type_and_subtype(raw_cls: str) -> Tuple[str, Optional[str]]:
        c = str(raw_cls or "").strip().lower()
        if c in ("car", "truck_bus", "truck", "bus", "van", "motorcycle"):
            return "VEHICLE", c.upper()
        if c in ("pedestrian",):
            return "PEDESTRIAN", "PEDESTRIAN"
        if c in ("bicycle",):
            return "BICYCLE", "BICYCLE"
        if c:
            return "OTHER", c.upper()
        return "UNKNOWN", None

    @staticmethod
    def _csv_index_map(header_line: str) -> Dict[str, int]:
        try:
            header = next(csv.reader([header_line]))
        except Exception:
            header = [x.strip() for x in str(header_line or "").strip().split(",")]
        return {str(name): i for i, name in enumerate(header)}

    def _ensure_offsets(self, rec: _IndRecordingIndex) -> None:
        if rec.offsets_by_track is not None and rec.csv_columns is not None:
            return

        offsets: Dict[int, Tuple[int, int]] = {}
        columns: Dict[str, int] = {}
        with rec.tracks_path.open("r", encoding="utf-8", errors="replace", newline="") as f:
            header_line = f.readline()
            if not header_line:
                rec.offsets_by_track = {}
                rec.csv_columns = {}
                return
            idx_by_name = self._csv_index_map(header_line)

            def idx(name: str) -> int:
                v = idx_by_name.get(name)
                return int(v) if v is not None else -1

            columns = {
                "trackId": idx("trackId"),
                "frame": idx("frame"),
                "xCenter": idx("xCenter"),
                "yCenter": idx("yCenter"),
                "heading": idx("heading"),
                "width": idx("width"),
                "length": idx("length"),
                "xVelocity": idx("xVelocity"),
                "yVelocity": idx("yVelocity"),
            }

            if columns["trackId"] < 0 or columns["frame"] < 0:
                rec.offsets_by_track = {}
                rec.csv_columns = columns
                return

            cur_track: Optional[int] = None
            cur_start = f.tell()
            while True:
                pos = f.tell()
                line = f.readline()
                if not line:
                    break
                parts = line.rstrip("\r\n").split(",")
                i_tid = columns["trackId"]
                if i_tid >= len(parts):
                    continue
                tid = self._as_int(parts[i_tid])
                if tid is None:
                    continue

                if cur_track is None:
                    cur_track = int(tid)
                    cur_start = pos
                elif tid != cur_track:
                    offsets[int(cur_track)] = (int(cur_start), int(pos))
                    cur_track = int(tid)
                    cur_start = pos

            end_pos = f.tell()
            if cur_track is not None:
                offsets[int(cur_track)] = (int(cur_start), int(end_pos))

        rec.offsets_by_track = offsets
        rec.csv_columns = columns

    @staticmethod
    def _col(parts: List[str], cols: Dict[str, int], key: str) -> Optional[str]:
        i = int(cols.get(key, -1))
        if i < 0 or i >= len(parts):
            return None
        return parts[i]

    def _active_tracks(self, rec: _IndRecordingIndex, frame_start: int, frame_end: int) -> List[_IndTrackMeta]:
        out: List[_IndTrackMeta] = []
        for tm in rec.tracks_meta_list:
            if tm.final_frame < frame_start or tm.initial_frame > frame_end:
                continue
            out.append(tm)
        return out

    def _background_meta_for_recording(self, rec: _IndRecordingIndex) -> Optional[Dict[str, Any]]:
        if rec.background_path is None or not rec.background_path.exists() or not rec.background_path.is_file():
            return None
        size = read_png_size(rec.background_path)
        if not size:
            return None
        width_px, height_px = size
        meters_per_px = float(rec.ortho_px_to_meter) * float(self.background_scale_down)
        if not (meters_per_px > 0):
            return None
        return {
            "kind": "scene_image",
            "path": str(rec.background_path),
            "size_px": {"width": int(width_px), "height": int(height_px)},
            "meters_per_px": float(meters_per_px),
            # inD helper uses xCenterVis = x/ortho and yCenterVis = -y/ortho;
            # displayed image is down-scaled by `background_scale_down`.
            "extent": {
                "min_x": 0.0,
                "max_x": float(width_px) * meters_per_px,
                "min_y": -float(height_px) * meters_per_px,
                "max_y": 0.0,
            },
        }

    def get_scene_background(self, split: str, scene_id: str) -> Optional[Path]:
        split = self._SPLIT
        sid = str(scene_id or "")
        ref = self._scenes.get(sid)
        if ref is None:
            return None
        rec = self._recordings.get(ref.recording_id)
        if rec is None:
            return None
        bg = rec.background_path
        if bg is None or not bg.exists() or not bg.is_file():
            return None
        return bg

    def load_scene_bundle(
        self,
        split: str,
        scene_id: str,
        include_map: bool = True,
        map_padding: float = 60.0,
        map_points_step: int = 5,
        max_lanes: int = 4000,
        map_clip: str = "intersection",
    ) -> Dict[str, Any]:
        split = self._SPLIT
        sid = str(scene_id or "")
        ref = self._scenes.get(sid)
        if ref is None:
            raise KeyError(f"scene not found: {sid}")
        rec = self._recordings.get(ref.recording_id)
        if rec is None:
            raise KeyError(f"recording not found for scene: {sid}")

        self._ensure_offsets(rec)
        cols = rec.csv_columns or {}
        offsets = rec.offsets_by_track or {}

        warnings: List[str] = []
        by_frame: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        extent = bbox_init()
        rows = 0
        obj_ids: set[str] = set()

        active_tracks = self._active_tracks(rec, ref.frame_start, ref.frame_end)
        if not active_tracks:
            warnings.append("scene_window_empty")

        with rec.tracks_path.open("r", encoding="utf-8", errors="replace", newline="") as f:
            # Iterate by track segments, not by full file scan.
            for tm in active_tracks:
                off = offsets.get(tm.track_id)
                if not off:
                    continue
                start_off, end_off = off
                f.seek(start_off)
                while f.tell() < end_off:
                    line = f.readline()
                    if not line:
                        break
                    parts = line.rstrip("\r\n").split(",")

                    frame_i = self._as_int(self._col(parts, cols, "frame"))
                    if frame_i is None:
                        continue
                    frame = int(frame_i)
                    if frame < ref.frame_start or frame > ref.frame_end:
                        continue

                    x = safe_float(self._col(parts, cols, "xCenter"))
                    y = safe_float(self._col(parts, cols, "yCenter"))
                    if x is not None and y is not None:
                        bbox_update(extent, x, y)

                    heading = safe_float(self._col(parts, cols, "heading"))
                    theta = math.radians(float(heading)) if heading is not None else None

                    width = safe_float(self._col(parts, cols, "width"))
                    length = safe_float(self._col(parts, cols, "length"))
                    if width is None:
                        width = tm.width
                    if length is None:
                        length = tm.length

                    v_x = safe_float(self._col(parts, cols, "xVelocity"))
                    v_y = safe_float(self._col(parts, cols, "yVelocity"))
                    t, st = self._class_to_type_and_subtype(tm.cls)

                    obj_id = str(tm.track_id)
                    rec_out = {
                        "id": obj_id,
                        "track_id": obj_id,
                        "object_id": obj_id,
                        "type": t,
                        "sub_type": st,
                        "sub_type_code": None,
                        "tag": f"recording-{rec.recording_id}",
                        "x": x,
                        "y": y,
                        "z": None,
                        "length": length,
                        "width": width,
                        "height": None,
                        "theta": theta,
                        "v_x": v_x,
                        "v_y": v_y,
                    }
                    by_frame[frame].append(rec_out)
                    obj_ids.add(obj_id)
                    rows += 1

        frame_keys = sorted(by_frame.keys())
        timestamps = [float(fr) / float(rec.frame_rate) for fr in frame_keys]
        t0 = timestamps[0] if timestamps else 0.0

        if not bbox_is_valid(extent):
            extent = {"min_x": -10.0, "min_y": -10.0, "max_x": 10.0, "max_y": 10.0}
            warnings.append("extent_missing")
        if rows <= 0:
            warnings.append("scene_window_empty")

        frames: List[Dict[str, Any]] = []
        for fr in frame_keys:
            frames.append({"infra": by_frame.get(fr, [])})

        modality_stats = {
            "ego": {"rows": 0, "unique_ts": 0, "min_ts": None, "max_ts": None},
            "vehicle": {"rows": 0, "unique_ts": 0, "min_ts": None, "max_ts": None},
            "traffic_light": {"rows": 0, "unique_ts": 0, "min_ts": None, "max_ts": None},
            "infra": {
                "rows": int(rows),
                "unique_ts": int(len(frame_keys)),
                "min_ts": timestamps[0] if timestamps else None,
                "max_ts": timestamps[-1] if timestamps else None,
                "unique_agents": int(len(obj_ids)),
            },
        }

        background = self._background_meta_for_recording(rec)
        if background is not None:
            background["url"] = f"/api/datasets/{self.spec.id}/scene/{split}/{sid}/background"
            background["recording_id"] = rec.recording_id

        map_out: Optional[Dict[str, Any]] = None
        map_id: Optional[str] = None
        if include_map:
            try:
                parsed_map = self._load_lanelet_map_parsed(rec, points_step=map_points_step)
                if parsed_map is None:
                    warnings.append("map_missing")
                elif parsed_map.get("bbox") is not None:
                    if map_clip == "scene":
                        clip_extent = bbox_pad(extent, map_padding)
                    else:
                        clip_extent = parsed_map["bbox"]
                    focus_xy = (
                        (extent["min_x"] + extent["max_x"]) * 0.5,
                        (extent["min_y"] + extent["max_y"]) * 0.5,
                    )
                    map_out = self._clip_lanelet_map(parsed_map, clip_extent, max_lanes=max_lanes, focus_xy=focus_xy)
                    map_out["clip_mode"] = str(map_clip or "intersection")
                    map_out["clip_extent"] = clip_extent
                    map_out["points_step"] = int(max(1, map_points_step))
                    map_out["counts"] = dict(parsed_map.get("counts") or {})
                    map_out["bbox"] = parsed_map.get("bbox")
                    map_id = str(parsed_map.get("map_id") or "")
                    if map_id == "":
                        map_id = None
                else:
                    warnings.append("map_empty")
            except Exception as e:
                warnings.append(f"map_load_failed:{e}")

        window_count = 0
        for x in self._scenes.values():
            if x.recording_id == ref.recording_id:
                window_count += 1

        return {
            "dataset_id": self.spec.id,
            "split": split,
            "scene_id": sid,
            "scene_label": self._scene_label(ref),
            "city": None,
            "intersect_id": ref.location_id,
            "intersect_label": ref.location_label,
            "recording_id": rec.recording_id,
            "recording_label": f"Recording {rec.recording_id}",
            "window_index": int(ref.window_i),
            "window_count": int(window_count),
            "intersect_by_modality": {"infra": ref.location_id},
            "map_id": map_id,
            "t0": t0,
            "timestamps": timestamps,
            "extent": extent,
            "map": map_out,
            "background": background,
            "modality_stats": modality_stats,
            "frames": frames,
            "warnings": warnings,
        }


class SinDAdapter:
    """
    Adapter for SinD (signalized intersection drone dataset).

    Scene model:
    - split is always "all"
    - group/intersection is city
    - scene is one scenario folder
    """

    _SPLIT = "all"

    def __init__(self, spec: DatasetSpec) -> None:
        self.spec = spec
        self._bindings = spec.bindings if isinstance(spec.bindings, dict) else {}
        self._scenes: Dict[str, _SindScenarioRef] = {}
        self._scene_ids_sorted: Dict[str, List[str]] = {self._SPLIT: []}
        self._scene_ids_by_city: Dict[str, Dict[str, List[str]]] = {self._SPLIT: {}}
        self._scene_index: Dict[str, Dict[str, int]] = {self._SPLIT: {}}
        self._scene_index_by_city: Dict[str, Dict[str, Dict[str, int]]] = {self._SPLIT: {}}
        self._lanelet_map_cache: Dict[Tuple[str, int], Dict[str, Any]] = {}
        self._build_index()
        if not self._scenes:
            raise ValueError("SinD adapter could not discover any scenes")

    def _binding_obj(self, role: str) -> Dict[str, Any]:
        v = self._bindings.get(role) if isinstance(self._bindings, dict) else None
        return v if isinstance(v, dict) else {}

    def _binding_dir(self, role: str) -> Optional[Path]:
        obj = self._binding_obj(role)
        raw = obj.get("path")
        if raw is None and isinstance(self._bindings.get(role), str):
            raw = self._bindings.get(role)
        if not raw:
            return None
        try:
            p = Path(str(raw)).expanduser().resolve()
        except Exception:
            return None
        if p.exists() and p.is_dir():
            return p
        return p

    def _discover_data_dir(self) -> Optional[Path]:
        bound = self._binding_dir("data_dir")
        if bound and bound.exists() and bound.is_dir():
            return bound
        if self.spec.root.exists() and self.spec.root.is_dir():
            return self.spec.root.resolve()
        return None

    @staticmethod
    def _city_label(city_id: str) -> str:
        s = str(city_id or "").strip()
        if not s:
            return "City ?"
        return s.replace("_", " ")

    @staticmethod
    def _scenario_sort_key(name: str) -> Tuple[int, str]:
        m = re.search(r"(\d+)", str(name or ""))
        if m:
            try:
                return int(m.group(1)), str(name)
            except Exception:
                pass
        return (10**9), str(name)

    @staticmethod
    def _is_scenario_dir(path: Path) -> bool:
        if not path.exists() or not path.is_dir():
            return False
        return (path / "Veh_smoothed_tracks.csv").exists() or (path / "Ped_smoothed_tracks.csv").exists()

    def _discover_city_blocks(self) -> List[Tuple[str, Path, List[Path], Optional[Path], Optional[Path]]]:
        data_dir = self._discover_data_dir()
        if data_dir is None or not data_dir.exists() or not data_dir.is_dir():
            return []

        first_level = [p for p in sorted(data_dir.iterdir()) if p.is_dir() and not p.name.startswith(".")]
        direct_scenarios = [p for p in first_level if self._is_scenario_dir(p)]

        blocks: List[Tuple[str, Path, List[Path], Optional[Path], Optional[Path]]] = []
        if direct_scenarios:
            city_id = str(data_dir.name or "city").strip()
            city_dir = data_dir
            map_file = next(iter(sorted([p for p in city_dir.glob("*.osm") if p.is_file()])), None)
            bg_file = next(iter(sorted([p for p in city_dir.glob("*.png") if p.is_file()])), None)
            blocks.append((city_id, city_dir, sorted(direct_scenarios, key=lambda x: self._scenario_sort_key(x.name)), map_file, bg_file))
            return blocks

        for city_dir in first_level:
            scenarios = [p for p in sorted(city_dir.iterdir()) if p.is_dir() and not p.name.startswith(".") and self._is_scenario_dir(p)]
            if not scenarios:
                continue
            city_id = str(city_dir.name).strip()
            map_file = next(iter(sorted([p for p in city_dir.glob("*.osm") if p.is_file()])), None)
            bg_file = next(iter(sorted([p for p in city_dir.glob("*.png") if p.is_file()])), None)
            blocks.append((city_id, city_dir, sorted(scenarios, key=lambda x: self._scenario_sort_key(x.name)), map_file, bg_file))

        blocks.sort(key=lambda x: str(x[0]).lower())
        return blocks

    def _build_index(self) -> None:
        split = self._SPLIT
        by_city: Dict[str, List[str]] = defaultdict(list)
        sid_n = 1
        for city_id, city_dir, scenarios, map_file, bg_file in self._discover_city_blocks():
            _ = city_dir
            city_label = self._city_label(city_id)
            for scen in scenarios:
                sid = str(sid_n)
                sid_n += 1
                ref = _SindScenarioRef(
                    scene_id=sid,
                    split=split,
                    city_id=city_id,
                    city_label=city_label,
                    scenario_id=scen.name,
                    scenario_label=scen.name.replace("_", " "),
                    veh_path=(scen / "Veh_smoothed_tracks.csv").resolve() if (scen / "Veh_smoothed_tracks.csv").exists() else None,
                    ped_path=(scen / "Ped_smoothed_tracks.csv").resolve() if (scen / "Ped_smoothed_tracks.csv").exists() else None,
                    tl_path=self._discover_traffic_light_file(scen),
                    map_path=map_file.resolve() if isinstance(map_file, Path) and map_file.exists() else None,
                    background_path=bg_file.resolve() if isinstance(bg_file, Path) and bg_file.exists() else None,
                )
                self._scenes[sid] = ref
                self._scene_ids_sorted[split].append(sid)
                by_city[city_id].append(sid)

        self._scene_ids_by_city[split] = dict(by_city)
        self._scene_index[split] = {sid: i for i, sid in enumerate(self._scene_ids_sorted[split])}
        self._scene_index_by_city[split] = {
            cid: {sid: i for i, sid in enumerate(ids)}
            for cid, ids in self._scene_ids_by_city[split].items()
        }

    @staticmethod
    def _discover_traffic_light_file(scene_dir: Path) -> Optional[Path]:
        csvs = [p for p in scene_dir.glob("*.csv") if p.is_file()]
        ranked: List[Tuple[int, Path]] = []
        for p in csvs:
            n = p.name.lower()
            if "traffic" not in n or "meta" in n or n.startswith(".~lock"):
                continue
            score = 0
            if "trafficlight" in n:
                score += 2
            if "traffic_lights" in n:
                score += 1
            ranked.append((score, p.resolve()))
        if not ranked:
            return None
        ranked.sort(key=lambda x: (-x[0], str(x[1]).lower()))
        return ranked[0][1]

    def list_intersections(self, split: str) -> List[Dict[str, Any]]:
        split = self._SPLIT
        out = []
        for cid, ids in self._scene_ids_by_city.get(split, {}).items():
            out.append(
                {
                    "intersect_id": str(cid),
                    "intersect_label": self._city_label(cid),
                    "count": int(len(ids)),
                }
            )
        out.sort(key=lambda x: str(x.get("intersect_label") or "").lower())
        return out

    def _list_scene_ids(self, intersect_id: Optional[str]) -> List[str]:
        split = self._SPLIT
        if intersect_id:
            return list(self._scene_ids_by_city.get(split, {}).get(str(intersect_id), []))
        return list(self._scene_ids_sorted.get(split, []))

    @staticmethod
    def _scene_label(ref: _SindScenarioRef) -> str:
        return f"{ref.scenario_label} · {ref.city_label}"

    def list_scenes(
        self,
        split: str,
        intersect_id: Optional[str] = None,
        limit: int = 200,
        offset: int = 0,
        include_tl_only: bool = False,
    ) -> Dict[str, Any]:
        split = self._SPLIT
        ids = self._list_scene_ids(intersect_id=intersect_id)
        if include_tl_only:
            ids = [sid for sid in ids if self._scenes.get(sid) and self._scenes[sid].tl_path is not None]
        total = len(ids)
        slice_ids = ids[offset : offset + limit]

        items: List[Dict[str, Any]] = []
        n_tl = 0
        for sid in slice_ids:
            ref = self._scenes[sid]
            has_tl = ref.tl_path is not None and ref.tl_path.exists()
            if has_tl:
                n_tl += 1
            items.append(
                {
                    "scene_id": ref.scene_id,
                    "scene_label": self._scene_label(ref),
                    "recording_id": ref.scenario_id,
                    "window_index": 0,
                    "split": split,
                    "city": ref.city_id,
                    "intersect_id": ref.city_id,
                    "intersect_label": ref.city_label,
                    "by_modality": {
                        "infra": {
                            "rows": 0,
                            "min_ts": None,
                            "max_ts": None,
                            "unique_ts": 0,
                            "duration_s": None,
                            "unique_agents": 0,
                        },
                        "traffic_light": {
                            "rows": 0,
                            "min_ts": None,
                            "max_ts": None,
                            "unique_ts": 0,
                        } if has_tl else {"rows": 0, "min_ts": None, "max_ts": None, "unique_ts": 0},
                    },
                }
            )

        return {
            "total": total,
            "limit": int(limit),
            "offset": int(offset),
            "items": items,
            "availability": {
                "scene_count": total,
                "by_modality": {
                    "infra": total,
                    "traffic_light": n_tl if slice_ids else len([sid for sid in ids if self._scenes[sid].tl_path is not None]),
                },
            },
            "include_tl_only": bool(include_tl_only),
        }

    def locate_scene(self, split: str, scene_id: str) -> Dict[str, Any]:
        split = self._SPLIT
        sid = str(scene_id or "")
        ref = self._scenes.get(sid)
        if ref is None:
            return {"split": split, "scene_id": sid, "found": False}
        idx_all = self._scene_index.get(split, {}).get(sid)
        idx_city = self._scene_index_by_city.get(split, {}).get(ref.city_id, {}).get(sid)
        total_city = len(self._scene_ids_by_city.get(split, {}).get(ref.city_id, []))
        return {
            "split": split,
            "scene_id": sid,
            "found": True,
            "city": ref.city_id,
            "intersect_id": ref.city_id,
            "intersect_label": ref.city_label,
            "recording_id": ref.scenario_id,
            "window_index": 0,
            "index_all": idx_all,
            "total_all": len(self._scene_ids_sorted.get(split, [])),
            "index_in_intersection": idx_city,
            "total_in_intersection": total_city,
        }

    @staticmethod
    def _as_int(raw: Any) -> Optional[int]:
        v = safe_float(raw)
        if v is None:
            return None
        try:
            return int(v)
        except Exception:
            return None

    @staticmethod
    def _ts_key_from_ms(raw: Any) -> Optional[int]:
        v = safe_float(raw)
        if v is None:
            return None
        return int(round(float(v) / 100.0))

    @staticmethod
    def _ts_from_key(ts_key: int) -> float:
        return float(ts_key) / 10.0

    @staticmethod
    def _class_to_type_and_subtype(raw_cls: str) -> Tuple[str, Optional[str]]:
        c = str(raw_cls or "").strip().lower()
        if c in ("car", "truck", "bus", "van", "motorcycle", "tricycle"):
            return "VEHICLE", c.upper()
        if c in ("pedestrian", "person"):
            return "PEDESTRIAN", "PEDESTRIAN"
        if c in ("bicycle", "cyclist"):
            return "BICYCLE", "BICYCLE"
        if c in ("animal",):
            return "ANIMAL", "ANIMAL"
        if c:
            return "OTHER", c.upper()
        return "UNKNOWN", None

    @staticmethod
    def _q3(v: Optional[float]) -> Optional[float]:
        # Keep transport payload compact while preserving sub-centimeter precision.
        if v is None:
            return None
        try:
            return round(float(v), 3)
        except Exception:
            return None

    def _read_tracks_csv(
        self,
        path: Path,
        source_tag: str,
    ) -> Tuple[Dict[int, List[Dict[str, Any]]], Dict[str, float], int, set[str], Counter]:
        by_ts: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        extent = bbox_init()
        rows = 0
        unique_ids: set[str] = set()
        sub_type_counts: Counter = Counter()

        if not path.exists() or not path.is_file():
            return {}, extent, 0, unique_ids, sub_type_counts

        with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
            r = csv.DictReader(f)
            for row in r:
                ts_key = self._ts_key_from_ms(row.get("timestamp_ms"))
                if ts_key is None:
                    fr = self._as_int(row.get("frame_id"))
                    if fr is not None:
                        ts_key = int(fr)
                if ts_key is None:
                    continue

                x = safe_float(row.get("x"))
                y = safe_float(row.get("y"))
                if x is not None and y is not None:
                    bbox_update(extent, x, y)

                track_raw = row.get("track_id")
                if track_raw is None or str(track_raw).strip() == "":
                    track_raw = row.get("id")
                track_id = str(track_raw or f"row{rows+1}")
                obj_id = f"{source_tag}:{track_id}"

                cls_raw = str(row.get("agent_type") or "").strip()
                if not cls_raw:
                    cls_raw = "pedestrian" if source_tag == "ped" else "vehicle"
                obj_type, sub_type = self._class_to_type_and_subtype(cls_raw)
                theta = safe_float(row.get("heading_rad"))
                if theta is None:
                    theta = safe_float(row.get("yaw_rad"))
                # Emit only fields used by the frontend renderer/filters.
                rec: Dict[str, Any] = {
                    "id": obj_id,
                    "type": obj_type,
                    "sub_type": sub_type,
                    "x": self._q3(x),
                    "y": self._q3(y),
                }
                for k, val in (
                    ("length", safe_float(row.get("length"))),
                    ("width", safe_float(row.get("width"))),
                    ("theta", theta),
                    ("v_x", safe_float(row.get("vx"))),
                    ("v_y", safe_float(row.get("vy"))),
                ):
                    q = self._q3(val)
                    if q is not None:
                        rec[k] = q
                by_ts[ts_key].append(rec)
                unique_ids.add(obj_id)
                sub_type_counts[str(sub_type or "UNKNOWN")] += 1
                rows += 1

        return by_ts, extent, rows, unique_ids, sub_type_counts

    @staticmethod
    def _normalize_col_name(raw: str) -> str:
        return re.sub(r"[^a-z0-9]+", "", str(raw or "").strip().lower())

    def _tl_timestamp_column(self, fieldnames: List[str]) -> Optional[str]:
        if not fieldnames:
            return None
        norm = {self._normalize_col_name(x): x for x in fieldnames}
        for key in ("timestampms", "timestamp", "timems", "time"):
            if key in norm:
                return norm[key]
        for x in fieldnames:
            n = self._normalize_col_name(x)
            if "timestamp" in n:
                return x
        return None

    def _tl_state_columns(self, path: Optional[Path]) -> List[str]:
        if path is None or not path.exists() or not path.is_file():
            return []
        try:
            with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
                r = csv.DictReader(f)
                fieldnames = [str(x or "").strip() for x in (r.fieldnames or []) if str(x or "").strip()]
        except Exception:
            return []
        out = []
        for col in fieldnames:
            n = self._normalize_col_name(col)
            if "trafficlight" in n or ("traffic" in n and "light" in n):
                out.append(col)
        return out

    @staticmethod
    def _tl_color_from_value(raw: Any) -> Optional[str]:
        s = str(raw or "").strip()
        if s == "":
            return None
        low = s.lower()
        if "red" in low:
            return "RED"
        if "yellow" in low:
            return "YELLOW"
        if "green" in low:
            return "GREEN"
        try:
            v = int(float(low))
        except Exception:
            return None
        if v == 0:
            return "RED"
        if v == 1:
            return "YELLOW"
        if v in (2, 3):
            return "GREEN"
        return None

    def _read_traffic_lights_csv(
        self,
        path: Optional[Path],
        anchors: List[Tuple[float, float]],
    ) -> Tuple[Dict[int, List[Dict[str, Any]]], Dict[str, float], int]:
        by_ts: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        extent = bbox_init()
        rows = 0
        if path is None or not path.exists() or not path.is_file():
            return {}, extent, 0

        with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
            r = csv.DictReader(f)
            fieldnames = [str(x or "").strip() for x in (r.fieldnames or []) if str(x or "").strip()]
            ts_col = self._tl_timestamp_column(fieldnames)
            state_cols = self._tl_state_columns(path)
            if ts_col is None or not state_cols:
                return {}, extent, 0
            if not anchors:
                anchors = [(0.0, 0.0)]

            for row in r:
                ts_key = self._ts_key_from_ms(row.get(ts_col))
                if ts_key is None:
                    fr = self._as_int(row.get("RawFrameID"))
                    if fr is not None:
                        ts_key = int(fr)
                if ts_key is None:
                    continue

                for i, col in enumerate(state_cols):
                    color = self._tl_color_from_value(row.get(col))
                    if color is None:
                        continue
                    x, y = anchors[i % len(anchors)]
                    bbox_update(extent, x, y)
                    rec = {
                        "id": f"{i+1}:{col}",
                        "x": self._q3(x),
                        "y": self._q3(y),
                        "color_1": color,
                    }
                    by_ts[ts_key].append(rec)
                    rows += 1

        return by_ts, extent, rows

    @staticmethod
    def _latlon_to_local_xy(lat: float, lon: float) -> Tuple[float, float]:
        # SinD lanelet maps encode near-origin lat/lon values in a local projection-like frame.
        # Equirectangular scaling is sufficient for this small field of view.
        x = float(lon) * 111319.49079327357
        y = float(lat) * 110574.0
        return x, y

    @staticmethod
    def _resample_polyline(points: List[Tuple[float, float]], n_out: int) -> List[Tuple[float, float]]:
        if n_out <= 1:
            return points[:1]
        if len(points) <= 1:
            return points[:]
        if len(points) == n_out:
            return points[:]
        out: List[Tuple[float, float]] = []
        span = float(len(points) - 1)
        for i in range(n_out):
            t = span * (float(i) / float(n_out - 1))
            j0 = int(math.floor(t))
            j1 = min(len(points) - 1, j0 + 1)
            a = t - float(j0)
            x0, y0 = points[j0]
            x1, y1 = points[j1]
            out.append(((1.0 - a) * x0 + a * x1, (1.0 - a) * y0 + a * y1))
        return out

    @staticmethod
    def _downsample_polyline(points: List[Tuple[float, float]], step: int) -> List[Tuple[float, float]]:
        s = max(1, int(step))
        if s <= 1 or len(points) <= max(12, s * 2):
            return points
        idxs = list(range(0, len(points), s))
        last = len(points) - 1
        if idxs[-1] != last:
            idxs.append(last)
        out = [points[i] for i in idxs]
        if len(out) < 2 and len(points) >= 2:
            out = [points[0], points[-1]]
        return out

    @staticmethod
    def _polyline_bbox(points: List[Tuple[float, float]]) -> Optional[Dict[str, float]]:
        if not points:
            return None
        b = bbox_init()
        for x, y in points:
            bbox_update(b, x, y)
        return b if bbox_is_valid(b) else None

    @staticmethod
    def _polygon_bbox(points: List[Tuple[float, float]]) -> Optional[Dict[str, float]]:
        return SinDAdapter._polyline_bbox(points)

    def _load_lanelet_map_parsed(self, map_path: Path, points_step: int) -> Optional[Dict[str, Any]]:
        if map_path is None or not map_path.exists() or not map_path.is_file():
            return None
        step = max(1, int(points_step))
        key = (str(map_path.resolve()), step)
        cached = self._lanelet_map_cache.get(key)
        if cached is not None:
            return cached

        tree = ET.parse(map_path)
        root = tree.getroot()

        nodes: Dict[str, Tuple[float, float]] = {}
        for n in root.findall("node"):
            nid = str(n.attrib.get("id") or "").strip()
            lat = safe_float(n.attrib.get("lat"))
            lon = safe_float(n.attrib.get("lon"))
            if not nid or lat is None or lon is None:
                continue
            nodes[nid] = self._latlon_to_local_xy(float(lat), float(lon))

        ways: Dict[str, List[str]] = {}
        way_tags: Dict[str, Dict[str, str]] = {}
        for w in root.findall("way"):
            wid = str(w.attrib.get("id") or "").strip()
            if not wid:
                continue
            refs = [str(nd.attrib.get("ref") or "").strip() for nd in w.findall("nd")]
            ways[wid] = [r for r in refs if r]
            tags = {str(t.attrib.get("k") or ""): str(t.attrib.get("v") or "") for t in w.findall("tag")}
            way_tags[wid] = tags

        def _way_points(wid: Optional[str]) -> List[Tuple[float, float]]:
            if wid is None:
                return []
            refs = ways.get(wid, [])
            pts: List[Tuple[float, float]] = []
            for rid in refs:
                xy = nodes.get(rid)
                if xy is None:
                    continue
                if pts and abs(xy[0] - pts[-1][0]) < 1e-9 and abs(xy[1] - pts[-1][1]) < 1e-9:
                    continue
                pts.append(xy)
            return pts

        lanes: List[Dict[str, Any]] = []
        stoplines: List[Dict[str, Any]] = []
        crosswalks: List[Dict[str, Any]] = []
        junctions: List[Dict[str, Any]] = []
        map_bbox = bbox_init()

        for rel in root.findall("relation"):
            tags = {str(t.attrib.get("k") or ""): str(t.attrib.get("v") or "") for t in rel.findall("tag")}
            if tags.get("type") != "lanelet":
                continue

            left_id: Optional[str] = None
            right_id: Optional[str] = None
            for m in rel.findall("member"):
                if str(m.attrib.get("type") or "") != "way":
                    continue
                role = str(m.attrib.get("role") or "")
                ref = str(m.attrib.get("ref") or "").strip()
                if not ref:
                    continue
                if role == "left":
                    left_id = ref
                elif role == "right":
                    right_id = ref

            left = _way_points(left_id)
            right = _way_points(right_id)
            center: List[Tuple[float, float]] = []
            if len(left) >= 2 and len(right) >= 2:
                d_same = (left[0][0] - right[0][0]) ** 2 + (left[0][1] - right[0][1]) ** 2
                d_same += (left[-1][0] - right[-1][0]) ** 2 + (left[-1][1] - right[-1][1]) ** 2
                d_rev = (left[0][0] - right[-1][0]) ** 2 + (left[0][1] - right[-1][1]) ** 2
                d_rev += (left[-1][0] - right[0][0]) ** 2 + (left[-1][1] - right[0][1]) ** 2
                if d_rev < d_same:
                    right = list(reversed(right))
                n = max(len(left), len(right))
                l2 = self._resample_polyline(left, n)
                r2 = self._resample_polyline(right, n)
                center = [((lp[0] + rp[0]) * 0.5, (lp[1] + rp[1]) * 0.5) for lp, rp in zip(l2, r2)]
            elif len(left) >= 2:
                center = left
            elif len(right) >= 2:
                center = right

            left = self._downsample_polyline(left, step)
            right = self._downsample_polyline(right, step)
            center = self._downsample_polyline(center, step)
            if len(center) < 2:
                continue
            polygon: List[Tuple[float, float]] = []
            if len(left) >= 2 and len(right) >= 2:
                polygon = left + list(reversed(right))
                if len(polygon) >= 3 and polygon[0] != polygon[-1]:
                    polygon.append(polygon[0])

            b = self._polyline_bbox(polygon if len(polygon) >= 3 else center)
            if b is None:
                continue
            bbox_update_from_bbox(map_bbox, b)
            subtype = str(tags.get("subtype") or tags.get("location") or "road")
            st_low = subtype.lower()
            lanes.append(
                {
                    "id": str(rel.attrib.get("id") or f"lane_{len(lanes)+1}"),
                    "lane_type": subtype,
                    "turn_direction": None,
                    "is_intersection": bool(("intersection" in st_low) or ("junction" in st_low)),
                    "has_traffic_control": False,
                    "centerline": center,
                    "left_boundary": left,
                    "right_boundary": right,
                    "polygon": polygon,
                    "bbox": b,
                }
            )

        for wid, tags in way_tags.items():
            typ = str(tags.get("type") or "").strip().lower()
            pts = self._downsample_polyline(_way_points(wid), step)
            if len(pts) < 2:
                continue
            b = self._polyline_bbox(pts)
            if b is None:
                continue
            if typ == "stop_line":
                bbox_update_from_bbox(map_bbox, b)
                stoplines.append({"id": wid, "centerline": pts, "bbox": b})
            elif typ == "zebra":
                poly = pts[:]
                if len(poly) >= 3 and (poly[0][0] != poly[-1][0] or poly[0][1] != poly[-1][1]):
                    poly.append(poly[0])
                pb = self._polygon_bbox(poly)
                if pb is None:
                    continue
                bbox_update_from_bbox(map_bbox, pb)
                crosswalks.append({"id": wid, "polygon": poly, "bbox": pb})

        parsed = {
            "map_id": map_path.stem,
            "map_file": map_path.name,
            "counts": {
                "LANE": len(lanes),
                "STOPLINE": len(stoplines),
                "CROSSWALK": len(crosswalks),
                "JUNCTION": len(junctions),
            },
            "lanes": lanes,
            "stoplines": stoplines,
            "crosswalks": crosswalks,
            "junctions": junctions,
            "bbox": map_bbox if bbox_is_valid(map_bbox) else None,
        }
        self._lanelet_map_cache[key] = parsed
        return parsed

    def _clip_lanelet_map(
        self,
        parsed_map: Dict[str, Any],
        extent: Dict[str, float],
        max_lanes: int,
        focus_xy: Optional[Tuple[float, float]] = None,
    ) -> Dict[str, Any]:
        def _clip_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
            out: List[Dict[str, Any]] = []
            for it in items:
                b = it.get("bbox")
                if not isinstance(b, dict):
                    continue
                try:
                    if bbox_intersects(b, extent):
                        out.append(it)
                except Exception:
                    continue
            return out

        lanes = _clip_items(parsed_map.get("lanes", []) or [])
        stoplines = _clip_items(parsed_map.get("stoplines", []) or [])
        crosswalks = _clip_items(parsed_map.get("crosswalks", []) or [])
        junctions = _clip_items(parsed_map.get("junctions", []) or [])

        lanes_truncated = False
        if max_lanes and len(lanes) > max_lanes:
            if focus_xy:
                cx, cy = focus_xy
            else:
                cx = (extent["min_x"] + extent["max_x"]) * 0.5
                cy = (extent["min_y"] + extent["max_y"]) * 0.5

            def _dist2(l: Dict[str, Any]) -> float:
                b = l.get("bbox") or {}
                mx = (float(b.get("min_x", 0.0)) + float(b.get("max_x", 0.0))) * 0.5
                my = (float(b.get("min_y", 0.0)) + float(b.get("max_y", 0.0))) * 0.5
                dx = mx - cx
                dy = my - cy
                return dx * dx + dy * dy

            lanes.sort(key=_dist2)
            lanes = lanes[: int(max_lanes)]
            lanes_truncated = True

        return {
            "map_id": parsed_map.get("map_id"),
            "map_file": parsed_map.get("map_file"),
            "lanes_truncated": lanes_truncated,
            "lanes": [
                {
                    "id": l.get("id"),
                    "lane_type": l.get("lane_type"),
                    "turn_direction": l.get("turn_direction"),
                    "is_intersection": l.get("is_intersection"),
                    "has_traffic_control": l.get("has_traffic_control"),
                    "centerline": l.get("centerline") or [],
                    "left_boundary": l.get("left_boundary") or [],
                    "right_boundary": l.get("right_boundary") or [],
                    "polygon": l.get("polygon") or [],
                }
                for l in lanes
            ],
            "stoplines": [{"id": x.get("id"), "centerline": x.get("centerline") or []} for x in stoplines],
            "crosswalks": [{"id": x.get("id"), "polygon": x.get("polygon") or []} for x in crosswalks],
            "junctions": [{"id": x.get("id"), "polygon": x.get("polygon") or []} for x in junctions],
        }

    @staticmethod
    def _polyline_midpoint(pts: List[Tuple[float, float]]) -> Optional[Tuple[float, float]]:
        if not pts:
            return None
        i = int(max(0, (len(pts) - 1) // 2))
        x, y = pts[i]
        return float(x), float(y)

    def _traffic_light_anchors(
        self,
        parsed_map: Optional[Dict[str, Any]],
        extent_hint: Optional[Dict[str, float]],
        n: int,
    ) -> List[Tuple[float, float]]:
        pts: List[Tuple[float, float]] = []
        if parsed_map:
            for s in parsed_map.get("stoplines", []) or []:
                mid = self._polyline_midpoint(s.get("centerline") or [])
                if mid is not None:
                    pts.append(mid)
            if not pts:
                for ln in parsed_map.get("lanes", []) or []:
                    mid = self._polyline_midpoint(ln.get("centerline") or [])
                    if mid is not None:
                        pts.append(mid)
                        if len(pts) >= 12:
                            break

        if not pts and extent_hint and bbox_is_valid(extent_hint):
            cx = (extent_hint["min_x"] + extent_hint["max_x"]) * 0.5
            cy = (extent_hint["min_y"] + extent_hint["max_y"]) * 0.5
            w = max(8.0, abs(extent_hint["max_x"] - extent_hint["min_x"]))
            h = max(8.0, abs(extent_hint["max_y"] - extent_hint["min_y"]))
            r = 0.32 * min(w, h)
            for i in range(max(4, n)):
                a = (2.0 * math.pi * float(i)) / float(max(4, n))
                pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))

        if not pts:
            pts = [(0.0, 0.0)]

        uniq: List[Tuple[float, float]] = []
        seen = set()
        for x, y in pts:
            key = (round(float(x), 3), round(float(y), 3))
            if key in seen:
                continue
            seen.add(key)
            uniq.append((float(x), float(y)))
        if not uniq:
            uniq = [(0.0, 0.0)]

        if n <= 0:
            return uniq
        out = list(uniq)
        i = 0
        while len(out) < n:
            out.append(uniq[i % len(uniq)])
            i += 1
        return out[:n]

    def _background_meta_for_scene(
        self,
        ref: _SindScenarioRef,
        map_bbox: Optional[Dict[str, float]],
    ) -> Optional[Dict[str, Any]]:
        bg = ref.background_path
        if bg is None or not bg.exists() or not bg.is_file():
            return None
        size = read_png_size(bg)
        if not size:
            return None
        if map_bbox is None or not bbox_is_valid(map_bbox):
            return None
        w_px, h_px = size
        if w_px <= 0 or h_px <= 0:
            return None
        width_m = max(1e-6, float(map_bbox["max_x"]) - float(map_bbox["min_x"]))
        height_m = max(1e-6, float(map_bbox["max_y"]) - float(map_bbox["min_y"]))
        meters_per_px = 0.5 * (width_m / float(w_px) + height_m / float(h_px))
        return {
            "kind": "scene_image",
            "path": str(bg),
            "size_px": {"width": int(w_px), "height": int(h_px)},
            "meters_per_px": float(meters_per_px),
            "extent": {
                "min_x": float(map_bbox["min_x"]),
                "max_x": float(map_bbox["max_x"]),
                "min_y": float(map_bbox["min_y"]),
                "max_y": float(map_bbox["max_y"]),
            },
        }

    def get_scene_background(self, split: str, scene_id: str) -> Optional[Path]:
        split = self._SPLIT
        sid = str(scene_id or "")
        ref = self._scenes.get(sid)
        if ref is None:
            return None
        bg = ref.background_path
        if bg is None or not bg.exists() or not bg.is_file():
            return None
        return bg

    def load_scene_bundle(
        self,
        split: str,
        scene_id: str,
        include_map: bool = True,
        map_padding: float = 60.0,
        map_points_step: int = 5,
        max_lanes: int = 4000,
        map_clip: str = "intersection",
    ) -> Dict[str, Any]:
        split = self._SPLIT
        sid = str(scene_id or "")
        ref = self._scenes.get(sid)
        if ref is None:
            raise KeyError(f"scene not found: {sid}")

        warnings: List[str] = []
        infra_by_ts: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        tl_by_ts: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        extent = bbox_init()
        rows_infra = 0
        unique_agents: set[str] = set()
        sub_type_counts: Counter = Counter()

        for src_tag, path in (("veh", ref.veh_path), ("ped", ref.ped_path)):
            if path is None:
                continue
            by_ts, ext, rows, ids, st_counts = self._read_tracks_csv(path, source_tag=src_tag)
            for k, arr in by_ts.items():
                infra_by_ts[k].extend(arr)
            if bbox_is_valid(ext):
                bbox_update_from_bbox(extent, ext)
            rows_infra += int(rows)
            unique_agents.update(ids)
            sub_type_counts.update(st_counts)

        parsed_map: Optional[Dict[str, Any]] = None
        map_out: Optional[Dict[str, Any]] = None
        map_id: Optional[str] = None
        if ref.map_path is not None:
            try:
                parsed_map = self._load_lanelet_map_parsed(ref.map_path, points_step=map_points_step)
            except Exception as e:
                warnings.append(f"map_load_failed:{e}")

        tl_rows = 0
        if ref.tl_path is not None:
            tl_cols = self._tl_state_columns(ref.tl_path)
            anchors = self._traffic_light_anchors(parsed_map, extent if bbox_is_valid(extent) else None, len(tl_cols))
            tl_loaded, tl_extent, tl_rows = self._read_traffic_lights_csv(ref.tl_path, anchors=anchors)
            for k, arr in tl_loaded.items():
                tl_by_ts[k].extend(arr)
            if bbox_is_valid(tl_extent):
                bbox_update_from_bbox(extent, tl_extent)

        if not bbox_is_valid(extent):
            if parsed_map and parsed_map.get("bbox") and bbox_is_valid(parsed_map["bbox"]):
                extent = dict(parsed_map["bbox"])
                warnings.append("extent_from_map_bbox")
            else:
                extent = {"min_x": -10.0, "min_y": -10.0, "max_x": 10.0, "max_y": 10.0}
                warnings.append("extent_missing")

        if include_map:
            if parsed_map is None:
                warnings.append("map_missing")
            elif parsed_map.get("bbox") is not None:
                if map_clip == "scene":
                    clip_extent = bbox_pad(extent, map_padding)
                else:
                    clip_extent = parsed_map["bbox"]
                focus_xy = (
                    (extent["min_x"] + extent["max_x"]) * 0.5,
                    (extent["min_y"] + extent["max_y"]) * 0.5,
                )
                map_out = self._clip_lanelet_map(parsed_map, clip_extent, max_lanes=max_lanes, focus_xy=focus_xy)
                map_out["clip_mode"] = str(map_clip or "intersection")
                map_out["clip_extent"] = clip_extent
                map_out["points_step"] = int(max(1, map_points_step))
                map_out["counts"] = dict(parsed_map.get("counts") or {})
                map_out["bbox"] = parsed_map.get("bbox")
                map_id = str(parsed_map.get("map_id") or "") or None
            else:
                warnings.append("map_empty")

        all_keys = sorted(set(infra_by_ts.keys()) | set(tl_by_ts.keys()))
        timestamps = [self._ts_from_key(k) for k in all_keys]
        t0 = timestamps[0] if timestamps else 0.0
        frames = [{"infra": infra_by_ts.get(k, []), "traffic_light": tl_by_ts.get(k, [])} for k in all_keys]

        if rows_infra <= 0:
            warnings.append("scene_window_empty")
        if ref.tl_path is not None and tl_rows <= 0:
            warnings.append("traffic_light_empty")

        modality_stats = {
            "ego": {"rows": 0, "unique_ts": 0, "min_ts": None, "max_ts": None},
            "vehicle": {"rows": 0, "unique_ts": 0, "min_ts": None, "max_ts": None},
            "infra": {
                "rows": int(rows_infra),
                "unique_ts": int(len(infra_by_ts)),
                "min_ts": min((self._ts_from_key(k) for k in infra_by_ts.keys()), default=None),
                "max_ts": max((self._ts_from_key(k) for k in infra_by_ts.keys()), default=None),
                "unique_agents": int(len(unique_agents)),
                "sub_type_counts": dict(sub_type_counts),
            },
            "traffic_light": {
                "rows": int(tl_rows),
                "unique_ts": int(len(tl_by_ts)),
                "min_ts": min((self._ts_from_key(k) for k in tl_by_ts.keys()), default=None),
                "max_ts": max((self._ts_from_key(k) for k in tl_by_ts.keys()), default=None),
            },
        }

        background = self._background_meta_for_scene(ref, parsed_map.get("bbox") if parsed_map else None)
        if background is not None:
            background["url"] = f"/api/datasets/{self.spec.id}/scene/{split}/{sid}/background"

        return {
            "dataset_id": self.spec.id,
            "split": split,
            "scene_id": sid,
            "scene_label": self._scene_label(ref),
            "city": ref.city_id,
            "intersect_id": ref.city_id,
            "intersect_label": ref.city_label,
            "recording_id": ref.scenario_id,
            "recording_label": ref.scenario_label,
            "window_index": 0,
            "window_count": 1,
            "intersect_by_modality": {
                "infra": ref.city_id,
                "traffic_light": ref.city_id,
            },
            "map_id": map_id,
            "t0": t0,
            "timestamps": timestamps,
            "extent": extent,
            "map": map_out,
            "background": background,
            "modality_stats": modality_stats,
            "frames": frames,
            "warnings": warnings,
        }


@dataclass
class _CpmWindowIndex:
    bucket: int
    start_ms: int
    end_ms: int
    first_ts_ms: int
    last_ts_ms: int
    offset_start: int
    offset_end: int
    rows: int
    frames: int


@dataclass
class _CpmSensorIndex:
    sensor_id: str
    sensor_label: str
    path: Path
    header: str
    row_filter_field: Optional[str]
    row_filter_value: Optional[str]
    t0_ms: int
    window_ms: int
    windows: List[_CpmWindowIndex]


@dataclass
class _CpmSceneRef:
    scene_id: str
    split: str
    sensor_id: str
    window_i: int
    sensor_label: str
    path: Path
    window: _CpmWindowIndex


class CpmObjectsAdapter:
    """
    Adapter for Consider_it CPM object CSV logs (LiDAR/thermal).

    Data model:
    - "Intersection" in the UI becomes a sensor log (one CSV file).
    - "Scene" becomes a gap-aware, fixed-cap time window within that log:
      * we start a new scene if there is a large time gap in `generationTime_ms`
      * and we cap the scene duration so playback stays snappy
    - World coordinates are local to the sensor; no global map support.
    """

    # Defaults tuned for exploration:
    # - windows are long enough to be meaningful
    # - but short enough to load quickly (especially for dense LiDAR logs)
    DEFAULT_WINDOW_S = 300
    DEFAULT_GAP_S = 120
    DEFAULT_FRAME_BIN_MS = 100
    _CPM_ALIASES: Dict[str, Tuple[str, ...]] = {
        "generationTime_ms": ("generationTime_ms", "generation_time_ms", "generationtime", "timestamp_ms", "gen_time_ms"),
        "trackID": ("track_id", "trackID", "trackId", "track"),
        "objectID": ("objectID", "object_id", "track_id", "id"),
        "rsu": ("rsu", "rsu_id", "sensor_id", "sensor"),
        "xDistance_m": ("xDistance_m", "x_distance_m", "x_distance", "xdist_m", "north_m"),
        "yDistance_m": ("yDistance_m", "y_distance_m", "y_distance", "ydist_m", "east_m"),
        "xSpeed_mps": ("xSpeed_mps", "x_speed_mps", "vx_mps", "speed_x_mps", "north_speed_mps"),
        "ySpeed_mps": ("ySpeed_mps", "y_speed_mps", "vy_mps", "speed_y_mps", "east_speed_mps"),
        "yawAngle_deg": ("yawAngle_deg", "yaw_angle_deg", "heading_deg", "yaw_deg"),
        "classificationType": ("classificationType", "classification_type", "class_id", "object_class"),
        "objLength_m": ("objLength_m", "obj_length_m", "length_m"),
        "objWidth_m": ("objWidth_m", "obj_width_m", "width_m"),
        "objHeight_m": ("objHeight_m", "obj_height_m", "height_m"),
    }

    def __init__(self, spec: DatasetSpec, window_s: int | None = None, gap_s: int | None = None) -> None:
        self.spec = spec
        self._bindings = spec.bindings if isinstance(spec.bindings, dict) else {}
        strategy = spec.scene_strategy if isinstance(spec.scene_strategy, dict) else {}
        strategy_window = strategy.get("window_s")
        strategy_gap = strategy.get("gap_s")
        strategy_bin = strategy.get("frame_bin_ms")
        self.window_s = int(window_s or strategy_window or self.DEFAULT_WINDOW_S)
        self.window_ms = max(1, self.window_s) * 1000
        self.gap_s = int(gap_s or strategy_gap or self.DEFAULT_GAP_S)
        self.gap_ms = max(0, self.gap_s) * 1000
        self.frame_bin_ms = max(1, int(strategy_bin or self.DEFAULT_FRAME_BIN_MS))

        self._sensors: Dict[str, _CpmSensorIndex] = {}
        self._scenes: Dict[str, _CpmSceneRef] = {}
        self._scene_ids_sorted: Dict[str, List[str]] = {"all": []}
        self._scene_ids_by_sensor: Dict[str, Dict[str, List[str]]] = {"all": {}}
        self._scene_index: Dict[str, Dict[str, int]] = {"all": {}}
        self._scene_index_by_sensor: Dict[str, Dict[str, Dict[str, int]]] = {"all": {}}

        self._build_index()

    def _bucket_ts_ms(self, ts_ms: int) -> int:
        b = int(self.frame_bin_ms)
        if b <= 1:
            return int(ts_ms)
        # Keep stable temporal ordering while coalescing close timestamps into one frame.
        return int(ts_ms // b) * b

    @staticmethod
    def _norm_col(s: Any) -> str:
        return re.sub(r"[^a-z0-9]+", "", str(s or "").strip().lower())

    def _binding_obj(self, role: str) -> Dict[str, Any]:
        v = self._bindings.get(role) if isinstance(self._bindings, dict) else None
        return v if isinstance(v, dict) else {}

    def _binding_paths(self, role: str) -> List[Path]:
        obj = self._binding_obj(role)
        out: List[Path] = []
        if isinstance(obj.get("paths"), list):
            for raw in obj.get("paths"):
                try:
                    p = Path(str(raw)).expanduser().resolve()
                except Exception:
                    continue
                out.append(p)
        elif obj.get("path"):
            try:
                out.append(Path(str(obj.get("path"))).expanduser().resolve())
            except Exception:
                pass
        return out

    def _binding_column_map(self) -> Dict[str, str]:
        obj = self._binding_obj("cpm_logs")
        raw = obj.get("column_map")
        if not isinstance(raw, dict):
            return {}
        out: Dict[str, str] = {}
        for k, v in raw.items():
            kk = str(k or "").strip()
            vv = str(v or "").strip()
            if kk and vv:
                out[kk] = vv
        return out

    def _binding_delimiter(self) -> str:
        obj = self._binding_obj("cpm_logs")
        raw = str(obj.get("delimiter") or ",")
        if raw not in (",", ";", "\t"):
            return ","
        return raw

    def _binding_encoding(self) -> str:
        obj = self._binding_obj("cpm_logs")
        enc = str(obj.get("encoding") or "utf-8").strip().lower()
        if not enc:
            return "utf-8"
        return enc

    def _resolve_field_map(self, fieldnames: Iterable[str]) -> Dict[str, str]:
        fields = [str(x or "").strip() for x in fieldnames]
        by_norm: Dict[str, str] = {}
        for f in fields:
            n = self._norm_col(f)
            if n and n not in by_norm:
                by_norm[n] = f

        out: Dict[str, str] = {}
        # Prefer canonical columns whenever they exist in the file.
        for canonical in self._CPM_ALIASES.keys():
            got = by_norm.get(self._norm_col(canonical))
            if got:
                out[canonical] = got

        explicit = self._binding_column_map()
        for canonical, actual in explicit.items():
            if canonical in out:
                continue
            if actual in fields:
                out[canonical] = actual

        for canonical, aliases in self._CPM_ALIASES.items():
            if canonical in out:
                continue
            for alias in aliases:
                got = by_norm.get(self._norm_col(alias))
                if got:
                    out[canonical] = got
                    break
        return out

    def _row_value(self, row: Dict[str, Any], field_map: Dict[str, str], canonical: str) -> Any:
        key = field_map.get(canonical)
        if not key:
            return None
        return row.get(key)

    @staticmethod
    def _as_int_ms(raw: Any) -> Optional[int]:
        v = safe_float(raw)
        if v is None:
            return None
        try:
            return int(v)
        except Exception:
            return None

    def _open_reader_with_map(self, path: Path) -> Tuple[Any, Any, Dict[str, str], str]:
        encoding = self._binding_encoding()
        pref = self._binding_delimiter()
        candidates: List[str] = []
        for d in (pref, ",", ";", "\t"):
            if d not in candidates:
                candidates.append(d)

        fallback: Optional[Tuple[Any, Any, Dict[str, str], str]] = None
        for d in candidates:
            f = path.open("r", encoding=encoding, errors="replace", newline="")
            r = csv.DictReader(f, delimiter=d)
            fmap = self._resolve_field_map(r.fieldnames or [])
            if "generationTime_ms" in fmap:
                return f, r, fmap, d
            if fallback is None:
                fallback = (f, r, fmap, d)
            else:
                f.close()

        if fallback is not None:
            return fallback

        # Defensive fallback.
        f = path.open("r", encoding=encoding, errors="replace", newline="")
        r = csv.DictReader(f, delimiter=pref)
        fmap = self._resolve_field_map(r.fieldnames or [])
        return f, r, fmap, pref

    def _looks_like_cpm_csv(self, path: Path) -> bool:
        try:
            with path.open("r", encoding="utf-8", errors="replace") as f:
                header_line = f.readline().strip()
        except Exception:
            return False
        if not header_line:
            return False
        delimiter = "," if header_line.count(",") >= header_line.count(";") else ";"
        fields = [x.strip() for x in header_line.split(delimiter)]
        fmap = self._resolve_field_map(fields)
        return all(k in fmap for k in ("generationTime_ms", "xDistance_m", "yDistance_m"))

    @staticmethod
    def _sensor_id_from_rel(rel: Path) -> str:
        # Stable, URL-safe identifier (no slashes).
        s = str(rel.as_posix())
        if s.lower().endswith(".csv"):
            s = s[:-4]
        return s.replace("/", "__")

    @staticmethod
    def _fmt_date_from_yyyymmdd(s: str) -> str:
        if len(s) != 8 or not s.isdigit():
            return s
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"

    def _sensor_label_from_rel(self, rel: Path) -> str:
        parts = rel.as_posix().split("/")
        if parts and parts[0] == "lidar":
            rsu = parts[1] if len(parts) >= 2 else "RSU"
            return f"LiDAR {rsu}"
        if parts and parts[0] == "thermal_camera":
            stem = rel.stem
            m = re.match(r"^(\d{8})-(.+)$", stem)
            if m:
                date = self._fmt_date_from_yyyymmdd(m.group(1))
                return f"Thermal camera ({date})"
            return f"Thermal camera {rel.name}"
        return rel.stem

    def _discover_csv_files(self) -> List[Path]:
        # Keep bound file list (from profile detection), but also rescan root and
        # merge in any missing logs. This makes the app resilient to partial or
        # stale saved bindings when users add new files later.
        bound = [p for p in self._binding_paths("cpm_logs") if p.exists() and p.is_file()]
        merged: List[Path] = []
        seen = set()
        for p in sorted(bound):
            k = str(p.resolve())
            if k in seen:
                continue
            seen.add(k)
            merged.append(p.resolve())

        root = self.spec.root
        if root.exists():
            files = sorted(root.glob("**/*.csv"))
            for p in files:
                if not p.is_file():
                    continue
                if not self._looks_like_cpm_csv(p):
                    continue
                k = str(p.resolve())
                if k in seen:
                    continue
                seen.add(k)
                merged.append(p.resolve())
        return merged

    def _index_one_csv(self, path: Path) -> List[_CpmSensorIndex]:
        try:
            rel = path.relative_to(self.spec.root)
        except Exception:
            rel = Path(path.name)
        base_sensor_id = self._sensor_id_from_rel(rel)
        base_sensor_label = self._sensor_label_from_rel(rel)
        try:
            with path.open("r", encoding=self._binding_encoding(), errors="replace") as f0:
                header = f0.readline()
        except Exception:
            header = ""

        # A CPM file can contain multiple physical sensors (e.g., LiDAR RSUs).
        # Index them separately for clearer UI and stable playback.
        per_sensor_ts: Dict[str, Counter] = defaultdict(Counter)
        sensor_meta: Dict[str, Tuple[str, Optional[str], Optional[str]]] = {}
        found_any = False

        f = None
        try:
            f, r, field_map, _ = self._open_reader_with_map(path)
            rsu_col = field_map.get("rsu")
            for row in r:
                ts_ms = self._as_int_ms(self._row_value(row, field_map, "generationTime_ms"))
                if ts_ms is None:
                    continue
                found_any = True
                ts_b = self._bucket_ts_ms(int(ts_ms))

                rsu_val: Optional[str] = None
                if rsu_col:
                    try:
                        rs = row.get(rsu_col)
                        rsu_val = str(rs).strip() if rs is not None else None
                    except Exception:
                        rsu_val = None
                    if rsu_val == "":
                        rsu_val = None

                if rsu_val:
                    rsu_norm = re.sub(r"[^a-zA-Z0-9_-]+", "_", rsu_val)
                    sensor_id = f"{base_sensor_id}__{rsu_norm}"
                    sensor_label = f"LiDAR {rsu_val}"
                    per_sensor_ts[sensor_id][ts_b] += 1
                    if sensor_id not in sensor_meta:
                        sensor_meta[sensor_id] = (sensor_label, rsu_col, rsu_val)
                else:
                    per_sensor_ts[base_sensor_id][ts_b] += 1
                    if base_sensor_id not in sensor_meta:
                        sensor_meta[base_sensor_id] = (base_sensor_label, None, None)
        finally:
            if f is not None:
                try:
                    f.close()
                except Exception:
                    pass

        if not found_any:
            return []

        out: List[_CpmSensorIndex] = []
        for sensor_id, ts_counts in sorted(per_sensor_ts.items(), key=lambda kv: kv[0]):
            windows: List[_CpmWindowIndex] = []
            ts_sorted = sorted(ts_counts.keys())
            if ts_sorted:
                bucket = 0
                cur_first = int(ts_sorted[0])
                cur_last = int(ts_sorted[0])
                cur_rows = int(ts_counts[cur_first])
                cur_frames = 1
                prev = cur_last

                for ts in ts_sorted[1:]:
                    g = int(ts)
                    gap = g - prev
                    dur = g - cur_first
                    if gap > self.gap_ms or dur >= self.window_ms:
                        windows.append(
                            _CpmWindowIndex(
                                bucket=bucket,
                                start_ms=cur_first,
                                end_ms=cur_last,
                                first_ts_ms=cur_first,
                                last_ts_ms=cur_last,
                                offset_start=0,
                                offset_end=0,
                                rows=int(cur_rows),
                                frames=int(cur_frames),
                            )
                        )
                        bucket += 1
                        cur_first = g
                        cur_last = g
                        cur_rows = int(ts_counts[g])
                        cur_frames = 1
                    else:
                        cur_last = g
                        cur_rows += int(ts_counts[g])
                        cur_frames += 1
                    prev = g

                windows.append(
                    _CpmWindowIndex(
                        bucket=bucket,
                        start_ms=cur_first,
                        end_ms=cur_last,
                        first_ts_ms=cur_first,
                        last_ts_ms=cur_last,
                        offset_start=0,
                        offset_end=0,
                        rows=int(cur_rows),
                        frames=int(cur_frames),
                    )
                )
                t0_ms = int(ts_sorted[0])
            else:
                t0_ms = 0

            label, filt_field, filt_value = sensor_meta.get(sensor_id, (base_sensor_label, None, None))
            out.append(
                _CpmSensorIndex(
                    sensor_id=sensor_id,
                    sensor_label=label,
                    path=path,
                    header=header,
                    row_filter_field=filt_field,
                    row_filter_value=filt_value,
                    t0_ms=int(t0_ms),
                    window_ms=self.window_ms,
                    windows=windows,
                )
            )
        return out

    def _build_index(self) -> None:
        files = self._discover_csv_files()
        for path in files:
            items = self._index_one_csv(path)
            for idx in items:
                self._sensors[idx.sensor_id] = idx

        # Flatten into global, stable scene ordering.
        flat: List[Tuple[str, int, int]] = []
        for sensor_id, s in self._sensors.items():
            for wi, w in enumerate(s.windows):
                flat.append((sensor_id, w.first_ts_ms, wi))
        flat.sort(key=lambda t: (t[0], t[1], t[2]))

        split = "all"
        self._scene_ids_sorted[split] = []
        self._scene_ids_by_sensor[split] = defaultdict(list)

        for n, (sensor_id, _ts, wi) in enumerate(flat, start=1):
            scene_id = str(n)
            s = self._sensors[sensor_id]
            ref = _CpmSceneRef(
                scene_id=scene_id,
                split=split,
                sensor_id=sensor_id,
                window_i=wi,
                sensor_label=s.sensor_label,
                path=s.path,
                window=s.windows[wi],
            )
            self._scenes[scene_id] = ref
            self._scene_ids_sorted[split].append(scene_id)
            self._scene_ids_by_sensor[split][sensor_id].append(scene_id)

        self._scene_index[split] = {sid: i for i, sid in enumerate(self._scene_ids_sorted[split])}
        self._scene_index_by_sensor[split] = {sid: {x: i for i, x in enumerate(lst)} for sid, lst in self._scene_ids_by_sensor[split].items()}

    def list_intersections(self, split: str) -> List[Dict[str, Any]]:
        # This dataset has no train/val; treat any split as "all".
        split = "all"
        items = []
        for s in sorted(self._sensors.values(), key=lambda x: x.sensor_id):
            items.append(
                {
                    "intersect_id": s.sensor_id,
                    "intersect_label": s.sensor_label,
                    "count": len(self._scene_ids_by_sensor[split].get(s.sensor_id, [])),
                }
            )
        # Prefer LiDAR streams first in UI ordering; thermal camera can stay available.
        def _sensor_rank(label: str) -> int:
            lab = str(label or "").lower()
            if lab.startswith("lidar"):
                return 0
            if lab.startswith("thermal"):
                return 1
            return 2
        items.sort(key=lambda it: (_sensor_rank(it.get("intersect_label")), -int(it["count"]), str(it["intersect_label"])))
        return items

    def list_scenes(
        self,
        split: str,
        intersect_id: Optional[str] = None,
        limit: int = 200,
        offset: int = 0,
        include_tl_only: bool = False,
    ) -> Dict[str, Any]:
        split = "all"
        if intersect_id:
            ids = list(self._scene_ids_by_sensor[split].get(intersect_id, []))
        else:
            ids = list(self._scene_ids_sorted[split])

        total = len(ids)
        slice_ = ids[offset : offset + limit]
        items = []
        for sid in slice_:
            ref = self._scenes[sid]
            w = ref.window
            dur_s = max(0.0, float(w.last_ts_ms - w.first_ts_ms) / 1000.0)

            # A human-friendly label: local time-of-day range for the window.
            try:
                t0 = _dt.datetime.fromtimestamp(w.first_ts_ms / 1000.0)
                t1 = _dt.datetime.fromtimestamp(w.last_ts_ms / 1000.0)
                time_label = f"{t0.strftime('%H:%M:%S')}–{t1.strftime('%H:%M:%S')}"
            except Exception:
                time_label = "window"

            items.append(
                {
                    "scene_id": ref.scene_id,
                    "scene_label": f"Scene {ref.scene_id} · {time_label}",
                    "split": split,
                    "city": None,
                    "intersect_id": ref.sensor_id,
                    "intersect_label": ref.sensor_label,
                    "by_modality": {
                        "infra": {
                            "rows": int(w.rows),
                            "min_ts": float(w.first_ts_ms) / 1000.0,
                            "max_ts": float(w.last_ts_ms) / 1000.0,
                            "unique_ts": int(w.frames),
                            "duration_s": dur_s,
                            "unique_agents": None,
                        }
                    },
                }
            )

        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "items": items,
            "availability": {
                "scene_count": total,
                "by_modality": {"infra": total},
            },
            "include_tl_only": bool(include_tl_only),
        }

    def locate_scene(self, split: str, scene_id: str) -> Dict[str, Any]:
        split = "all"
        scene_id = str(scene_id)
        ref = self._scenes.get(scene_id)
        if ref is None:
            return {"split": split, "scene_id": scene_id, "found": False}

        idx_all = self._scene_index[split].get(scene_id)
        idx_in = self._scene_index_by_sensor[split].get(ref.sensor_id, {}).get(scene_id)

        return {
            "split": split,
            "scene_id": scene_id,
            "found": True,
            "city": None,
            "intersect_id": ref.sensor_id,
            "intersect_label": ref.sensor_label,
            "index_all": idx_all,
            "total_all": len(self._scene_ids_sorted[split]),
            "index_in_intersection": idx_in,
            "total_in_intersection": len(self._scene_ids_by_sensor[split].get(ref.sensor_id, [])),
        }

    @staticmethod
    def _class_to_type_and_subtype(classification_type: Optional[int]) -> Tuple[str, Optional[str]]:
        """
        Consider.it CPM class mapping:
        - 0: VEHICLE
        - 1: VRU
        Some legacy exports may still contain broader proto ids; collapse them
        to the same two-class taxonomy for a consistent viewer experience.
        """
        if classification_type is None:
            return "UNKNOWN", None

        if classification_type == 0:
            return "VEHICLE", "VEHICLE"
        if classification_type == 1:
            return "VRU", "VRU"

        # Legacy proto ranges, collapsed to the same two classes.
        if 2 <= classification_type <= 11:
            return "VEHICLE", "VEHICLE"
        if 12 <= classification_type <= 21:
            return "VRU", "VRU"

        return "UNKNOWN", None

    def load_scene_bundle(
        self,
        split: str,
        scene_id: str,
        include_map: bool = True,
        map_padding: float = 60.0,
        map_points_step: int = 5,
        max_lanes: int = 4000,
        map_clip: str = "intersection",
    ) -> Dict[str, Any]:
        split = "all"
        scene_id = str(scene_id)
        ref = self._scenes.get(scene_id)
        if ref is None:
            raise KeyError(f"scene not found: {scene_id}")

        warnings: List[str] = []
        w = ref.window

        by_ts: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        extent = bbox_init()
        rows = 0
        obj_ids = set()

        f = None
        try:
            f, r, field_map, _ = self._open_reader_with_map(ref.path)
            sensor_idx = self._sensors.get(ref.sensor_id)
            filter_field = sensor_idx.row_filter_field if sensor_idx else None
            filter_value = sensor_idx.row_filter_value if sensor_idx else None
            for row in r:
                if filter_field and filter_value is not None:
                    rv = row.get(filter_field)
                    if str(rv).strip() != str(filter_value):
                        continue

                ts_ms_raw = self._as_int_ms(self._row_value(row, field_map, "generationTime_ms"))
                if ts_ms_raw is None:
                    continue
                ts_ms = self._bucket_ts_ms(int(ts_ms_raw))
                if ts_ms is None:
                    continue
                if ts_ms < w.start_ms or ts_ms > w.end_ms:
                    continue
                rows += 1

                track_id = self._row_value(row, field_map, "trackID")
                oid_raw = self._row_value(row, field_map, "objectID")
                oid = track_id if track_id not in (None, "") else oid_raw
                obj_ids.add(oid)

                # Dataset frame is local to the sensor:
                # proto says xDistance=meters north, yDistance=meters east -> convert to (x=east, y=north)
                y_north = safe_float(self._row_value(row, field_map, "xDistance_m"))
                x_east = safe_float(self._row_value(row, field_map, "yDistance_m"))
                x = x_east
                y = y_north
                if x is not None and y is not None:
                    bbox_update(extent, x, y)

                vx_north = safe_float(self._row_value(row, field_map, "xSpeed_mps"))
                vy_east = safe_float(self._row_value(row, field_map, "ySpeed_mps"))
                v_x = vy_east
                v_y = vx_north

                yaw_deg = safe_float(self._row_value(row, field_map, "yawAngle_deg"))
                theta = None
                if yaw_deg is not None:
                    # yaw is clockwise from north -> theta is CCW from east (x axis)
                    theta = math.radians(90.0 - float(yaw_deg))

                cls = self._row_value(row, field_map, "classificationType")
                cls_i: Optional[int] = None
                try:
                    if cls not in (None, ""):
                        cls_i = int(float(cls))
                except Exception:
                    cls_i = None

                rec = {
                    "id": oid,
                    "track_id": track_id,
                    "object_id": oid_raw,
                    "type": None,
                    "sub_type": None,
                    "sub_type_code": cls_i,
                    "tag": ref.sensor_id,
                    "x": x,
                    "y": y,
                    "z": None,
                    "length": safe_float(self._row_value(row, field_map, "objLength_m")),
                    "width": safe_float(self._row_value(row, field_map, "objWidth_m")),
                    "height": safe_float(self._row_value(row, field_map, "objHeight_m")),
                    "theta": theta,
                    "v_x": v_x,
                    "v_y": v_y,
                }
                t, st = self._class_to_type_and_subtype(cls_i)
                rec["type"] = t
                rec["sub_type"] = st
                by_ts[ts_ms].append(rec)
        except Exception as e:
            raise RuntimeError(f"failed to read scene window from {ref.path}: {e}")
        finally:
            if f is not None:
                try:
                    f.close()
                except Exception:
                    pass

        ts_list = sorted(by_ts.keys())
        timestamps = [float(t) / 1000.0 for t in ts_list]
        t0 = timestamps[0] if timestamps else 0.0

        if not bbox_is_valid(extent):
            extent = {"min_x": -10.0, "min_y": -10.0, "max_x": 10.0, "max_y": 10.0}
            warnings.append("extent_missing: could not compute extent from window rows")
        if rows == 0:
            warnings.append("scene_window_empty")

        frames: List[Dict[str, Any]] = []
        for ts in ts_list:
            frames.append({"infra": by_ts.get(ts, [])})

        modality_stats = {
            "ego": {"rows": 0, "unique_ts": 0, "min_ts": None, "max_ts": None},
            "vehicle": {"rows": 0, "unique_ts": 0, "min_ts": None, "max_ts": None},
            "traffic_light": {"rows": 0, "unique_ts": 0, "min_ts": None, "max_ts": None},
            "infra": {
                "rows": int(rows),
                "unique_ts": int(len(ts_list)),
                "min_ts": float(ts_list[0]) / 1000.0 if ts_list else None,
                "max_ts": float(ts_list[-1]) / 1000.0 if ts_list else None,
                "unique_agents": int(len(obj_ids)),
            },
        }

        return {
            "dataset_id": self.spec.id,
            "split": split,
            "scene_id": scene_id,
            "city": None,
            "intersect_id": ref.sensor_id,
            "intersect_label": ref.sensor_label,
            "intersect_by_modality": {"infra": ref.sensor_id},
            "map_id": None,
            "t0": t0,
            "timestamps": timestamps,
            "extent": extent,
            "modality_stats": modality_stats,
            "frames": frames,
            "warnings": warnings,
        }


class _LRUCache:
    def __init__(self, max_items: int) -> None:
        self.max_items = max_items
        self._d: "OrderedDict[Tuple[str, str], Any]" = OrderedDict()

    def get(self, key: Tuple[str, str]) -> Any:
        v = self._d.get(key)
        if v is None:
            return None
        self._d.move_to_end(key)
        return v

    def set(self, key: Tuple[str, str], value: Any) -> None:
        self._d[key] = value
        self._d.move_to_end(key)
        while len(self._d) > self.max_items:
            self._d.popitem(last=False)


def load_registry(repo_root: Path) -> List[DatasetSpec]:
    def _resolve_path(p: Optional[str]) -> Optional[Path]:
        if not p:
            return None
        s = str(p)
        try:
            pp = Path(s).expanduser()
        except Exception:
            return None
        if pp.is_absolute():
            return pp.resolve()
        return (repo_root / s).resolve()

    def _parse_lat_lon(obj: Any) -> Optional[Tuple[float, float]]:
        if obj is None:
            return None
        lat: Any = None
        lon: Any = None
        if isinstance(obj, dict):
            lat = obj.get("lat", obj.get("latitude"))
            lon = obj.get("lon", obj.get("lng", obj.get("longitude")))
        elif isinstance(obj, (list, tuple)) and len(obj) >= 2:
            lat = obj[0]
            lon = obj[1]
        else:
            return None
        try:
            lat_f = float(lat)
            lon_f = float(lon)
        except Exception:
            return None
        if not (-90.0 <= lat_f <= 90.0 and -180.0 <= lon_f <= 180.0):
            return None
        return (lat_f, lon_f)

    def _merge_registry(base: Dict[str, Any], local: Dict[str, Any]) -> Dict[str, Any]:
        merged = {"datasets": []}
        base_items = list(base.get("datasets", []) or [])
        local_items = list(local.get("datasets", []) or [])
        by_id: Dict[str, Dict[str, Any]] = {}
        ordered: List[str] = []
        for it in base_items:
            if not isinstance(it, dict) or "id" not in it:
                continue
            iid = str(it["id"])
            by_id[iid] = dict(it)
            ordered.append(iid)
        for it in local_items:
            if not isinstance(it, dict) or "id" not in it:
                continue
            iid = str(it["id"])
            if iid in by_id:
                # Local overrides base keys.
                by_id[iid].update(it)
            else:
                by_id[iid] = dict(it)
                ordered.append(iid)
        merged["datasets"] = [by_id[i] for i in ordered if i in by_id]
        return merged

    registry_path_env = str(os.environ.get("TRAJ_REGISTRY_PATH") or "").strip()
    if registry_path_env:
        registry_path = _resolve_path(registry_path_env)
        if registry_path is None:
            return []
    else:
        registry_path = repo_root / "dataset" / "registry.json"
    if not registry_path.exists():
        return []
    raw_base = json.loads(registry_path.read_text())

    # Optional local overrides (private paths / basemap origins, etc).
    raw_local: Dict[str, Any] = {}
    local_path_env = str(os.environ.get("TRAJ_REGISTRY_LOCAL") or "").strip()
    if local_path_env:
        local_path = _resolve_path(local_path_env)
    else:
        local_path = repo_root / "dataset" / "registry.local.json"
    if local_path is None:
        local_path = repo_root / "dataset" / "registry.local.json"
    if local_path.exists():
        try:
            raw_local = json.loads(local_path.read_text())
        except Exception:
            raw_local = {}

    raw = _merge_registry(raw_base, raw_local) if raw_local else raw_base
    datasets_raw = list(raw.get("datasets", []) or [])

    # Append profile-backed dataset entries. This keeps static registry datasets
    # working as before while allowing per-user local dataset connections.
    try:
        prof_entries = load_profile_dataset_entries(repo_root)
    except Exception:
        prof_entries = []
    if prof_entries:
        by_id: Dict[str, int] = {}
        families_present: set[str] = set()
        for i, d in enumerate(datasets_raw):
            if not isinstance(d, dict):
                continue
            iid = str(d.get("id") or "").strip()
            fam = str(d.get("family") or "").strip()
            if iid:
                by_id[iid] = i
            if fam:
                families_present.add(fam)

        for entry in prof_entries:
            if not isinstance(entry, dict) or "id" not in entry:
                continue
            iid = str(entry.get("id") or "").strip()
            fam = str(entry.get("family") or "").strip()
            if not iid:
                continue

            idx = by_id.get(iid)
            if idx is not None:
                cur = datasets_raw[idx] if isinstance(datasets_raw[idx], dict) else {}
                merged = dict(cur)
                # Profile-backed data source should override source-related keys
                # while preserving the canonical catalog/registry identity fields.
                for k in ("root", "bindings", "scene_strategy", "profile_id", "scenes", "basemap"):
                    if k in entry and entry.get(k) not in (None, "", [], {}):
                        merged[k] = entry.get(k)
                if not merged.get("family") and fam:
                    merged["family"] = fam
                if not merged.get("title") and entry.get("title"):
                    merged["title"] = entry.get("title")
                datasets_raw[idx] = merged
                if fam:
                    families_present.add(fam)
                continue

            # Keep one dataset card per family in the app: if the static registry
            # already has this family, skip extra profile-only ids.
            if fam and fam in families_present:
                continue

            datasets_raw.append(entry)
            by_id[iid] = len(datasets_raw) - 1
            if fam:
                families_present.add(fam)

    out: List[DatasetSpec] = []
    for d in datasets_raw:
        if not isinstance(d, dict):
            continue
        try:
            root = _resolve_path(d.get("root"))
            if root is None:
                raise ValueError("missing root")
            basemap = d.get("basemap") if isinstance(d.get("basemap"), dict) else {}
            geo_origin = _parse_lat_lon(basemap.get("origin")) if basemap else None
            geo_by: Optional[Dict[str, Tuple[float, float]]] = None
            if basemap and isinstance(basemap.get("origin_by_intersect"), dict):
                geo_by = {}
                for k, v in basemap["origin_by_intersect"].items():
                    ll = _parse_lat_lon(v)
                    if ll is not None:
                        geo_by[str(k)] = ll
                if not geo_by:
                    geo_by = None

            ds = DatasetSpec(
                id=str(d["id"]),
                title=str(d.get("title") or d["id"]),
                family=str(d.get("family") or "generic"),
                root=root,
                profile=_resolve_path(d.get("profile")) if d.get("profile") else None,
                scenes=_resolve_path(d.get("scenes")) if d.get("scenes") else None,
                bindings=dict(d.get("bindings")) if isinstance(d.get("bindings"), dict) else None,
                scene_strategy=dict(d.get("scene_strategy")) if isinstance(d.get("scene_strategy"), dict) else None,
                geo_origin=geo_origin,
                geo_origin_by_intersect=geo_by,
                basemap_tile_url=str(basemap.get("tile_url")) if basemap and basemap.get("tile_url") else None,
                basemap_attribution=str(basemap.get("attribution")) if basemap and basemap.get("attribution") else None,
            )
        except Exception:
            continue
        out.append(ds)
    return out


class DatasetStore:
    _SUPPORTED_FAMILIES = set(SUPPORTED_DATASET_FAMILIES)

    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root
        self.specs = {s.id: s for s in load_registry(repo_root)}
        self.adapters: Dict[str, Any] = {}
        self._adapter_errors: Dict[str, str] = {}
        self._adapter_lock = threading.Lock()
        self._dataset_list_cache: Optional[List[Dict[str, Any]]] = None

    @classmethod
    def _is_supported_family(cls, family: str) -> bool:
        return str(family or "").strip() in cls._SUPPORTED_FAMILIES

    @staticmethod
    def _strategy_int(spec: DatasetSpec, key: str) -> Optional[int]:
        strat = spec.scene_strategy if isinstance(spec.scene_strategy, dict) else {}
        raw = str(strat.get(key) or "").strip()
        return int(raw) if raw.isdigit() else None

    def _build_adapter(self, spec: DatasetSpec) -> Any:
        if spec.family == "v2x-traj":
            return V2XTrajAdapter(spec)
        if spec.family == "v2x-seq":
            return V2XSeqAdapter(spec)
        if spec.family == "ind":
            return InDAdapter(spec, window_s=self._strategy_int(spec, "window_s"))
        if spec.family == "sind":
            return SinDAdapter(spec)
        if spec.family == "cpm-objects":
            # Consider_it CPM object logs (CSV). No global map; viewed in local sensor frame.
            return CpmObjectsAdapter(
                spec,
                window_s=self._strategy_int(spec, "window_s"),
                gap_s=self._strategy_int(spec, "gap_s"),
            )
        raise KeyError(f"unsupported dataset family: {spec.family}")

    @staticmethod
    def _probe_sind_assets(data_root: Path) -> Tuple[bool, bool, bool]:
        has_map = False
        has_bg = False
        has_tl = False
        if not data_root.exists() or not data_root.is_dir():
            return has_map, has_bg, has_tl
        try:
            for dirpath, _dirs, files in os.walk(data_root):
                for name in files:
                    low = str(name or "").lower()
                    if not has_map and low.endswith(".osm"):
                        has_map = True
                    if not has_bg and low.endswith(".png"):
                        has_bg = True
                    if not has_tl and low.endswith(".csv") and "traffic" in low and "meta" not in low and not low.startswith(".~lock"):
                        has_tl = True
                    if has_map and has_bg and has_tl:
                        return has_map, has_bg, has_tl
        except Exception:
            return has_map, has_bg, has_tl
        return has_map, has_bg, has_tl

    @staticmethod
    def _dataset_meta(spec: DatasetSpec) -> Dict[str, Any]:
        # Keep this additive: the frontend can ignore these fields safely.
        if spec.family == "v2x-traj":
            bindings = spec.bindings if isinstance(spec.bindings, dict) else {}
            map_path = ((bindings.get("maps_dir") or {}).get("path")) if isinstance(bindings.get("maps_dir"), dict) else None
            tl_path = ((bindings.get("traffic_light") or {}).get("path")) if isinstance(bindings.get("traffic_light"), dict) else None
            has_map = bool(Path(str(map_path)).expanduser().exists()) if map_path else bool((spec.root / "maps").exists())
            has_tl = bool(Path(str(tl_path)).expanduser().exists()) if tl_path else bool((spec.root / "traffic-light").exists())
            return {
                "splits": ["train", "val"],
                "default_split": "train",
                "group_label": "Intersection",
                "has_map": has_map,
                "modalities": ["ego", "infra", "vehicle", "traffic_light"],
                "modality_labels": {"ego": "Ego vehicle", "infra": "Infrastructure", "vehicle": "Other vehicles", "traffic_light": "Traffic lights"},
                "modality_short_labels": {"ego": "Ego", "infra": "Infra", "vehicle": "Vehicles", "traffic_light": "Lights"},
                "has_traffic_lights": has_tl,
            }
        if spec.family == "v2x-seq":
            bindings = spec.bindings if isinstance(spec.bindings, dict) else {}
            map_path = ((bindings.get("maps_dir") or {}).get("path")) if isinstance(bindings.get("maps_dir"), dict) else None
            tl_path = ((bindings.get("traffic_light") or {}).get("path")) if isinstance(bindings.get("traffic_light"), dict) else None
            has_map = bool(Path(str(map_path)).expanduser().exists()) if map_path else bool((spec.root / "maps").exists())
            has_tl = bool(Path(str(tl_path)).expanduser().exists()) if tl_path else bool((spec.root / "single-infrastructure" / "traffic-light").exists())
            return {
                "splits": ["train", "val"],
                "default_split": "val",
                "group_label": "Intersection",
                "has_map": has_map,
                "modalities": ["ego", "infra", "vehicle", "traffic_light"],
                "modality_labels": {
                    "ego": "Cooperative vehicle-infrastructure",
                    "infra": "Single infrastructure",
                    "vehicle": "Single vehicle",
                    "traffic_light": "Traffic lights",
                },
                "modality_short_labels": {"ego": "Coop", "infra": "Infra", "vehicle": "Vehicle", "traffic_light": "Lights"},
                "has_traffic_lights": has_tl,
            }
        if spec.family == "cpm-objects":
            meta: Dict[str, Any] = {
                "splits": ["all"],
                "default_split": "all",
                "group_label": "Sensor",
                "has_map": False,
                # CPM object logs are a single stream of detected objects (no ego/vehicles/TL split).
                "modalities": ["infra"],
                "modality_labels": {"infra": "Objects"},
                "modality_short_labels": {"infra": "Objects"},
            }
            if spec.geo_origin or spec.geo_origin_by_intersect:
                bm: Dict[str, Any] = {
                    "provider": "osm",
                    # Prefer same-origin tile proxy to avoid client-side adblock/CORS issues.
                    "tile_url": spec.basemap_tile_url or "/api/tiles/osm/{z}/{x}/{y}.png",
                    "attribution": spec.basemap_attribution or "© OpenStreetMap contributors",
                }
                if spec.geo_origin:
                    bm["origin"] = {"lat": spec.geo_origin[0], "lon": spec.geo_origin[1]}
                if spec.geo_origin_by_intersect:
                    bm["origin_by_intersect"] = {k: {"lat": v[0], "lon": v[1]} for k, v in spec.geo_origin_by_intersect.items()}
                meta["basemap"] = bm
            return meta
        if spec.family == "ind":
            bindings = spec.bindings if isinstance(spec.bindings, dict) else {}
            map_path = ((bindings.get("maps_dir") or {}).get("path")) if isinstance(bindings.get("maps_dir"), dict) else None
            has_map = False
            map_roots: List[Path] = []
            if map_path:
                p = Path(str(map_path)).expanduser()
                map_roots.append((p / "lanelets"))
                map_roots.append(p)
            map_roots.append(spec.root / "maps" / "lanelets")
            map_roots.append(spec.root / "maps")
            for mr in map_roots:
                try:
                    if mr.exists() and mr.is_dir() and next(mr.rglob("*.osm"), None) is not None:
                        has_map = True
                        break
                except Exception:
                    continue
            return {
                "splits": ["all"],
                "default_split": "all",
                "group_label": "Location",
                "has_map": has_map,
                "has_scene_background": True,
                "has_traffic_lights": False,
                "modalities": ["infra"],
                "modality_labels": {"infra": "Road users"},
                "modality_short_labels": {"infra": "Objects"},
            }
        if spec.family == "sind":
            bindings = spec.bindings if isinstance(spec.bindings, dict) else {}
            data_dir_raw = ((bindings.get("data_dir") or {}).get("path")) if isinstance(bindings.get("data_dir"), dict) else None
            data_root = Path(str(data_dir_raw)).expanduser() if data_dir_raw else spec.root
            has_map, has_bg, has_tl = DatasetStore._probe_sind_assets(data_root)
            return {
                "splits": ["all"],
                "default_split": "all",
                "group_label": "City",
                "has_map": has_map,
                "has_scene_background": has_bg,
                "has_traffic_lights": has_tl,
                "modalities": ["infra", "traffic_light"],
                "modality_labels": {"infra": "Road users", "traffic_light": "Traffic lights"},
                "modality_short_labels": {"infra": "Objects", "traffic_light": "Lights"},
            }
        return {
            "splits": ["all"],
            "default_split": "all",
            "group_label": "Group",
            "has_map": False,
            "modalities": ["infra"],
            "modality_labels": {"infra": "Objects"},
            "modality_short_labels": {"infra": "Objects"},
        }

    def list_datasets(self) -> List[Dict[str, Any]]:
        if self._dataset_list_cache is not None:
            return [dict(x) for x in self._dataset_list_cache]
        out = []
        for spec in self.specs.values():
            meta = self._dataset_meta(spec)
            supported = self._is_supported_family(spec.family)
            item: Dict[str, Any] = {
                "id": spec.id,
                "title": spec.title,
                "family": spec.family,
                "supported": supported,
                **meta,
            }
            if not supported:
                item["unsupported_reason"] = f"Unsupported dataset family: {spec.family}"
            out.append(item)
        self._dataset_list_cache = [dict(x) for x in out]
        return out

    def get_adapter(self, dataset_id: str) -> Any:
        spec = self.specs.get(dataset_id)
        if spec is None:
            raise KeyError(f"dataset not found or unsupported: {dataset_id}")
        if not self._is_supported_family(spec.family):
            raise KeyError(f"dataset not found or unsupported: {dataset_id}")

        with self._adapter_lock:
            cached = self.adapters.get(dataset_id)
            if cached is not None:
                return cached

            cached_error = self._adapter_errors.get(dataset_id)
            if cached_error is not None:
                raise RuntimeError(cached_error)

            try:
                adapter = self._build_adapter(spec)
            except Exception as e:
                msg = f"failed to initialize dataset adapter '{dataset_id}': {e}"
                self._adapter_errors[dataset_id] = msg
                raise RuntimeError(msg) from e

            self.adapters[dataset_id] = adapter
            return adapter
