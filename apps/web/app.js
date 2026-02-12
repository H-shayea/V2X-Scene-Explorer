/* V2X Scene Explorer web app: no build tooling, no external deps. */

const $ = (id) => document.getElementById(id);

function trajDomain() {
  return (window.TrajDomain && typeof window.TrajDomain === "object") ? window.TrajDomain : null;
}

function warnMissingTrajDomainOnce() {
  if (window.__trajDomainWarned) return;
  window.__trajDomainWarned = true;
  console.warn("TrajDomain (domain.js) is unavailable; using built-in fallback mappings.");
}

function hasDesktopBridge() {
  const api = window.pywebview && window.pywebview.api ? window.pywebview.api : null;
  if (!api) return false;
  if (typeof api.is_desktop === "function") return true;
  if (typeof api.pick_folder === "function") return true;
  return false;
}

function isWebMode() {
  return !hasDesktopBridge();
}

function webBackendQueryOverride() {
  try {
    const qp = new URLSearchParams(String(window.location.search || ""));
    const raw = String(qp.get("web_backend") || "").trim().toLowerCase();
    if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
    if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  } catch (_) { }
  return null;
}

function hasEmbeddedWebBackend() {
  const wb = window.WebBackend;
  return !!(wb && typeof wb.fetchJson === "function" && typeof wb.postJson === "function");
}

function shouldForceEmbeddedWebBackend() {
  return webBackendQueryOverride() === true;
}

function canFallbackToEmbeddedWebBackend() {
  if (!isWebMode() || !hasEmbeddedWebBackend()) return false;
  return webBackendQueryOverride() !== false;
}

function isEmbeddedFallbackStatus(status) {
  const s = Number(status);
  return s === 404 || s === 405 || s === 501 || s === 502 || s === 503 || s === 504;
}

function makeApiError(url, res, text) {
  const err = new Error(`${res.status} ${res.statusText}: ${text}`);
  err.status = Number(res.status || 0);
  err.url = String(url || "");
  err.body = String(text || "");
  return err;
}

function syncRuntimeModeCss() {
  const web = isWebMode();
  if (document.body) {
    document.body.classList.toggle("is-web-mode", web);
  }
  if (web) console.log("Running in Web Mode (Static/GitHub Pages)");
}
syncRuntimeModeCss();
window.addEventListener("pywebviewready", syncRuntimeModeCss);

async function fetchJson(url) {
  const forceEmbedded = shouldForceEmbeddedWebBackend();
  if (forceEmbedded && hasEmbeddedWebBackend()) {
    return window.WebBackend.fetchJson(url);
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      const err = makeApiError(url, res, text);
      if (canFallbackToEmbeddedWebBackend() && isEmbeddedFallbackStatus(err.status)) {
        return window.WebBackend.fetchJson(url);
      }
      throw err;
    }
    return await res.json();
  } catch (err) {
    const status = Number(err && err.status);
    if (canFallbackToEmbeddedWebBackend() && (!Number.isFinite(status) || isEmbeddedFallbackStatus(status))) {
      return window.WebBackend.fetchJson(url);
    }
    throw err;
  }
}

async function postJson(url, payload) {
  const forceEmbedded = shouldForceEmbeddedWebBackend();
  if (forceEmbedded && hasEmbeddedWebBackend()) {
    return window.WebBackend.postJson(url, payload);
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) {
      const text = await res.text();
      const err = makeApiError(url, res, text);
      if (canFallbackToEmbeddedWebBackend() && isEmbeddedFallbackStatus(err.status)) {
        return window.WebBackend.postJson(url, payload);
      }
      throw err;
    }
    return await res.json();
  } catch (err) {
    const status = Number(err && err.status);
    if (canFallbackToEmbeddedWebBackend() && (!Number.isFinite(status) || isEmbeddedFallbackStatus(status))) {
      return window.WebBackend.postJson(url, payload);
    }
    throw err;
  }
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
    } catch (_) { }
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
    tileUrl: tileUrl || (isWebMode() ? "https://tile.openstreetmap.org/{z}/{x}/{y}.png" : "/api/tiles/osm/{z}/{x}/{y}.png"),
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

function drawSceneBackground(ctx, view, cssW, cssH, dpr, bundle) {
  if (!state.sceneBgEnabled) return;
  const placement = currentSceneBackgroundPlacement(bundle);
  if (!placement) return;
  const bg = placement.background;
  const tile = getTileImage(bg.url);
  if (!tile || tile.status !== "loaded") return;

  const [cx, cy] = viewWorldToCanvas(view, cssW, cssH, placement.cx, placement.cy);
  const w = Math.max(1.0, Math.abs(placement.widthM * view.scale));
  const h = Math.max(1.0, Math.abs(placement.heightM * view.scale));
  if (!(w > 1 && h > 1)) return;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = placement.alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.translate(cx, cy);
  if (placement.flipY) {
    ctx.scale(1, -1);
  }
  ctx.drawImage(tile.img, -w * 0.5, -h * 0.5, w, h);
  ctx.restore();
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
    TRUCK_BUS: "#f97316",
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
  hasSceneBackground: false,
  showMap: true,
  sceneBgEnabled: false,
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
  sceneAvailability: null,
  includeTlOnlyScenes: false,
  bundle: null,
  frame: 0,
  playing: false,
  timer: null,
  speed: 1,
  showVelocity: false,
  showHeading: false,
  trajectoryRange: "full", // "none" | "past" | "full"
  pathCache: null,
  pathAllCache: null,
  holdTL: true,
  mapPointsStep: 3,
  mapPadding: 120,
  mapClip: "scene",
  mapMaxLanes: 5000,
  mapSource: "lanelet2", // none | lanelet2 | orthophoto | overlay
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
  sindBgAlignByCity: {},
  sceneTransitionTimer: null,
};

const req = { intersections: 0, scenes: 0, bundle: 0 };

const LS_LAST_DATASET = "trajExplorer.lastDatasetId";
const LS_DATASET_SETTINGS = "trajExplorer.datasetSettingsById.v1";
const LS_SIND_BG_ALIGN = "trajExplorer.sindBgAlignByCity.v1";
const COOKIE_SIND_BG_ALIGN = "trajExplorerSindBgAlignV1";
const SS_SOURCE_BY_TYPE = "trajExplorer.sourceByType.v1";

function safeJsonParse(s) {
  try {
    return JSON.parse(String(s || ""));
  } catch (_) {
    return null;
  }
}

function readCookie(name) {
  const key = String(name || "").trim();
  if (!key) return "";
  const parts = String(document.cookie || "").split(";");
  for (const part of parts) {
    const p = String(part || "").trim();
    if (!p) continue;
    const i = p.indexOf("=");
    if (i <= 0) continue;
    const k = p.slice(0, i).trim();
    if (k !== key) continue;
    try {
      return decodeURIComponent(p.slice(i + 1));
    } catch (_) {
      return p.slice(i + 1);
    }
  }
  return "";
}

