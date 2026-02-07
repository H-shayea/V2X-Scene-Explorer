# V2X Scene Explorer

Owner: Hassan

V2X Scene Explorer is a lightweight, dependency-free web app for exploring multi-agent trajectory datasets:
scene browsing, playback, full trajectories, per-class filters, and HD map rendering when available.

![V2X Scene Explorer hero](apps/web/hero.svg)

## Features

- Dataset picker with per-dataset settings (saved locally in your browser)
- Scene navigation (next/prev, list paging, jump to scene ID)
- Playback (play/pause, next frame, speed control)
- Visual layers: trajectories, velocity arrows, heading arrows
- Filters: modality/stream, object type, and fine-grained classes (subtypes)
- HD map layers (lanes/stoplines/crosswalks/junction areas) for datasets that provide maps

## Quick start

### Requirements

- Python 3.10+ (backend uses only the Python standard library)

### 1) Configure datasets (not included in this repo)

Datasets are intentionally not committed to GitHub (they are large). After downloading a dataset locally,
edit `dataset/registry.json` and set each dataset's `root` to your local path.

Default expected locations (recommended):

- `dataset/v2x-traj/` (V2X-Traj dataset root)
- `dataset/ConsiderIt/` (Consider.it CPM Objects dataset root)

### 2) Run the server

From the repo root:

```bash
python3 -m apps.server.server --port 8000
```

Dev mode (auto-restart the backend when Python files change):

```bash
python3 -m apps.server.server --port 8000 --reload
```

Then open:

- http://127.0.0.1:8000

## Supported datasets

### V2X-Traj (`family: v2x-traj`)

- Splits: `train`, `val`
- Grouping: intersections -> scenes
- Map: supported (HD map rendering)

Note: this repo includes a small, precomputed scene index in `dataset/profiles/v2x-traj/` (not the dataset itself).


## Keyboard shortcuts

- `Space`: play/pause
- `Left` / `Right`: previous/next frame
- `P` / `N`: previous/next scene
- `F`: fit view

## Repo layout

- Backend: `apps/server/`
- Frontend: `apps/web/` (vanilla HTML/CSS/JS; no build tools)
- Dataset config: `dataset/registry.json`

## Troubleshooting

- Empty dataset list / startup issue: verify `dataset/registry.json` exists and points to valid paths.
- Scene list loads but scene rendering fails: confirm the dataset folder exists and contains the expected files.
- Port already in use: run with a different `--port`.

