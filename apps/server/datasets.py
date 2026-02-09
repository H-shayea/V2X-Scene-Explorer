from __future__ import annotations

import csv
import datetime as _dt
import io
import json
import math
import os
import re
from collections import Counter, OrderedDict, defaultdict
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


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
        if spec.scenes is None:
            raise ValueError("v2x-traj adapter requires scenes.csv")

        self._scene_index: Dict[str, Dict[str, SceneSummary]] = {"train": {}, "val": {}}
        self._intersections: Dict[str, Counter] = {"train": Counter(), "val": Counter()}
        self._load_scenes_csv(spec.scenes)

        # Precompute stable scene ordering and indices for paging/jump-to-scene UX.
        self._sorted_scene_ids: Dict[str, List[str]] = {"train": [], "val": []}
        self._scene_id_to_index: Dict[str, Dict[str, int]] = {"train": {}, "val": {}}
        self._sorted_scene_ids_by_intersect: Dict[str, Dict[str, List[str]]] = {"train": {}, "val": {}}
        self._scene_id_to_index_by_intersect: Dict[str, Dict[str, Dict[str, int]]] = {"train": {}, "val": {}}
        self._build_scene_indices()

        self._map_cache: Dict[Tuple[int, int], Dict[str, Any]] = {}
        self._csv_cache: _LRUCache = _LRUCache(max_items=24)

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
            return base / "ego-trajectories" / split / "data" / f"{scene_id}.csv"
        if modality == "infra":
            return base / "infrastructure-trajectories" / split / "data" / f"{scene_id}.csv"
        if modality == "vehicle":
            return base / "vehicle-trajectories" / split / "data" / f"{scene_id}.csv"
        if modality == "traffic_light":
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

        maps_dir = self.spec.root / "maps"
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

    def __init__(self, spec: DatasetSpec, window_s: int | None = None, gap_s: int | None = None) -> None:
        self.spec = spec
        self.window_s = int(window_s or self.DEFAULT_WINDOW_S)
        self.window_ms = max(1, self.window_s) * 1000
        self.gap_s = int(gap_s or self.DEFAULT_GAP_S)
        self.gap_ms = max(0, self.gap_s) * 1000

        self._sensors: Dict[str, _CpmSensorIndex] = {}
        self._scenes: Dict[str, _CpmSceneRef] = {}
        self._scene_ids_sorted: Dict[str, List[str]] = {"all": []}
        self._scene_ids_by_sensor: Dict[str, Dict[str, List[str]]] = {"all": {}}
        self._scene_index: Dict[str, Dict[str, int]] = {"all": {}}
        self._scene_index_by_sensor: Dict[str, Dict[str, Dict[str, int]]] = {"all": {}}

        self._build_index()

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
            return "Thermal camera"
        return rel.stem

    def _discover_csv_files(self) -> List[Path]:
        root = self.spec.root
        if not root.exists():
            return []
        files = sorted(root.glob("**/*cpm-objects.csv"))
        return [p for p in files if p.is_file()]

    def _index_one_csv(self, path: Path) -> _CpmSensorIndex:
        rel = path.relative_to(self.spec.root)
        sensor_id = self._sensor_id_from_rel(rel)
        sensor_label = self._sensor_label_from_rel(rel)

        with path.open("rb") as fb:
            header_bytes = fb.readline()
            header = header_bytes.decode("utf-8", errors="replace")
            t0_ms: Optional[int] = None

            windows_raw: List[Dict[str, Any]] = []
            cur: Optional[Dict[str, Any]] = None
            last_frame_ms: Optional[int] = None

            while True:
                pos = fb.tell()
                line = fb.readline()
                if not line:
                    break
                comma = line.find(b",")
                if comma <= 0:
                    continue
                try:
                    g = int(line[:comma])
                except Exception:
                    continue

                if t0_ms is None:
                    t0_ms = g

                is_new_frame = (last_frame_ms != g)

                # Start a new window if:
                # - we see a large time gap between frames (prevents "teleporting" during playback)
                # - or the window grows past the cap (keeps interactive performance predictable)
                if cur is None:
                    cur = {
                        "bucket": int(len(windows_raw)),
                        "offset_start": int(pos),
                        "first_ts_ms": int(g),
                        "last_ts_ms": int(g),
                        "rows": 0,
                        "frames": 0,
                    }
                    windows_raw.append(cur)
                elif is_new_frame and last_frame_ms is not None:
                    gap = int(g - last_frame_ms)
                    dur = int(g - int(cur["first_ts_ms"]))
                    if gap > self.gap_ms or dur >= self.window_ms:
                        cur = {
                            "bucket": int(len(windows_raw)),
                            "offset_start": int(pos),
                            "first_ts_ms": int(g),
                            "last_ts_ms": int(g),
                            "rows": 0,
                            "frames": 0,
                        }
                        windows_raw.append(cur)

                cur["rows"] += 1
                if is_new_frame:
                    cur["frames"] += 1
                    last_frame_ms = g
                cur["last_ts_ms"] = int(g)

            if t0_ms is None:
                t0_ms = 0

            eof = fb.tell()
            windows: List[_CpmWindowIndex] = []
            for i, w in enumerate(windows_raw):
                off0 = int(w["offset_start"])
                off1 = int(windows_raw[i + 1]["offset_start"]) if i + 1 < len(windows_raw) else int(eof)
                b = int(w["bucket"])
                start_ms = int(w["first_ts_ms"])
                end_ms = int(min(int(w["last_ts_ms"]), start_ms + self.window_ms))
                windows.append(
                    _CpmWindowIndex(
                        bucket=b,
                        start_ms=start_ms,
                        end_ms=end_ms,
                        first_ts_ms=int(w["first_ts_ms"]),
                        last_ts_ms=int(w["last_ts_ms"]),
                        offset_start=off0,
                        offset_end=off1,
                        rows=int(w["rows"]),
                        frames=int(w["frames"]),
                    )
                )

        return _CpmSensorIndex(
            sensor_id=sensor_id,
            sensor_label=sensor_label,
            path=path,
            header=header,
            t0_ms=int(t0_ms),
            window_ms=self.window_ms,
            windows=windows,
        )

    def _build_index(self) -> None:
        files = self._discover_csv_files()
        for path in files:
            idx = self._index_one_csv(path)
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
        items.sort(key=lambda it: (-int(it["count"]), str(it["intersect_label"])))
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
        Decode PerceptionSensorData.ObjectType from sensor_interface-v1.2.1.proto.

        We keep `type` aligned with the existing viewer's high-level filters, and
        put fine-grained labels in `sub_type`.
        """
        if classification_type is None:
            return "UNKNOWN", None

        # Vehicle types (0..11)
        if classification_type == 0:
            return "VEHICLE", "UNKNOWN"
        if classification_type == 1:
            return "VEHICLE", "MOPED"
        if classification_type == 2:
            return "VEHICLE", "MOTORCYCLE"
        if classification_type == 3:
            return "VEHICLE", "CAR"
        if classification_type == 4:
            return "VEHICLE", "BUS"
        if classification_type == 5:
            return "VEHICLE", "LIGHT_TRUCK"
        if classification_type == 6:
            return "VEHICLE", "HEAVY_TRUCK"
        if classification_type == 7:
            return "VEHICLE", "TRAILER"
        if classification_type == 8:
            return "VEHICLE", "SPECIAL_VEHICLE"
        if classification_type == 9:
            return "VEHICLE", "TRAM"
        if classification_type == 10:
            return "VEHICLE", "EMERGENCY_VEHICLE"
        if classification_type == 11:
            return "VEHICLE", "AGRICULTURAL"

        # Person types (12..18). Map cyclist (15) to BICYCLE for existing filters.
        if classification_type == 12:
            return "PEDESTRIAN", "PERSON_UNKNOWN"
        if classification_type == 13:
            return "PEDESTRIAN", "PEDESTRIAN"
        if classification_type == 14:
            return "PEDESTRIAN", "WHEELCHAIR"
        if classification_type == 15:
            return "BICYCLE", "CYCLIST"
        if classification_type == 16:
            return "PEDESTRIAN", "STROLLER"
        if classification_type == 17:
            return "PEDESTRIAN", "SKATES"
        if classification_type == 18:
            return "PEDESTRIAN", "PERSON_GROUP"

        # Animal / other
        if classification_type == 19:
            return "ANIMAL", "ANIMAL"
        if classification_type == 20:
            return "OTHER", "OTHER_UNKNOWN"
        if classification_type == 21:
            return "RSU", "ROADSIDE_UNIT"

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

        # Read just the window region (between stored byte offsets).
        try:
            with ref.path.open("rb") as fb:
                header = self._sensors[ref.sensor_id].header
                fb.seek(w.offset_start)
                chunk = fb.read(max(0, w.offset_end - w.offset_start))
                text = header + chunk.decode("utf-8", errors="replace")
        except Exception as e:
            raise RuntimeError(f"failed to read scene window from {ref.path}: {e}")

        by_ts: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        extent = bbox_init()
        rows = 0
        obj_ids = set()

        r = csv.DictReader(io.StringIO(text))
        for row in r:
            rows += 1
            g_ms = safe_float(row.get("generationTime_ms"))
            if g_ms is None:
                continue
            ts_ms = int(g_ms)

            oid = row.get("objectID")
            obj_ids.add(oid)

            # Dataset frame is local to the sensor:
            # proto says xDistance=meters north, yDistance=meters east -> convert to (x=east, y=north)
            y_north = safe_float(row.get("xDistance_m"))
            x_east = safe_float(row.get("yDistance_m"))
            x = x_east
            y = y_north
            if x is not None and y is not None:
                bbox_update(extent, x, y)

            vx_north = safe_float(row.get("xSpeed_mps"))
            vy_east = safe_float(row.get("ySpeed_mps"))
            v_x = vy_east
            v_y = vx_north

            yaw_deg = safe_float(row.get("yawAngle_deg"))
            theta = None
            if yaw_deg is not None:
                # yaw is clockwise from north -> theta is CCW from east (x axis)
                theta = math.radians(90.0 - float(yaw_deg))

            cls = row.get("classificationType")
            cls_i: Optional[int] = None
            try:
                if cls not in (None, ""):
                    cls_i = int(float(cls))
            except Exception:
                cls_i = None

            rec = {
                "id": oid,
                "type": None,
                "sub_type": None,
                "sub_type_code": cls_i,
                "tag": ref.sensor_id,
                "x": x,
                "y": y,
                "z": None,
                "length": safe_float(row.get("objLength_m")),
                "width": safe_float(row.get("objWidth_m")),
                "height": safe_float(row.get("objHeight_m")),
                "theta": theta,
                "v_x": v_x,
                "v_y": v_y,
            }
            t, st = self._class_to_type_and_subtype(cls_i)
            rec["type"] = t
            rec["sub_type"] = st
            by_ts[ts_ms].append(rec)

        ts_list = sorted(by_ts.keys())
        timestamps = [float(t) / 1000.0 for t in ts_list]
        t0 = timestamps[0] if timestamps else 0.0

        if not bbox_is_valid(extent):
            extent = {"min_x": -10.0, "min_y": -10.0, "max_x": 10.0, "max_y": 10.0}
            warnings.append("extent_missing: could not compute extent from window rows")

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

    registry_path = repo_root / "dataset" / "registry.json"
    if not registry_path.exists():
        return []
    raw_base = json.loads(registry_path.read_text())

    # Optional local overrides (private paths / basemap origins, etc).
    raw_local: Dict[str, Any] = {}
    local_path = repo_root / "dataset" / "registry.local.json"
    if local_path.exists():
        try:
            raw_local = json.loads(local_path.read_text())
        except Exception:
            raw_local = {}

    raw = _merge_registry(raw_base, raw_local) if raw_local else raw_base

    out: List[DatasetSpec] = []
    for d in raw.get("datasets", []):
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
                self.adapters[spec.id] = CpmObjectsAdapter(spec)

    @staticmethod
    def _dataset_meta(spec: DatasetSpec) -> Dict[str, Any]:
        # Keep this additive: the frontend can ignore these fields safely.
        if spec.family == "v2x-traj":
            return {
                "splits": ["train", "val"],
                "default_split": "train",
                "group_label": "Intersection",
                "has_map": True,
                "modalities": ["ego", "infra", "vehicle", "traffic_light"],
                "modality_labels": {"ego": "Ego vehicle", "infra": "Infrastructure", "vehicle": "Other vehicles", "traffic_light": "Traffic lights"},
                "modality_short_labels": {"ego": "Ego", "infra": "Infra", "vehicle": "Vehicles", "traffic_light": "Lights"},
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
