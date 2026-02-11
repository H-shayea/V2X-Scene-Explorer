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

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
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

const EARTH_R = 6378137; // meters (WGS84 / WebMercator)
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    try {
      render();
    } catch (_) {}
  });
}

const TILE_CACHE_MAX = 320;
const tileCache = new Map(); // key -> { img, status }

function tileUrlFromTemplate(tpl, z, x, y) {
  return String(tpl || "")
    .replaceAll("{z}", String(z))
    .replaceAll("{x}", String(x))
    .replaceAll("{y}", String(y));
}

function cacheTouch(key, value) {
  if (tileCache.has(key)) tileCache.delete(key);
  tileCache.set(key, value);
  while (tileCache.size > TILE_CACHE_MAX) {
    const first = tileCache.keys().next().value;
    if (first == null) break;
    tileCache.delete(first);
  }
}

function getTileImage(url) {
  const key = String(url || "");
  if (!key) return null;
  const existing = tileCache.get(key);
  if (existing) {
    cacheTouch(key, existing);
    return existing;
  }

  const img = new Image();
  img.decoding = "async";
  const rec = { img, status: "loading" };
  img.onload = () => {
    rec.status = "loaded";
    queueRender();
  };
  img.onerror = () => {
    rec.status = "error";
    queueRender();
  };
  img.src = key;
  cacheTouch(key, rec);
  return rec;
}

function enuToLatLon(origin, xEastM, yNorthM) {
  const lat0 = Number(origin?.lat);
  const lon0 = Number(origin?.lon);
  if (!Number.isFinite(lat0) || !Number.isFinite(lon0)) return null;
  const lat0r = lat0 * DEG2RAD;
  const lon0r = lon0 * DEG2RAD;
  const latr = lat0r + Number(yNorthM || 0) / EARTH_R;
  const lonr = lon0r + Number(xEastM || 0) / (EARTH_R * Math.cos(lat0r));
  return { lat: latr * RAD2DEG, lon: lonr * RAD2DEG };
}

