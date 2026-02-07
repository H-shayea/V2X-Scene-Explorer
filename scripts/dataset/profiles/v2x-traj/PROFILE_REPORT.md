# Dataset Profile Report (Phase A)

- Generated at: `2026-02-05T17:06:24+01:00`
- Dataset root: `../dataset/v2x-traj`
- Scan level: `geometry`
- Total size (bytes): `11272550501` (10.5 GB)

## Notes

- Found extra map_files directory: v2x-traj/map_files
-   - yizhuang_PEK_halluc_bbox_table.npy (1.8 MB)
-   - yizhuang_PEK_tableidx_to_laneid_map.json (1.4 MB)
-   - yizhuang_PEK_vector_map.json (88.4 MB)

## CSV Tables

### `ego-trajectories/train/data`

- Path: `ego-trajectories/train/data`
- Files: `6062`
- Total rows: `14668456`

Columns (union):

```text
city
height
id
intersect_id
length
sub_type
tag
theta
timestamp
type
v_x
v_y
width
x
y
z
```

- Rows/file: n=6062, min=884.0, p50=2143.0, p95=4041.0, max=6109.0
- Unique timestamps/file: n=6062, min=80.0, p50=80.0, p95=80.0, max=80.0
- Duration/file (s): n=6062, min=7.8999998569488525s, p50=7.900000095367432s, p95=7.900000095367432s, max=7.900000095367432s
- Unique agents/file: n=6062, min=20.0, p50=79.0, p95=154.0, max=288.0

Numeric ranges:

| column | min | max | missing | parse_error |
|---|---:|---:|---:|---:|
| timestamp | 1.63419e+09 | 1.66851e+09 | 0 | 0 |
| x | 416425 | 419358 | 0 | 0 |
| y | 4.73009e+06 | 4.73262e+06 | 0 | 0 |
| theta | -3.14159 | 3.14157 | 484960 | 0 |
| v_x | -32.1258 | 30.7658 | 484960 | 0 |
| v_y | -27.4219 | 24.693 | 484960 | 0 |

Categorical values (capped to 200 unique values per column):

- `city`: ['PEK']
- `intersect_id`: ['yizhuang#11-1_po', 'yizhuang#12-1_po', 'yizhuang#13-1_po', 'yizhuang#14-1_po', 'yizhuang#20-1_po', 'yizhuang#25-1_po', 'yizhuang#4-1_po', 'yizhuang#7-1_po']
- `type`: ['BICYCLE', 'PEDESTRIAN', 'VEHICLE']
- `sub_type`: ['BUS', 'CAR', 'CYCLIST', 'MOTORCYCLIST', 'PEDESTRIAN', 'TRICYCLIST', 'TRUCK', 'UNKNOWN', 'VAN']
- `tag`: ['AV', 'OTHERS', 'TARGET_AGENT']

Top timestamp deltas (rounded to 0.001):

- dt=0.1s: 478898

### `ego-trajectories/val/data`

- Path: `ego-trajectories/val/data`
- Files: `2020`
- Total rows: `4809618`

Columns (union):

```text
city
height
id
intersect_id
length
sub_type
tag
theta
timestamp
type
v_x
v_y
width
x
y
z
```

- Rows/file: n=2020, min=893.0, p50=2117.5, p95=3945.2, max=5947.0
- Unique timestamps/file: n=2020, min=80.0, p50=80.0, p95=80.0, max=80.0
- Duration/file (s): n=2020, min=7.8999998569488525s, p50=7.900000095367432s, p95=7.900000095367432s, max=7.900000095367432s
- Unique agents/file: n=2020, min=20.0, p50=76.0, p95=148.0, max=288.0

Numeric ranges:

| column | min | max | missing | parse_error |
|---|---:|---:|---:|---:|
| timestamp | 1.63419e+09 | 1.66851e+09 | 0 | 0 |
| x | 416425 | 419358 | 0 | 0 |
| y | 4.7301e+06 | 4.73258e+06 | 0 | 0 |
| theta | -3.14159 | 3.14157 | 161600 | 0 |
| v_x | -32.1258 | 30.7658 | 161600 | 0 |
| v_y | -27.4219 | 24.693 | 161600 | 0 |

Categorical values (capped to 200 unique values per column):

- `city`: ['PEK']
- `intersect_id`: ['yizhuang#11-1_po', 'yizhuang#12-1_po', 'yizhuang#13-1_po', 'yizhuang#14-1_po', 'yizhuang#20-1_po', 'yizhuang#25-1_po', 'yizhuang#4-1_po', 'yizhuang#7-1_po']
- `type`: ['BICYCLE', 'PEDESTRIAN', 'VEHICLE']
- `sub_type`: ['BUS', 'CAR', 'CYCLIST', 'MOTORCYCLIST', 'PEDESTRIAN', 'TRICYCLIST', 'TRUCK', 'UNKNOWN', 'VAN']
- `tag`: ['AV', 'OTHERS', 'TARGET_AGENT']

