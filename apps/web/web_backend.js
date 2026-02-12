
/**
 * Browser-based File System Access API wrapper + mock "backend" validation logic.
 * Replaces Python backend calls when running on GitHub Pages / static host.
 */

const WebFS = {
  rootHandle: null,
  cachedHandles: new Map(), // path string -> handle

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
    const handle = await this.getFileHandle(pathStr);
    if (!handle) return null;
    const file = await handle.getFile();
    return await file.text();
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

function parseCsv(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    // Handle basic quoted CSV if needed, but V2X-Traj is usually simple
    const values = lines[i].split(',');
    if (values.length !== headers.length) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j].trim();
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

  const lanes = Object.values(raw.LANE || {}).map(l => ({
    id: l.id,
    lane_type: l.lane_type,
    turn_direction: l.turn_direction,
    is_intersection: l.is_intersection,
    has_traffic_control: l.has_traffic_control,
    centerline: parsePoly(l.centerline)
  }));

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


// === Web Backend Emulation ===

const WebBackend = {
  LS_DATASETS: "traj.web.datasets",
  LS_PROFILES: "traj.web.profiles",
  LS_DEFAULT_PROFILE: "traj.web.default_profile",

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
    const local = [];
    try {
      const stored = JSON.parse(localStorage.getItem(this.LS_DATASETS));
      if (Array.isArray(stored)) local.push(...stored);
    } catch (e) { }
    // Return static catalog + local overrides/additions.
    return [...this.STATIC_CATALOG, ...local];
  },

  saveDatasets(list) {
    const staticIds = new Set(this.STATIC_CATALOG.map((d) => d.id));
    const toSave = Array.isArray(list) ? list.filter((d) => d && !staticIds.has(d.id)) : [];
    localStorage.setItem(this.LS_DATASETS, JSON.stringify(toSave));
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
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'v2x-traj' || s === 'v2x_traj' || s === 'v2xtraj') return 'v2x_traj';
    if (s === 'v2x-seq' || s === 'v2x_seq' || s === 'v2xseq') return 'v2x_seq';
    if (s === 'ind' || s === 'in-d' || s === 'ind_dataset') return 'ind';
    if (s === 'sind' || s === 'sin-d' || s === 'sin_d' || s === 'sind_dataset') return 'sind';
    if (s === 'consider-it-cpm' || s === 'consider_it_cpm' || s === 'cpm' || s === 'cpm-objects' || s === 'considerit') return 'consider_it_cpm';
    return '';
  },

  datasetFamilyFromType(raw) {
    const t = this.normalizeDatasetType(raw);
    if (t === 'v2x_traj') return 'v2x-traj';
    if (t === 'v2x_seq') return 'v2x-seq';
    if (t === 'ind') return 'ind';
    if (t === 'sind') return 'sind';
    if (t === 'consider_it_cpm') return 'cpm-objects';
    return '';
  },

  capabilitiesFromType(raw) {
    const t = this.normalizeDatasetType(raw);
    if (t === "v2x_traj" || t === "v2x_seq") {
      return { has_map: true, has_traffic_lights: true, splits: ["train", "val"], group_label: "Intersection" };
    }
    if (t === "ind") return { has_map: true, has_traffic_lights: false, splits: ["all"], group_label: "Location" };
    if (t === "sind") return { has_map: true, has_traffic_lights: true, splits: ["all"], group_label: "City" };
    if (t === "consider_it_cpm") return { has_map: false, has_traffic_lights: false, splits: ["all"], group_label: "Sensor" };
    return {};
  },

  defaultSceneStrategy(raw) {
    const t = this.normalizeDatasetType(raw);
    if (t === "v2x_traj") return { mode: "intersection_scene" };
    if (t === "v2x_seq") return { mode: "sequence_scene" };
    if (t === "ind") return { mode: "recording_window", window_s: 60 };
    if (t === "sind") return { mode: "scenario_scene" };
    if (t === "consider_it_cpm") return { mode: "time_window", window_s: 300, gap_s: 120 };
    return { mode: "intersection_scene" };
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

  async fetchJson(url) {
    if (url.endsWith('/api/app_meta')) {
      return { app_name: "V2X Scene Explorer (Web)", app_version: "0.2.0-web", desktop: false, update_repo: null };
    }
    if (url.endsWith('/api/datasets')) return { datasets: this.getDatasets() };
    if (url.endsWith('/api/profiles')) return { items: this.listProfileSummaries() };
    const profileMatch = String(url).match(/\/api\/profiles\/([^/?#]+)/);
    if (profileMatch) return await this.handleGetProfile(decodeURIComponent(profileMatch[1]));
    if (url.includes('/meta')) { // Handle /api/datasets/{id}/meta
      // Extract ID
      const parts = url.split('/');
      const id = parts[parts.indexOf('datasets') + 1];
      const all = this.getDatasets();
      const found = all.find(d => d.id === id);
      if (found) return found; // Return the dataset spec itself as meta
      return {};
    }
    if (url.includes('/scenes?')) return await this.handleListScenes(url);
    if (url.includes('/intersections?')) return await this.handleListIntersections(url);
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
    const dsEntry = {
      id: profile.dataset_id,
      title: profile.name || profile.dataset_id,
      family: family,
      root: rootPath,
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
    const split = urlObj.searchParams.get('split') || 'train';

    if (!WebFS.rootHandle) {
      return { split, items: [] };
    }

    let csvText = await WebFS.readFileText('scenes.csv');
    // If not at root, try split folder
    if (!csvText) csvText = await WebFS.readFileText(WebFS.joinPath(WebFS.rootHandle.name, split, 'scenes.csv'));
    if (!csvText) csvText = await WebFS.readFileText(WebFS.joinPath(WebFS.rootHandle.name, 'scenes.csv'));

    if (!csvText) {
      return { split, items: [] };
    }

    const rows = parseCsv(csvText);
    const counts = {};
    rows.forEach(r => {
      // Filter by split logic
      let match = false;
      if (r.split) match = (r.split === split);
      else {
        const table = r.table || '';
        match = (!table || table.includes(split));
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

    return { split, items };
  },

  async handleListScenes(url) {
    const urlObj = new URL(url, 'http://localhost');
    const split = urlObj.searchParams.get('split') || 'train';
    const limit = parseInt(urlObj.searchParams.get('limit') || '200');
    const offset = parseInt(urlObj.searchParams.get('offset') || '0');

    // If no folder selected, we can't list scenes.
    if (!WebFS.rootHandle) {
      return { items: [], total: 0, limit, offset, availability: { scene_count: 0 } };
    }

    let csvText = await WebFS.readFileText('scenes.csv');
    // If not at root, try split folder
    if (!csvText) csvText = await WebFS.readFileText(WebFS.joinPath(WebFS.rootHandle.name, split, 'scenes.csv'));
    if (!csvText) csvText = await WebFS.readFileText(WebFS.joinPath(WebFS.rootHandle.name, 'scenes.csv'));

    if (!csvText) {
      // Fallback: list files in trajectories dir?
      // For now, return empty.
      return { items: [], total: 0, limit, offset, availability: { scene_count: 0 } };
    }

    const rows = parseCsv(csvText);
    const scenes = rows.filter(r => {
      // Filter by split logic:
      if (r.split) return r.split === split;

      const table = r.table || '';
      // If table column exists, filter by split. If not, include all (or assume split match).
      return !table || table.includes(split);
    }).map(r => ({
      scene_id: r.scene_id,
      split: split,
      city: r.city,
      intersect_id: r.intersect_id,
      intersect_label: r.intersect_id,
      by_modality: {}
    }));

    const slice = scenes.slice(offset, offset + limit);
    return {
      items: slice,
      total: scenes.length,
      limit,
      offset,
      availability: { scene_count: scenes.length }
    };
  },

  async handleLoadBundle(url) {
    if (!WebFS.rootHandle) throw new Error("No folder selected");
    const parts = url.split('/');
    const datasetId = parts[parts.indexOf('datasets') + 1] || 'web-dataset';
    const split = parts[parts.indexOf('scene') + 1];
    const sceneId = parts[parts.indexOf('scene') + 2];
    const urlObj = new URL(url, 'http://localhost');
    const includeMap = urlObj.searchParams.get('include_map') !== '0';

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
      // Try standard path: {root}/{folder}/{split}/data/{sceneId}.csv
      let path = WebFS.joinPath(WebFS.rootHandle.name, folder, split, 'data', `${sceneId}.csv`);
      let text = await WebFS.readFileText(path);

      // Fallback: {root}/{folder}/{sceneId}.csv
      if (!text) {
        path = WebFS.joinPath(WebFS.rootHandle.name, folder, `${sceneId}.csv`);
        text = await WebFS.readFileText(path);
      }

      if (text) {
        const rows = parseCsv(text);
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