function latLonToEnu(origin, latDeg, lonDeg) {
  const lat0 = Number(origin?.lat);
  const lon0 = Number(origin?.lon);
  const lat = Number(latDeg);
  const lon = Number(lonDeg);
  if (!Number.isFinite(lat0) || !Number.isFinite(lon0) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const lat0r = lat0 * DEG2RAD;
  const lon0r = lon0 * DEG2RAD;
  const latr = lat * DEG2RAD;
  const lonr = lon * DEG2RAD;
  const yNorth = (latr - lat0r) * EARTH_R;
  const xEast = (lonr - lon0r) * EARTH_R * Math.cos(lat0r);
  return { x: xEast, y: yNorth };
}

function clampLat(lat) {
  return clamp(lat, -85.05112878, 85.05112878);
}

function latLonToTileFrac(latDeg, lonDeg, z) {
  const n = 2 ** z;
  const lat = clampLat(Number(latDeg));
  const lon = Number(lonDeg);
  const x = n * ((lon + 180) / 360);
  const latR = lat * DEG2RAD;
  const y = n * (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2;
  return { x, y };
}

function tileFracToLatLon(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const latR = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lat: latR * RAD2DEG, lon };
}

function mod(n, m) {
  const r = n % m;
  return r < 0 ? r + m : r;
}

function basemapSuggestedZoom(viewScale, latDeg, minZoom = 14, maxZoom = 20) {
  const s = Number(viewScale);
  const latR = Number(latDeg) * DEG2RAD;
  if (!Number.isFinite(s) || !(s > 1e-9) || !Number.isFinite(latR)) return minZoom;
  const mPerPx = 1 / s;
  const base = (Math.cos(latR) * 2 * Math.PI * EARTH_R) / 256;
  const z = Math.round(Math.log2(base / mPerPx));
  return clamp(z, minZoom, maxZoom);
}

function currentBasemapConfig() {
  const meta = state.basemapMeta;
  if (!meta || typeof meta !== "object") return null;
  const provider = meta.provider ? String(meta.provider) : "osm";
  const tileUrl = meta.tile_url ? String(meta.tile_url) : "";
  const originBy = meta.origin_by_intersect && typeof meta.origin_by_intersect === "object" ? meta.origin_by_intersect : null;
  const originDefault = meta.origin && typeof meta.origin === "object" ? meta.origin : null;
  let origin = originDefault;
  const iid = state.intersectId;
  if (originBy && iid && originBy[iid]) origin = originBy[iid];
  if (!origin || origin.lat == null || origin.lon == null) return null;
  const lat = Number(origin.lat);
  const lon = Number(origin.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    provider,
    tileUrl: tileUrl || "/api/tiles/osm/{z}/{x}/{y}.png",
    origin: { lat, lon },
  };
}

function drawBasemap(ctx, view, cssW, cssH, dpr) {
  if (!state.basemapEnabled) {
    state.basemapFrameStats = null;
    return;
  }
  const cfg = currentBasemapConfig();
  if (!cfg) {
    state.basemapFrameStats = null;
    return;
  }

  const origin = cfg.origin;
  const z = Number.isFinite(Number(state.basemapZoom))
    ? Number(state.basemapZoom)
    : basemapSuggestedZoom(view.scale, origin.lat, 12, 20);
  state.basemapZoom = z;
  const stats = { needed: 0, loaded: 0, loading: 0, error: 0, z };

  // Visible world bounds (ENU meters).
  const halfW = cssW / (2 * view.scale);
  const halfH = cssH / (2 * view.scale);
  const xMin = view.centerX - halfW;
  const xMax = view.centerX + halfW;
  const yMin = view.centerY - halfH;
  const yMax = view.centerY + halfH;

  const corners = [
    enuToLatLon(origin, xMin, yMin),
    enuToLatLon(origin, xMin, yMax),
    enuToLatLon(origin, xMax, yMin),
    enuToLatLon(origin, xMax, yMax),
  ].filter(Boolean);
  if (!corners.length) {
    state.basemapFrameStats = stats;
    return;
  }

  let latMin = corners[0].lat;
  let latMax = corners[0].lat;
  let lonMin = corners[0].lon;
  let lonMax = corners[0].lon;
  for (const c of corners) {
    latMin = Math.min(latMin, c.lat);
    latMax = Math.max(latMax, c.lat);
    lonMin = Math.min(lonMin, c.lon);
    lonMax = Math.max(lonMax, c.lon);
  }

  const nw = latLonToTileFrac(latMax, lonMin, z);
  const se = latLonToTileFrac(latMin, lonMax, z);
  let tx0 = Math.floor(Math.min(nw.x, se.x)) - 1;
  let tx1 = Math.floor(Math.max(nw.x, se.x)) + 1;
  let ty0 = Math.floor(Math.min(nw.y, se.y)) - 1;
  let ty1 = Math.floor(Math.max(nw.y, se.y)) + 1;

  const n = 2 ** z;
  ty0 = clamp(ty0, 0, n - 1);
  ty1 = clamp(ty1, 0, n - 1);

  ctx.save();
  // Draw in CSS pixels (scaled to device pixels via dpr).
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 0.9;
  ctx.imageSmoothingEnabled = true;

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const xWrap = mod(tx, n);
      const url = tileUrlFromTemplate(cfg.tileUrl, z, xWrap, ty);
      const tile = getTileImage(url);
      if (!tile) continue;
      stats.needed += 1;
      if (tile.status === "loaded") stats.loaded += 1;
      else if (tile.status === "error") stats.error += 1;
      else stats.loading += 1;
      if (tile.status !== "loaded") continue;

      const llNW = tileFracToLatLon(xWrap, ty, z);
      const llSE = tileFracToLatLon(xWrap + 1, ty + 1, z);
      const wNW = latLonToEnu(origin, llNW.lat, llNW.lon);
      const wSE = latLonToEnu(origin, llSE.lat, llSE.lon);
      if (!wNW || !wSE) continue;

      const [cx0, cy0] = viewWorldToCanvas(view, cssW, cssH, wNW.x, wNW.y);
      const [cx1, cy1] = viewWorldToCanvas(view, cssW, cssH, wSE.x, wSE.y);

      const x0 = Math.min(cx0, cx1);
      const y0 = Math.min(cy0, cy1);
      const w = Math.abs(cx1 - cx0);
      const h = Math.abs(cy1 - cy0);
      if (w < 1 || h < 1) continue;
      // Skip fully offscreen tiles.
      if (x0 > cssW || y0 > cssH || x0 + w < 0 || y0 + h < 0) continue;

      ctx.drawImage(tile.img, x0, y0, w, h);
    }
  }

  ctx.restore();
  state.basemapFrameStats = stats;
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
    VRU: "#ef4444",
    PEDESTRIAN: "#ef4444",
    BICYCLE: "#06b6d4",
    OTHER: "#a1a1aa",
    ANIMAL: "#f472b6",
    RSU: "#22c55e",
    UNKNOWN: "#6b7280",
  },
  // Fine-grained class colors. Unknown labels fall back to a stable hash-based color.
  subType: {
    // Consider.it two-class palette (explicit to avoid hash-color collisions).
    VEHICLE: "#1d4ed8",
    VRU: "#dc2626",

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
  catalogById: {},
  catalogDatasets: [],
  datasetSettingsById: {},
  datasetId: null,
  datasetLocked: false,
  split: "train",
  splits: ["train", "val"],
  defaultSplit: "train",
  groupLabel: "Intersection",
  hasMap: true,
  basemapMeta: null,
  basemapEnabled: false,
  basemapZoom: null,
  basemapFrameStats: null,
  modalities: ["ego", "infra", "vehicle", "traffic_light"],
  sceneModalities: null,
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
  types: { VEHICLE: true, VRU: true, PEDESTRIAN: true, BICYCLE: true, OTHER: true, ANIMAL: true, RSU: true, UNKNOWN: true },
  debugOverlay: false,
  sceneBox: true,
  focusMask: true,
  view: null,
  mapPaths: null,
  selectedKey: null,
  selected: null,
  homeSearch: "",
  homeCategory: "",
  homeHasMap: "",
  homeHasTL: "",
  homeSort: "available",
  profiles: [],
  connectDraft: null,
  connectBusy: false,
  sourceBusy: false,
  sourceByType: {},
  profileWizard: {
    open: false,
    mode: "create",
    step: 1,
    busy: false,
    action: "",
    draft: null,
    profileId: "",
  },
  appMeta: null,
  updateInfo: null,
  updateDownloadUrl: "",
  updateBusy: false,
  sceneTransitionTimer: null,
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
    basemapEnabled: false,
    basemapZoom: null,
    layers: { ego: true, infra: true, vehicle: true, traffic_light: true },
    types: { VEHICLE: true, VRU: true, PEDESTRIAN: true, BICYCLE: true, OTHER: true, ANIMAL: true, RSU: true, UNKNOWN: true },
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
    basemapEnabled: !!state.basemapEnabled,
    basemapZoom: (state.basemapZoom != null && Number.isFinite(Number(state.basemapZoom))) ? Number(state.basemapZoom) : null,
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
  // Scene list paging is an internal performance detail; keep it stable.
  state.sceneLimit = 400;

  state.speed = Number.isFinite(Number(s.speed)) ? Number(s.speed) : 1;
  state.showVelocity = !!s.showVelocity;
  state.showHeading = !!s.showHeading;
  state.showTrail = (s.showTrail !== undefined) ? !!s.showTrail : true;
  state.trailFull = (s.trailFull !== undefined) ? !!s.trailFull : true;
  state.trailAll = !!s.trailAll;
  state.holdTL = (s.holdTL !== undefined) ? !!s.holdTL : true;
  const meta = currentDatasetMeta() || {};
  const hasBasemap = !!(meta.basemap && typeof meta.basemap === "object");
  const defaultBasemapOn = (meta.family === "cpm-objects") && hasBasemap;
  state.basemapEnabled = (s.basemapEnabled !== undefined) ? !!s.basemapEnabled : defaultBasemapOn;
  state.basemapZoom = Number.isFinite(Number(s.basemapZoom)) ? Number(s.basemapZoom) : null;

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

function setCheckDisabled(id, disabled) {
  const el = $(id);
  if (!el) return;
  el.disabled = !!disabled;
}

function setSelectValue(id, v) {
  const el = $(id);
  if (!el) return;
  el.value = String(v);
}

function shortSceneLabel(raw, fallback = "") {
  const s = String(raw || "").trim();
  if (!s) return String(fallback || "").trim();
  const compact = s.replace(/\s+/g, " ").trim();
  return compact.length > 96 ? `${compact.slice(0, 93)}...` : compact;
}

function currentSceneLabel(sceneId) {
  const sel = $("sceneSelect");
  const sid = String(sceneId || "").trim();
  if (sel && sid) {
    const opt = Array.from(sel.options || []).find((o) => String(o.value) === sid);
    if (opt && opt.textContent) return shortSceneLabel(opt.textContent, `Scene ${sid}`);
  }
  return sid ? `Scene ${sid}` : "Scene";
}

function setCanvasLoading(on, message = "Loading scene...") {
  const wrap = $("canvasWrap");
  const overlay = $("canvasOverlay");
  const text = $("canvasOverlayText");
  if (wrap) wrap.classList.toggle("is-loading", !!on);
  if (text) text.textContent = String(message || "Loading scene...");
  if (overlay) overlay.hidden = !on;
}

function markSceneTransition(label) {
  const wrap = $("canvasWrap");
  const out = $("sceneTransitionLabel");
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (out) out.textContent = `${shortSceneLabel(label, "Scene")} loaded at ${time}`;
  if (!wrap) return;
  if (state.sceneTransitionTimer) {
    clearTimeout(state.sceneTransitionTimer);
    state.sceneTransitionTimer = null;
  }
  wrap.classList.remove("is-switched");
  void wrap.offsetWidth;
  wrap.classList.add("is-switched");
  state.sceneTransitionTimer = setTimeout(() => {
    wrap.classList.remove("is-switched");
    state.sceneTransitionTimer = null;
  }, 520);
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
  }

  const splitSel = $("splitSelect");
  if (splitSel) {
    splitSel.value = state.split;
    state.split = splitSel.value || state.defaultSplit;
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
  setCheck("typeVru", state.types.VRU);
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
  setCheck("showBasemap", state.basemapEnabled);

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

function syncBasemapStatusUi() {
  const el = $("basemapStatus");
  if (!el) return;
  const cfg = currentBasemapConfig();
  if (!state.basemapEnabled || !cfg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  const st = state.basemapFrameStats;
  if (!st) {
    el.hidden = false;
    el.textContent = "Basemap: loading…";
    return;
  }

  const parts = [];
  parts.push(`Zoom z${st.z}`);
  parts.push(`Tiles ${st.loaded}/${st.needed}`);
  if (st.loading) parts.push(`Loading ${st.loading}`);
  if (st.error) parts.push(`Errors ${st.error}`);
  if (st.error && st.loaded === 0 && st.needed > 0) parts.push("Check internet/adblock");
  const msg = parts.join(" · ");

  if (el.textContent !== msg || el.hidden) {
    el.hidden = false;
    el.textContent = msg;
  }
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

  const datasetField = $("datasetField");
  if (datasetField) datasetField.hidden = !!state.datasetLocked;
  const datasetSel = $("datasetSelect");
  if (datasetSel) datasetSel.disabled = !!state.datasetLocked;

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
  const splitField = $("splitField");
  if (splitField) splitField.hidden = state.splits.length <= 1;

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

  // Optional basemap (raster) for datasets that provide a geo origin but no vector HD map.
  state.basemapMeta = (meta.basemap && typeof meta.basemap === "object") ? meta.basemap : null;
  const basemapWrap = $("basemapControls");
  const hasBasemap = !!(state.basemapMeta && (state.basemapMeta.origin || state.basemapMeta.origin_by_intersect));
  if (basemapWrap) basemapWrap.hidden = !hasBasemap;

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

  const isCpm = (datasetTypeFromMeta(meta) === "consider_it_cpm") || (meta.family === "cpm-objects");
  const setType = (key, wrapId, textId, label, show) => {
    const wrap = $(wrapId);
    if (wrap) wrap.hidden = !show;
    const txt = $(textId);
    if (txt && label) txt.textContent = label;
    if (!show && state.types && Object.prototype.hasOwnProperty.call(state.types, key)) {
      state.types[key] = false;
    }
  };
  if (isCpm) {
    setType("VEHICLE", "typeVehicleWrap", "typeVehicleText", "Vehicles", true);
    setType("VRU", "typeVruWrap", "typeVruText", "VRU", true);
    setType("PEDESTRIAN", "typePedWrap", "typePedText", "Pedestrian", false);
    setType("BICYCLE", "typeBikeWrap", "typeBikeText", "Bicycle", false);
    setType("OTHER", "typeOtherWrap", "typeOtherText", "Other", false);
    setType("ANIMAL", "typeAnimalWrap", "typeAnimalText", "Animal", false);
    setType("RSU", "typeRsuWrap", "typeRsuText", "Roadside unit", false);
    setType("UNKNOWN", "typeUnknownWrap", "typeUnknownText", "Unknown", false);
  } else {
    setType("VEHICLE", "typeVehicleWrap", "typeVehicleText", "Vehicle", true);
    setType("VRU", "typeVruWrap", "typeVruText", "VRU", false);
    setType("PEDESTRIAN", "typePedWrap", "typePedText", "Pedestrian", true);
    setType("BICYCLE", "typeBikeWrap", "typeBikeText", "Bicycle", true);
    setType("OTHER", "typeOtherWrap", "typeOtherText", "Other", true);
    setType("ANIMAL", "typeAnimalWrap", "typeAnimalText", "Animal", true);
    setType("RSU", "typeRsuWrap", "typeRsuText", "Roadside unit", true);
    setType("UNKNOWN", "typeUnknownWrap", "typeUnknownText", "Unknown", true);
  }

  const holdWrap = $("holdTLWrap");
  if (holdWrap) holdWrap.hidden = !available.has("traffic_light");
  state.sceneModalities = null;
  updateSceneModalityControls(null);
  updateSourcePanel();
}

function detectSceneModalities(bundle) {
  if (!bundle || typeof bundle !== "object") return null;
  const datasetAvailable = new Set(Array.isArray(state.modalities) ? state.modalities.map(String) : []);
  if (!datasetAvailable.size) return null;

  let out = new Set();
  const stats = bundle.modality_stats && typeof bundle.modality_stats === "object" ? bundle.modality_stats : null;
  if (stats) {
    for (const m of datasetAvailable) {
      const rows = Number((((stats[m] || {}).rows) || 0));
      if (rows > 0) out.add(m);
    }
  }

  // Fallback when stats are missing: inspect a small frame sample.
  if (!out.size && Array.isArray(bundle.frames) && bundle.frames.length) {
    const frames = bundle.frames;
    const step = Math.max(1, Math.floor(frames.length / 20));
    for (let i = 0; i < frames.length; i += step) {
      const fr = frames[i] || {};
      for (const m of datasetAvailable) {
        const arr = fr[m];
        if (Array.isArray(arr) && arr.length > 0) out.add(m);
      }
      if (out.size === datasetAvailable.size) break;
    }
  }

  if (!out.size) return null;
  return out;
}

function updateSceneModalityControls(bundle) {
  const datasetAvailable = new Set(Array.isArray(state.modalities) ? state.modalities.map(String) : []);
  const sceneAvailable = detectSceneModalities(bundle);
  state.sceneModalities = sceneAvailable ? Array.from(sceneAvailable) : null;

  const cfg = [
    { modality: "ego", wrapId: "layerEgoWrap", inputId: "layerEgo" },
    { modality: "infra", wrapId: "layerInfraWrap", inputId: "layerInfra" },
    { modality: "vehicle", wrapId: "layerVehicleWrap", inputId: "layerVehicle" },
    { modality: "traffic_light", wrapId: "layerTLWrap", inputId: "layerTL" },
  ];

  for (const it of cfg) {
    const datasetOn = datasetAvailable.has(it.modality);
    const sceneOn = !sceneAvailable || sceneAvailable.has(it.modality);
    const disable = datasetOn && !sceneOn;
    const wrap = $(it.wrapId);
    if (wrap) wrap.classList.toggle("is-disabled", disable);
    setCheckDisabled(it.inputId, disable);
  }

  const hold = $("holdTL");
  if (hold) {
    const tlDataset = datasetAvailable.has("traffic_light");
    const tlScene = !sceneAvailable || sceneAvailable.has("traffic_light");
    hold.disabled = !(tlDataset && tlScene);
  }
}

function hasModality(modality) {
  if (!Array.isArray(state.modalities) || !state.modalities.includes(modality)) return false;
  if (!Array.isArray(state.sceneModalities) || !state.sceneModalities.length) return true;
  return state.sceneModalities.includes(modality);
}

function agentModalitiesOrdered() {
  const ms = Array.isArray(state.modalities) ? state.modalities.map(String) : ["ego", "infra", "vehicle"];
  const agent = ms.filter((m) => m !== "traffic_light" && hasModality(m));
  const pref = ["infra", "vehicle", "ego"];
  const out = [];
  for (const p of pref) if (agent.includes(p)) out.push(p);
  for (const m of agent) if (!out.includes(m)) out.push(m);
  return out;
}

function countsModalitiesOrdered() {
  const ms = (Array.isArray(state.modalities) ? state.modalities.map(String) : ["ego", "infra", "vehicle", "traffic_light"]).filter((m) => hasModality(m));
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
  if (t === "VEHICLE" || t === "VRU" || t === "PEDESTRIAN" || t === "BICYCLE" || t === "OTHER" || t === "ANIMAL" || t === "RSU") return t;
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
  if (t === "VRU" && !state.types.VRU) return false;
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

  // Optional raster basemap (for datasets with geo origin but no HD map).
  drawBasemap(ctx, view, cssW, cssH, dpr);
  syncBasemapStatusUi();

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
  const drawAllTrails = !!(state.trailAll || !state.selectedKey);
  if (state.showTrail) {
    if (state.trailAll) {
      counts += " · Trajectories: all objects in frame";
    } else if (state.selectedKey && state.selectedKey.id != null) {
      counts += ` · Selected ${state.selectedKey.modality}:${state.selectedKey.id}`;
    } else {
      counts += " · Trajectories: all objects in frame (preview) · click a dot to lock selection";
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
    if (drawAllTrails) {
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
  if (sel) sel.innerHTML = "";
  state.datasetsById = {};
  const supportedIds = [];
  for (const ds of data.datasets || []) {
    if (!ds || !ds.id) continue;
    // Only surface datasets that the backend can actually serve (adapter exists).
    if (ds.supported === false) continue;
    state.datasetsById[ds.id] = ds;
    supportedIds.push(ds.id);
    const opt = document.createElement("option");
    opt.value = ds.id;
    opt.textContent = ds.title || ds.id;
    if (sel) sel.appendChild(opt);
  }

  const first = supportedIds.length ? supportedIds[0] : null;
  const last = localStorage.getItem(LS_LAST_DATASET);
  const preferred = (last && state.datasetsById[last]) ? last : first;
  if (preferred) {
    state.datasetId = preferred;
    if (sel) sel.value = preferred;
  }

  setHomeError("");

  applyDatasetUi();
  syncControlsFromState();
}

async function loadCatalog() {
  state.catalogById = {};
  state.catalogDatasets = [];
  try {
    const data = await fetchJson("/api/catalog");
    const items = Array.isArray(data.datasets) ? data.datasets : [];
    state.catalogDatasets = items;
    for (const it of items) {
      if (it && it.id) state.catalogById[String(it.id)] = it;
    }
  } catch (e) {
    // Catalog is optional; the app can still run with only /api/datasets.
    state.catalogById = {};
    state.catalogDatasets = [];
  }
}

async function loadProfiles() {
  state.profiles = [];
  try {
    const data = await fetchJson("/api/profiles");
    const items = Array.isArray(data.items) ? data.items : [];
    state.profiles = items;
  } catch (_) {
    state.profiles = [];
  }
}

function parseConnectPaths(raw) {
  const out = [];
  const seen = new Set();
  const lines = String(raw || "").split(/\r?\n/);
  for (const line of lines) {
    const s = String(line || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function cloneObj(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

function profileTypeLabel(datasetType) {
  const t = String(datasetType || "").toLowerCase();
  if (t === "v2x_traj") return "V2X-Traj";
  if (t === "v2x_seq") return "V2X-Seq";
  if (t === "consider_it_cpm") return "Consider.it CPM";
  if (!t) return "Unknown";
  return datasetType;
}

function profileStatusLabel(status) {
  const s = String(status || "");
  if (s === "ready") return "Ready";
  if (s === "ready_with_warnings") return "Ready (warnings)";
  if (s === "broken_path") return "Broken path";
  if (s === "schema_mismatch") return "Schema mismatch";
  return s || "Unknown";
}

function profileStatusTone(status) {
  const s = String(status || "");
  if (s === "ready") return "ok";
  if (s === "ready_with_warnings") return "warn";
  if (s === "broken_path" || s === "schema_mismatch") return "bad";
  return "";
}

function setConnectResult(msg, tone = "") {
  const el = $("homeConnectResult");
  if (!el) return;
  const m = String(msg || "").trim();
  if (!m) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("hint--ok", "hint--warn", "hint--bad");
    return;
  }
  el.hidden = false;
  el.textContent = m;
  el.classList.remove("hint--ok", "hint--warn", "hint--bad");
  if (tone === "ok") el.classList.add("hint--ok");
  else if (tone === "warn") el.classList.add("hint--warn");
  else if (tone === "bad") el.classList.add("hint--bad");
}

function datasetTypeFromFamily(family) {
  const fam = String(family || "").trim().toLowerCase();
  if (fam === "v2x-traj") return "v2x_traj";
  if (fam === "v2x-seq") return "v2x_seq";
  if (fam === "cpm-objects") return "consider_it_cpm";
  return "";
}

function datasetTypeFromMeta(meta) {
  if (!meta || typeof meta !== "object") return "";
  return datasetTypeFromFamily(meta.family);
}

function supportedLocalFamily(family) {
  const fam = String(family || "").trim().toLowerCase();
  return fam === "v2x-traj" || fam === "v2x-seq" || fam === "cpm-objects";
}

function virtualDatasetMeta(datasetId, title, family) {
  const fam = String(family || "").trim().toLowerCase();
  const base = {
    id: String(datasetId || "").trim(),
    title: String(title || datasetId || "").trim() || "Dataset",
    family: fam,
    supported: false,
    virtual: true,
  };
  if (fam === "v2x-traj") {
    return {
      ...base,
      splits: ["train", "val"],
      default_split: "train",
      group_label: "Intersection",
      has_map: true,
      has_traffic_lights: true,
      modalities: ["ego", "infra", "vehicle", "traffic_light"],
      modality_labels: { ego: "Ego vehicle", infra: "Infrastructure", vehicle: "Other vehicles", traffic_light: "Traffic lights" },
      modality_short_labels: { ego: "Ego", infra: "Infra", vehicle: "Vehicles", traffic_light: "Lights" },
    };
  }
  if (fam === "v2x-seq") {
    return {
      ...base,
      splits: ["train", "val"],
      default_split: "val",
      group_label: "Intersection",
      has_map: true,
      has_traffic_lights: true,
      modalities: ["ego", "infra", "vehicle", "traffic_light"],
      modality_labels: {
        ego: "Cooperative vehicle-infrastructure",
        infra: "Single infrastructure",
        vehicle: "Single vehicle",
        traffic_light: "Traffic lights",
      },
      modality_short_labels: { ego: "Coop", infra: "Infra", vehicle: "Vehicle", traffic_light: "Lights" },
    };
  }
  if (fam === "cpm-objects") {
    return {
      ...base,
      splits: ["all"],
      default_split: "all",
      group_label: "Sensor",
      has_map: false,
      has_traffic_lights: false,
      modalities: ["infra"],
      modality_labels: { infra: "Objects" },
      modality_short_labels: { infra: "Objects" },
    };
  }
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

function ensureDatasetMetaForCard(datasetId) {
  const did = String(datasetId || "").trim();
  if (!did) return null;
  if (state.datasetsById && state.datasetsById[did]) return state.datasetsById[did];
  const cat = (state.catalogById && state.catalogById[did]) ? state.catalogById[did] : null;
  if (!cat || typeof cat !== "object") return null;
  const app = (cat.app && typeof cat.app === "object") ? cat.app : {};
  const family = String(app.family || "").trim().toLowerCase();
  if (!supportedLocalFamily(family)) return null;
  const meta = virtualDatasetMeta(did, cat.title || did, family);
  state.datasetsById[did] = meta;
  const sel = $("datasetSelect");
  if (sel && !Array.from(sel.options || []).some((o) => String(o.value) === did)) {
    const opt = document.createElement("option");
    opt.value = did;
    opt.textContent = meta.title || did;
    sel.appendChild(opt);
  }
  return meta;
}

function runtimeProfilePreset(datasetType, meta) {
  const t = String(datasetType || "").trim();
  const m = (meta && typeof meta === "object") ? meta : {};
  const selectedDatasetId = String(m.id || "").trim();
  const selectedTitle = String(m.title || "").trim();
  const safeFromId = selectedDatasetId ? selectedDatasetId.replace(/[^a-zA-Z0-9_-]+/g, "-") : "";
  if (t === "v2x_traj") {
    const datasetId = selectedDatasetId || "v2x-traj";
    const safe = safeFromId || "v2x-traj";
    return {
      profile_id: `runtime-${safe}`,
      dataset_id: datasetId,
      name: selectedTitle || "V2X-Traj",
    };
  }
  if (t === "v2x_seq") {
    const datasetId = selectedDatasetId || "v2x-seq";
    const safe = safeFromId || "v2x-seq";
    return {
      profile_id: `runtime-${safe}`,
      dataset_id: datasetId,
      name: selectedTitle || "V2X-Seq",
    };
  }
  if (t === "consider_it_cpm") {
    const datasetId = selectedDatasetId || "consider-it-cpm";
    const safe = safeFromId || "consider-it-cpm";
    return {
      profile_id: `runtime-${safe}`,
      dataset_id: datasetId,
      name: selectedTitle || "Consider.it (CPM Objects)",
    };
  }
  const safe = safeFromId || "dataset";
  return {
    profile_id: `runtime-${safe}`,
    dataset_id: selectedDatasetId || "runtime-dataset",
    name: selectedTitle || "Dataset",
  };
}

function sourceState(datasetType) {
  const key = String(datasetType || "");
  if (!state.sourceByType[key]) {
    state.sourceByType[key] = {
      folderPath: "",
      folderName: "",
      protoPath: "",
      hint: "",
      tone: "",
    };
  }
  return state.sourceByType[key];
}

function hasLoadedSourceForMeta(meta) {
  const datasetType = datasetTypeFromMeta(meta || {});
  if (!datasetType) return false;
  const src = sourceState(datasetType);
  return !!String(src.folderPath || "").trim();
}

function isDesktopPickerAvailable(methodName) {
  const api = window.pywebview && window.pywebview.api ? window.pywebview.api : null;
  return !!(api && typeof api[methodName] === "function");
}

async function pickPathsDesktop(methodName, fallbackPrompt) {
  if (isDesktopPickerAvailable(methodName)) {
    try {
      const raw = await window.pywebview.api[methodName]();
      const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      return arr.map((x) => String(x || "").trim()).filter(Boolean);
    } catch (_) {
      // Fall through to manual fallback.
    }
  }

  // Web mode: ask the local backend to open a native folder picker (macOS).
  if (methodName === "pick_folder") {
    try {
      const payload = await postJson("/api/system/pick_folder", {
        prompt: String(fallbackPrompt || "Select dataset directory"),
      });
      if (payload && Array.isArray(payload.paths)) {
        return payload.paths.map((x) => String(x || "").trim()).filter(Boolean);
      }
    } catch (_) {
      // Fall through to manual prompt only if server-side picker is unavailable.
    }
  }

  const raw = window.prompt(fallbackPrompt, "");
  if (raw == null) return [];
  return parseConnectPaths(raw);
}

function folderNameFromPath(pathStr) {
  const s = String(pathStr || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!s) return "";
  const parts = s.split("/");
  return parts[parts.length - 1] || s;
}

function updateSourcePanel() {
  const meta = currentDatasetMeta() || {};
  const datasetType = datasetTypeFromMeta(meta);
  const src = sourceState(datasetType);
  const sourceHintEl = $("sourceHint");
  const sourceCard = $("sourceCard");
  const sourceCardTitle = $("sourceCardTitle");
  const sourceCardPath = $("sourceCardPath");
  const folderBtn = $("sourceFolderBtn");
  if (!sourceHintEl) return;

  const busy = !!state.sourceBusy;
  if (folderBtn) {
    folderBtn.disabled = busy || !datasetType;
    folderBtn.textContent = busy ? "Loading..." : "Load dataset directory...";
  }

  let msg = String(src.hint || "").trim();
  let tone = String(src.tone || "").trim();
  if (!datasetType) {
    msg = "This dataset is not yet supported for local loading.";
    tone = "bad";
  } else if (!msg && busy) {
    msg = "Loading dataset directory...";
  } else if (!msg && !src.folderPath) {
    msg = "Select a dataset directory to load scenes.";
    tone = "warn";
  } else if (!msg && Number(state.sceneTotal || 0) <= 0) {
    msg = "Directory loaded, but no scenes were found.";
    tone = "warn";
  } else if (!msg) {
    msg = "Source loaded.";
    tone = "ok";
  }
  sourceHintEl.textContent = msg;
  sourceHintEl.classList.remove("hint--ok", "hint--warn", "hint--bad");
  if (tone === "ok") sourceHintEl.classList.add("hint--ok");
  else if (tone === "warn") sourceHintEl.classList.add("hint--warn");
  else if (tone === "bad") sourceHintEl.classList.add("hint--bad");

  if (sourceCard && sourceCardTitle && sourceCardPath) {
    const hasFolder = !!String(src.folderPath || "").trim();
    sourceCard.hidden = !hasFolder;
    if (hasFolder) {
      const dsName = String(meta.title || meta.id || "Dataset").trim();
      const folderName = String(src.folderName || folderNameFromPath(src.folderPath) || "dataset").trim();
      sourceCardTitle.textContent = `${dsName} · ${folderName}`;
      sourceCardPath.textContent = String(src.folderPath || "").trim();
    } else {
      sourceCardTitle.textContent = "Dataset folder";
      sourceCardPath.textContent = "";
    }
  }
}

function sourceIssueMessage(validation) {
  const errors = Array.isArray(validation && validation.errors) ? validation.errors : [];
  const warnings = Array.isArray(validation && validation.warnings) ? validation.warnings : [];
  if (errors.length) return String(errors[0].message || "Validation failed.");
  if (warnings.length) return String(warnings[0].message || "Validation warning.");
  return "";
}

async function loadDatasetFromFolder(folderPathIn) {
  const meta = currentDatasetMeta() || {};
  const datasetType = datasetTypeFromMeta(meta);
  if (!datasetType) {
    setConnectResult("This dataset family does not support local loading yet.", "bad");
    return;
  }
  const folderPath = String(folderPathIn || "").trim();
  if (!folderPath) {
    setConnectResult("No dataset directory selected.", "bad");
    return;
  }

  const src = sourceState(datasetType);
  const preset = runtimeProfilePreset(datasetType, meta);
  state.sourceBusy = true;
  src.hint = "Detecting dataset schema...";
  src.tone = "";
  updateSourcePanel();

  try {
    const detected = await postJson("/api/profiles/detect", {
      dataset_type: datasetType,
      name: preset.name,
      paths: [folderPath],
    });
    if (!detected || !detected.profile) {
      throw new Error("Could not detect dataset profile from selected paths.");
    }
    const profile = cloneObj(detected.profile);
    profile.profile_id = preset.profile_id;
    profile.dataset_id = preset.dataset_id;
    profile.name = preset.name;

    const validated = await postJson("/api/profiles/validate", { profile });
    const status = String(((validated && validated.validation) ? validated.validation.status : "") || "");
    if (status !== "ready" && status !== "ready_with_warnings") {
      const detail = sourceIssueMessage(validated && validated.validation);
      throw new Error(detail || "Validation failed for selected source paths.");
    }

    const saved = await postJson("/api/profiles/save", { profile: validated.profile });
    await loadDatasets();
    await loadProfiles();
    renderHomeCategoryOptions();
    renderHomeDatasetCards();

    const runtimeDatasetId = String(((saved && saved.profile) ? saved.profile.dataset_id : "") || preset.dataset_id);
    src.folderPath = folderPath;
    src.folderName = folderNameFromPath(folderPath);
    const savedProto = ((((saved || {}).profile || {}).bindings || {}).proto_schema || {}).path;
    src.protoPath = savedProto ? String(savedProto || "").trim() : "";
    src.hint = status === "ready_with_warnings"
      ? `Loaded with warnings: ${sourceIssueMessage(validated.validation) || "check mapping."}`
      : "Dataset source loaded.";
    src.tone = status === "ready_with_warnings" ? "warn" : "ok";

    await openExplorerForDataset(runtimeDatasetId, { savePrev: false });
    setConnectResult(src.hint, src.tone);
  } catch (e) {
    const msg = `Load failed: ${e && e.message ? e.message : String(e)}`;
    src.hint = msg;
    src.tone = "bad";
    setConnectResult(msg, "bad");
  } finally {
    state.sourceBusy = false;
    updateSourcePanel();
  }
}

function setHint(id, msg, tone = "") {
  const el = $(id);
  if (!el) return;
  const m = String(msg || "").trim();
  if (!m) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("hint--ok", "hint--warn", "hint--bad");
    return;
  }
  el.hidden = false;
  el.textContent = m;
  el.classList.remove("hint--ok", "hint--warn", "hint--bad");
  if (tone === "ok") el.classList.add("hint--ok");
  else if (tone === "warn") el.classList.add("hint--warn");
  else if (tone === "bad") el.classList.add("hint--bad");
}

function getElValue(id) {
  const el = $(id);
  if (!el) return "";
  return String(el.value || "").trim();
}

function setElValue(id, value) {
  const el = $(id);
  if (!el) return;
  el.value = String(value || "");
}

function parseIntClamp(raw, fallback, minV, maxV) {
  const n = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, minV, maxV);
}

function wizardSelectedDatasetType() {
  const selected = getElValue("wizType");
  if (selected === "v2x_traj" || selected === "v2x_seq" || selected === "consider_it_cpm") return selected;
  const draftType = String(((state.profileWizard.draft || {}).profile || {}).dataset_type || "").trim();
  if (draftType === "v2x_traj" || draftType === "v2x_seq" || draftType === "consider_it_cpm") return draftType;
  return "";
}

function getBindingPath(profile, role) {
  if (!profile || typeof profile !== "object") return "";
  const b = profile.bindings && typeof profile.bindings === "object" ? profile.bindings : {};
  const obj = b[role];
  if (!obj || typeof obj !== "object") return "";
  return String(obj.path || "").trim();
}

function getBindingPaths(profile, role) {
  if (!profile || typeof profile !== "object") return [];
  const b = profile.bindings && typeof profile.bindings === "object" ? profile.bindings : {};
  const obj = b[role];
  if (!obj || typeof obj !== "object") return [];
  const arr = Array.isArray(obj.paths) ? obj.paths : [];
  return arr.map((x) => String(x || "").trim()).filter(Boolean);
}

function setBindingPath(bindings, role, path, required, kind) {
  const prev = bindings[role] && typeof bindings[role] === "object" ? bindings[role] : {};
  const p = String(path || "").trim();
  if (!p && !required) {
    delete bindings[role];
    return;
  }
  bindings[role] = {
    ...prev,
    kind: kind,
    required: !!required,
    path: p,
  };
}

function setWizardFromProfile(profile) {
  if (!profile || typeof profile !== "object") return;
  const datasetType = String(profile.dataset_type || "").trim();
  setElValue("wizType", datasetType || "auto");
  setElValue("wizName", String(profile.name || ""));
  setElValue("wizPaths", Array.isArray(profile.roots) ? profile.roots.join("\n") : "");

  setElValue("wizV2xScenes", getBindingPath(profile, "scenes_index"));
  setElValue(
    "wizV2xEgo",
    datasetType === "v2x_seq" ? (getBindingPath(profile, "traj_cooperative") || getBindingPath(profile, "traj_ego")) : getBindingPath(profile, "traj_ego")
  );
  setElValue("wizV2xInfra", getBindingPath(profile, "traj_infra"));
  setElValue("wizV2xVehicle", getBindingPath(profile, "traj_vehicle"));
  setElValue("wizV2xTl", getBindingPath(profile, "traffic_light"));
  setElValue("wizV2xMaps", getBindingPath(profile, "maps_dir"));

  setElValue("wizCpmLogs", getBindingPaths(profile, "cpm_logs").join("\n"));
  setElValue("wizCpmProto", getBindingPath(profile, "proto_schema"));
  const sceneStrategy = profile.scene_strategy && typeof profile.scene_strategy === "object" ? profile.scene_strategy : {};
  setElValue("wizCpmWindow", Number.isFinite(Number(sceneStrategy.window_s)) ? Number(sceneStrategy.window_s) : 300);
  setElValue("wizCpmGap", Number.isFinite(Number(sceneStrategy.gap_s)) ? Number(sceneStrategy.gap_s) : 120);
  const cpmLogs = profile.bindings && profile.bindings.cpm_logs && typeof profile.bindings.cpm_logs === "object"
    ? profile.bindings.cpm_logs
    : {};
  const colMap = cpmLogs.column_map && typeof cpmLogs.column_map === "object" ? cpmLogs.column_map : {};
  setElValue("wizCpmColTs", String(colMap.generationTime_ms || ""));
  setElValue("wizCpmColId", String(colMap.objectID || ""));
  setElValue("wizCpmColX", String(colMap.xDistance_m || ""));
  setElValue("wizCpmColY", String(colMap.yDistance_m || ""));
  setElValue("wizCpmColVx", String(colMap.xSpeed_mps || ""));
  setElValue("wizCpmColVy", String(colMap.ySpeed_mps || ""));
  setElValue("wizCpmColYaw", String(colMap.yawAngle_deg || ""));
  setElValue("wizCpmColClass", String(colMap.classificationType || ""));
}

function applyWizardDatasetBlocks() {
  const datasetType = wizardSelectedDatasetType();
  const v2x = $("wizMapV2x");
  const cpm = $("wizMapCpm");
  if (v2x) v2x.hidden = !(datasetType === "v2x_traj" || datasetType === "v2x_seq");
  if (cpm) cpm.hidden = datasetType !== "consider_it_cpm";
}

function buildProfileFromWizardInputs() {
  const wiz = state.profileWizard;
  const base = wiz.draft && wiz.draft.profile ? cloneObj(wiz.draft.profile) : {};
  const selectedType = getElValue("wizType");
  const datasetType = selectedType === "auto" ? String(base.dataset_type || "").trim() : selectedType;
  const name = getElValue("wizName");
  const roots = parseConnectPaths(getElValue("wizPaths"));
  const profile = {
    ...base,
    name: name || String(base.name || "Dataset Profile"),
    dataset_type: datasetType,
    roots: roots,
    bindings: base.bindings && typeof base.bindings === "object" ? { ...base.bindings } : {},
  };
  const bindings = profile.bindings;

  if (datasetType === "v2x_traj") {
    profile.scene_strategy = { mode: "intersection_scene" };
    setBindingPath(bindings, "scenes_index", getElValue("wizV2xScenes"), true, "file");
    setBindingPath(bindings, "traj_ego", getElValue("wizV2xEgo"), true, "dir");
    setBindingPath(bindings, "traj_infra", getElValue("wizV2xInfra"), true, "dir");
    setBindingPath(bindings, "traj_vehicle", getElValue("wizV2xVehicle"), true, "dir");
    setBindingPath(bindings, "traffic_light", getElValue("wizV2xTl"), false, "dir");
    setBindingPath(bindings, "maps_dir", getElValue("wizV2xMaps"), false, "dir");
    delete bindings.traj_cooperative;
    delete bindings.cpm_logs;
    delete bindings.proto_schema;
  }

  if (datasetType === "v2x_seq") {
    profile.scene_strategy = { mode: "sequence_scene" };
    setBindingPath(bindings, "traj_cooperative", getElValue("wizV2xEgo"), false, "dir");
    setBindingPath(bindings, "traj_infra", getElValue("wizV2xInfra"), false, "dir");
    setBindingPath(bindings, "traj_vehicle", getElValue("wizV2xVehicle"), false, "dir");
    setBindingPath(bindings, "traffic_light", getElValue("wizV2xTl"), false, "dir");
    setBindingPath(bindings, "maps_dir", getElValue("wizV2xMaps"), false, "dir");
    delete bindings.scenes_index;
    delete bindings.traj_ego;
    delete bindings.cpm_logs;
    delete bindings.proto_schema;
  }

  if (datasetType === "consider_it_cpm") {
    const prevLogs = bindings.cpm_logs && typeof bindings.cpm_logs === "object" ? bindings.cpm_logs : {};
    const logPaths = parseConnectPaths(getElValue("wizCpmLogs"));
    const columnMap = {};
    const tsCol = getElValue("wizCpmColTs");
    const idCol = getElValue("wizCpmColId");
    const xCol = getElValue("wizCpmColX");
    const yCol = getElValue("wizCpmColY");
    const vxCol = getElValue("wizCpmColVx");
    const vyCol = getElValue("wizCpmColVy");
    const yawCol = getElValue("wizCpmColYaw");
    const clsCol = getElValue("wizCpmColClass");
    if (tsCol) columnMap.generationTime_ms = tsCol;
    if (idCol) columnMap.objectID = idCol;
    if (xCol) columnMap.xDistance_m = xCol;
    if (yCol) columnMap.yDistance_m = yCol;
    if (vxCol) columnMap.xSpeed_mps = vxCol;
    if (vyCol) columnMap.ySpeed_mps = vyCol;
    if (yawCol) columnMap.yawAngle_deg = yawCol;
    if (clsCol) columnMap.classificationType = clsCol;
    bindings.cpm_logs = {
      ...prevLogs,
      kind: "file_list",
      required: true,
      paths: logPaths,
    };
    if (Object.keys(columnMap).length) bindings.cpm_logs.column_map = columnMap;
    else delete bindings.cpm_logs.column_map;

    const protoPath = getElValue("wizCpmProto");
    setBindingPath(bindings, "proto_schema", protoPath, false, "file");
    const windowS = parseIntClamp(getElValue("wizCpmWindow"), 300, 1, 86400);
    const gapS = parseIntClamp(getElValue("wizCpmGap"), 120, 0, 86400);
    profile.scene_strategy = { mode: "time_window", window_s: windowS, gap_s: gapS };
    delete bindings.scenes_index;
    delete bindings.traj_ego;
    delete bindings.traj_cooperative;
    delete bindings.traj_infra;
    delete bindings.traj_vehicle;
    delete bindings.traffic_light;
    delete bindings.maps_dir;
  }

  return profile;
}

function syncProfileWizardUi() {
  const wiz = state.profileWizard;
  const modal = $("profileWizardModal");
  if (!modal) return;

  modal.hidden = !wiz.open;
  modal.setAttribute("aria-hidden", wiz.open ? "false" : "true");
  if (!wiz.open) return;

  const title = $("profileWizardTitle");
  const sub = $("profileWizardSub");
  if (title) title.textContent = wiz.mode === "edit" ? "Edit Connection" : "New Connection";
  if (sub) sub.textContent = `Step ${wiz.step} of 3`;

  const step1 = $("wizStep1");
  const step2 = $("wizStep2");
  const step3 = $("wizStep3");
  if (step1) step1.hidden = wiz.step !== 1;
  if (step2) step2.hidden = wiz.step !== 2;
  if (step3) step3.hidden = wiz.step !== 3;

  const chips = [["wizStepChip1", 1], ["wizStepChip2", 2], ["wizStepChip3", 3]];
  for (const [id, stepNum] of chips) {
    const chip = $(id);
    if (!chip) continue;
    chip.classList.remove("wizardStep--active", "wizardStep--done");
    if (stepNum === wiz.step) chip.classList.add("wizardStep--active");
    if (stepNum < wiz.step) chip.classList.add("wizardStep--done");
  }

  applyWizardDatasetBlocks();

  const prevBtn = $("wizPrevBtn");
  const nextBtn = $("wizNextBtn");
  const saveBtn = $("wizSaveBtn");
  const detectBtn = $("wizDetectBtn");
  const validateBtn = $("wizValidateBtn");
  if (prevBtn) prevBtn.disabled = wiz.busy || wiz.step <= 1;
  if (nextBtn) {
    nextBtn.hidden = wiz.step >= 3;
    nextBtn.disabled = wiz.busy;
    nextBtn.textContent = wiz.step === 2 ? "Validate + Continue" : "Next";
  }
  if (saveBtn) {
    saveBtn.hidden = wiz.step !== 3;
    const status = String(((wiz.draft || {}).validation || {}).status || "");
    const canSave = !wiz.busy && (status === "ready" || status === "ready_with_warnings");
    saveBtn.disabled = !canSave;
    saveBtn.textContent = wiz.busy && wiz.action === "save" ? "Saving..." : "Save Connection";
  }
  if (detectBtn) {
    detectBtn.disabled = wiz.busy;
    detectBtn.textContent = wiz.busy && wiz.action === "detect" ? "Detecting..." : "Detect + Validate";
  }
  if (validateBtn) {
    validateBtn.disabled = wiz.busy;
    validateBtn.textContent = wiz.busy && wiz.action === "validate" ? "Validating..." : "Validate Mapping";
  }
  if (wiz.step === 3) renderWizardReview();
}

function openProfileWizard(mode = "create", payload = null) {
  state.profileWizard = {
    open: true,
    mode: mode === "edit" ? "edit" : "create",
    step: 1,
    busy: false,
    action: "",
    draft: null,
    profileId: "",
  };
  setHint("wizDetectResult", "");
  setHint("wizValidateResult", "");
  setConnectResult("");

  if (payload && payload.profile && typeof payload.profile === "object") {
    const draft = {
      ok: true,
      profile: cloneObj(payload.profile),
      validation: payload.validation && typeof payload.validation === "object" ? cloneObj(payload.validation) : {},
      capabilities: payload.capabilities && typeof payload.capabilities === "object" ? cloneObj(payload.capabilities) : {},
    };
    state.profileWizard.draft = draft;
    state.profileWizard.profileId = String(payload.profile.profile_id || "");
    setWizardFromProfile(draft.profile);
    const validationStatus = String((draft.validation || {}).status || "");
    if (validationStatus) {
      setHint("wizDetectResult", `Current profile status: ${profileStatusLabel(validationStatus)}.`, profileStatusTone(validationStatus));
    }
  } else {
    setElValue("wizType", "auto");
    setElValue("wizName", "");
    setElValue("wizPaths", "");
    setElValue("wizV2xScenes", "");
    setElValue("wizV2xEgo", "");
    setElValue("wizV2xInfra", "");
    setElValue("wizV2xVehicle", "");
    setElValue("wizV2xTl", "");
    setElValue("wizV2xMaps", "");
    setElValue("wizCpmLogs", "");
    setElValue("wizCpmProto", "");
    setElValue("wizCpmWindow", "300");
    setElValue("wizCpmGap", "120");
    setElValue("wizCpmColTs", "");
    setElValue("wizCpmColId", "");
    setElValue("wizCpmColX", "");
    setElValue("wizCpmColY", "");
    setElValue("wizCpmColVx", "");
    setElValue("wizCpmColVy", "");
    setElValue("wizCpmColYaw", "");
    setElValue("wizCpmColClass", "");
  }
  syncProfileWizardUi();
}

function closeProfileWizard() {
  state.profileWizard.open = false;
  state.profileWizard.busy = false;
  state.profileWizard.action = "";
  syncProfileWizardUi();
}

function renderWizardReview() {
  const wiz = state.profileWizard;
  const box = $("wizReviewSummary");
  const issuesEl = $("wizReviewIssues");
  if (!box || !issuesEl) return;
  const draft = wiz.draft || {};
  const profile = draft.profile && typeof draft.profile === "object" ? draft.profile : {};
  const validation = draft.validation && typeof draft.validation === "object" ? draft.validation : {};
  const status = String(validation.status || "");
  const detectorScore = Number(((profile.detector || {}).score));
  const scoreText = Number.isFinite(detectorScore) ? detectorScore.toFixed(1) : "?";

  const summaryRows = [];
  summaryRows.push(`<b>Name:</b> ${escapeHtml(String(profile.name || "?"))}`);
  summaryRows.push(`<b>Type:</b> ${escapeHtml(profileTypeLabel(profile.dataset_type || ""))}`);
  summaryRows.push(`<b>Status:</b> ${escapeHtml(profileStatusLabel(status))}`);
  summaryRows.push(`<b>Detection score:</b> ${escapeHtml(scoreText)}`);
  summaryRows.push(`<b>Dataset ID:</b> ${escapeHtml(String(profile.dataset_id || "(auto)"))}`);
  box.innerHTML = summaryRows.map((x) => `<div>${x}</div>`).join("");

  const errors = Array.isArray(validation.errors) ? validation.errors : [];
  const warnings = Array.isArray(validation.warnings) ? validation.warnings : [];
  const nodes = [];
  for (const issue of errors) {
    const msg = String(issue && issue.message ? issue.message : "Validation error.");
    const role = issue && issue.role ? ` (${String(issue.role)})` : "";
    nodes.push(`<div class="wizardIssue wizardIssue--bad"><b>Error${escapeHtml(role)}:</b> ${escapeHtml(msg)}</div>`);
  }
  for (const issue of warnings) {
    const msg = String(issue && issue.message ? issue.message : "Validation warning.");
    const role = issue && issue.role ? ` (${String(issue.role)})` : "";
    nodes.push(`<div class="wizardIssue wizardIssue--warn"><b>Warning${escapeHtml(role)}:</b> ${escapeHtml(msg)}</div>`);
  }
  issuesEl.innerHTML = nodes.length ? nodes.join("") : `<div class="wizardIssue">No validation issues.</div>`;
}

async function wizardDetect() {
  const wiz = state.profileWizard;
  const selectedType = getElValue("wizType");
  const datasetType = selectedType === "auto" ? null : selectedType;
  const name = getElValue("wizName");
  const paths = parseConnectPaths(getElValue("wizPaths"));
  if (!paths.length) {
    setHint("wizDetectResult", "Add at least one folder or file path.", "bad");
    return false;
  }

  const prevProfile = wiz.draft && wiz.draft.profile ? wiz.draft.profile : {};
  const keepProfileId = String(wiz.profileId || prevProfile.profile_id || "");
  const keepDatasetId = String(prevProfile.dataset_id || "");

  wiz.busy = true;
  wiz.action = "detect";
  syncProfileWizardUi();
  try {
    const payload = { dataset_type: datasetType, name, paths };
    const data = await postJson("/api/profiles/detect", payload);
    if (data && data.profile && typeof data.profile === "object") {
      if (keepProfileId) data.profile.profile_id = keepProfileId;
      if (keepDatasetId) data.profile.dataset_id = keepDatasetId;
      wiz.profileId = String(data.profile.profile_id || keepProfileId || "");
      setWizardFromProfile(data.profile);
    }
    wiz.draft = data || null;
    state.connectDraft = wiz.draft;

    const validation = data && data.validation ? data.validation : {};
    const status = String(validation.status || "");
    const tone = profileStatusTone(status);
    const score = Number(((data && data.profile && data.profile.detector) ? data.profile.detector.score : NaN));
    const scoreText = Number.isFinite(score) ? score.toFixed(1) : "?";
    setHint("wizDetectResult", `Detected ${profileTypeLabel((data && data.profile && data.profile.dataset_type) || "")} (score ${scoreText}) · ${profileStatusLabel(status)}`, tone);
    applyWizardDatasetBlocks();
    return true;
  } catch (e) {
    wiz.draft = null;
    setHint("wizDetectResult", `Detect failed: ${e && e.message ? e.message : String(e)}`, "bad");
    return false;
  } finally {
    wiz.busy = false;
    wiz.action = "";
    syncProfileWizardUi();
  }
}

async function wizardValidate() {
  const wiz = state.profileWizard;
  const profile = buildProfileFromWizardInputs();
  if (wiz.profileId) profile.profile_id = wiz.profileId;
  if (!profile.dataset_id && wiz.draft && wiz.draft.profile && wiz.draft.profile.dataset_id) {
    profile.dataset_id = wiz.draft.profile.dataset_id;
  }

  wiz.busy = true;
  wiz.action = "validate";
  syncProfileWizardUi();
  try {
    const data = await postJson("/api/profiles/validate", { profile });
    wiz.draft = data || null;
    state.connectDraft = wiz.draft;
    if (data && data.profile && typeof data.profile === "object") {
      wiz.profileId = String(data.profile.profile_id || wiz.profileId || "");
      setWizardFromProfile(data.profile);
    }
    const validation = data && data.validation ? data.validation : {};
    const status = String(validation.status || "");
    const tone = profileStatusTone(status);
    const errors = Array.isArray(validation.errors) ? validation.errors : [];
    const warnings = Array.isArray(validation.warnings) ? validation.warnings : [];
    if (status === "ready") {
      setHint("wizValidateResult", "Mapping is valid and ready to save.", "ok");
    } else if (status === "ready_with_warnings") {
      const msg = warnings.length ? String(warnings[0].message || "Validation has warnings.") : "Validation has warnings.";
      setHint("wizValidateResult", msg, "warn");
    } else {
      const msg = errors.length ? String(errors[0].message || "Validation failed.") : "Validation failed.";
      setHint("wizValidateResult", msg, "bad");
    }
    return tone === "ok" || status === "ready_with_warnings";
  } catch (e) {
    setHint("wizValidateResult", `Validate failed: ${e && e.message ? e.message : String(e)}`, "bad");
    return false;
  } finally {
    wiz.busy = false;
    wiz.action = "";
    syncProfileWizardUi();
  }
}

async function refreshHomeAfterProfileChange() {
  await loadDatasets();
  await loadProfiles();
  renderHomeCategoryOptions();
  renderHomeDatasetCards();
  renderHomeProfilesList();
}

async function saveConnectionProfileFromWizard() {
  const wiz = state.profileWizard;
  const ready = await wizardValidate();
  if (!ready) {
    setConnectResult("Fix validation errors before saving.", "bad");
    if (wiz.step !== 2) wiz.step = 2;
    syncProfileWizardUi();
    return;
  }
  if (!wiz.draft || !wiz.draft.profile) {
    setConnectResult("No profile to save.", "bad");
    return;
  }

  wiz.busy = true;
  wiz.action = "save";
  syncProfileWizardUi();
  try {
    const payload = await postJson("/api/profiles/save", { profile: wiz.draft.profile });
    const saved = payload && payload.profile ? payload.profile : null;
    await refreshHomeAfterProfileChange();
    if (saved && saved.dataset_id) {
      setConnectResult(`Saved profile: ${saved.name} (${saved.dataset_id}).`, "ok");
    } else {
      setConnectResult("Profile saved.", "ok");
    }
    closeProfileWizard();
  } catch (e) {
    setConnectResult(`Save failed: ${e && e.message ? e.message : String(e)}`, "bad");
  } finally {
    wiz.busy = false;
    wiz.action = "";
    syncProfileWizardUi();
  }
}

async function openProfileWizardForEdit(profileId) {
  const pid = String(profileId || "").trim();
  if (!pid) return;
  setConnectResult("");
  try {
    const payload = await fetchJson(`/api/profiles/${encodeURIComponent(pid)}`);
    openProfileWizard("edit", payload);
  } catch (e) {
    setConnectResult(`Could not load profile: ${e && e.message ? e.message : String(e)}`, "bad");
  }
}

async function deleteConnectionProfile(profileId) {
  const pid = String(profileId || "").trim();
  if (!pid) return;
  if (!window.confirm("Delete this connection profile?")) return;
  try {
    await postJson("/api/profiles/delete", { profile_id: pid });
    await refreshHomeAfterProfileChange();
    setConnectResult("Profile deleted.", "ok");
  } catch (e) {
    setConnectResult(`Delete failed: ${e && e.message ? e.message : String(e)}`, "bad");
  }
}

async function setDefaultConnectionProfile(profileId) {
  const pid = String(profileId || "").trim();
  if (!pid) return;
  try {
    await postJson("/api/profiles/default", { profile_id: pid });
    await refreshHomeAfterProfileChange();
    setConnectResult("Default profile updated.", "ok");
  } catch (e) {
    setConnectResult(`Set default failed: ${e && e.message ? e.message : String(e)}`, "bad");
  }
}

function renderHomeProfilesList() {
  const wrap = $("homeProfilesList");
  if (!wrap) return;
  const items = Array.isArray(state.profiles) ? state.profiles : [];
  if (!items.length) {
    wrap.innerHTML = `<div class="profileEmpty">No connection profiles yet. Add one to map local dataset files to app roles.</div>`;
    return;
  }

  wrap.innerHTML = items
    .map((p) => {
      const profileId = String(p.profile_id || "");
      const datasetId = String(p.dataset_id || "");
      const isDefault = !!p.is_default;
      const status = String(p.status || "");
      const tone = profileStatusTone(status);
      const statusClass = tone === "ok" ? "chip chip--yes" : tone === "bad" ? "chip chip--no" : "chip";
      const openBtn = datasetId && state.datasetsById[datasetId]
        ? `<button class="btn btn--ghost btn--sm" type="button" data-open-profile-dataset="${escapeHtml(datasetId)}">Open</button>`
        : "";
      const defaultChip = isDefault ? `<span class="chip chip--default">Default</span>` : "";
      const defaultBtn = isDefault
        ? ""
        : `<button class="btn btn--ghost btn--sm" type="button" data-set-default-profile="${escapeHtml(profileId)}">Set default</button>`;
      return `
        <div class="profileRow">
          <div class="profileRow__main">
            <div class="profileRow__name">${escapeHtml(String(p.name || profileId || "Profile"))}</div>
            <div class="profileRow__meta">${escapeHtml(profileTypeLabel(p.dataset_type))} · ${escapeHtml(datasetId || "no dataset id")}</div>
          </div>
          <div class="profileActions">
            ${defaultChip}
            <span class="${statusClass}">${escapeHtml(profileStatusLabel(status))}</span>
            ${openBtn}
            <button class="btn btn--ghost btn--sm" type="button" data-edit-profile="${escapeHtml(profileId)}">Edit</button>
            ${defaultBtn}
            <button class="btn btn--sm btn--danger" type="button" data-delete-profile="${escapeHtml(profileId)}">Delete</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function yesNoChip(label, v) {
  const vv = (v === true) ? "Yes" : (v === false) ? "No" : "?";
  const cls = (v === true) ? "chip chip--yes" : (v === false) ? "chip chip--no" : "chip";
  return `<span class="${cls}">${escapeHtml(label)}: ${escapeHtml(vv)}</span>`;
}

function prettyCategoryLabel(s) {
  const v = String(s || "").trim();
  if (!v) return null;
  return v.slice(0, 1).toUpperCase() + v.slice(1);
}

function renderHomeCategoryOptions() {
  const sel = $("homeCategory");
  if (!sel) return;
  const cur = String(state.homeCategory || "");
  const cats = new Set();
  for (const it of state.catalogDatasets || []) {
    if (it && it.category) cats.add(String(it.category));
  }
  const ordered = Array.from(cats).sort((a, b) => a.localeCompare(b));
  sel.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All";
  sel.appendChild(all);
  for (const c of ordered) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = prettyCategoryLabel(c) || c;
    sel.appendChild(opt);
  }
  const keep = cur && ordered.includes(cur);
  state.homeCategory = keep ? cur : "";
  sel.value = state.homeCategory;
}

function renderHomeDatasetCards() {
  const wrap = $("homeDatasetCards");
  if (!wrap) return;

  const q = String(state.homeSearch || "").trim().toLowerCase();
  const catFilter = String(state.homeCategory || "").trim();
  const mapFilter = String(state.homeHasMap || "").trim();
  const tlFilter = String(state.homeHasTL || "").trim();
  const sortMode = String(state.homeSort || "available").trim();

  // Start from the catalog (if present), then append any locally configured datasets
  // that don't have a catalog entry yet.
  let items = Array.isArray(state.catalogDatasets) ? [...state.catalogDatasets] : [];
  const seen = new Set(items.map((it) => String(it && it.id ? it.id : "")));
  for (const ds of Object.values(state.datasetsById || {})) {
    if (!ds || !ds.id) continue;
    const id = String(ds.id);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      title: ds.title || id,
      year: null,
      venue: null,
      category: "",
      visibility: "public",
      summary: "Configured dataset (no catalog entry yet).",
      highlights: [],
      capabilities: { has_map: !!ds.has_map, has_traffic_lights: null, coordinate_frame: null, scene_unit: null },
      links: [],
      app: { supported: true, family: ds.family || null },
    });
  }

  function triMatch(v, mode) {
    if (!mode) return true;
    if (mode === "yes") return v === true;
    if (mode === "no") return v === false;
    if (mode === "unknown") return v !== true && v !== false;
    return true;
  }

  const filtered = items.filter((it) => {
    if (catFilter && String(it.category || "") !== catFilter) return false;
    const caps = it.capabilities || {};
    if (!triMatch(caps.has_map, mapFilter)) return false;
    if (!triMatch(caps.has_traffic_lights, tlFilter)) return false;
    const hay = [
      it.id,
      it.title,
      it.venue,
      it.category,
      it.visibility,
      it.summary,
      Array.isArray(it.highlights) ? it.highlights.join(" ") : "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return !q || hay.includes(q);
  });

  const installed = [];
  const catalogOnly = [];
  for (const it of filtered) {
    const ds = state.datasetsById ? state.datasetsById[it.id] : null;
    if (ds && !ds.virtual) installed.push(it);
    else catalogOnly.push(it);
  }

  function yearNum(it) {
    const y = Number(it && it.year);
    return Number.isFinite(y) ? y : -1;
  }

  function titleText(it) {
    return String(it && (it.title || it.id) || "").toLowerCase();
  }

  function cmpItems(a, b) {
    if (sortMode === "title_asc") {
      return titleText(a).localeCompare(titleText(b));
    }
    if (sortMode === "year_desc") {
      const dy = yearNum(b) - yearNum(a);
      if (dy) return dy;
      return titleText(a).localeCompare(titleText(b));
    }
    // Default: available-first is already handled by sections; sort by year desc within sections.
    const dy = yearNum(b) - yearNum(a);
    if (dy) return dy;
    return titleText(a).localeCompare(titleText(b));
  }

  installed.sort(cmpItems);
  catalogOnly.sort(cmpItems);

  const statsEl = $("homeStats");
  if (statsEl) {
    const totalCatalog = (state.catalogDatasets || []).length;
    const totalInstalled = Object.keys(state.datasetsById || {}).length;
    const totalProfiles = Array.isArray(state.profiles) ? state.profiles.length : 0;
    const showing = filtered.length;
    const chips = [];
    chips.push(`<span class="chip chip--yes">Available: ${totalInstalled}</span>`);
    chips.push(`<span class="chip">Connections: ${totalProfiles}</span>`);
    if (totalCatalog) chips.push(`<span class="chip">Catalog: ${totalCatalog}</span>`);
    if (q || catFilter || mapFilter || tlFilter) chips.push(`<span class="chip">Showing: ${showing}</span>`);
    statsEl.innerHTML = chips.join("");
  }

  function section(title, arr) {
    if (!arr.length) return "";
    const cards = arr
      .map((it) => {
        const ds = state.datasetsById[it.id] || null;
        const appSpec = (it.app && typeof it.app === "object") ? it.app : {};
        const family = String((ds && ds.family) || appSpec.family || "").trim().toLowerCase();
        const isSupported = !!ds || (appSpec.supported === true && supportedLocalFamily(family));
        const isPrivate = String(it.visibility || "").toLowerCase() === "private";
        const tagText = isPrivate ? "Private" : (ds ? "Available" : (isSupported ? "Ready to load" : "Catalog"));
        const tagCls = isPrivate ? "dsTag dsTag--private" : isSupported ? "dsTag dsTag--on" : "dsTag";
        const active = state.datasetId && String(it.id) === String(state.datasetId);

        const caps = it.capabilities || {};
        const chips = [];
        const catLabel = prettyCategoryLabel(it.category);
        if (catLabel) chips.push(`<span class="chip">Category: ${escapeHtml(catLabel)}</span>`);
        chips.push(yesNoChip("HD map", caps.has_map));
        chips.push(yesNoChip("Traffic lights", caps.has_traffic_lights));
        if (caps.coordinate_frame) chips.push(`<span class="chip">Frame: ${escapeHtml(caps.coordinate_frame)}</span>`);
        if (caps.scene_unit) chips.push(`<span class="chip">Scene: ${escapeHtml(caps.scene_unit)}</span>`);
        if (ds && Array.isArray(ds.splits)) chips.push(`<span class="chip">Splits: ${escapeHtml(ds.splits.map(splitLabel).join(" · "))}</span>`);
        if (ds && ds.group_label) chips.push(`<span class="chip">Group: ${escapeHtml(ds.group_label)}</span>`);

        const links = (Array.isArray(it.links) ? it.links : []).slice(0, 4);
        const linkHtml = links
          .map((l) => {
            const href = l && l.url ? String(l.url) : "";
            const label = l && l.label ? String(l.label) : "Link";
            if (!href) return "";
            return `<a class="linkPill" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
          })
          .filter(Boolean)
          .join("");

        const titleLine = escapeHtml(it.title || it.id || "Dataset");
        const metaBits = [it.year ? String(it.year) : null, it.venue || null].filter(Boolean);
        const meta = metaBits.length ? `<div class="dsCard__meta">${escapeHtml(metaBits.join(" · "))}</div>` : "";

        const summary = String(it.summary || "").trim();
        const summaryHtml = summary ? `<div class="dsSummary">${escapeHtml(summary)}</div>` : "";

        const highlights = (Array.isArray(it.highlights) ? it.highlights : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 3);
        const hiHtml = highlights.length
          ? `<div class="dsHighlights">${highlights.map((h) => `<div class="dsHi">• ${escapeHtml(h)}</div>`).join("")}</div>`
          : "";

        const btnHtml = isSupported
          ? `<button class="btn" type="button" data-open-dataset="${escapeHtml(it.id)}">Open Explorer</button>`
          : `<button class="btn btn--ghost" type="button" disabled>Planned</button>`;

        return `
          <article class="dsCard${active ? " dsCard--active" : ""}">
            <div class="dsCard__top">
              <div>
                <div class="dsCard__title">${titleLine}</div>
                ${meta}
              </div>
              <span class="${tagCls}">${escapeHtml(tagText)}</span>
            </div>
            ${summaryHtml}
            ${hiHtml}
            <div class="dsChips">${chips.join("")}</div>
            <div class="dsActions">
              ${btnHtml}
              <div class="dsLinks">${linkHtml}</div>
            </div>
          </article>
        `;
      })
      .join("");

    return `
      <div class="dsSectionHead">
        <div class="dsSectionTitle">${escapeHtml(title)} <span class="dsSectionCount">(${arr.length})</span></div>
      </div>
      ${cards}
    `;
  }

  const html = [
    section("Available now", installed),
    section("Dataset catalog", catalogOnly),
  ]
    .filter(Boolean)
    .join("\n");

  if (!html) {
    wrap.innerHTML = `<div class="dsEmpty">No datasets match your search/filters.</div>`;
    return;
  }
  wrap.innerHTML = html;
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

function setUpdateHint(msg, tone = "") {
  const el = $("updateHint");
  if (!el) return;
  const m = String(msg || "").trim();
  if (!m) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("hint--ok", "hint--warn", "hint--bad");
    return;
  }
  el.hidden = false;
  el.textContent = m;
  el.classList.remove("hint--ok", "hint--warn", "hint--bad");
  if (tone === "ok") el.classList.add("hint--ok");
  else if (tone === "warn") el.classList.add("hint--warn");
  else if (tone === "bad") el.classList.add("hint--bad");
}

function syncUpdateUi() {
  const badge = $("appVersionBadge");
  const checkBtn = $("checkUpdateBtn");
  const dlBtn = $("downloadUpdateBtn");
  const meta = state.appMeta || null;
  const upd = state.updateInfo || null;

  const ver = meta && meta.app_version ? String(meta.app_version) : null;
  if (badge) badge.textContent = ver ? `v${ver}` : "v?";
  if (checkBtn) {
    checkBtn.disabled = !!state.updateBusy;
    checkBtn.textContent = state.updateBusy ? "Checking..." : "Check updates";
  }
  if (dlBtn) {
    const canDownload = !!(upd && upd.update_available && state.updateDownloadUrl);
    dlBtn.hidden = !canDownload;
    dlBtn.disabled = !canDownload;
  }
}

async function loadAppMeta() {
  try {
    const data = await fetchJson("/api/app_meta");
    state.appMeta = data || null;
  } catch (_) {
    state.appMeta = null;
  }
  syncUpdateUi();
}

async function checkForUpdates({ force = false, userInitiated = false } = {}) {
  if (state.updateBusy) return;
  state.updateBusy = true;
  syncUpdateUi();

  try {
    const qs = new URLSearchParams({ force: force ? "1" : "0" });
    const data = await fetchJson(`/api/update/check?${qs.toString()}`);
    state.updateInfo = data || null;

    const latest = data && data.latest_version ? `v${data.latest_version}` : null;
    const current = data && data.app_version ? `v${data.app_version}` : null;
    state.updateDownloadUrl = String((data && (data.download_url || data.release_url || "")) || "").trim();

    if (!data || data.ok === false) {
      const err = data && data.error ? String(data.error) : "Update check failed.";
      setUpdateHint(err, userInitiated ? "bad" : "");
      syncUpdateUi();
      return;
    }

    if (data.update_available) {
      setUpdateHint(`Update available: ${latest || "new release"} (current ${current || "unknown"}).`, "warn");
      syncUpdateUi();
      return;
    }

    if (latest && data.comparison_confident === false) {
      setUpdateHint(`Latest release found (${latest}). Version format differs from current app version.`, "warn");
      syncUpdateUi();
      return;
    }

    if (userInitiated) {
      setUpdateHint(`You are up to date (${current || "current version"}).`, "ok");
    }
  } catch (e) {
    const msg = `Update check failed: ${e && e.message ? e.message : String(e)}`;
    setUpdateHint(msg, userInitiated ? "bad" : "");
  } finally {
    state.updateBusy = false;
    syncUpdateUi();
  }
}

function clearExplorerSceneState(message) {
  const msg = String(message || "").trim() || "Load a dataset directory to start.";
  setPlaying(false);
  setCanvasLoading(false);
  state.bundle = null;
  state.sceneModalities = null;
  state.frame = 0;
  state.sceneIds = [];
  state.sceneId = null;
  state.sceneTotal = 0;
  state.sceneOffset = 0;
  state.intersectId = "";
  state.selectedKey = null;
  state.selected = null;
  state.view = null;
  state.mapPaths = null;
  resetTrailCache();
  updateSubTypeUi(null);

  const interSel = $("intersectSelect");
  if (interSel) {
    interSel.innerHTML = "";
    interSel.disabled = true;
    const all = document.createElement("option");
    all.value = "";
    all.textContent = `All ${pluralizeLower(state.groupLabel) || "groups"}`;
    interSel.appendChild(all);
    interSel.value = "";
  }
  const sceneSel = $("sceneSelect");
  if (sceneSel) {
    sceneSel.innerHTML = "";
    sceneSel.disabled = true;
  }
  const splitSel = $("splitSelect");
  if (splitSel) splitSel.disabled = true;
  const prevBtn = $("prevSceneBtn");
  if (prevBtn) prevBtn.disabled = true;
  const nextBtn = $("nextSceneBtn");
  if (nextBtn) nextBtn.disabled = true;
  const jumpInput = $("sceneJumpInput");
  if (jumpInput) jumpInput.disabled = true;
  const jumpBtn = $("sceneGoBtn");
  if (jumpBtn) jumpBtn.disabled = true;

  const slider = $("frameSlider");
  if (slider) {
    slider.min = "0";
    slider.max = "0";
    slider.value = "0";
  }
  const frameLabel = $("frameLabel");
  if (frameLabel) frameLabel.textContent = "Frame 0";
  const timeLabel = $("timeLabel");
  if (timeLabel) timeLabel.textContent = "Time +0.0s";
  const countsLabel = $("countsLabel");
  if (countsLabel) countsLabel.textContent = "No data loaded";
  const transLabel = $("sceneTransitionLabel");
  if (transLabel) transLabel.textContent = "";

  updateSceneHint(0, 0, 0);
  setPlaybackEnabled(false);
  updateSceneModalityControls(null);
  updateStatusBox(msg);
  const si = $("sceneInfo");
  if (si) si.textContent = msg;

  const canvas = $("mapCanvas");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const { cssW, cssH, dpr } = getCanvasSize(canvas);
      resizeCanvas(canvas, ctx, cssW, cssH, dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
}

function sourcePromptText(datasetType, title) {
  const name = String(title || "dataset");
  if (datasetType === "v2x_traj") {
    return `Select the ${name} dataset directory to start scene loading.`;
  }
  if (datasetType === "consider_it_cpm") {
    return `Select the ${name} dataset directory to start scene loading.`;
  }
  return `Select the ${name} dataset directory to start scene loading.`;
}

async function openExplorerForDataset(datasetId, { savePrev = true, loadData = true } = {}) {
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
  updateSourcePanel();

  if (!loadData) {
    const meta = currentDatasetMeta() || {};
    clearExplorerSceneState(sourcePromptText(datasetTypeFromMeta(meta), meta.title || meta.id || "dataset"));
    updateSourcePanel();
    return;
  }

  // Now load data for this dataset.
  state.sceneOffset = Number(state.sceneOffset || 0);
  await loadIntersections();
  await loadScenes();
  await loadSceneBundle();
  updateSourcePanel();
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
  sel.disabled = false;

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
  if (keep) {
    state.intersectId = prev;
  } else {
    const meta = currentDatasetMeta() || {};
    const datasetType = datasetTypeFromMeta(meta);
    if (datasetType === "consider_it_cpm") {
      const lidar = Array.from(sel.options).find((o) => String(o.value || "").startsWith("lidar__"));
      state.intersectId = lidar ? String(lidar.value) : "";
    } else {
      state.intersectId = "";
    }
  }
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

  const existing = state.sceneId;
  const keep = existing && (data.items || []).some((it) => String(it.scene_id) === String(existing));
  const next = keep ? existing : (data.items && data.items[0] ? data.items[0].scene_id : null);
  state.sceneId = next;
  if (next) sel.value = next;
  const hasScenes = state.sceneIds.length > 0;
  sel.disabled = !hasScenes;
  const prevBtn = $("prevSceneBtn");
  if (prevBtn) prevBtn.disabled = !hasScenes;
  const nextBtn = $("nextSceneBtn");
  if (nextBtn) nextBtn.disabled = !hasScenes;
  const jumpInput = $("sceneJumpInput");
  if (jumpInput) jumpInput.disabled = !hasScenes;
  const jumpBtn = $("sceneGoBtn");
  if (jumpBtn) jumpBtn.disabled = !hasScenes;
}

async function loadSceneBundle() {
  const reqId = ++req.bundle;
  const ds = state.datasetId;
  const split = state.split;
  const scene = state.sceneId;
  if (!ds || !split || !scene) {
    state.sceneModalities = null;
    updateSceneModalityControls(null);
    setCanvasLoading(false);
    return;
  }

  setPlaying(false);
  state.selected = null;
  $("sceneInfo").textContent = "Loading scene…";
  updateStatusBox("Loading scene…");
  setCanvasLoading(true, `Loading ${currentSceneLabel(scene)}...`);

  try {
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
    updateSceneModalityControls(bundle);
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
    const splitSel = $("splitSelect");
    if (splitSel) splitSel.disabled = state.splits.length <= 1;
    const interSel = $("intersectSelect");
    if (interSel) interSel.disabled = false;
    const sceneSel = $("sceneSelect");
    if (sceneSel) sceneSel.disabled = false;
    const prevBtn = $("prevSceneBtn");
    if (prevBtn) prevBtn.disabled = false;
    const nextBtn = $("nextSceneBtn");
    if (nextBtn) nextBtn.disabled = false;
    const jumpInput = $("sceneJumpInput");
    if (jumpInput) jumpInput.disabled = false;
    const jumpBtn = $("sceneGoBtn");
    if (jumpBtn) jumpBtn.disabled = false;
    updateStatusBox();
    updateSceneInfo();
    render();
    markSceneTransition(currentSceneLabel(scene));
  } catch (e) {
    if (reqId === req.bundle) {
      const msg = `Failed to load scene: ${e && e.message ? e.message : String(e)}`;
      updateStatusBox(msg);
      $("sceneInfo").textContent = msg;
    }
    throw e;
  } finally {
    if (reqId === req.bundle) setCanvasLoading(false);
  }
}

function wireUi() {
  const backBtn = $("backHomeBtn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      setPlaying(false);
      saveCurrentDatasetSettings();
      state.datasetLocked = false;
      setView("home");
      syncControlsFromState();
      renderHomeDatasetCards();
      renderHomeProfilesList();
      setHomeError("");
      updateSourcePanel();
    });
  }

  const checkUpdateBtn = $("checkUpdateBtn");
  if (checkUpdateBtn) {
    checkUpdateBtn.addEventListener("click", () => {
      checkForUpdates({ force: true, userInitiated: true }).catch(() => {});
    });
  }

  const dlBtn = $("downloadUpdateBtn");
  if (dlBtn) {
    dlBtn.addEventListener("click", () => {
      const url = String(state.updateDownloadUrl || "").trim();
      if (!url) return;
      try {
        window.open(url, "_blank", "noopener");
      } catch (_) {}
    });
  }

  $("datasetSelect").addEventListener("change", async (e) => {
    try {
      state.datasetLocked = false;
      await openExplorerForDataset(e.target.value, { savePrev: true });
    } catch (err) {
      updateStatusBox(`Failed to switch dataset: ${err && err.message ? err.message : String(err)}`);
    }
  });

  const sourceFolderBtn = $("sourceFolderBtn");
  if (sourceFolderBtn) {
    sourceFolderBtn.addEventListener("click", async () => {
      if (state.sourceBusy) return;
      const meta = currentDatasetMeta() || {};
      const datasetType = datasetTypeFromMeta(meta);
      if (!datasetType) {
        setConnectResult("This dataset is not supported for local loading.", "bad");
        updateSourcePanel();
        return;
      }
      const prompt = datasetType === "v2x_traj"
        ? "Enter a V2X-Traj dataset directory path:"
        : datasetType === "v2x_seq"
          ? "Enter a V2X-Seq dataset directory path:"
          : "Enter a Consider.it dataset directory path:";
      const paths = await pickPathsDesktop("pick_folder", prompt);
      if (!paths.length) return;
      await loadDatasetFromFolder(paths[0]);
    });
  }

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
  bindCheck("typeVru", (v) => (state.types.VRU = v));
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
  bindCheck("showBasemap", (v) => {
    state.basemapEnabled = v;
    if (!v) state.basemapZoom = null;
  });
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
  const search = $("homeSearch");
  if (search) {
    search.addEventListener("input", () => {
      state.homeSearch = String(search.value || "");
      renderHomeDatasetCards();
    });
  }

  const catSel = $("homeCategory");
  if (catSel) {
    catSel.addEventListener("change", () => {
      state.homeCategory = String(catSel.value || "");
      renderHomeDatasetCards();
    });
  }

  const mapSel = $("homeHasMap");
  if (mapSel) {
    mapSel.addEventListener("change", () => {
      state.homeHasMap = String(mapSel.value || "");
      renderHomeDatasetCards();
    });
  }

  const tlSel = $("homeHasTL");
  if (tlSel) {
    tlSel.addEventListener("change", () => {
      state.homeHasTL = String(tlSel.value || "");
      renderHomeDatasetCards();
    });
  }

  const sortSel = $("homeSort");
  if (sortSel) {
    sortSel.addEventListener("change", () => {
      state.homeSort = String(sortSel.value || "available");
      renderHomeDatasetCards();
    });
  }

  const newConnBtn = $("homeConnectNewBtn");
  if (newConnBtn) {
    newConnBtn.addEventListener("click", () => {
      openProfileWizard("create");
    });
  }

  const profileList = $("homeProfilesList");
  if (profileList) {
    profileList.addEventListener("click", async (ev) => {
      const openBtn = ev.target && ev.target.closest ? ev.target.closest("[data-open-profile-dataset]") : null;
      if (openBtn) {
        const ds = String(openBtn.getAttribute("data-open-profile-dataset") || "").trim();
        if (!ds) return;
        setHomeError("");
        openBtn.disabled = true;
        const prevText = openBtn.textContent;
        openBtn.textContent = "Opening...";
        try {
          const ensured = ensureDatasetMetaForCard(ds);
          if (!ensured && !state.datasetsById[ds]) throw new Error("Dataset is not supported in this app yet.");
          const effectiveMeta = ensured || state.datasetsById[ds] || null;
          const loadData = hasLoadedSourceForMeta(effectiveMeta);
          state.datasetLocked = true;
          setView("explorer");
          await openExplorerForDataset(ds, { savePrev: false, loadData });
        } catch (e) {
          setView("home");
          setHomeError(`Failed to open explorer: ${e && e.message ? e.message : String(e)}`);
        } finally {
          openBtn.textContent = prevText;
          openBtn.disabled = false;
        }
        return;
      }

      const editBtn = ev.target && ev.target.closest ? ev.target.closest("[data-edit-profile]") : null;
      if (editBtn) {
        const profileId = editBtn.getAttribute("data-edit-profile");
        if (profileId) await openProfileWizardForEdit(profileId);
        return;
      }

      const delBtn = ev.target && ev.target.closest ? ev.target.closest("[data-delete-profile]") : null;
      if (delBtn) {
        const profileId = delBtn.getAttribute("data-delete-profile");
        if (profileId) await deleteConnectionProfile(profileId);
        return;
      }

      const defBtn = ev.target && ev.target.closest ? ev.target.closest("[data-set-default-profile]") : null;
      if (defBtn) {
        const profileId = defBtn.getAttribute("data-set-default-profile");
        if (profileId) await setDefaultConnectionProfile(profileId);
      }
    });
  }

  const modal = $("profileWizardModal");
  if (modal) {
    modal.addEventListener("click", (ev) => {
      if (!ev.target) return;
      const close = ev.target.closest ? ev.target.closest("[data-close-profile-wizard]") : null;
      if (!close) return;
      if (state.profileWizard.busy) return;
      closeProfileWizard();
    });
  }
  const closeBtn = $("profileWizardCloseBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      if (state.profileWizard.busy) return;
      closeProfileWizard();
    });
  }

  const wizTypeSel = $("wizType");
  if (wizTypeSel) {
    wizTypeSel.addEventListener("change", () => {
      applyWizardDatasetBlocks();
      syncProfileWizardUi();
    });
  }

  const wizDetectBtn = $("wizDetectBtn");
  if (wizDetectBtn) {
    wizDetectBtn.addEventListener("click", () => {
      wizardDetect().catch(() => {});
    });
  }
  const wizValidateBtn = $("wizValidateBtn");
  if (wizValidateBtn) {
    wizValidateBtn.addEventListener("click", () => {
      wizardValidate().catch(() => {});
    });
  }

  const wizPrevBtn = $("wizPrevBtn");
  if (wizPrevBtn) {
    wizPrevBtn.addEventListener("click", () => {
      if (state.profileWizard.busy) return;
      state.profileWizard.step = Math.max(1, Number(state.profileWizard.step || 1) - 1);
      syncProfileWizardUi();
    });
  }

  const wizNextBtn = $("wizNextBtn");
  if (wizNextBtn) {
    wizNextBtn.addEventListener("click", async () => {
      if (state.profileWizard.busy) return;
      const step = Number(state.profileWizard.step || 1);
      if (step === 1) {
        if (state.profileWizard.draft && state.profileWizard.draft.profile) {
          const nextProfile = buildProfileFromWizardInputs();
          if (state.profileWizard.profileId) nextProfile.profile_id = state.profileWizard.profileId;
          state.profileWizard.draft.profile = nextProfile;
          state.profileWizard.step = 2;
        } else {
          const ok = await wizardDetect();
          if (ok) state.profileWizard.step = 2;
        }
      } else if (step === 2) {
        const ok = await wizardValidate();
        if (ok) state.profileWizard.step = 3;
      }
      syncProfileWizardUi();
    });
  }

  const wizSaveBtn = $("wizSaveBtn");
  if (wizSaveBtn) {
    wizSaveBtn.addEventListener("click", () => {
      saveConnectionProfileFromWizard().catch(() => {});
    });
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!state.profileWizard.open || state.profileWizard.busy) return;
    closeProfileWizard();
  });

  const wrap = $("homeDatasetCards");
  if (wrap) {
    wrap.addEventListener("click", async (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest("[data-open-dataset]") : null;
      if (!btn) return;
      const ds = btn.getAttribute("data-open-dataset");
      if (!ds) return;

      setHomeError("");
      btn.disabled = true;
      const prevText = btn.textContent;
      btn.textContent = "Opening...";

      try {
        const ensured = ensureDatasetMetaForCard(ds);
        if (!ensured && !state.datasetsById[ds]) throw new Error("Dataset is not supported in this app yet.");
        const effectiveMeta = ensured || state.datasetsById[ds] || null;
        const loadData = hasLoadedSourceForMeta(effectiveMeta);
        state.datasetLocked = true;
        setView("explorer");
        await openExplorerForDataset(ds, { savePrev: false, loadData });
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
  syncUpdateUi();

  await loadDatasets();
  await loadProfiles();
  await loadCatalog();
  renderHomeCategoryOptions();
  const mapSel = $("homeHasMap");
  if (mapSel) mapSel.value = String(state.homeHasMap || "");
  const tlSel = $("homeHasTL");
  if (tlSel) tlSel.value = String(state.homeHasTL || "");
  const sortSel = $("homeSort");
  if (sortSel) sortSel.value = String(state.homeSort || "available");
  renderHomeProfilesList();
  renderHomeDatasetCards();

  // Update checks run in the background and should not block loading datasets.
  loadAppMeta()
    .then(() => checkForUpdates({ force: false, userInitiated: false }))
    .catch(() => {});

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
