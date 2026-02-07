/* V2X Scene Explorer web app: no build tooling, no external deps. */

const $ = (id) => document.getElementById(id);

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "null";
  return Number(n).toFixed(digits);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtMeters(m) {
  if (m == null || !Number.isFinite(Number(m))) return "?";
  const v = Number(m);
  const av = Math.abs(v);
  if (av >= 1000) return `${(v / 1000).toFixed(2)}km`;
  if (av >= 100) return `${v.toFixed(0)}m`;
  return `${v.toFixed(1)}m`;
}

function extentWH(extent) {
  if (!extent) return { w: null, h: null };
  const w = Number(extent.max_x) - Number(extent.min_x);
  const h = Number(extent.max_y) - Number(extent.min_y);
  return { w: Number.isFinite(w) ? w : null, h: Number.isFinite(h) ? h : null };
}

function intersectionLabel(intersectId) {
  if (!intersectId) return null;
  const m = String(intersectId).match(/#(\d+)/);
  if (!m) return intersectId;
  const num = String(m[1]).padStart(2, "0");
  return `Intersection ${num}`;
}

function splitLabel(split) {
  const s = String(split || "").toLowerCase();
  if (s === "train") return "Train";
  if (s === "val" || s === "validation") return "Validation";
  if (s === "test") return "Test";
  if (s === "all") return "All";
  return split || "?";
}

function fitViewToExtent(extent, w, h, padPx = 28) {
  const worldW = Math.max(1e-6, extent.max_x - extent.min_x);
  const worldH = Math.max(1e-6, extent.max_y - extent.min_y);
  const scale = Math.min((w - 2 * padPx) / worldW, (h - 2 * padPx) / worldH);
  const centerX = (extent.min_x + extent.max_x) / 2;
  const centerY = (extent.min_y + extent.max_y) / 2;
  return { centerX, centerY, scale: Math.max(1e-6, scale) };
}

function viewWorldToCanvas(view, w, h, x, y) {
  const cx = (x - view.centerX) * view.scale + w / 2;
  const cy = (view.centerY - y) * view.scale + h / 2;
  return [cx, cy];
}

function viewCanvasToWorld(view, w, h, cx, cy) {
  const x = (cx - w / 2) / view.scale + view.centerX;
  const y = view.centerY - (cy - h / 2) / view.scale;
  return [x, y];
}

function applyWorldTransform(ctx, view, w, h, dpr) {
  const a = view.scale * dpr;
  const d = -view.scale * dpr;
  const e = (w / 2 - view.scale * view.centerX) * dpr;
  const f = (h / 2 + view.scale * view.centerY) * dpr;
  ctx.setTransform(a, 0, 0, d, e, f);
}

function buildPathFromPolyline(path, pts, close = false) {
  if (!pts || pts.length < 2) return;
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
  if (close) path.closePath();
}

const COLORS = {
  modality: {
    ego: "#2563eb",
    infra: "#f59e0b",
    vehicle: "#10b981",
    traffic_light: "#111827",
  },
  type: {
    VEHICLE: "#0b1220",
    PEDESTRIAN: "#ef4444",
    BICYCLE: "#06b6d4",
    OTHER: "#a1a1aa",
    ANIMAL: "#f472b6",
    RSU: "#22c55e",
    UNKNOWN: "#6b7280",
  },
  // Fine-grained class colors. Unknown labels fall back to a stable hash-based color.
  subType: {
    CAR: "#2563eb",
    BUS: "#a855f7",
    VAN: "#14b8a6",
    TRUCK: "#f97316",
    LIGHT_TRUCK: "#fb923c",
    HEAVY_TRUCK: "#c2410c",
    TRAILER: "#a16207",
    MOTORCYCLE: "#0ea5e9",
    MOTORCYCLIST: "#0ea5e9",
    MOPED: "#38bdf8",
    TRAM: "#0f766e",
    EMERGENCY_VEHICLE: "#dc2626",
    AGRICULTURAL: "#84cc16",
    SPECIAL_VEHICLE: "#eab308",

    PEDESTRIAN: "#ef4444",
    PERSON_UNKNOWN: "#fb7185",
    WHEELCHAIR: "#f43f5e",
    STROLLER: "#fb7185",
    SKATES: "#e11d48",
    PERSON_GROUP: "#be123c",
    CYCLIST: "#06b6d4",
    TRICYCLIST: "#16a34a",

    OTHER_UNKNOWN: "#a3a3a3",
    ANIMAL: "#f472b6",
    ROADSIDE_UNIT: "#22c55e",
    UNKNOWN: "#6b7280",
  },
  tl: {
    RED: "#ef4444",
    YELLOW: "#f59e0b",
    GREEN: "#10b981",
  },
};

const state = {
  started: false,
  datasetsById: {},
  datasetSettingsById: {},
  datasetId: null,
  split: "train",
  splits: ["train", "val"],
  defaultSplit: "train",
  groupLabel: "Intersection",
  hasMap: true,
  modalities: ["ego", "infra", "vehicle", "traffic_light"],
  modalityLabels: {},
  modalityShortLabels: {},
  subTypesByDataset: {},
  subTypeFilters: {},
  subTypeCounts: null,
  subTypeList: [],
  intersectId: null,
  sceneId: null,
  sceneIds: [],
  sceneOffset: 0,
  sceneLimit: 400,
  sceneTotal: 0,
  bundle: null,
  frame: 0,
  playing: false,
  timer: null,
  speed: 1,
  showVelocity: false,
  showHeading: false,
  showTrail: true,
  trailFull: true,
  trailAll: false,
  trailCache: null,
  trailAllCache: null,
  holdTL: true,
  mapPointsStep: 3,
  mapPadding: 120,
  mapClip: "scene",
  mapMaxLanes: 5000,
  layers: { ego: true, infra: true, vehicle: true, traffic_light: true },
  mapLayers: { lanes: true, stoplines: true, crosswalks: true, junctions: true },
  types: { VEHICLE: true, PEDESTRIAN: true, BICYCLE: true, OTHER: true, ANIMAL: true, RSU: true, UNKNOWN: true },
  debugOverlay: false,
  sceneBox: true,
  focusMask: true,
  view: null,
  mapPaths: null,
  selectedKey: null,
  selected: null,
};

const req = { intersections: 0, scenes: 0, bundle: 0 };

const LS_LAST_DATASET = "trajExplorer.lastDatasetId";
const LS_DATASET_SETTINGS = "trajExplorer.datasetSettingsById.v1";

function safeJsonParse(s) {
  try {
    return JSON.parse(String(s || ""));
  } catch (_) {
    return null;
  }
}

function defaultDatasetSettings() {
  // Per-dataset UI prefs. Keep this small + stable; avoid storing anything derived from scene content.
  return {
    split: null,
    intersectId: "",
    sceneId: "",
    sceneOffset: 0,
    sceneLimit: 400,
    speed: 1,
    showVelocity: false,
    showHeading: false,
    showTrail: true,
    trailFull: true,
    trailAll: false,
    holdTL: true,
    layers: { ego: true, infra: true, vehicle: true, traffic_light: true },
    types: { VEHICLE: true, PEDESTRIAN: true, BICYCLE: true, OTHER: true, ANIMAL: true, RSU: true, UNKNOWN: true },
    mapClip: "scene",
    mapPointsStep: 3,
    mapPadding: 120,
    mapMaxLanes: 5000,
    mapLayers: { lanes: true, stoplines: true, crosswalks: true, junctions: true },
    debugOverlay: false,
    sceneBox: true,
    focusMask: true,
  };
}

function captureDatasetSettings() {
  return {
    split: state.split,
    intersectId: state.intersectId || "",
    sceneId: state.sceneId || "",
    sceneOffset: Number(state.sceneOffset || 0),
    sceneLimit: Number(state.sceneLimit || 400),
    speed: Number(state.speed || 1),
    showVelocity: !!state.showVelocity,
    showHeading: !!state.showHeading,
    showTrail: !!state.showTrail,
    trailFull: !!state.trailFull,
    trailAll: !!state.trailAll,
    holdTL: !!state.holdTL,
    layers: { ...(state.layers || {}) },
    types: { ...(state.types || {}) },
    mapClip: state.mapClip || "scene",
    mapPointsStep: Number(state.mapPointsStep || 3),
    mapPadding: Number(state.mapPadding || 120),
    mapMaxLanes: Number(state.mapMaxLanes || 5000),
    mapLayers: { ...(state.mapLayers || {}) },
    debugOverlay: !!state.debugOverlay,
    sceneBox: !!state.sceneBox,
    focusMask: !!state.focusMask,
  };
}

function persistDatasetSettings() {
  try {
    localStorage.setItem(LS_DATASET_SETTINGS, JSON.stringify(state.datasetSettingsById || {}));
  } catch (_) {}
}

function loadPersistedDatasetSettings() {
  const raw = safeJsonParse(localStorage.getItem(LS_DATASET_SETTINGS));
  if (!raw || typeof raw !== "object") return;
  state.datasetSettingsById = raw;
}

function saveCurrentDatasetSettings() {
  const ds = state.datasetId;
  if (!ds) return;
  state.datasetSettingsById[ds] = captureDatasetSettings();
  persistDatasetSettings();
}

function restoreDatasetSettings(ds) {
  const defaults = defaultDatasetSettings();
  const saved = (state.datasetSettingsById && state.datasetSettingsById[ds]) ? state.datasetSettingsById[ds] : null;
  const s = saved && typeof saved === "object" ? saved : defaults;

  // Split must exist for this dataset; fall back to dataset default.
  state.split = (s.split && state.splits.includes(s.split)) ? s.split : state.defaultSplit;

  state.intersectId = s.intersectId || "";
  state.sceneId = s.sceneId || "";
  state.sceneOffset = Number.isFinite(Number(s.sceneOffset)) ? Number(s.sceneOffset) : 0;
  state.sceneLimit = Number.isFinite(Number(s.sceneLimit)) ? Number(s.sceneLimit) : 400;

  state.speed = Number.isFinite(Number(s.speed)) ? Number(s.speed) : 1;
  state.showVelocity = !!s.showVelocity;
  state.showHeading = !!s.showHeading;
  state.showTrail = (s.showTrail !== undefined) ? !!s.showTrail : true;
  state.trailFull = (s.trailFull !== undefined) ? !!s.trailFull : true;
  state.trailAll = !!s.trailAll;
  state.holdTL = (s.holdTL !== undefined) ? !!s.holdTL : true;

  state.layers = { ...defaults.layers, ...(s.layers || {}) };
  state.types = { ...defaults.types, ...(s.types || {}) };

  state.mapClip = s.mapClip || defaults.mapClip;
  state.mapPointsStep = Number.isFinite(Number(s.mapPointsStep)) ? Number(s.mapPointsStep) : defaults.mapPointsStep;
  state.mapPadding = Number.isFinite(Number(s.mapPadding)) ? Number(s.mapPadding) : defaults.mapPadding;
  state.mapMaxLanes = Number.isFinite(Number(s.mapMaxLanes)) ? Number(s.mapMaxLanes) : defaults.mapMaxLanes;
  state.mapLayers = { ...defaults.mapLayers, ...(s.mapLayers || {}) };

  state.debugOverlay = !!s.debugOverlay;
  state.sceneBox = (s.sceneBox !== undefined) ? !!s.sceneBox : true;
  state.focusMask = (s.focusMask !== undefined) ? !!s.focusMask : true;

  // Never expose unavailable modalities for this dataset.
  const available = new Set(state.modalities || []);
  for (const k of Object.keys(state.layers || {})) {
    if (!available.has(k)) state.layers[k] = false;
  }
  if (!available.has("traffic_light")) state.holdTL = false;
}

function setView(mode) {
  const home = $("homeView");
  const explorer = $("explorerView");
  if (!home || !explorer) return;
  const isHome = (mode === "home");
  home.hidden = !isHome;
  explorer.hidden = isHome;
  state.started = !isHome;
}

function setCheck(id, v) {
  const el = $(id);
  if (!el) return;
  el.checked = !!v;
}

function setSelectValue(id, v) {
  const el = $(id);
  if (!el) return;
  el.value = String(v);
}

function closestOptionValue(el, target) {
  const opts = Array.from(el.options || []).map((o) => String(o.value));
  if (!opts.length) return null;
  const t = Number(target);
  if (!Number.isFinite(t)) return opts[0];
  let best = opts[0];
  let bestD = Math.abs(Number(best) - t);
  for (const v of opts) {
    const d = Math.abs(Number(v) - t);
    if (d < bestD) {
      best = v;
      bestD = d;
    }
  }
  return best;
}

function syncControlsFromState() {
  if (state.datasetId) {
    const dsSel = $("datasetSelect");
    if (dsSel) dsSel.value = state.datasetId;
    const homeSel = $("homeDatasetSelect");
    if (homeSel) homeSel.value = state.datasetId;
  }

  const splitSel = $("splitSelect");
  if (splitSel) {
    splitSel.value = state.split;
    state.split = splitSel.value || state.defaultSplit;
  }

  const limSel = $("sceneLimitSelect");
  if (limSel) {
    const v = closestOptionValue(limSel, state.sceneLimit);
    if (v != null) {
      limSel.value = v;
      state.sceneLimit = Number(v) || state.sceneLimit;
    }
  }

  const speedSel = $("speedSelect");
  if (speedSel) {
    const v = closestOptionValue(speedSel, state.speed);
    if (v != null) {
      speedSel.value = v;
      state.speed = Number(v) || state.speed;
    }
  }

  setCheck("layerEgo", state.layers.ego);
  setCheck("layerInfra", state.layers.infra);
  setCheck("layerVehicle", state.layers.vehicle);
  setCheck("layerTL", state.layers.traffic_light);

  setCheck("typeVehicle", state.types.VEHICLE);
  setCheck("typePed", state.types.PEDESTRIAN);
  setCheck("typeBike", state.types.BICYCLE);
  setCheck("typeOther", state.types.OTHER);
  setCheck("typeAnimal", state.types.ANIMAL);
  setCheck("typeRsu", state.types.RSU);
  setCheck("typeUnknown", state.types.UNKNOWN);

  setCheck("showVelocity", state.showVelocity);
  setCheck("showHeading", state.showHeading);
  setCheck("showTrail", state.showTrail);
  setCheck("trailAll", state.trailAll);
  setCheck("trailFull", state.trailFull);
  setCheck("holdTL", state.holdTL);

  setCheck("debugOverlay", state.debugOverlay);
  setCheck("sceneBox", state.sceneBox);
  setCheck("focusMask", state.focusMask);

  const mapClipSel = $("mapClipSelect");
  if (mapClipSel) {
    mapClipSel.value = state.mapClip;
    state.mapClip = mapClipSel.value || state.mapClip;
  }
  const mapStepSel = $("mapStepSelect");
  if (mapStepSel) {
    const v = closestOptionValue(mapStepSel, state.mapPointsStep);
    if (v != null) {
      mapStepSel.value = v;
      state.mapPointsStep = Number(v) || state.mapPointsStep;
    }
  }
  const mapPadSel = $("mapPadSelect");
  if (mapPadSel) {
    const v = closestOptionValue(mapPadSel, state.mapPadding);
    if (v != null) {
      mapPadSel.value = v;
      state.mapPadding = Number(v) || state.mapPadding;
    }
  }
  const mapMaxSel = $("mapMaxLanesSelect");
  if (mapMaxSel) {
    const v = closestOptionValue(mapMaxSel, state.mapMaxLanes);
    if (v != null) {
      mapMaxSel.value = v;
      state.mapMaxLanes = Number(v) || state.mapMaxLanes;
    }
  }

  setCheck("mapLanes", state.mapLayers.lanes);
  setCheck("mapStoplines", state.mapLayers.stoplines);
  setCheck("mapCrosswalks", state.mapLayers.crosswalks);
  setCheck("mapJunctions", state.mapLayers.junctions);
}

function getCanvasSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return { cssW: rect.width, cssH: rect.height, dpr };
}

