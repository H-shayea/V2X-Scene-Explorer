
/**
 * Browser-based File System Access API wrapper + mock "backend" validation logic.
 * Replaces Python backend calls when running on GitHub Pages / static host.
 */

const WebFS = {
  rootHandle: null,
  cachedHandles: new Map(), // path string -> handle
  textCache: new Map(), // path string -> text
  maxTextCacheItems: 64,

  isSupported() {
    return 'showDirectoryPicker' in window;
  },

  async pickDirectory() {
    try {
      const handle = await window.showDirectoryPicker({
        mode: 'read',
      });
      this.rootHandle = handle;
      this.cachedHandles.clear();
      this.textCache.clear();
      if (window.WebBackend && window.WebBackend._csvRowsCache && typeof window.WebBackend._csvRowsCache.clear === "function") {
        window.WebBackend._csvRowsCache.clear();
      }
      if (window.WebBackend && window.WebBackend._cpmIndexCache && typeof window.WebBackend._cpmIndexCache.clear === "function") {
        window.WebBackend._cpmIndexCache.clear();
      }
      this.cachedHandles.set('', handle);
      this.cachedHandles.set(handle.name, handle);
      return handle;
    } catch (e) {
      if (e.name === 'AbortError') return null;
      throw e;
    }
  },

  joinPath(...parts) {
    return parts.join('/').replace(/\/+/g, '/');
  },

  async getFileHandle(pathStr) {
    if (!this.rootHandle) return null;
    let parts = pathStr.replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..');
    if (parts.length > 0 && parts[0] === this.rootHandle.name) parts.shift();
    if (parts.length === 0) return null;

    let current = this.rootHandle;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      if (i === parts.length - 1) {
        try { return await current.getFileHandle(name); } catch { return null; }
      } else {
        try { current = await current.getDirectoryHandle(name); } catch { return null; }
      }
    }
    return null;
  },

  async readFileText(pathStr) {
    const key = String(pathStr || "");
    if (this.textCache.has(key)) {
      const hit = this.textCache.get(key);
      this.textCache.delete(key);
      this.textCache.set(key, hit);
      return hit;
    }
    const handle = await this.getFileHandle(pathStr);
    if (!handle) return null;
    const file = await handle.getFile();
    const text = await file.text();
    this.textCache.set(key, text);
    while (this.textCache.size > this.maxTextCacheItems) {
      const oldest = this.textCache.keys().next().value;
      this.textCache.delete(oldest);
    }
    return text;
  },

  async readFileJson(pathStr) {
    const text = await this.readFileText(pathStr);
    return text ? JSON.parse(text) : null;
  },

  async listDir(pathStr) {
    if (!this.rootHandle) return [];
    let parts = pathStr.replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..');
    if (parts.length > 0 && parts[0] === this.rootHandle.name) parts.shift();

    let current = this.rootHandle;
    if (parts.length > 0) {
      for (const name of parts) {
        try { current = await current.getDirectoryHandle(name); } catch { return []; }
      }
    }

    const files = [];
    for await (const entry of current.values()) {
      files.push(entry.name);
    }
    return files;
  }
};

// === Helper Functions ===

function countChar(s, ch) {
  if (!s || !ch) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) n += 1;
  }
  return n;
}

function detectCsvDelimiter(headerLine, preferred = ",") {
  const pref = (preferred === "," || preferred === ";" || preferred === "\t") ? preferred : ",";
  const candidates = [pref, ",", ";", "\t"].filter((d, i, arr) => arr.indexOf(d) === i);
  let best = pref;
  let bestCount = -1;
  for (const d of candidates) {
    const c = countChar(headerLine || "", d);
    if (c > bestCount) {
      bestCount = c;
      best = d;
    }
  }
  return best;
}

function splitCsvLine(line, delimiter = ",") {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsv(text, preferredDelimiter = ",") {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const first = lines.findIndex((l) => String(l || "").trim() !== "");
  if (first < 0) return [];
  const rawHeader = String(lines[first] || "").replace(/^\uFEFF/, "");
  const delimiter = detectCsvDelimiter(rawHeader, preferredDelimiter);
  const headers = splitCsvLine(rawHeader, delimiter).map((h) => String(h || "").trim());
  if (!headers.length) return [];

  const rows = [];
  for (let i = first + 1; i < lines.length; i++) {
    const line = String(lines[i] || "");
    if (!line.trim()) continue;
    const values = splitCsvLine(line, delimiter);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = String(values[j] == null ? "" : values[j]).trim();
    }
    rows.push(row);
  }
  return rows;
}

function parseTs100ms(ts) {
  if (!ts) return null;
  return Math.round(parseFloat(ts) * 10);
}

function safeFloat(v) {
  const f = parseFloat(v);
  return isFinite(f) ? f : null;
}

// === Map Helper ===

function processMapData(raw) {
  // Converts JSON map (Dict[ID, Obj]) to List[Obj] expected by app.js

  function parsePoly(points) {
    if (!Array.isArray(points)) return [];
    return points.map(p => {
      // Handle [x, y, z] or {x, y, z}
      if (Array.isArray(p)) return [p[0], p[1]];
      if (p && typeof p === 'object') return [p.x, p.y];
      return null;
    }).filter(Boolean);
  }

  function buildLanePolygon(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length < 2 || right.length < 2) return [];
    const poly = left.concat([...right].reverse());
    if (poly.length < 3) return [];
    const a = poly[0];
    const b = poly[poly.length - 1];
    if (!a || !b || a[0] !== b[0] || a[1] !== b[1]) poly.push([a[0], a[1]]);
    return poly;
  }

  const lanes = Object.values(raw.LANE || {}).map(l => {
    const leftBoundary = parsePoly(l.left_boundary);
    const rightBoundary = parsePoly(l.right_boundary);
    let polygon = parsePoly(l.polygon);
    if (polygon.length < 3) polygon = buildLanePolygon(leftBoundary, rightBoundary);
    return {
      id: l.id,
      lane_type: l.lane_type,
      turn_direction: l.turn_direction,
      is_intersection: l.is_intersection,
      has_traffic_control: l.has_traffic_control,
      centerline: parsePoly(l.centerline),
      left_boundary: leftBoundary,
      right_boundary: rightBoundary,
      polygon
    };
  });

  const stoplines = Object.values(raw.STOPLINE || {}).map(s => ({
    id: s.id,
    centerline: parsePoly(s.centerline)
  }));

  const crosswalks = Object.values(raw.CROSSWALK || {}).map(c => ({
    id: c.id,
    polygon: parsePoly(c.polygon)
  }));

  const junctions = Object.values(raw.JUNCTION || {}).map(j => ({
    id: j.id,
    polygon: parsePoly(j.polygon)
  }));

  return {
    map_id: "web_map",
    lanes,
    stoplines,
    crosswalks,
    junctions
  };
}

function trajDomain() {
  return (window.TrajDomain && typeof window.TrajDomain === "object") ? window.TrajDomain : null;
}

function warnMissingTrajDomainOnce() {
  if (window.__trajDomainWarnedBackend) return;
  window.__trajDomainWarnedBackend = true;
  console.warn("TrajDomain (domain.js) is unavailable in WebBackend; using built-in fallback mappings.");
}

function domainNormalizeDatasetType(raw) {
  const d = trajDomain();
  if (d && typeof d.normalizeDatasetType === "function") {
    return d.normalizeDatasetType(raw);
  }
  warnMissingTrajDomainOnce();
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'v2x-traj' || s === 'v2x_traj' || s === 'v2xtraj') return 'v2x_traj';
  if (s === 'v2x-seq' || s === 'v2x_seq' || s === 'v2xseq') return 'v2x_seq';
  if (s === 'ind' || s === 'in-d' || s === 'ind_dataset') return 'ind';
  if (s === 'sind' || s === 'sin-d' || s === 'sin_d' || s === 'sind_dataset') return 'sind';
  if (s === 'consider-it-cpm' || s === 'consider_it_cpm' || s === 'cpm' || s === 'cpm-objects' || s === 'considerit') return 'consider_it_cpm';
  return '';
}

function domainDatasetFamilyFromType(raw) {
  const d = trajDomain();
  if (d && typeof d.datasetFamilyFromType === "function") {
    return d.datasetFamilyFromType(raw);
  }
  warnMissingTrajDomainOnce();
  const t = domainNormalizeDatasetType(raw);
  if (t === 'v2x_traj') return 'v2x-traj';
  if (t === 'v2x_seq') return 'v2x-seq';
  if (t === 'ind') return 'ind';
  if (t === 'sind') return 'sind';
  if (t === 'consider_it_cpm') return 'cpm-objects';
  return '';
}

function domainDatasetTypeFromFamily(rawFamily) {
  const d = trajDomain();
  if (d && typeof d.datasetTypeFromFamily === "function") {
    return d.datasetTypeFromFamily(rawFamily);
  }
  warnMissingTrajDomainOnce();
  const fam = String(rawFamily || "").trim().toLowerCase();
  if (fam === "v2x-traj") return "v2x_traj";
  if (fam === "v2x-seq") return "v2x_seq";
  if (fam === "ind") return "ind";
  if (fam === "sind") return "sind";
  if (fam === "cpm-objects") return "consider_it_cpm";
  return "";
}

function domainCapabilitiesFromType(raw) {
  const d = trajDomain();
  if (d && typeof d.capabilitiesFromDatasetType === "function") {
    return d.capabilitiesFromDatasetType(raw);
  }
  warnMissingTrajDomainOnce();
  const t = domainNormalizeDatasetType(raw);
  if (t === "v2x_traj" || t === "v2x_seq") {
    return { has_map: true, has_traffic_lights: true, splits: ["train", "val"], group_label: "Intersection" };
  }
  if (t === "ind") return { has_map: true, has_traffic_lights: false, splits: ["all"], group_label: "Location" };
  if (t === "sind") return { has_map: true, has_traffic_lights: true, splits: ["all"], group_label: "City" };
  if (t === "consider_it_cpm") return { has_map: false, has_traffic_lights: false, splits: ["all"], group_label: "Sensor" };
  return {};
}

