from __future__ import annotations

import csv
import datetime as _dt
import json
import math
import os
import re
from collections import Counter, OrderedDict, defaultdict
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    from apps.server.profiles import load_profile_dataset_entries
except ModuleNotFoundError:
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
                k = str(p.resolve())
                if k in seen:
                    continue
                seen.add(k)
                out.append(p.resolve())
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

    def list_scenes(
        self,
        split: str,
        intersect_id: Optional[str] = None,
        limit: int = 200,
        offset: int = 0,
    ) -> Dict[str, Any]:
        scenes = list(self._scene_index.get(split, {}).values())
        if intersect_id:
            scenes = [s for s in scenes if s.intersect_id == intersect_id]
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

        return {"total": total, "limit": limit, "offset": offset, "items": items}

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

        lanes_out: List[Dict[str, Any]] = []
        for lane_id, lane in (data.get("LANE") or {}).items():
            if not isinstance(lane, dict):
                continue
            cl = parse_polyline(lane.get("centerline"))
            if not cl:
                continue
            lanes_out.append(
                {
                    "id": lane_id,
                    "lane_type": lane.get("lane_type"),
                    "turn_direction": lane.get("turn_direction"),
                    "is_intersection": lane.get("is_intersection"),
                    "has_traffic_control": lane.get("has_traffic_control"),
                    "centerline": cl,
                    "bbox": feature_bbox(cl),
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

        return {"total": total, "limit": limit, "offset": offset, "items": items}

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
    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root
        self.specs = {s.id: s for s in load_registry(repo_root)}
        self.adapters: Dict[str, Any] = {}

        for spec in self.specs.values():
            if spec.family == "v2x-traj":
                self.adapters[spec.id] = V2XTrajAdapter(spec)
            elif spec.family == "cpm-objects":
                # Consider_it CPM object logs (CSV). No global map; viewed in local sensor frame.
                strat = spec.scene_strategy if isinstance(spec.scene_strategy, dict) else {}
                window_s = int(strat.get("window_s")) if str(strat.get("window_s") or "").strip().isdigit() else None
                gap_s = int(strat.get("gap_s")) if str(strat.get("gap_s") or "").strip().isdigit() else None
                self.adapters[spec.id] = CpmObjectsAdapter(spec, window_s=window_s, gap_s=gap_s)

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
        out = []
        for spec in self.specs.values():
            meta = self._dataset_meta(spec)
            supported = spec.id in self.adapters
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
        return out

    def get_adapter(self, dataset_id: str) -> Any:
        if dataset_id not in self.adapters:
            raise KeyError(f"dataset not found or unsupported: {dataset_id}")
        return self.adapters[dataset_id]
