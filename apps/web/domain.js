/* Shared dataset-domain helpers used by app.js and web_backend.js. */
(function initTrajDomain(global) {
  const TYPES = Object.freeze({
    v2x_traj: Object.freeze({
      family: "v2x-traj",
      label: "V2X-Traj",
      displayName: "V2X-Traj",
      expectedLayoutHint: "Expected root folders: ego-trajectories, infrastructure-trajectories, vehicle-trajectories, and optional maps/traffic-light.",
      sceneStrategy: Object.freeze({ mode: "intersection_scene" }),
      capabilities: Object.freeze({
        has_map: true,
        has_traffic_lights: true,
        splits: Object.freeze(["train", "val"]),
        default_split: "train",
        group_label: "Intersection",
        modalities: Object.freeze(["ego", "infra", "vehicle", "traffic_light"]),
        modality_labels: Object.freeze({
          ego: "Ego vehicle",
          infra: "Infrastructure",
          vehicle: "Other vehicles",
          traffic_light: "Traffic lights",
        }),
        modality_short_labels: Object.freeze({
          ego: "Ego",
          infra: "Infra",
          vehicle: "Vehicles",
          traffic_light: "Lights",
        }),
      }),
    }),
    v2x_seq: Object.freeze({
      family: "v2x-seq",
      label: "V2X-Seq",
      displayName: "V2X-Seq",
      expectedLayoutHint: "Expected root folders: cooperative-vehicle-infrastructure, single-infrastructure, and/or single-vehicle.",
      sceneStrategy: Object.freeze({ mode: "sequence_scene" }),
      capabilities: Object.freeze({
        has_map: true,
        has_traffic_lights: true,
        splits: Object.freeze(["train", "val"]),
        default_split: "val",
        group_label: "Intersection",
        modalities: Object.freeze(["ego", "infra", "vehicle", "traffic_light"]),
        modality_labels: Object.freeze({
          ego: "Cooperative vehicle-infrastructure",
          infra: "Single infrastructure",
          vehicle: "Single vehicle",
          traffic_light: "Traffic lights",
        }),
        modality_short_labels: Object.freeze({
          ego: "Coop",
          infra: "Infra",
          vehicle: "Vehicle",
          traffic_light: "Lights",
        }),
      }),
    }),
    ind: Object.freeze({
      family: "ind",
      label: "inD",
      displayName: "inD",
      expectedLayoutHint: "Expected inD root with data/*_tracks.csv, *_tracksMeta.csv, *_recordingMeta.csv and optional maps/lanelets.",
      sceneStrategy: Object.freeze({ mode: "recording_window", window_s: 60 }),
      capabilities: Object.freeze({
        has_map: true,
        has_traffic_lights: false,
        has_scene_background: true,
        splits: Object.freeze(["all"]),
        default_split: "all",
        group_label: "Location",
        modalities: Object.freeze(["infra"]),
        modality_labels: Object.freeze({ infra: "Road users" }),
        modality_short_labels: Object.freeze({ infra: "Objects" }),
      }),
    }),
    sind: Object.freeze({
      family: "sind",
      label: "SinD",
      displayName: "SinD",
      expectedLayoutHint: "Expected SinD root with city folders, scenario folders, and Veh_smoothed_tracks.csv / Ped_smoothed_tracks.csv files.",
      sceneStrategy: Object.freeze({ mode: "scenario_scene" }),
      capabilities: Object.freeze({
        has_map: true,
        has_traffic_lights: true,
        has_scene_background: true,
        splits: Object.freeze(["all"]),
        default_split: "all",
        group_label: "City",
        modalities: Object.freeze(["infra", "traffic_light"]),
        modality_labels: Object.freeze({
          infra: "Road users",
          traffic_light: "Traffic lights",
        }),
        modality_short_labels: Object.freeze({
          infra: "Objects",
          traffic_light: "Lights",
        }),
      }),
    }),
    consider_it_cpm: Object.freeze({
      family: "cpm-objects",
      label: "Consider.it CPM",
      displayName: "Consider.it",
      expectedLayoutHint: "Expected root folders: lidar and/or thermal_camera with CPM CSV logs.",
      sceneStrategy: Object.freeze({ mode: "time_window", window_s: 300, gap_s: 120 }),
      capabilities: Object.freeze({
        has_map: false,
        has_traffic_lights: false,
        has_scene_background: false,
        splits: Object.freeze(["all"]),
        default_split: "all",
        group_label: "Sensor",
        modalities: Object.freeze(["infra"]),
        modality_labels: Object.freeze({ infra: "Objects" }),
        modality_short_labels: Object.freeze({ infra: "Objects" }),
      }),
    }),
  });

  const TYPE_ALIASES = Object.freeze({
    v2x_traj: Object.freeze(["v2x-traj", "v2x_traj", "v2xtraj"]),
    v2x_seq: Object.freeze(["v2x-seq", "v2x_seq", "v2xseq"]),
    ind: Object.freeze(["ind", "in-d", "ind_dataset"]),
    sind: Object.freeze(["sind", "sin-d", "sin_d", "sind_dataset"]),
    consider_it_cpm: Object.freeze(["consider-it-cpm", "consider_it_cpm", "cpm", "cpm-objects", "considerit"]),
  });

  const TYPE_FROM_ALIAS = (() => {
    const out = {};
    for (const [canonical, aliases] of Object.entries(TYPE_ALIASES)) {
      for (const alias of aliases) out[String(alias)] = canonical;
    }
    return Object.freeze(out);
  })();

  const TYPE_FROM_FAMILY = (() => {
    const out = {};
    for (const [typeId, cfg] of Object.entries(TYPES)) {
      out[String(cfg.family)] = typeId;
    }
    return Object.freeze(out);
  })();

  function normalizeDatasetType(raw) {
    const s = String(raw || "").trim().toLowerCase();
    return TYPE_FROM_ALIAS[s] || "";
  }

  function datasetFamilyFromType(raw) {
    const t = normalizeDatasetType(raw);
    return t && TYPES[t] ? TYPES[t].family : "";
  }

  function datasetTypeFromFamily(rawFamily) {
    const s = String(rawFamily || "").trim().toLowerCase();
    return TYPE_FROM_FAMILY[s] || "";
  }

  function isSupportedLocalFamily(rawFamily) {
    return !!datasetTypeFromFamily(rawFamily);
  }

  function datasetTypeLabel(rawType) {
    const t = normalizeDatasetType(rawType);
    if (!t || !TYPES[t]) return rawType ? String(rawType) : "Unknown";
    return TYPES[t].label;
  }

  function datasetTypeDisplayName(rawType) {
    const t = normalizeDatasetType(rawType);
    if (!t || !TYPES[t]) return "this dataset";
    return TYPES[t].displayName;
  }

  function expectedDatasetLayoutHint(rawType) {
    const t = normalizeDatasetType(rawType);
    if (!t || !TYPES[t]) return "";
    return TYPES[t].expectedLayoutHint;
  }

  function defaultSceneStrategy(rawType) {
    const t = normalizeDatasetType(rawType);
    if (!t || !TYPES[t]) return { mode: "intersection_scene" };
    const src = TYPES[t].sceneStrategy || { mode: "intersection_scene" };
    return JSON.parse(JSON.stringify(src));
  }

  function capabilitiesFromDatasetType(rawType) {
    const t = normalizeDatasetType(rawType);
    if (!t || !TYPES[t]) return {};
    return JSON.parse(JSON.stringify(TYPES[t].capabilities || {}));
  }

  function buildVirtualDatasetMeta(datasetId, title, family) {
    const fam = String(family || "").trim().toLowerCase();
    const t = datasetTypeFromFamily(fam);
    const caps = capabilitiesFromDatasetType(t);
    const base = {
      id: String(datasetId || "").trim(),
      title: String(title || datasetId || "").trim() || "Dataset",
      family: fam,
      supported: false,
      virtual: true,
    };
    if (!t) {
      return {
        ...base,
        splits: ["all"],
        default_split: "all",
        group_label: "Group",
        has_map: false,
        modalities: ["infra"],
        modality_labels: { infra: "Objects" },
        modality_short_labels: { infra: "Objects" },
      };
    }
    return {
      ...base,
      splits: Array.isArray(caps.splits) ? caps.splits : ["all"],
      default_split: String(caps.default_split || "all"),
      group_label: String(caps.group_label || "Group"),
      has_map: !!caps.has_map,
      has_scene_background: !!caps.has_scene_background,
      has_traffic_lights: !!caps.has_traffic_lights,
      modalities: Array.isArray(caps.modalities) ? caps.modalities : ["infra"],
      modality_labels: (caps.modality_labels && typeof caps.modality_labels === "object") ? caps.modality_labels : { infra: "Objects" },
      modality_short_labels: (caps.modality_short_labels && typeof caps.modality_short_labels === "object") ? caps.modality_short_labels : { infra: "Objects" },
    };
  }

  global.TrajDomain = Object.freeze({
    TYPES,
    normalizeDatasetType,
    datasetFamilyFromType,
    datasetTypeFromFamily,
    isSupportedLocalFamily,
    datasetTypeLabel,
    datasetTypeDisplayName,
    expectedDatasetLayoutHint,
    defaultSceneStrategy,
    capabilitiesFromDatasetType,
    buildVirtualDatasetMeta,
  });
})(window);
