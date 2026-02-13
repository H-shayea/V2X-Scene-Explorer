# V2X Scene Explorer

V2X Scene Explorer is a trajectory dataset explorer for V2X and traffic-scene research.
It provides scene browsing, synchronized playback, trajectory overlays, and HD map rendering (when available).

![V2X Scene Explorer hero](apps/web/hero.svg)

## Key features

- Local dataset loading (no dataset files committed to this repo)
- Scene browser with split/intersection filtering
- Playback controls with frame stepping and timeline scrub
- Agent filtering by stream, type, and subtype
- Map layers (lanelet/map geometry, stoplines, crosswalks, junctions)
- Desktop app (macOS) and browser-based web app

## Quick start

### Requirements

- Python 3.10+
- macOS only if you want the native desktop app

### Run web app (recommended for development)

```bash
./dev.sh web
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000)

Options:

```bash
HOST=127.0.0.1 PORT=9000 ./dev.sh web
```

### Run desktop app (macOS dev mode)

```bash
python3 -m pip install -r desktop/requirements-macos.txt
./dev.sh desktop
```

### Build desktop bundle

```bash
./dev.sh build
./dev.sh dmg
```

For release/signing/notarization, use [`RELEASING.md`](RELEASING.md).

## Connect a local dataset

Datasets are not bundled with this repository.
After downloading datasets locally:

1. Start the app.
2. Open **Connect Local Dataset**.
3. Select dataset type (or use auto-detect).
4. Select/paste dataset root path(s).
5. Click **Detect + Validate**, then **Save Connection**.

Connections are stored per user and can be updated without editing source code.

## Supported datasets

| Family | Splits | Scene model | Map support | Notes |
| --- | --- | --- | --- | --- |
| `v2x-traj` | `train`, `val` | dataset-native scenes | yes | includes precomputed scene index in repo |
| `v2x-seq` | `train`, `val` | intersection + clip scenes | yes | schema-driven loader; supports traffic-light-only toggle |
| `ind` | `all` | recording windows | yes (lanelet/scene background when available) | 60s windowing by default |
| `sind` | `all` | recording windows | yes (lanelet + orthophoto alignment) | city-specific background alignment controls |
| `cpm-objects` (Consider.it, private) | `all` | gap-aware windows per sensor log | no HD map (optional OSM basemap) | expects CPM CSV logs in `lidar` and/or `thermal_camera` |

## Dataset layout hints

Expected roots are documented in:

- [`tutorials/02_dataset_layouts.md`](tutorials/02_dataset_layouts.md)

Scene definition logic per dataset is documented in:

- [`tutorials/01_scenes.md`](tutorials/01_scenes.md)

## Keyboard shortcuts

- `Space`: play/pause
- `Left` / `Right`: previous/next frame
- `P` / `N`: previous/next scene
- `F`: fit view

## Documentation

- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Dataset scene model: [`tutorials/01_scenes.md`](tutorials/01_scenes.md)
- Dataset folder layouts: [`tutorials/02_dataset_layouts.md`](tutorials/02_dataset_layouts.md)
- QA smoke notes: [`tutorials/03_qa_smoke.md`](tutorials/03_qa_smoke.md)
- Desktop release process: [`RELEASING.md`](RELEASING.md)

## Troubleshooting

- Browser says local file access is unsupported:
  - Use Chrome, Edge, or Opera for web static mode (File System Access API required).
- Dataset loads but no scenes found:
  - Confirm you selected the dataset root, not a parent/child folder.
  - Check expected layout in [`tutorials/02_dataset_layouts.md`](tutorials/02_dataset_layouts.md).
- Works on localhost but not GitHub Pages:
  - GitHub Pages mode reads local files via browser APIs and requires compatible browser permissions.
- Port already in use:
  - Run with another port, e.g. `PORT=9000 ./dev.sh web`.

## License

MIT. See [`LICENSE`](LICENSE).