function domainDefaultSceneStrategy(raw) {
  const d = trajDomain();
  if (d && typeof d.defaultSceneStrategy === "function") {
    return d.defaultSceneStrategy(raw);
  }
  warnMissingTrajDomainOnce();
  const t = domainNormalizeDatasetType(raw);
  if (t === "v2x_traj") return { mode: "intersection_scene" };
  if (t === "v2x_seq") return { mode: "sequence_scene" };
  if (t === "ind") return { mode: "recording_window", window_s: 60 };
  if (t === "sind") return { mode: "scenario_scene" };
  if (t === "consider_it_cpm") return { mode: "time_window", window_s: 300, gap_s: 120 };
  return { mode: "intersection_scene" };
}

const CPM_ALIASES = Object.freeze({
  generationTime_ms: Object.freeze(["generationTime_ms", "generation_time_ms", "generationtime", "timestamp_ms", "gen_time_ms"]),
  trackID: Object.freeze(["track_id", "trackID", "trackId", "track"]),
  objectID: Object.freeze(["objectID", "object_id", "track_id", "id"]),
  rsu: Object.freeze(["rsu", "rsu_id", "sensor_id", "sensor"]),
  xDistance_m: Object.freeze(["xDistance_m", "x_distance_m", "x_distance", "xdist_m", "north_m"]),
  yDistance_m: Object.freeze(["yDistance_m", "y_distance_m", "y_distance", "ydist_m", "east_m"]),
  xSpeed_mps: Object.freeze(["xSpeed_mps", "x_speed_mps", "vx_mps", "speed_x_mps", "north_speed_mps"]),
  ySpeed_mps: Object.freeze(["ySpeed_mps", "y_speed_mps", "vy_mps", "speed_y_mps", "east_speed_mps"]),
  yawAngle_deg: Object.freeze(["yawAngle_deg", "yaw_angle_deg", "heading_deg", "yaw_deg"]),
  classificationType: Object.freeze(["classificationType", "classification_type", "class_id", "object_class"]),
  objLength_m: Object.freeze(["objLength_m", "obj_length_m", "length_m"]),
  objWidth_m: Object.freeze(["objWidth_m", "obj_width_m", "width_m"]),
  objHeight_m: Object.freeze(["objHeight_m", "obj_height_m", "height_m"]),
});