function resizeCanvas(canvas, ctx, cssW, cssH, dpr) {
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  // We set transforms per layer (world vs UI overlays).
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function summarizeBundle(bundle) {
  const warnings = bundle.warnings || [];
  const lines = [];
  const groupLabel = state.groupLabel || "Intersection";
  lines.push(`dataset: ${bundle.dataset_id}`);
  lines.push(`split:   ${bundle.split}`);
  lines.push(`scene:   ${bundle.scene_id}`);
  lines.push(`city:    ${bundle.city}`);
  lines.push(`group_label: ${groupLabel}`);
  const label = bundle.intersect_label || intersectionLabel(bundle.intersect_id);
  if (label) {
    lines.push(`group: ${label}`);
  }
  lines.push(`group_id: ${bundle.intersect_id}`);
  lines.push(`map_id:  ${bundle.map_id}`);
  if (bundle.intersect_by_modality) {
    lines.push(`intersect_by_modality: ${JSON.stringify(bundle.intersect_by_modality)}`);
  }
  lines.push(`frames:  ${bundle.frames.length}`);
  if (bundle.timestamps && bundle.timestamps.length) {
    const t0 = bundle.timestamps[0];
    const t1 = bundle.timestamps[bundle.timestamps.length - 1];
    lines.push(`t0..t1:  ${t0} .. ${t1}`);
  }
  lines.push(`extent:  x=[${fmt(bundle.extent.min_x, 1)}, ${fmt(bundle.extent.max_x, 1)}], y=[${fmt(bundle.extent.min_y, 1)}, ${fmt(bundle.extent.max_y, 1)}]`);

  if (bundle.modality_stats) {
    lines.push("");
    lines.push("modality_stats:");
    for (const key of ["ego", "infra", "vehicle", "traffic_light"]) {
      const s = bundle.modality_stats[key];
      if (!s) continue;
      lines.push(
        `- ${key}: rows=${s.rows}, unique_ts=${s.unique_ts}, min_ts=${s.min_ts}, max_ts=${s.max_ts}`
      );
    }
  }

  if (bundle.map) {
    lines.push("");
    lines.push(`map clip_mode: ${bundle.map.clip_mode || "?"}`);
    if (bundle.map.map_file) {
      lines.push(`map file: ${bundle.map.map_file}`);
    }
    if (bundle.map.counts) {
      lines.push(
        `map counts: lanes=${bundle.map.counts.LANE}, stoplines=${bundle.map.counts.STOPLINE}, crosswalks=${bundle.map.counts.CROSSWALK}, junctions=${bundle.map.counts.JUNCTION}`
      );
    }
    if (bundle.map.bbox) {
      lines.push(
        `map bbox: x=[${fmt(bundle.map.bbox.min_x, 1)}, ${fmt(bundle.map.bbox.max_x, 1)}], y=[${fmt(bundle.map.bbox.min_y, 1)}, ${fmt(bundle.map.bbox.max_y, 1)}]`
      );
    }
    lines.push(`map lanes(shown): ${bundle.map.lanes.length}${bundle.map.lanes_truncated ? " (truncated)" : ""}`);
    lines.push(`map stoplines(shown): ${bundle.map.stoplines.length}`);
    lines.push(`map crosswalks(shown): ${bundle.map.crosswalks.length}`);
    lines.push(`map junctions(shown): ${bundle.map.junctions.length}`);
    lines.push(`map clip:  x=[${fmt(bundle.map.clip_extent.min_x, 1)}, ${fmt(bundle.map.clip_extent.max_x, 1)}], y=[${fmt(bundle.map.clip_extent.min_y, 1)}, ${fmt(bundle.map.clip_extent.max_y, 1)}]`);
  }
  if (warnings.length) {
    lines.push("");
    lines.push("warnings:");
    for (const w of warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

function currentDatasetMeta() {
  const id = state.datasetId;
  if (!id) return null;
  return state.datasetsById && state.datasetsById[id] ? state.datasetsById[id] : null;
}

function pluralizeLower(singular) {
  const base = String(singular || "").trim().toLowerCase();
  if (!base) return "";
  if (base.endsWith("s")) return base;
  return `${base}s`;
}

function applyDatasetUi() {
  const meta = currentDatasetMeta() || {};
  state.groupLabel = meta.group_label || "Intersection";
  state.hasMap = meta.has_map !== undefined ? !!meta.has_map : true;
  state.splits = Array.isArray(meta.splits) && meta.splits.length ? meta.splits : ["train", "val"];
  state.defaultSplit = meta.default_split || state.splits[0] || "train";
  const fallbackModalities = (meta.family === "cpm-objects") ? ["infra"] : ["ego", "infra", "vehicle", "traffic_light"];
  state.modalities = Array.isArray(meta.modalities) && meta.modalities.length ? meta.modalities.map(String) : fallbackModalities;
  state.modalityLabels = (meta.modality_labels && typeof meta.modality_labels === "object") ? meta.modality_labels : (
    meta.family === "cpm-objects" ? { infra: "Objects" } : {}
  );
  state.modalityShortLabels = (meta.modality_short_labels && typeof meta.modality_short_labels === "object") ? meta.modality_short_labels : (
    meta.family === "cpm-objects" ? { infra: "Objects" } : {}
  );

  // Per-dataset subtype filters so switching datasets doesn't leak settings.
  const ds = state.datasetId || "";
  if (!state.subTypesByDataset[ds]) state.subTypesByDataset[ds] = {};
  state.subTypeFilters = state.subTypesByDataset[ds];

  const groupEl = $("groupLabel");
  if (groupEl) groupEl.textContent = state.groupLabel;

  const splitSel = $("splitSelect");
  if (splitSel) {
    splitSel.innerHTML = "";
    for (const s of state.splits) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = splitLabel(s);
      splitSel.appendChild(opt);
    }
  }

  if (!state.splits.includes(state.split)) {
    state.split = state.defaultSplit;
  }
  if (splitSel) {
    splitSel.value = state.split;
    splitSel.disabled = state.splits.length <= 1;
  }

  const mapTitle = $("mapTitle");
  const mapOnly = $("mapOnlyControls");
  const fitMapBtn = $("fitMapBtn");
  if (state.hasMap) {
    if (mapTitle) mapTitle.textContent = "Map";
    if (mapOnly) mapOnly.hidden = false;
    if (fitMapBtn) fitMapBtn.hidden = false;
  } else {
    if (mapTitle) mapTitle.textContent = "View";
    if (mapOnly) mapOnly.hidden = true;
    if (fitMapBtn) fitMapBtn.hidden = true;
  }

  // Dataset-specific modality availability and naming.
  const available = new Set(state.modalities || []);
  const titleEl = $("modalitiesTitle");
  if (titleEl) titleEl.textContent = (available.size <= 1) ? "Stream" : "Modalities";

  const setMod = (modality, wrapId, textId) => {
    const wrap = $(wrapId);
    if (!wrap) return;
    const on = available.has(modality);
    wrap.hidden = !on;
    const txt = $(textId);
    if (txt) {
      const label = (state.modalityLabels && state.modalityLabels[modality]) ? state.modalityLabels[modality] : labelizeEnum(modality);
      txt.textContent = label;
    }
    if (!on && state.layers && Object.prototype.hasOwnProperty.call(state.layers, modality)) {
      state.layers[modality] = false;
    }
  };

  setMod("ego", "layerEgoWrap", "layerEgoText");
  setMod("infra", "layerInfraWrap", "layerInfraText");
  setMod("vehicle", "layerVehicleWrap", "layerVehicleText");
  setMod("traffic_light", "layerTLWrap", "layerTLText");

  const holdWrap = $("holdTLWrap");
  if (holdWrap) holdWrap.hidden = !available.has("traffic_light");
}

function hasModality(modality) {
  return Array.isArray(state.modalities) && state.modalities.includes(modality);
}

function agentModalitiesOrdered() {
  const ms = Array.isArray(state.modalities) ? state.modalities.map(String) : ["ego", "infra", "vehicle"];
  const agent = ms.filter((m) => m !== "traffic_light");
  const pref = ["infra", "vehicle", "ego"];
  const out = [];
  for (const p of pref) if (agent.includes(p)) out.push(p);
  for (const m of agent) if (!out.includes(m)) out.push(m);
  return out;
}

function countsModalitiesOrdered() {
  const ms = Array.isArray(state.modalities) ? state.modalities.map(String) : ["ego", "infra", "vehicle", "traffic_light"];
  const pref = ["ego", "infra", "vehicle", "traffic_light"];
  const out = [];
  for (const p of pref) if (ms.includes(p)) out.push(p);
  for (const m of ms) if (!out.includes(m)) out.push(m);
  return out;
}

function modalityShortLabel(modality) {
  if (state.modalityShortLabels && state.modalityShortLabels[modality]) return String(state.modalityShortLabels[modality]);
  if (modality === "traffic_light") return "Lights";
  if (modality === "vehicle") return "Vehicles";
  if (modality === "infra") return "Infra";
  if (modality === "ego") return "Ego";
  return labelizeEnum(modality);
}

function computeSceneViewExtent(bundle) {
  if (bundle.map && bundle.map.clip_extent) return bundle.map.clip_extent;
  return bundle.extent;
}

function buildMapPaths(map) {
  if (!map) return null;

  const lanesRoad = new Path2D();
  const lanesIntersection = new Path2D();
  const stoplines = new Path2D();
  const crosswalks = new Path2D();
  const junctions = new Path2D();

  for (const lane of map.lanes || []) {
    const p = lane && lane.is_intersection ? lanesIntersection : lanesRoad;
    buildPathFromPolyline(p, lane.centerline, false);
  }
  for (const s of map.stoplines || []) buildPathFromPolyline(stoplines, s.centerline, false);
  for (const cw of map.crosswalks || []) buildPathFromPolyline(crosswalks, cw.polygon, true);
  for (const j of map.junctions || []) buildPathFromPolyline(junctions, j.polygon, true);

  return { lanesRoad, lanesIntersection, stoplines, crosswalks, junctions };
}

function recType(rec) {
  const t = rec && rec.type ? String(rec.type).toUpperCase() : "UNKNOWN";
  if (t === "VEHICLE" || t === "PEDESTRIAN" || t === "BICYCLE" || t === "OTHER" || t === "ANIMAL" || t === "RSU") return t;
  return "UNKNOWN";
}

function recSubType(rec) {
  const st = rec && rec.sub_type != null ? String(rec.sub_type).trim() : "";
  if (!st) return "UNKNOWN";
  return st.toUpperCase();
}

function labelizeEnum(s) {
  const raw = String(s || "").trim();
  if (!raw) return "?";
  return raw
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function hashStringFNV1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function colorFromString(label) {
  const s = String(label || "");
  const h = hashStringFNV1a(s);
  const hue = h % 360;
  // Keep saturation/lightness in a readable range on the light canvas background.
  return `hsl(${hue} 70% 42%)`;
}

function colorForRec(rec) {
  const st = recSubType(rec);
  if (st && st !== "UNKNOWN") {
    return (COLORS.subType && COLORS.subType[st]) ? COLORS.subType[st] : colorFromString(st);
  }
  const t = recType(rec);
  return COLORS.type[t] || COLORS.type.UNKNOWN;
}

function drawAgent(ctx, view, modality, rec, showVelocity, showHeading) {
  if (rec.x == null || rec.y == null) return;

  const fill = colorForRec(rec);
  const stroke = COLORS.modality[modality] || "#111827";

  const theta = rec.theta != null ? Number(rec.theta) : null;
  const length = rec.length != null ? Number(rec.length) : null;
  const width = rec.width != null ? Number(rec.width) : null;
  const px = (n) => n / view.scale;

  ctx.save();

  const drawHeadingArrow = () => {
    if (!showHeading) return;
    if (theta == null || !Number.isFinite(theta)) return;

    const dirX = Math.cos(theta);
    const dirY = Math.sin(theta);

    // Constant screen-space length so it reads at any zoom.
    const lenPx = 34;
    const lenWorld = lenPx / view.scale;

    const x0 = Number(rec.x);
    const y0 = Number(rec.y);
    const x1 = x0 + dirX * lenWorld;
    const y1 = y0 + dirY * lenWorld;

    const headLen = px(8.0);
    const headW = px(5.0);
    const nx = -dirY;
    const ny = dirX;
    const hx = x1 - dirX * headLen;
    const hy = y1 - dirY * headLen;
    const lx = hx + nx * headW;
    const ly = hy + ny * headW;
    const rx = hx - nx * headW;
    const ry = hy - ny * headW;

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash([px(6.0), px(5.0)]);

    // Dashed stem + halo.
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = px(3.4);
    ctx.stroke();
    ctx.globalAlpha = 0.52;
    ctx.strokeStyle = fill;
    ctx.lineWidth = px(2.0);
    ctx.stroke();

    // Small open arrowhead.
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(x1, y1);
    ctx.lineTo(rx, ry);
    ctx.globalAlpha = 0.62;
    ctx.strokeStyle = fill;
    ctx.lineWidth = px(2.0);
    ctx.stroke();
    ctx.restore();
  };

  const drawVelocityArrow = () => {
    if (!showVelocity) return;
    const vx = rec.v_x != null ? Number(rec.v_x) : null;
    const vy = rec.v_y != null ? Number(rec.v_y) : null;
    if (vx == null || vy == null || !Number.isFinite(vx) || !Number.isFinite(vy)) return;
    const speed = Math.hypot(vx, vy);
    if (!(speed > 1e-3)) return;

    const dirX = vx / speed;
    const dirY = vy / speed;

    // Visualize where this object would be after ~t seconds at current velocity.
    // Clamp arrow length in screen space for readability across zoom levels.
    const horizonS = 0.7;
    let lenWorld = speed * horizonS;
    const lenPx = clamp(lenWorld * view.scale, 10, 110);
    lenWorld = lenPx / view.scale;

    const x0 = Number(rec.x);
    const y0 = Number(rec.y);
    const x1 = x0 + dirX * lenWorld;
    const y1 = y0 + dirY * lenWorld;

    const headLen = px(9.0);
    const headW = px(5.5);
    const nx = -dirY;
    const ny = dirX;
    const hx = x1 - dirX * headLen;
    const hy = y1 - dirY * headLen;
    const lx = hx + nx * headW;
    const ly = hy + ny * headW;
    const rx = hx - nx * headW;
    const ry = hy - ny * headW;

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Stem + halo.
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = px(3.6);
    ctx.stroke();
    ctx.globalAlpha = 0.78;
    ctx.strokeStyle = fill;
    ctx.lineWidth = px(2.2);
    ctx.stroke();

    // Filled arrowhead.
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(lx, ly);
    ctx.lineTo(rx, ry);
    ctx.closePath();
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
  };

  const isDot = (theta == null || length == null || width == null || !(length > 0) || !(width > 0));

  if (isDot) {
    // Class color is the primary cue; modality is a subtle halo.
    ctx.beginPath();
    ctx.strokeStyle = stroke;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = px(2.6);
    ctx.arc(rec.x, rec.y, px(4.6), 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.fillStyle = fill;
    ctx.globalAlpha = 0.96;
    ctx.arc(rec.x, rec.y, px(3.6), 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = fill;
    ctx.globalAlpha = 0.78;
    ctx.lineWidth = px(1.2);
    ctx.stroke();
  } else {
    // Oriented box in world coords; transform corners.
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const hl = length / 2;
    const hw = width / 2;

    const corners = [
      [rec.x + hl * c - hw * s, rec.y + hl * s + hw * c],
      [rec.x + hl * c + hw * s, rec.y + hl * s - hw * c],
      [rec.x - hl * c + hw * s, rec.y - hl * s - hw * c],
      [rec.x - hl * c - hw * s, rec.y - hl * s + hw * c],
    ];

    ctx.beginPath();
    for (let i = 0; i < corners.length; i++) {
      const [x, y] = corners[i];
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    ctx.fillStyle = fill;
    ctx.globalAlpha = 0.28;
    ctx.fill();

    // Two-pass stroke: outer modality accent + inner class outline.
    ctx.strokeStyle = stroke;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = px(1.9);
    ctx.stroke();

    ctx.strokeStyle = fill;
    ctx.globalAlpha = 0.78;
    ctx.lineWidth = px(1.1);
    ctx.stroke();
  }

  drawHeadingArrow();
  drawVelocityArrow();

  ctx.restore();
}

function drawTrafficLight(ctx, view, rec) {
  if (rec.x == null || rec.y == null) return;
  const col = COLORS.tl[String(rec.color_1 || "").toUpperCase()] || "#111827";
  const px = (n) => n / view.scale;

  ctx.beginPath();
  ctx.fillStyle = col;
  ctx.globalAlpha = 0.9;
  ctx.arc(rec.x, rec.y, px(4.0), 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#111827";
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = px(1.2);
  ctx.stroke();
}

function shouldDrawRec(modality, rec) {
  if (!state.layers[modality]) return false;
  if (modality === "traffic_light") return true;
  const t = recType(rec);
  if (t === "VEHICLE" && !state.types.VEHICLE) return false;
  if (t === "PEDESTRIAN" && !state.types.PEDESTRIAN) return false;
  if (t === "BICYCLE" && !state.types.BICYCLE) return false;
  if (t === "OTHER" && !state.types.OTHER) return false;
  if (t === "ANIMAL" && !state.types.ANIMAL) return false;
  if (t === "RSU" && !state.types.RSU) return false;
  if (t === "UNKNOWN" && !state.types.UNKNOWN) return false;

  // Optional fine-grained sub-type filtering.
  const st = recSubType(rec);
  if (state.subTypeFilters && Object.prototype.hasOwnProperty.call(state.subTypeFilters, st) && !state.subTypeFilters[st]) {
    return false;
  }
  return true;
}

function computeSubTypeCounts(bundle) {
  const counts = new Map();
  if (!bundle || !bundle.frames) return counts;
  for (const fr of bundle.frames) {
    if (!fr) continue;
    for (const modality of agentModalitiesOrdered()) {
      for (const rec of fr[modality] || []) {
        const st = recSubType(rec);
        counts.set(st, (counts.get(st) || 0) + 1);
      }
    }
  }
  return counts;
}

function updateSubTypeUi(bundle) {
  const section = $("subTypeSection");
  const wrap = $("subTypeFilters");
  if (!section || !wrap) return;

  if (!bundle) {
    section.hidden = true;
    wrap.innerHTML = "";
    state.subTypeCounts = null;
    state.subTypeList = [];
    return;
  }

  const counts = computeSubTypeCounts(bundle);
  const list = Array.from(counts.entries()).map(([sub_type, count]) => ({ sub_type, count }));
  list.sort((a, b) => (b.count - a.count) || a.sub_type.localeCompare(b.sub_type));

  state.subTypeCounts = counts;
  state.subTypeList = list;

  if (!list.length) {
    section.hidden = true;
    wrap.innerHTML = "";
    return;
  }

  section.hidden = false;

  // Ensure all present subtypes default to enabled.
  for (const it of list) {
    if (!Object.prototype.hasOwnProperty.call(state.subTypeFilters, it.sub_type)) {
      state.subTypeFilters[it.sub_type] = true;
    }
  }

  wrap.innerHTML = "";
  for (const it of list) {
    const lab = document.createElement("label");
    lab.className = "check small";

    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.dataset.subtype = it.sub_type;
    inp.checked = !!state.subTypeFilters[it.sub_type];
    inp.addEventListener("change", () => {
      state.subTypeFilters[it.sub_type] = !!inp.checked;
      render();
    });

    lab.appendChild(inp);
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = (COLORS.subType && COLORS.subType[it.sub_type]) ? COLORS.subType[it.sub_type] : colorFromString(it.sub_type);
    lab.appendChild(sw);
    const txt = document.createTextNode(`${labelizeEnum(it.sub_type)} (${it.count})`);
    lab.appendChild(txt);
    wrap.appendChild(lab);
  }
}

function upperBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function resetTrailCache() {
  state.trailCache = null;
  state.trailAllCache = null;
}

function getSelectedTrack() {
  const bundle = state.bundle;
  const key = state.selectedKey;
  if (!bundle || !key || !key.modality || key.id == null) return null;

  const sceneKey = `${bundle.dataset_id}:${bundle.split}:${bundle.scene_id}`;
  const cacheKey = `${sceneKey}:${key.modality}:${String(key.id)}`;
  if (state.trailCache && state.trailCache.key === cacheKey) return state.trailCache;

  const pts = [];
  const frames = [];
  let metaType = null;
  let metaSubType = null;
  let lastX = null;
  let lastY = null;

  for (let i = 0; i < bundle.frames.length; i++) {
    const recs = bundle.frames[i]?.[key.modality] || [];
    let hit = null;
    for (let j = 0; j < recs.length; j++) {
      const r = recs[j];
      if (String(r.id) === String(key.id)) {
        hit = r;
        break;
      }
    }
    if (!hit) continue;
    if (metaType == null && hit.type != null) metaType = hit.type;
    if (metaSubType == null && hit.sub_type != null) metaSubType = hit.sub_type;
    if (hit.x == null || hit.y == null) continue;
    const x = Number(hit.x);
    const y = Number(hit.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (lastX != null && lastY != null && Math.abs(x - lastX) < 1e-6 && Math.abs(y - lastY) < 1e-6) continue;
    pts.push([x, y]);
    frames.push(i);
    lastX = x;
    lastY = y;
  }

  state.trailCache = { key: cacheKey, pts, frames, meta: { type: metaType, sub_type: metaSubType } };
  return state.trailCache;
}

function getAllTracksFor(modality) {
  const bundle = state.bundle;
  if (!bundle) return null;
  const sceneKey = `${bundle.dataset_id}:${bundle.split}:${bundle.scene_id}`;
  if (!state.trailAllCache || state.trailAllCache.key !== sceneKey) {
    state.trailAllCache = { key: sceneKey, byModality: {} };
  }
  const cache = state.trailAllCache;
  if (cache.byModality[modality]) return cache.byModality[modality];

  const tracks = new Map(); // id -> { pts: [[x,y],...], frames: [i,...] }
  const lastById = new Map(); // id -> [x,y]

  for (let i = 0; i < bundle.frames.length; i++) {
    const recs = bundle.frames[i]?.[modality] || [];
    for (let j = 0; j < recs.length; j++) {
      const r = recs[j];
      if (!r || r.id == null || r.x == null || r.y == null) continue;
      const id = String(r.id);
      const x = Number(r.x);
      const y = Number(r.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const last = lastById.get(id);
      if (last && Math.abs(x - last[0]) < 1e-6 && Math.abs(y - last[1]) < 1e-6) continue;

      let t = tracks.get(id);
      if (!t) {
        t = { pts: [], frames: [] };
        tracks.set(id, t);
      }
      t.pts.push([x, y]);
      t.frames.push(i);
      lastById.set(id, [x, y]);
    }
  }

  cache.byModality[modality] = tracks;
  return tracks;
}

function render() {
  const canvas = $("mapCanvas");
  const ctx = canvas.getContext("2d");

  const bundle = state.bundle;
  if (!bundle) return;

  const { cssW, cssH, dpr } = getCanvasSize(canvas);
  resizeCanvas(canvas, ctx, cssW, cssH, dpr);

  // Clear in device pixels.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Ensure a view exists (default: fit to scene/trajectories).
  if (!state.view) {
    // Default to the scene extent (trajectories). Users can hit "Fit Map" for full intersection context.
    state.view = fitViewToExtent(bundle.extent, cssW, cssH, 28);
  }
  const view = state.view;

  // Draw map (Path2D cached per scene)
  if (bundle.map && state.mapPaths) {
    ctx.save();
    applyWorldTransform(ctx, view, cssW, cssH, dpr);
    const px = (n) => n / view.scale;

    // Junction polygons
    if (state.mapLayers.junctions) {
      ctx.save();
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = "#111827";
      ctx.fill(state.mapPaths.junctions);
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = "#111827";
      ctx.lineWidth = px(2.0);
      ctx.setLineDash([px(6), px(6)]);
      ctx.stroke(state.mapPaths.junctions);
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Crosswalks
    if (state.mapLayers.crosswalks) {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = "#0ea5e9";
      ctx.fill(state.mapPaths.crosswalks);
      ctx.restore();
    }

    // Stoplines
    if (state.mapLayers.stoplines) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = px(2.0);
      ctx.stroke(state.mapPaths.stoplines);
      ctx.restore();
    }

    // Lanes
    if (state.mapLayers.lanes) {
      // Non-intersection lanes (lighter)
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = "#111827";
      ctx.lineWidth = px(1.0);
      ctx.stroke(state.mapPaths.lanesRoad);
      ctx.restore();

      // Intersection lanes (bolder) to visually separate "intersection area" from the surrounding map.
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = "#111827";
      ctx.lineWidth = px(1.8);
      ctx.stroke(state.mapPaths.lanesIntersection);
      ctx.restore();
    }

    ctx.restore();
  }

  // Draw agents for current frame
  const frame = clamp(state.frame, 0, Math.max(0, bundle.frames.length - 1));
  const fr = bundle.frames[frame] || {};

  // Keep selection "live" as we scrub time.
  if (state.selectedKey) {
    const { modality, id } = state.selectedKey;
    const arr = (fr[modality] || []);
    const match = arr.find((r) => String(r.id) === String(id));
    state.selected = match ? { modality, ...match } : null;
  }

  // Frame stats
  const hasTL = hasModality("traffic_light");
  let tlArr = hasTL ? (fr.traffic_light || []) : [];
  if (hasTL && state.layers.traffic_light && state.holdTL && (!tlArr || !tlArr.length)) {
    for (let i = frame - 1; i >= 0; i--) {
      const prev = bundle.frames[i]?.traffic_light || [];
      if (prev.length) {
        tlArr = prev;
        break;
      }
    }
  }

  const parts = [];
  for (const modality of countsModalitiesOrdered()) {
    if (!hasModality(modality)) continue;
    const label = modalityShortLabel(modality);
    if (modality === "traffic_light") {
      parts.push(`${label} ${tlArr.length}`);
    } else {
      const arr = fr[modality] || [];
      parts.push(`${label} ${arr.length}`);
    }
  }
  let counts = parts.join(" · ");
  if (state.showTrail) {
    if (state.trailAll) {
      counts += " · Trajectories: all objects in frame";
    } else if (state.selectedKey && state.selectedKey.id != null) {
      counts += ` · Selected ${state.selectedKey.modality}:${state.selectedKey.id}`;
    } else {
      counts += " · Tip: click a dot to select + view its trajectory";
    }
  }
  $("countsLabel").textContent = counts;

  // World drawing pass: trails + agents + TL + highlight
  ctx.save();
  applyWorldTransform(ctx, view, cssW, cssH, dpr);

  // Visual anchors to reduce confusion:
  // - scene box: where trajectories actually are
  // - focus mask (optional): dims map outside scene when viewing full intersection
  if (state.focusMask && bundle.map && bundle.map.clip_mode === "intersection" && bundle.map.clip_extent) {
    const outer = bundle.map.clip_extent;
    const pad = clamp(Number(state.mapPadding || 120), 40, 250);
    const inner = {
      min_x: bundle.extent.min_x - pad,
      min_y: bundle.extent.min_y - pad,
      max_x: bundle.extent.max_x + pad,
      max_y: bundle.extent.max_y + pad,
    };
    const mask = new Path2D();
    mask.rect(outer.min_x, outer.min_y, outer.max_x - outer.min_x, outer.max_y - outer.min_y);
    mask.rect(inner.min_x, inner.min_y, inner.max_x - inner.min_x, inner.max_y - inner.min_y);
    ctx.save();
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = "#0b1220";
    ctx.fill(mask, "evenodd");
    ctx.restore();
  }

  if (state.sceneBox) {
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(
      bundle.extent.min_x,
      bundle.extent.min_y,
      bundle.extent.max_x - bundle.extent.min_x,
      bundle.extent.max_y - bundle.extent.min_y
    );
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.6 / view.scale;
    ctx.strokeRect(
      bundle.extent.min_x,
      bundle.extent.min_y,
      bundle.extent.max_x - bundle.extent.min_x,
      bundle.extent.max_y - bundle.extent.min_y
    );
    ctx.restore();
  }

  if (state.debugOverlay) {
    const px = (n) => n / view.scale;
    // Scene extent
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = px(1.5);
    ctx.strokeRect(
      bundle.extent.min_x,
      bundle.extent.min_y,
      bundle.extent.max_x - bundle.extent.min_x,
      bundle.extent.max_y - bundle.extent.min_y
    );
    ctx.restore();

    // Map clip extent (if present)
    if (bundle.map && bundle.map.clip_extent) {
      const e = bundle.map.clip_extent;
      ctx.save();
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = "#0ea5e9";
      ctx.lineWidth = px(1.5);
      ctx.strokeRect(e.min_x, e.min_y, e.max_x - e.min_x, e.max_y - e.min_y);
      ctx.restore();
    }

    // View center crosshair
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = px(1.0);
    const s = px(18);
    ctx.beginPath();
    ctx.moveTo(view.centerX - s, view.centerY);
    ctx.lineTo(view.centerX + s, view.centerY);
    ctx.moveTo(view.centerX, view.centerY - s);
    ctx.lineTo(view.centerX, view.centerY + s);
    ctx.stroke();
    ctx.restore();
  }

  const drawTrajectory = (modality, pts, frames, alphaScale = 1.0, strokeColor = null) => {
    if (!pts || !frames || pts.length < 2) return;
    const k = upperBound(frames, frame);
    const color = strokeColor || (COLORS.modality[modality] || "#111827");
    const px = (n) => n / view.scale; // pixel -> world units

    const drawSegment = (i0, i1, alpha, widthPx, dashPx, halo) => {
      const n = i1 - i0;
      if (n < 2) return;
      ctx.save();
      ctx.globalAlpha = alpha * alphaScale;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.setLineDash(dashPx ? dashPx.map(px) : []);

      ctx.beginPath();
      ctx.moveTo(pts[i0][0], pts[i0][1]);
      for (let i = i0 + 1; i < i1; i++) ctx.lineTo(pts[i][0], pts[i][1]);

      if (halo) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = px(widthPx + 2.2);
        ctx.stroke();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = px(widthPx);
      ctx.stroke();
      ctx.restore();
    };

    if (state.trailFull) {
      const start = Math.max(0, k - 1);
      drawSegment(start, pts.length, 0.32, 2.0, [10, 8], true);
    }
    drawSegment(0, k, 0.88, 2.8, null, true);
  };

  // Trajectories (selected or all objects in the current frame)
  if (state.showTrail) {
    if (state.trailAll) {
      const seen = new Set();
      for (const modality of agentModalitiesOrdered()) {
        if (!state.layers[modality]) continue;
        const tracks = getAllTracksFor(modality);
        if (!tracks) continue;
        for (const rec of fr[modality] || []) {
          if (!shouldDrawRec(modality, rec)) continue;
          if (!rec || rec.id == null) continue;
          const key = `${modality}:${String(rec.id)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const tr = tracks.get(String(rec.id));
          if (!tr) continue;
          const st = recSubType(rec);
          const col = (st && st !== "UNKNOWN") ? colorForRec(rec) : null;
          // Slightly lighter when drawing many trajectories.
          drawTrajectory(modality, tr.pts, tr.frames, 0.55, col);
        }
      }
    } else if (state.selectedKey) {
      const tr = getSelectedTrack();
      if (tr) {
        const meta = tr.meta || {};
        const metaRec = { type: meta.type, sub_type: meta.sub_type };
        const st = recSubType(metaRec);
        const col = (st && st !== "UNKNOWN") ? colorForRec(metaRec) : null;
        drawTrajectory(state.selectedKey.modality, tr.pts, tr.frames, 1.0, col);
      }
    }
  }

  const showVelocity = !!state.showVelocity;
  const showHeading = !!state.showHeading;
  for (const modality of agentModalitiesOrdered()) {
    for (const rec of fr[modality] || []) {
      if (!shouldDrawRec(modality, rec)) continue;
      drawAgent(ctx, view, modality, rec, showVelocity, showHeading);
    }
  }

  if (hasTL && state.layers.traffic_light) {
    for (const rec of tlArr || []) drawTrafficLight(ctx, view, rec);
  }

  if (state.selected && state.selected.x != null && state.selected.y != null) {
    ctx.beginPath();
    ctx.arc(state.selected.x, state.selected.y, 8.5 / view.scale, 0, Math.PI * 2);
    ctx.strokeStyle = "#111827";
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2.2 / view.scale;
    ctx.stroke();
  }

  ctx.restore();

  // Timeline labels
  $("frameLabel").textContent = `Frame ${frame} / ${Math.max(0, bundle.frames.length - 1)}`;
  const ts = bundle.timestamps && bundle.timestamps[frame] != null ? bundle.timestamps[frame] : null;
  const rel = ts != null && bundle.t0 != null ? ts - bundle.t0 : 0;
  const sign = rel >= 0 ? "+" : "";
  $("timeLabel").textContent = `Time ${sign}${fmt(rel, 1)}s`;
}

function pickNearestAgentAt(canvasX, canvasY) {
  const bundle = state.bundle;
  if (!bundle) return null;

  const canvas = $("mapCanvas");
  const { cssW, cssH } = getCanvasSize(canvas);
  const view = state.view || fitViewToExtent(computeSceneViewExtent(bundle), cssW, cssH, 28);

  const fr = bundle.frames[state.frame] || {};
  const candidates = [];
  for (const modality of agentModalitiesOrdered()) {
    if (!state.layers[modality]) continue;
    for (const rec of fr[modality] || []) {
      if (!shouldDrawRec(modality, rec)) continue;
      if (rec.x == null || rec.y == null) continue;
      const [cx, cy] = viewWorldToCanvas(view, cssW, cssH, rec.x, rec.y);
      const dx = cx - canvasX;
      const dy = cy - canvasY;
      const d2 = dx * dx + dy * dy;
      candidates.push({ modality, rec, d2 });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.d2 - b.d2);
  const best = candidates[0];
  if (best.d2 > 14 * 14) return null;
  return { modality: best.modality, rec: best.rec };
}

function updateSceneInfo(extraLines = []) {
  const bundle = state.bundle;
  let txt = bundle ? summarizeBundle(bundle) : "Select a scene…";
  if (state.selectedKey) {
    txt += `\n\nselectedKey:\n${JSON.stringify(state.selectedKey, null, 2)}`;
    if (state.selected) {
      txt += "\n\nselected:\n" + JSON.stringify(state.selected, null, 2);
    } else {
      txt += "\n\nselected:\n(null at this frame)";
    }

    if (state.showTrail) {
      const tr = getSelectedTrack();
      const ptsN = tr && tr.pts ? tr.pts.length : 0;
      let pastN = null;
      if (tr && tr.frames && tr.frames.length) {
        const fr = clamp(state.frame, 0, Math.max(0, (bundle && bundle.frames ? bundle.frames.length : 1) - 1));
        pastN = upperBound(tr.frames, fr);
      }
      txt += `\n\ntrajectory:\n${JSON.stringify(
        { points: ptsN, past_points: pastN, full: !!state.trailFull },
        null,
        2
      )}`;
    }
  }
  if (extraLines.length) {
    txt += "\n\n" + extraLines.join("\n");
  }
  $("sceneInfo").textContent = txt;
}

function setPlaybackEnabled(enabled) {
  const on = !!enabled;
  $("playBtn").disabled = !on;
  $("stepBtn").disabled = !on;
  $("frameSlider").disabled = !on;
  if (!on) setPlaying(false);
}

function setPlaying(on) {
  if (on && (!state.bundle || !state.bundle.frames || state.bundle.frames.length <= 0)) {
    on = false;
  }
  state.playing = on;
  const btn = $("playBtn");
  btn.textContent = on ? "Pause" : "Play";

  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (!on) return;

  const tick = () => {
    if (!state.playing || !state.bundle) return;

    const t = state.bundle.timestamps || [];
    const n = state.bundle.frames.length || 0;
    if (n <= 0) return;

    const cur = state.frame;
    const next = (cur + 1) % n;
    let dt = 0.1;
    if (t.length >= 2) {
      const raw = Number(t[next]) - Number(t[cur]);
      if (raw > 0) dt = raw;
    }
    const delay = Math.max(10, Math.round((dt * 1000) / Math.max(0.01, state.speed)));

    state.frame = next;
    $("frameSlider").value = String(state.frame);
    render();
    state.timer = setTimeout(tick, delay);
  };

  state.timer = setTimeout(tick, 0);
}

function bestDurationSec(byModality) {
  if (!byModality) return null;
  let best = null;
  for (const k of Object.keys(byModality)) {
    const d = byModality[k] && byModality[k].duration_s != null ? Number(byModality[k].duration_s) : null;
    if (d == null || !Number.isFinite(d)) continue;
    if (best == null || d > best) best = d;
  }
  return best;
}

function updateSceneHint(total, shown, mismatch) {
  const el = $("sceneHint");
  if (!el) return;
  const groupLabel = state.groupLabel || "Intersection";
  const parts = [];
  if (state.intersectId) {
    let lab = null;
    const interSel = $("intersectSelect");
    if (interSel) {
      const opt = Array.from(interSel.options).find((o) => String(o.value) === String(state.intersectId));
      if (opt && opt.textContent) lab = String(opt.textContent).replace(/\s*\(\d+\)\s*$/, "");
    }
    lab = lab || intersectionLabel(state.intersectId) || state.intersectId;
    parts.push(`${groupLabel}: ${lab}`);
  } else {
    parts.push(`${groupLabel}: All ${pluralizeLower(groupLabel) || "groups"}`);
  }
  if (total != null) parts.push(`Scenes: ${total}`);
  if (mismatch != null && mismatch > 0) parts.push(`WARNING: ${mismatch} not in filter`);
  el.textContent = parts.join(" · ");
}

function updateScenePagingUi() {
  const total = Number(state.sceneTotal || 0);
  const lim = Math.max(1, Number(state.sceneLimit || 400));
  const off = Math.max(0, Number(state.sceneOffset || 0));

  const pageLabel = $("pageLabel");
  if (pageLabel) {
    if (total <= 0) {
      pageLabel.textContent = "List: 0-0 of 0";
    } else {
      const start = off + 1;
      const end = Math.min(total, off + lim);
      pageLabel.textContent = `List: ${start}-${end} of ${total}`;
    }
  }

  const prev = $("prevPageBtn");
  const next = $("nextPageBtn");
  if (prev) prev.disabled = off <= 0;
  if (next) next.disabled = off + lim >= total;

  const limitSel = $("sceneLimitSelect");
  if (limitSel) limitSel.value = String(lim);
}

function updateStatusBox(message = null) {
  const el = $("statusBox");
  if (!el) return;

  if (message) {
    el.textContent = message;
    return;
  }

  const b = state.bundle;
  if (!b) {
    el.textContent = "Select a scene…";
    return;
  }

  const warn = b.warnings || [];
  const hasPrefix = (p) => warn.some((w) => String(w).startsWith(p));
  const has = (w) => warn.includes(w);

  const isEmpty = hasPrefix("no_timestamps");
  const mapFail = hasPrefix("map_load_failed");
  const mapMismatch = has("scene_outside_map_bbox") || has("scene_center_outside_map_bbox");
  const intersectMismatch = has("intersect_id_mismatch_across_modalities");

  let tagText = "OK";
  let tagCls = "statusTag statusTag--ok";
  if (isEmpty) {
    tagText = "Empty scene";
    tagCls = "statusTag statusTag--bad";
  } else if (mapFail) {
    tagText = "Map error";
    tagCls = "statusTag statusTag--bad";
  } else if (mapMismatch) {
    tagText = "Map mismatch";
    tagCls = "statusTag statusTag--bad";
  } else if (intersectMismatch || warn.length) {
    tagText = warn.length ? `Warnings (${warn.length})` : "Warnings";
    tagCls = "statusTag statusTag--warn";
  }

  const interLabel = b.intersect_label || intersectionLabel(b.intersect_id) || b.intersect_id || "?";
  const title = `${interLabel} · Scene ${b.scene_id}`;

  const mapFile = b.map && b.map.map_file ? b.map.map_file : null;
  const scope = b.map && b.map.clip_mode ? b.map.clip_mode : null;
  const scopeLabel = scope === "scene" ? "Focused (scene)" : scope === "intersection" ? "Full (intersection map)" : "None";

  const { w: sceneW, h: sceneH } = extentWH(b.extent);
  const { w: clipW, h: clipH } = extentWH(b.map && b.map.clip_extent ? b.map.clip_extent : null);
  const { w: mapW, h: mapH } = extentWH(b.map && b.map.bbox ? b.map.bbox : null);

  const items = [];
  items.push({ k: "Split", v: splitLabel(b.split) });
  if (b.city) items.push({ k: "City", v: b.city });
  items.push({ k: `${state.groupLabel || "Intersection"} ID`, v: b.intersect_id || "?" });
  if (state.hasMap) {
    items.push({ k: "Map file", v: mapFile || "(none)" });
    items.push({ k: "Map scope", v: scopeLabel });
    items.push({ k: "Detail / padding", v: `Step ${state.mapPointsStep} · Pad ${fmtMeters(state.mapPadding)}` });
  }
  if (sceneW != null && sceneH != null) items.push({ k: "Trajectory extent", v: `${fmtMeters(sceneW)} × ${fmtMeters(sceneH)}` });
  if (state.hasMap) {
    if (clipW != null && clipH != null) items.push({ k: "Map clip", v: `${fmtMeters(clipW)} × ${fmtMeters(clipH)}` });
    if (mapW != null && mapH != null) items.push({ k: "Map file extent", v: `${fmtMeters(mapW)} × ${fmtMeters(mapH)}` });
    if (b.map && b.map.counts) {
      const c = b.map.counts;
      items.push({ k: "Lanes", v: `${(b.map.lanes || []).length}${b.map.lanes_truncated ? " (truncated)" : ""} / ${c.LANE}` });
      items.push({ k: "Crosswalks", v: `${(b.map.crosswalks || []).length} / ${c.CROSSWALK}` });
    }
  }

  const warnText =
    warn.length === 0
      ? ""
      : `<div class="statusBox__warnings"><b>Warnings:</b> ${escapeHtml(warn.slice(0, 4).join(" · "))}${
          warn.length > 4 ? ` · +${warn.length - 4} more` : ""
        }</div>`;

  const metaParts = [b.city || null, splitLabel(b.split), mapFile ? `map ${mapFile}` : null].filter(Boolean);
  el.innerHTML = `
    <div class="statusBox__top">
      <div class="statusBox__title">${escapeHtml(title)}</div>
      <span class="${tagCls}">${escapeHtml(tagText)}</span>
    </div>
    <div class="statusBox__meta">${escapeHtml(metaParts.join(" · "))}</div>
    <div class="statusBox__grid">
      ${items
        .slice(0, 10)
        .map((it) => `<div><b>${escapeHtml(it.k)}:</b> ${escapeHtml(it.v)}</div>`)
        .join("")}
    </div>
    ${warnText}
  `;
}

async function loadDatasets() {
  const data = await fetchJson("/api/datasets");
  const sel = $("datasetSelect");
  const homeSel = $("homeDatasetSelect");
  if (sel) sel.innerHTML = "";
  if (homeSel) homeSel.innerHTML = "";
  state.datasetsById = {};
  for (const ds of data.datasets || []) {
    state.datasetsById[ds.id] = ds;
    const opt = document.createElement("option");
    opt.value = ds.id;
    opt.textContent = ds.title || ds.id;
    if (sel) sel.appendChild(opt);
    if (homeSel) homeSel.appendChild(opt.cloneNode(true));
  }

  const first = (data.datasets && data.datasets[0] && data.datasets[0].id) || null;
  const last = localStorage.getItem(LS_LAST_DATASET);
  const preferred = (last && state.datasetsById[last]) ? last : first;
  if (preferred) {
    state.datasetId = preferred;
    if (sel) sel.value = preferred;
    if (homeSel) homeSel.value = preferred;
  }

  const btn = $("homeStartBtn");
  if (btn) btn.disabled = !preferred;
  if (homeSel) homeSel.disabled = !preferred;
  setHomeError("");

  applyDatasetUi();
  syncControlsFromState();
}

function renderHomeDatasetMeta() {
  const el = $("homeDatasetMeta");
  if (!el) return;
  const ds = state.datasetId ? state.datasetsById[state.datasetId] : null;
  if (!ds) {
    el.textContent = "";
    return;
  }
  const splits = Array.isArray(ds.splits) ? ds.splits.map(splitLabel).join(" · ") : "?";
  const group = ds.group_label || state.groupLabel || "Group";
  const map = ds.has_map ? "Yes" : "No";
  const mapCls = ds.has_map ? "chip--yes" : "chip--no";

  let note = "";
  if (ds.family === "cpm-objects") {
    note = "CPM Objects are shown in the sensor's local coordinate frame (no HD map). Scenes are long, gap-aware windows for smooth playback.";
  } else if (ds.family === "v2x-traj") {
    note = "V2X-Traj scenes include trajectories across modalities plus traffic lights and an HD map (when enabled).";
  }

  el.innerHTML = `
    <div class="homeMeta__title">Dataset Overview</div>
    <div class="homeChips">
      <span class="chip">Splits: ${escapeHtml(splits)}</span>
      <span class="chip">Group: ${escapeHtml(group)}</span>
      <span class="chip ${mapCls}">HD map: ${escapeHtml(map)}</span>
    </div>
    ${note ? `<div class="homeNote">${escapeHtml(note)}</div>` : ""}
  `;
}

function setHomeError(msg) {
  const el = $("homeError");
  if (!el) return;
  const m = String(msg || "").trim();
  if (!m) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = m;
}

async function openExplorerForDataset(datasetId, { savePrev = true } = {}) {
  const next = String(datasetId || "").trim();
  if (!next) return;

  const prev = state.datasetId;
  if (savePrev && prev && prev !== next) saveCurrentDatasetSettings();

  state.datasetId = next;
  try {
    localStorage.setItem(LS_LAST_DATASET, next);
  } catch (_) {}

  // Dataset meta first (splits + group label + map controls), then restore prefs.
  applyDatasetUi();
  restoreDatasetSettings(next);
  syncControlsFromState();
  renderHomeDatasetMeta();

  // Now load data for this dataset.
  state.sceneOffset = Number(state.sceneOffset || 0);
  await loadIntersections();
  await loadScenes();
  await loadSceneBundle();
}

async function loadIntersections() {
  const reqId = ++req.intersections;
  const ds = state.datasetId;
  const split = state.split;
  const prev = state.intersectId || "";
  const data = await fetchJson(`/api/datasets/${encodeURIComponent(ds)}/intersections?split=${encodeURIComponent(split)}`);
  if (reqId !== req.intersections) return;
  const sel = $("intersectSelect");
  sel.innerHTML = "";

  const all = document.createElement("option");
  all.value = "";
  all.textContent = `All ${pluralizeLower(state.groupLabel) || "groups"}`;
  sel.appendChild(all);

  for (const it of data.items || []) {
    const opt = document.createElement("option");
    opt.value = it.intersect_id;
    const label = it.intersect_label || intersectionLabel(it.intersect_id);
    opt.textContent = `${label || it.intersect_id} (${it.count})`;
    sel.appendChild(opt);
  }

  const keep = prev && Array.from(sel.options).some((o) => String(o.value) === String(prev));
  state.intersectId = keep ? prev : "";
  sel.value = state.intersectId;
}

async function loadScenes() {
  const reqId = ++req.scenes;
  const ds = state.datasetId;
  const split = state.split;
  const inter = state.intersectId || "";
  const qs = new URLSearchParams({
    split,
    limit: String(state.sceneLimit || 400),
    offset: String(state.sceneOffset || 0),
  });
  if (inter) qs.set("intersect_id", inter);
  const data = await fetchJson(`/api/datasets/${encodeURIComponent(ds)}/scenes?${qs.toString()}`);
  if (reqId !== req.scenes) return;

  const sel = $("sceneSelect");
  sel.innerHTML = "";
  state.sceneIds = [];
  state.sceneTotal = Number(data.total || 0);
  let mismatch = 0;
  for (const it of data.items || []) {
    const opt = document.createElement("option");
    opt.value = it.scene_id;
    const dur = bestDurationSec(it.by_modality);
    const durLabel = dur != null ? `${fmt(dur, 1)}s` : null;
    const sceneLabel = it.scene_label || `Scene ${it.scene_id}`;
    if (state.intersectId) {
      opt.textContent = [sceneLabel, durLabel].filter(Boolean).join(" · ");
    } else {
      const label = it.intersect_label || intersectionLabel(it.intersect_id) || it.intersect_id || "?";
      opt.textContent = [sceneLabel, label, durLabel].filter(Boolean).join(" · ");
    }
    sel.appendChild(opt);
    state.sceneIds.push(it.scene_id);
    if (state.intersectId && it.intersect_id && String(it.intersect_id) !== String(state.intersectId)) mismatch++;
  }

  updateSceneHint(data.total, (data.items || []).length, mismatch);
  updateScenePagingUi();

  const existing = state.sceneId;
  const keep = existing && (data.items || []).some((it) => String(it.scene_id) === String(existing));
  const next = keep ? existing : (data.items && data.items[0] ? data.items[0].scene_id : null);
  state.sceneId = next;
  if (next) sel.value = next;
}

async function loadSceneBundle() {
  const reqId = ++req.bundle;
  const ds = state.datasetId;
  const split = state.split;
  const scene = state.sceneId;
  if (!ds || !split || !scene) return;

  setPlaying(false);
  state.selected = null;
  $("sceneInfo").textContent = "Loading scene…";
  updateStatusBox("Loading scene…");

  const qs = new URLSearchParams({
    include_map: state.hasMap ? "1" : "0",
    map_clip: state.mapClip || "intersection",
    map_points_step: String(state.mapPointsStep || 3),
    map_padding: String(state.mapPadding || 120),
    max_lanes: String(state.mapMaxLanes || 5000),
  });

  const bundle = await fetchJson(`/api/datasets/${encodeURIComponent(ds)}/scene/${encodeURIComponent(split)}/${encodeURIComponent(scene)}/bundle?${qs.toString()}`);
  if (reqId !== req.bundle) return;
  if (state.datasetId !== ds || state.split !== split || String(state.sceneId) !== String(scene)) return;

  state.bundle = bundle;
  state.frame = 0;
  state.selectedKey = null;
  state.selected = null;
  resetTrailCache();
  updateSubTypeUi(bundle);

  // Reflect server-applied map settings (in case values were clamped/defaulted).
  if (bundle.map) {
    if (bundle.map.clip_mode) {
      state.mapClip = bundle.map.clip_mode;
      $("mapClipSelect").value = state.mapClip;
    }
    if (bundle.map.points_step) {
      state.mapPointsStep = Number(bundle.map.points_step) || state.mapPointsStep;
      $("mapStepSelect").value = String(state.mapPointsStep);
    }
  }

  const slider = $("frameSlider");
  slider.min = "0";
  slider.max = String(Math.max(0, bundle.frames.length - 1));
  slider.value = "0";

  state.mapPaths = buildMapPaths(bundle.map);

  // Fit view on load (default: trajectories; scope can be expanded via "Fit Map"/scope selector).
  const canvas = $("mapCanvas");
  const { cssW, cssH } = getCanvasSize(canvas);
  state.view = fitViewToExtent(bundle.extent, cssW, cssH, 28);

  setPlaybackEnabled(bundle.frames && bundle.frames.length > 0);
  updateStatusBox();
  updateSceneInfo();
  render();
}

function wireUi() {
  const backBtn = $("backHomeBtn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      setPlaying(false);
      saveCurrentDatasetSettings();
      setView("home");
      syncControlsFromState();
      renderHomeDatasetMeta();
      setHomeError("");
    });
  }

  $("datasetSelect").addEventListener("change", async (e) => {
    try {
      await openExplorerForDataset(e.target.value, { savePrev: true });
    } catch (err) {
      updateStatusBox(`Failed to switch dataset: ${err && err.message ? err.message : String(err)}`);
    }
  });

  $("splitSelect").addEventListener("change", async (e) => {
    state.split = e.target.value;
    state.sceneOffset = 0;
    await loadIntersections();
    await loadScenes();
    await loadSceneBundle();
  });

  $("intersectSelect").addEventListener("change", async (e) => {
    state.intersectId = e.target.value;
    state.sceneOffset = 0;
    await loadScenes();
    await loadSceneBundle();
  });

  $("sceneSelect").addEventListener("change", async (e) => {
    state.sceneId = e.target.value;
    await loadSceneBundle();
  });

  const goScene = async (delta) => {
    const sel = $("sceneSelect");
    const ids = state.sceneIds || [];
    if (!ids.length) return;
    const cur = state.sceneId || sel.value;
    let idx = ids.findIndex((x) => String(x) === String(cur));
    if (idx < 0) idx = 0;
    const nextIdx = idx + delta;

    // Auto-page if we hit the list ends and there are more scenes beyond this page.
    if (nextIdx < 0) {
      if ((state.sceneOffset || 0) > 0) {
        state.sceneOffset = Math.max(0, (state.sceneOffset || 0) - (state.sceneLimit || 400));
        await loadScenes();
        const last = (state.sceneIds && state.sceneIds[state.sceneIds.length - 1]) || null;
        if (last) {
          state.sceneId = last;
          sel.value = last;
          await loadSceneBundle();
        }
      }
      return;
    }
    if (nextIdx >= ids.length) {
      const off = state.sceneOffset || 0;
      const lim = state.sceneLimit || 400;
      const total = state.sceneTotal || 0;
      if (off + lim < total) {
        state.sceneOffset = off + lim;
        await loadScenes();
        const first = (state.sceneIds && state.sceneIds[0]) || null;
        if (first) {
          state.sceneId = first;
          sel.value = first;
          await loadSceneBundle();
        }
      }
      return;
    }

    const nextId = ids[clamp(nextIdx, 0, ids.length - 1)];
    if (String(nextId) === String(cur)) return;
    state.sceneId = nextId;
    sel.value = nextId;
    await loadSceneBundle();
  };

  $("prevSceneBtn").addEventListener("click", () => {
    goScene(-1).catch(() => {});
  });
  $("nextSceneBtn").addEventListener("click", () => {
    goScene(1).catch(() => {});
  });

  const goPage = async (delta) => {
    const total = Number(state.sceneTotal || 0);
    const lim = Math.max(1, Number(state.sceneLimit || 400));
    if (total <= 0) return;
    const off = Math.max(0, Number(state.sceneOffset || 0));
    const nextOff = clamp(off + delta * lim, 0, Math.max(0, total - lim));
    if (nextOff === off) return;
    state.sceneOffset = nextOff;
    await loadScenes();
    await loadSceneBundle();
  };

  $("prevPageBtn").addEventListener("click", () => {
    goPage(-1).catch(() => {});
  });
  $("nextPageBtn").addEventListener("click", () => {
    goPage(1).catch(() => {});
  });

  $("sceneLimitSelect").addEventListener("change", async (e) => {
    state.sceneLimit = Number(e.target.value || 400);
    state.sceneOffset = 0;
    await loadScenes();
    await loadSceneBundle();
  });

  const jumpToScene = async (raw) => {
    const sceneId = String(raw || "").trim();
    if (!sceneId) return;
    const ds = state.datasetId;
    const split = state.split;
    if (!ds || !split) return;

    setPlaying(false);
    updateStatusBox(`Locating scene ${sceneId}…`);

    let loc = null;
    try {
      const qs = new URLSearchParams({ split, scene_id: sceneId });
      loc = await fetchJson(`/api/datasets/${encodeURIComponent(ds)}/locate_scene?${qs.toString()}`);
    } catch (e) {
      updateStatusBox(`Locate failed: ${e.message || String(e)}`);
      return;
    }

    if (!loc || !loc.found) {
      updateStatusBox(`Scene ${sceneId} not found in split ${split}.`);
      return;
    }

    const iid = loc.intersect_id || "";
    // Jump is explicit user intent: switch the intersection filter to match the scene.
    state.intersectId = iid;
    state.sceneId = sceneId;
    state.sceneOffset = 0;

    const idx = loc.index_in_intersection;
    if (idx != null && Number.isFinite(Number(idx))) {
      const lim = Math.max(1, Number(state.sceneLimit || 400));
      state.sceneOffset = Math.floor(Number(idx) / lim) * lim;
    }

    const interSel = $("intersectSelect");
    if (interSel && (iid === "" || Array.from(interSel.options).some((o) => o.value === iid))) {
      interSel.value = iid;
    }

    await loadScenes();

    const sceneSel = $("sceneSelect");
    if (sceneSel && Array.from(sceneSel.options).some((o) => o.value === sceneId)) {
      sceneSel.value = sceneId;
    }

    await loadSceneBundle();
  };

  $("sceneGoBtn").addEventListener("click", () => {
    jumpToScene($("sceneJumpInput").value).catch(() => {});
  });

  $("sceneJumpInput").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      jumpToScene($("sceneJumpInput").value).catch(() => {});
    }
  });

  $("frameSlider").addEventListener("input", (e) => {
    state.frame = Number(e.target.value || 0);
    render();
    if (state.selectedKey) updateSceneInfo();
  });

  $("playBtn").addEventListener("click", () => setPlaying(!state.playing));
  $("stepBtn").addEventListener("click", () => {
    if (!state.bundle) return;
    state.frame = (state.frame + 1) % state.bundle.frames.length;
    $("frameSlider").value = String(state.frame);
    render();
    if (state.selectedKey) updateSceneInfo();
  });

  $("speedSelect").addEventListener("change", (e) => {
    state.speed = Number(e.target.value || 1);
    if (state.playing) setPlaying(true);
  });

  $("mapStepSelect").addEventListener("change", async (e) => {
    state.mapPointsStep = Number(e.target.value || 3);
    await loadSceneBundle();
  });

  $("mapPadSelect").addEventListener("change", async (e) => {
    state.mapPadding = Number(e.target.value || 120);
    await loadSceneBundle();
  });

  $("mapClipSelect").addEventListener("change", async (e) => {
    state.mapClip = e.target.value || "intersection";
    await loadSceneBundle();
  });

  $("mapMaxLanesSelect").addEventListener("change", async (e) => {
    state.mapMaxLanes = Number(e.target.value || 5000);
    await loadSceneBundle();
  });

  $("showVelocity").addEventListener("change", (e) => {
    state.showVelocity = !!e.target.checked;
    render();
  });

  $("showHeading").addEventListener("change", (e) => {
    state.showHeading = !!e.target.checked;
    render();
  });

  const bindCheck = (id, onChange) => {
    $(id).addEventListener("change", (e) => {
      onChange(!!e.target.checked);
      render();
    });
  };

  bindCheck("layerEgo", (v) => (state.layers.ego = v));
  bindCheck("layerInfra", (v) => (state.layers.infra = v));
  bindCheck("layerVehicle", (v) => (state.layers.vehicle = v));
  bindCheck("layerTL", (v) => (state.layers.traffic_light = v));

  bindCheck("mapLanes", (v) => (state.mapLayers.lanes = v));
  bindCheck("mapStoplines", (v) => (state.mapLayers.stoplines = v));
  bindCheck("mapCrosswalks", (v) => (state.mapLayers.crosswalks = v));
  bindCheck("mapJunctions", (v) => (state.mapLayers.junctions = v));

  bindCheck("typeVehicle", (v) => (state.types.VEHICLE = v));
  bindCheck("typePed", (v) => (state.types.PEDESTRIAN = v));
  bindCheck("typeBike", (v) => (state.types.BICYCLE = v));
  bindCheck("typeOther", (v) => (state.types.OTHER = v));
  bindCheck("typeAnimal", (v) => (state.types.ANIMAL = v));
  bindCheck("typeRsu", (v) => (state.types.RSU = v));
  bindCheck("typeUnknown", (v) => (state.types.UNKNOWN = v));

  const setAllSubTypes = (on) => {
    const list = state.subTypeList || [];
    for (const it of list) state.subTypeFilters[it.sub_type] = !!on;
    const wrap = $("subTypeFilters");
    if (wrap) {
      for (const el of wrap.querySelectorAll("input[data-subtype]")) el.checked = !!on;
    }
    render();
  };
  const allBtn = $("subTypeAllBtn");
  if (allBtn) allBtn.addEventListener("click", () => setAllSubTypes(true));
  const noneBtn = $("subTypeNoneBtn");
  if (noneBtn) noneBtn.addEventListener("click", () => setAllSubTypes(false));

  bindCheck("showTrail", (v) => (state.showTrail = v));
  bindCheck("trailAll", (v) => (state.trailAll = v));
  bindCheck("trailFull", (v) => (state.trailFull = v));
  bindCheck("holdTL", (v) => (state.holdTL = v));
  bindCheck("debugOverlay", (v) => (state.debugOverlay = v));
  bindCheck("sceneBox", (v) => (state.sceneBox = v));
  bindCheck("focusMask", (v) => (state.focusMask = v));

  const fitToExtent = (extent) => {
    const canvas = $("mapCanvas");
    const { cssW, cssH } = getCanvasSize(canvas);
    state.view = fitViewToExtent(extent, cssW, cssH, 28);
    render();
  };

  $("fitSceneBtn").addEventListener("click", () => {
    if (!state.bundle) return;
    fitToExtent(state.bundle.extent);
  });

  $("fitMapBtn").addEventListener("click", () => {
    if (!state.bundle) return;
    const ext = computeSceneViewExtent(state.bundle);
    fitToExtent(ext);
  });

  const canvas = $("mapCanvas");
  let isDown = false;
  let moved = false;
  let downX = 0;
  let downY = 0;
  let startCenterX = 0;
  let startCenterY = 0;

  canvas.addEventListener("pointerdown", (ev) => {
    if (!state.bundle) return;
    if (!state.view) {
      state.view = fitViewToExtent(computeSceneViewExtent(state.bundle), canvas.clientWidth, canvas.clientHeight, 28);
    }
    isDown = true;
    moved = false;
    const rect = canvas.getBoundingClientRect();
    downX = ev.clientX - rect.left;
    downY = ev.clientY - rect.top;
    startCenterX = state.view.centerX;
    startCenterY = state.view.centerY;
    canvas.setPointerCapture(ev.pointerId);
  });

  canvas.addEventListener("pointermove", (ev) => {
    if (!isDown || !state.view) return;
    const rect = canvas.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    const dx = cx - downX;
    const dy = cy - downY;
    if (dx * dx + dy * dy > 8 * 8) moved = true;
    state.view.centerX = startCenterX - dx / state.view.scale;
    state.view.centerY = startCenterY + dy / state.view.scale;
    render();
  });

  const endPointer = (ev) => {
    if (!isDown) return;
    isDown = false;
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch (_) {}
    if (!moved) {
      const rect = canvas.getBoundingClientRect();
      const cx = ev.clientX - rect.left;
      const cy = ev.clientY - rect.top;
	      const picked = pickNearestAgentAt(cx, cy);
	      if (!picked) {
	        state.selectedKey = null;
	        state.selected = null;
	        resetTrailCache();
	        updateSceneInfo();
	        render();
	        return;
	      }
	      state.selectedKey = { modality: picked.modality, id: picked.rec.id };
	      state.selected = { modality: picked.modality, ...picked.rec };
	      resetTrailCache();
	      updateSceneInfo();
	      render();
	    }
	  };

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", () => {
    isDown = false;
    moved = false;
  });

  canvas.addEventListener(
    "wheel",
    (ev) => {
      if (!state.bundle) return;
      if (!state.view) return;
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cx = ev.clientX - rect.left;
      const cy = ev.clientY - rect.top;
      const { cssW, cssH } = getCanvasSize(canvas);
      const [wx, wy] = viewCanvasToWorld(state.view, cssW, cssH, cx, cy);

      const factor = Math.exp(-ev.deltaY * 0.0012);
      const nextScale = clamp(state.view.scale * factor, 0.02, 50);
      state.view.scale = nextScale;
      // Keep (wx, wy) pinned under the cursor.
      state.view.centerX = wx - (cx - cssW / 2) / nextScale;
      state.view.centerY = wy + (cy - cssH / 2) / nextScale;
      render();
    },
    { passive: false }
  );

  window.addEventListener("keydown", (ev) => {
    // Don't steal keystrokes from form controls.
    const tag = (ev.target && ev.target.tagName) ? String(ev.target.tagName).toLowerCase() : "";
    if (tag === "input" || tag === "select" || tag === "textarea") return;

    if (ev.code === "Space") {
      ev.preventDefault();
      setPlaying(!state.playing);
      return;
    }
    if (ev.code === "ArrowRight") {
      ev.preventDefault();
      if (!state.bundle) return;
      setPlaying(false);
      state.frame = (state.frame + 1) % state.bundle.frames.length;
      $("frameSlider").value = String(state.frame);
      render();
      if (state.selectedKey) updateSceneInfo();
      return;
    }
    if (ev.code === "ArrowLeft") {
      ev.preventDefault();
      if (!state.bundle) return;
      setPlaying(false);
      state.frame = (state.frame - 1 + state.bundle.frames.length) % state.bundle.frames.length;
      $("frameSlider").value = String(state.frame);
      render();
      if (state.selectedKey) updateSceneInfo();
      return;
    }
    if (ev.key && (ev.key === "f" || ev.key === "F")) {
      ev.preventDefault();
      if (!state.bundle) return;
      const ext = computeSceneViewExtent(state.bundle);
      const canvas = $("mapCanvas");
      const { cssW, cssH } = getCanvasSize(canvas);
      state.view = fitViewToExtent(ext, cssW, cssH, 28);
      render();
    }

    if (ev.key && (ev.key === "n" || ev.key === "N") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      goScene(1).catch(() => {});
      return;
    }
    if (ev.key && (ev.key === "p" || ev.key === "P") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      goScene(-1).catch(() => {});
      return;
    }
    if (ev.code === "PageDown") {
      ev.preventDefault();
      goScene(1).catch(() => {});
      return;
    }
    if (ev.code === "PageUp") {
      ev.preventDefault();
      goScene(-1).catch(() => {});
      return;
    }
  });

  window.addEventListener("resize", () => {
    render();
  });
}

function wireHomeUi() {
  const sel = $("homeDatasetSelect");
  if (sel) {
    sel.addEventListener("change", (e) => {
      state.datasetId = e.target.value;
      applyDatasetUi();
      syncControlsFromState();
      renderHomeDatasetMeta();
      setHomeError("");
    });
  }

  const btn = $("homeStartBtn");
  if (btn) {
    btn.addEventListener("click", async () => {
      const ds = sel ? sel.value : (state.datasetId || "");
      if (!ds) {
        setHomeError("Please choose a dataset first.");
        return;
      }

      setHomeError("");
      btn.disabled = true;
      const prevText = btn.textContent;
      btn.textContent = "Opening...";

      setView("explorer");
      try {
        await openExplorerForDataset(ds, { savePrev: false });
      } catch (e) {
        setView("home");
        setHomeError(`Failed to open explorer: ${e && e.message ? e.message : String(e)}`);
      } finally {
        btn.textContent = prevText;
        btn.disabled = false;
      }
    });
  }
}

async function main() {
  loadPersistedDatasetSettings();
  wireUi();
  wireHomeUi();
  setView("home");

  const homeBtn = $("homeStartBtn");
  if (homeBtn) homeBtn.disabled = true;
  const homeSel = $("homeDatasetSelect");
  if (homeSel) homeSel.disabled = true;

  await loadDatasets();
  renderHomeDatasetMeta();

  window.addEventListener("beforeunload", () => {
    if (state.started) saveCurrentDatasetSettings();
  });
}

main().catch((e) => {
  setView("home");
  setHomeError(`Startup error: ${e && e.message ? e.message : String(e)}`);
  const si = $("sceneInfo");
  if (si) si.textContent = `Startup error:\n${e.stack || e.message || String(e)}`;
});
