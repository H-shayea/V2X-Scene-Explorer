# Tutorial 02: Dataset Layouts and Quirks

This tutorial documents the folder structures the app expects when users load a local dataset directory.

## 1) V2X-Traj (`family: v2x-traj`)

Expected root:

```text
<root>/
  ego-trajectories/
  infrastructure-trajectories/
  vehicle-trajectories/
  traffic-light/            # optional
  maps/                     # optional
```

Scene behavior:

- Split: `train` / `val`
- Group: intersection
- Scene: dataset-provided scene id

## 2) V2X-Seq (`family: v2x-seq`)

Expected root:

```text
<root>/
  single-infrastructure/
    trajectories/
    traffic-light/
  single-vehicle/
    trajectories/
  cooperative-vehicle-infrastructure/
    cooperative-trajectories/      # optional in some subsets
    infrastructure-trajectories/    # optional in some subsets
    vehicle-trajectories/           # optional in some subsets
    traffic-light/                  # optional
  maps/                             # optional
```

Important quirk:

- Some local copies have folder names that do not match the actual CSV schema.
- The loader uses CSV headers to classify each folder as trajectory vs traffic-light.

Viewer controls:

- Scene panel shows split-level modality availability.
- V2X-Seq adds a toggle: `Include traffic-light-only scenes`.

## 3) Consider.it CPM Objects (`family: cpm-objects`)

Expected root:

```text
<root>/
  lidar/
    *.csv
  thermal_camera/
    *.csv
  sensor_interface-v1.2.1.proto     # optional but recommended
```

Scene behavior:

- Split: `all`
- Group: sensor stream
- Scene: gap-aware time window extracted from continuous logs

Known behavior:

- App merges detected CPM logs from `lidar/` and `thermal_camera/`.
- In this project, classes are normalized to two groups for this dataset:
  - `VEHICLE`
  - `VRU`
