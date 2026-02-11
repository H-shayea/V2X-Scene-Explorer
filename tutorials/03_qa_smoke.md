# Tutorial 03: QA Smoke Snapshot

Date: 2026-02-11

This is a backend/API smoke snapshot run after recent V2X-Seq and trajectory-UI fixes.

## Scope

- Dataset discovery from `dataset/registry*.json`
- Scene listing by split/group
- Scene bundle loading (sample scenes)
- Track continuity stats (to validate trajectory rendering inputs)
- V2X-Seq TL-only scene toggle behavior (`include_tl_only`)

## Results

### V2X-Traj

- Train: `6062` scenes
- Val: `2020` scenes
- Availability per split: all four modalities present in all scenes (`ego`, `infra`, `vehicle`, `traffic_light`)
- Sample scene bundles loaded successfully; no warnings in sampled scenes

### Consider.it CPM Objects

- Split `all`: `529` scenes
- Availability: `infra` stream in all scenes
- Sample scene bundles loaded successfully; no warnings in sampled scenes
- Track continuity observed (sample scene had long-running tracks, max track length > 1000 frames)

### V2X-Seq (current local subset)

- Train (default filtering): `1` trajectory scene
  - Availability: `ego: 1`
- Val (default filtering): `5338` trajectory scenes
  - Availability: `infra: 5337`, `ego: 1`, `traffic_light: 5338`
- TL-only toggle checks:
  - Train: filtered=`1`, with TL-only=`39430`
  - Val: filtered=`5338`, with TL-only=`15771`

Interpretation:

- Current local V2X-Seq copy is highly imbalanced by split/content.
- The low train trajectory scene count is data-layout/content driven, not a loader bug.

## Notes

- Full trajectory rendering now receives valid multi-frame tracks in sampled datasets.
- Scene panel now exposes split-level modality availability for faster debugging and user clarity.