Top timestamp deltas (rounded to 0.001):

- dt=0.1s: 159580

### `infrastructure-trajectories/train/data`

- Path: `infrastructure-trajectories/train/data`
- Files: `6062`
- Total rows: `10574902`

Columns (union):

```text
city
height
id
intersect_id
length
sub_type
tag
theta
timestamp
type
v_x
v_y
width
x
y
z
```

- Rows/file: n=6062, min=476.0, p50=1456.0, p95=3398.0, max=3995.0
- Unique timestamps/file: n=6062, min=57.0, p50=79.0, p95=80.0, max=80.0
- Duration/file (s): n=6062, min=6.799999952316284s, p50=7.900000095367432s, p95=7.900000095367432s, max=7.900000095367432s
- Unique agents/file: n=6062, min=14.0, p50=35.0, p95=73.0, max=105.0

Numeric ranges:

| column | min | max | missing | parse_error |
|---|---:|---:|---:|---:|
| timestamp | 1.63419e+09 | 1.66851e+09 | 0 | 0 |
| x | 416487 | 419161 | 0 | 0 |
| y | 4.73018e+06 | 4.73248e+06 | 0 | 0 |
| theta | -3.14145 | 3.14121 | 0 | 0 |
| v_x | -52.0739 | 58.2309 | 0 | 0 |
| v_y | -34.3512 | 32.2933 | 0 | 0 |

Categorical values (capped to 200 unique values per column):

- `city`: ['PEK']
- `intersect_id`: ['yizhuang#11-1_po', 'yizhuang#12-1_po', 'yizhuang#13-1_po', 'yizhuang#14-1_po', 'yizhuang#20-1_po', 'yizhuang#25-1_po', 'yizhuang#4-1_po', 'yizhuang#7-1_po']
- `type`: ['BICYCLE', 'PEDESTRIAN', 'VEHICLE']
- `sub_type`: ['BUS', 'CAR', 'CYCLIST', 'MOTORCYCLIST', 'PEDESTRIAN', 'TRICYCLIST', 'TRUCK', 'VAN']
- `tag`: ['OTHERS']

Top timestamp deltas (rounded to 0.001):

- dt=0.1s: 460008
- dt=0.2s: 7605
- dt=0.3s: 532
- dt=0.5s: 54
- dt=0.4s: 52
- dt=1.2s: 33
- dt=1.3s: 33
- dt=0.8s: 26
- dt=0.7s: 22

### `infrastructure-trajectories/val/data`

- Path: `infrastructure-trajectories/val/data`
- Files: `2020`
- Total rows: `3455005`

Columns (union):

```text
city
height
id
intersect_id
length
sub_type
tag
theta
timestamp
type
v_x
v_y
width
x
y
z
```

- Rows/file: n=2020, min=511.0, p50=1391.5, p95=3327.2, max=3995.0
- Unique timestamps/file: n=2020, min=58.0, p50=80.0, p95=80.0, max=80.0
- Duration/file (s): n=2020, min=6.799999952316284s, p50=7.900000095367432s, p95=7.900000095367432s, max=7.900000095367432s
- Unique agents/file: n=2020, min=14.0, p50=34.0, p95=72.0, max=105.0

Numeric ranges:

| column | min | max | missing | parse_error |
|---|---:|---:|---:|---:|
| timestamp | 1.63419e+09 | 1.66851e+09 | 0 | 0 |
| x | 416487 | 419161 | 0 | 0 |
| y | 4.73018e+06 | 4.73248e+06 | 0 | 0 |
| theta | -3.14145 | 3.14121 | 0 | 0 |
| v_x | -52.0739 | 58.2309 | 0 | 0 |
| v_y | -34.3512 | 32.2933 | 0 | 0 |

Categorical values (capped to 200 unique values per column):

- `city`: ['PEK']
- `intersect_id`: ['yizhuang#11-1_po', 'yizhuang#12-1_po', 'yizhuang#13-1_po', 'yizhuang#14-1_po', 'yizhuang#20-1_po', 'yizhuang#25-1_po', 'yizhuang#4-1_po', 'yizhuang#7-1_po']
- `type`: ['BICYCLE', 'PEDESTRIAN', 'VEHICLE']
- `sub_type`: ['BUS', 'CAR', 'CYCLIST', 'MOTORCYCLIST', 'PEDESTRIAN', 'TRICYCLIST', 'TRUCK', 'VAN']
- `tag`: ['OTHERS']

Top timestamp deltas (rounded to 0.001):

- dt=0.1s: 153762
- dt=0.2s: 2383
- dt=0.3s: 171
- dt=0.4s: 19
- dt=0.5s: 17
- dt=1.3s: 10
- dt=1.2s: 6
- dt=0.8s: 5
- dt=0.7s: 3

### `vehicle-trajectories/train/data`

- Path: `vehicle-trajectories/train/data`
- Files: `6062`
- Total rows: `13809207`

Columns (union):