function writeCookie(name, value, maxAgeDays = 3650) {
  const key = String(name || "").trim();
  if (!key) return;
  const encoded = encodeURIComponent(String(value || ""));
  const maxAge = Math.max(1, Math.round(Number(maxAgeDays || 3650) * 86400));
  document.cookie = `${key}=${encoded}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
}

function defaultDatasetSettings() {
  // Per-dataset UI prefs. Keep this small + stable; avoid storing anything derived from scene content.
  return {
    split: null,
    intersectId: "",
    sceneId: "",
    sceneOffset: 0,
    sceneLimit: 400,
    includeTlOnlyScenes: false,
    speed: 1,
    showVelocity: false,
    showHeading: false,
    trajectoryRange: "full",
    holdTL: true,
    showMap: true,
    sceneBgEnabled: false,
    basemapEnabled: false,
    basemapZoom: null,
    layers: { ego: true, infra: true, vehicle: true, traffic_light: true },
    types: { VEHICLE: true, VRU: true, PEDESTRIAN: true, BICYCLE: true, OTHER: true, ANIMAL: true, RSU: true, UNKNOWN: true },
    mapClip: "scene",
    mapPointsStep: 3,
    mapPadding: 120,
    mapMaxLanes: 5000,
    mapSource: "lanelet2",
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
    includeTlOnlyScenes: !!state.includeTlOnlyScenes,
    speed: Number(state.speed || 1),
    showVelocity: !!state.showVelocity,
    showHeading: !!state.showHeading,
    trajectoryRange: (state.trajectoryRange === "none" || state.trajectoryRange === "past" || state.trajectoryRange === "full")
      ? state.trajectoryRange
      : "full",
    holdTL: !!state.holdTL,
    showMap: !!state.showMap,
    sceneBgEnabled: !!state.sceneBgEnabled,
    basemapEnabled: !!state.basemapEnabled,
    basemapZoom: (state.basemapZoom != null && Number.isFinite(Number(state.basemapZoom))) ? Number(state.basemapZoom) : null,
    layers: { ...(state.layers || {}) },
    types: { ...(state.types || {}) },
    mapClip: state.mapClip || "scene",
    mapPointsStep: Number(state.mapPointsStep || 3),
    mapPadding: Number(state.mapPadding || 120),
    mapMaxLanes: Number(state.mapMaxLanes || 5000),
    mapSource: state.mapSource || "lanelet2",
    mapLayers: { ...(state.mapLayers || {}) },
    debugOverlay: !!state.debugOverlay,
    sceneBox: !!state.sceneBox,
    focusMask: !!state.focusMask,
  };
}

function persistDatasetSettings() {
  try {
    localStorage.setItem(LS_DATASET_SETTINGS, JSON.stringify(state.datasetSettingsById || {}));
  } catch (_) { }
}

function loadPersistedDatasetSettings() {
  const raw = safeJsonParse(localStorage.getItem(LS_DATASET_SETTINGS));
  if (!raw || typeof raw !== "object") return;
  state.datasetSettingsById = raw;
}

function persistSourceByType() {
  try {
    sessionStorage.setItem(SS_SOURCE_BY_TYPE, JSON.stringify(state.sourceByType || {}));
  } catch (_) { }
}

function loadPersistedSourceByType() {
  try {
    const raw = safeJsonParse(sessionStorage.getItem(SS_SOURCE_BY_TYPE));
    if (!raw || typeof raw !== "object") return;
    state.sourceByType = raw;
  } catch (_) { }
}

function defaultSindBgAlign() {
  return {
    enabled: true,
    tx: 0,
    ty: 0,
    sx: 1,
    sy: 1,
    rotationDeg: 0,
    alpha: 0.92,
    flipY: false,
  };
}

function isSindDataset(meta = currentDatasetMeta()) {
  return String((meta && meta.family) || "").trim().toLowerCase() === "sind";
}

function sindBgAlignCityKeys(bundle = state.bundle) {
  if (!isSindDataset()) return [];
  if (!bundle || typeof bundle !== "object") return [];
  const city = String(bundle.city || bundle.intersect_id || "").trim();
  if (!city) return [];
  const ds = String(state.datasetId || "").trim();
  const keys = [];
  if (ds) keys.push(`${ds}::${city}`);
  keys.push(`sind::${city}`);
  return Array.from(new Set(keys));
}

function sindBgAlignCityKey(bundle = state.bundle) {
  const keys = sindBgAlignCityKeys(bundle);
  return keys.length ? keys[0] : null;
}

function persistSindBgAlignStore() {
  const payload = JSON.stringify(state.sindBgAlignByCity || {});
  try {
    localStorage.setItem(LS_SIND_BG_ALIGN, payload);
  } catch (_) { }
  try {
    writeCookie(COOKIE_SIND_BG_ALIGN, payload);
  } catch (_) { }
}

function loadPersistedSindBgAlignStore() {
  let raw = safeJsonParse(localStorage.getItem(LS_SIND_BG_ALIGN));
  if (!raw || typeof raw !== "object") {
    raw = safeJsonParse(readCookie(COOKIE_SIND_BG_ALIGN));
  }
  if (!raw || typeof raw !== "object") return;
  state.sindBgAlignByCity = raw;
  try {
    localStorage.setItem(LS_SIND_BG_ALIGN, JSON.stringify(raw));
  } catch (_) { }
}

function getSindBgAlign(bundle = state.bundle) {
  const base = defaultSindBgAlign();
  const keys = sindBgAlignCityKeys(bundle);
  if (!keys.length) return base;
  let got = null;
  for (const key of keys) {
    const val = state.sindBgAlignByCity && state.sindBgAlignByCity[key];
    if (val && typeof val === "object") {
      got = val;
      break;
    }
  }
  if (!got || typeof got !== "object") return base;
  const sx = Number(got.sx);
  const sy = Number(got.sy);
  const alpha = Number(got.alpha);
  return {
    enabled: (got.enabled !== undefined) ? !!got.enabled : true,
    tx: Number.isFinite(Number(got.tx)) ? Number(got.tx) : 0,
    ty: Number.isFinite(Number(got.ty)) ? Number(got.ty) : 0,
    sx: Number.isFinite(sx) && sx > 0 ? sx : 1,
    sy: Number.isFinite(sy) && sy > 0 ? sy : 1,
    rotationDeg: Number.isFinite(Number(got.rotationDeg)) ? Number(got.rotationDeg) : 0,
    alpha: Number.isFinite(alpha) ? clamp(alpha, 0.2, 1.0) : 0.92,
    flipY: !!got.flipY,
  };
}

function setSindBgAlign(partial, bundle = state.bundle) {
  const keys = sindBgAlignCityKeys(bundle);
  if (!keys.length) return;
  const prev = getSindBgAlign(bundle);
  const next = { ...prev, ...(partial || {}) };
  // Keep values numerically stable.
  next.tx = Number.isFinite(Number(next.tx)) ? Number(next.tx) : 0;
  next.ty = Number.isFinite(Number(next.ty)) ? Number(next.ty) : 0;
  next.sx = Number.isFinite(Number(next.sx)) && Number(next.sx) > 0 ? Number(next.sx) : 1;
  next.sy = Number.isFinite(Number(next.sy)) && Number(next.sy) > 0 ? Number(next.sy) : 1;
  next.rotationDeg = Number.isFinite(Number(next.rotationDeg)) ? Number(next.rotationDeg) : 0;
  next.alpha = Number.isFinite(Number(next.alpha)) ? clamp(Number(next.alpha), 0.2, 1.0) : 0.92;
  next.flipY = !!next.flipY;
  next.enabled = !!next.enabled;
  for (const key of keys) {
    state.sindBgAlignByCity[key] = next;
  }
  persistSindBgAlignStore();
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
  state.includeTlOnlyScenes = !!s.includeTlOnlyScenes;
  const fam = String((currentDatasetMeta() || {}).family || "").toLowerCase();
  if (fam !== "v2x-seq") state.includeTlOnlyScenes = false;

  state.speed = Number.isFinite(Number(s.speed)) ? Number(s.speed) : 1;
  state.showVelocity = !!s.showVelocity;
  state.showHeading = !!s.showHeading;
  const legacyShowTrail = (s.showTrail !== undefined) ? !!s.showTrail : undefined;
  const legacyTrailFull = (s.trailFull !== undefined) ? !!s.trailFull : undefined;
  const legacyShowPastPaths = (s.showPastPaths !== undefined) ? !!s.showPastPaths : legacyShowTrail;
  const legacyIncludeFuture = (s.pathIncludeFuture !== undefined) ? !!s.pathIncludeFuture : legacyTrailFull;
  if (s.trajectoryRange === "none" || s.trajectoryRange === "past" || s.trajectoryRange === "full") {
    state.trajectoryRange = s.trajectoryRange;
  } else {
    // Older settings may have had trajectories turned off.
    if (legacyShowPastPaths === false) state.trajectoryRange = "none";
    else state.trajectoryRange = legacyIncludeFuture === false ? "past" : "full";
  }
  state.holdTL = (s.holdTL !== undefined) ? !!s.holdTL : true;
  const meta = currentDatasetMeta() || {};
  const hasMap = meta.has_map !== undefined ? !!meta.has_map : true;
  const hasSceneBg = !!meta.has_scene_background;
  state.showMap = (s.showMap !== undefined) ? !!s.showMap : hasMap;
  if (!hasMap) state.showMap = false;
  state.sceneBgEnabled = (s.sceneBgEnabled !== undefined) ? !!s.sceneBgEnabled : hasSceneBg;
  if (!hasSceneBg) state.sceneBgEnabled = false;
  const hasBasemap = !!(meta.basemap && typeof meta.basemap === "object");
  const defaultBasemapOn = (meta.family === "cpm-objects") && hasBasemap;
  state.basemapEnabled = (s.basemapEnabled !== undefined) ? !!s.basemapEnabled : defaultBasemapOn;
  state.basemapZoom = Number.isFinite(Number(s.basemapZoom)) ? Number(s.basemapZoom) : null;

  if (supportsMapSourceSelector(meta)) {
    applyMapSourceSelection(s.mapSource, { silent: true });
  }

  state.layers = { ...defaults.layers, ...(s.layers || {}) };
  state.types = { ...defaults.types, ...(s.types || {}) };

  state.mapClip = s.mapClip || defaults.mapClip;
  state.mapPointsStep = Number.isFinite(Number(s.mapPointsStep)) ? Number(s.mapPointsStep) : defaults.mapPointsStep;
  state.mapPadding = Number.isFinite(Number(s.mapPadding)) ? Number(s.mapPadding) : defaults.mapPadding;
  state.mapMaxLanes = Number.isFinite(Number(s.mapMaxLanes)) ? Number(s.mapMaxLanes) : defaults.mapMaxLanes;
  state.mapSource = (s.mapSource === "none" || s.mapSource === "orthophoto" || s.mapSource === "overlay") ? s.mapSource : "lanelet2";
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
  setCheck("trajectoryRangeNone", state.trajectoryRange === "none");
  setCheck("trajectoryRangePast", state.trajectoryRange === "past");
  setCheck("trajectoryRangeFull", state.trajectoryRange === "full");
  setCheck("holdTL", state.holdTL);
  setCheck("sceneTlOnly", state.includeTlOnlyScenes);
  setCheck("showMap", state.showMap);
  setCheck("showSceneBg", state.sceneBgEnabled);
  setCheck("showBasemap", state.basemapEnabled);
  setSelectValue("mapSourceSelect", state.mapSource || "lanelet2");

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

function supportsMapSourceSelector(meta = currentDatasetMeta()) {
  const m = (meta && typeof meta === "object") ? meta : {};
  const fam = String(m.family || "").toLowerCase();
  return (fam === "ind" || fam === "sind") && !!m.has_map && !!m.has_scene_background;
}

function normalizeMapSource(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "none") return "none";
  if (s === "orthophoto") return "orthophoto";
  if (s === "overlay") return "overlay";
  return "lanelet2";
}

function applyMapSourceSelection(rawSource, { silent = false } = {}) {
  const source = normalizeMapSource(rawSource);
  state.mapSource = source;
  if (source === "none") {
    state.showMap = false;
    state.sceneBgEnabled = false;
    state.basemapEnabled = false;
  } else if (source === "orthophoto") {
    state.showMap = false;
    state.sceneBgEnabled = true;
    state.basemapEnabled = false;
  } else if (source === "overlay") {
    state.showMap = true;
    state.sceneBgEnabled = true;
    state.basemapEnabled = false;
  } else {
    state.showMap = true;
    state.sceneBgEnabled = false;
  }
  if (!silent) {
    syncControlsFromState();
    syncMapSourceUi(state.bundle);
    render();
  }
}

function activeMapSourceLabel(bundle = state.bundle) {
  const meta = currentDatasetMeta() || {};
  if (supportsMapSourceSelector(meta)) {
    if (state.mapSource === "orthophoto") return "Orthophoto";
    if (state.mapSource === "overlay") return "Lanelet2 + orthophoto";
    if (state.mapSource === "none") return "None";
    return "Lanelet2";
  }
  const hasBg = !!currentSceneBackground(bundle);
  if (state.showMap && hasBg && state.sceneBgEnabled) return "Vector map + image";
  if (state.showMap) return "Vector map";
  if (hasBg && state.sceneBgEnabled) return "Scene image";
  if (state.basemapEnabled && currentBasemapConfig()) return "Basemap";
  return "None";
}

function syncMapSourceUi(bundle = state.bundle) {
  const meta = currentDatasetMeta() || {};
  const isSelectable = supportsMapSourceSelector(meta);
  const controls = $("mapSourceControls");
  const select = $("mapSourceSelect");
  const status = $("mapSourceStatus");
  const showMapWrap = $("showMapWrap");
  const showSceneBgWrap = $("showSceneBgWrap");

  if (controls) controls.hidden = !isSelectable;
  if (showMapWrap) showMapWrap.hidden = isSelectable ? true : !state.hasMap;
  if (showSceneBgWrap) showSceneBgWrap.hidden = isSelectable ? true : !state.hasSceneBackground;

  if (!isSelectable) {
    if (status) {
      status.hidden = true;
      status.textContent = "";
    }
    syncSindBgAlignUi(bundle);
    return;
  }

  const bgReady = !!currentSceneBackground(bundle);
  if (select) {
    select.disabled = false;
    if ((state.mapSource === "orthophoto" || state.mapSource === "overlay") && !bgReady) {
      state.mapSource = "lanelet2";
      state.showMap = true;
      state.sceneBgEnabled = false;
    }
    select.value = normalizeMapSource(state.mapSource);
    const optOrth = Array.from(select.options || []).find((o) => o.value === "orthophoto");
    if (optOrth) {
      optOrth.disabled = !bgReady;
      optOrth.textContent = bgReady ? "Orthophoto image" : "Orthophoto image (unavailable in this scene)";
    }
    const optOverlay = Array.from(select.options || []).find((o) => o.value === "overlay");
    if (optOverlay) {
      optOverlay.disabled = !bgReady;
      optOverlay.textContent = bgReady ? "Lanelet2 + orthophoto (overlay)" : "Lanelet2 + orthophoto (unavailable in this scene)";
    }
  }
  if (status) {
    status.hidden = false;
    status.textContent = `Active: ${activeMapSourceLabel(bundle)}`;
  }
  syncSindBgAlignUi(bundle);
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

function currentSceneBackground(bundle = state.bundle) {
  if (!bundle || typeof bundle !== "object") return null;
  const bg = bundle.background;
  if (!bg || typeof bg !== "object") return null;
  if (!bg.url || !bg.extent) return null;
  const ext = bg.extent;
  const coords = ["min_x", "min_y", "max_x", "max_y"];
  for (const k of coords) {
    if (!Number.isFinite(Number(ext[k]))) return null;
  }
  return bg;
}

function currentSceneBackgroundBasePlacement(bundle = state.bundle) {
  const bg = currentSceneBackground(bundle);
  if (!bg) return null;
  const ext = bg.extent;
  const minX = Number(ext.min_x);
  const maxX = Number(ext.max_x);
  const minY = Number(ext.min_y);
  const maxY = Number(ext.max_y);
  if (![minX, maxX, minY, maxY].every((v) => Number.isFinite(v))) return null;

  return {
    background: bg,
    cx: 0.5 * (minX + maxX),
    cy: 0.5 * (minY + maxY),
    widthM: Math.max(1e-6, maxX - minX),
    heightM: Math.max(1e-6, maxY - minY),
  };
}

function currentSindTrajectoryTransform(bundle = state.bundle) {
  if (!isSindDataset() || !sindBgAlignCityKey(bundle)) return null;
  const base = currentSceneBackgroundBasePlacement(bundle);
  if (!base) return null;
  const cal = getSindBgAlign(bundle);
  if (!cal.enabled) return null;

  const tx = Number.isFinite(Number(cal.tx)) ? Number(cal.tx) : 0;
  const ty = Number.isFinite(Number(cal.ty)) ? Number(cal.ty) : 0;
  const sx = clamp(Number.isFinite(Number(cal.sx)) ? Number(cal.sx) : 1, 0.05, 10);
  const sy = clamp(Number.isFinite(Number(cal.sy)) ? Number(cal.sy) : 1, 0.05, 10);
  const rotDeg = clamp(Number.isFinite(Number(cal.rotationDeg)) ? Number(cal.rotationDeg) : 0, -180, 180);
  const rotRad = (rotDeg * Math.PI) / 180.0;

  if (Math.abs(tx) < 1e-9 && Math.abs(ty) < 1e-9 && Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9 && Math.abs(rotRad) < 1e-12) {
    return null;
  }

  return {
    c0x: base.cx,
    c0y: base.cy,
    c1x: base.cx + tx,
    c1y: base.cy + ty,
    sx,
    sy,
    rotRad,
    cos: Math.cos(rotRad),
    sin: Math.sin(rotRad),
  };
}

function applySindTrajectoryToPoint(x, y, bundle = state.bundle) {
  const tx = currentSindTrajectoryTransform(bundle);
  const xIn = Number(x);
  const yIn = Number(y);
  if (!tx || !Number.isFinite(xIn) || !Number.isFinite(yIn)) return [xIn, yIn];

  const dx = xIn - tx.c1x;
  const dy = yIn - tx.c1y;
  const xr = dx * tx.cos + dy * tx.sin;
  const yr = -dx * tx.sin + dy * tx.cos;
  return [tx.c0x + xr / tx.sx, tx.c0y + yr / tx.sy];
}

function applySindTrajectoryWorldTransform(ctx, bundle = state.bundle) {
  const tx = currentSindTrajectoryTransform(bundle);
  if (!tx) return false;
  ctx.translate(tx.c0x, tx.c0y);
  ctx.scale(1 / tx.sx, 1 / tx.sy);
  ctx.rotate(-tx.rotRad);
  ctx.translate(-tx.c1x, -tx.c1y);
  return true;
}

function transformExtentForSindTrajectory(extent, bundle = state.bundle) {
  if (!extent || typeof extent !== "object") return extent;
  const corners = [
    [Number(extent.min_x), Number(extent.min_y)],
    [Number(extent.min_x), Number(extent.max_y)],
    [Number(extent.max_x), Number(extent.min_y)],
    [Number(extent.max_x), Number(extent.max_y)],
  ];
  if (!corners.every((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]))) return extent;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    const [tx, ty] = applySindTrajectoryToPoint(x, y, bundle);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
    minX = Math.min(minX, tx);
    minY = Math.min(minY, ty);
    maxX = Math.max(maxX, tx);
    maxY = Math.max(maxY, ty);
  }
  if (![minX, minY, maxX, maxY].every((v) => Number.isFinite(v))) return extent;
  return { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY };
}

function currentSceneBackgroundPlacement(bundle = state.bundle) {
  const base = currentSceneBackgroundBasePlacement(bundle);
  if (!base) return null;

  let alpha = 0.92;
  let flipY = false;

  const useSindCalib = isSindDataset() && !!sindBgAlignCityKey(bundle);
  if (useSindCalib) {
    const cal = getSindBgAlign(bundle);
    if (cal.enabled) {
      alpha = clamp(Number(cal.alpha || 0.92), 0.2, 1.0);
      flipY = !!cal.flipY;
    }
  }

  return {
    ...base,
    rotationDeg: 0,
    alpha,
    flipY,
  };
}

function syncSindBgAlignUi(bundle = state.bundle) {
  const fold = $("bgAlignSection");
  const hint = $("bgAlignHint");
  const show = isSindDataset() && !!currentSceneBackground(bundle) && !!sindBgAlignCityKey(bundle);
  if (fold) fold.hidden = !show;
  if (!show) {
    if (hint) hint.textContent = "";
    return;
  }

  const cal = getSindBgAlign(bundle);
  setCheck("bgAlignEnabled", cal.enabled);
  setCheck("bgAlignFlipY", cal.flipY);
  const alphaEl = $("bgAlignAlpha");
  if (alphaEl) alphaEl.value = String(cal.alpha);
  const txEl = $("bgAlignTx");
  if (txEl) txEl.value = String(cal.tx);
  const tyEl = $("bgAlignTy");
  if (tyEl) tyEl.value = String(cal.ty);
  const sxEl = $("bgAlignSx");
  if (sxEl) sxEl.value = String(cal.sx);
  const syEl = $("bgAlignSy");
  if (syEl) syEl.value = String(cal.sy);
  const rotEl = $("bgAlignRot");
  if (rotEl) rotEl.value = String(cal.rotationDeg);

  if (hint) {
    const city = String(bundle.city || bundle.intersect_id || "city");
    hint.textContent = `City ${city} · tx ${cal.tx.toFixed(1)}m · ty ${cal.ty.toFixed(1)}m · sx ${cal.sx.toFixed(3)} · sy ${cal.sy.toFixed(3)} · rot ${cal.rotationDeg.toFixed(1)}°`;
  }
}

function syncSceneBackgroundUi(bundle = state.bundle) {
  const wrap = $("showSceneBgWrap");
  const status = $("sceneBgStatus");
  const checkbox = $("showSceneBg");
  if (supportsMapSourceSelector(currentDatasetMeta())) {
    if (wrap) wrap.hidden = true;
    if (checkbox) checkbox.disabled = true;
    if (status) {
      status.hidden = true;
      status.textContent = "";
    }
    syncSindBgAlignUi(bundle);
    return;
  }
  const hasFeature = !!state.hasSceneBackground;
  const bg = currentSceneBackground(bundle);
  if (wrap) wrap.hidden = !hasFeature;
  if (!hasFeature) {
    if (checkbox) checkbox.disabled = true;
    if (status) {
      status.hidden = true;
      status.textContent = "";
    }
    syncSindBgAlignUi(bundle);
    return;
  }
  if (checkbox) checkbox.disabled = !bg;
  if (!status) {
    syncSindBgAlignUi(bundle);
    return;
  }
  if (!bg) {
    status.hidden = false;
    status.textContent = bundle ? "Background image is not available for this scene." : "Load a scene to display the background image.";
    syncSindBgAlignUi(bundle);
    return;
  }
  const size = (bg.size_px && typeof bg.size_px === "object") ? bg.size_px : null;
  const w = Number(size && size.width);
  const h = Number(size && size.height);
  const rec = String(bg.recording_id || "").trim();
  const label = Number.isFinite(w) && Number.isFinite(h)
    ? `${Math.round(w)}x${Math.round(h)} px`
    : "image ready";
  status.hidden = false;
  status.textContent = rec ? `Recording ${rec} · ${label}` : label;
  syncSindBgAlignUi(bundle);
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

function toBBoxArray(ext) {
  if (!ext || typeof ext !== "object") return null;
  const vals = [Number(ext.min_x), Number(ext.min_y), Number(ext.max_x), Number(ext.max_y)];
  if (!vals.every((v) => Number.isFinite(v))) return null;
  return vals;
}

function buildAdvancedMetadataPayload(bundle) {
  const map = bundle && bundle.map && typeof bundle.map === "object" ? bundle.map : null;
  const bg = bundle && bundle.background && typeof bundle.background === "object" ? bundle.background : null;
  return {
    dataset_id: bundle ? bundle.dataset_id : null,
    split: bundle ? bundle.split : null,
    city: bundle ? bundle.city : null,
    scene_id: bundle ? bundle.scene_id : null,
    scene_label: bundle ? bundle.scene_label : null,
    group_label: state.groupLabel || "Intersection",
    group_id: bundle ? bundle.intersect_id : null,
    group_display: bundle ? (bundle.intersect_label || intersectionLabel(bundle.intersect_id) || null) : null,
    map_id: bundle ? bundle.map_id : null,
    recording_id: bundle ? bundle.recording_id : null,
    recording_label: bundle ? bundle.recording_label : null,
    window_index: bundle && Number.isFinite(Number(bundle.window_index)) ? Number(bundle.window_index) : null,
    window_count: bundle && Number.isFinite(Number(bundle.window_count)) ? Number(bundle.window_count) : null,
    map_source_active: bundle ? activeMapSourceLabel(bundle) : null,
    frames: bundle && Array.isArray(bundle.frames) ? bundle.frames.length : 0,
    timestamps: bundle && Array.isArray(bundle.timestamps) ? bundle.timestamps : [],
    modality_stats: bundle && bundle.modality_stats ? bundle.modality_stats : null,
    warnings: bundle && Array.isArray(bundle.warnings) ? bundle.warnings : [],
    intersect_by_modality: bundle && bundle.intersect_by_modality ? bundle.intersect_by_modality : null,
    extents: {
      scene_bbox: bundle ? toBBoxArray(bundle.extent) : null,
      scene_size_m: bundle ? extentWH(bundle.extent) : { w: null, h: null },
      map_bbox: map ? toBBoxArray(map.bbox) : null,
      map_clip_bbox: map ? toBBoxArray(map.clip_extent) : null,
      map_clip_size_m: map ? extentWH(map.clip_extent) : { w: null, h: null },
    },
    map: map
      ? {
        clip_mode: map.clip_mode || null,
        map_file: map.map_file || null,
        counts: map.counts || null,
        lanes_shown: Array.isArray(map.lanes) ? map.lanes.length : 0,
        stoplines_shown: Array.isArray(map.stoplines) ? map.stoplines.length : 0,
        crosswalks_shown: Array.isArray(map.crosswalks) ? map.crosswalks.length : 0,
        junctions_shown: Array.isArray(map.junctions) ? map.junctions.length : 0,
        lanes_truncated: !!map.lanes_truncated,
      }
      : null,
    background: bg
      ? {
        recording_id: bg.recording_id || null,
        url: bg.url || null,
        extent_bbox: toBBoxArray(bg.extent),
        size_px: bg.size_px || null,
        alignment: isSindDataset() ? getSindBgAlign(bundle) : null,
      }
      : null,
  };
}

function summarizeBundle(bundle) {
  return JSON.stringify(buildAdvancedMetadataPayload(bundle), null, 2);
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
  state.hasSceneBackground = !!meta.has_scene_background;
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
    if (state.showMap === undefined || state.showMap === null) state.showMap = true;
  } else {
    if (mapTitle) mapTitle.textContent = "View";
    if (mapOnly) mapOnly.hidden = true;
    if (fitMapBtn) fitMapBtn.hidden = true;
    state.showMap = false;
  }
  if (!state.hasSceneBackground) state.sceneBgEnabled = false;

  // Optional basemap (raster) for datasets that provide a geo origin but no vector HD map.
  state.basemapMeta = (meta.basemap && typeof meta.basemap === "object") ? meta.basemap : null;
  const basemapWrap = $("basemapControls");
  const hasBasemap = !!(state.basemapMeta && (state.basemapMeta.origin || state.basemapMeta.origin_by_intersect));
  const mapSourceMode = supportsMapSourceSelector(meta);
  if (mapSourceMode) state.basemapEnabled = false;
  if (basemapWrap) basemapWrap.hidden = !hasBasemap || mapSourceMode;
  if (mapSourceMode) {
    applyMapSourceSelection(state.mapSource || "lanelet2", { silent: true });
  }
  syncSceneBackgroundUi(null);
  syncMapSourceUi(null);

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
  const sceneTlOnlyWrap = $("sceneTlOnlyWrap");
  if (sceneTlOnlyWrap) {
    const fam = String(meta.family || "").toLowerCase();
    sceneTlOnlyWrap.hidden = fam !== "v2x-seq";
  }
  if (String(meta.family || "").toLowerCase() !== "v2x-seq") {
    state.includeTlOnlyScenes = false;
  }
  state.sceneModalities = null;
  updateSceneModalityControls(null);
  updateSplitAvailabilityHint(state.sceneAvailability);
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
  if (state.showMap && bundle.map && bundle.map.clip_extent) return bundle.map.clip_extent;
  return transformExtentForSindTrajectory(bundle.extent, bundle);
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
  // Fast path: backend may provide pre-aggregated subtype counts.
  const pre = (((bundle.modality_stats || {}).infra || {}).sub_type_counts);
  if (pre && typeof pre === "object" && !Array.isArray(pre)) {
    for (const [k, v] of Object.entries(pre)) {
      const n = Number(v || 0);
      if (Number.isFinite(n) && n > 0) counts.set(String(k || "UNKNOWN"), n);
    }
    if (counts.size > 0) return counts;
  }
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
    lab.className = "check small agentTypeRow";

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
    const line = document.createElement("span");
    line.className = "agentType__line";
    const name = document.createElement("span");
    name.className = "agentType__name";
    name.textContent = labelizeEnum(it.sub_type);
    const count = document.createElement("span");
    count.className = "agentType__count";
    count.textContent = String(it.count);
    line.appendChild(name);
    line.appendChild(count);
    lab.appendChild(line);
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

function resetPathCache() {
  state.pathCache = null;
  state.pathAllCache = null;
}

function getSelectedTrack() {
  const bundle = state.bundle;
  const key = state.selectedKey;
  if (!bundle || !key || !key.modality || key.id == null) return null;

  const sceneKey = `${bundle.dataset_id}:${bundle.split}:${bundle.scene_id}`;
  const cacheKey = `${sceneKey}:${key.modality}:${String(key.id)}`;
  if (state.pathCache && state.pathCache.key === cacheKey) return state.pathCache;

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

  state.pathCache = { key: cacheKey, pts, frames, meta: { type: metaType, sub_type: metaSubType } };
  return state.pathCache;
}

function getAllTracksFor(modality) {
  const bundle = state.bundle;
  if (!bundle) return null;
  const sceneKey = `${bundle.dataset_id}:${bundle.split}:${bundle.scene_id}`;
  if (!state.pathAllCache || state.pathAllCache.key !== sceneKey) {
    state.pathAllCache = { key: sceneKey, byModality: {} };
  }
  const cache = state.pathAllCache;
  if (cache.byModality[modality]) return cache.byModality[modality];

  const tracks = new Map(); // id -> { pts: [[x,y],...], frames: [i,...], meta: {type, sub_type} }
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
        t = { pts: [], frames: [], meta: { type: null, sub_type: null } };
        tracks.set(id, t);
      }
      if (t.meta.type == null && r.type != null) t.meta.type = r.type;
      if (t.meta.sub_type == null && r.sub_type != null) t.meta.sub_type = r.sub_type;
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
    state.view = fitViewToExtent(transformExtentForSindTrajectory(bundle.extent, bundle), cssW, cssH, 28);
  }
  const view = state.view;

  // Optional scene background image (e.g., inD orthophoto).
  drawSceneBackground(ctx, view, cssW, cssH, dpr, bundle);

  // Optional raster basemap (for datasets with geo origin but no HD map).
  drawBasemap(ctx, view, cssW, cssH, dpr);
  syncBasemapStatusUi();

  // Draw map (Path2D cached per scene)
  if (state.showMap && bundle.map && state.mapPaths) {
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
  const rangeLabel = state.trajectoryRange === "none"
    ? "hidden"
    : (state.trajectoryRange === "past" ? "history tracks" : "full track");
  counts += ` · Trajectories: ${rangeLabel}`;
  $("countsLabel").textContent = counts;

  // World drawing pass: paths + agents + TL + highlight
  ctx.save();
  applyWorldTransform(ctx, view, cssW, cssH, dpr);

  // Visual anchors to reduce confusion:
  // - scene box: where trajectories actually are
  // - focus mask (optional): dims map outside scene when viewing full intersection
  if (state.focusMask && bundle.map && bundle.map.clip_mode === "intersection" && bundle.map.clip_extent) {
    const outer = bundle.map.clip_extent;
    const pad = clamp(Number(state.mapPadding || 120), 40, 250);
    const sceneExtent = transformExtentForSindTrajectory(bundle.extent, bundle);
    const inner = {
      min_x: sceneExtent.min_x - pad,
      min_y: sceneExtent.min_y - pad,
      max_x: sceneExtent.max_x + pad,
      max_y: sceneExtent.max_y + pad,
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
    const sceneExtent = transformExtentForSindTrajectory(bundle.extent, bundle);
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(
      sceneExtent.min_x,
      sceneExtent.min_y,
      sceneExtent.max_x - sceneExtent.min_x,
      sceneExtent.max_y - sceneExtent.min_y
    );
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.6 / view.scale;
    ctx.strokeRect(
      sceneExtent.min_x,
      sceneExtent.min_y,
      sceneExtent.max_x - sceneExtent.min_x,
      sceneExtent.max_y - sceneExtent.min_y
    );
    ctx.restore();
  }

  if (state.debugOverlay) {
    const px = (n) => n / view.scale;
    const sceneExtent = transformExtentForSindTrajectory(bundle.extent, bundle);
    // Scene extent
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = px(1.5);
    ctx.strokeRect(
      sceneExtent.min_x,
      sceneExtent.min_y,
      sceneExtent.max_x - sceneExtent.min_x,
      sceneExtent.max_y - sceneExtent.min_y
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

    if (state.trajectoryRange === "full") {
      // Future-on mode: keep past strong and make future visibly dashed.
      drawSegment(0, pts.length, 0.22, 1.8, null, false);

      // Future part from current frame onward (dashed + halo for contrast).
      const futureStart = Math.max(0, k - 1);
      drawSegment(futureStart, pts.length, 0.95, 2.6, [10, 7], true);

      // Past part up to the current frame (solid emphasis).
      drawSegment(0, k, 0.92, 3.0, null, true);
      return;
    }

    // History-only mode.
    drawSegment(0, k, 0.92, 3.0, null, true);
  };

  ctx.save();
  applySindTrajectoryWorldTransform(ctx, bundle);

  // Trajectories for all objects in scene.
  if (state.trajectoryRange !== "none") {
    for (const modality of agentModalitiesOrdered()) {
      if (!state.layers[modality]) continue;
      const tracks = getAllTracksFor(modality);
      if (!tracks) continue;
      for (const tr of tracks.values()) {
        const metaRec = tr.meta || {};
        if (!shouldDrawRec(modality, metaRec)) continue;
        const st = recSubType(metaRec);
        const col = (st && st !== "UNKNOWN") ? colorForRec(metaRec) : null;
        drawTrajectory(modality, tr.pts, tr.frames, 0.55, col);
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
      const [wx, wy] = applySindTrajectoryToPoint(rec.x, rec.y, bundle);
      const [cx, cy] = viewWorldToCanvas(view, cssW, cssH, wx, wy);
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
  if (!bundle) {
    $("sceneInfo").textContent = "Select a scene…";
    return;
  }
  const payload = buildAdvancedMetadataPayload(bundle);
  if (state.selectedKey) {
    const tr = getSelectedTrack();
    const ptsN = tr && tr.pts ? tr.pts.length : 0;
    let pastN = null;
    if (tr && tr.frames && tr.frames.length) {
      const fr = clamp(state.frame, 0, Math.max(0, (bundle && bundle.frames ? bundle.frames.length : 1) - 1));
      pastN = upperBound(tr.frames, fr);
    }
    payload.selection = {
      key: state.selectedKey,
      frame_record: state.selected || null,
      trajectory_mode: {
        range: (state.trajectoryRange === "none" || state.trajectoryRange === "past" || state.trajectoryRange === "full")
          ? state.trajectoryRange
          : "full",
        points: ptsN,
        past_points: pastN,
      },
    };
  }
  if (extraLines.length) payload.notes = extraLines;
  $("sceneInfo").textContent = JSON.stringify(payload, null, 2);
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

function formatInt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return Math.max(0, Math.round(v)).toLocaleString();
}

function formatSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "n/a";
  return `${n.toFixed(1)} m/s`;
}

function renderSceneBrowserGroup(title, rows) {
  const body = (rows || [])
    .map(([k, v]) => `<div class="sceneBrowser__row"><span class="sceneBrowser__label">${escapeHtml(k)}</span><span class="sceneBrowser__value">${escapeHtml(v)}</span></div>`)
    .join("");
  return `<div class="sceneBrowser__group"><div class="sceneBrowser__title">${escapeHtml(title)}</div>${body}</div>`;
}

function updateSplitAvailabilityHint(availability) {
  const el = $("splitAvailabilityHint");
  if (!el) return;

  const avail = availability && typeof availability === "object" ? availability : null;
  const byModality = avail && avail.by_modality && typeof avail.by_modality === "object" ? avail.by_modality : null;
  if (!byModality) {
    el.innerHTML = "";
    return;
  }

  let modalOrder = Array.isArray(state.modalities) ? state.modalities.map(String) : [];
  if (!modalOrder.length) {
    modalOrder = ["ego", "infra", "vehicle", "traffic_light"].filter((m) => Object.prototype.hasOwnProperty.call(byModality, m));
  }
  if (!modalOrder.length) {
    modalOrder = Object.keys(byModality);
  }
  const rows = [];
  for (const m of modalOrder) {
    const c = Number(byModality[m] || 0);
    const label = modalityShortLabel(m);
    rows.push([label, formatInt(c)]);
  }
  el.innerHTML = renderSceneBrowserGroup("Availability", rows);
}

function updateSceneHint(total, _shown, _mismatch) {
  const el = $("sceneHint");
  if (!el) return;
  const groupLabel = state.groupLabel || "Intersection";
  const rows = [];
  const allLabel = String(groupLabel).toLowerCase() === "intersection"
    ? "All intersections"
    : `All ${pluralizeLower(groupLabel) || "groups"}`;
  if (state.intersectId) {
    let lab = null;
    const interSel = $("intersectSelect");
    if (interSel) {
      const opt = Array.from(interSel.options).find((o) => String(o.value) === String(state.intersectId));
      if (opt && opt.textContent) lab = String(opt.textContent).replace(/\s*\(\d+\)\s*$/, "");
    }
    lab = lab || intersectionLabel(state.intersectId) || state.intersectId;
    rows.push([groupLabel, String(lab)]);
  } else {
    rows.push([groupLabel, allLabel]);
  }
  rows.push(["Total scenes", formatInt(total != null ? total : 0)]);
  el.innerHTML = renderSceneBrowserGroup("Scope", rows);
}

const SCENE_CLOSE_ENCOUNTER_THRESHOLD_M = 2.5;
const SCENE_STOP_SPEED_MPS = 0.25;
const SCENE_MOVE_SPEED_MPS = 0.8;

function wrapAngleRad(a) {
  let x = Number(a);
  if (!Number.isFinite(x)) return null;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function headingBetween(p0, p1) {
  if (!p0 || !p1) return null;
  const dx = Number(p1.x) - Number(p0.x);
  const dy = Number(p1.y) - Number(p0.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  return Math.atan2(dy, dx);
}

function normalizeDtSeconds(dtRaw) {
  let dt = Number(dtRaw);
  if (!Number.isFinite(dt) || dt <= 0) return null;
  // Some datasets carry millisecond timestamps; normalize to seconds.
  if (dt > 20) dt /= 1000;
  return dt > 0 ? dt : null;
}

function scenePublicIntersection(bundle) {
  const raw = String(bundle && (bundle.intersect_label || bundle.intersect_id || "") || "");
  const m = raw.match(/(\d{1,3})/);
  if (m) return `Intersection ${String(Number(m[1])).padStart(2, "0")}`;
  if (/^intersection\b/i.test(raw)) return raw.replace(/\s+/g, " ").trim();
  return "Intersection";
}

function scenePublicScene(bundle) {
  const sceneLabel = String(bundle && bundle.scene_label ? bundle.scene_label : "").trim();
  const sceneId = String(bundle && bundle.scene_id != null ? bundle.scene_id : "").trim();
  const fromLabel = sceneLabel.match(/scene\s*([0-9]+)/i) || sceneLabel.match(/\b([0-9]{1,4})\b/);
  if (fromLabel) return `Scene ${Number(fromLabel[1])}`;
  if (/^\d+$/.test(sceneId)) return `Scene ${Number(sceneId)}`;
  return sceneLabel && /^scene/i.test(sceneLabel) ? sceneLabel : "Scene";
}

function isVruTrack(track) {
  if (!track) return false;
  const t = String(track.type || "").toUpperCase();
  if (t === "VRU" || t === "PEDESTRIAN" || t === "BICYCLE") return true;
  for (const st of (track.subTypes || [])) {
    const s = String(st || "").toUpperCase();
    if (s.includes("PED") || s.includes("BICYCLE") || s.includes("CYCL") || s.includes("SCOOT")) return true;
  }
  return false;
}

function extractYieldConflictCount(bundle) {
  const sources = [];
  if (Array.isArray(bundle && bundle.events)) sources.push(bundle.events);
  if (Array.isArray(bundle && bundle.interaction_events)) sources.push(bundle.interaction_events);
  if (Array.isArray(bundle && bundle.interactions)) sources.push(bundle.interactions);
  if (!sources.length) return null;
  let n = 0;
  for (const src of sources) {
    for (const it of src) {
      const txt = typeof it === "string" ? it : JSON.stringify(it || {});
      if (/yield|conflict/i.test(txt)) n += 1;
    }
  }
  return n;
}

function collectSceneProfileMetrics(bundle) {
  const frames = Array.isArray(bundle && bundle.frames) ? bundle.frames : [];
  const timestamps = Array.isArray(bundle && bundle.timestamps) ? bundle.timestamps : [];
  const modalities = Array.isArray(state.modalities) ? state.modalities.filter((m) => m !== "traffic_light") : ["infra", "vehicle", "ego"];

  const tracks = new Map(); // key -> { type, subTypes:Set, samples:[...] }
  let peakSimultaneous = 0;
  let minInterAgentDistance = Infinity;
  let closeEncounters = 0;
  const pairState = new Map(); // key -> { close, lastFrame }

  for (let fi = 0; fi < frames.length; fi++) {
    const fr = frames[fi] || {};
    const agents = [];
    let frameCount = 0;

    for (const modality of modalities) {
      const recs = fr[modality] || [];
      for (const rec of recs) {
        if (!rec || rec.id == null) continue;
        const x = Number(rec.x);
        const y = Number(rec.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

        frameCount += 1;
        const key = `${modality}:${String(rec.id)}`;
        agents.push({ key, x, y });

        let tr = tracks.get(key);
        if (!tr) {
          tr = { type: "UNKNOWN", subTypes: new Set(), samples: [] };
          tracks.set(key, tr);
        }

        const t = recType(rec);
        const st = recSubType(rec);
        if (tr.type === "UNKNOWN" && t !== "UNKNOWN") tr.type = t;
        tr.subTypes.add(st);

        const vx = Number(rec.vx);
        const vy = Number(rec.vy);
        const speedRaw = Number(rec.speed_mps ?? rec.speed ?? rec.velocity ?? NaN);
        tr.samples.push({
          frame: fi,
          ts: (timestamps[fi] != null && Number.isFinite(Number(timestamps[fi]))) ? Number(timestamps[fi]) : null,
          x,
          y,
          vx: Number.isFinite(vx) ? vx : null,
          vy: Number.isFinite(vy) ? vy : null,
          speedRaw: Number.isFinite(speedRaw) ? Math.abs(speedRaw) : null,
        });
      }
    }

    peakSimultaneous = Math.max(peakSimultaneous, frameCount);

    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i];
        const b = agents[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (Number.isFinite(d)) minInterAgentDistance = Math.min(minInterAgentDistance, d);

        const pairKey = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
        const prev = pairState.get(pairKey);
        const prevClose = !!(prev && prev.lastFrame === fi - 1 && prev.close);
        const isClose = Number.isFinite(d) && d <= SCENE_CLOSE_ENCOUNTER_THRESHOLD_M;
        if (isClose && !prevClose) closeEncounters += 1;
        pairState.set(pairKey, { close: isClose, lastFrame: fi });
      }
    }
  }

  let vruCount = 0;
  let rareBus = 0;
  let rareTruck = 0;
  let speedSum = 0;
  let speedN = 0;
  let laneChanges = 0;
  let turns = 0;
  let fullStops = 0;

  for (const tr of tracks.values()) {
    if (isVruTrack(tr)) vruCount += 1;
    const subTypes = Array.from(tr.subTypes || []);
    const hasBus = subTypes.some((s) => /BUS/.test(String(s)));
    const hasTruck = subTypes.some((s) => /TRUCK/.test(String(s)));
    if (hasBus) rareBus += 1;
    if (hasTruck) rareTruck += 1;

    const samples = Array.isArray(tr.samples) ? tr.samples : [];
    if (!samples.length) continue;

    const speeds = new Array(samples.length).fill(null);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      let sp = null;
      if (s.vx != null && s.vy != null) {
        sp = Math.hypot(s.vx, s.vy);
      } else if (s.speedRaw != null) {
        sp = s.speedRaw;
      } else if (i > 0) {
        const p = samples[i - 1];
        const dt = normalizeDtSeconds((s.ts != null && p.ts != null) ? (s.ts - p.ts) : (s.frame - p.frame));
        if (dt != null) {
          sp = Math.hypot(s.x - p.x, s.y - p.y) / dt;
        }
      }
      if (Number.isFinite(sp)) {
        speeds[i] = Math.max(0, sp);
        speedSum += Math.max(0, sp);
        speedN += 1;
      }
    }

    let moved = false;
    let inStop = false;
    let stopRun = 0;
    for (let i = 0; i < speeds.length; i++) {
      const sp = speeds[i];
      if (!Number.isFinite(sp)) continue;
      if (sp >= SCENE_MOVE_SPEED_MPS) moved = true;
      if (sp <= SCENE_STOP_SPEED_MPS) {
        stopRun += 1;
        if (moved && !inStop && stopRun >= 2) {
          fullStops += 1;
          inStop = true;
        }
      } else {
        stopRun = 0;
        if (sp > SCENE_STOP_SPEED_MPS + 0.2) inStop = false;
      }
    }

    let lastTurnAt = -999;
    let lastLaneChangeAt = -999;
    for (let i = 2; i < samples.length - 2; i++) {
      const p0 = samples[i - 2];
      const p1 = samples[i];
      const p2 = samples[i + 2];
      const hin = headingBetween(p0, p1);
      const hout = headingBetween(p1, p2);
      if (hin == null || hout == null) continue;
      const headingDelta = Math.abs(wrapAngleRad(hout - hin) || 0) * (180 / Math.PI);
      const chord = Math.hypot(p2.x - p0.x, p2.y - p0.y);
      if (!(chord > 3)) continue;
      const area2 = Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x));
      const lateralOffset = area2 / Math.max(1e-6, chord);
      const sp = speeds[i];
      const speedOk = !Number.isFinite(sp) || sp > SCENE_MOVE_SPEED_MPS;

      if (speedOk && headingDelta >= 30) {
        if (i - lastTurnAt > 6) {
          turns += 1;
          lastTurnAt = i;
        }
        continue;
      }
      if (speedOk && headingDelta <= 14 && lateralOffset >= 1.4) {
        if (i - lastLaneChangeAt > 8) {
          laneChanges += 1;
          lastLaneChangeAt = i;
        }
      }
    }
  }

  return {
    totalAgents: tracks.size,
    peakSimultaneous,
    vruCount,
    rareBus,
    rareTruck,
    avgSpeed: speedN > 0 ? (speedSum / speedN) : null,
    laneChanges,
    turns,
    fullStops,
    closeEncounters,
    minInterAgentDistance: Number.isFinite(minInterAgentDistance) ? minInterAgentDistance : null,
    yieldConflictEvents: extractYieldConflictCount(bundle),
  };
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

  const metrics = collectSceneProfileMetrics(b);
  const trajectorySize = extentWH(b.extent);
  const clipSize = extentWH((b.map && b.map.clip_extent) ? b.map.clip_extent : b.extent);
  const lanesShown = b.map && Array.isArray(b.map.lanes) ? b.map.lanes.length : 0;
  const crosswalksShown = b.map && Array.isArray(b.map.crosswalks) ? b.map.crosswalks.length : 0;

  const rareVehicles = [];
  if (metrics.rareBus > 0) rareVehicles.push(`Bus (${formatInt(metrics.rareBus)})`);
  if (metrics.rareTruck > 0) rareVehicles.push(`Truck (${formatInt(metrics.rareTruck)})`);
  const rareVehicleText = rareVehicles.length ? rareVehicles.join(" · ") : "None detected";

  const groups = [
    {
      title: "Agents",
      rows: [
        ["Total active agents", formatInt(metrics.totalAgents)],
        ["Peak simultaneous", formatInt(metrics.peakSimultaneous)],
        ["VRU count", formatInt(metrics.vruCount)],
        ["Rare vehicle presence", rareVehicleText],
      ],
    },
    {
      title: "Motion",
      rows: [
        ["Average speed", formatSpeed(metrics.avgSpeed)],
        ["Lane changes", formatInt(metrics.laneChanges)],
        ["Turns", formatInt(metrics.turns)],
        ["Full stops", formatInt(metrics.fullStops)],
      ],
    },
    {
      title: "Interaction",
      rows: [
        [`Close encounters (≤${SCENE_CLOSE_ENCOUNTER_THRESHOLD_M.toFixed(1)}m)`, formatInt(metrics.closeEncounters)],
        ["Minimum inter-agent distance", fmtMeters(metrics.minInterAgentDistance)],
      ],
    },
    {
      title: "Spatial Context",
      rows: [
        ["Trajectory area", `${fmtMeters(trajectorySize.w)} × ${fmtMeters(trajectorySize.h)}`],
        ["Scene clip size", `${fmtMeters(clipSize.w)} × ${fmtMeters(clipSize.h)}`],
        ["Lanes shown", `${formatInt(lanesShown)}${b.map && b.map.lanes_truncated ? " (truncated)" : ""}`],
        ["Crosswalks", formatInt(crosswalksShown)],
      ],
    },
  ];
  if (metrics.yieldConflictEvents != null) {
    groups[2].rows.push(["Yield/conflict events", formatInt(metrics.yieldConflictEvents)]);
  }

  const groupsHtml = groups
    .map((g) => {
      const rows = g.rows
        .slice(0, 4)
        .map(([k, v]) => `<div class="sceneProfile__row"><span class="sceneProfile__label">${escapeHtml(k)}</span><span class="sceneProfile__value">${escapeHtml(v)}</span></div>`)
        .join("");
      return `<section class="sceneProfile__group"><div class="sceneProfile__groupTitle">${escapeHtml(g.title)}</div>${rows}</section>`;
    })
    .join("");

  const headerTitle = `${scenePublicIntersection(b)} · ${scenePublicScene(b)}`;
  const headerMeta = [b.city || null, splitLabel(b.split)].filter(Boolean).join(" · ");
  el.innerHTML = `
    <div class="sceneProfile">
      <div class="sceneProfile__header">
        <div class="sceneProfile__title">${escapeHtml(headerTitle)}</div>
        <div class="sceneProfile__meta">${escapeHtml(headerMeta || splitLabel(b.split))}</div>
      </div>
      ${groupsHtml}
    </div>
  `;
}

async function loadDatasets() {
  const data = await fetchJson("/api/datasets");
  const sel = $("datasetSelect");
  if (sel) sel.innerHTML = "";
  state.datasetsById = {};
  const supportedIds = [];
  for (const raw of data.datasets || []) {
    if (!raw || !raw.id) continue;
    const id = String(raw.id || "").trim();
    if (!id) continue;
    const appSpec = (raw.app && typeof raw.app === "object") ? raw.app : {};
    const family = String(raw.family || appSpec.family || "").trim().toLowerCase();
    const supported = (typeof raw.supported === "boolean")
      ? raw.supported
      : ((typeof appSpec.supported === "boolean") ? appSpec.supported : true);
    const ds = {
      ...raw,
      id,
      family: family || String(raw.family || "").trim().toLowerCase(),
      supported,
    };
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
  function staticCatalogFallback() {
    try {
      const raw = (window.WebBackend && Array.isArray(window.WebBackend.STATIC_CATALOG))
        ? window.WebBackend.STATIC_CATALOG
        : [];
      return Array.isArray(raw) ? raw.filter((it) => it && it.id) : [];
    } catch (_) {
      return [];
    }
  }

  function mergeCatalogItems(primary, fallback) {
    const out = [];
    const seen = new Set();
    for (const it of primary || []) {
      if (!it || !it.id) continue;
      const id = String(it.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(it);
    }
    for (const it of fallback || []) {
      if (!it || !it.id) continue;
      const id = String(it.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(it);
    }
    return out;
  }

  state.catalogById = {};
  state.catalogDatasets = [];
  let apiItems = [];
  try {
    const data = await fetchJson("/api/catalog");
    apiItems = Array.isArray(data.datasets) ? data.datasets : [];
  } catch (e) {
    apiItems = [];
  }

  // Keep landing-page cards stable even when /api/catalog is missing/incomplete.
  const items = mergeCatalogItems(apiItems, staticCatalogFallback());
  state.catalogDatasets = items;
  for (const it of items) {
    if (it && it.id) state.catalogById[String(it.id)] = it;
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
  const d = trajDomain();
  if (d && typeof d.datasetTypeLabel === "function") {
    return d.datasetTypeLabel(datasetType);
  }
  warnMissingTrajDomainOnce();
  const t = String(datasetType || "").toLowerCase();
  if (t === "v2x_traj") return "V2X-Traj";
  if (t === "v2x_seq") return "V2X-Seq";
  if (t === "ind") return "inD";
  if (t === "sind") return "SinD";
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
  const d = trajDomain();
  if (d && typeof d.datasetTypeFromFamily === "function") {
    return d.datasetTypeFromFamily(family);
  }
  warnMissingTrajDomainOnce();
  const fam = String(family || "").trim().toLowerCase();
  if (fam === "v2x-traj") return "v2x_traj";
  if (fam === "v2x-seq") return "v2x_seq";
  if (fam === "ind") return "ind";
  if (fam === "sind") return "sind";
  if (fam === "cpm-objects") return "consider_it_cpm";
  return "";
}

function datasetFamilyFromMeta(meta) {
  if (!meta || typeof meta !== "object") return "";
  const direct = String(meta.family || "").trim().toLowerCase();
  if (direct) return direct;
  const app = (meta.app && typeof meta.app === "object") ? meta.app : null;
  return String((app && app.family) || "").trim().toLowerCase();
}

function datasetTypeFromMeta(meta) {
  return datasetTypeFromFamily(datasetFamilyFromMeta(meta));
}

function supportedLocalFamily(family) {
  const d = trajDomain();
  if (d && typeof d.isSupportedLocalFamily === "function") {
    return !!d.isSupportedLocalFamily(family);
  }
  warnMissingTrajDomainOnce();
  const fam = String(family || "").trim().toLowerCase();
  return fam === "v2x-traj" || fam === "v2x-seq" || fam === "ind" || fam === "sind" || fam === "cpm-objects";
}

function virtualDatasetMeta(datasetId, title, family) {
  const d = trajDomain();
  if (d && typeof d.buildVirtualDatasetMeta === "function") {
    return d.buildVirtualDatasetMeta(datasetId, title, family);
  }
  warnMissingTrajDomainOnce();
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
      has_scene_background: false,
      has_traffic_lights: false,
      modalities: ["infra"],
      modality_labels: { infra: "Objects" },
      modality_short_labels: { infra: "Objects" },
    };
  }
  if (fam === "ind") {
    return {
      ...base,
      splits: ["all"],
      default_split: "all",
      group_label: "Location",
      has_map: true,
      has_scene_background: true,
      has_traffic_lights: false,
      modalities: ["infra"],
      modality_labels: { infra: "Road users" },
      modality_short_labels: { infra: "Objects" },
    };
  }
  if (fam === "sind") {
    return {
      ...base,
      splits: ["all"],
      default_split: "all",
      group_label: "City",
      has_map: true,
      has_scene_background: true,
      has_traffic_lights: true,
      modalities: ["infra", "traffic_light"],
      modality_labels: { infra: "Road users", traffic_light: "Traffic lights" },
      modality_short_labels: { infra: "Objects", traffic_light: "Lights" },
    };
  }
  return {
    ...base,
    splits: ["all"],
    default_split: "all",
    group_label: "Group",
    has_map: false,
    has_scene_background: false,
    modalities: ["infra"],
    modality_labels: { infra: "Objects" },
    modality_short_labels: { infra: "Objects" },
  };
}

function ensureDatasetMetaForCard(datasetId) {
  const did = String(datasetId || "").trim();
  if (!did) return null;
  if (state.datasetsById && state.datasetsById[did]) {
    const existing = state.datasetsById[did];
    const fam = datasetFamilyFromMeta(existing);
    if (fam && String(existing.family || "").trim().toLowerCase() !== fam) {
      state.datasetsById[did] = { ...existing, family: fam };
    }
    return state.datasetsById[did];
  }
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
  if (t === "ind") {
    const datasetId = selectedDatasetId || "ind";
    const safe = safeFromId || "ind";
    return {
      profile_id: `runtime-${safe}`,
      dataset_id: datasetId,
      name: selectedTitle || "inD",
    };
  }
  if (t === "sind") {
    const datasetId = selectedDatasetId || "sind";
    const safe = safeFromId || "sind";
    return {
      profile_id: `runtime-${safe}`,
      dataset_id: datasetId,
      name: selectedTitle || "SinD",
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

function updateExplorerHeaderContext() {
  const meta = currentDatasetMeta() || {};
  const datasetName = String(meta.title || state.datasetId || "Dataset").trim() || "Dataset";
  const datasetChip = $("activeDatasetName");
  if (datasetChip) datasetChip.textContent = datasetName;
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

async function pickFolderViaWebFs() {
  if (!window.WebFS) {
    throw new Error("Web file picker is unavailable.");
  }
  if (window.WebFS.isSupported && !window.WebFS.isSupported()) {
    alert("Your browser does not support the File System Access API (needed for local file access). Please use Chrome, Edge, or Opera.");
    return [];
  }
  try {
    const handle = await window.WebFS.pickDirectory();
    return handle ? [handle.name] : [];
  } catch (e) {
    console.error("Picker error:", e);
    return [];
  }
}

async function pickFolderViaApi(promptText, defaultPath = "") {
  const url = "/api/system/pick_folder";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: String(promptText || "Select dataset directory"),
      default_path: String(defaultPath || "").trim(),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw makeApiError(url, res, text);
  }
  const payload = await res.json();
  if (payload && Array.isArray(payload.paths)) {
    return payload.paths.map((x) => String(x || "").trim()).filter(Boolean);
  }
  const one = String((payload && payload.path) || "").trim();
  return one ? [one] : [];
}

async function pickPathsDesktop(methodName, fallbackPrompt, defaultPath = "") {
  const forceEmbedded = shouldForceEmbeddedWebBackend();
  if (methodName === "pick_folder" && forceEmbedded && window.WebFS) {
    return pickFolderViaWebFs();
  }
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
    let apiErr = null;
    if (!forceEmbedded) {
      try {
        return await pickFolderViaApi(fallbackPrompt || "Select dataset directory", defaultPath);
      } catch (e) {
        apiErr = e;
        const status = Number(e && e.status);
        if (status === 403) {
          throw new Error("Native folder picker is blocked on this URL. Open the app from http://localhost and try again.");
        }
      }
    }

    if (canFallbackToEmbeddedWebBackend() && window.WebFS) {
      const status = Number(apiErr && apiErr.status);
      if (!Number.isFinite(status) || isEmbeddedFallbackStatus(status)) {
        return pickFolderViaWebFs();
      }
    }

    if (apiErr) {
      throw apiErr;
    }
    throw new Error("Native folder picker is unavailable. Run the local server on your Mac and open the app from localhost.");
  }
  throw new Error("Folder picker method is not supported.");
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
  if (!sourceHintEl) {
    updateExplorerHeaderContext();
    return;
  }

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
      const fullPath = String(src.folderPath || "").trim();
      sourceCardTitle.textContent = `${dsName} · ${folderName}`;
      sourceCardPath.textContent = `Folder: ${folderName}`;
      sourceCardPath.title = fullPath;
    } else {
      sourceCardTitle.textContent = "Dataset folder";
      sourceCardPath.textContent = "";
      sourceCardPath.title = "";
    }
  }
  updateExplorerHeaderContext();
}

function expectedDatasetLayoutHint(datasetType) {
  const d = trajDomain();
  if (d && typeof d.expectedDatasetLayoutHint === "function") {
    return d.expectedDatasetLayoutHint(datasetType);
  }
  warnMissingTrajDomainOnce();
  const t = String(datasetType || "").trim().toLowerCase();
  if (t === "v2x_traj") return "Expected root folders: ego-trajectories, infrastructure-trajectories, vehicle-trajectories, and optional maps/traffic-light.";
  if (t === "v2x_seq") return "Expected root folders: cooperative-vehicle-infrastructure, single-infrastructure, and/or single-vehicle.";
  if (t === "consider_it_cpm") return "Expected root folders: lidar and/or thermal_camera with CPM CSV logs.";
  if (t === "ind") return "Expected inD root with data/*_tracks.csv, *_tracksMeta.csv, *_recordingMeta.csv and optional maps/lanelets.";
  if (t === "sind") return "Expected SinD root with city folders, scenario folders, and Veh_smoothed_tracks.csv / Ped_smoothed_tracks.csv files.";
  return "";
}

function datasetTypeDisplayName(datasetType) {
  const d = trajDomain();
  if (d && typeof d.datasetTypeDisplayName === "function") {
    return d.datasetTypeDisplayName(datasetType);
  }
  warnMissingTrajDomainOnce();
  const t = String(datasetType || "").trim().toLowerCase();
  if (t === "v2x_traj") return "V2X-Traj";
  if (t === "v2x_seq") return "V2X-Seq";
  if (t === "consider_it_cpm") return "Consider.it";
  if (t === "ind") return "inD";
  if (t === "sind") return "SinD";
  return "this dataset";
}

function friendlyLoadFailureMessage(err, datasetType) {
  const raw = String((err && err.message) ? err.message : (err || "")).trim();
  const low = raw.toLowerCase();
  const name = datasetTypeDisplayName(datasetType);

  if (
    !raw
    || low.includes("could not detect dataset profile")
    || low.includes("validation failed")
    || low.includes("required")
    || low.includes("expected")
    || low.includes("missing")
    || low.includes("schema")
    || low.includes("column")
  ) {
    return `Wrong folder for ${name}. Please select the correct dataset root.`;
  }
  if (low.includes("native folder picker is unavailable")) {
    return "Folder picker is unavailable. Please run the app locally and try again.";
  }
  return raw.length > 140
    ? `Could not load folder for ${name}. Please try again with the dataset root folder.`
    : raw;
}

function sourceIssueMessage(validation, datasetType) {
  const errors = Array.isArray(validation && validation.errors) ? validation.errors : [];
  const warnings = Array.isArray(validation && validation.warnings) ? validation.warnings : [];
  const first = errors.length ? errors[0] : (warnings.length ? warnings[0] : null);
  if (!first) return "";
  const msg = String(first.message || "Validation failed.").trim();
  const hint = expectedDatasetLayoutHint(datasetType);
  const code = String(first.code || "");
  if (hint && (code === "E_SCHEMA_REQUIRED_COLUMNS" || code === "E_ROLE_REQUIRED_MISSING" || code === "E_PATH_MISSING")) {
    return `${msg} ${hint}`;
  }
  return msg;
}

function isLikelyDirectoryPath(pathStr) {
  const s = String(pathStr || "").trim();
  if (!s) return false;
  if (/[\\\/]$/.test(s)) return true;
  const low = s.toLowerCase();
  return !low.endsWith(".csv") && !low.endsWith(".json") && !low.endsWith(".proto") && !low.endsWith(".txt");
}

async function loadDatasetFromFolder(folderPathIn) {
  const meta = currentDatasetMeta() || {};
  const datasetType = datasetTypeFromMeta(meta);
  const src = sourceState(datasetType);
  if (!datasetType) {
    src.hint = "This dataset family does not support local loading yet.";
    src.tone = "bad";
    persistSourceByType();
    setConnectResult(src.hint, src.tone);
    updateSourcePanel();
    return;
  }
  const folderPath = String(folderPathIn || "").trim();
  if (!folderPath) {
    src.hint = "No dataset directory selected.";
    src.tone = "bad";
    persistSourceByType();
    setConnectResult(src.hint, src.tone);
    updateSourcePanel();
    return;
  }
  if (!isLikelyDirectoryPath(folderPath)) {
    src.hint = "Please select a dataset directory (folder), not a file.";
    src.tone = "bad";
    persistSourceByType();
    setConnectResult(src.hint, src.tone);
    updateSourcePanel();
    return;
  }

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
      throw new Error(`Could not detect dataset profile from selected folder. ${expectedDatasetLayoutHint(datasetType)}`);
    }
    const profile = cloneObj(detected.profile);
    profile.profile_id = preset.profile_id;
    profile.dataset_id = preset.dataset_id;
    profile.name = preset.name;

    const validated = await postJson("/api/profiles/validate", { profile });
    const status = String(((validated && validated.validation) ? validated.validation.status : "") || "");
    if (status !== "ready" && status !== "ready_with_warnings") {
      const detail = sourceIssueMessage(validated && validated.validation, datasetType);
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
      ? `Loaded with warnings: ${sourceIssueMessage(validated.validation, datasetType) || "check mapping."}`
      : "Dataset source loaded.";
    src.tone = status === "ready_with_warnings" ? "warn" : "ok";
    persistSourceByType();

    await openExplorerForDataset(runtimeDatasetId, { savePrev: false });
    const loadedScenes = Array.isArray(state.sceneIds) ? state.sceneIds.length : 0;
    if (loadedScenes <= 0) {
      const hint = expectedDatasetLayoutHint(datasetType);
      src.hint = hint
        ? `Dataset loaded, but no scenes were found. ${hint}`
        : "Dataset loaded, but no scenes were found in the selected directory.";
      src.tone = "warn";
      persistSourceByType();
    }
    setConnectResult(src.hint, src.tone);
  } catch (e) {
    const msg = friendlyLoadFailureMessage(e, datasetType);
    src.hint = msg;
    src.tone = "bad";
    persistSourceByType();
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
  if (selected === "v2x_traj" || selected === "v2x_seq" || selected === "consider_it_cpm" || selected === "ind" || selected === "sind") return selected;
  const draftType = String(((state.profileWizard.draft || {}).profile || {}).dataset_type || "").trim();
  if (draftType === "v2x_traj" || draftType === "v2x_seq" || draftType === "consider_it_cpm" || draftType === "ind" || draftType === "sind") return draftType;
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

  if (datasetType === "ind") {
    const prevScene = profile.scene_strategy && typeof profile.scene_strategy === "object" ? profile.scene_strategy : {};
    const windowS = Number.isFinite(Number(prevScene.window_s)) ? Number(prevScene.window_s) : 60;
    profile.scene_strategy = { mode: "recording_window", window_s: Math.max(10, Math.min(600, windowS)) };
    delete bindings.scenes_index;
    delete bindings.traj_ego;
    delete bindings.traj_cooperative;
    delete bindings.traj_infra;
    delete bindings.traj_vehicle;
    delete bindings.traffic_light;
    delete bindings.cpm_logs;
    delete bindings.proto_schema;
  }

  if (datasetType === "sind") {
    profile.scene_strategy = { mode: "scenario_scene" };
    delete bindings.scenes_index;
    delete bindings.traj_ego;
    delete bindings.traj_cooperative;
    delete bindings.traj_infra;
    delete bindings.traj_vehicle;
    delete bindings.traffic_light;
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
    const fam = String(ds.family || "").trim().toLowerCase();
    const isProfileAlias = id.startsWith("profile-");
    if (isProfileAlias && fam) {
      const hasCatalogFamily = items.some((it) => {
        const app = (it && typeof it.app === "object") ? it.app : {};
        return String(app.family || "").trim().toLowerCase() === fam;
      });
      if (hasCatalogFamily) {
        continue;
      }
    }
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

  const hasFilters = !!(q || catFilter || mapFilter || tlFilter);
  const showNoMatchFallback = hasFilters && items.length > 0 && filtered.length === 0;
  const displayItems = showNoMatchFallback ? items : filtered;

  const installed = [];
  const catalogOnly = [];
  for (const it of displayItems) {
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
    const showing = displayItems.length;
    const chips = [];
    chips.push(`<span class="chip chip--yes">Available: ${totalInstalled}</span>`);
    chips.push(`<span class="chip">Connections: ${totalProfiles}</span>`);
    if (totalCatalog) chips.push(`<span class="chip">Catalog: ${totalCatalog}</span>`);
    if (hasFilters) chips.push(`<span class="chip">Showing: ${showing}</span>`);
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
        const catLabel = prettyCategoryLabel(it.category);
        const splits = ds && Array.isArray(ds.splits) && ds.splits.length
          ? ds.splits.map(splitLabel).join(" · ")
          : "";

        const coreFacts = [];
        if (catLabel) coreFacts.push(["Category", catLabel]);
        if (caps.coordinate_frame) coreFacts.push(["Frame", String(caps.coordinate_frame)]);
        if (caps.scene_unit) coreFacts.push(["Scene", String(caps.scene_unit)]);
        if (splits) coreFacts.push(["Splits", splits]);
        const factsHtml = coreFacts.length
          ? `<div class="dsFacts">${coreFacts.map(([k, v]) => `<div class="dsFact"><span class="dsFact__label">${escapeHtml(k)}</span><span class="dsFact__value">${escapeHtml(v)}</span></div>`).join("")}</div>`
          : "";

        function capabilityPill(label, value) {
          const cls = value === true ? "dsCap dsCap--yes" : (value === false ? "dsCap dsCap--no" : "dsCap dsCap--unknown");
          const val = value === true ? "Yes" : (value === false ? "No" : "Unknown");
          return `<span class="${cls}">${escapeHtml(label)}: ${escapeHtml(val)}</span>`;
        }
        const capsHtml = `<div class="dsCaps">${capabilityPill("HD map", caps.has_map)}${capabilityPill("Traffic lights", caps.has_traffic_lights)}</div>`;

        function linkPriority(label) {
          const s = String(label || "").toLowerCase();
          if (s.includes("paper") || s.includes("arxiv")) return 3;
          if (s.includes("code") || s.includes("github") || s.includes("project")) return 2;
          return 1;
        }
        const links = (Array.isArray(it.links) ? it.links : [])
          .map((l) => ({
            href: l && l.url ? String(l.url).trim() : "",
            label: l && l.label ? String(l.label).trim() : "Link",
          }))
          .filter((l) => l.href);
        links.sort((a, b) => {
          const pr = linkPriority(b.label) - linkPriority(a.label);
          if (pr) return pr;
          return a.label.localeCompare(b.label);
        });
        const primaryLinks = links.slice(0, 2);
        const extraLinks = links.slice(2, 5);
        const linkHtml = primaryLinks
          .map((l) => `<a class="dsActionLink" href="${escapeHtml(l.href)}" target="_blank" rel="noreferrer">${escapeHtml(l.label)}</a>`)
          .join("");

        const titleLine = escapeHtml(it.title || it.id || "Dataset");
        const metaBits = [it.year ? String(it.year) : null, it.venue || null].filter(Boolean);
        const meta = metaBits.length ? `<div class="dsCard__meta">${escapeHtml(metaBits.join(" · "))}</div>` : "";

        const summary = String(it.summary || "").trim();
        const highlights = (Array.isArray(it.highlights) ? it.highlights : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 4);
        const summaryCompact = summary || (highlights.length ? highlights[0] : "");
        const summaryHtml = summaryCompact ? `<p class="dsSummary dsSummary--compact">${escapeHtml(summaryCompact)}</p>` : "";

        const detailFacts = [];
        if (ds && ds.group_label) detailFacts.push(["Group", String(ds.group_label)]);
        const detailFactsHtml = detailFacts.length
          ? `<div class="dsDetailFacts">${detailFacts.map(([k, v]) => `<div class="dsDetailFact"><span class="dsDetailFact__label">${escapeHtml(k)}</span><span class="dsDetailFact__value">${escapeHtml(v)}</span></div>`).join("")}</div>`
          : "";
        const detailHighlightsHtml = highlights.length
          ? `<ul class="dsDetailList">${highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>`
          : "";
        const detailLinksHtml = extraLinks.length
          ? `<div class="dsDetailLinks">${extraLinks.map((l) => `<a class="dsDetailLink" href="${escapeHtml(l.href)}" target="_blank" rel="noreferrer">${escapeHtml(l.label)}</a>`).join("")}</div>`
          : "";
        const detailsHtml = (summary || detailFacts.length || highlights.length > 1 || extraLinks.length)
          ? `<details class="dsDetails"><summary>More details</summary><div class="dsDetails__body">${summary ? `<p class="dsDetailText">${escapeHtml(summary)}</p>` : ""}${detailHighlightsHtml}${detailFactsHtml}${detailLinksHtml}</div></details>`
          : "";

        const btnHtml = isSupported
          ? `<button class="btn btn--sm" type="button" data-open-dataset="${escapeHtml(it.id)}">Open Explorer</button>`
          : `<button class="btn btn--ghost btn--sm" type="button" disabled>Planned</button>`;

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
            ${factsHtml}
            ${capsHtml}
            ${detailsHtml}
            <div class="dsActions">
              <div class="dsActions__primary">${btnHtml}</div>
              ${linkHtml ? `<div class="dsActionLinks">${linkHtml}</div>` : ""}
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

  const fallbackNotice = showNoMatchFallback
    ? `
      <div class="dsEmpty">
        <div>No exact match for current search/filters. Showing all datasets.</div>
        <div style="margin-top:8px;">
          <button id="homeClearFiltersBtn" class="btn btn--ghost btn--sm" type="button">Clear filters</button>
        </div>
      </div>
    `
    : "";

  const html = [
    fallbackNotice,
    section("Available now", installed),
    section("Dataset catalog", catalogOnly),
  ]
    .filter(Boolean)
    .join("\n");

  if (!html) {
    const hasAnyDatasets = items.length > 0;
    if (!hasAnyDatasets) {
      if (isWebMode()) {
        wrap.innerHTML = `<div class="dsEmpty">No datasets loaded yet.<br>Click "Load dataset directory..." to open a local V2X-Traj folder.</div>`;
      } else {
        wrap.innerHTML = `<div class="dsEmpty">No datasets are available right now. Try reloading the app.</div>`;
      }
      return;
    }
    if (hasFilters) {
      wrap.innerHTML = `
        <div class="dsEmpty">
          <div>No exact match for current search/filters.</div>
          <div style="margin-top:8px;">
            <button id="homeClearFiltersBtn" class="btn btn--ghost btn--sm" type="button">Clear filters</button>
          </div>
        </div>
      `;
      const clearBtn = $("homeClearFiltersBtn");
      if (clearBtn) {
        clearBtn.addEventListener("click", () => {
          state.homeSearch = "";
          state.homeCategory = "";
          state.homeHasMap = "";
          state.homeHasTL = "";
          state.homeSort = "available";
          const search = $("homeSearch");
          if (search) search.value = "";
          const cat = $("homeCategory");
          if (cat) cat.value = "";
          const map = $("homeHasMap");
          if (map) map.value = "";
          const tl = $("homeHasTL");
          if (tl) tl.value = "";
          const sort = $("homeSort");
          if (sort) sort.value = "available";
          renderHomeDatasetCards();
        });
      }
      return;
    }
    wrap.innerHTML = `<div class="dsEmpty">No datasets are available in this view.</div>`;
    return;
  }
  wrap.innerHTML = html;
  if (showNoMatchFallback) {
    const clearBtn = $("homeClearFiltersBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        state.homeSearch = "";
        state.homeCategory = "";
        state.homeHasMap = "";
        state.homeHasTL = "";
        state.homeSort = "available";
        const search = $("homeSearch");
        if (search) search.value = "";
        const cat = $("homeCategory");
        if (cat) cat.value = "";
        const map = $("homeHasMap");
        if (map) map.value = "";
        const tl = $("homeHasTL");
        if (tl) tl.value = "";
        const sort = $("homeSort");
        if (sort) sort.value = "available";
        renderHomeDatasetCards();
      });
    }
  }
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
      const rawErr = data && data.error ? String(data.error) : "Update check failed.";
      const lowErr = rawErr.toLowerCase();
      const err = lowErr.includes("http error 404")
        ? "No published release found yet for this repository."
        : rawErr;
      setUpdateHint(err, userInitiated ? "bad" : "");
      syncUpdateUi();
      return;
    }

    if (data.comparison_mode === "no_releases") {
      if (userInitiated) setUpdateHint("No published release found yet (or only drafts exist).", "warn");
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
      const suffix = data.release_prerelease ? " · latest channel is prerelease." : "";
      setUpdateHint(`You are up to date (${current || "current version"})${suffix}`, "ok");
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
  state.sceneAvailability = null;
  state.sceneOffset = 0;
  state.intersectId = "";
  state.selectedKey = null;
  state.selected = null;
  state.view = null;
  state.mapPaths = null;
  resetPathCache();
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
  updateSplitAvailabilityHint(null);
  setPlaybackEnabled(false);
  syncSceneBackgroundUi(null);
  syncMapSourceUi(null);
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
  if (datasetType === "v2x_seq") {
    return `Select the ${name} dataset directory to start scene loading.`;
  }
  if (datasetType === "ind") {
    return `Select the ${name} dataset directory to start scene loading.`;
  }
  if (datasetType === "sind") {
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
  } catch (_) { }

  // Dataset meta first (splits + group label + map controls), then restore prefs.
  applyDatasetUi();
  restoreDatasetSettings(next);
  syncControlsFromState();
  syncMapSourceUi(null);
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
  if (state.includeTlOnlyScenes) qs.set("include_tl_only", "1");
  const data = await fetchJson(`/api/datasets/${encodeURIComponent(ds)}/scenes?${qs.toString()}`);
  if (reqId !== req.scenes) return;

  const sel = $("sceneSelect");
  sel.innerHTML = "";
  state.sceneIds = [];
  state.sceneTotal = Number(data.total || 0);
  state.sceneAvailability = (data.availability && typeof data.availability === "object") ? data.availability : null;
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
  updateSplitAvailabilityHint(state.sceneAvailability);

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
    syncSceneBackgroundUi(null);
    syncMapSourceUi(null);
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
    syncSceneBackgroundUi(bundle);
    syncMapSourceUi(bundle);
    updateSceneModalityControls(bundle);
    resetPathCache();
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
      syncSceneBackgroundUi(null);
      syncMapSourceUi(null);
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
      checkForUpdates({ force: true, userInitiated: true }).catch(() => { });
    });
  }

  const dlBtn = $("downloadUpdateBtn");
  if (dlBtn) {
    dlBtn.addEventListener("click", () => {
      const url = String(state.updateDownloadUrl || "").trim();
      if (!url) return;
      try {
        window.open(url, "_blank", "noopener");
      } catch (_) { }
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
      try {
        const meta = currentDatasetMeta() || {};
        const datasetType = datasetTypeFromMeta(meta);
        if (!datasetType) {
          const src = sourceState(datasetType);
          src.hint = "This dataset is not supported for local loading.";
          src.tone = "bad";
          persistSourceByType();
          setConnectResult("This dataset is not supported for local loading.", "bad");
          updateSourcePanel();
          return;
        }
        const prompt = datasetType === "v2x_traj"
          ? "Select the V2X-Traj dataset directory"
          : datasetType === "v2x_seq"
            ? "Select the V2X-Seq dataset directory"
            : datasetType === "ind"
              ? "Select the inD dataset directory"
              : datasetType === "sind"
                ? "Select the SinD dataset directory"
                : "Select the Consider.it dataset directory";
        const src = sourceState(datasetType);
        const paths = await pickPathsDesktop("pick_folder", prompt, src.folderPath || "");
        if (!paths.length) return;
        await loadDatasetFromFolder(paths[0]);
      } catch (e) {
        const msg = `Folder picker failed: ${e && e.message ? e.message : String(e)}`;
        const meta = currentDatasetMeta() || {};
        const datasetType = datasetTypeFromMeta(meta);
        const src = sourceState(datasetType);
        src.hint = msg;
        src.tone = "bad";
        persistSourceByType();
        setConnectResult(msg, "bad");
        updateSourcePanel();
      }
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

  const sceneTlOnly = $("sceneTlOnly");
  if (sceneTlOnly) {
    sceneTlOnly.addEventListener("change", async (e) => {
      state.includeTlOnlyScenes = !!e.target.checked;
      state.sceneOffset = 0;
      await loadScenes();
      await loadSceneBundle();
    });
  }

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
    goScene(-1).catch(() => { });
  });
  $("nextSceneBtn").addEventListener("click", () => {
    goScene(1).catch(() => { });
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
    jumpToScene($("sceneJumpInput").value).catch(() => { });
  });

  $("sceneJumpInput").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      jumpToScene($("sceneJumpInput").value).catch(() => { });
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

  const mapSourceSel = $("mapSourceSelect");
  if (mapSourceSel) {
    mapSourceSel.addEventListener("change", (e) => {
      applyMapSourceSelection(String(e.target.value || "lanelet2"));
    });
  }

  const commitBgAlign = (patch = {}) => {
    if (!isSindDataset() || !state.bundle) return;
    setSindBgAlign(patch, state.bundle);
    syncSindBgAlignUi(state.bundle);
    render();
  };

  const readBgAlignInputs = () => {
    const out = {
      enabled: !!($("bgAlignEnabled") && $("bgAlignEnabled").checked),
      flipY: !!($("bgAlignFlipY") && $("bgAlignFlipY").checked),
      tx: Number($("bgAlignTx") && $("bgAlignTx").value),
      ty: Number($("bgAlignTy") && $("bgAlignTy").value),
      sx: Number($("bgAlignSx") && $("bgAlignSx").value),
      sy: Number($("bgAlignSy") && $("bgAlignSy").value),
      rotationDeg: Number($("bgAlignRot") && $("bgAlignRot").value),
      alpha: Number($("bgAlignAlpha") && $("bgAlignAlpha").value),
    };
    if (!Number.isFinite(out.tx)) out.tx = 0;
    if (!Number.isFinite(out.ty)) out.ty = 0;
    if (!Number.isFinite(out.sx)) out.sx = 1;
    if (!Number.isFinite(out.sy)) out.sy = 1;
    if (!Number.isFinite(out.rotationDeg)) out.rotationDeg = 0;
    if (!Number.isFinite(out.alpha)) out.alpha = 0.92;
    out.sx = clamp(out.sx, 0.05, 10);
    out.sy = clamp(out.sy, 0.05, 10);
    out.rotationDeg = clamp(out.rotationDeg, -180, 180);
    out.alpha = clamp(out.alpha, 0.2, 1.0);
    return out;
  };

  const bindBgAlignNumber = (id, key, { min = null, max = null } = {}) => {
    const el = $(id);
    if (!el) return;
    const onChange = () => {
      let v = Number(el.value);
      if (!Number.isFinite(v)) return;
      if (min != null) v = Math.max(min, v);
      if (max != null) v = Math.min(max, v);
      commitBgAlign({ [key]: v });
    };
    el.addEventListener("input", onChange);
    el.addEventListener("change", onChange);
    el.addEventListener("blur", onChange);
  };

  const bindBgAlignCheck = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", (e) => {
      commitBgAlign({ [key]: !!e.target.checked });
    });
  };

  bindBgAlignCheck("bgAlignEnabled", "enabled");
  bindBgAlignCheck("bgAlignFlipY", "flipY");
  bindBgAlignNumber("bgAlignTx", "tx");
  bindBgAlignNumber("bgAlignTy", "ty");
  bindBgAlignNumber("bgAlignSx", "sx", { min: 0.05, max: 10 });
  bindBgAlignNumber("bgAlignSy", "sy", { min: 0.05, max: 10 });
  bindBgAlignNumber("bgAlignRot", "rotationDeg", { min: -180, max: 180 });
  const alphaEl = $("bgAlignAlpha");
  if (alphaEl) {
    alphaEl.addEventListener("input", () => {
      const v = Number(alphaEl.value);
      if (!Number.isFinite(v)) return;
      commitBgAlign({ alpha: clamp(v, 0.2, 1.0) });
    });
  }
  const resetAlignBtn = $("bgAlignResetBtn");
  if (resetAlignBtn) {
    resetAlignBtn.addEventListener("click", () => {
      if (!isSindDataset() || !state.bundle) return;
      setSindBgAlign(defaultSindBgAlign(), state.bundle);
      syncSindBgAlignUi(state.bundle);
      render();
    });
  }
  const saveAlignBtn = $("bgAlignSaveBtn");
  if (saveAlignBtn) {
    saveAlignBtn.addEventListener("click", () => {
      if (!isSindDataset() || !state.bundle) return;
      // Explicitly save whatever is currently in the inputs (even before blur/change fires).
      commitBgAlign(readBgAlignInputs());
      const prev = String(saveAlignBtn.textContent || "Save");
      saveAlignBtn.textContent = "Saved";
      setTimeout(() => {
        saveAlignBtn.textContent = prev;
      }, 1000);
    });
  }

  $("showVelocity").addEventListener("change", (e) => {
    state.showVelocity = !!e.target.checked;
    render();
  });

  $("showHeading").addEventListener("change", (e) => {
    state.showHeading = !!e.target.checked;
    render();
  });

  const bindCheck = (id, onChange) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", (e) => {
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
  const copyMetaBtn = $("copySceneMetaBtn");
  if (copyMetaBtn) {
    copyMetaBtn.addEventListener("click", async () => {
      const raw = $("sceneInfo");
      if (!raw) return;
      const text = String(raw.textContent || "");
      if (!text) return;
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (_) {
        ok = false;
      }
      const prev = String(copyMetaBtn.textContent || "Copy raw metadata");
      copyMetaBtn.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(() => {
        copyMetaBtn.textContent = prev;
      }, 1100);
    });
  }

  const setTrajectoryRangeUi = () => {
    setCheck("trajectoryRangeNone", state.trajectoryRange === "none");
    setCheck("trajectoryRangePast", state.trajectoryRange === "past");
    setCheck("trajectoryRangeFull", state.trajectoryRange === "full");
  };

  const bindTrajectoryRange = (id, value) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", (e) => {
      if (!e.target.checked) {
        // Keep this control single-select even though it is rendered as checkboxes.
        setTrajectoryRangeUi();
        return;
      }
      state.trajectoryRange = value;
      setTrajectoryRangeUi();
      render();
    });
  };
  bindTrajectoryRange("trajectoryRangeNone", "none");
  bindTrajectoryRange("trajectoryRangePast", "past");
  bindTrajectoryRange("trajectoryRangeFull", "full");
  bindCheck("holdTL", (v) => (state.holdTL = v));
  bindCheck("showMap", (v) => {
    state.showMap = v;
    if (supportsMapSourceSelector(currentDatasetMeta())) {
      state.mapSource = v ? "lanelet2" : (state.sceneBgEnabled ? "orthophoto" : "none");
      syncMapSourceUi(state.bundle);
    }
  });
  bindCheck("showSceneBg", (v) => {
    state.sceneBgEnabled = v;
    if (supportsMapSourceSelector(currentDatasetMeta())) {
      state.mapSource = v ? "orthophoto" : (state.showMap ? "lanelet2" : "none");
      syncMapSourceUi(state.bundle);
    }
  });
  bindCheck("showBasemap", (v) => {
    state.basemapEnabled = v;
    if (!v) state.basemapZoom = null;
    syncMapSourceUi(state.bundle);
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
    } catch (_) { }
    if (!moved) {
      const rect = canvas.getBoundingClientRect();
      const cx = ev.clientX - rect.left;
      const cy = ev.clientY - rect.top;
      const picked = pickNearestAgentAt(cx, cy);
      if (!picked) {
        state.selectedKey = null;
        state.selected = null;
        resetPathCache();
        updateSceneInfo();
        render();
        return;
      }
      state.selectedKey = { modality: picked.modality, id: picked.rec.id };
      state.selected = { modality: picked.modality, ...picked.rec };
      resetPathCache();
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
      goScene(1).catch(() => { });
      return;
    }
    if (ev.key && (ev.key === "p" || ev.key === "P") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      goScene(-1).catch(() => { });
      return;
    }
    if (ev.code === "PageDown") {
      ev.preventDefault();
      goScene(1).catch(() => { });
      return;
    }
    if (ev.code === "PageUp") {
      ev.preventDefault();
      goScene(-1).catch(() => { });
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
      wizardDetect().catch(() => { });
    });
  }
  const wizValidateBtn = $("wizValidateBtn");
  if (wizValidateBtn) {
    wizValidateBtn.addEventListener("click", () => {
      wizardValidate().catch(() => { });
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
      saveConnectionProfileFromWizard().catch(() => { });
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
  loadPersistedSindBgAlignStore();
  loadPersistedSourceByType();
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
    .catch(() => { });

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