function cpmNormCol(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function cpmAsInt(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function cpmBucketTs(tsMs, frameBinMs) {
  const b = Math.max(1, Number(frameBinMs) || 100);
  return Math.floor(Number(tsMs) / b) * b;
}

function cpmAsHms(tsMs) {
  const d = new Date(Number(tsMs));
  if (!Number.isFinite(d.getTime())) return "window";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function cpmTimeRangeLabel(firstMs, lastMs) {
  const a = cpmAsHms(firstMs);
  const b = cpmAsHms(lastMs);
  if (a === "window" || b === "window") return "window";
  return `${a}-${b}`;
}

function cpmSensorIdFromRel(relPath) {
  let s = String(relPath || "").replace(/\\/g, "/");
  if (s.toLowerCase().endsWith(".csv")) s = s.slice(0, -4);
  return s.replace(/\//g, "__");
}

function cpmFmtDateFromYmd(s) {
  const raw = String(s || "").trim();
  if (!/^\d{8}$/.test(raw)) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function cpmSensorLabelFromRel(relPath) {
  const rel = String(relPath || "").replace(/\\/g, "/");
  const parts = rel.split("/").filter(Boolean);
  if (parts.length && parts[0] === "lidar") {
    const rsu = parts.length >= 2 ? parts[1] : "RSU";
    return `LiDAR ${rsu}`;
  }
  if (parts.length && parts[0] === "thermal_camera") {
    const stem = parts[parts.length - 1].replace(/\.csv$/i, "");
    const m = stem.match(/^(\d{8})-(.+)$/);
    if (m) return `Thermal camera (${cpmFmtDateFromYmd(m[1])})`;
    return `Thermal camera ${parts[parts.length - 1] || ""}`.trim();
  }
  const name = parts[parts.length - 1] || rel;
  return name.replace(/\.csv$/i, "");
}

function cpmClassToTypeSubtype(classificationType) {
  if (classificationType == null) return { type: "UNKNOWN", sub_type: null };
  const c = Number(classificationType);
  if (!Number.isFinite(c)) return { type: "UNKNOWN", sub_type: null };
  if (c === 0) return { type: "VEHICLE", sub_type: "VEHICLE" };
  if (c === 1) return { type: "VRU", sub_type: "VRU" };
  if (c >= 2 && c <= 11) return { type: "VEHICLE", sub_type: "VEHICLE" };
  if (c >= 12 && c <= 21) return { type: "VRU", sub_type: "VRU" };
  return { type: "UNKNOWN", sub_type: null };
}

function cpmSensorLabelRank(label) {
  const lab = String(label || "").toLowerCase();
  if (lab.startsWith("lidar")) return 0;
  if (lab.startsWith("thermal")) return 1;
  return 2;
}


// === Web Backend Emulation ===

const WebBackend = {
  LS_DATASETS: "traj.web.datasets",
  LS_PROFILES: "traj.web.profiles",
  LS_DEFAULT_PROFILE: "traj.web.default_profile",
  CSV_ROWS_CACHE_MAX: 96,
  _csvRowsCache: new Map(), // path -> parsed rows
  CPM_INDEX_CACHE_MAX: 8,
  _cpmIndexCache: new Map(), // key -> index payload

  STATIC_CATALOG: [
    {
      "id": "v2x-traj",
      "title": "V2X-Traj",
      "year": 2024,
      "venue": "NeurIPS (paper ecosystem)",
      "category": "intersection-centric",
      "visibility": "public",
      "summary": "Real-world cooperative motion forecasting dataset with multiple autonomous vehicles and infrastructure present in each scenario (vehicle-to-everything / V2X). Designed to evaluate cooperative forecasting beyond pure vehicle-to-infrastructure settings.",
      "highlights": [
        "Cooperative forecasting focus (multi-agent, multi-device)",
        "Multiple cooperation settings (e.g., V2I / V2V / V2X) depending on the benchmark",
        "Works with HD maps and traffic signals when provided by the dataset release"
      ],
      "capabilities": {
        "has_map": true,
        "has_traffic_lights": true,
        "coordinate_frame": "global (map)",
        "scene_unit": "intersection -> scene"
      },
      "links": [
        {
          "label": "Paper (arXiv:2311.00371)",
          "url": "https://arxiv.org/abs/2311.00371"
        },
        {
          "label": "Project code (V2X-Graph)",
          "url": "https://github.com/AIR-THU/V2X-Graph"
        }
      ],
      "app": { "supported": true, "family": "v2x-traj" }
    },
    {
      "id": "consider-it-cpm",
      "title": "Consider.it (CPM Objects)",
      "year": 2025,
      "venue": "Internal / private",
      "category": "intersection-centric",
      "visibility": "private",
      "summary": "Private cooperative perception dataset of CPM object logs. Logs contain timestamped object detections from roadside units (RSUs) and thermal camera recordings. The viewer segments continuous logs into longer, gap-aware time windows for interactive playback.",
      "highlights": [
        "Private dataset (not distributed via this repository)",
        "Object detections with fine-grained class ids (decoded from sensor_interface-v1.2.1.proto)",
        "Local sensor coordinate frame (no HD map)"
      ],
      "capabilities": {
        "has_map": false,
        "has_traffic_lights": false,
        "coordinate_frame": "local (sensor)",
        "scene_unit": "sensor log -> time window scene"
      },
      "links": [],
      "app": { "supported": true, "family": "cpm-objects" }
    },
    {
      "id": "ind",
      "title": "inD",
      "year": 2019,
      "venue": "arXiv:1911.07602",
      "category": "intersection-centric",
      "visibility": "public",
      "summary": "Naturalistic road user trajectories recorded by drones at multiple German intersections. Provides extracted trajectories per road user with high positional accuracy.",
      "highlights": ["Top-down drone viewpoint", "Multiple intersection locations", "Trajectory extraction for road users"],
      "capabilities": {
        "has_map": false,
        "has_traffic_lights": false,
        "coordinate_frame": "global (geo-referenced)",
        "scene_unit": "recording / location"
      },
      "links": [
        { "label": "Paper", "url": "https://arxiv.org/abs/1911.07602" },
        { "label": "Website", "url": "https://www.ind-dataset.com/" }
      ],
      "app": { "supported": true, "family": "ind" }
    },
    {
      "id": "sind",
      "title": "SinD",
      "year": 2022,
      "venue": "ITSC 2022; arXiv:2209.02297",
      "category": "intersection-centric",
      "visibility": "public",
      "summary": "Drone-recorded dataset at signalized intersections. Includes traffic participant trajectories plus synchronized traffic light states and high-definition maps.",
      "highlights": ["Signalized intersection focus", "Traffic light states", "HD map support (Lanelet2)"],
      "capabilities": {
        "has_map": true,
        "has_traffic_lights": true,
        "coordinate_frame": "global (map)",
        "scene_unit": "city -> scenario"
      },
      "links": [
        { "label": "Paper", "url": "https://arxiv.org/abs/2209.02297" },
        { "label": "GitHub", "url": "https://github.com/SOTIF-AVLab/SinD" }
      ],
      "app": { "supported": true, "family": "sind" }
    },
    {
      "id": "int2",
      "title": "INT2",
      "year": 2023,
      "venue": "ICCV 2023",
      "category": "intersection-centric",
      "visibility": "public",
      "summary": "Large-scale interactive trajectory prediction dataset for intersections. Includes vectorized semantic maps and traffic light information.",
      "highlights": ["Interactive prediction focus", "Vector maps + traffic lights", "Large-scale benchmark"],
      "capabilities": {
        "has_map": true,
        "has_traffic_lights": true
      },
      "links": [
        { "label": "Paper", "url": "https://openaccess.thecvf.com/content/ICCV2023/html/Yan_INT2_Interactive_Trajectory_Prediction_at_Intersections_ICCV_2023_paper.html" },
        { "label": "GitHub", "url": "https://github.com/AIR-DISCOVER/INT2" }
      ],
      "app": { "supported": false, "family": null }
    },
    {
      "id": "vtp-tl",
      "title": "VTP-TL",
      "year": 2022,
      "venue": "ECCV 2022",
      "category": "intersection-centric",
      "visibility": "public",
      "summary": "Vehicle trajectory prediction under traffic lights at urban intersections.",
      "highlights": ["Traffic-light-aware forecasting", "Released with D2-TPred"],
      "capabilities": { "has_map": null, "has_traffic_lights": true },
      "links": [
        { "label": "Paper", "url": "https://arxiv.org/abs/2207.10398" },
        { "label": "GitHub", "url": "https://github.com/VTP-TL/D2-TPred" }
      ],
      "app": { "supported": false, "family": null }
    },
    {
      "id": "v2x-seq",
      "title": "V2X-Seq",
      "year": 2023,
      "venue": "CVPR 2023",
      "category": "intersection-centric",
      "visibility": "public",
      "summary": "Large-scale sequential V2X dataset including trajectories, vector maps, and traffic lights.",
      "highlights": ["Sequential V2X data", "Vector maps + traffic lights", "Perception + forecasting"],
      "capabilities": {
        "has_map": true,
        "has_traffic_lights": true,
        "coordinate_frame": "global (map)",
        "scene_unit": "scenario"
      },
      "links": [
        { "label": "Paper", "url": "https://openaccess.thecvf.com/content/CVPR2023/html/Yu_V2X-Seq_A_Large-Scale_Sequential_Dataset_for_Vehicle-Infrastructure_Cooperative_Perception_and_CVPR_2023_paper.html" },
        { "label": "GitHub", "url": "https://github.com/AIR-THU/DAIR-V2X-Seq" }
      ],
      "app": { "supported": true, "family": "v2x-seq" }
    },
    {
      "id": "interaction",
      "title": "INTERACTION",
      "year": 2019,
      "venue": "arXiv:1910.03088",
      "category": "multi-scenario",
      "visibility": "public",
      "summary": "International dataset of highly interactive driving scenarios paired with semantic maps.",
      "highlights": ["Multiple scenario types", "Semantic maps", "Interactive behaviors"],
      "capabilities": { "has_map": true, "has_traffic_lights": true },
      "links": [
        { "label": "Paper", "url": "https://arxiv.org/abs/1910.03088" },
        { "label": "Website", "url": "https://interaction-dataset.com/" }
      ],
      "app": { "supported": false, "family": null }
    },
    {
      "id": "round",
      "title": "rounD",
      "year": 2020,
      "venue": "ITSC 2020",
      "category": "intersection-adjacent",
      "visibility": "public",
      "summary": "Naturalistic road user trajectories recorded by drones at multiple German roundabouts.",
      "highlights": ["Top-down drone viewpoint", "Roundabout scenarios", "OpenDRIVE support"],
      "capabilities": { "has_map": true, "has_traffic_lights": false },
      "links": [{ "label": "Website", "url": "https://levelxdata.com/round-dataset/" }],
      "app": { "supported": false, "family": null }
    }
  ],

  nowIso() {
    return new Date().toISOString();
  },

  getDatasets() {
    const byId = new Map();
    for (const item of this.STATIC_CATALOG) {
      if (!item || !item.id) continue;
      byId.set(String(item.id), { ...item });
    }
    try {
      const stored = JSON.parse(localStorage.getItem(this.LS_DATASETS));
      if (Array.isArray(stored)) {
        for (const raw of stored) {
          if (!raw || !raw.id) continue;
          const id = String(raw.id);
          const prev = byId.get(id) || {};
          byId.set(id, { ...prev, ...raw });
        }
      }
    } catch (e) { }
    return Array.from(byId.values());
  },

  saveDatasets(list) {
    const byId = new Map();
    for (const raw of (Array.isArray(list) ? list : [])) {
      if (!raw || !raw.id) continue;
      const id = String(raw.id);
      const prev = byId.get(id) || {};
      byId.set(id, { ...prev, ...raw });
    }
    localStorage.setItem(this.LS_DATASETS, JSON.stringify(Array.from(byId.values())));
  },

  getProfiles() {
    try {
      const stored = JSON.parse(localStorage.getItem(this.LS_PROFILES) || '[]');
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  },

  saveProfiles(list) {
    localStorage.setItem(this.LS_PROFILES, JSON.stringify(Array.isArray(list) ? list : []));
  },

  getDefaultProfileId() {
    return String(localStorage.getItem(this.LS_DEFAULT_PROFILE) || "").trim();
  },

  setDefaultProfileId(profileId) {
    const pid = String(profileId || "").trim();
    if (pid) localStorage.setItem(this.LS_DEFAULT_PROFILE, pid);
    else localStorage.removeItem(this.LS_DEFAULT_PROFILE);
  },

  normalizeDatasetType(raw) {
    return domainNormalizeDatasetType(raw);
  },

  datasetFamilyFromType(raw) {
    return domainDatasetFamilyFromType(raw);
  },

  capabilitiesFromType(raw) {
    return domainCapabilitiesFromType(raw);
  },

  defaultSceneStrategy(raw) {
    return domainDefaultSceneStrategy(raw);
  },

  profileSummary(profile, defaultProfileId = this.getDefaultProfileId()) {
    const p = (profile && typeof profile === "object") ? profile : {};
    const profileId = String(p.profile_id || "");
    const validation = (p.validation && typeof p.validation === "object") ? p.validation : {};
    return {
      profile_id: profileId,
      name: String(p.name || profileId || "Profile"),
      dataset_id: String(p.dataset_id || ""),
      dataset_type: String(p.dataset_type || ""),
      status: String(validation.status || ""),
      last_checked: String(validation.last_checked || ""),
      is_default: !!(defaultProfileId && profileId === defaultProfileId),
    };
  },

  listProfileSummaries() {
    const defaultProfileId = this.getDefaultProfileId();
    const out = this.getProfiles().map((p) => this.profileSummary(p, defaultProfileId));
    out.sort((a, b) => {
      if (!!a.is_default !== !!b.is_default) return a.is_default ? -1 : 1;
      const an = String(a.name || "").toLowerCase();
      const bn = String(b.name || "").toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return String(a.profile_id || "").localeCompare(String(b.profile_id || ""));
    });
    return out;
  },

  normalizeProfile(profileIn, fallbackType = "") {
    const src = (profileIn && typeof profileIn === "object") ? profileIn : {};
    const now = this.nowIso();
    const datasetType = this.normalizeDatasetType(src.dataset_type || fallbackType) || "v2x_traj";
    const profileId = String(src.profile_id || `web-${Date.now()}`).trim();
    const datasetId = String(src.dataset_id || `profile-${datasetType.replace(/_/g, "-")}-${profileId.slice(0, 8)}`).trim();
    const rootsIn = Array.isArray(src.roots) ? src.roots : [];
    const roots = rootsIn.map((x) => String(x || "").trim()).filter(Boolean);
    if (!roots.length && WebFS.rootHandle && WebFS.rootHandle.name) roots.push(String(WebFS.rootHandle.name));

    const detectorIn = (src.detector && typeof src.detector === "object") ? src.detector : {};
    const detector = {
      score: Number.isFinite(Number(detectorIn.score)) ? Number(detectorIn.score) : 0,
      second_best: Number.isFinite(Number(detectorIn.second_best)) ? Number(detectorIn.second_best) : 0,
      decision_mode: String(detectorIn.decision_mode || "auto"),
      checked_at: String(detectorIn.checked_at || now),
    };

    const validation = {
      status: "ready",
      errors: [],
      warnings: [],
      last_checked: now,
    };
    const capabilities = this.capabilitiesFromType(datasetType);
    const bindings = (src.bindings && typeof src.bindings === "object") ? { ...src.bindings } : {};
    const sceneStrategy = (src.scene_strategy && typeof src.scene_strategy === "object")
      ? { ...src.scene_strategy }
      : this.defaultSceneStrategy(datasetType);
    const cacheIn = (src.cache && typeof src.cache === "object") ? src.cache : {};

    const profile = {
      ...src,
      schema_version: String(src.schema_version || "profile-v1"),
      profile_id: profileId,
      dataset_id: datasetId,
      name: String(src.name || "Dataset Profile"),
      dataset_type: datasetType,
      adapter_version: String(src.adapter_version || "web-shim"),
      roots,
      bindings,
      scene_strategy: sceneStrategy,
      detector,
      validation,
      cache: {
        index_dir: String(cacheIn.index_dir || ""),
        fingerprint: String(cacheIn.fingerprint || ""),
        index_version: String(cacheIn.index_version || "web-shim"),
        last_indexed_at: String(cacheIn.last_indexed_at || ""),
        scene_count: Number(cacheIn.scene_count || 0),
        row_count: Number(cacheIn.row_count || 0),
      },
      capabilities,
      ui_defaults: (src.ui_defaults && typeof src.ui_defaults === "object") ? { ...src.ui_defaults } : {},
    };
    return { profile, validation, capabilities };
  },

  inferDatasetTypeFromRootEntries(entries) {
    const names = Array.isArray(entries) ? entries.map((x) => String(x || "").trim().toLowerCase()) : [];
    if (names.includes("lidar") || names.includes("thermal_camera") || names.some((x) => x.includes("cpm"))) {
      return "consider_it_cpm";
    }
    if (names.includes("cooperative-vehicle-infrastructure") || names.includes("single-infrastructure") || names.includes("single-vehicle")) {
      return "v2x_seq";
    }
    if (names.includes("ego-trajectories") || names.includes("infrastructure-trajectories") || names.includes("vehicle-trajectories")) {
      return "v2x_traj";
    }
    if (names.some((x) => x.includes("recordingmeta") || x.endsWith("_tracks.csv"))) {
      return "ind";
    }
    if (names.some((x) => x.includes("veh_smoothed_tracks") || x.includes("ped_smoothed_tracks"))) {
      return "sind";
    }
    return "v2x_traj";
  },

  _cacheCsvRows(pathKey, rows) {
    this._csvRowsCache.set(pathKey, rows);
    while (this._csvRowsCache.size > this.CSV_ROWS_CACHE_MAX) {
      const oldest = this._csvRowsCache.keys().next().value;
      this._csvRowsCache.delete(oldest);
    }
  },

  async readCsvRowsFromPaths(paths) {
    for (const p of (paths || [])) {
      const pathKey = String(p || "").trim();
      if (!pathKey) continue;
      if (this._csvRowsCache.has(pathKey)) {
        const cached = this._csvRowsCache.get(pathKey);
        this._csvRowsCache.delete(pathKey);
        this._csvRowsCache.set(pathKey, cached);
        return { rows: cached, path: pathKey };
      }
      const text = await WebFS.readFileText(pathKey);
      if (!text) continue;
      const rows = parseCsv(text);
      this._cacheCsvRows(pathKey, rows);
      return { rows, path: pathKey };
    }
    return { rows: [], path: null };
  },

  _clampInt(raw, fallback, minV, maxV) {
    const n = Number.parseInt(String(raw == null ? "" : raw), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(minV, Math.min(maxV, n));
  },

  _cacheCpmIndex(cacheKey, value) {
    this._cpmIndexCache.set(cacheKey, value);
    while (this._cpmIndexCache.size > this.CPM_INDEX_CACHE_MAX) {
      const oldest = this._cpmIndexCache.keys().next().value;
      this._cpmIndexCache.delete(oldest);
    }
  },

  _extractDatasetIdFromUrl(url) {
    const parts = String(url || "").split("/");
    const i = parts.indexOf("datasets");
    if (i < 0 || i + 1 >= parts.length) return "";
    return decodeURIComponent(String(parts[i + 1] || "").trim());
  },

  _resolveDatasetContext(datasetId) {
    const did = String(datasetId || "").trim();
    const datasets = this.getDatasets();
    const dataset = datasets.find((d) => String((d && d.id) || "") === did) || null;
    const profiles = this.getProfiles();
    const defaultPid = this.getDefaultProfileId();
    const profile =
      profiles.find((p) => String((p && p.profile_id) || "") === defaultPid && String((p && p.dataset_id) || "") === did)
      || profiles.find((p) => String((p && p.dataset_id) || "") === did)
      || null;

    const fromProfile = this.normalizeDatasetType(profile && profile.dataset_type);
    const family = String(((dataset && (dataset.family || (dataset.app && dataset.app.family))) || "")).trim().toLowerCase();
    const fromFamily = domainDatasetTypeFromFamily(family);
    const fromId = this.normalizeDatasetType(did);
    const datasetType = fromProfile || fromFamily || fromId || "v2x_traj";
    return { datasetId: did, dataset, profile, datasetType };
  },

  _resolveCpmOptions(ctx) {
    const profile = (ctx && ctx.profile && typeof ctx.profile === "object") ? ctx.profile : {};
    const strategy = (profile.scene_strategy && typeof profile.scene_strategy === "object") ? profile.scene_strategy : {};
    const bindings = (profile.bindings && typeof profile.bindings === "object") ? profile.bindings : {};
    const cpmLogs = (bindings.cpm_logs && typeof bindings.cpm_logs === "object") ? bindings.cpm_logs : {};

    const windowS = this._clampInt(strategy.window_s, 300, 10, 7200);
    const gapS = this._clampInt(strategy.gap_s, 120, 0, 3600);
    const frameBinMs = this._clampInt(strategy.frame_bin_ms, 100, 1, 5000);
    const delimiterRaw = String(cpmLogs.delimiter || ",");
    const delimiter = (delimiterRaw === "," || delimiterRaw === ";" || delimiterRaw === "\t") ? delimiterRaw : ",";
    const columnMapIn = (cpmLogs.column_map && typeof cpmLogs.column_map === "object") ? cpmLogs.column_map : {};
    const column_map = {};
    for (const [k, v] of Object.entries(columnMapIn)) {
      const kk = String(k || "").trim();
      const vv = String(v || "").trim();
      if (kk && vv) column_map[kk] = vv;
    }

    return {
      window_s: windowS,
      window_ms: windowS * 1000,
      gap_s: gapS,
      gap_ms: gapS * 1000,
      frame_bin_ms: frameBinMs,
      delimiter,
      column_map,
    };
  },

  _resolveCpmFieldMap(headers, explicitMap) {
    const fields = Array.isArray(headers) ? headers.map((x) => String(x || "").trim()) : [];
    const byNorm = {};
    for (const f of fields) {
      const n = cpmNormCol(f);
      if (n && byNorm[n] == null) byNorm[n] = f;
    }
    const out = {};
    for (const canonical of Object.keys(CPM_ALIASES)) {
      const got = byNorm[cpmNormCol(canonical)];
      if (got) out[canonical] = got;
    }
    if (explicitMap && typeof explicitMap === "object") {
      for (const [canonical, actual] of Object.entries(explicitMap)) {
        if (out[canonical]) continue;
        const wanted = String(actual || "").trim();
        if (wanted && fields.includes(wanted)) out[canonical] = wanted;
      }
    }
    for (const [canonical, aliases] of Object.entries(CPM_ALIASES)) {
      if (out[canonical]) continue;
      for (const alias of aliases || []) {
        const got = byNorm[cpmNormCol(alias)];
        if (got) {
          out[canonical] = got;
          break;
        }
      }
    }
    return out;
  },

  async _collectCpmCsvRelativePaths() {
    if (!WebFS.rootHandle) return [];
    const root = WebFS.rootHandle;
    const topDirNames = [];
    for await (const entry of root.values()) {
      if (entry && entry.kind === "directory") topDirNames.push(String(entry.name || ""));
    }
    const wantedTop = new Set(topDirNames.filter((n) => {
      const low = String(n || "").toLowerCase();
      return low === "lidar" || low === "thermal_camera";
    }).map((x) => String(x).toLowerCase()));
    const preferTopOnly = wantedTop.size > 0;
    const topLikelyRoots = new Set(topDirNames.filter((n) => {
      const low = String(n || "").toLowerCase();
      return low.includes("consider") || low.includes("cpm");
    }).map((x) => String(x).toLowerCase()));

    const out = [];
    const isLikelyCpmPath = (rel) => {
      const parts = String(rel || "").toLowerCase().split("/").filter(Boolean);
      if (!parts.length) return false;
      if (parts.includes("lidar") || parts.includes("thermal_camera")) return true;
      for (const p of parts) {
        if (p.includes("consider") || p.includes("cpm")) return true;
      }
      return false;
    };

    const shouldIncludeCsv = (rel) => {
      if (preferTopOnly) return true;
      const low = String(rel || "").toLowerCase();
      if (isLikelyCpmPath(low)) return true;
      const base = low.split("/").pop() || "";
      return base.includes("cpm");
    };

    const walk = async (dirHandle, relPrefix, depth, underLikelyRoot = false) => {
      for await (const entry of dirHandle.values()) {
        if (!entry || !entry.name) continue;
        const name = String(entry.name);
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        const lowRel = String(rel || "").toLowerCase();
        if (entry.kind === "directory") {
          if (depth === 0 && preferTopOnly && !wantedTop.has(name.toLowerCase())) {
            continue;
          }
          const nextLikely = underLikelyRoot || isLikelyCpmPath(lowRel) || (depth === 0 && topLikelyRoots.has(String(name || "").toLowerCase()));
          await walk(entry, rel, depth + 1, nextLikely);
          continue;
        }
        if (entry.kind === "file" && name.toLowerCase().endsWith(".csv")) {
          if (underLikelyRoot || shouldIncludeCsv(rel)) out.push(rel);
        }
      }
    };
    await walk(root, "", 0, false);
    out.sort((a, b) => a.localeCompare(b));
    return out;
  },

  _buildCpmIndexForFile(relPath, pathKey, text, opts) {
    const source = String(text || "");
    if (!source) return [];

    const sensors = new Map();
    const len = source.length;
    let pos = 0;
    let headerDone = false;
    let delimiter = ",";
    let headers = [];
    let idxByCanonical = {};
    let rsuIdx = -1;
    let tsIdx = -1;
    let lineNo = 0;

    const baseSensorId = cpmSensorIdFromRel(relPath);
    const baseSensorLabel = cpmSensorLabelFromRel(relPath);
    const sanitizeSensor = (raw) => String(raw || "").replace(/[^a-zA-Z0-9_-]+/g, "_");

    while (pos <= len) {
      const lineStart = pos;
      const nl = source.indexOf("\n", pos);
      const rawLine = nl >= 0 ? source.slice(pos, nl) : source.slice(pos);
      const lineEnd = nl >= 0 ? (nl + 1) : len;
      pos = nl >= 0 ? (nl + 1) : (len + 1);

      let line = rawLine;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) {
        lineNo += 1;
        continue;
      }

      if (!headerDone) {
        const headerLine = String(line || "").replace(/^\uFEFF/, "");
        delimiter = detectCsvDelimiter(headerLine, opts && opts.delimiter ? opts.delimiter : ",");
        headers = splitCsvLine(headerLine, delimiter).map((x) => String(x || "").trim());
        const fieldMap = this._resolveCpmFieldMap(headers, opts ? opts.column_map : null);
        const byHeader = {};
        headers.forEach((h, i) => {
          if (!(h in byHeader)) byHeader[h] = i;
        });
        idxByCanonical = {};
        for (const canonical of Object.keys(CPM_ALIASES)) {
          const actual = fieldMap[canonical];
          idxByCanonical[canonical] = (actual != null && byHeader[actual] != null) ? Number(byHeader[actual]) : -1;
        }
        tsIdx = Number(idxByCanonical.generationTime_ms);
        rsuIdx = Number(idxByCanonical.rsu);
        const hasRequired = tsIdx >= 0 && idxByCanonical.xDistance_m >= 0 && idxByCanonical.yDistance_m >= 0;
        if (!hasRequired) {
          return [];
        }
        headerDone = true;
        lineNo += 1;
        continue;
      }

      const values = splitCsvLine(line, delimiter);
      if (tsIdx >= values.length) {
        lineNo += 1;
        continue;
      }
      const tsRaw = cpmAsInt(values[tsIdx]);
      if (tsRaw == null) {
        lineNo += 1;
        continue;
      }
      const tsBucket = cpmBucketTs(tsRaw, opts.frame_bin_ms);

      let rsuVal = null;
      if (rsuIdx >= 0 && rsuIdx < values.length) {
        const rv = String(values[rsuIdx] == null ? "" : values[rsuIdx]).trim();
        if (rv) rsuVal = rv;
      }

      const sensorId = rsuVal ? `${baseSensorId}__${sanitizeSensor(rsuVal)}` : baseSensorId;
      const sensorLabel = rsuVal ? `LiDAR ${rsuVal}` : baseSensorLabel;
      let sensor = sensors.get(sensorId);
      if (!sensor) {
        sensor = {
          sensor_id: sensorId,
          sensor_label: sensorLabel,
          path: pathKey,
          rel_path: relPath,
          row_filter_value: rsuVal,
          row_filter_index: rsuIdx >= 0 ? rsuIdx : null,
          delimiter,
          field_indices: { ...idxByCanonical },
          frame_rows: new Map(),
        };
        sensors.set(sensorId, sensor);
      }
      let frame = sensor.frame_rows.get(tsBucket);
      if (!frame) {
        frame = { rows: 0, start: lineStart, end: lineEnd };
        sensor.frame_rows.set(tsBucket, frame);
      }
      frame.rows += 1;
      frame.end = lineEnd;
      lineNo += 1;
    }

    if (!headerDone || tsIdx < 0 || idxByCanonical.xDistance_m < 0 || idxByCanonical.yDistance_m < 0) {
      return [];
    }

    const out = [];
    for (const sensor of sensors.values()) {
      const tsList = Array.from(sensor.frame_rows.keys()).map((x) => Number(x)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
      if (!tsList.length) continue;

      const windows = [];
      let bucket = 0;
      let curFirst = tsList[0];
      let curLast = tsList[0];
      let curRows = Number(sensor.frame_rows.get(curFirst).rows || 0);
      let curFrames = 1;
      let curOffsetStart = Number(sensor.frame_rows.get(curFirst).start || 0);
      let curOffsetEnd = Number(sensor.frame_rows.get(curFirst).end || 0);
      let prev = tsList[0];

      const pushWindow = () => {
        windows.push({
          bucket,
          start_ms: curFirst,
          end_ms: curLast,
          first_ts_ms: curFirst,
          last_ts_ms: curLast,
          offset_start: curOffsetStart,
          offset_end: curOffsetEnd,
          rows: curRows,
          frames: curFrames,
        });
      };

      for (let i = 1; i < tsList.length; i++) {
        const ts = tsList[i];
        const stats = sensor.frame_rows.get(ts);
        const gap = ts - prev;
        const dur = ts - curFirst;
        if (gap > opts.gap_ms || dur >= opts.window_ms) {
          pushWindow();
          bucket += 1;
          curFirst = ts;
          curLast = ts;
          curRows = Number(stats && stats.rows || 0);
          curFrames = 1;
          curOffsetStart = Number(stats && stats.start || 0);
          curOffsetEnd = Number(stats && stats.end || 0);
        } else {
          curLast = ts;
          curRows += Number(stats && stats.rows || 0);
          curFrames += 1;
          curOffsetEnd = Number(stats && stats.end || curOffsetEnd);
        }
        prev = ts;
      }
      pushWindow();

      out.push({
        sensor_id: sensor.sensor_id,
        sensor_label: sensor.sensor_label,
        path: sensor.path,
        rel_path: sensor.rel_path,
        row_filter_value: sensor.row_filter_value,
        row_filter_index: sensor.row_filter_index,
        delimiter: sensor.delimiter,
        field_indices: sensor.field_indices,
        t0_ms: tsList[0],
        windows,
      });
    }
    return out;
  },

  async _buildCpmIndex(ctx, opts) {
    const split = "all";
    const relCsv = await this._collectCpmCsvRelativePaths();
    const sensors = {};

    for (const relPath of relCsv) {
      const pathKey = WebFS.joinPath(WebFS.rootHandle.name, relPath);
      const text = await WebFS.readFileText(pathKey);
      if (!text) continue;
      const indexed = this._buildCpmIndexForFile(relPath, pathKey, text, opts);
      for (const item of indexed) {
        let sid = String(item.sensor_id || "");
        if (!sid) continue;
        if (sensors[sid]) {
          let n = 2;
          while (sensors[`${sid}__${n}`]) n += 1;
          sid = `${sid}__${n}`;
        }
        sensors[sid] = { ...item, sensor_id: sid };
      }
    }

    const flat = [];
    for (const sensorId of Object.keys(sensors)) {
      const sensor = sensors[sensorId];
      const windows = Array.isArray(sensor.windows) ? sensor.windows : [];
      for (let wi = 0; wi < windows.length; wi++) {
        const w = windows[wi];
        flat.push([sensorId, Number(w.first_ts_ms || 0), wi]);
      }
    }
    flat.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || (Number(a[1]) - Number(b[1])) || (Number(a[2]) - Number(b[2])));

    const scenes = {};
    const sceneIdsSorted = [];
    const sceneIdsBySensor = {};
    for (let i = 0; i < flat.length; i++) {
      const sceneId = String(i + 1);
      const sensorId = String(flat[i][0]);
      const wi = Number(flat[i][2]);
      const sensor = sensors[sensorId];
      const w = sensor && sensor.windows ? sensor.windows[wi] : null;
      if (!sensor || !w) continue;
      scenes[sceneId] = {
        scene_id: sceneId,
        split,
        sensor_id: sensorId,
        sensor_label: sensor.sensor_label,
        path: sensor.path,
        window_i: wi,
        window: w,
        row_filter_value: sensor.row_filter_value,
        row_filter_index: sensor.row_filter_index,
        delimiter: sensor.delimiter,
        field_indices: sensor.field_indices,
      };
      sceneIdsSorted.push(sceneId);
      if (!sceneIdsBySensor[sensorId]) sceneIdsBySensor[sensorId] = [];
      sceneIdsBySensor[sensorId].push(sceneId);
    }

    const sceneIndex = {};
    for (let i = 0; i < sceneIdsSorted.length; i++) sceneIndex[sceneIdsSorted[i]] = i;
    const sceneIndexBySensor = {};
    for (const [sid, ids] of Object.entries(sceneIdsBySensor)) {
      const m = {};
      for (let i = 0; i < ids.length; i++) m[ids[i]] = i;
      sceneIndexBySensor[sid] = m;
    }

    return {
      split,
      options: opts,
      sensors,
      scenes,
      scene_ids_sorted: sceneIdsSorted,
      scene_ids_by_sensor: sceneIdsBySensor,
      scene_index: sceneIndex,
      scene_index_by_sensor: sceneIndexBySensor,
    };
  },

  async _getCpmIndex(ctx) {
    if (!WebFS.rootHandle) {
      return {
        split: "all",
        sensors: {},
        scenes: {},
        scene_ids_sorted: [],
        scene_ids_by_sensor: {},
        scene_index: {},
        scene_index_by_sensor: {},
      };
    }
    const opts = this._resolveCpmOptions(ctx || {});
    const rootName = String(WebFS.rootHandle.name || "");
    const key = JSON.stringify({
      root: rootName,
      dataset_id: String((ctx && ctx.datasetId) || ""),
      window_s: opts.window_s,
      gap_s: opts.gap_s,
      frame_bin_ms: opts.frame_bin_ms,
      delimiter: opts.delimiter,
      column_map: opts.column_map,
    });
    const cached = this._cpmIndexCache.get(key);
    if (cached) {
      this._cpmIndexCache.delete(key);
      this._cpmIndexCache.set(key, cached);
      return cached;
    }
    const built = await this._buildCpmIndex(ctx || {}, opts);
    this._cacheCpmIndex(key, built);
    return built;
  },

  async fetchJson(url) {
    if (url.endsWith('/api/app_meta')) {
      return { app_name: "V2X Scene Explorer (Web)", app_version: "0.2.0-web", desktop: false, update_repo: null };
    }
    if (url.includes('/api/update/check')) {
      return {
        ok: true,
        update_available: false,
        app_version: "0.2.0-web",
        latest_version: "0.2.0-web",
        comparison_mode: "static_web",
        comparison_confident: true,
        release_prerelease: false,
        download_url: null,
        release_url: null,
      };
    }
    if (url.endsWith('/api/datasets')) return { datasets: this.getDatasets() };
    if (url.endsWith('/api/profiles')) return { items: this.listProfileSummaries() };
    const profileMatch = String(url).match(/\/api\/profiles\/([^/?#]+)/);
    if (profileMatch) return await this.handleGetProfile(decodeURIComponent(profileMatch[1]));
    if (url.includes('/meta')) { // Handle /api/datasets/{id}/meta
      // Extract ID
      const id = this._extractDatasetIdFromUrl(url);
      const all = this.getDatasets();
      const found = all.find(d => String((d && d.id) || "") === id);
      if (found) return found; // Return the dataset spec itself as meta
      return {};
    }
    if (url.includes('/scenes?')) return await this.handleListScenes(url);
    if (url.includes('/intersections?')) return await this.handleListIntersections(url);
    if (url.includes('/locate_scene?')) return await this.handleLocateScene(url);
    if (url.includes('/bundle?')) return await this.handleLoadBundle(url);

    throw new Error(`WebBackend: Unhandled GET ${url}`);
  },

  async postJson(url, payload) {
    if (url.endsWith('/api/profiles/detect')) return await this.handleDetect(payload);
    if (url.endsWith('/api/profiles/validate')) return await this.handleValidate(payload);
    if (url.endsWith('/api/profiles/save')) return await this.handleSaveProfile(payload);
    if (url.endsWith('/api/profiles/delete')) return await this.handleDeleteProfile(payload);
    if (url.endsWith('/api/profiles/default')) return await this.handleSetDefaultProfile(payload);

    throw new Error(`WebBackend: Unhandled POST ${url}`);
  },

  async handleDetect(payload) {
    if (!WebFS.rootHandle) {
      const validation = {
        status: "broken_path",
        errors: [{ code: "E_ROLE_REQUIRED_MISSING", message: "Provide at least one folder or file path." }],
        warnings: [],
        last_checked: this.nowIso(),
      };
      return { ok: false, error: "No folder selected.", validation };
    }

    const rootName = String(WebFS.rootHandle.name || "").trim() || "Web Dataset";
    const files = await WebFS.listDir(rootName);
    const hinted = this.normalizeDatasetType(payload && payload.dataset_type);
    const datasetType = hinted || this.inferDatasetTypeFromRootEntries(files);
    const base = {
      name: String((payload && payload.name) || rootName),
      dataset_type: datasetType,
      roots: [rootName],
      bindings: {},
      scene_strategy: this.defaultSceneStrategy(datasetType),
      detector: {
        score: hinted ? 100 : 70,
        second_best: 0,
        decision_mode: hinted ? "auto" : "confirm",
        checked_at: this.nowIso(),
      },
    };
    const out = this.normalizeProfile(base, datasetType);
    return { ok: true, profile: out.profile, validation: out.validation, capabilities: out.capabilities };
  },

  async handleValidate(payload) {
    const profile = (payload && payload.profile && typeof payload.profile === "object") ? payload.profile : {};
    const hinted = this.normalizeDatasetType(payload && payload.dataset_type);
    const out = this.normalizeProfile(profile, hinted);
    return { ok: true, profile: out.profile, validation: out.validation, capabilities: out.capabilities };
  },

  async handleGetProfile(profileId) {
    const pid = String(profileId || "").trim();
    if (!pid) throw new Error("profile_id is required");
    const profiles = this.getProfiles();
    const raw = profiles.find((p) => String(p.profile_id || "") === pid);
    if (!raw) throw new Error(`profile not found: ${pid}`);
    const out = this.normalizeProfile(raw, raw.dataset_type);
    return {
      profile: out.profile,
      summary: this.profileSummary(out.profile),
      validation: out.validation,
      capabilities: out.capabilities,
    };
  },

  async handleDeleteProfile(payload) {
    const pid = String((payload && (payload.profile_id || payload.id)) || "").trim();
    if (!pid) throw new Error("profile_id is required");
    const profiles = this.getProfiles();
    const idx = profiles.findIndex((p) => String(p.profile_id || "") === pid);
    if (idx < 0) throw new Error(`profile not found: ${pid}`);
    const removed = profiles[idx];
    profiles.splice(idx, 1);
    this.saveProfiles(profiles);

    const removedDatasetId = String((removed && removed.dataset_id) || "").trim();
    if (removedDatasetId) {
      const datasets = this.getDatasets().filter((d) => String(d && d.id || "") !== removedDatasetId);
      this.saveDatasets(datasets);
    }
    if (this.getDefaultProfileId() === pid) {
      const nextDefault = String(((profiles[0] || {}).profile_id) || "").trim();
      this.setDefaultProfileId(nextDefault);
    }
    return { ok: true, profile_id: pid, default_profile_id: this.getDefaultProfileId(), datasets: this.getDatasets() };
  },

  async handleSetDefaultProfile(payload) {
    const pid = String((payload && (payload.profile_id || payload.id)) || "").trim();
    if (!pid) throw new Error("profile_id is required");
    const profiles = this.getProfiles();
    const raw = profiles.find((p) => String(p.profile_id || "") === pid);
    if (!raw) throw new Error(`profile not found: ${pid}`);
    this.setDefaultProfileId(pid);
    return {
      ok: true,
      profile_id: pid,
      name: String(raw.name || pid),
      dataset_id: String(raw.dataset_id || ""),
    };
  },

  async handleSaveProfile(payload) {
    const profileIn = payload && payload.profile && typeof payload.profile === "object" ? payload.profile : {};
    const out = this.normalizeProfile(profileIn, profileIn.dataset_type);
    const profile = out.profile;
    const profiles = this.getProfiles();

    const existingIdx = profiles.findIndex(p => p.profile_id === profile.profile_id);
    if (existingIdx >= 0) profiles[existingIdx] = profile;
    else profiles.push(profile);
    this.saveProfiles(profiles);
    if (!this.getDefaultProfileId()) {
      this.setDefaultProfileId(profile.profile_id);
    }

    const family = this.datasetFamilyFromType(profile.dataset_type) || "v2x-traj";
    const rootPath = String((profile.roots && profile.roots[0]) || (WebFS.rootHandle && WebFS.rootHandle.name) || "").trim();
    const caps = this.capabilitiesFromType(profile.dataset_type) || {};
    const dsEntry = {
      id: profile.dataset_id,
      title: profile.name || profile.dataset_id,
      family: family,
      root: rootPath,
      dataset_type: profile.dataset_type,
      has_map: !!caps.has_map,
      has_scene_background: !!caps.has_scene_background,
      has_traffic_lights: !!caps.has_traffic_lights,
      splits: Array.isArray(caps.splits) && caps.splits.length ? caps.splits.slice() : undefined,
      default_split: String(caps.default_split || "").trim() || undefined,
      group_label: String(caps.group_label || "").trim() || undefined,
      modalities: Array.isArray(caps.modalities) && caps.modalities.length ? caps.modalities.slice() : undefined,
      modality_labels: (caps.modality_labels && typeof caps.modality_labels === "object") ? { ...caps.modality_labels } : undefined,
      modality_short_labels: (caps.modality_short_labels && typeof caps.modality_short_labels === "object") ? { ...caps.modality_short_labels } : undefined,
      app: { supported: true, family: family },
    };

    const datasets = this.getDatasets();
    const idx = datasets.findIndex((d) => String((d && d.id) || "") === dsEntry.id);
    if (idx >= 0) datasets[idx] = { ...datasets[idx], ...dsEntry };
    else datasets.push(dsEntry);
    this.saveDatasets(datasets);

    return { ok: true, profile: profile, validation: out.validation, capabilities: out.capabilities, datasets: this.getDatasets() };
  },

  async handleListIntersections(url) {
    const urlObj = new URL(url, 'http://localhost');
    const requestedSplit = urlObj.searchParams.get('split') || 'train';
    const datasetId = this._extractDatasetIdFromUrl(url);
    const ctx = this._resolveDatasetContext(datasetId);

    if (!WebFS.rootHandle) {
      return { split: requestedSplit, items: [] };
    }

    if (ctx.datasetType === "consider_it_cpm") {
      const index = await this._getCpmIndex(ctx);
      const split = index.split || "all";
      const sensors = (index && index.sensors && typeof index.sensors === "object") ? index.sensors : {};
      const bySensor = (index && index.scene_ids_by_sensor && typeof index.scene_ids_by_sensor === "object") ? index.scene_ids_by_sensor : {};
      const items = [];
      for (const sensor of Object.values(sensors)) {
        if (!sensor || !sensor.sensor_id) continue;
        const sid = String(sensor.sensor_id);
        const ids = Array.isArray(bySensor[sid]) ? bySensor[sid] : [];
        items.push({
          intersect_id: sid,
          intersect_label: String(sensor.sensor_label || sid),
          count: ids.length,
        });
      }
      items.sort((a, b) => {
        const ra = cpmSensorLabelRank(a.intersect_label);
        const rb = cpmSensorLabelRank(b.intersect_label);
        if (ra !== rb) return ra - rb;
        if (a.count !== b.count) return b.count - a.count;
        return String(a.intersect_label || "").localeCompare(String(b.intersect_label || ""));
      });
      return { split, items };
    }

    const candidatePaths = [
      'scenes.csv',
      WebFS.joinPath(WebFS.rootHandle.name, requestedSplit, 'scenes.csv'),
      WebFS.joinPath(WebFS.rootHandle.name, 'scenes.csv'),
    ];
    const found = await this.readCsvRowsFromPaths(candidatePaths);
    const rows = Array.isArray(found.rows) ? found.rows : [];
    if (!rows.length) {
      return { split: requestedSplit, items: [] };
    }
    const counts = {};
    rows.forEach(r => {
      // Filter by split logic
      let match = false;
      if (r.split) match = (r.split === requestedSplit);
      else {
        const table = r.table || '';
        match = (!table || table.includes(requestedSplit));
      }

      if (match && r.intersect_id) {
        counts[r.intersect_id] = (counts[r.intersect_id] || 0) + 1;
      }
    });

    const items = Object.entries(counts).map(([k, v]) => ({
      intersect_id: k,
      intersect_label: k, // basic label
      count: v
    })).sort((a, b) => b.count - a.count);

    return { split: requestedSplit, items };
  },

  async handleListScenes(url) {
    const urlObj = new URL(url, 'http://localhost');
    const requestedSplit = urlObj.searchParams.get('split') || 'train';
    const limit = this._clampInt(urlObj.searchParams.get('limit'), 200, 1, 5000);
    const offset = this._clampInt(urlObj.searchParams.get('offset'), 0, 0, 1_000_000_000);
    const intersectId = String(urlObj.searchParams.get('intersect_id') || '').trim();
    const includeTlOnly = String(urlObj.searchParams.get('include_tl_only') || '0').toLowerCase();
    const includeTlOnlyFlag = includeTlOnly === '1' || includeTlOnly === 'true' || includeTlOnly === 'yes' || includeTlOnly === 'on';
    const datasetId = this._extractDatasetIdFromUrl(url);
    const ctx = this._resolveDatasetContext(datasetId);

    // If no folder selected, we can't list scenes.
    if (!WebFS.rootHandle) {
      return { items: [], total: 0, limit, offset, availability: { scene_count: 0 } };
    }

    if (ctx.datasetType === "consider_it_cpm") {
      const index = await this._getCpmIndex(ctx);
      const split = index.split || "all";
      let ids = [];
      if (intersectId) {
        ids = Array.isArray(index.scene_ids_by_sensor && index.scene_ids_by_sensor[intersectId])
          ? index.scene_ids_by_sensor[intersectId].slice()
          : [];
      } else {
        ids = Array.isArray(index.scene_ids_sorted) ? index.scene_ids_sorted.slice() : [];
      }

      const total = ids.length;
      const slice = ids.slice(offset, offset + limit);
      const items = [];
      for (const sid of slice) {
        const ref = index.scenes && index.scenes[sid] ? index.scenes[sid] : null;
        if (!ref || !ref.window) continue;
        const w = ref.window;
        const durS = Math.max(0, (Number(w.last_ts_ms || 0) - Number(w.first_ts_ms || 0)) / 1000);
        const timeLabel = cpmTimeRangeLabel(w.first_ts_ms, w.last_ts_ms);
        items.push({
          scene_id: String(ref.scene_id || sid),
          scene_label: `Scene ${String(ref.scene_id || sid)} · ${timeLabel}`,
          split,
          city: null,
          intersect_id: String(ref.sensor_id || ""),
          intersect_label: String(ref.sensor_label || ref.sensor_id || ""),
          by_modality: {
            infra: {
              rows: Number(w.rows || 0),
              min_ts: Number(w.first_ts_ms || 0) / 1000,
              max_ts: Number(w.last_ts_ms || 0) / 1000,
              unique_ts: Number(w.frames || 0),
              duration_s: durS,
              unique_agents: null,
            },
          },
        });
      }
      return {
        split,
        intersect_id: intersectId || null,
        total,
        limit,
        offset,
        items,
        availability: { scene_count: total, by_modality: { infra: total } },
        include_tl_only: includeTlOnlyFlag,
      };
    }

    const candidatePaths = [
      'scenes.csv',
      WebFS.joinPath(WebFS.rootHandle.name, requestedSplit, 'scenes.csv'),
      WebFS.joinPath(WebFS.rootHandle.name, 'scenes.csv'),
    ];
    const found = await this.readCsvRowsFromPaths(candidatePaths);
    const rows = Array.isArray(found.rows) ? found.rows : [];
    if (!rows.length) {
      // Fallback: list files in trajectories dir?
      // For now, return empty.
      return { items: [], total: 0, limit, offset, availability: { scene_count: 0 } };
    }
    let scenes = rows.filter(r => {
      // Filter by split logic:
      if (r.split) return r.split === requestedSplit;

      const table = r.table || '';
      // If table column exists, filter by split. If not, include all (or assume split match).
      return !table || table.includes(requestedSplit);
    }).map(r => ({
      scene_id: String(r.scene_id || "").trim(),
      scene_label: String(r.scene_label || "").trim() || null,
      split: requestedSplit,
      city: r.city,
      intersect_id: String(r.intersect_id || "").trim() || null,
      intersect_label: String(r.intersect_label || r.intersect_id || "").trim() || null,
      by_modality: {}
    })).filter((r) => !!r.scene_id);

    if (intersectId) {
      scenes = scenes.filter((r) => String(r.intersect_id || "") === intersectId);
    }

    const slice = scenes.slice(offset, offset + limit);
    return {
      split: requestedSplit,
      intersect_id: intersectId || null,
      items: slice,
      total: scenes.length,
      limit,
      offset,
      availability: { scene_count: scenes.length },
      include_tl_only: includeTlOnlyFlag,
    };
  },

  async handleLocateScene(url) {
    const urlObj = new URL(url, 'http://localhost');
    const requestedSplit = String(urlObj.searchParams.get('split') || 'train').trim() || 'train';
    const sceneId = String(urlObj.searchParams.get('scene_id') || '').trim();
    if (!sceneId) throw new Error("scene_id is required");
    const datasetId = this._extractDatasetIdFromUrl(url);
    const ctx = this._resolveDatasetContext(datasetId);

    if (!WebFS.rootHandle) {
      return { split: requestedSplit, scene_id: sceneId, found: false };
    }

    if (ctx.datasetType === "consider_it_cpm") {
      const index = await this._getCpmIndex(ctx);
      const split = index.split || "all";
      const ref = index.scenes && index.scenes[sceneId] ? index.scenes[sceneId] : null;
      if (!ref) return { split, scene_id: sceneId, found: false };
      const idxAll = index.scene_index && index.scene_index[sceneId] != null ? Number(index.scene_index[sceneId]) : null;
      const idxIn = index.scene_index_by_sensor && index.scene_index_by_sensor[ref.sensor_id]
        && index.scene_index_by_sensor[ref.sensor_id][sceneId] != null
        ? Number(index.scene_index_by_sensor[ref.sensor_id][sceneId])
        : null;
      const totalIn = Array.isArray(index.scene_ids_by_sensor && index.scene_ids_by_sensor[ref.sensor_id])
        ? index.scene_ids_by_sensor[ref.sensor_id].length
        : 0;
      return {
        split,
        scene_id: sceneId,
        found: true,
        city: null,
        intersect_id: String(ref.sensor_id || ""),
        intersect_label: String(ref.sensor_label || ref.sensor_id || ""),
        index_all: idxAll,
        total_all: Array.isArray(index.scene_ids_sorted) ? index.scene_ids_sorted.length : 0,
        index_in_intersection: idxIn,
        total_in_intersection: totalIn,
      };
    }

    const candidatePaths = [
      'scenes.csv',
      WebFS.joinPath(WebFS.rootHandle.name, requestedSplit, 'scenes.csv'),
      WebFS.joinPath(WebFS.rootHandle.name, 'scenes.csv'),
    ];
    const found = await this.readCsvRowsFromPaths(candidatePaths);
    const rows = Array.isArray(found.rows) ? found.rows : [];
    if (!rows.length) return { split: requestedSplit, scene_id: sceneId, found: false };

    const scenes = rows.filter((r) => {
      if (r.split) return String(r.split) === requestedSplit;
      const table = String(r.table || '');
      return !table || table.includes(requestedSplit);
    }).map((r) => ({
      scene_id: String(r.scene_id || "").trim(),
      intersect_id: String(r.intersect_id || "").trim(),
      intersect_label: String(r.intersect_label || r.intersect_id || "").trim(),
      city: String(r.city || "").trim() || null,
    })).filter((r) => !!r.scene_id);

    const idxAll = scenes.findIndex((s) => String(s.scene_id) === sceneId);
    if (idxAll < 0) return { split: requestedSplit, scene_id: sceneId, found: false };
    const scene = scenes[idxAll];
    const sameIntersect = scenes.filter((s) => String(s.intersect_id || "") === String(scene.intersect_id || ""));
    const idxIn = sameIntersect.findIndex((s) => String(s.scene_id) === sceneId);
    return {
      split: requestedSplit,
      scene_id: sceneId,
      found: true,
      city: scene.city,
      intersect_id: scene.intersect_id || null,
      intersect_label: scene.intersect_label || scene.intersect_id || null,
      index_all: idxAll,
      total_all: scenes.length,
      index_in_intersection: idxIn >= 0 ? idxIn : null,
      total_in_intersection: sameIntersect.length,
    };
  },

  async _loadCpmBundle(ctx, datasetId, sceneId) {
    const index = await this._getCpmIndex(ctx);
    const split = index.split || "all";
    const sid = String(sceneId || "").trim();
    const ref = index.scenes && index.scenes[sid] ? index.scenes[sid] : null;
    if (!ref || !ref.window) throw new Error(`scene not found: ${sid}`);

    const text = await WebFS.readFileText(ref.path);
    if (!text) throw new Error(`failed to read scene file: ${ref.path}`);

    const w = ref.window;
    const src = String(text || "");
    const startOff = Math.max(0, Number(w.offset_start || 0));
    const endOffRaw = Number(w.offset_end || src.length);
    const endOff = Math.min(src.length, Number.isFinite(endOffRaw) && endOffRaw > startOff ? endOffRaw : src.length);
    const section = src.slice(startOff, endOff);
    const delim = String(ref.delimiter || ",");
    const idx = (ref.field_indices && typeof ref.field_indices === "object") ? ref.field_indices : {};
    const valueAt = (arr, i) => (Number.isFinite(Number(i)) && Number(i) >= 0 && Number(i) < arr.length) ? arr[Number(i)] : null;
    const tsIdx = Number(idx.generationTime_ms);
    if (!(tsIdx >= 0)) throw new Error(`scene file is missing timestamp column: ${ref.path}`);

    const filterIdx = Number(ref.row_filter_index);
    const filterValue = ref.row_filter_value == null ? null : String(ref.row_filter_value);

    const byTs = {};
    const extent = { min_x: Infinity, min_y: Infinity, max_x: -Infinity, max_y: -Infinity };
    const objIds = new Set();
    let rows = 0;

    let pos = 0;
    const len = section.length;
    while (pos <= len) {
      const nl = section.indexOf("\n", pos);
      const rawLine = nl >= 0 ? section.slice(pos, nl) : section.slice(pos);
      pos = nl >= 0 ? (nl + 1) : (len + 1);
      let line = rawLine;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;

      const values = splitCsvLine(line, delim);

      if (filterValue != null && filterIdx >= 0) {
        const rv = String(valueAt(values, filterIdx) == null ? "" : valueAt(values, filterIdx)).trim();
        if (rv !== filterValue) continue;
      }

      const tsRaw = cpmAsInt(valueAt(values, tsIdx));
      if (tsRaw == null) continue;
      const ts = cpmBucketTs(tsRaw, index.options && index.options.frame_bin_ms ? index.options.frame_bin_ms : 100);
      if (ts < Number(w.start_ms) || ts > Number(w.end_ms)) continue;

      const trackIdRaw = valueAt(values, idx.trackID);
      const objectIdRaw = valueAt(values, idx.objectID);
      const trackId = trackIdRaw == null ? null : String(trackIdRaw).trim();
      const objectId = objectIdRaw == null ? null : String(objectIdRaw).trim();
      const oid = (trackId && trackId !== "") ? trackId : (objectId && objectId !== "" ? objectId : `obj-${rows + 1}`);
      objIds.add(oid);

      const yNorth = safeFloat(valueAt(values, idx.xDistance_m));
      const xEast = safeFloat(valueAt(values, idx.yDistance_m));
      const x = xEast;
      const y = yNorth;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        extent.min_x = Math.min(extent.min_x, x);
        extent.min_y = Math.min(extent.min_y, y);
        extent.max_x = Math.max(extent.max_x, x);
        extent.max_y = Math.max(extent.max_y, y);
      }

      const vxNorth = safeFloat(valueAt(values, idx.xSpeed_mps));
      const vyEast = safeFloat(valueAt(values, idx.ySpeed_mps));
      const v_x = vyEast;
      const v_y = vxNorth;

      const yawDeg = safeFloat(valueAt(values, idx.yawAngle_deg));
      const theta = (yawDeg == null) ? null : (Math.PI / 180.0) * (90.0 - yawDeg);
      const cls = cpmAsInt(valueAt(values, idx.classificationType));
      const mapped = cpmClassToTypeSubtype(cls);

      const rec = {
        id: oid,
        track_id: trackId,
        object_id: objectId,
        type: mapped.type,
        sub_type: mapped.sub_type,
        sub_type_code: cls,
        tag: ref.sensor_id,
        x,
        y,
        z: null,
        length: safeFloat(valueAt(values, idx.objLength_m)),
        width: safeFloat(valueAt(values, idx.objWidth_m)),
        height: safeFloat(valueAt(values, idx.objHeight_m)),
        theta,
        v_x,
        v_y,
      };

      if (!byTs[ts]) byTs[ts] = [];
      byTs[ts].push(rec);
      rows += 1;
    }

    const tsList = Object.keys(byTs).map((x) => Number(x)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const timestamps = tsList.map((t) => t / 1000.0);
    const t0 = timestamps.length ? timestamps[0] : 0.0;
    const hasExtent = Number.isFinite(extent.min_x) && Number.isFinite(extent.min_y) && Number.isFinite(extent.max_x) && Number.isFinite(extent.max_y);
    const normalizedExtent = hasExtent ? extent : { min_x: -10.0, min_y: -10.0, max_x: 10.0, max_y: 10.0 };
    const warnings = [];
    if (!hasExtent) warnings.push("extent_missing: could not compute extent from window rows");
    if (rows <= 0) warnings.push("scene_window_empty");

    const frames = tsList.map((ts) => ({ infra: byTs[ts] || [] }));
    const modalityStats = {
      ego: { rows: 0, unique_ts: 0, min_ts: null, max_ts: null },
      vehicle: { rows: 0, unique_ts: 0, min_ts: null, max_ts: null },
      traffic_light: { rows: 0, unique_ts: 0, min_ts: null, max_ts: null },
      infra: {
        rows: rows,
        unique_ts: tsList.length,
        min_ts: tsList.length ? tsList[0] / 1000.0 : null,
        max_ts: tsList.length ? tsList[tsList.length - 1] / 1000.0 : null,
        unique_agents: objIds.size,
      },
    };
    const sceneLabel = `Scene ${sid} · ${cpmTimeRangeLabel(w.first_ts_ms, w.last_ts_ms)}`;
    const windowCount = Array.isArray(index.scene_ids_by_sensor && index.scene_ids_by_sensor[ref.sensor_id])
      ? index.scene_ids_by_sensor[ref.sensor_id].length
      : 0;

    return {
      dataset_id: String(datasetId || ctx.datasetId || "consider-it-cpm"),
      split,
      scene_id: sid,
      scene_label: sceneLabel,
      city: null,
      intersect_id: ref.sensor_id,
      intersect_label: ref.sensor_label,
      window_index: Number(ref.window_i || 0),
      window_count: windowCount,
      intersect_by_modality: { infra: ref.sensor_id },
      map_id: null,
      map: null,
      t0,
      timestamps,
      extent: normalizedExtent,
      modality_stats: modalityStats,
      frames,
      warnings,
    };
  },

  async handleLoadBundle(url) {
    if (!WebFS.rootHandle) throw new Error("No folder selected");
    const parts = url.split('/');
    const datasetId = decodeURIComponent(parts[parts.indexOf('datasets') + 1] || 'web-dataset');
    const split = parts[parts.indexOf('scene') + 1];
    const sceneId = parts[parts.indexOf('scene') + 2];
    const urlObj = new URL(url, 'http://localhost');
    const includeMap = urlObj.searchParams.get('include_map') !== '0';
    const ctx = this._resolveDatasetContext(datasetId);

    if (ctx.datasetType === "consider_it_cpm") {
      return await this._loadCpmBundle(ctx, datasetId, sceneId);
    }

    const modalities = ['ego', 'infra', 'vehicle', 'traffic_light'];
    const pathMap = {
      'ego': 'ego-trajectories',
      'infra': 'infrastructure-trajectories',
      'vehicle': 'vehicle-trajectories',
      'traffic_light': 'traffic-light'
    };

    const extent = { min_x: Infinity, min_y: Infinity, max_x: -Infinity, max_y: -Infinity };
    const allTs = new Set();

    const updateExtent = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      extent.min_x = Math.min(extent.min_x, x);
      extent.min_y = Math.min(extent.min_y, y);
      extent.max_x = Math.max(extent.max_x, x);
      extent.max_y = Math.max(extent.max_y, y);
    };

    const trajectories = {};
    for (const mod of modalities) {
      const folder = pathMap[mod];
      const candidatePaths = [
        WebFS.joinPath(WebFS.rootHandle.name, folder, split, 'data', `${sceneId}.csv`),
        WebFS.joinPath(WebFS.rootHandle.name, folder, `${sceneId}.csv`),
      ];
      const found = await this.readCsvRowsFromPaths(candidatePaths);
      const rows = Array.isArray(found.rows) ? found.rows : [];
      if (rows.length) {
        const byTs = {};
        rows.forEach(r => {
          const ts = parseTs100ms(r.timestamp);
          if (ts === null) return;
          if (!byTs[ts]) byTs[ts] = [];

          // Construct object based on modality
          // Helper to copy safe floats
          const obj = {
            id: r.id,
            type: r.type,
            sub_type: r.sub_type,
            x: safeFloat(r.x),
            y: safeFloat(r.y),
            v_x: safeFloat(r.v_x),
            v_y: safeFloat(r.v_y),
            tag: r.tag,
            length: safeFloat(r.length),
            width: safeFloat(r.width),
            height: safeFloat(r.height),
            theta: safeFloat(r.theta),
            z: safeFloat(r.z),
          };

          // TL Specifics
          if (mod === 'traffic_light') {
            obj.color_1 = r.color_1;
            obj.remain_1 = safeFloat(r.remain_1);
            obj.color_2 = r.color_2;
            obj.remain_2 = safeFloat(r.remain_2);
            obj.lane_id = r.lane_id;
          }

          allTs.add(ts);
          updateExtent(obj.x, obj.y);
          byTs[ts].push(obj);
        });
        trajectories[mod] = byTs;
      }
    }

    let mapData = null;
    if (includeMap) {
      // Find map JSON
      const mapFiles = await WebFS.listDir(WebFS.joinPath(WebFS.rootHandle.name, 'maps'));
      const jsonMap = mapFiles.find(f => f.endsWith('.json'));
      if (jsonMap) {
        const text = await WebFS.readFileText(WebFS.joinPath(WebFS.rootHandle.name, 'maps', jsonMap));
        if (text) {
          mapData = processMapData(JSON.parse(text));
          mapData.map_file = jsonMap;
        }
      }
    }

    const tsSorted = Array.from(allTs).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const timestamps = tsSorted.map((x) => x / 10);
    const t0 = timestamps.length ? timestamps[0] : 0;
    const frames = tsSorted.map((ts) => ({
      ego: trajectories.ego && trajectories.ego[ts] ? trajectories.ego[ts] : [],
      infra: trajectories.infra && trajectories.infra[ts] ? trajectories.infra[ts] : [],
      vehicle: trajectories.vehicle && trajectories.vehicle[ts] ? trajectories.vehicle[ts] : [],
      traffic_light: trajectories.traffic_light && trajectories.traffic_light[ts] ? trajectories.traffic_light[ts] : [],
    }));

    const modality_stats = {};
    for (const mod of modalities) {
      const byTs = trajectories[mod] || {};
      const keys = Object.keys(byTs).map((x) => Number(x)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
      const rows = keys.reduce((acc, k) => acc + ((byTs[k] || []).length), 0);
      modality_stats[mod] = {
        rows: rows,
        unique_ts: keys.length,
        min_ts: keys.length ? (keys[0] / 10) : null,
        max_ts: keys.length ? (keys[keys.length - 1] / 10) : null,
      };
    }

    const normalizedExtent = Number.isFinite(extent.min_x) ? extent : { min_x: 0, min_y: 0, max_x: 1, max_y: 1 };

    return {
      dataset_id: datasetId,
      scene_id: sceneId,
      split: split,
      city: "Web City",
      intersect_id: "web",
      intersect_label: "Web",
      map_id: mapData ? (mapData.map_id || "web_map") : null,
      t0: t0,
      timestamps: timestamps,
      extent: normalizedExtent,
      scene_label: `Scene ${sceneId}`,
      modality_stats: modality_stats,
      frames: frames,
      warnings: [],
      trajectories: trajectories,
      map: mapData,
      meta: { city: "Web City", intersect_id: "web" }
    };
  }
};

window.WebBackend = WebBackend;
window.WebFS = WebFS;