```text
city
height
id
intersect_id
length
sub_type
tag
theta
timestamp
type
v_x
v_y
width
x
y
z
```

- Rows/file: n=6062, min=202.0, p50=2011.5, p95=3901.95, max=6029.0
- Unique timestamps/file: n=6062, min=4.0, p50=80.0, p95=80.0, max=80.0
- Duration/file (s): n=6062, min=0.2999999523162842s, p50=7.900000095367432s, p95=7.900000095367432s, max=7.900000095367432s
- Unique agents/file: n=6062, min=19.0, p50=74.0, p95=148.0, max=293.0

Numeric ranges:

| column | min | max | missing | parse_error |
|---|---:|---:|---:|---:|
| timestamp | 1.63419e+09 | 1.66851e+09 | 0 | 0 |
| x | 416425 | 419372 | 0 | 0 |
| y | 4.73009e+06 | 4.73263e+06 | 0 | 0 |
| theta | -3.14159 | 3.14157 | 0 | 0 |
| v_x | -32.1258 | 30.7658 | 0 | 0 |
| v_y | -27.4219 | 24.693 | 0 | 0 |

Categorical values (capped to 200 unique values per column):

- `city`: ['PEK']
- `intersect_id`: ['yizhuang#11-1_po', 'yizhuang#12-1_po', 'yizhuang#13-1_po', 'yizhuang#14-1_po', 'yizhuang#20-1_po', 'yizhuang#25-1_po', 'yizhuang#4-1_po', 'yizhuang#7-1_po']
- `type`: ['BICYCLE', 'PEDESTRIAN', 'VEHICLE']
- `sub_type`: ['BUS', 'CAR', 'CYCLIST', 'MOTORCYCLIST', 'PEDESTRIAN', 'TRICYCLIST', 'TRUCK', 'UNKNOWN', 'VAN']
- `tag`: ['OTHERS']

Top timestamp deltas (rounded to 0.001):

- dt=0.1s: 477490
- dt=0.4s: 110
- dt=0.3s: 47
- dt=0.5s: 4

### `vehicle-trajectories/val/data`

- Path: `vehicle-trajectories/val/data`
- Files: `2020`
- Total rows: `4547375`

Columns (union):

```text
city
height
id
intersect_id
length
sub_type
tag
theta
timestamp
type
v_x
v_y
width
x
y
z
```

- Rows/file: n=2020, min=809.0, p50=1984.0, p95=3829.3499999999995, max=5867.0
- Unique timestamps/file: n=2020, min=20.0, p50=80.0, p95=80.0, max=80.0
- Duration/file (s): n=2020, min=1.8999998569488525s, p50=7.900000095367432s, p95=7.900000095367432s, max=7.900000095367432s
- Unique agents/file: n=2020, min=19.0, p50=75.0, p95=147.0, max=289.0

Numeric ranges:

| column | min | max | missing | parse_error |
|---|---:|---:|---:|---:|
| timestamp | 1.63419e+09 | 1.66851e+09 | 0 | 0 |
| x | 416425 | 419372 | 0 | 0 |
| y | 4.73009e+06 | 4.73263e+06 | 0 | 0 |
| theta | -3.14159 | 3.14157 | 0 | 0 |
| v_x | -32.1258 | 30.7658 | 0 | 0 |
| v_y | -27.4219 | 24.693 | 0 | 0 |

Categorical values (capped to 200 unique values per column):

- `city`: ['PEK']
- `intersect_id`: ['yizhuang#11-1_po', 'yizhuang#12-1_po', 'yizhuang#13-1_po', 'yizhuang#14-1_po', 'yizhuang#20-1_po', 'yizhuang#25-1_po', 'yizhuang#4-1_po', 'yizhuang#7-1_po']
- `type`: ['BICYCLE', 'PEDESTRIAN', 'VEHICLE']
- `sub_type`: ['BUS', 'CAR', 'CYCLIST', 'MOTORCYCLIST', 'PEDESTRIAN', 'TRICYCLIST', 'TRUCK', 'UNKNOWN', 'VAN']
- `tag`: ['OTHERS']

Top timestamp deltas (rounded to 0.001):

- dt=0.1s: 159233
- dt=0.4s: 38
- dt=0.3s: 19
- dt=0.5s: 3

### `traffic-light/train/data`

- Path: `traffic-light/train/data`
- Files: `6062`
- Total rows: `2731895`

Columns (union):

```text
city
color_1
color_2
color_3
direction
intersect_id
lane_id
remain_1
remain_2
remain_3
timestamp
x
y
```

- Rows/file: n=6062, min=0.0, p50=456.0, p95=632.0, max=640.0
- Unique timestamps/file: n=5791, min=1.0, p50=75.0, p95=80.0, max=80.0
- Duration/file (s): n=5791, min=0.0s, p50=7.8999998569488525s, p95=7.900000095367432s, max=7.900000095367432s

Numeric ranges:

