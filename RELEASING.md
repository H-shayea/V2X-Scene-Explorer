# V2X Scene Explorer Release Guide (macOS)

This guide is for publishing a new desktop build when you fix or update the app.

## 1) Bump version

1. Open `/Users/shayea/Documents/Projects/Traj/apps/app_meta.py`.
2. Update `APP_VERSION` to the new version (example: `0.2.1`).
3. Commit and push your code changes to the app branch.

## 2) Build app + DMG

Run from the project root:

```bash
./desktop/build_macos_app.sh
./desktop/build_macos_dmg.sh
```

Output:

- App bundle: `/Users/shayea/Documents/Projects/Traj/dist/V2X Scene Explorer.app`
- DMG: `/Users/shayea/Documents/Projects/Traj/dist/V2X Scene Explorer.dmg`

## 3) Quick local test

1. Open the DMG.
2. Drag `V2X Scene Explorer.app` to `Applications`.
3. Launch it and verify scenes, tracks, and map render correctly.
4. If updating an existing install, choose **Replace**.

## 4) Create tag and push it

```bash
git tag v0.2.1
git push origin v0.2.1
```

Use the same version number as `APP_VERSION`.

## 5) Publish GitHub release

1. Open GitHub repo `Releases` -> `Draft a new release`.
2. Select the new tag (example: `v0.2.1`).
3. Title example: `V2X Scene Explorer v0.2.1`.
4. Add short release notes (fixes + improvements).
5. Upload asset: `V2X Scene Explorer.dmg`.
6. Click `Publish release`.

Important:

- In-app update detection checks the latest GitHub release and looks for a `.dmg` asset.
- If you want all users to receive this update, do not keep it as testers-only pre-release.

## 6) How users install/update

1. Open the GitHub release page.
2. Download `V2X Scene Explorer.dmg` from `Assets`.
3. Open DMG and move app to `Applications`.
4. If already installed, replace the old app with the new one.

## 7) Optional: signed/notarized release (Apple Developer account required)

If you later get Apple Developer credentials:

```bash
./desktop/sign_macos_app.sh
./desktop/build_macos_dmg.sh
./desktop/notarize_macos_dmg.sh
```

Then upload the notarized DMG to the release.
