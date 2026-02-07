#!/usr/bin/env python3
"""
Phase A dataset profiler.

Goals:
- Build an evidence-based understanding of the dataset(s) on disk.
- Validate joins/alignment across modalities (where possible).
- Produce:
  - a human report (Markdown)
  - a machine-readable profile (JSON)

This script intentionally uses only the Python standard library (no pandas/numpy).
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import os
import re
import statistics
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


SCAN_LEVELS = ("keys", "geometry", "full")
DEFAULT_DATASET_CANDIDATES = (
    "dataset/v2x-traj",
    "../dataset/v2x-traj",
)


def now_iso() -> str:
    return dt.datetime.now().astimezone().replace(microsecond=0).isoformat()


def display_path(path: Path, base: Optional[Path] = None) -> str:
    """
    Prefer repo/local relative paths in logs and reports.
    Falls back to plain string when relative conversion is not possible.
    """
    if base is None:
        base = Path.cwd()
    try:
        return str(path.relative_to(base))
    except ValueError:
        return str(path)


def choose_default_dataset_root() -> Optional[Path]:
    for candidate in DEFAULT_DATASET_CANDIDATES:
        p = Path(candidate)
        if p.exists():
            return p
    return None


def human_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    units = ["KB", "MB", "GB", "TB", "PB"]
    x = float(n)
    for u in units:
        x /= 1024.0
        if x < 1024.0:
            return f"{x:.1f} {u}"
    return f"{x:.1f} EB"


def safe_float(s: str) -> Optional[float]:
    if s is None:
        return None
    s = s.strip()
    if s == "":
        return None
    try:
        x = float(s)
    except ValueError:
        return None
    if math.isfinite(x):
        return x
    return None


def safe_int(s: str) -> Optional[int]:
    if s is None:
        return None
    s = s.strip()
    if s == "":
        return None
    try:
        return int(s)
    except ValueError:
        return None


def parse_point_xy(p: Any) -> Optional[Tuple[float, float]]:
    """
    Map JSON often stores points as strings like "(x, y)".
    Accepts:
    - "(x, y)" strings
    - [x, y] / (x, y) sequences
    Returns (x, y) floats or None.
    """
    if p is None:
        return None
    if isinstance(p, (list, tuple)) and len(p) >= 2:
        x = safe_float(str(p[0]))
        y = safe_float(str(p[1]))
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


def percentile(sorted_vals: Sequence[float], p: float) -> float:
    """
    p in [0, 100]. Linear interpolation between closest ranks.
    """
    if not sorted_vals:
        raise ValueError("percentile on empty list")
    if p <= 0:
        return float(sorted_vals[0])
    if p >= 100:
        return float(sorted_vals[-1])
    k = (len(sorted_vals) - 1) * (p / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return float(sorted_vals[int(k)])
    d0 = sorted_vals[f] * (c - k)
    d1 = sorted_vals[c] * (k - f)
    return float(d0 + d1)


def summarize_distribution(values: Sequence[float]) -> Dict[str, Any]:
    if not values:
        return {"count": 0}
    vals = list(values)
    vals.sort()
    count = len(vals)
    mean = float(sum(vals) / count)
    return {
        "count": count,
        "min": float(vals[0]),
        "p05": percentile(vals, 5),
        "p25": percentile(vals, 25),
        "p50": percentile(vals, 50),
        "p75": percentile(vals, 75),
        "p95": percentile(vals, 95),
        "max": float(vals[-1]),
        "mean": mean,
    }


@dataclass
class ColumnNumericAgg:
    min: Optional[float] = None
    max: Optional[float] = None
    missing: int = 0
    parse_error: int = 0

    def update(self, raw: str) -> None:
        if raw is None or raw.strip() == "":
            self.missing += 1
            return
        x = safe_float(raw)
        if x is None:
            self.parse_error += 1
            return
        if self.min is None or x < self.min:
            self.min = x
        if self.max is None or x > self.max:
            self.max = x


@dataclass
class CsvFileStats:
    file: str
    scene_id: str
    rows: int
    min_ts: Optional[float]
    max_ts: Optional[float]
    unique_ts: int
    duration_s: Optional[float]
    unique_agents: Optional[int] = None
    intersect_id: Optional[str] = None
    intersect_label: Optional[str] = None
    intersect_id_variants: int = 0
    city: Optional[str] = None


@dataclass
class CsvTableProfile:
    name: str
    rel_dir: str
    file_count: int
    total_rows: int
    columns_union: List[str]
    columns_variants: Dict[str, int]
    numeric: Dict[str, ColumnNumericAgg]
    categorical_values: Dict[str, List[str]]
    delta_t_counts: Dict[str, int]
    rows_per_file: Dict[str, Any]
    unique_ts_per_file: Dict[str, Any]
    duration_s_per_file: Dict[str, Any]
    unique_agents_per_file: Optional[Dict[str, Any]] = None
    files: List[CsvFileStats] = field(default_factory=list)


@dataclass
class MapProfile:
    file: str
    map_id: Optional[int]
    top_keys: List[str]
    entity_counts: Dict[str, int]
    lane_fields_sample: List[str]
    bbox_xy_sampled: Optional[Dict[str, float]] = None


@dataclass
class DatasetProfile:
    dataset_root: str
    generated_at: str
    scan_level: str
    total_size_bytes: int
    tables: List[CsvTableProfile]
    maps: List[MapProfile]
    alignment: Dict[str, Any]
    notes: List[str]


def dataset_total_size(root: Path) -> int:
    total = 0
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            try:
                total += (Path(dirpath) / fn).stat().st_size
            except OSError:
                pass
    return total


def detect_family(root: Path) -> str:
    if (root / "ego-trajectories").exists() and (root / "traffic-light").exists():
        return "v2x-traj"
    if (root / "single-vehicle").exists() and (root / "maps").exists():
        return "v2x-seq-tfd"
    return "generic"


def discover_csv_dirs(root: Path) -> List[Path]:
    dirs: Dict[Path, int] = defaultdict(int)
    for dirpath, _, filenames in os.walk(root):
        count = 0
        for fn in filenames:
            if fn.lower().endswith(".csv"):
                count += 1
        if count:
            dirs[Path(dirpath)] = count
    # Prefer stable ordering
    return sorted(dirs.keys(), key=lambda p: str(p))


def parse_intersect_to_map_id(intersect_id: str) -> Optional[int]:
    if not intersect_id:
        return None
    m = re.search(r"#(\d+)", intersect_id)
    if m:
        return int(m.group(1))
    return None


def intersection_label(intersect_id: Optional[str]) -> Optional[str]:
    """
    Human-readable, explicit naming for UI elements.
    Example: yizhuang#4-1_po -> Yizhuang Intersection 04
    """
    if not intersect_id:
        return None
    map_id = parse_intersect_to_map_id(intersect_id)
    if map_id is None:
        return f"Intersection ({intersect_id})"
    return f"Yizhuang Intersection {map_id:02d}"


def parse_map_filename_to_id(name: str) -> Optional[int]:
    # Accept yizhuang_hdmap4.json, hdmap4.json, etc.
    m = re.search(r"hdmap(\d+)", name)
    if m:
        return int(m.group(1))
    m = re.search(r"(\d+)", name)
    if m:
        return int(m.group(1))
    return None


def profile_maps(maps_dir: Path, bbox_sample_step: int = 10) -> Tuple[List[MapProfile], Dict[int, set]]:
    if not maps_dir.exists():
        return [], {}
    out: List[MapProfile] = []
    lane_ids_by_map: Dict[int, set] = {}

    for p in sorted(maps_dir.glob("*.json")):
        try:
            data = json.loads(p.read_text())
        except Exception:
            # If a map fails to parse, still record the filename.
            out.append(
                MapProfile(
                    file=p.name,
                    map_id=parse_map_filename_to_id(p.name),
                    top_keys=[],
                    entity_counts={},
                    lane_fields_sample=[],
                    bbox_xy_sampled=None,
                )
            )
            continue

        top_keys = list(data.keys())
        entity_counts: Dict[str, int] = {}
        for k in top_keys:
            v = data.get(k)
            if isinstance(v, dict):
                entity_counts[k] = len(v)
            elif isinstance(v, list):
                entity_counts[k] = len(v)

        lane_fields: set = set()
        bbox = {"min_x": None, "min_y": None, "max_x": None, "max_y": None}
        lane_dict = data.get("LANE")
        if isinstance(lane_dict, dict) and lane_dict:
            # Sample lane fields and bbox from lane centerlines.
            lane_items = list(lane_dict.items())
            for i, (_, lane) in enumerate(lane_items[:200]):
                if isinstance(lane, dict):
                    lane_fields.update(lane.keys())

            # bbox sampling: iterate all lanes, but only parse every Nth point per lane.
            for _, lane in lane_dict.items():
                if not isinstance(lane, dict):
                    continue
                cl = lane.get("centerline")
                if not isinstance(cl, list) or not cl:
                    continue
                for j, pt in enumerate(cl):
                    if bbox_sample_step > 1 and (j % bbox_sample_step) != 0:
                        continue
                    xy = parse_point_xy(pt)
                    if xy is None:
                        continue
                    x, y = xy
                    if bbox["min_x"] is None or x < bbox["min_x"]:
                        bbox["min_x"] = x
                    if bbox["max_x"] is None or x > bbox["max_x"]:
                        bbox["max_x"] = x
                    if bbox["min_y"] is None or y < bbox["min_y"]:
                        bbox["min_y"] = y
                    if bbox["max_y"] is None or y > bbox["max_y"]:
                        bbox["max_y"] = y

        map_id = parse_map_filename_to_id(p.name)
        if map_id is not None and isinstance(lane_dict, dict):
            lane_ids_by_map[map_id] = set(lane_dict.keys())

        bbox_out = None
        if all(v is not None for v in bbox.values()):
            bbox_out = {k: float(v) for k, v in bbox.items() if v is not None}

        out.append(
            MapProfile(
                file=p.name,
                map_id=map_id,
                top_keys=top_keys,
                entity_counts=entity_counts,
                lane_fields_sample=sorted(lane_fields),
                bbox_xy_sampled=bbox_out,
            )
        )

    return out, lane_ids_by_map


def profile_csv_table(
    dataset_root: Path,
    table_dir: Path,
    scan_level: str,
    lane_ids_by_map: Dict[int, set],
    progress_every: int = 500,
) -> Tuple[CsvTableProfile, Dict[str, CsvFileStats]]:
    rel_dir = str(table_dir.relative_to(dataset_root))
    name = rel_dir
    files = sorted(table_dir.glob("*.csv"), key=lambda p: p.name)

    # Heuristics: treat as traffic-light if the path contains that segment.
    is_traffic_light = "traffic-light" in rel_dir.replace("\\\\", "/")

    # Columns we care about
    key_cols = ["city", "timestamp", "intersect_id"]
    traj_cat_cols = ["type", "sub_type", "tag"]
    tl_cat_cols = ["direction", "color_1", "color_2", "color_3"]
    tl_id_cols = ["lane_id"]
    traj_id_cols = ["id"]

    traj_numeric_by_level = {
        "keys": ["timestamp"],
        "geometry": ["timestamp", "x", "y", "theta", "v_x", "v_y"],
        "full": ["timestamp", "x", "y", "z", "length", "width", "height", "theta", "v_x", "v_y"],
    }
    tl_numeric_cols = ["timestamp", "x", "y", "remain_1", "remain_2", "remain_3"]

    categorical_cols = list(key_cols)
    if is_traffic_light:
        categorical_cols += tl_cat_cols
    else:
        categorical_cols += traj_cat_cols

    numeric_cols = tl_numeric_cols if is_traffic_light else traj_numeric_by_level[scan_level]

    # Aggregates
    total_rows = 0
    columns_union: set = set()
    columns_variants: Counter = Counter()
    numeric_aggs: Dict[str, ColumnNumericAgg] = {c: ColumnNumericAgg() for c in numeric_cols}
    cat_sets: Dict[str, set] = {c: set() for c in categorical_cols if c not in ("timestamp",)}
    delta_t_counts: Counter = Counter()
    rows_per_file: List[int] = []
    unique_ts_per_file: List[int] = []
    duration_s_per_file: List[float] = []
    unique_agents_per_file: List[int] = []

    per_scene: Dict[str, CsvFileStats] = {}

    # Track lane_id validity against maps (traffic-light only)
    lane_id_missing_total = 0
    lane_id_checked_total = 0
    lane_id_map_miss_by_map: Counter = Counter()

    for idx, p in enumerate(files, start=1):
        scene_id = p.stem
        rows = 0
        min_ts: Optional[float] = None
        max_ts: Optional[float] = None
        ts_set: set = set()
        agent_ids: Optional[set] = set() if (not is_traffic_light and "id" in traj_id_cols) else None
        intersect_ids: set = set()
        city_values: set = set()
        lane_ids: Optional[set] = set() if is_traffic_light else None

        try:
            with p.open("r", newline="") as f:
                reader = csv.reader(f)
                header = next(reader, None)
                if header is None:
                    header = []
                header = [h.strip() for h in header]
                columns_union.update(header)
                columns_variants[",".join(header)] += 1
                col_to_idx = {c: i for i, c in enumerate(header)}

                # Resolve indices (if present)
                idx_city = col_to_idx.get("city")
                idx_ts = col_to_idx.get("timestamp")
                idx_intersect = col_to_idx.get("intersect_id")
                idx_id = col_to_idx.get("id")
                idx_lane = col_to_idx.get("lane_id")

                numeric_idxs = [(c, col_to_idx[c]) for c in numeric_cols if c in col_to_idx]
                cat_idxs = [(c, col_to_idx[c]) for c in cat_sets.keys() if c in col_to_idx]
                # id / lane tracked separately

                for row in reader:
                    if not row:
                        continue
                    rows += 1

                    # timestamp is both numeric and used for cadence stats
                    if idx_ts is not None and idx_ts < len(row):
                        raw_ts = row[idx_ts]
                        numeric_aggs["timestamp"].update(raw_ts)
                        ts = safe_float(raw_ts)
                        if ts is not None:
                            ts_set.add(ts)
                            if min_ts is None or ts < min_ts:
                                min_ts = ts
                            if max_ts is None or ts > max_ts:
                                max_ts = ts

                    # intersect_id should usually be constant per scene
                    if idx_intersect is not None and idx_intersect < len(row):
                        intersect_ids.add(row[idx_intersect].strip())

                    if idx_city is not None and idx_city < len(row):
                        city_values.add(row[idx_city].strip())

                    if agent_ids is not None and idx_id is not None and idx_id < len(row):
                        agent_ids.add(row[idx_id].strip())

                    if lane_ids is not None and idx_lane is not None and idx_lane < len(row):
                        lane_ids.add(row[idx_lane].strip())

                    # numeric cols (excluding timestamp which we already handled)
                    for c, j in numeric_idxs:
                        if c == "timestamp":
                            continue
                        raw = row[j] if j < len(row) else ""
                        numeric_aggs[c].update(raw)

                    # categorical cols
                    for c, j in cat_idxs:
                        if j >= len(row):
                            continue
                        v = row[j].strip()
                        if v != "":
                            # Cap unbounded categories to avoid accidental blowups
                            s = cat_sets.get(c)
                            if s is not None and len(s) < 200:
                                s.add(v)

        except Exception:
            # If we fail to read a file, still record it with empty stats.
            per_scene[scene_id] = CsvFileStats(
                file=p.name,
                scene_id=scene_id,
                rows=0,
                min_ts=None,
                max_ts=None,
                unique_ts=0,
                duration_s=None,
            )
            continue

        total_rows += rows
        rows_per_file.append(rows)

        # Unique timestamps and dt distribution
        unique_ts = 0
        duration_s: Optional[float] = None
        if ts_set:
            unique_ts = len(ts_set)
            unique_ts_per_file.append(unique_ts)
            if min_ts is not None and max_ts is not None:
                duration_s = max_ts - min_ts
                duration_s_per_file.append(duration_s)
            if len(ts_set) > 1:
                ts_sorted = sorted(ts_set)
                for a, b in zip(ts_sorted, ts_sorted[1:]):
                    d = round(b - a, 3)
                    if d > 0:
                        delta_t_counts[str(d)] += 1

        unique_agents = None
        if agent_ids is not None:
            unique_agents = len(agent_ids)
            unique_agents_per_file.append(unique_agents)

        intersect_id = None
        if intersect_ids:
            # Choose the most common-like (stable) representation: smallest string.
            intersect_id = sorted(intersect_ids)[0]

        city = None
        if city_values:
            city = sorted(city_values)[0]

        # Optional validation: traffic-light lane_id should exist in referenced map.
        if is_traffic_light and lane_ids is not None and intersect_id:
            map_id = parse_intersect_to_map_id(intersect_id)
            lane_set = lane_ids_by_map.get(map_id) if map_id is not None else None
            if lane_set is not None:
                for lid in lane_ids:
                    if lid == "":
                        continue
                    lane_id_checked_total += 1
                    if lid not in lane_set:
                        lane_id_missing_total += 1
                        lane_id_map_miss_by_map[str(map_id)] += 1

        per_scene[scene_id] = CsvFileStats(
            file=p.name,
            scene_id=scene_id,
            rows=rows,
            min_ts=min_ts,
            max_ts=max_ts,
            unique_ts=unique_ts,
            duration_s=duration_s,
            unique_agents=unique_agents,
            intersect_id=intersect_id,
            intersect_label=intersection_label(intersect_id),
            intersect_id_variants=len(intersect_ids),
            city=city,
        )

        if progress_every and idx % progress_every == 0:
            print(f"  - {name}: {idx}/{len(files)} files", flush=True)

    # Package aggregates for output
    cat_values_out: Dict[str, List[str]] = {}
    for c, s in cat_sets.items():
        cat_values_out[c] = sorted(s)

    rows_per_file_summary = summarize_distribution([float(x) for x in rows_per_file])
    unique_ts_summary = summarize_distribution([float(x) for x in unique_ts_per_file])
    duration_s_summary = summarize_distribution([float(x) for x in duration_s_per_file])
    unique_agents_summary = (
        summarize_distribution([float(x) for x in unique_agents_per_file]) if unique_agents_per_file else None
    )

    # Add validation notes for traffic light lane ids into delta_t_counts namespace (keeps schema simple)
    delta_t_out = dict(delta_t_counts)
    if is_traffic_light:
        delta_t_out["_lane_id_checked"] = lane_id_checked_total
        delta_t_out["_lane_id_missing"] = lane_id_missing_total
        if lane_id_map_miss_by_map:
            # Encode as json-ish string keys to keep type stable.
            for k, v in lane_id_map_miss_by_map.items():
                delta_t_out[f"_lane_id_missing_map_{k}"] = v

    table_profile = CsvTableProfile(
        name=name,
        rel_dir=rel_dir,
        file_count=len(files),
        total_rows=total_rows,
        columns_union=sorted(columns_union),
        columns_variants=dict(columns_variants),
        numeric=numeric_aggs,
        categorical_values=cat_values_out,
        delta_t_counts=delta_t_out,
        rows_per_file=rows_per_file_summary,
        unique_ts_per_file=unique_ts_summary,
        duration_s_per_file=duration_s_summary,
        unique_agents_per_file=unique_agents_summary,
        files=list(per_scene.values()),
    )

    return table_profile, per_scene


def build_alignment_report(
    family: str,
    tables: List[CsvTableProfile],
    per_scene_by_table: Dict[str, Dict[str, CsvFileStats]],
) -> Dict[str, Any]:
    """
    Cross-table checks:
    - file set overlap
    - intersect_id consistency across modalities
    - timestamp window consistency across modalities
    """
    def split_from_name(name: str) -> str:
        parts = name.replace("\\\\", "/").split("/")
        for p in parts:
            if p in ("train", "val", "test"):
                return p
        return "unknown"

    def alignment_for(table_names: List[str]) -> Dict[str, Any]:
        scene_sets: Dict[str, set] = {name: set(per_scene_by_table[name].keys()) for name in table_names}
        if not scene_sets:
            return {}

        all_scenes = set.union(*scene_sets.values())
        common_scenes = set.intersection(*scene_sets.values())

        missing_by_table: Dict[str, int] = {}
        empty_files_by_table: Dict[str, int] = {}
        multi_intersect_by_table: Dict[str, int] = {}
        for name, s in scene_sets.items():
            missing_by_table[name] = len(all_scenes - s)
            empty_files_by_table[name] = sum(1 for st in per_scene_by_table[name].values() if st.rows == 0)
            multi_intersect_by_table[name] = sum(
                1 for st in per_scene_by_table[name].values() if (st.intersect_id_variants or 0) > 1
            )

        # Pairwise scene overlap (counts only)
        pairwise: Dict[str, int] = {}
        for i in range(len(table_names)):
            for j in range(i + 1, len(table_names)):
                a, b = table_names[i], table_names[j]
                pairwise[f"{a} ∩ {b}"] = len(scene_sets[a] & scene_sets[b])

        # For scenes present in all tables, check intersect_id and time windows
        intersect_mismatch = 0
        time_min_mismatch = 0
        time_max_mismatch = 0
        samples: List[Dict[str, Any]] = []
        samples_limit = 20

        for scene_id in sorted(common_scenes):
            stats = [per_scene_by_table[name][scene_id] for name in table_names]
            intersect_ids = {s.intersect_id for s in stats if s.intersect_id}
            if len(intersect_ids) > 1:
                intersect_mismatch += 1
                if len(samples) < samples_limit:
                    samples.append(
                        {
                            "scene_id": scene_id,
                            "issue": "intersect_id_mismatch",
                            "by_table": {name: per_scene_by_table[name][scene_id].intersect_id for name in table_names},
                        }
                    )

            mins = [s.min_ts for s in stats if s.min_ts is not None]
            maxs = [s.max_ts for s in stats if s.max_ts is not None]
            if mins and (max(mins) - min(mins) > 1e-3):
                time_min_mismatch += 1
                if len(samples) < samples_limit:
                    samples.append(
                        {
                            "scene_id": scene_id,
                            "issue": "min_ts_mismatch",
                            "by_table": {name: per_scene_by_table[name][scene_id].min_ts for name in table_names},
                        }
                    )
            if maxs and (max(maxs) - min(maxs) > 1e-3):
                time_max_mismatch += 1
                if len(samples) < samples_limit:
                    samples.append(
                        {
                            "scene_id": scene_id,
                            "issue": "max_ts_mismatch",
                            "by_table": {name: per_scene_by_table[name][scene_id].max_ts for name in table_names},
                        }
                    )

        return {
            "table_count": len(table_names),
            "scene_union_count": len(all_scenes),
            "scene_intersection_count": len(common_scenes),
            "missing_scenes_by_table": missing_by_table,
            "empty_files_by_table": empty_files_by_table,
            "multi_intersect_id_files_by_table": multi_intersect_by_table,
            "pairwise_scene_overlap": pairwise,
            "intersect_id_mismatch_count": intersect_mismatch,
            "min_ts_mismatch_count": time_min_mismatch,
            "max_ts_mismatch_count": time_max_mismatch,
            "samples": samples,
        }

    out: Dict[str, Any] = {"family": family}
    table_names_all = [t.name for t in tables]

    # Overall (may mix splits, so intersection can be 0; kept for completeness)
    out["overall"] = alignment_for(table_names_all)

    by_split: Dict[str, List[str]] = defaultdict(list)
    for name in table_names_all:
        by_split[split_from_name(name)].append(name)

    out["by_split"] = {split: alignment_for(names) for split, names in sorted(by_split.items())}
    return out


def write_markdown_report(profile: DatasetProfile, out_path: Path) -> None:
    lines: List[str] = []
    lines.append("# Dataset Profile Report (Phase A)")
    lines.append("")
    lines.append(f"- Generated at: `{profile.generated_at}`")
    lines.append(f"- Dataset root: `{profile.dataset_root}`")
    lines.append(f"- Scan level: `{profile.scan_level}`")
    lines.append(f"- Total size (bytes): `{profile.total_size_bytes}` ({human_bytes(profile.total_size_bytes)})")
    lines.append("")

    if profile.notes:
        lines.append("## Notes")
        lines.append("")
        for n in profile.notes:
            lines.append(f"- {n}")
        lines.append("")

    lines.append("## CSV Tables")
    lines.append("")
    for t in profile.tables:
        lines.append(f"### `{t.name}`")
        lines.append("")
        lines.append(f"- Path: `{t.rel_dir}`")
        lines.append(f"- Files: `{t.file_count}`")
        lines.append(f"- Total rows: `{t.total_rows}`")
        lines.append("")

        # Schema
        lines.append("Columns (union):")
        lines.append("")
        lines.append("```text")
        for c in t.columns_union:
            lines.append(c)
        lines.append("```")
        lines.append("")

        # Basic distributions
        def fmt_dist(d: Dict[str, Any], unit: str = "") -> str:
            if d.get("count", 0) == 0:
                return "n=0"
            return (
                f"n={d['count']}, min={d['min']}{unit}, p50={d['p50']}{unit}, p95={d['p95']}{unit}, max={d['max']}{unit}"
            )

        lines.append(f"- Rows/file: {fmt_dist(t.rows_per_file)}")
        lines.append(f"- Unique timestamps/file: {fmt_dist(t.unique_ts_per_file)}")
        lines.append(f"- Duration/file (s): {fmt_dist(t.duration_s_per_file, 's')}")
        if t.unique_agents_per_file is not None:
            lines.append(f"- Unique agents/file: {fmt_dist(t.unique_agents_per_file)}")
        lines.append("")

        # Numeric ranges
        lines.append("Numeric ranges:")
        lines.append("")
        lines.append("| column | min | max | missing | parse_error |")
        lines.append("|---|---:|---:|---:|---:|")
        for col, agg in t.numeric.items():
            lines.append(
                f"| {col} | {'' if agg.min is None else agg.min:.6g} | {'' if agg.max is None else agg.max:.6g} | {agg.missing} | {agg.parse_error} |"
            )
        lines.append("")

        # Categorical values
        if t.categorical_values:
            lines.append("Categorical values (capped to 200 unique values per column):")
            lines.append("")
            for col, vals in t.categorical_values.items():
                if not vals:
                    continue
                lines.append(f"- `{col}`: {vals}")
            lines.append("")

        # Human-readable intersection names
        intersection_pairs = sorted(
            {
                (s.intersect_id, s.intersect_label)
                for s in t.files
                if s.intersect_id and s.intersect_label
            },
            key=lambda x: x[0],
        )
        if intersection_pairs:
            lines.append("Intersection naming:")
            lines.append("")
            for raw_id, label in intersection_pairs:
                lines.append(f"- `{label}` -> `{raw_id}`")
            lines.append("")

        # Timestamp delta distribution
        if t.delta_t_counts:
            # Only show numeric-like keys, keep internal validation keys separate.
            numeric_deltas = {k: v for k, v in t.delta_t_counts.items() if not k.startswith("_")}
            if numeric_deltas:
                top = sorted(numeric_deltas.items(), key=lambda kv: kv[1], reverse=True)[:10]
                lines.append("Top timestamp deltas (rounded to 0.001):")
                lines.append("")
                for d, c in top:
                    lines.append(f"- dt={d}s: {c}")
                lines.append("")
            if any(k.startswith("_lane_id_") for k in t.delta_t_counts.keys()):
                lines.append("Traffic-light lane_id validation:")
                lines.append("")
                checked = t.delta_t_counts.get("_lane_id_checked", 0)
                missing = t.delta_t_counts.get("_lane_id_missing", 0)
                lines.append(f"- lane_id checked: {checked}")
                lines.append(f"- lane_id missing in map: {missing}")
                lines.append("")

    # Maps
    lines.append("## Maps")
    lines.append("")
    lines.append(f"- Map files: `{len(profile.maps)}`")
    lines.append("")
    for m in profile.maps:
        lines.append(f"### `{m.file}`")
        lines.append("")
        lines.append(f"- map_id: `{m.map_id}`")
        if m.entity_counts:
            parts = ", ".join(f"{k}={v}" for k, v in m.entity_counts.items())
            lines.append(f"- entity counts: {parts}")
        if m.bbox_xy_sampled:
            b = m.bbox_xy_sampled
            lines.append(f"- bbox (sampled): x=[{b['min_x']:.2f}, {b['max_x']:.2f}], y=[{b['min_y']:.2f}, {b['max_y']:.2f}]")
        lines.append("")

    # Alignment summary
    lines.append("## Cross-Table Alignment")
    lines.append("")
    lines.append(f"- family: `{profile.alignment.get('family')}`")
    lines.append("")

    def render_alignment_block(title: str, a: Dict[str, Any]) -> None:
        if not a:
            lines.append(f"### {title}")
            lines.append("")
            lines.append("_No alignment data._")
            lines.append("")
            return

        lines.append(f"### {title}")
        lines.append("")
        for k in [
            "table_count",
            "scene_union_count",
            "scene_intersection_count",
            "intersect_id_mismatch_count",
            "min_ts_mismatch_count",
            "max_ts_mismatch_count",
        ]:
            if k in a:
                lines.append(f"- {k}: `{a[k]}`")

        if a.get("empty_files_by_table"):
            lines.append(f"- empty_files_by_table: `{a['empty_files_by_table']}`")
        if a.get("multi_intersect_id_files_by_table"):
            lines.append(f"- multi_intersect_id_files_by_table: `{a['multi_intersect_id_files_by_table']}`")
        if a.get("missing_scenes_by_table"):
            lines.append(f"- missing_scenes_by_table: `{a['missing_scenes_by_table']}`")
        lines.append("")

        if a.get("samples"):
            lines.append("Samples:")
            lines.append("")
            lines.append("```json")
            lines.append(json.dumps(a["samples"], indent=2))
            lines.append("```")
            lines.append("")

    render_alignment_block("Overall (all tables)", profile.alignment.get("overall", {}))
    by_split = profile.alignment.get("by_split", {})
    if isinstance(by_split, dict):
        for split, a in by_split.items():
            render_alignment_block(f"Split: {split}", a)

    out_path.write_text("\n".join(lines) + "\n")


def write_json(profile: DatasetProfile, out_path: Path) -> None:
    def default(o: Any) -> Any:
        if hasattr(o, "__dataclass_fields__"):
            d = asdict(o)
            # ColumnNumericAgg dataclasses inside CsvTableProfile numeric dict will be rendered as dicts.
            return d
        raise TypeError(f"not json serializable: {type(o)}")

    out_path.write_text(json.dumps(profile, default=default, indent=2) + "\n")


def write_scenes_csv(
    tables: List[CsvTableProfile],
    per_scene_by_table: Dict[str, Dict[str, CsvFileStats]],
    out_path: Path,
) -> None:
    # Build union of scenes across all tables; output one row per (scene, table)
    table_names = [t.name for t in tables]
    scene_union: set = set()
    for name in table_names:
        scene_union |= set(per_scene_by_table.get(name, {}).keys())

    rows: List[Dict[str, Any]] = []
    for scene_id in sorted(scene_union, key=lambda s: (len(s), s)):
        for table in table_names:
            s = per_scene_by_table.get(table, {}).get(scene_id)
            if s is None:
                continue
            rows.append(
                {
                    "table": table,
                    "scene_id": scene_id,
                    "file": s.file,
                    "rows": s.rows,
                    "min_ts": "" if s.min_ts is None else s.min_ts,
                    "max_ts": "" if s.max_ts is None else s.max_ts,
                    "unique_ts": s.unique_ts,
                    "duration_s": "" if s.duration_s is None else s.duration_s,
                    "unique_agents": "" if s.unique_agents is None else s.unique_agents,
                    "intersect_id": "" if s.intersect_id is None else s.intersect_id,
                    "intersect_label": "" if s.intersect_label is None else s.intersect_label,
                    "intersect_id_variants": s.intersect_id_variants,
                    "city": "" if s.city is None else s.city,
                }
            )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "table",
                "scene_id",
                "file",
                "rows",
                "min_ts",
                "max_ts",
                "unique_ts",
                "duration_s",
                "unique_agents",
                "intersect_id",
                "intersect_label",
                "intersect_id_variants",
                "city",
            ],
        )
        w.writeheader()
        w.writerows(rows)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Profile a dataset folder (Phase A).")
    ap.add_argument(
        "dataset_root",
        nargs="?",
        type=str,
        default=None,
        help=(
            "Path to dataset root (e.g., dataset/v2x-traj). "
            "If omitted, tries: dataset/v2x-traj, ../dataset/v2x-traj."
        ),
    )
    ap.add_argument("--out-dir", type=str, default="dataset/profiles", help="Output directory root")
    ap.add_argument("--scan-level", type=str, default="geometry", choices=SCAN_LEVELS)
    ap.add_argument("--progress-every", type=int, default=500)
    ap.add_argument("--map-bbox-sample-step", type=int, default=10, help="Parse every Nth point in lane centerlines")
    args = ap.parse_args(argv)

    if args.dataset_root is None:
        chosen = choose_default_dataset_root()
        if chosen is None:
            cands = ", ".join(DEFAULT_DATASET_CANDIDATES)
            print(
                f"Could not auto-detect dataset root. "
                f"Provide it explicitly (tried: {cands}).",
                file=sys.stderr,
            )
            return 2
        dataset_root = chosen
    else:
        dataset_root = Path(args.dataset_root)

    if not dataset_root.exists():
        print(f"Dataset root not found: {display_path(dataset_root)}", file=sys.stderr)
        return 2

    family = detect_family(dataset_root)
    out_root = Path(args.out_dir)
    dataset_id = dataset_root.name
    out_dir = out_root / dataset_id
    out_dir.mkdir(parents=True, exist_ok=True)

    print(
        f"Profiling dataset: {display_path(dataset_root)} "
        f"(family={family}, scan={args.scan_level})",
        flush=True,
    )

    total_size = dataset_total_size(dataset_root)
    maps_dir = dataset_root / "maps"
    map_profiles, lane_ids_by_map = profile_maps(maps_dir, bbox_sample_step=args.map_bbox_sample_step)

    csv_dirs = []
    if family == "v2x-traj":
        # Prefer known ordering for readability.
        for view in ["ego-trajectories", "infrastructure-trajectories", "vehicle-trajectories"]:
            for split in ["train", "val"]:
                d = dataset_root / view / split / "data"
                if d.exists():
                    csv_dirs.append(d)
        for split in ["train", "val"]:
            d = dataset_root / "traffic-light" / split / "data"
            if d.exists():
                csv_dirs.append(d)
    else:
        csv_dirs = discover_csv_dirs(dataset_root)

    if not csv_dirs:
        print("No CSV directories found under dataset root.", file=sys.stderr)
        return 2

    tables: List[CsvTableProfile] = []
    per_scene_by_table: Dict[str, Dict[str, CsvFileStats]] = {}

    for d in csv_dirs:
        rel = str(d.relative_to(dataset_root))
        print(f"- Table: {rel}", flush=True)
        t, per_scene = profile_csv_table(
            dataset_root=dataset_root,
            table_dir=d,
            scan_level=args.scan_level,
            lane_ids_by_map=lane_ids_by_map,
            progress_every=args.progress_every,
        )
        tables.append(t)
        per_scene_by_table[t.name] = per_scene

    alignment = build_alignment_report(family=family, tables=tables, per_scene_by_table=per_scene_by_table)

    notes = []
    if family == "v2x-traj":
        extra_map_files = dataset_root / "map_files"
        if extra_map_files.exists():
            notes.append(f"Found extra map_files directory: {display_path(extra_map_files, dataset_root.parent)}")
            for p in sorted(extra_map_files.iterdir()):
                notes.append(f"  - {p.name} ({human_bytes(p.stat().st_size)})")

    profile = DatasetProfile(
        dataset_root=display_path(dataset_root),
        generated_at=now_iso(),
        scan_level=args.scan_level,
        total_size_bytes=total_size,
        tables=tables,
        maps=map_profiles,
        alignment=alignment,
        notes=notes,
    )

    # Outputs
    json_path = out_dir / "profile.json"
    scenes_csv_path = out_dir / "scenes.csv"
    md_path = out_dir / "PROFILE_REPORT.md"
    md_root_path = Path("dataset/PROFILE_REPORT.md")

    write_json(profile, json_path)
    write_scenes_csv(tables, per_scene_by_table, scenes_csv_path)
    write_markdown_report(profile, md_path)
    # Convenience: keep a stable path at dataset/PROFILE_REPORT.md for the most recent run.
    write_markdown_report(profile, md_root_path)

    print(f"Wrote: {display_path(json_path)}", flush=True)
    print(f"Wrote: {display_path(scenes_csv_path)}", flush=True)
    print(f"Wrote: {display_path(md_path)}", flush=True)
    print(f"Wrote: {display_path(md_root_path)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