| column | min | max | missing | parse_error |
|---|---:|---:|---:|---:|
| timestamp | 1.63419e+09 | 1.66851e+09 | 0 | 0 |
| x | 416535 | 419049 | 0 | 0 |
| y | 4.73025e+06 | 4.73239e+06 | 0 | 0 |
| remain_1 | 0 | 144 | 0 | 0 |
| remain_2 | 4 | 144 | 0 | 0 |
| remain_3 | 4 | 144 | 0 | 0 |

Categorical values (capped to 200 unique values per column):

- `city`: ['PEK']
- `intersect_id`: ['yizhuang#11-1_po', 'yizhuang#12-1_po', 'yizhuang#13-1_po', 'yizhuang#14-1_po', 'yizhuang#20-1_po', 'yizhuang#25-1_po', 'yizhuang#4-1_po', 'yizhuang#7-1_po']
- `direction`: ['EAST', 'NORTH', 'SOUTH', 'WEST']
- `color_1`: ['GREEN', 'RED', 'YELLOW']
- `color_2`: ['GREEN', 'RED', 'YELLOW']
- `color_3`: ['GREEN', 'RED', 'YELLOW']

Top timestamp deltas (rounded to 0.001):

- dt=0.1s: 384310
- dt=0.2s: 29312
- dt=0.3s: 1161
- dt=0.4s: 132
- dt=0.5s: 78
- dt=0.9s: 59
- dt=0.6s: 26
- dt=0.8s: 20
- dt=2.5s: 17
- dt=4.7s: 11

Traffic-light lane_id validation:

- lane_id checked: 37814
- lane_id missing in map: 954

### `traffic-light/val/data`

- Path: `traffic-light/val/data`
- Files: `2020`
- Total rows: `923686`

Columns (union):

```text
city
color_1
color_2
color_3
direction
intersect_id
lane_id
remain_1
remain_2
remain_3
timestamp
x
y
```

- Rows/file: n=2020, min=0.0, p50=462.0, p95=632.0, max=640.0
- Unique timestamps/file: n=1941, min=1.0, p50=75.0, p95=80.0, max=80.0
- Duration/file (s): n=1941, min=0.0s, p50=7.8999998569488525s, p95=7.900000095367432s, max=7.900000095367432s

Numeric ranges:

| column | min | max | missing | parse_error |
|---|---:|---:|---:|---:|
| timestamp | 1.63419e+09 | 1.66851e+09 | 0 | 0 |
| x | 416535 | 419049 | 0 | 0 |
| y | 4.73025e+06 | 4.73239e+06 | 0 | 0 |
| remain_1 | 0 | 144 | 0 | 0 |
| remain_2 | 4 | 144 | 0 | 0 |
| remain_3 | 4 | 144 | 0 | 0 |

Categorical values (capped to 200 unique values per column):

- `city`: ['PEK']
- `intersect_id`: ['yizhuang#11-1_po', 'yizhuang#12-1_po', 'yizhuang#13-1_po', 'yizhuang#14-1_po', 'yizhuang#20-1_po', 'yizhuang#25-1_po', 'yizhuang#4-1_po', 'yizhuang#7-1_po']
- `direction`: ['EAST', 'NORTH', 'SOUTH', 'WEST']
- `color_1`: ['GREEN', 'RED', 'YELLOW']
- `color_2`: ['GREEN', 'RED', 'YELLOW']
- `color_3`: ['GREEN', 'RED', 'YELLOW']

Top timestamp deltas (rounded to 0.001):

- dt=0.1s: 129237
- dt=0.2s: 10007
- dt=0.3s: 343
- dt=0.4s: 34
- dt=0.5s: 30
- dt=0.6s: 11
- dt=0.8s: 11
- dt=0.9s: 9
- dt=5.2s: 5
- dt=2.5s: 4

Traffic-light lane_id validation:

- lane_id checked: 12716
- lane_id missing in map: 260

## Maps

- Map files: `28`

### `yizhuang_hdmap1.json`

- map_id: `1`
- entity counts: LANE=24827, STOPLINE=9, CROSSWALK=955, JUNCTION=969
- bbox (sampled): x=[415035.64, 419110.92], y=[4729628.80, 4733689.59]

### `yizhuang_hdmap10.json`

- map_id: `10`
- entity counts: LANE=16655, STOPLINE=0, CROSSWALK=546, JUNCTION=562
- bbox (sampled): x=[417768.98, 421800.02], y=[4730702.21, 4734570.61]

### `yizhuang_hdmap11.json`

- map_id: `11`
- entity counts: LANE=22331, STOPLINE=10, CROSSWALK=785, JUNCTION=868
- bbox (sampled): x=[415853.90, 420054.41], y=[4728210.31, 4732276.11]

### `yizhuang_hdmap12.json`

- map_id: `12`
- entity counts: LANE=22777, STOPLINE=11, CROSSWALK=835, JUNCTION=876
- bbox (sampled): x=[415557.22, 419782.40], y=[4728583.36, 4732639.44]

### `yizhuang_hdmap13.json`

