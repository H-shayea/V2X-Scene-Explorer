from __future__ import annotations

import csv
import io
import json
import os
from pathlib import Path
import re
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple
import uuid


PROFILE_SCHEMA_VERSION = 1
PROFILE_ADAPTER_VERSION = "1.0"


def _now_utc_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _norm_col(s: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(s or "").strip().lower())


def _safe_float(x: Any) -> Optional[float]:
    if x is None:
        return None
    try:
        v = float(str(x).strip())
    except Exception:
        return None
    if v != v:
        return None
    if v in (float("inf"), float("-inf")):
        return None
    return v


def _clamp(n: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, n))


def _detect_delimiter(sample: str) -> str:
    txt = str(sample or "")
    if not txt:
        return ","
    try:
        dialect = csv.Sniffer().sniff(txt, delimiters=",;\t")
        d = str(dialect.delimiter or ",")
        if d in (",", ";", "\t"):
            return d
    except Exception:
        pass
    c_comma = txt.count(",")
    c_semi = txt.count(";")
    c_tab = txt.count("\t")
    if c_tab > c_comma and c_tab > c_semi:
        return "\t"
    if c_semi > c_comma:
        return ";"
    return ","


def _read_text_with_fallback(path: Path, max_bytes: int = 256 * 1024) -> tuple[str, str]:
    raw = path.read_bytes()[:max_bytes]
    for enc in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return raw.decode(enc), enc
        except Exception:
            continue
    return raw.decode("utf-8", errors="replace"), "utf-8"


def _read_csv_header(path: Path) -> tuple[List[str], str, str]:
    if not path.exists() or not path.is_file():
        return [], ",", "utf-8"
    text, enc = _read_text_with_fallback(path)
    delim = _detect_delimiter(text)
    buf = io.StringIO(text)
    r = csv.reader(buf, delimiter=delim)
    try:
        header = next(r)
    except Exception:
        return [], delim, enc
    out = [str(x or "").strip() for x in header]
    return out, delim, enc


def _sample_csv_rows(path: Path, delimiter: str, encoding: str, max_rows: int = 200) -> tuple[List[Dict[str, str]], List[str]]:
    rows: List[Dict[str, str]] = []
    fieldnames: List[str] = []
    try:
        with path.open("r", newline="", encoding=encoding, errors="replace") as f:
            r = csv.DictReader(f, delimiter=delimiter)
            fieldnames = [str(x or "").strip() for x in (r.fieldnames or [])]
            for row in r:
                rows.append({str(k or "").strip(): str(v or "").strip() for k, v in (row or {}).items()})
                if len(rows) >= max_rows:
                    break
    except Exception:
        return [], fieldnames
    return rows, fieldnames


def _alias_set(canonical: str, aliases: Iterable[str]) -> set[str]:
    out = {_norm_col(canonical)}
    for a in aliases:
        out.add(_norm_col(a))
    return out


_CPM_ALIASES: Dict[str, set[str]] = {
    "generationTime_ms": _alias_set(
        "generationTime_ms",
        ["generation_time_ms", "generationtime", "timestamp_ms", "gen_time_ms", "time_ms", "timeofmeasurement_ms"],
    ),
    "trackID": _alias_set("trackID", ["track_id", "trackid", "track", "trackId"]),
    "objectID": _alias_set("objectID", ["object_id", "track_id", "id"]),
    "xDistance_m": _alias_set("xDistance_m", ["x_distance_m", "x_distance", "xdist_m", "north_m"]),
    "yDistance_m": _alias_set("yDistance_m", ["y_distance_m", "y_distance", "ydist_m", "east_m"]),
    "xSpeed_mps": _alias_set("xSpeed_mps", ["x_speed_mps", "vx_mps", "speed_x_mps", "north_speed_mps"]),
    "ySpeed_mps": _alias_set("ySpeed_mps", ["y_speed_mps", "vy_mps", "speed_y_mps", "east_speed_mps"]),
    "yawAngle_deg": _alias_set("yawAngle_deg", ["yaw_angle_deg", "heading_deg", "yaw_deg"]),
    "classificationType": _alias_set("classificationType", ["classification_type", "class_id", "object_class"]),
    "objLength_m": _alias_set("objLength_m", ["obj_length_m", "length_m"]),
    "objWidth_m": _alias_set("objWidth_m", ["obj_width_m", "width_m"]),
    "objHeight_m": _alias_set("objHeight_m", ["obj_height_m", "height_m"]),
}


_V2X_SCENES_ALIASES: Dict[str, set[str]] = {
    "table": _alias_set("table", ["table_name", "source_table", "source"]),
    "scene_id": _alias_set("scene_id", ["sceneid", "scene", "segment_id"]),
    "file": _alias_set("file", ["filename", "file_name", "path"]),
    "intersect_id": _alias_set("intersect_id", ["intersection_id", "intersection", "junction_id"]),
    "city": _alias_set("city", ["location"]),
}


_V2X_TRAJ_ALIASES: Dict[str, set[str]] = {
    "timestamp": _alias_set("timestamp", ["ts", "time", "time_s", "unix_time"]),
    "x": _alias_set("x", ["pos_x", "center_x", "x_m"]),
    "y": _alias_set("y", ["pos_y", "center_y", "y_m"]),
}


_V2X_TL_ALIASES: Dict[str, set[str]] = {
    "timestamp": _alias_set("timestamp", ["ts", "time", "time_s", "unix_time"]),
    "lane_id": _alias_set("lane_id", ["laneid", "lane"]),
    "color_1": _alias_set("color_1", ["color1", "signal_1"]),
    "remain_1": _alias_set("remain_1", ["remain1", "remain_time_1", "time_left_1"]),
}


