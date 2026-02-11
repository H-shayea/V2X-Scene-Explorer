# Tutorial 01: How We Define "Scenes"

This app supports multiple dataset families. A key idea is the word "scene".

In V2X Scene Explorer, a "scene" is simply the smallest unit we load and play back in the viewer.
It is not always defined the same way for every dataset.

This tutorial explains how scenes are defined for each dataset family, and why.

## Why do we divide data into scenes?

Even if a dataset is a continuous recording, the viewer needs manageable chunks so that:

- Loading stays fast and predictable (no multi-gigabyte loads).
- Playback UI is simple (a single timeline slider with a finite range).
- Scene navigation is useful (next/prev scene, jump to a scene ID).
- Caching is practical (we can keep one scene bundle in memory).

## Three dataset families, three definitions of "scene"

### 1) V2X-Traj (`family: v2x-traj`)

For V2X-Traj, scenes are already defined by the dataset:

- Each `scene_id` corresponds to a set of CSV files for different modalities (ego / infrastructure / other vehicles / traffic lights).
- Scenes are grouped by an "intersection" identifier.
- There are explicit splits: `train` and `val`.

Where it is implemented:

- Dataset index files:
  - `dataset/profiles/v2x-traj/scenes.csv` (scene list used for fast browsing)
  - `dataset/profiles/v2x-traj/profile.json` (profiling summary; optional for the app UI)
- Backend adapter:
  - `apps/server/datasets.py` -> `V2XTrajAdapter`

Important point: for V2X-Traj we do *not* invent scenes. We use the dataset's scene ids and metadata.

### 2) V2X-Seq (`family: v2x-seq`)

For V2X-Seq, we treat each CSV clip as one scene:

- Scene id = CSV file stem
- Split = parent folder (`train` / `val`)
- Grouping = intersection id when available in CSV rows

Compared to V2X-Traj, V2X-Seq local copies can be inconsistent in folder naming.
So the loader uses CSV schema to classify data roles (trajectory vs traffic-light), not
only the folder name.

Where it is implemented:

- Backend adapter:
  - `apps/server/datasets.py` -> `V2XSeqAdapter`

### 3) Consider.it CPM Objects (`family: cpm-objects`)

For Consider.it CPM Objects, the raw data is a continuous log stored as CSV files.
There is no scene boundary provided. So we define scenes ourselves.

We treat the dataset as:

- UI "Group" (shown as "Sensor") = one CSV log file (example: `lidar/RSU_08/...cpm-objects.csv`)
- "Scene" = a time window ("chunk") inside that CSV log

Where it is implemented:

- Backend adapter:
  - `apps/server/datasets.py` -> `CpmObjectsAdapter`

#### The segmentation rules (gap-aware, capped windows)

We scan each CSV file and split it into windows using two rules:

1) Start a new scene if there is a large time gap between frames.
   - Default gap: `DEFAULT_GAP_S = 120` seconds
2) Start a new scene if the current window becomes too long.
   - Default max window length: `DEFAULT_WINDOW_S = 300` seconds (5 minutes)

These defaults are tuned to avoid "a lot of short scenes" while keeping each scene small enough to load quickly.

Code reference:

- `apps/server/datasets.py`
  - `class CpmObjectsAdapter`
  - `DEFAULT_WINDOW_S`, `DEFAULT_GAP_S`
  - `_index_one_csv()` (build window boundaries)
  - `_build_index()` (assign stable scene ids)

#### What is a "frame" in CPM Objects?

In CPM Objects CSV logs:

- The first column is `generationTime_ms` (epoch milliseconds).
- Each timestamp corresponds to a "frame" (an update time).
- A single frame can contain many rows (one per detected object).

In the code, we detect a new frame when `generationTime_ms` changes.

#### Pseudocode for windowing

```text
window = None
last_frame_ts = None

for each CSV row:
  ts = generationTime_ms
  new_frame = (ts != last_frame_ts)

  if window is None:
    start window at ts
  else if new_frame:
    gap_s = (ts - last_frame_ts) / 1000
    dur_s = (ts - window.first_ts) / 1000

    if gap_s > GAP_S or dur_s >= WINDOW_S:
      start new window at ts

  add row to window
  if new_frame: last_frame_ts = ts
```

#### Stable scene ids

After we compute windows for each sensor log, we generate stable scene ids:

- For each window we create a scene reference (sensor_id + window index).
- We flatten all windows into one list and sort them by:
  - `sensor_id`, then `first_ts`, then `window_i`
- We assign scene ids as `1..N` in that order.

This is implemented in:

- `apps/server/datasets.py` -> `CpmObjectsAdapter._build_index()`

#### Why not treat the entire file as one scene?

Because some sensor logs can be very long and dense:

- A single scene would take too long to load.
- The timeline slider would be huge and unpleasant to use.
- Rendering would be heavy (too many objects across too many frames).

Windowing gives a better interactive experience.

## How this maps to the UI

- For V2X-Traj:
  - Split: `Train` / `Validation`
  - Group: `Intersection`
  - Scene: dataset-provided `scene_id`
- For V2X-Seq:
  - Split: `Train` / `Validation`
  - Group: `Intersection`
  - Scene: one CSV clip
- For CPM Objects:
  - Split: always `All`
  - Group: `Sensor` (CSV file)
  - Scene: a numbered window within that sensor log

The dataset declares its UI "shape" via metadata returned by `/api/datasets`
(see `apps/server/datasets.py` -> `DatasetStore._dataset_meta()`).

## Optional exercise: tweak CPM window sizes (advanced)

If you want longer or shorter CPM scenes, change:

- `CpmObjectsAdapter.DEFAULT_WINDOW_S` (max window length)
- `CpmObjectsAdapter.DEFAULT_GAP_S` (gap threshold)

Then restart the server and observe how the number of scenes changes per sensor.