- map_id: `13`
- entity counts: LANE=24392, STOPLINE=10, CROSSWALK=912, JUNCTION=934
- bbox (sampled): x=[415404.79, 419699.35], y=[4728937.37, 4732975.31]

### `yizhuang_hdmap14.json`

- map_id: `14`
- entity counts: LANE=23463, STOPLINE=6, CROSSWALK=910, JUNCTION=921
- bbox (sampled): x=[414768.48, 418886.43], y=[4729999.33, 4734011.77]

### `yizhuang_hdmap15.json`

- map_id: `15`
- entity counts: LANE=21643, STOPLINE=1, CROSSWALK=829, JUNCTION=853
- bbox (sampled): x=[414448.61, 418693.31], y=[4730354.53, 4734085.19]

### `yizhuang_hdmap16.json`

- map_id: `16`
- entity counts: LANE=18610, STOPLINE=1, CROSSWALK=707, JUNCTION=767
- bbox (sampled): x=[414300.20, 418455.35], y=[4730600.63, 4734769.95]

### `yizhuang_hdmap17.json`

- map_id: `17`
- entity counts: LANE=15041, STOPLINE=1, CROSSWALK=596, JUNCTION=650
- bbox (sampled): x=[414118.11, 418142.16], y=[4731086.21, 4734848.51]

### `yizhuang_hdmap18.json`

- map_id: `18`
- entity counts: LANE=22064, STOPLINE=10, CROSSWALK=779, JUNCTION=839
- bbox (sampled): x=[416156.03, 420178.56], y=[4728322.02, 4732462.04]

### `yizhuang_hdmap19.json`

- map_id: `19`
- entity counts: LANE=23911, STOPLINE=11, CROSSWALK=861, JUNCTION=886
- bbox (sampled): x=[415903.72, 420054.41], y=[4728583.36, 4732782.32]

### `yizhuang_hdmap2.json`

- map_id: `2`
- entity counts: LANE=24384, STOPLINE=9, CROSSWALK=927, JUNCTION=915
- bbox (sampled): x=[415259.91, 419281.14], y=[4729293.56, 4733291.32]

### `yizhuang_hdmap20.json`

- map_id: `20`
- entity counts: LANE=24996, STOPLINE=10, CROSSWALK=913, JUNCTION=934
- bbox (sampled): x=[415733.60, 419850.78], y=[4729098.18, 4733137.55]

### `yizhuang_hdmap21.json`

- map_id: `21`
- entity counts: LANE=14529, STOPLINE=0, CROSSWALK=470, JUNCTION=489
- bbox (sampled): x=[418115.92, 422150.58], y=[4730952.06, 4734570.61]

### `yizhuang_hdmap22.json`

- map_id: `22`
- entity counts: LANE=25259, STOPLINE=9, CROSSWALK=971, JUNCTION=996
- bbox (sampled): x=[414657.99, 418724.37], y=[4729366.30, 4733689.59]

### `yizhuang_hdmap23.json`

- map_id: `23`
- entity counts: LANE=17145, STOPLINE=0, CROSSWALK=560, JUNCTION=725
- bbox (sampled): x=[413740.51, 417863.68], y=[4728330.18, 4732431.25]

### `yizhuang_hdmap24.json`

- map_id: `24`
- entity counts: LANE=20512, STOPLINE=8, CROSSWALK=726, JUNCTION=848
- bbox (sampled): x=[414165.40, 418187.49], y=[4728478.26, 4732676.09]

### `yizhuang_hdmap25.json`

- map_id: `25`
- entity counts: LANE=23731, STOPLINE=9, CROSSWALK=862, JUNCTION=916
- bbox (sampled): x=[414526.83, 418560.07], y=[4728793.81, 4732854.15]

### `yizhuang_hdmap26.json`

- map_id: `26`
- entity counts: LANE=14259, STOPLINE=0, CROSSWALK=465, JUNCTION=622
- bbox (sampled): x=[413550.86, 417560.95], y=[4728205.89, 4732212.34]

### `yizhuang_hdmap27.json`

- map_id: `27`
- entity counts: LANE=12663, STOPLINE=0, CROSSWALK=386, JUNCTION=526
- bbox (sampled): x=[413194.03, 417080.51], y=[4727861.61, 4731966.64]

### `yizhuang_hdmap28.json`

- map_id: `28`
- entity counts: LANE=25894, STOPLINE=10, CROSSWALK=957, JUNCTION=930
- bbox (sampled): x=[415909.13, 420131.03], y=[4729312.29, 4733362.31]

### `yizhuang_hdmap3.json`

- map_id: `3`
- entity counts: LANE=25677, STOPLINE=9, CROSSWALK=963, JUNCTION=931
- bbox (sampled): x=[415527.78, 419657.42], y=[4729406.70, 4733461.20]

### `yizhuang_hdmap4.json`

- map_id: `4`
- entity counts: LANE=26849, STOPLINE=9, CROSSWALK=1015, JUNCTION=961
- bbox (sampled): x=[415833.20, 419881.41], y=[4729625.39, 4733778.92]