def _build_field_map(fieldnames: Iterable[str], aliases: Dict[str, set[str]], explicit: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    actual = [str(x or "").strip() for x in fieldnames]
    by_norm: Dict[str, str] = {}
    for c in actual:
        n = _norm_col(c)
        if n and n not in by_norm:
            by_norm[n] = c

    out: Dict[str, str] = {}
    # Always prefer canonical columns first when present.
    for canonical in aliases.keys():
        got = by_norm.get(_norm_col(canonical))
        if got:
            out[canonical] = got

    if explicit:
        for k, v in explicit.items():
            kk = str(k or "").strip()
            vv = str(v or "").strip()
            if not kk or not vv:
                continue
            if kk in out:
                continue
            if vv in actual:
                out[kk] = vv

    for canonical, alias_set_vals in aliases.items():
        if canonical in out:
            continue
        # Stable iteration order avoids non-deterministic picks from a set.
        for alias_norm in sorted(alias_set_vals):
            got = by_norm.get(alias_norm)
            if got:
                out[canonical] = got
                break
    return out


def _infer_common_root(paths: List[Path]) -> Optional[Path]:
    if not paths:
        return None
    try:
        parts = [p.resolve() for p in paths]
    except Exception:
        parts = [p for p in paths]
    if not parts:
        return None
    common = parts[0]
    for p in parts[1:]:
        while not str(p).startswith(str(common)) and common != common.parent:
            common = common.parent
    return common


def _issue(code: str, message: str, role: Optional[str] = None, path: Optional[str] = None) -> Dict[str, str]:
    out = {"code": str(code), "message": str(message)}
    if role:
        out["role"] = str(role)
    if path:
        out["path"] = str(path)
    return out


def _resolve_input_paths(raw_paths: Iterable[str], repo_root: Path) -> List[Path]:
    out: List[Path] = []
    for raw in raw_paths:
        s = str(raw or "").strip()
        if not s:
            continue
        p = Path(s).expanduser()
        if not p.is_absolute():
            p = (repo_root / p).resolve()
        else:
            p = p.resolve()
        if p not in out:
            out.append(p)
    return out


def _collect_csv_files(paths: Iterable[Path], max_files: int = 4000) -> List[Path]:
    out: List[Path] = []
    files = [p for p in paths if p.is_file() and p.suffix.lower() == ".csv"]
    dirs = [p for p in paths if p.is_dir()]

    # Always include explicitly provided files first.
    out.extend(files)

    for p in dirs:
        if len(out) >= max_files:
            break
        for f in sorted(p.rglob("*.csv")):
            out.append(f)
            if len(out) >= max_files:
                break
    # Stable and deduped.
    uniq = []
    seen = set()
    for p in out:
        k = str(p)
        if k in seen:
            continue
        seen.add(k)
        uniq.append(p)
    return uniq


def _collect_cpm_csv_files(paths: Iterable[Path], max_files: Optional[int] = None) -> List[Path]:
    """
    Collect CPM CSV candidates from expected dataset layout.

    Preferred layout inside a dataset directory:
      - lidar/**.csv
      - thermal_camera/**.csv

    If these folders are missing, we fall back to scanning the provided path(s).
    """
    out: List[Path] = []
    for p in paths:
        if max_files is not None and len(out) >= max_files:
            break
        if p.is_file() and p.suffix.lower() == ".csv":
            out.append(p)
            continue
        if not p.is_dir():
            continue

        preferred_roots: List[Path] = []
        lidar_root = p / "lidar"
        thermal_root = p / "thermal_camera"
        if lidar_root.exists() and lidar_root.is_dir():
            preferred_roots.append(lidar_root)
        if thermal_root.exists() and thermal_root.is_dir():
            preferred_roots.append(thermal_root)
        if not preferred_roots:
            preferred_roots = [p]

        for root in preferred_roots:
            for f in sorted(root.rglob("*.csv")):
                out.append(f)
                if max_files is not None and len(out) >= max_files:
                    break
            if max_files is not None and len(out) >= max_files:
                break

    uniq: List[Path] = []
    seen = set()
    for p in out:
        k = str(p)
        if k in seen:
            continue
        seen.add(k)
        uniq.append(p)
    return uniq


def _uniform_sample_paths(paths: List[Path], max_n: int) -> List[Path]:
    if max_n <= 0 or len(paths) <= max_n:
        return list(paths)
    # Uniformly sample across sorted paths so large datasets do not bias to
    # early filenames only.
    out: List[Path] = []
    step = float(len(paths) - 1) / float(max_n - 1)
    used = set()
    for i in range(max_n):
        idx = int(round(i * step))
        idx = max(0, min(len(paths) - 1, idx))
        if idx in used:
            continue
        used.add(idx)
        out.append(paths[idx])
    return out


def _score_cpm_csv(path: Path, explicit_col_map: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    header, delimiter, encoding = _read_csv_header(path)
    if not header:
        return {
            "path": str(path),
            "score": 0.0,
            "delimiter": delimiter,
            "encoding": encoding,
            "field_map": {},
            "sample_rows": 0,
            "reason": "empty_or_unreadable_header",
        }

    field_map = _build_field_map(header, _CPM_ALIASES, explicit=explicit_col_map)
    score = 0.0
    if "generationTime_ms" in field_map:
        score += 40
    if "xDistance_m" in field_map:
        score += 20
    if "yDistance_m" in field_map:
        score += 20
    if "objectID" in field_map:
        score += 5
    if "classificationType" in field_map:
        score += 5
    if "xSpeed_mps" in field_map and "ySpeed_mps" in field_map:
        score += 5
    if "yawAngle_deg" in field_map:
        score += 3
    if any(k in field_map for k in ("objLength_m", "objWidth_m", "objHeight_m")):
        score += 2

    rows, fieldnames = _sample_csv_rows(path, delimiter=delimiter, encoding=encoding, max_rows=200)
    if fieldnames and not field_map:
        field_map = _build_field_map(fieldnames, _CPM_ALIASES, explicit=explicit_col_map)

    ts_ok = 0
    xy_ok = 0
    total = 0
    for row in rows:
        total += 1
        ts_v = _safe_float(row.get(field_map.get("generationTime_ms", "__missing__"), None))
        x_v = _safe_float(row.get(field_map.get("xDistance_m", "__missing__"), None))
        y_v = _safe_float(row.get(field_map.get("yDistance_m", "__missing__"), None))
        if ts_v is not None:
            ts_ok += 1
        if x_v is not None and y_v is not None:
            xy_ok += 1

    parse_ratio = (ts_ok / total) if total > 0 else 0.0
    xy_ratio = (xy_ok / total) if total > 0 else 0.0
    if total > 0 and parse_ratio >= 0.90:
        score += 10
    if total > 0 and xy_ratio >= 0.80:
        score += 10
    if total > 0 and max(parse_ratio, xy_ratio) < 0.30:
        score -= 30

    score = float(_clamp(score, 0, 100))
    return {
        "path": str(path),
        "score": score,
        "delimiter": delimiter,
        "encoding": encoding,
        "field_map": field_map,
        "sample_rows": total,
        "ts_ratio": round(parse_ratio, 4),
        "xy_ratio": round(xy_ratio, 4),
    }


def _score_v2x_scenes_csv(path: Path) -> Dict[str, Any]:
    header, delimiter, encoding = _read_csv_header(path)
    if not header:
        return {"path": str(path), "score": 0.0, "field_map": {}, "rows": 0, "table_samples": []}
    field_map = _build_field_map(header, _V2X_SCENES_ALIASES)
    score = 0.0

    if all(k in field_map for k in ("table", "scene_id", "file")):
        score += 30
    if "intersect_id" in field_map:
        score += 10
    if "city" in field_map:
        score += 5

    rows, fieldnames = _sample_csv_rows(path, delimiter=delimiter, encoding=encoding, max_rows=300)
    if fieldnames and not field_map:
        field_map = _build_field_map(fieldnames, _V2X_SCENES_ALIASES)

    row_ok = 0
    table_vals: List[str] = []
    split_hits = 0
    modality_hits = 0
    for row in rows:
        table = str(row.get(field_map.get("table", "__missing__"), "") or "").strip()
        sid = str(row.get(field_map.get("scene_id", "__missing__"), "") or "").strip()
        if table and sid:
            row_ok += 1
        if table:
            table_vals.append(table)
            low = table.lower()
            if "/train/" in low or "/val/" in low:
                split_hits += 1
            if "ego-trajectories/" in low or "infrastructure-trajectories/" in low or "vehicle-trajectories/" in low:
                modality_hits += 1

    total = len(rows)
    ok_ratio = (row_ok / total) if total else 0.0
    if total > 0 and ok_ratio >= 0.90:
        score += 10
    elif total > 0 and ok_ratio < 0.50:
        score -= 25
    if split_hits > 0:
        score += 10
    if modality_hits > 0:
        score += 15
    if any("traffic-light/" in str(t).lower() for t in table_vals):
        score += 5

    return {
        "path": str(path),
        "score": float(_clamp(score, 0, 100)),
        "field_map": field_map,
        "rows": total,
        "delimiter": delimiter,
        "encoding": encoding,
        "table_samples": sorted({str(x) for x in table_vals})[:200],
    }


def _score_traj_dir(path: Path) -> float:
    if not path.exists() or not path.is_dir():
        return 0.0
    sample_csv: Optional[Path] = None
    for f in path.rglob("*.csv"):
        sample_csv = f
        break
    if sample_csv is None:
        return 0.0
    header, _, _ = _read_csv_header(sample_csv)
    fmap = _build_field_map(header, _V2X_TRAJ_ALIASES)
    if all(k in fmap for k in ("timestamp", "x", "y")):
        return 100.0
    if "timestamp" in fmap and ("x" in fmap or "y" in fmap):
        return 55.0
    return 20.0


def _score_tl_dir(path: Path) -> float:
    if not path.exists() or not path.is_dir():
        return 0.0
    sample_csv: Optional[Path] = None
    for f in path.rglob("*.csv"):
        sample_csv = f
        break
    if sample_csv is None:
        return 0.0
    header, _, _ = _read_csv_header(sample_csv)
    fmap = _build_field_map(header, _V2X_TL_ALIASES)
    if all(k in fmap for k in ("timestamp", "lane_id", "color_1", "remain_1")):
        return 100.0
    if "timestamp" in fmap and ("lane_id" in fmap or "color_1" in fmap):
        return 55.0
    return 20.0


def _infer_v2x_seq_bindings(roots: List[Path]) -> Dict[str, Any]:
    """
    Infer V2X-Seq role bindings from root candidates using directory layout and
    CSV schema checks. This supports local copies with swapped folder names.
    """
    best_root: Optional[Path] = None
    best_score = -1.0
    best_bindings: Dict[str, Path] = {}
    best_quality: Dict[str, float] = {}

    # Probe root + a few parents so users can pick either dataset root or subfolders.
    candidate_roots: List[Path] = []
    for p in roots:
        candidate_roots.extend(_parent_chain(p.resolve(), max_depth=4))

    seen = set()
    uniq_roots: List[Path] = []
    for r in candidate_roots:
        k = str(r)
        if k in seen:
            continue
        seen.add(k)
        uniq_roots.append(r)

    def _pick_best(cands: List[Path], scorer) -> Tuple[Optional[Path], float]:
        best_p: Optional[Path] = None
        best_s = -1.0
        for p in cands:
            if not p.exists() or not p.is_dir():
                continue
            s = float(scorer(p))
            if s > best_s:
                best_s = s
                best_p = p
        return best_p, max(0.0, best_s)

    for root in uniq_roots[:80]:
        si_traj = root / "single-infrastructure" / "trajectories"
        si_tl = root / "single-infrastructure" / "traffic-light"
        sv_traj = root / "single-vehicle" / "trajectories"
        coop_infra = root / "cooperative-vehicle-infrastructure" / "infrastructure-trajectories"
        coop_vehicle = root / "cooperative-vehicle-infrastructure" / "vehicle-trajectories"
        coop_traj = root / "cooperative-vehicle-infrastructure" / "cooperative-trajectories"
        coop_tl = root / "cooperative-vehicle-infrastructure" / "traffic-light"
        maps_dir = root / "maps"

        coop_cands = [coop_traj, coop_infra, coop_vehicle, coop_tl]
        infra_cands = [si_traj]
        vehicle_cands = [sv_traj]
        tl_cands = [si_tl, coop_tl]

        traj_coop, q_coop = _pick_best(coop_cands, _score_traj_dir)
        traj_infra, q_infra = _pick_best(infra_cands, _score_traj_dir)
        traj_vehicle, q_vehicle = _pick_best(vehicle_cands, _score_traj_dir)
        traffic_light, q_tl = _pick_best(tl_cands, _score_tl_dir)

        if q_coop < 50.0:
            traj_coop = None
        if q_infra < 50.0:
            traj_infra = None
        if q_vehicle < 50.0:
            traj_vehicle = None
        if q_tl < 50.0:
            traffic_light = None

        # Prefer distinct sources when possible.
        if traj_infra is not None and traj_vehicle is not None and traj_infra.resolve() == traj_vehicle.resolve():
            second_vehicle, second_q_vehicle = _pick_best(
                [p for p in vehicle_cands if p.exists() and p.is_dir() and p.resolve() != traj_infra.resolve()],
                _score_traj_dir,
            )
            if second_vehicle is not None and second_q_vehicle >= 50.0:
                traj_vehicle = second_vehicle
                q_vehicle = second_q_vehicle

        root_score = 0.0
        if traj_coop is not None:
            root_score += 36.0
            root_score += q_coop * 0.16
        if traj_infra is not None:
            root_score += 24.0
            root_score += q_infra * 0.10
        if traj_vehicle is not None:
            root_score += 24.0
            root_score += q_vehicle * 0.10
        if traffic_light is not None:
            root_score += 12.0
            root_score += q_tl * 0.08
        if maps_dir.exists() and maps_dir.is_dir():
            root_score += 10.0
        # Strongly down-rank roots that have no trajectory source.
        if traj_coop is None and traj_infra is None and traj_vehicle is None:
            root_score *= 0.25

        if root_score > best_score:
            best_score = root_score
            best_root = root
            best_bindings = {}
            best_quality = {}
            if traj_coop is not None:
                best_bindings["traj_cooperative"] = traj_coop.resolve()
                best_quality["traj_cooperative"] = float(q_coop)
            if traj_infra is not None:
                best_bindings["traj_infra"] = traj_infra.resolve()
                best_quality["traj_infra"] = float(q_infra)
            if traj_vehicle is not None:
                best_bindings["traj_vehicle"] = traj_vehicle.resolve()
                best_quality["traj_vehicle"] = float(q_vehicle)
            if traffic_light is not None:
                best_bindings["traffic_light"] = traffic_light.resolve()
                best_quality["traffic_light"] = float(q_tl)
            if maps_dir.exists() and maps_dir.is_dir():
                best_bindings["maps_dir"] = maps_dir.resolve()
                best_quality["maps_dir"] = 100.0

    return {
        "root": best_root.resolve() if best_root is not None else None,
        "bindings": best_bindings,
        "quality": best_quality,
        "score": float(_clamp(best_score if best_score >= 0 else 0.0, 0.0, 100.0)),
    }


def _parent_chain(p: Path, max_depth: int = 6) -> List[Path]:
    out = [p]
    cur = p
    for _ in range(max_depth):
        if cur.parent == cur:
            break
        cur = cur.parent
        out.append(cur)
    return out


def _score_ind_data_dir(data_dir: Path) -> Dict[str, Any]:
    if not data_dir.exists() or not data_dir.is_dir():
        return {
            "data_dir": str(data_dir),
            "score": 0.0,
            "recordings": 0,
            "header_ok_ratio": 0.0,
            "triplet_ratio": 0.0,
            "background_ratio": 0.0,
        }

    tracks = sorted([p for p in data_dir.glob("*_tracks.csv") if p.is_file()])
    if not tracks:
        return {
            "data_dir": str(data_dir),
            "score": 0.0,
            "recordings": 0,
            "header_ok_ratio": 0.0,
            "triplet_ratio": 0.0,
            "background_ratio": 0.0,
        }

    n_total = len(tracks)
    n_triplet = 0
    n_background = 0
    n_header_ok = 0
    sample = tracks[: min(8, n_total)]

    for t in tracks:
        prefix = t.name[: -len("_tracks.csv")]
        tm = data_dir / f"{prefix}_tracksMeta.csv"
        rm = data_dir / f"{prefix}_recordingMeta.csv"
        bg = data_dir / f"{prefix}_background.png"
        if tm.exists() and rm.exists():
            n_triplet += 1
        if bg.exists():
            n_background += 1

    required_tracks = {"trackid", "frame", "xcenter", "ycenter"}
    required_tracks_meta = {"trackid", "initialframe", "finalframe", "class"}
    required_recording_meta = {"recordingid", "locationid", "framerate"}

    for t in sample:
        prefix = t.name[: -len("_tracks.csv")]
        tm = data_dir / f"{prefix}_tracksMeta.csv"
        rm = data_dir / f"{prefix}_recordingMeta.csv"
        if not tm.exists() or not rm.exists():
            continue
        h_t, _, _ = _read_csv_header(t)
        h_tm, _, _ = _read_csv_header(tm)
        h_rm, _, _ = _read_csv_header(rm)
        set_t = {_norm_col(x) for x in h_t}
        set_tm = {_norm_col(x) for x in h_tm}
        set_rm = {_norm_col(x) for x in h_rm}
        if required_tracks.issubset(set_t) and required_tracks_meta.issubset(set_tm) and required_recording_meta.issubset(set_rm):
            n_header_ok += 1

    triplet_ratio = (float(n_triplet) / float(n_total)) if n_total > 0 else 0.0
    background_ratio = (float(n_background) / float(n_total)) if n_total > 0 else 0.0
    header_ok_ratio = (float(n_header_ok) / float(len(sample))) if sample else 0.0

    score = 0.0
    score += 45.0 * triplet_ratio
    score += 25.0 * header_ok_ratio
    score += 10.0 * background_ratio
    score += min(20.0, float(n_total) * 0.8)
    score = float(_clamp(score, 0.0, 100.0))

    return {
        "data_dir": str(data_dir),
        "score": score,
        "recordings": int(n_total),
        "header_ok_ratio": round(header_ok_ratio, 4),
        "triplet_ratio": round(triplet_ratio, 4),
        "background_ratio": round(background_ratio, 4),
    }


def _infer_ind_bindings(roots: List[Path]) -> Dict[str, Any]:
    best_root: Optional[Path] = None
    best_data: Optional[Path] = None
    best_maps: Optional[Path] = None
    best_score = -1.0
    best_details: Dict[str, Any] = {}

    candidates: List[Path] = []
    for p in roots:
        candidates.extend(_parent_chain(p.resolve(), max_depth=4))

    seen = set()
    uniq: List[Path] = []
    for c in candidates:
        k = str(c)
        if k in seen:
            continue
        seen.add(k)
        uniq.append(c)

    for root in uniq[:80]:
        data_dir = (root / "data").resolve() if (root / "data").exists() else root.resolve()
        scored = _score_ind_data_dir(data_dir)
        s = float(scored.get("score", 0.0))
        maps_dir = (root / "maps").resolve()
        if maps_dir.exists() and maps_dir.is_dir():
            s += 5.0
        s = float(_clamp(s, 0.0, 100.0))
        if s > best_score:
            best_score = s
            best_root = root.resolve()
            best_data = data_dir.resolve()
            best_maps = maps_dir.resolve() if maps_dir.exists() and maps_dir.is_dir() else None
            best_details = dict(scored)

    return {
        "root": best_root,
        "data_dir": best_data,
        "maps_dir": best_maps,
        "score": float(_clamp(best_score if best_score >= 0 else 0.0, 0.0, 100.0)),
        "details": best_details,
    }


def _detect_ind(paths: List[Path], profile_name: str) -> Dict[str, Any]:
    inferred = _infer_ind_bindings(paths)
    root = inferred.get("root")
    data_dir = inferred.get("data_dir")
    maps_dir = inferred.get("maps_dir")
    score = float(inferred.get("score") or 0.0)

    if not isinstance(root, Path) or not isinstance(data_dir, Path):
        return {
            "dataset_type": "ind",
            "score": 0.0,
            "second_best": 0.0,
            "decision_mode": "manual",
            "profile": None,
            "validation": {
                "status": "schema_mismatch",
                "errors": [_issue("E_SCHEMA_REQUIRED_COLUMNS", "Could not infer a valid inD root from selected path(s).")],
                "warnings": [],
                "last_checked": _now_utc_iso(),
            },
        }

    details = inferred.get("details") if isinstance(inferred.get("details"), dict) else {}
    n_recordings = int(details.get("recordings") or 0)
    if n_recordings <= 0:
        return {
            "dataset_type": "ind",
            "score": float(_clamp(score * 0.4, 0, 100)),
            "second_best": 0.0,
            "decision_mode": "manual",
            "profile": None,
            "validation": {
                "status": "schema_mismatch",
                "errors": [_issue("E_SCHEMA_REQUIRED_COLUMNS", "No inD recording triplets (*_tracks/_tracksMeta/_recordingMeta.csv) were found.")],
                "warnings": [],
                "last_checked": _now_utc_iso(),
            },
        }

    decision = "auto" if score >= 75 else ("confirm" if score >= 50 else "manual")
    bindings: Dict[str, Dict[str, Any]] = {
        "data_dir": {
            "kind": "dir",
            "required": True,
            "path": str(data_dir),
            "detected_score": score,
        }
    }
    if isinstance(maps_dir, Path):
        bindings["maps_dir"] = {"kind": "dir", "required": False, "path": str(maps_dir), "detected_score": 100.0}

    profile = {
        "schema_version": PROFILE_SCHEMA_VERSION,
        "name": profile_name or "inD Local",
        "dataset_type": "ind",
        "adapter_version": PROFILE_ADAPTER_VERSION,
        "roots": [str(root)],
        "bindings": bindings,
        "scene_strategy": {"mode": "recording_window", "window_s": 60},
        "detector": {
            "score": score,
            "second_best": 0.0,
            "decision_mode": decision,
            "checked_at": _now_utc_iso(),
        },
    }
    return {
        "dataset_type": "ind",
        "score": score,
        "second_best": 0.0,
        "decision_mode": decision,
        "profile": profile,
    }


def _looks_like_sind_scenario_dir(path: Path) -> bool:
    if not path.exists() or not path.is_dir():
        return False
    veh = path / "Veh_smoothed_tracks.csv"
    ped = path / "Ped_smoothed_tracks.csv"
    return veh.exists() or ped.exists()


def _score_sind_root(root: Path) -> Dict[str, Any]:
    if not root.exists() or not root.is_dir():
        return {
            "root": str(root),
            "score": 0.0,
            "city_count": 0,
            "scenario_count": 0,
            "veh_ratio": 0.0,
            "ped_ratio": 0.0,
            "tl_ratio": 0.0,
            "map_city_ratio": 0.0,
            "background_city_ratio": 0.0,
            "maps_dir": None,
        }

    # Support selecting either:
    # 1) full SinD root (cities as first-level dirs), or
    # 2) a single city directory (scenarios as first-level dirs).
    first_level = [p for p in sorted(root.iterdir()) if p.is_dir() and not p.name.startswith(".")]
    direct_scenarios = [p for p in first_level if _looks_like_sind_scenario_dir(p)]
    if direct_scenarios:
        city_dirs = [root]
    else:
        city_dirs = []
        for c in first_level:
            scen = [p for p in sorted(c.iterdir()) if p.is_dir() and not p.name.startswith(".") and _looks_like_sind_scenario_dir(p)]
            if scen:
                city_dirs.append(c)

    if not city_dirs:
        return {
            "root": str(root),
            "score": 0.0,
            "city_count": 0,
            "scenario_count": 0,
            "veh_ratio": 0.0,
            "ped_ratio": 0.0,
            "tl_ratio": 0.0,
            "map_city_ratio": 0.0,
            "background_city_ratio": 0.0,
            "maps_dir": None,
        }

    scenario_count = 0
    n_veh = 0
    n_ped = 0
    n_tl = 0
    city_with_map = 0
    city_with_bg = 0
    map_roots: List[Path] = []

    for city_dir in city_dirs:
        scenario_dirs = [p for p in sorted(city_dir.iterdir()) if p.is_dir() and not p.name.startswith(".") and _looks_like_sind_scenario_dir(p)]
        if city_dir == root and direct_scenarios:
            scenario_dirs = direct_scenarios
        if not scenario_dirs:
            continue
        scenario_count += len(scenario_dirs)

        has_city_map = any(p.is_file() for p in city_dir.glob("*.osm"))
        has_city_bg = any(p.is_file() for p in city_dir.glob("*.png"))
        if has_city_map:
            city_with_map += 1
            map_roots.append(city_dir)
        if has_city_bg:
            city_with_bg += 1

        for scen in scenario_dirs:
            if (scen / "Veh_smoothed_tracks.csv").exists():
                n_veh += 1
            if (scen / "Ped_smoothed_tracks.csv").exists():
                n_ped += 1
            tl_files = [p for p in scen.glob("*.csv") if p.is_file() and ("traffic" in p.name.lower()) and ("meta" not in p.name.lower()) and (not p.name.startswith(".~lock"))]
            if tl_files:
                n_tl += 1

    if scenario_count <= 0:
        return {
            "root": str(root),
            "score": 0.0,
            "city_count": int(len(city_dirs)),
            "scenario_count": 0,
            "veh_ratio": 0.0,
            "ped_ratio": 0.0,
            "tl_ratio": 0.0,
            "map_city_ratio": 0.0,
            "background_city_ratio": 0.0,
            "maps_dir": None,
        }

    veh_ratio = float(n_veh) / float(scenario_count)
    ped_ratio = float(n_ped) / float(scenario_count)
    tl_ratio = float(n_tl) / float(scenario_count)
    map_city_ratio = float(city_with_map) / float(max(1, len(city_dirs)))
    bg_city_ratio = float(city_with_bg) / float(max(1, len(city_dirs)))

    score = 0.0
    score += 35.0 * min(1.0, float(scenario_count) / 16.0)
    score += 25.0 * veh_ratio
    score += 18.0 * ped_ratio
    score += 8.0 * tl_ratio
    score += 9.0 * map_city_ratio
    score += 5.0 * bg_city_ratio
    score = float(_clamp(score, 0.0, 100.0))

    maps_dir: Optional[str] = None
    if map_roots:
        # If full-root layout is selected, maps live inside city dirs.
        # Keep maps_dir as root for adapter-side discovery.
        maps_dir = str(root.resolve())

    return {
        "root": str(root.resolve()),
        "score": score,
        "city_count": int(len(city_dirs)),
        "scenario_count": int(scenario_count),
        "veh_ratio": round(veh_ratio, 4),
        "ped_ratio": round(ped_ratio, 4),
        "tl_ratio": round(tl_ratio, 4),
        "map_city_ratio": round(map_city_ratio, 4),
        "background_city_ratio": round(bg_city_ratio, 4),
        "maps_dir": maps_dir,
    }


def _infer_sind_bindings(roots: List[Path]) -> Dict[str, Any]:
    best_root: Optional[Path] = None
    best_score = -1.0
    best_details: Dict[str, Any] = {}

    candidates: List[Path] = []
    for p in roots:
        candidates.extend(_parent_chain(p.resolve(), max_depth=4))

    seen = set()
    uniq: List[Path] = []
    for c in candidates:
        k = str(c)
        if k in seen:
            continue
        seen.add(k)
        uniq.append(c)

    for root in uniq[:80]:
        scored = _score_sind_root(root)
        s = float(scored.get("score", 0.0))
        if s > best_score:
            best_score = s
            best_root = root.resolve()
            best_details = dict(scored)

    maps_dir = best_details.get("maps_dir")
    maps_path = Path(str(maps_dir)).resolve() if maps_dir else None
    return {
        "root": best_root,
        "data_dir": best_root,
        "maps_dir": maps_path,
        "score": float(_clamp(best_score if best_score >= 0 else 0.0, 0.0, 100.0)),
        "details": best_details,
    }


def _detect_sind(paths: List[Path], profile_name: str) -> Dict[str, Any]:
    inferred = _infer_sind_bindings(paths)
    root = inferred.get("root")
    data_dir = inferred.get("data_dir")
    maps_dir = inferred.get("maps_dir")
    score = float(inferred.get("score") or 0.0)
    details = inferred.get("details") if isinstance(inferred.get("details"), dict) else {}
    scenario_count = int(details.get("scenario_count") or 0)

    if not isinstance(root, Path) or not isinstance(data_dir, Path) or scenario_count <= 0:
        return {
            "dataset_type": "sind",
            "score": float(_clamp(score * 0.4, 0, 100)),
            "second_best": 0.0,
            "decision_mode": "manual",
            "profile": None,
            "validation": {
                "status": "schema_mismatch",
                "errors": [_issue("E_SCHEMA_REQUIRED_COLUMNS", "Could not infer a valid SinD root with scenario folders.")],
                "warnings": [],
                "last_checked": _now_utc_iso(),
            },
        }

    decision = "auto" if score >= 75 else ("confirm" if score >= 50 else "manual")
    bindings: Dict[str, Dict[str, Any]] = {
        "data_dir": {
            "kind": "dir",
            "required": True,
            "path": str(data_dir),
            "detected_score": score,
        }
    }
    if isinstance(maps_dir, Path):
        bindings["maps_dir"] = {
            "kind": "dir",
            "required": False,
            "path": str(maps_dir),
            "detected_score": float(details.get("map_city_ratio") or 0.0) * 100.0,
        }

    profile = {
        "schema_version": PROFILE_SCHEMA_VERSION,
        "name": profile_name or "SinD Local",
        "dataset_type": "sind",
        "adapter_version": PROFILE_ADAPTER_VERSION,
        "roots": [str(root)],
        "bindings": bindings,
        "scene_strategy": {"mode": "scenario_scene"},
        "detector": {
            "score": score,
            "second_best": 0.0,
            "decision_mode": decision,
            "checked_at": _now_utc_iso(),
        },
    }
    return {
        "dataset_type": "sind",
        "score": score,
        "second_best": 0.0,
        "decision_mode": decision,
        "profile": profile,
    }


def _detect_v2x(paths: List[Path], profile_name: str) -> Dict[str, Any]:
    # Prefer scoring likely index files (by name/path), but allow a fallback mode
    # where we detect V2X from directory layout only (no scenes CSV provided).
    csv_files = _collect_csv_files(paths, max_files=1200)
    scored = []
    for f in csv_files:
        low = str(f.as_posix()).lower()
        if ("scene" not in low) and ("index" not in low):
            continue
        s = _score_v2x_scenes_csv(f)
        if s["score"] > 0:
            scored.append(s)
    # Fallback: still try a small sample if no name-based candidates matched.
    if not scored:
        for f in csv_files[:120]:
            s = _score_v2x_scenes_csv(f)
            if s["score"] > 0:
                scored.append(s)

    scored.sort(key=lambda x: float(x.get("score", 0.0)), reverse=True)
    best = scored[0] if scored else None
    scenes_path = Path(str(best["path"])) if best else None
    table_samples = [str(x) for x in (best.get("table_samples") or [])] if best else []

    role_prefix: Dict[str, str] = {}
    for t in table_samples:
        low = t.lower()
        prefix = t
        for x in ("/train/", "/val/", "/test/"):
            i = low.find(x)
            if i > 0:
                prefix = t[:i]
                break
        pp = prefix.strip("/").strip()
        if not pp:
            continue
        if "ego" in low and "traj" in low:
            role_prefix["traj_ego"] = pp
        elif "infrastructure" in low and "traj" in low:
            role_prefix["traj_infra"] = pp
        elif "vehicle" in low and "traj" in low:
            role_prefix["traj_vehicle"] = pp
        elif "traffic-light" in low or "traffic_light" in low:
            role_prefix["traffic_light"] = pp

    candidate_roots: List[Path] = []
    for p in paths:
        if p.exists():
            candidate_roots.extend(_parent_chain(p.resolve()))
    if scenes_path is not None:
        candidate_roots.extend(_parent_chain(scenes_path.parent))
    # Dedup while preserving order.
    seen = set()
    dedup_roots = []
    for r in candidate_roots:
        k = str(r)
        if k in seen:
            continue
        seen.add(k)
        dedup_roots.append(r)

    def root_score(root: Path) -> tuple[float, Dict[str, Path]]:
        found: Dict[str, Path] = {}
        score = 0.0
        defaults = {
            "traj_ego": "ego-trajectories",
            "traj_infra": "infrastructure-trajectories",
            "traj_vehicle": "vehicle-trajectories",
            "traffic_light": "traffic-light",
        }
        for role, default_name in defaults.items():
            pref = role_prefix.get(role, default_name)
            p = (root / pref).resolve()
            if p.exists() and p.is_dir():
                found[role] = p
                score += 18.0 if role != "traffic_light" else 8.0
                score += _score_traj_dir(p) * (0.05 if role != "traffic_light" else 0.02)
        maps_dir = (root / "maps").resolve()
        if maps_dir.exists() and maps_dir.is_dir():
            found["maps_dir"] = maps_dir
            score += 8.0
        return score, found

    best_root = None
    best_found: Dict[str, Path] = {}
    best_root_score = -1.0
    for r in dedup_roots[:100]:
        s, found = root_score(r)
        if s > best_root_score:
            best_root_score = s
            best_root = r
            best_found = found
    if best_root is None:
        return {
            "dataset_type": "v2x_traj",
            "score": 0.0,
            "second_best": 0.0,
            "decision_mode": "manual",
            "profile": None,
            "validation": {
                "status": "schema_mismatch",
                "errors": [_issue("E_SCHEMA_REQUIRED_COLUMNS", "Could not infer a valid V2X root from selected path(s).")],
                "warnings": [],
                "last_checked": _now_utc_iso(),
            },
        }

    if best is not None:
        total_score = float(_clamp(0.55 * float(best["score"]) + 0.45 * max(0.0, best_root_score), 0, 100))
    else:
        # Directory-layout-only confidence.
        total_score = float(_clamp(max(0.0, best_root_score), 0, 100))
    decision = "auto" if total_score >= 75 else ("confirm" if total_score >= 50 else "manual")

    required_roles = ("traj_ego", "traj_infra", "traj_vehicle")
    missing_required = [r for r in required_roles if r not in best_found]
    if missing_required:
        miss = ", ".join(missing_required)
        return {
            "dataset_type": "v2x_traj",
            "score": float(_clamp(total_score * 0.5, 0, 100)),
            "second_best": 0.0,
            "decision_mode": "manual",
            "profile": None,
            "validation": {
                "status": "broken_path",
                "errors": [_issue("E_ROLE_REQUIRED_MISSING", f"Missing required V2X directories: {miss}.")],
                "warnings": [],
                "last_checked": _now_utc_iso(),
            },
        }

    bindings: Dict[str, Dict[str, Any]] = {}
    if scenes_path is not None and float(best.get("score", 0.0)) >= 40.0:
        bindings["scenes_index"] = {
            "kind": "file",
            "required": False,
            "path": str(scenes_path.resolve()),
            "detected_score": float(best["score"]),
        }
    for role in ("traj_ego", "traj_infra", "traj_vehicle", "traffic_light", "maps_dir"):
        p = best_found.get(role)
        if p:
            bindings[role] = {
                "kind": "dir",
                "required": role in ("traj_ego", "traj_infra", "traj_vehicle"),
                "path": str(p),
                "detected_score": float(_score_traj_dir(p)) if role != "maps_dir" else 100.0,
            }

    profile = {
        "schema_version": PROFILE_SCHEMA_VERSION,
        "name": profile_name or "V2X-Traj Local",
        "dataset_type": "v2x_traj",
        "adapter_version": PROFILE_ADAPTER_VERSION,
        "roots": [str(best_root.resolve())],
        "bindings": bindings,
        "scene_strategy": {"mode": "intersection_scene"},
        "detector": {
            "score": total_score,
            "second_best": 0.0,
            "decision_mode": decision,
            "checked_at": _now_utc_iso(),
        },
    }
    return {
        "dataset_type": "v2x_traj",
        "score": total_score,
        "second_best": 0.0,
        "decision_mode": decision,
        "profile": profile,
    }


def _detect_v2x_seq(paths: List[Path], profile_name: str) -> Dict[str, Any]:
    inferred = _infer_v2x_seq_bindings(paths)
    root = inferred.get("root")
    root_bindings = inferred.get("bindings") if isinstance(inferred.get("bindings"), dict) else {}
    quality = inferred.get("quality") if isinstance(inferred.get("quality"), dict) else {}
    score = float(inferred.get("score") or 0.0)

    if not isinstance(root, Path):
        return {
            "dataset_type": "v2x_seq",
            "score": 0.0,
            "second_best": 0.0,
            "decision_mode": "manual",
            "profile": None,
            "validation": {
                "status": "schema_mismatch",
                "errors": [_issue("E_SCHEMA_REQUIRED_COLUMNS", "Could not infer a valid V2X-Seq root from selected path(s).")],
                "warnings": [],
                "last_checked": _now_utc_iso(),
            },
        }

    has_traj = ("traj_cooperative" in root_bindings) or ("traj_infra" in root_bindings) or ("traj_vehicle" in root_bindings)
    if not has_traj:
        return {
            "dataset_type": "v2x_seq",
            "score": float(_clamp(score * 0.4, 0, 100)),
            "second_best": 0.0,
            "decision_mode": "manual",
            "profile": None,
            "validation": {
                "status": "schema_mismatch",
                "errors": [_issue("E_SCHEMA_REQUIRED_COLUMNS", "No trajectory directories were detected for V2X-Seq.")],
                "warnings": [],
                "last_checked": _now_utc_iso(),
            },
        }

    decision = "auto" if score >= 75 else ("confirm" if score >= 50 else "manual")
    bindings: Dict[str, Dict[str, Any]] = {}
    for role in ("traj_cooperative", "traj_infra", "traj_vehicle", "traffic_light", "maps_dir"):
        p = root_bindings.get(role)
        if not isinstance(p, Path):
            continue
        bindings[role] = {
            "kind": "dir",
            "required": False,
            "path": str(p),
            "detected_score": float(quality.get(role, 0.0)),
        }

    profile = {
        "schema_version": PROFILE_SCHEMA_VERSION,
        "name": profile_name or "V2X-Seq Local",
        "dataset_type": "v2x_seq",
        "adapter_version": PROFILE_ADAPTER_VERSION,
        "roots": [str(root)],
        "bindings": bindings,
        "scene_strategy": {"mode": "sequence_scene"},
        "detector": {
            "score": score,
            "second_best": 0.0,
            "decision_mode": decision,
            "checked_at": _now_utc_iso(),
        },
    }
    return {
        "dataset_type": "v2x_seq",
        "score": score,
        "second_best": 0.0,
        "decision_mode": decision,
        "profile": profile,
    }


def _detect_cpm(paths: List[Path], profile_name: str) -> Dict[str, Any]:
    csv_files = _collect_cpm_csv_files(paths, max_files=None)
    score_inputs = _uniform_sample_paths(csv_files, max_n=3000)
    scores = [_score_cpm_csv(p) for p in score_inputs]
    scores.sort(key=lambda x: float(x.get("score", 0.0)), reverse=True)
    top = float(scores[0]["score"]) if scores else 0.0
    second = float(scores[1]["score"]) if len(scores) > 1 else 0.0
    decision = "auto" if top >= 75 and (top - second) >= 12 else ("confirm" if top >= 50 else "manual")

    selected = [s for s in scores if float(s.get("score", 0.0)) >= 50.0]
    selected_paths = [Path(str(s["path"])).resolve() for s in selected] if selected else list(csv_files)
    common_root = _infer_common_root(selected_paths) or _infer_common_root(paths) or Path.cwd()

    best = selected[0] if selected else (scores[0] if scores else None)
    col_map = dict((best or {}).get("field_map") or {})
    delim = str((best or {}).get("delimiter") or ",")
    enc = str((best or {}).get("encoding") or "utf-8")

    proto_path = None
    for root in paths:
        if root.is_file() and root.suffix.lower() == ".proto":
            proto_path = root.resolve()
            break
        if root.is_dir():
            cands = sorted(root.rglob("*.proto"))
            if cands:
                proto_path = cands[0].resolve()
                break

    bindings: Dict[str, Dict[str, Any]] = {}
    if csv_files:
        bindings["cpm_logs"] = {
            "kind": "file_list",
            "required": True,
            "paths": [str(p.resolve()) for p in csv_files],
            "detected_score": top,
            "delimiter": delim,
            "encoding": enc,
            "column_map": col_map,
        }
    if proto_path:
        bindings["proto_schema"] = {
            "kind": "file",
            "required": False,
            "path": str(proto_path),
        }

    profile = {
        "schema_version": PROFILE_SCHEMA_VERSION,
        "name": profile_name or "Consider.it Local",
        "dataset_type": "consider_it_cpm",
        "adapter_version": PROFILE_ADAPTER_VERSION,
        "roots": [str(common_root.resolve())],
        "bindings": bindings,
        "scene_strategy": {"mode": "time_window", "window_s": 300, "gap_s": 120},
        "detector": {
            "score": top,
            "second_best": second,
            "decision_mode": decision,
            "checked_at": _now_utc_iso(),
        },
    }
    return {
        "dataset_type": "consider_it_cpm",
        "score": top,
        "second_best": second,
        "decision_mode": decision,
        "profile": profile,
    }


def _normalize_dataset_type(raw: Any) -> str:
    s = str(raw or "").strip().lower()
    if s in ("v2x-traj", "v2x_traj", "v2xtraj"):
        return "v2x_traj"
    if s in ("v2x-seq", "v2x_seq", "v2xseq"):
        return "v2x_seq"
    if s in ("consider-it-cpm", "consider_it_cpm", "cpm", "cpm-objects", "considerit"):
        return "consider_it_cpm"
    if s in ("ind", "in-d", "ind_dataset"):
        return "ind"
    if s in ("sind", "sin-d", "sin_d", "sind_dataset"):
        return "sind"
    return ""


def detect_profile(repo_root: Path, payload: Dict[str, Any]) -> Dict[str, Any]:
    raw_paths = payload.get("paths") if isinstance(payload.get("paths"), list) else []
    paths = _resolve_input_paths([str(x) for x in raw_paths], repo_root=repo_root)
    if not paths:
        return {
            "ok": False,
            "error": "No paths provided.",
            "validation": {
                "status": "broken_path",
                "errors": [_issue("E_ROLE_REQUIRED_MISSING", "Provide at least one folder or file path.")],
                "warnings": [],
                "last_checked": _now_utc_iso(),
            },
        }

    type_hint = _normalize_dataset_type(payload.get("dataset_type"))
    profile_name = str(payload.get("name") or "").strip()

    if type_hint == "v2x_traj":
        picked = _detect_v2x(paths, profile_name)
    elif type_hint == "v2x_seq":
        picked = _detect_v2x_seq(paths, profile_name)
    elif type_hint == "consider_it_cpm":
        picked = _detect_cpm(paths, profile_name)
    elif type_hint == "ind":
        picked = _detect_ind(paths, profile_name)
    elif type_hint == "sind":
        picked = _detect_sind(paths, profile_name)
    else:
        cpm = _detect_cpm(paths, profile_name)
        v2x = _detect_v2x(paths, profile_name)
        v2x_seq = _detect_v2x_seq(paths, profile_name)
        ind = _detect_ind(paths, profile_name)
        sind = _detect_sind(paths, profile_name)
        ranked = sorted(
            [cpm, v2x, v2x_seq, ind, sind],
            key=lambda x: float(x.get("score", 0.0)),
            reverse=True,
        )
        picked = ranked[0]
        picked["second_best"] = float(ranked[1].get("score", 0.0)) if len(ranked) > 1 else 0.0
        score = float(picked.get("score", 0.0))
        margin = score - float(picked.get("second_best", 0.0))
        if score >= 75 and margin >= 12:
            picked["decision_mode"] = "auto"
        elif score >= 50:
            picked["decision_mode"] = "confirm"
        else:
            picked["decision_mode"] = "manual"
        if isinstance(picked.get("profile"), dict):
            det = dict(picked["profile"].get("detector") or {})
            det["second_best"] = float(picked.get("second_best", 0.0))
            det["decision_mode"] = str(picked["decision_mode"])
            picked["profile"]["detector"] = det

    profile = picked.get("profile")
    if not isinstance(profile, dict):
        return {
            "ok": False,
            "error": "Could not detect a dataset profile from the provided paths.",
            **picked,
        }

    validated = validate_profile(repo_root, profile)
    out = {"ok": True, **picked}
    out["profile"] = validated["profile"]
    out["validation"] = validated["validation"]
    out["capabilities"] = validated["capabilities"]
    return out


def _normalize_binding_path(raw: Any, repo_root: Path) -> Optional[str]:
    s = str(raw or "").strip()
    if not s:
        return None
    p = Path(s).expanduser()
    if not p.is_absolute():
        p = (repo_root / p).resolve()
    else:
        p = p.resolve()
    return str(p)


def _status_from_issues(errors: List[Dict[str, str]], warnings: List[Dict[str, str]]) -> str:
    if errors:
        codes = {str(x.get("code") or "") for x in errors}
        if any(c.startswith("E_PATH_") or c == "E_ROLE_REQUIRED_MISSING" for c in codes):
            return "broken_path"
        return "schema_mismatch"
    if warnings:
        return "ready_with_warnings"
    return "ready"


def validate_profile(repo_root: Path, profile_in: Dict[str, Any]) -> Dict[str, Any]:
    now = _now_utc_iso()
    p = dict(profile_in or {})
    dataset_type = _normalize_dataset_type(p.get("dataset_type"))
    errors: List[Dict[str, str]] = []
    warnings: List[Dict[str, str]] = []

    if not dataset_type:
        errors.append(_issue("E_DATASET_UNSUPPORTED", "Unknown dataset_type."))
        out = {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "dataset_type": "",
            "name": str(p.get("name") or "Dataset"),
            "adapter_version": PROFILE_ADAPTER_VERSION,
            "roots": [],
            "bindings": {},
            "scene_strategy": {"mode": "intersection_scene"},
            "validation": {"status": _status_from_issues(errors, warnings), "errors": errors, "warnings": warnings, "last_checked": now},
            "capabilities": {},
        }
        return {"profile": out, "validation": out["validation"], "capabilities": out["capabilities"]}

    roots = _resolve_input_paths([str(x) for x in (p.get("roots") or [])], repo_root=repo_root)
    if not roots:
        raw_bindings = p.get("bindings") if isinstance(p.get("bindings"), dict) else {}
        candidate_paths: List[str] = []
        for v in raw_bindings.values():
            if isinstance(v, dict) and isinstance(v.get("path"), str):
                candidate_paths.append(v.get("path"))
            if isinstance(v, dict) and isinstance(v.get("paths"), list):
                candidate_paths.extend([str(x) for x in v.get("paths") if str(x or "").strip()])
        roots = _resolve_input_paths(candidate_paths, repo_root=repo_root)
    roots = [r for r in roots if r.exists()]
    if not roots:
        warnings.append(_issue("W_NO_ROOTS", "No existing root path resolved from profile inputs."))

    bindings_raw = p.get("bindings") if isinstance(p.get("bindings"), dict) else {}
    bindings: Dict[str, Dict[str, Any]] = {}

    def get_binding_path(role: str, required: bool, kind: str = "file") -> Optional[str]:
        obj = bindings_raw.get(role)
        if isinstance(obj, dict) and "path" in obj:
            path = _normalize_binding_path(obj.get("path"), repo_root=repo_root)
            item = {"kind": kind, "required": bool(required), "path": path or ""}
            for extra in ("detected_score", "delimiter", "encoding", "column_map"):
                if extra in obj:
                    item[extra] = obj[extra]
            bindings[role] = item
            return path
        if isinstance(obj, str):
            path = _normalize_binding_path(obj, repo_root=repo_root)
            bindings[role] = {"kind": kind, "required": bool(required), "path": path or ""}
            return path
        return None

    capabilities: Dict[str, Any] = {}
    scene_strategy = p.get("scene_strategy") if isinstance(p.get("scene_strategy"), dict) else {}
    if dataset_type == "v2x_traj":
        scene_strategy = {"mode": "intersection_scene"}
        scenes_path = get_binding_path("scenes_index", required=False, kind="file")
        ego_dir = get_binding_path("traj_ego", required=True, kind="dir")
        infra_dir = get_binding_path("traj_infra", required=True, kind="dir")
        veh_dir = get_binding_path("traj_vehicle", required=True, kind="dir")
        tl_dir = get_binding_path("traffic_light", required=False, kind="dir")
        maps_dir = get_binding_path("maps_dir", required=False, kind="dir")
        get_binding_path("profile_file", required=False, kind="file")

        for role, role_path, kind in (
            ("traj_ego", ego_dir, "dir"),
            ("traj_infra", infra_dir, "dir"),
            ("traj_vehicle", veh_dir, "dir"),
        ):
            if not role_path:
                errors.append(_issue("E_ROLE_REQUIRED_MISSING", f"Missing required binding for {role}.", role=role))
                continue
            pp = Path(role_path)
            if not pp.exists():
                errors.append(_issue("E_PATH_MISSING", f"Path does not exist for {role}.", role=role, path=role_path))
                continue
            if kind == "file" and not pp.is_file():
                errors.append(_issue("E_PATH_UNREADABLE", f"Expected a file for {role}.", role=role, path=role_path))
            if kind == "dir" and not pp.is_dir():
                errors.append(_issue("E_PATH_UNREADABLE", f"Expected a directory for {role}.", role=role, path=role_path))

        if scenes_path:
            pp = Path(scenes_path)
            if not pp.exists():
                warnings.append(_issue("W_OPTIONAL_ROLE_MISSING", "Scenes index CSV is missing; adapter will infer scenes from trajectory folders.", role="scenes_index", path=scenes_path))
            elif not pp.is_file():
                warnings.append(_issue("W_OPTIONAL_ROLE_MISSING", "Scenes index binding is not a file; adapter will infer scenes from trajectory folders.", role="scenes_index", path=scenes_path))

        if scenes_path and Path(scenes_path).exists():
            s = _score_v2x_scenes_csv(Path(scenes_path))
            if float(s.get("score", 0.0)) < 40.0:
                warnings.append(_issue("W_LOW_CONFIDENCE_DETECTION", "Scenes index CSV schema looks invalid; adapter will infer scenes from trajectory folders.", role="scenes_index", path=scenes_path))

        for role, role_path in (("traj_ego", ego_dir), ("traj_infra", infra_dir), ("traj_vehicle", veh_dir)):
            if not role_path or not Path(role_path).is_dir():
                continue
            quality = _score_traj_dir(Path(role_path))
            if quality < 50:
                errors.append(_issue("E_SCHEMA_REQUIRED_COLUMNS", f"Trajectory files in {role} are missing required columns (timestamp, x, y).", role=role, path=role_path))

        if tl_dir and (not Path(tl_dir).exists() or not Path(tl_dir).is_dir()):
            warnings.append(_issue("W_OPTIONAL_ROLE_MISSING", "Traffic light directory is missing.", role="traffic_light", path=tl_dir))
        if maps_dir and (not Path(maps_dir).exists() or not Path(maps_dir).is_dir()):
            warnings.append(_issue("W_OPTIONAL_ROLE_MISSING", "Map directory is missing.", role="maps_dir", path=maps_dir))

        capabilities = {
            "has_map": bool(maps_dir and Path(maps_dir).exists()),
            "has_traffic_lights": bool(tl_dir and Path(tl_dir).exists()),
            "splits": ["train", "val"],
            "group_label": "Intersection",
        }

    elif dataset_type == "v2x_seq":
        scene_strategy = {"mode": "sequence_scene"}
        traj_coop = get_binding_path("traj_cooperative", required=False, kind="dir")
        traj_infra = get_binding_path("traj_infra", required=False, kind="dir")
        traj_vehicle = get_binding_path("traj_vehicle", required=False, kind="dir")
        tl_dir = get_binding_path("traffic_light", required=False, kind="dir")
        maps_dir = get_binding_path("maps_dir", required=False, kind="dir")
        get_binding_path("profile_file", required=False, kind="file")

        if (not traj_coop and not traj_infra and not traj_vehicle) and roots:
            inferred = _infer_v2x_seq_bindings(roots)
            inf_bindings = inferred.get("bindings") if isinstance(inferred.get("bindings"), dict) else {}
            for role in ("traj_cooperative", "traj_infra", "traj_vehicle", "traffic_light", "maps_dir"):
                p = inf_bindings.get(role)
                if not isinstance(p, Path):
                    continue
                if role not in bindings:
                    bindings[role] = {
                        "kind": "dir",
                        "required": role == "traj_infra",
                        "path": str(p),
                        "detected_score": float((inferred.get("quality") or {}).get(role, 0.0)),
                    }
            traj_coop = traj_coop or ((bindings.get("traj_cooperative") or {}).get("path") if isinstance(bindings.get("traj_cooperative"), dict) else None)
            traj_infra = traj_infra or ((bindings.get("traj_infra") or {}).get("path") if isinstance(bindings.get("traj_infra"), dict) else None)
            traj_vehicle = traj_vehicle or ((bindings.get("traj_vehicle") or {}).get("path") if isinstance(bindings.get("traj_vehicle"), dict) else None)
            tl_dir = tl_dir or ((bindings.get("traffic_light") or {}).get("path") if isinstance(bindings.get("traffic_light"), dict) else None)
            maps_dir = maps_dir or ((bindings.get("maps_dir") or {}).get("path") if isinstance(bindings.get("maps_dir"), dict) else None)

        if not traj_coop and not traj_infra and not traj_vehicle:
            errors.append(
                _issue(
                    "E_ROLE_REQUIRED_MISSING",
                    "At least one trajectory directory is required (traj_cooperative, traj_infra, or traj_vehicle).",
                    role="traj_cooperative",
                )
            )

        for role, role_path in (("traj_cooperative", traj_coop), ("traj_infra", traj_infra), ("traj_vehicle", traj_vehicle)):
            if not role_path:
                continue
            pp = Path(role_path)
            if not pp.exists():
                errors.append(_issue("E_PATH_MISSING", f"Path does not exist for {role}.", role=role, path=role_path))
                continue
            if not pp.is_dir():
                errors.append(_issue("E_PATH_UNREADABLE", f"Expected a directory for {role}.", role=role, path=role_path))
                continue
            quality = _score_traj_dir(pp)
            if quality < 50:
                errors.append(_issue("E_SCHEMA_REQUIRED_COLUMNS", f"Directory for {role} does not look like trajectory CSV data.", role=role, path=role_path))

        if tl_dir:
            pp = Path(tl_dir)
            if not pp.exists() or not pp.is_dir():
                warnings.append(_issue("W_OPTIONAL_ROLE_MISSING", "Traffic light directory is missing.", role="traffic_light", path=tl_dir))
            else:
                q_tl = _score_tl_dir(pp)
                if q_tl < 50:
                    warnings.append(_issue("W_LOW_CONFIDENCE_DETECTION", "Traffic light directory schema looks unusual; verify mapping.", role="traffic_light", path=tl_dir))

        if maps_dir and (not Path(maps_dir).exists() or not Path(maps_dir).is_dir()):
            warnings.append(_issue("W_OPTIONAL_ROLE_MISSING", "Map directory is missing.", role="maps_dir", path=maps_dir))

        capabilities = {
            "has_map": bool(maps_dir and Path(maps_dir).exists()),
            "has_traffic_lights": bool(tl_dir and Path(tl_dir).exists()),
            "splits": ["train", "val"],
            "group_label": "Intersection",
        }

    elif dataset_type == "ind":
        mode = str(scene_strategy.get("mode") or "recording_window")
        window_s = int(scene_strategy.get("window_s") or 60)
        scene_strategy = {"mode": mode, "window_s": max(10, min(600, window_s))}

        data_dir = get_binding_path("data_dir", required=True, kind="dir")
        maps_dir = get_binding_path("maps_dir", required=False, kind="dir")

        if not data_dir and roots:
            inferred = _infer_ind_bindings(roots)
            inf_data = inferred.get("data_dir")
            inf_maps = inferred.get("maps_dir")
            if isinstance(inf_data, Path):
                bindings["data_dir"] = {
                    "kind": "dir",
                    "required": True,
                    "path": str(inf_data),
                    "detected_score": float(inferred.get("score") or 0.0),
                }
                data_dir = str(inf_data)
            if isinstance(inf_maps, Path) and "maps_dir" not in bindings:
                bindings["maps_dir"] = {
                    "kind": "dir",
                    "required": False,
                    "path": str(inf_maps),
                    "detected_score": 100.0,
                }
                maps_dir = str(inf_maps)

        if not data_dir:
            errors.append(_issue("E_ROLE_REQUIRED_MISSING", "Missing required binding for data_dir.", role="data_dir"))
        else:
            dp = Path(data_dir)
            if not dp.exists():
                errors.append(_issue("E_PATH_MISSING", "Path does not exist for data_dir.", role="data_dir", path=data_dir))
            elif not dp.is_dir():
                errors.append(_issue("E_PATH_UNREADABLE", "Expected a directory for data_dir.", role="data_dir", path=data_dir))
            else:
                scored = _score_ind_data_dir(dp)
                recordings = int(scored.get("recordings") or 0)
                if recordings <= 0:
                    errors.append(_issue("E_SCHEMA_REQUIRED_COLUMNS", "No inD recording files were found in data_dir.", role="data_dir", path=data_dir))
                if float(scored.get("triplet_ratio") or 0.0) < 1.0 and recordings > 0:
                    warnings.append(_issue("W_LOW_CONFIDENCE_DETECTION", "Some recordings are missing *_tracksMeta or *_recordingMeta files.", role="data_dir", path=data_dir))
                if float(scored.get("header_ok_ratio") or 0.0) < 0.6 and recordings > 0:
                    warnings.append(_issue("W_LOW_CONFIDENCE_DETECTION", "inD CSV headers look unusual; verify dataset layout.", role="data_dir", path=data_dir))

        if maps_dir and (not Path(maps_dir).exists() or not Path(maps_dir).is_dir()):
            warnings.append(_issue("W_OPTIONAL_ROLE_MISSING", "Map directory is missing.", role="maps_dir", path=maps_dir))

        capabilities = {
            "has_map": False,
            "has_traffic_lights": False,
            "splits": ["all"],
            "group_label": "Location",
        }

    elif dataset_type == "sind":
        scene_strategy = {"mode": "scenario_scene"}

        data_dir = get_binding_path("data_dir", required=True, kind="dir")
        maps_dir = get_binding_path("maps_dir", required=False, kind="dir")

        if not data_dir and roots:
            inferred = _infer_sind_bindings(roots)
            inf_data = inferred.get("data_dir")
            inf_maps = inferred.get("maps_dir")
            details = inferred.get("details") if isinstance(inferred.get("details"), dict) else {}
            if isinstance(inf_data, Path):
                bindings["data_dir"] = {
                    "kind": "dir",
                    "required": True,
                    "path": str(inf_data),
                    "detected_score": float(inferred.get("score") or 0.0),
                }
                data_dir = str(inf_data)
            if isinstance(inf_maps, Path) and "maps_dir" not in bindings:
                bindings["maps_dir"] = {
                    "kind": "dir",
                    "required": False,
                    "path": str(inf_maps),
                    "detected_score": float(details.get("map_city_ratio") or 0.0) * 100.0,
                }
                maps_dir = str(inf_maps)

        score_info: Dict[str, Any] = {}
        if not data_dir:
            errors.append(_issue("E_ROLE_REQUIRED_MISSING", "Missing required binding for data_dir.", role="data_dir"))
        else:
            dp = Path(data_dir)
            if not dp.exists():
                errors.append(_issue("E_PATH_MISSING", "Path does not exist for data_dir.", role="data_dir", path=data_dir))
            elif not dp.is_dir():
                errors.append(_issue("E_PATH_UNREADABLE", "Expected a directory for data_dir.", role="data_dir", path=data_dir))
            else:
                score_info = _score_sind_root(dp)
                scenario_count = int(score_info.get("scenario_count") or 0)
                city_count = int(score_info.get("city_count") or 0)
                if scenario_count <= 0:
                    errors.append(_issue("E_SCHEMA_REQUIRED_COLUMNS", "No SinD scenario folders were found in data_dir.", role="data_dir", path=data_dir))
                if city_count <= 0:
                    warnings.append(_issue("W_LOW_CONFIDENCE_DETECTION", "No SinD city structure was detected.", role="data_dir", path=data_dir))
                if float(score_info.get("veh_ratio") or 0.0) < 0.6:
                    warnings.append(_issue("W_LOW_CONFIDENCE_DETECTION", "Many scenarios are missing Veh_smoothed_tracks.csv.", role="data_dir", path=data_dir))
                if float(score_info.get("ped_ratio") or 0.0) < 0.6:
                    warnings.append(_issue("W_LOW_CONFIDENCE_DETECTION", "Many scenarios are missing Ped_smoothed_tracks.csv.", role="data_dir", path=data_dir))
                if float(score_info.get("map_city_ratio") or 0.0) <= 0.0:
                    warnings.append(_issue("W_OPTIONAL_ROLE_MISSING", "No city-level OSM map files were detected.", role="maps_dir", path=data_dir))

        if maps_dir and (not Path(maps_dir).exists() or not Path(maps_dir).is_dir()):
            warnings.append(_issue("W_OPTIONAL_ROLE_MISSING", "Map directory is missing.", role="maps_dir", path=maps_dir))

        capabilities = {
            "has_map": bool(float(score_info.get("map_city_ratio") or 0.0) > 0.0),
            "has_traffic_lights": bool(float(score_info.get("tl_ratio") or 0.0) > 0.0),
            "splits": ["all"],
            "group_label": "City",
        }

    elif dataset_type == "consider_it_cpm":
        mode = str(scene_strategy.get("mode") or "time_window")
        window_s = int(scene_strategy.get("window_s") or 300)
        gap_s = int(scene_strategy.get("gap_s") or 120)
        scene_strategy = {"mode": mode, "window_s": max(1, window_s), "gap_s": max(0, gap_s)}

        logs_obj = bindings_raw.get("cpm_logs") if isinstance(bindings_raw.get("cpm_logs"), dict) else {}
        raw_paths = logs_obj.get("paths") if isinstance(logs_obj.get("paths"), list) else []
        log_paths = _resolve_input_paths([str(x) for x in raw_paths], repo_root=repo_root)
        if not log_paths and roots:
            # Fallback discovery for manual profiles with only roots.
            log_paths = _collect_cpm_csv_files(roots, max_files=None)
        existing_logs = [p for p in log_paths if p.exists() and p.is_file()]
        if not existing_logs:
            errors.append(_issue("E_ROLE_REQUIRED_MISSING", "No CPM CSV files resolved for cpm_logs.", role="cpm_logs"))

        explicit_map = logs_obj.get("column_map") if isinstance(logs_obj.get("column_map"), dict) else None
        score_inputs = _uniform_sample_paths(existing_logs, max_n=3000)
        scored = [_score_cpm_csv(p, explicit_col_map=explicit_map) for p in score_inputs]
        scored.sort(key=lambda x: float(x.get("score", 0.0)), reverse=True)
        valid = [s for s in scored if float(s.get("score", 0.0)) >= 50.0]
        if existing_logs and not valid:
            errors.append(_issue("E_SCHEMA_REQUIRED_COLUMNS", "CPM CSV files do not contain the required core columns.", role="cpm_logs"))
        if scored and float(scored[0].get("score", 0.0)) < 75.0 and valid:
            warnings.append(_issue("W_LOW_CONFIDENCE_DETECTION", "CPM detection confidence is moderate; verify column mapping.", role="cpm_logs"))

        best_for_map = valid[0] if valid else (scored[0] if scored else None)
        column_map = dict((best_for_map or {}).get("field_map") or {})
        delimiter = str((best_for_map or {}).get("delimiter") or ",")
        encoding = str((best_for_map or {}).get("encoding") or "utf-8")
        bindings["cpm_logs"] = {
            "kind": "file_list",
            "required": True,
            "paths": [str(p.resolve()) for p in existing_logs],
            "detected_score": float((best_for_map or {}).get("score", 0.0)),
            "delimiter": delimiter,
            "encoding": encoding,
            "column_map": column_map,
        }

        proto_obj = bindings_raw.get("proto_schema")
        proto_path = None
        if isinstance(proto_obj, dict) and "path" in proto_obj:
            proto_path = _normalize_binding_path(proto_obj.get("path"), repo_root=repo_root)
        elif isinstance(proto_obj, str):
            proto_path = _normalize_binding_path(proto_obj, repo_root=repo_root)
        if proto_path:
            bindings["proto_schema"] = {"kind": "file", "required": False, "path": proto_path}
            if not Path(proto_path).exists():
                warnings.append(_issue("W_OPTIONAL_ROLE_MISSING", "Proto schema file path does not exist.", role="proto_schema", path=proto_path))

        basemap = p.get("basemap") if isinstance(p.get("basemap"), dict) else {}
        if basemap and not basemap.get("origin") and not basemap.get("origin_by_intersect"):
            warnings.append(_issue("W_NO_MAP_CONFIG", "Basemap config provided without origin coordinates."))

        capabilities = {
            "has_map": bool(basemap.get("origin") or basemap.get("origin_by_intersect")),
            "has_traffic_lights": False,
            "splits": ["all"],
            "group_label": "Sensor",
        }

    status = _status_from_issues(errors, warnings)
    profile_id = str(p.get("profile_id") or "").strip() or str(uuid.uuid4())
    dataset_id = str(p.get("dataset_id") or "").strip()
    if not dataset_id:
        dataset_id = f"profile-{dataset_type.replace('_', '-')}-{profile_id[:8]}"

    detector = p.get("detector") if isinstance(p.get("detector"), dict) else {}
    detector = {
        "score": float(detector.get("score") or 0.0),
        "second_best": float(detector.get("second_best") or 0.0),
        "decision_mode": str(detector.get("decision_mode") or ("auto" if status.startswith("ready") else "manual")),
        "checked_at": str(detector.get("checked_at") or now),
    }

    validation = {
        "status": status,
        "errors": errors,
        "warnings": warnings,
        "last_checked": now,
    }

    cache = p.get("cache") if isinstance(p.get("cache"), dict) else {}
    cache_out = {
        "index_dir": str(cache.get("index_dir") or ""),
        "fingerprint": str(cache.get("fingerprint") or ""),
        "index_version": str(cache.get("index_version") or PROFILE_ADAPTER_VERSION),
        "last_indexed_at": str(cache.get("last_indexed_at") or ""),
        "scene_count": int(cache.get("scene_count") or 0),
        "row_count": int(cache.get("row_count") or 0),
    }

    profile_out = {
        "schema_version": PROFILE_SCHEMA_VERSION,
        "profile_id": profile_id,
        "dataset_id": dataset_id,
        "name": str(p.get("name") or "Dataset Profile"),
        "dataset_type": dataset_type,
        "adapter_version": str(p.get("adapter_version") or PROFILE_ADAPTER_VERSION),
        "roots": [str(x) for x in roots] if roots else [],
        "bindings": bindings,
        "scene_strategy": scene_strategy,
        "detector": detector,
        "validation": validation,
        "cache": cache_out,
        "capabilities": capabilities,
        "ui_defaults": p.get("ui_defaults") if isinstance(p.get("ui_defaults"), dict) else {},
    }
    if dataset_type == "consider_it_cpm":
        basemap = p.get("basemap") if isinstance(p.get("basemap"), dict) else {}
        if basemap:
            profile_out["basemap"] = basemap
    return {"profile": profile_out, "validation": validation, "capabilities": capabilities}


def _profile_dir(repo_root: Path) -> Path:
    env = str(os.environ.get("TRAJ_PROFILE_DIR") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
    desktop = str(os.environ.get("TRAJ_DESKTOP_APP") or "0") == "1"
    if desktop:
        app_name = str(os.environ.get("TRAJ_APP_NAME") or "V2X Scene Explorer")
        return (Path.home() / "Library" / "Application Support" / app_name / "profiles").resolve()
    return (repo_root / "dataset" / "profiles.local").resolve()


def _safe_profile_filename(profile_id: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9_-]+", "", str(profile_id or ""))
    if not s:
        s = str(uuid.uuid4())
    return f"{s}.json"


class ProfileStore:
    _STATE_FILE_NAME = "_profile_store_state.json"

    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root.resolve()
        self.dir = _profile_dir(self.repo_root)
        self.dir.mkdir(parents=True, exist_ok=True)

    def _profile_path(self, profile_id: str) -> Path:
        return self.dir / _safe_profile_filename(profile_id)

    def _state_path(self) -> Path:
        return self.dir / self._STATE_FILE_NAME

    def _iter_profile_paths(self) -> List[Path]:
        out: List[Path] = []
        for p in sorted(self.dir.glob("*.json")):
            if p.name == self._STATE_FILE_NAME:
                continue
            out.append(p)
        return out

    def _read_state(self) -> Dict[str, Any]:
        p = self._state_path()
        if not p.exists():
            return {}
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return raw if isinstance(raw, dict) else {}

    def _write_state(self, state: Dict[str, Any]) -> None:
        p = self._state_path()
        payload = state if isinstance(state, dict) else {}
        p.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")

    def _default_profile_id(self) -> str:
        state = self._read_state()
        return str(state.get("default_profile_id") or "").strip()

    def _set_default_profile_id(self, profile_id: str) -> None:
        pid = str(profile_id or "").strip()
        state = self._read_state()
        if pid:
            state["default_profile_id"] = pid
        else:
            state.pop("default_profile_id", None)
        self._write_state(state)

    def _profile_summary(self, raw: Dict[str, Any], fallback_id: str, default_profile_id: str) -> Dict[str, Any]:
        profile_id = str(raw.get("profile_id") or fallback_id)
        return {
            "profile_id": profile_id,
            "dataset_id": str(raw.get("dataset_id") or ""),
            "name": str(raw.get("name") or fallback_id),
            "dataset_type": str(raw.get("dataset_type") or ""),
            "status": str(((raw.get("validation") or {}).get("status")) or ""),
            "last_checked": str(((raw.get("validation") or {}).get("last_checked")) or ""),
            "is_default": bool(default_profile_id and profile_id == default_profile_id),
        }

    def list_profiles(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        default_profile_id = self._default_profile_id()
        for p in self._iter_profile_paths():
            try:
                raw = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(raw, dict):
                continue
            out.append(self._profile_summary(raw, p.stem, default_profile_id))
        out.sort(key=lambda x: (not bool(x.get("is_default")), x["name"].lower(), x["profile_id"]))
        return out

    def read_profile(self, profile_id: str) -> Optional[Dict[str, Any]]:
        p = self._profile_path(profile_id)
        if not p.exists():
            return None
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None
        return raw if isinstance(raw, dict) else None

    def get_profile(self, profile_id: str) -> Optional[Dict[str, Any]]:
        raw = self.read_profile(profile_id)
        if not isinstance(raw, dict):
            return None
        v = validate_profile(self.repo_root, raw)
        norm = dict(v["profile"])
        summary = self._profile_summary(norm, str(norm.get("profile_id") or profile_id), self._default_profile_id())
        return {"profile": norm, "summary": summary, "validation": v["validation"], "capabilities": v["capabilities"]}

    def detect(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return detect_profile(self.repo_root, payload)

    def validate(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        profile = payload.get("profile") if isinstance(payload.get("profile"), dict) else payload
        v = validate_profile(self.repo_root, profile if isinstance(profile, dict) else {})
        return {"ok": True, "profile": v["profile"], "validation": v["validation"], "capabilities": v["capabilities"]}

    def save_profile(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        profile = payload.get("profile") if isinstance(payload.get("profile"), dict) else payload
        if not isinstance(profile, dict):
            raise ValueError("profile payload must be an object")
        v = validate_profile(self.repo_root, profile)
        norm = dict(v["profile"])
        status = str(((norm.get("validation") or {}).get("status")) or "")
        if status not in ("ready", "ready_with_warnings"):
            raise ValueError("Profile validation failed; fix errors before saving.")

        p = self._profile_path(str(norm.get("profile_id") or ""))
        p.write_text(json.dumps(norm, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
        profile_id = str(norm.get("profile_id") or "").strip()
        if profile_id and not self._default_profile_id():
            self._set_default_profile_id(profile_id)
        return norm

    def delete_profile(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        profile_id = str(payload.get("profile_id") or payload.get("id") or "").strip()
        if not profile_id:
            raise ValueError("profile_id is required")
        p = self._profile_path(profile_id)
        if not p.exists():
            raise KeyError(f"profile not found: {profile_id}")
        p.unlink()

        default_profile_id = self._default_profile_id()
        if default_profile_id and default_profile_id == profile_id:
            remaining = self.list_profiles()
            next_default = str((remaining[0] if remaining else {}).get("profile_id") or "")
            self._set_default_profile_id(next_default)
        return {"ok": True, "profile_id": profile_id, "default_profile_id": self._default_profile_id()}

    def set_default_profile(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        profile_id = str(payload.get("profile_id") or payload.get("id") or "").strip()
        if not profile_id:
            raise ValueError("profile_id is required")
        raw = self.read_profile(profile_id)
        if not isinstance(raw, dict):
            raise KeyError(f"profile not found: {profile_id}")
        self._set_default_profile_id(profile_id)
        return {
            "ok": True,
            "profile_id": profile_id,
            "name": str(raw.get("name") or profile_id),
            "dataset_id": str(raw.get("dataset_id") or ""),
        }

    def _iter_ready_profiles(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for p in self._iter_profile_paths():
            try:
                raw = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(raw, dict):
                continue
            status = str(((raw.get("validation") or {}).get("status")) or "")
            if status not in ("ready", "ready_with_warnings"):
                continue
            out.append(raw)
        return out

    def dataset_entries(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        default_profile_id = self._default_profile_id()
        ready_profiles = self._iter_ready_profiles()
        ready_profiles.sort(
            key=lambda p: (
                str(p.get("profile_id") or "") != default_profile_id,
                str(p.get("name") or p.get("dataset_id") or "").lower(),
            )
        )
        for p in ready_profiles:
            dataset_type = _normalize_dataset_type(p.get("dataset_type"))
            did = str(p.get("dataset_id") or "").strip()
            if not did:
                continue
            roots = [str(x) for x in (p.get("roots") or []) if str(x).strip()]
            root = roots[0] if roots else ""
            if not root:
                continue
            entry: Dict[str, Any] = {
                "id": did,
                "title": str(p.get("name") or did),
                "root": root,
                "bindings": p.get("bindings") if isinstance(p.get("bindings"), dict) else {},
                "scene_strategy": p.get("scene_strategy") if isinstance(p.get("scene_strategy"), dict) else {},
                "profile_id": str(p.get("profile_id") or ""),
            }
            if dataset_type == "v2x_traj":
                entry["family"] = "v2x-traj"
                scenes_path = (((entry.get("bindings") or {}).get("scenes_index") or {}).get("path")) if isinstance(entry.get("bindings"), dict) else None
                if scenes_path:
                    entry["scenes"] = str(scenes_path)
            elif dataset_type == "v2x_seq":
                entry["family"] = "v2x-seq"
            elif dataset_type == "ind":
                entry["family"] = "ind"
            elif dataset_type == "sind":
                entry["family"] = "sind"
            elif dataset_type == "consider_it_cpm":
                entry["family"] = "cpm-objects"
                basemap = p.get("basemap") if isinstance(p.get("basemap"), dict) else None
                if basemap:
                    entry["basemap"] = basemap
            else:
                continue
            out.append(entry)
        return out


def load_profile_dataset_entries(repo_root: Path) -> List[Dict[str, Any]]:
    try:
        store = ProfileStore(repo_root)
        return store.dataset_entries()
    except Exception:
        return []
