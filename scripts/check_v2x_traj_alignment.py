#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from apps.server.datasets import DatasetStore


def is_bad_warning(w: str) -> bool:
    w = str(w)
    if w.startswith("map_load_failed"):
        return True
    if w in ("scene_outside_map_bbox", "scene_center_outside_map_bbox"):
        return True
    if w == "intersect_id_mismatch_across_modalities":
        return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Quick correctness smoke-test for v2x-traj map↔scene alignment.")
    ap.add_argument("--dataset-id", default="v2x-traj")
    ap.add_argument("--split", default="both", choices=["train", "val", "both"])
    ap.add_argument("--intersections", type=int, default=5, help="How many intersections to sample per split.")
    ap.add_argument("--scenes-per-intersection", type=int, default=5, help="How many scenes to sample per intersection.")
    ap.add_argument("--map-clip", default="scene", choices=["scene", "intersection"])
    ap.add_argument("--map-padding", type=float, default=120.0)
    ap.add_argument("--map-points-step", type=int, default=3)
    ap.add_argument("--max-lanes", type=int, default=5000)
    args = ap.parse_args()

    store = DatasetStore(Path(".").resolve())
    adapter = store.get_adapter(args.dataset_id)

    splits = ["train", "val"] if args.split == "both" else [args.split]
    bad_total = 0

    for split in splits:
        ints = adapter.list_intersections(split)[: max(0, args.intersections)]
        print(f"\nSplit: {split}  (sampled intersections={len(ints)})")

        checked = 0
        bad = 0
        for it in ints:
            iid = it["intersect_id"]
            scenes = adapter.list_scenes(
                split,
                intersect_id=iid,
                limit=max(1, args.scenes_per_intersection),
                offset=0,
            )["items"]

            for s in scenes:
                sid = s["scene_id"]
                bundle = adapter.load_scene_bundle(
                    split=split,
                    scene_id=sid,
                    include_map=True,
                    map_padding=args.map_padding,
                    map_points_step=args.map_points_step,
                    max_lanes=args.max_lanes,
                    map_clip=args.map_clip,
                )
                warnings = bundle.get("warnings") or []
                bad_w = [w for w in warnings if is_bad_warning(w)]
                checked += 1
                if bad_w:
                    bad += 1
                    bad_total += 1
                    print(f"- BAD: intersect={iid} scene={sid} warnings={bad_w}")

        print(f"Checked scenes: {checked}")
        print(f"Bad scenes:     {bad}")

    if bad_total:
        print(f"\nFAIL: found {bad_total} bad scenes (map mismatch / map load / intersect mismatch).")
        return 2

    print("\nOK: no map mismatch warnings in sampled scenes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