### `yizhuang_hdmap5.json`

- map_id: `5`
- entity counts: LANE=28370, STOPLINE=9, CROSSWALK=1066, JUNCTION=985
- bbox (sampled): x=[416215.80, 420283.86], y=[4729857.46, 4733927.48]

### `yizhuang_hdmap6.json`

- map_id: `6`
- entity counts: LANE=27782, STOPLINE=9, CROSSWALK=1035, JUNCTION=964
- bbox (sampled): x=[416498.83, 420669.35], y=[4729986.22, 4734069.38]

### `yizhuang_hdmap7.json`

- map_id: `7`
- entity counts: LANE=23489, STOPLINE=4, CROSSWALK=838, JUNCTION=805
- bbox (sampled): x=[417001.39, 421120.34], y=[4730220.92, 4734390.33]

### `yizhuang_hdmap8.json`

- map_id: `8`
- entity counts: LANE=21121, STOPLINE=0, CROSSWALK=725, JUNCTION=705
- bbox (sampled): x=[417260.90, 421235.71], y=[4730220.92, 4734570.61]

### `yizhuang_hdmap9.json`

- map_id: `9`
- entity counts: LANE=18771, STOPLINE=0, CROSSWALK=631, JUNCTION=629
- bbox (sampled): x=[417518.29, 421514.99], y=[4730631.48, 4734570.61]

## Cross-Table Alignment

- family: `v2x-traj`

### Overall (all tables)

- table_count: `8`
- scene_union_count: `8082`
- scene_intersection_count: `0`
- intersect_id_mismatch_count: `0`
- min_ts_mismatch_count: `0`
- max_ts_mismatch_count: `0`
- empty_files_by_table: `{'ego-trajectories/train/data': 0, 'ego-trajectories/val/data': 0, 'infrastructure-trajectories/train/data': 0, 'infrastructure-trajectories/val/data': 0, 'vehicle-trajectories/train/data': 0, 'vehicle-trajectories/val/data': 0, 'traffic-light/train/data': 271, 'traffic-light/val/data': 79}`
- multi_intersect_id_files_by_table: `{'ego-trajectories/train/data': 0, 'ego-trajectories/val/data': 0, 'infrastructure-trajectories/train/data': 0, 'infrastructure-trajectories/val/data': 0, 'vehicle-trajectories/train/data': 0, 'vehicle-trajectories/val/data': 0, 'traffic-light/train/data': 0, 'traffic-light/val/data': 0}`
- missing_scenes_by_table: `{'ego-trajectories/train/data': 2020, 'ego-trajectories/val/data': 6062, 'infrastructure-trajectories/train/data': 2020, 'infrastructure-trajectories/val/data': 6062, 'vehicle-trajectories/train/data': 2020, 'vehicle-trajectories/val/data': 6062, 'traffic-light/train/data': 2020, 'traffic-light/val/data': 6062}`

### Split: train

- table_count: `4`
- scene_union_count: `6062`
- scene_intersection_count: `6062`
- intersect_id_mismatch_count: `0`
- min_ts_mismatch_count: `615`
- max_ts_mismatch_count: `679`
- empty_files_by_table: `{'ego-trajectories/train/data': 0, 'infrastructure-trajectories/train/data': 0, 'vehicle-trajectories/train/data': 0, 'traffic-light/train/data': 271}`
- multi_intersect_id_files_by_table: `{'ego-trajectories/train/data': 0, 'infrastructure-trajectories/train/data': 0, 'vehicle-trajectories/train/data': 0, 'traffic-light/train/data': 0}`
- missing_scenes_by_table: `{'ego-trajectories/train/data': 0, 'infrastructure-trajectories/train/data': 0, 'vehicle-trajectories/train/data': 0, 'traffic-light/train/data': 0}`

Samples:

