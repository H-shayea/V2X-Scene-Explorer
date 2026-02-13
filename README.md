# V2X Scene Explorer

V2X Scene Explorer is an interactive viewer for V2X trajectory datasets, scenes, and map context.

Live app: [https://h-shayea.github.io/V2X-Scene-Explorer/](https://h-shayea.github.io/V2X-Scene-Explorer/)

![V2X Scene Explorer hero](apps/web/hero.svg)

## Features

- Scene browsing by split and intersection
- Frame-by-frame playback and timeline scrub
- Agent overlays with class filters
- Trajectory visualization (history/full tracks)
- Map rendering with lanelet and orthophoto modes
- Desktop app and web app support

## Supported datasets

- V2X-Traj
- V2X-Seq
- inD
- SinD
- Consider.it (CPM Objects)

## Usage

1. Open the live app.
2. Select a dataset.
3. Select split and intersection.
4. Choose a scene and start playback.
5. Use map source and layer controls to inspect alignment and context.

## Local development

Requirements:

- Python 3.10+

Run web app:

```bash
./dev.sh web
```

Run desktop app (macOS):

```bash
python3 -m pip install -r desktop/requirements-macos.txt
./dev.sh desktop
```

Build desktop app (macOS):

```bash
./dev.sh build
./dev.sh dmg
```

## Keyboard shortcuts

- `Space`: play/pause
- `Left` / `Right`: previous/next frame
- `P` / `N`: previous/next scene
- `F`: fit view

## License

MIT. See [`LICENSE`](LICENSE).
