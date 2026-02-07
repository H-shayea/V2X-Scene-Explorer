# V2X-Traj Dataset Documentation

## 1) Dataset introduction

V2X-Traj is a cooperative trajectory dataset for vehicle-to-everything (V2X) research.
It combines information from different viewpoints (ego vehicle, infrastructure, and other
vehicles) together with traffic light states and HD maps.

## 2) Dataset scope and source

This document describes the dataset stored at:
- `dataset/v2x-traj`

## 3) Dataset structure

Inside `dataset/v2x-traj`, the data is organized into five parts:
- ego-vehicle trajectories (train and validation)
- infrastructure trajectories (train and validation)
- vehicle trajectories (train and validation)
- traffic light states (train and validation)
- HD maps (JSON files)

Folder layout:

```text
dataset/v2x-traj/
├── ego-trajectories/
│   ├── train/data/            (CSV files)
│   └── val/data/              (CSV files)
├── infrastructure-trajectories/
│   ├── train/data/            (CSV files)
│   └── val/data/              (CSV files)
├── vehicle-trajectories/
│   ├── train/data/            (CSV files)
│   └── val/data/              (CSV files)
├── traffic-light/
│   ├── train/data/            (CSV files)
│   └── val/data/              (CSV files)
└── maps/                      (JSON files)
```

## 4) Split and file counts (local check)

- `ego-trajectories/train/data`: 6062
- `ego-trajectories/val/data`: 2020
- `infrastructure-trajectories/train/data`: 6062
- `infrastructure-trajectories/val/data`: 2020
- `vehicle-trajectories/train/data`: 6062
- `vehicle-trajectories/val/data`: 2020
- `traffic-light/train/data`: 6062
- `traffic-light/val/data`: 2020
- `maps`: 28 JSON files

## 5) Data schema

### 5.1 Trajectory CSVs
Applies to:
- `ego-trajectories/train/data` and `ego-trajectories/val/data`
- `infrastructure-trajectories/train/data` and `infrastructure-trajectories/val/data`
- `vehicle-trajectories/train/data` and `vehicle-trajectories/val/data`

Columns:
`city, timestamp, id, type, sub_type, tag, x, y, z, length, width, height, theta, v_x, v_y, intersect_id`

Observed values (sampled):
- `type`: `VEHICLE`, `BICYCLE`, `PEDESTRIAN`
- `sub_type`: `CAR`, `TRUCK`, `VAN`, `BUS`, `PEDESTRIAN`, `MOTORCYCLIST`, `TRICYCLIST`, `UNKNOWN`
- `tag`: mostly `OTHERS`

### 5.2 Traffic-light CSVs
Applies to:
- `traffic-light/train/data` and `traffic-light/val/data`

Columns:
`city, timestamp, x, y, direction, lane_id, color_1, remain_1, color_2, remain_2, color_3, remain_3, intersect_id`

Observed values (sampled):
- `direction`: `NORTH`, `SOUTH`, `EAST`, `WEST`
- light colors: `RED`, `YELLOW`, `GREEN`

### 5.3 Map JSON files
Applies to:
- files under `maps/` (for example `yizhuang_hdmap1.json`)

Top-level keys:
- `LANE`
- `STOPLINE`
- `CROSSWALK`
- `JUNCTION`

Common lane fields:
- `has_traffic_control`, `lane_type`, `turn_direction`, `is_intersection`
- `l_neighbor_id`, `r_neighbor_id`, `predecessors`, `successors`
- `centerline`, `left_boundary`, `right_boundary`

## 6) Timing note

Sample trajectory files show timestamp steps of `0.1` seconds (10 Hz).

## 7) Usage scope

All preprocessing, training, and evaluation should use `dataset/v2x-traj`.

## 8) Intersection naming (readable aliases)

To make reports easier to read, use these aliases while keeping raw `intersect_id` values for joins:

| Raw `intersect_id` | Alias |
|---|---|
| `yizhuang#4-1_po` | `Yizhuang Intersection 04` |
| `yizhuang#7-1_po` | `Yizhuang Intersection 07` |
| `yizhuang#11-1_po` | `Yizhuang Intersection 11` |
| `yizhuang#12-1_po` | `Yizhuang Intersection 12` |
| `yizhuang#13-1_po` | `Yizhuang Intersection 13` |
| `yizhuang#14-1_po` | `Yizhuang Intersection 14` |
| `yizhuang#20-1_po` | `Yizhuang Intersection 20` |
| `yizhuang#25-1_po` | `Yizhuang Intersection 25` |