```json
[
  {
    "scene_id": "10000",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1651996653.4,
      "infrastructure-trajectories/train/data": 1651996653.4,
      "vehicle-trajectories/train/data": 1651996653.4,
      "traffic-light/train/data": 1651996653.3
    }
  },
  {
    "scene_id": "10004",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484570.7,
      "infrastructure-trajectories/train/data": 1663484570.7,
      "vehicle-trajectories/train/data": 1663484570.7,
      "traffic-light/train/data": 1663484570.6
    }
  },
  {
    "scene_id": "10008",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484572.3,
      "infrastructure-trajectories/train/data": 1663484572.3,
      "vehicle-trajectories/train/data": 1663484572.3,
      "traffic-light/train/data": 1663484572.2
    }
  },
  {
    "scene_id": "10012",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484573.9,
      "infrastructure-trajectories/train/data": 1663484573.9,
      "vehicle-trajectories/train/data": 1663484573.9,
      "traffic-light/train/data": 1663484573.8
    }
  },
  {
    "scene_id": "10013",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484574.3,
      "infrastructure-trajectories/train/data": 1663484574.3,
      "vehicle-trajectories/train/data": 1663484574.3,
      "traffic-light/train/data": 1663484574.2
    }
  },
  {
    "scene_id": "10021",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484580.0,
      "infrastructure-trajectories/train/data": 1663484580.0,
      "vehicle-trajectories/train/data": 1663484580.0,
      "traffic-light/train/data": 1663484580.1
    }
  },
  {
    "scene_id": "10023",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484588.7,
      "infrastructure-trajectories/train/data": 1663484588.7,
      "vehicle-trajectories/train/data": 1663484588.7,
      "traffic-light/train/data": 1663484588.6
    }
  },
  {
    "scene_id": "10025",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484581.6,
      "infrastructure-trajectories/train/data": 1663484581.6,
      "vehicle-trajectories/train/data": 1663484581.6,
      "traffic-light/train/data": 1663484581.7
    }
  },
  {
    "scene_id": "10028",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484590.7,
      "infrastructure-trajectories/train/data": 1663484590.7,
      "vehicle-trajectories/train/data": 1663484590.7,
      "traffic-light/train/data": 1663484590.6
    }
  },
  {
    "scene_id": "10031",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484591.9,
      "infrastructure-trajectories/train/data": 1663484591.9,
      "vehicle-trajectories/train/data": 1663484591.9,
      "traffic-light/train/data": 1663484591.8
    }
  },
  {
    "scene_id": "10032",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484592.3,
      "infrastructure-trajectories/train/data": 1663484592.3,
      "vehicle-trajectories/train/data": 1663484592.3,
      "traffic-light/train/data": 1663484592.2
    }
  },
  {
    "scene_id": "10036",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484593.9,
      "infrastructure-trajectories/train/data": 1663484593.9,
      "vehicle-trajectories/train/data": 1663484593.9,
      "traffic-light/train/data": 1663484593.8
    }
  },
  {
    "scene_id": "10050",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484591.6,
      "infrastructure-trajectories/train/data": 1663484591.6,
      "vehicle-trajectories/train/data": 1663484591.6,
      "traffic-light/train/data": 1663484591.7
    }
  },
  {
    "scene_id": "10083",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484612.7,
      "infrastructure-trajectories/train/data": 1663484612.7,
      "vehicle-trajectories/train/data": 1663484612.7,
      "traffic-light/train/data": 1663484612.6
    }
  },
  {
    "scene_id": "10097",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1663484618.3,
      "infrastructure-trajectories/train/data": 1663484618.3,
      "vehicle-trajectories/train/data": 1663484618.3,
      "traffic-light/train/data": 1663484618.2
    }
  },
  {
    "scene_id": "1011",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1652501872.9,
      "infrastructure-trajectories/train/data": 1652501872.9,
      "vehicle-trajectories/train/data": 1652501872.9,
      "traffic-light/train/data": 1652501872.8
    }
  },
  {
    "scene_id": "1016",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1668411044.8,
      "infrastructure-trajectories/train/data": 1668411044.6,
      "vehicle-trajectories/train/data": 1668411044.8,
      "traffic-light/train/data": 1668411044.7
    }
  },
  {
    "scene_id": "1017",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1668411045.2,
      "infrastructure-trajectories/train/data": 1668411045.0,
      "vehicle-trajectories/train/data": 1668411045.2,
      "traffic-light/train/data": 1668411044.7
    }
  },
  {
    "scene_id": "1018",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1668411037.7,
      "infrastructure-trajectories/train/data": 1668411037.7,
      "vehicle-trajectories/train/data": 1668411037.7,
      "traffic-light/train/data": 1668411037.8
    }
  },
  {
    "scene_id": "1022",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/train/data": 1668411047.2,
      "infrastructure-trajectories/train/data": 1668411047.2,
      "vehicle-trajectories/train/data": 1668411047.2,
      "traffic-light/train/data": 1668411047.1
    }
  }
]
```

### Split: val

- table_count: `4`
- scene_union_count: `2020`
- scene_intersection_count: `2020`
- intersect_id_mismatch_count: `0`
- min_ts_mismatch_count: `211`
- max_ts_mismatch_count: `200`
- empty_files_by_table: `{'ego-trajectories/val/data': 0, 'infrastructure-trajectories/val/data': 0, 'vehicle-trajectories/val/data': 0, 'traffic-light/val/data': 79}`
- multi_intersect_id_files_by_table: `{'ego-trajectories/val/data': 0, 'infrastructure-trajectories/val/data': 0, 'vehicle-trajectories/val/data': 0, 'traffic-light/val/data': 0}`
- missing_scenes_by_table: `{'ego-trajectories/val/data': 0, 'infrastructure-trajectories/val/data': 0, 'vehicle-trajectories/val/data': 0, 'traffic-light/val/data': 0}`

Samples:

```json
[
  {
    "scene_id": "10003",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1663484570.3,
      "infrastructure-trajectories/val/data": 1663484570.3,
      "vehicle-trajectories/val/data": 1663484570.3,
      "traffic-light/val/data": 1663484570.2
    }
  },
  {
    "scene_id": "1001",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1652501868.9,
      "infrastructure-trajectories/val/data": 1652501868.9,
      "vehicle-trajectories/val/data": 1652501868.9,
      "traffic-light/val/data": 1652501868.8
    }
  },
  {
    "scene_id": "10035",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1663484593.5,
      "infrastructure-trajectories/val/data": 1663484593.5,
      "vehicle-trajectories/val/data": 1663484593.5,
      "traffic-light/val/data": 1663484593.4
    }
  },
  {
    "scene_id": "1015",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411044.4,
      "infrastructure-trajectories/val/data": 1668411043.8,
      "vehicle-trajectories/val/data": 1668411044.4,
      "traffic-light/val/data": 1668411044.2
    }
  },
  {
    "scene_id": "1020",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411038.5,
      "infrastructure-trajectories/val/data": 1668411038.5,
      "vehicle-trajectories/val/data": 1668411038.5,
      "traffic-light/val/data": 1668411038.6
    }
  },
  {
    "scene_id": "1020",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411046.4,
      "infrastructure-trajectories/val/data": 1668411046.4,
      "vehicle-trajectories/val/data": 1668411046.4,
      "traffic-light/val/data": 1668411046.2
    }
  },
  {
    "scene_id": "1038",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411045.7,
      "infrastructure-trajectories/val/data": 1668411045.8,
      "vehicle-trajectories/val/data": 1668411045.7,
      "traffic-light/val/data": 1668411045.8
    }
  },
  {
    "scene_id": "1038",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411053.6,
      "infrastructure-trajectories/val/data": 1668411053.5,
      "vehicle-trajectories/val/data": 1668411053.6,
      "traffic-light/val/data": 1668411053.6
    }
  },
  {
    "scene_id": "1042",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411055.2,
      "infrastructure-trajectories/val/data": 1668411055.2,
      "vehicle-trajectories/val/data": 1668411055.2,
      "traffic-light/val/data": 1668411055.1
    }
  },
  {
    "scene_id": "1047",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411049.3,
      "infrastructure-trajectories/val/data": 1668411049.3,
      "vehicle-trajectories/val/data": 1668411049.3,
      "traffic-light/val/data": 1668411049.4
    }
  },
  {
    "scene_id": "1053",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411059.6,
      "infrastructure-trajectories/val/data": 1668411059.5,
      "vehicle-trajectories/val/data": 1668411059.6,
      "traffic-light/val/data": 1668411059.3
    }
  },
  {
    "scene_id": "1076",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411060.9,
      "infrastructure-trajectories/val/data": 1668411061.0,
      "vehicle-trajectories/val/data": 1668411060.9,
      "traffic-light/val/data": 1668411060.9
    }
  },
  {
    "scene_id": "1096",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411069.3,
      "infrastructure-trajectories/val/data": 1668411069.3,
      "vehicle-trajectories/val/data": 1668411069.3,
      "traffic-light/val/data": 1668411069.4
    }
  },
  {
    "scene_id": "1111",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411075.3,
      "infrastructure-trajectories/val/data": 1668411075.3,
      "vehicle-trajectories/val/data": 1668411075.3,
      "traffic-light/val/data": 1668411075.4
    }
  },
  {
    "scene_id": "1149",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411105.3,
      "infrastructure-trajectories/val/data": 1668411105.3,
      "vehicle-trajectories/val/data": 1668411105.3,
      "traffic-light/val/data": 1668411105.4
    }
  },
  {
    "scene_id": "1160",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411109.7,
      "infrastructure-trajectories/val/data": 1668411109.7,
      "vehicle-trajectories/val/data": 1668411109.7,
      "traffic-light/val/data": 1668411109.8
    }
  },
  {
    "scene_id": "1169",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411128.5,
      "infrastructure-trajectories/val/data": 1668411128.6,
      "vehicle-trajectories/val/data": 1668411128.5,
      "traffic-light/val/data": 1668411128.6
    }
  },
  {
    "scene_id": "1170",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411128.9,
      "infrastructure-trajectories/val/data": 1668411128.9,
      "vehicle-trajectories/val/data": 1668411128.9,
      "traffic-light/val/data": 1668411129.0
    }
  },
  {
    "scene_id": "1170",
    "issue": "max_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1668411136.8,
      "infrastructure-trajectories/val/data": 1668411136.8,
      "vehicle-trajectories/val/data": 1668411136.8,
      "traffic-light/val/data": 1668411136.7
    }
  },
  {
    "scene_id": "1208",
    "issue": "min_ts_mismatch",
    "by_table": {
      "ego-trajectories/val/data": 1648868314.5,
      "infrastructure-trajectories/val/data": 1648868314.5,
      "vehicle-trajectories/val/data": 1648868314.5,
      "traffic-light/val/data": 1648868314.6
    }
  }
]
```

