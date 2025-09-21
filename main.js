// main.js
const { app, BrowserWindow, ipcMain, session, dialog, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const pkg = require('./package.json');

let launcherWin = null;
let quittingApp = false;

const gameWindows = new Map();

const LEGACY_DIRNAME = 'FlyffU Launcher';
const appData = app.getPath('appData');
const legacyUserData = path.join(appData, LEGACY_DIRNAME);

try { fs.mkdirSync(legacyUserData, { recursive: true }); } catch {}
app.setName('FlyffU Launcher');
app.setPath('userData', legacyUserData);

const USER_DATA = app.getPath('userData');
const PROFILES_FILE = path.join(USER_DATA, 'profiles.json');
const PENDING_FILE = path.join(USER_DATA, 'pending_deletes.json');
const TRASH_DIR = path.join(USER_DATA, 'Trash');

// Jobs
const JOBS = [
  'Vagrant',
  'Acrobat',
  'Jester',
  'Ranger',
  'Harlequin',
  'Crackshooter',
  'Assist',
  'Ringmaster',
  'Billposter',
  'Seraph',
  'Force Master',
  'Magician',
  'Psykeeper',
  'Elementor',
  'Mentalist',
  'Arcanist',
  'Mercenary',
  'Blade',
  'Knight',
  'Slayer',
  'Templar'
];
const JOBS_SET = new Set(JOBS);
const DEFAULT_JOB = 'Vagrant';
const JOB_OPTIONS_HTML = JOBS.map(j => `<option value="${j}">${j}</option>`).join('');

// Single-instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    ensureLauncher();
    if (launcherWin && !launcherWin.isDestroyed()) {
      if (launcherWin.isMinimized()) launcherWin.restore();
      launcherWin.show();
      launcherWin.focus();
    }
  });
}

// ---------- Profiles storage helpers ----------

/** @typedef {{name:string, job:string, partition:string, frame?:boolean, isClone?:boolean, winState?:{bounds?:{x?:number,y?:number,width:number,height:number}, isMaximized?:boolean}}} Profile */

function readRawProfiles() {
  try {
    if (!fs.existsSync(PROFILES_FILE)) return [];
    const raw = fs.readFileSync(PROFILES_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function safeProfileName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 40);
}

// Preferred stable partition generator (sanitized)
function partitionFromName(name) {
  return `persist:profile-${String(name || '').replace(/[^a-z0-9-_ ]/gi, '_')}`;
}

/**
 * Legacy/variant partition resolution helpers
 * NOTE: These are STRICT variants of the SAME name (sanitized/encoded/raw), not "Copy" suffixes.
 */
function partitionCandidatesFromName(name) {
  const raw = String(name || '');
  const sanitized = `profile-${raw.replace(/[^a-z0-9-_ ]/gi, '_')}`;
  const encoded = `profile-${encodeURIComponent(raw)}`;
  const rawDirect = `profile-${raw}`;
  const extras = [];
  if (!sanitized.endsWith('_')) extras.push(sanitized + '_');
  if (!encoded.endsWith('_')) extras.push(encoded + '_');
  if (!rawDirect.endsWith('_')) extras.push(rawDirect + '_');
  const uniq = new Set([sanitized, encoded, rawDirect, ...extras]);
  return Array.from(uniq);
}

function partitionDirExists(dirName) {
  try {
    const p = path.join(USER_DATA, 'Partitions', dirName);
    const st = fs.statSync(p);
    return st && st.isDirectory();
  } catch {
    return false;
  }
}

function resolveLegacyPartition(name) {
  const candidates = partitionCandidatesFromName(name);
  for (const cand of candidates) {
    if (partitionDirExists(cand)) {
      return `persist:${cand}`;
    }
  }
  return undefined;
}

function partitionForProfile(p) {
  if (p && typeof p.partition === 'string' && p.partition) return p.partition;
  const legacy = resolveLegacyPartition(p?.name || '');
  if (legacy) return legacy;
  return partitionFromName(p?.name || '');
}

function inferIsCloneFromName(name) {
  return /\bCopy(?:\s+\d+)?$/i.test(String(name || '').trim());
}

function sanitizeWinState(ws) {
  try {
    if (!ws || typeof ws !== 'object') return undefined;
    const isMaximized = !!ws.isMaximized;
    let bounds;
    if (ws.bounds && typeof ws.bounds === 'object') {
      const b = {
        x: (typeof ws.bounds.x === 'number') ? ws.bounds.x : undefined,
        y: (typeof ws.bounds.y === 'number') ? ws.bounds.y : undefined,
        width: Math.max(200, Number(ws.bounds.width) || 0),
        height: Math.max(200, Number(ws.bounds.height) || 0)
      };
      if (b.width && b.height) bounds = b;
    }
    if (!bounds && !isMaximized) return undefined;
    return { bounds, isMaximized };
  } catch {
    return undefined;
  }
}

function normalizeProfiles(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(Boolean)
    .map(item => {
      if (typeof item === 'string') {
        const name = safeProfileName(item);
        return {
          name,
          job: DEFAULT_JOB,
          partition: partitionForProfile({ name }),
          frame: false,
          isClone: inferIsCloneFromName(name),
          winState: undefined
        };
      }
      const name = safeProfileName(item?.name);
      if (!name) return null;
      const jobRaw = (item?.job || '').trim();
      const job = JOBS_SET.has(jobRaw) ? jobRaw : DEFAULT_JOB;
      const partition = (typeof item?.partition === 'string' && item.partition) ? item.partition : partitionForProfile({ name });
      const frame = !!item?.frame;
      const isClone = (typeof item?.isClone === 'boolean') ? item.isClone : inferIsCloneFromName(name);
      const winState = (item && typeof item.winState === 'object') ? sanitizeWinState(item.winState) : undefined;
      return { name, job, partition, frame, isClone, winState };
    })
    .filter(Boolean);
}

/** @returns {Profile[]} */
function readProfiles() {
  return normalizeProfiles(readRawProfiles());
}

function writeProfiles(list) {
  try {
    fs.mkdirSync(path.dirname(PROFILES_FILE), { recursive: true });
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save profiles:', e);
  }
}

function getProfileIndex(list, name) {
  return list.findIndex(p => p.name === name);
}

function getProfileByName(name) {
  const list = readProfiles();
  return list.find(p => p.name === name) || null;
}

function saveProfile(updated) {
  const list = readProfiles();
  const idx = getProfileIndex(list, updated.name);
  if (idx === -1) return false;
  list[idx] = updated;
  writeProfiles(list);
  return true;
}

function patchProfile(name, patch) {
  const list = readProfiles();
  const idx = getProfileIndex(list, name);
  if (idx === -1) return false;
  list[idx] = { ...list[idx], ...patch };
  writeProfiles(list);
  return true;
}

function getActiveProfileNames() {
  const names = [];
  for (const [key, set] of gameWindows.entries()) {
    if (set && set.size > 0) names.push(key);
  }
  return names;
}

function broadcastActiveUpdate() {
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.send('profiles:active-updated', getActiveProfileNames());
  }
  updateGlobalShortcut();
}

function ensureLauncher() {
  if (launcherWin && !launcherWin.isDestroyed()) return;
  createLauncher();
}

function toggleLauncherVisibility() {
  ensureLauncher();
  if (launcherWin.isVisible()) {
    launcherWin.hide();
  } else {
    launcherWin.show();
    launcherWin.focus();
  }
}

/** Only enable Ctrl+Shift+L when there is at least one active session */
function updateGlobalShortcut() {
  globalShortcut.unregister('CommandOrControl+Shift+L');
  if (getActiveProfileNames().length > 0) {
    globalShortcut.register('CommandOrControl+Shift+L', () => {
      toggleLauncherVisibility();
    });
  }
}

// ---------- Partition dir + Retriable delete helpers ----------

function getPartitionDir(partition) {
  const name = String(partition || '').replace(/^persist:/, '');
  return path.join(USER_DATA, 'Partitions', name);
}

function getLegacyPartitionDirsForProfile(p) {
  const name = p?.name || '';
  const cands = partitionCandidatesFromName(name);
  return cands.map(dir => path.join(USER_DATA, 'Partitions', dir));
}

/**
 * Produce a conservative set of folder name candidates that represent the SAME partition
 * string (handles encoded/decoded/underscored + optional trailing underscore variants).
 * We DO NOT derive from display name here to avoid touching other profiles.
 */
function dirBasesFromPartition(partition) {
  const base = String(partition || '').replace(/^persist:/, ''); // e.g. profile-Test_Copy
  const bases = new Set([base]);

  // Try decode -> encode roundtrip
  let decoded = base;
  try { decoded = decodeURIComponent(base); } catch {}
  const encoded = encodeURIComponent(decoded);
  bases.add(decoded);
  bases.add(encoded);

  // Underscore-sanitized from decoded human form
  const underscored = decoded.replace(/[^a-z0-9-_ ]/gi, '_');
  bases.add(underscored);

  // Ensure prefix "profile-" remains; if not, add prefixed versions
  for (const b of Array.from(bases)) {
    if (!/^profile-/.test(b)) bases.add(`profile-${b}`);
  }

  // Add optional trailing underscore variants
  for (const b of Array.from(bases)) {
    if (!b.endsWith('_')) bases.add(b + '_');
  }

  return Array.from(bases);
}

function readPendingDeletes() {
  try {
    if (!fs.existsSync(PENDING_FILE)) return [];
    const raw = fs.readFileSync(PENDING_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writePendingDeletes(list) {
  try {
    fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
    fs.writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write pending deletes:', e);
  }
}

function enqueuePendingDelete(dirPath) {
  const list = readPendingDeletes();
  if (!list.includes(dirPath)) list.push(dirPath);
  writePendingDeletes(list);
}

async function tryRmDirRecursive(dir, attempts = 4, delayMs = 250) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      lastErr = e;
      if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'ENOENT')) {
        await new Promise(r => setTimeout(r, delayMs * Math.pow(2, i)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function safeRemovePartitionDirByPath(dir) {
  try {
    await tryRmDirRecursive(dir);
    return true;
  } catch (e) {
    // Attempt rename to Trash and delete there
    try {
      await fs.promises.mkdir(TRASH_DIR, { recursive: true }).catch(() => {});
      const base = path.basename(dir);
      const tmp = path.join(TRASH_DIR, `${base}-${Date.now()}`);
      await fs.promises.rename(dir, tmp);
      try {
        await tryRmDirRecursive(tmp);
        return true;
      } catch (e2) {
        enqueuePendingDelete(tmp);
        console.error('Queued for later deletion:', tmp, e2);
        return false;
      }
    } catch (eRename) {
      enqueuePendingDelete(dir);
      console.error('Failed renaming partition dir, queued for later deletion:', dir, eRename);
      return false;
    }
  }
}

async function safeRemovePartitionDir(partition, profileObjForLegacySweep) {
  // Primary from explicit partition
  const primary = getPartitionDir(partition);
  let ok = await safeRemovePartitionDirByPath(primary);

  // STRICT legacy dirs for current display name (sanitized/encoded/raw)
  if (profileObjForLegacySweep) {
    const legacyDirs = getLegacyPartitionDirsForProfile(profileObjForLegacySweep);
    for (const dir of legacyDirs) {
      if (dir === primary) continue;
      try {
        const st = await fs.promises.stat(dir).catch(() => null);
        if (st && st.isDirectory()) {
          const res = await safeRemovePartitionDirByPath(dir);
          ok = ok && res;
        }
      } catch {}
    }
  }

  // Partition-derived variants (covers renames where partition stayed on an old naming scheme)
  try {
    const partsRoot = path.join(USER_DATA, 'Partitions');
    const candidates = dirBasesFromPartition(partition);
    for (const base of candidates) {
      const full = path.join(partsRoot, base);
      if (full === primary) continue; // already handled
      try {
        const st = await fs.promises.stat(full);
        if (st && st.isDirectory()) {
          const res = await safeRemovePartitionDirByPath(full);
          ok = ok && res;
        }
      } catch {}
    }
  } catch (e) {
    console.error('Partition-variant sweep failed:', e);
  }

  return ok;
}

async function processPendingDeletes() {
  const list = readPendingDeletes();
  if (list.length === 0) return;
  const remain = [];
  for (const p of list) {
    try {
      await tryRmDirRecursive(p);
    } catch {
      remain.push(p);
    }
  }
  writePendingDeletes(remain);
}

// ---------- Update check helpers ----------

function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'FlyffU-Launcher',
        'Accept': 'application/vnd.github+json',
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode || 0, json });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function normalizeVersion(v) {
  return String(v || '').trim().replace(/^v/i, '');
}

function compareSemver(a, b) {
  const pa = normalizeVersion(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function fetchLatestReleaseTag() {
  const { status, json } = await httpGetJson('https://api.github.com/repos/toffeegg/FlyffU-Launcher/releases/latest');
  if (status !== 200) throw new Error('GitHub API error: ' + status);
  // Prefer tag_name; fallback to name
  return normalizeVersion(json.tag_name || json.name || '');
}

// ---------- UI ----------

function createLauncher() {
  launcherWin = new BrowserWindow({
    width: 900,
    height: 760,
    resizable: false,
    autoHideMenuBar: true,
    show: false,
    icon: 'build-res/icon.png',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  launcherWin.on('close', (e) => {
    if (quittingApp) return;
    if (getActiveProfileNames().length > 0) {
      e.preventDefault();
      launcherWin.hide();
    }
  });

  const jobFilterOptions = `<option value="all">All Jobs</option>${JOB_OPTIONS_HTML}`;

  const html = `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>FlyffU Launcher</title>
  <style>
    :root{
      --bg:#0b0f16; --panel:#0f1522; --panel-2:#0c1220;
      --line:#1c2533; --text:#e6edf3; --sub:#9aa7bd; --accent:#2563eb; --danger:#b91c1c; --ok:#16a34a;
    }
    *{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial}
    html,body{height:100%}
    body{margin:0;background:var(--bg);color:var(--text);display:flex;flex-direction:column}
  
    .top{
      display:flex;align-items:center;gap:8px;
      padding:10px 12px;border-bottom:1px solid var(--line);
      position:sticky;top:0;background:var(--bg);z-index:1000
    }
    .brand{display:flex;align-items:center;gap:8px}
    .muted{color:var(--sub);font-size:11px;line-height:1.25}
  
    .wrap{
      flex:1;display:flex;align-items:center;justify-content:center;
      padding:0px 12px 12px
    }
  
    .card {
      display:flex;
      flex-direction:column;
      width:min(860px, 100vw);
      height:90svh;
      border-radius:0;
    }
    .card-h {
      flex: 0 0 auto;
      padding: 1px 0px 10px 0px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      gap:8px
    }
    .card-h #count {
      margin-left: auto;
    }
    .card-c{
      flex:1;display:flex;flex-direction:column;padding:1px 12px;min-height:0;
    }
  
    .btn {
      border: none;
      padding: 8px 14px;
      margin: 2px 0;
      border-radius: 6px;
      background: #1b2334;
      color: #fff;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      letter-spacing: .3px;
      transition: transform .1s ease, filter .2s ease, background .2s ease;
    }
    
    .btn:hover { filter: brightness(1.15); }
    .btn:active { transform: scale(.97); }
    
    .btn.primary {
      background: linear-gradient(135deg, #2c8ae8, #1f6fc2);
      color: #fff;
      box-shadow: 0 2px 6px rgba(44, 138, 232, 0.35);
    }
   .btn.primary:hover {
      filter: brightness(1.15);
      box-shadow: 0 3px 8px rgba(44, 138, 232, 0.45);
    }
    
    .btn.primary:active {
      transform: scale(.97);
      box-shadow: 0 1px 4px rgba(44, 138, 232, 0.25);
    }
    
    .btn.danger {
      background: linear-gradient(135deg, #c62828, #a91d1d);
      color: #fff;
    }
    
    .btn[disabled] {
      opacity: .5;
      cursor: not-allowed;
    }
    
    input[type="text"], select {
      width: 100%;
      padding: 8px 12px;
      margin: 2px 0;
      border-radius: 6px;
      border: 1px solid #2a3548;
      background: #151c28;
      color: #e0e3ea;
      font-size: 13px;
      transition: border .2s ease, box-shadow .2s ease;
    }
    input[type="text"]:focus, select:focus {
      border-color: #d4af37;
      box-shadow: 0 0 0 2px rgba(212, 175, 55, .25);
      outline: none;
    }

    .list{
      flex:1 1 auto;min-height:0;
      display:flex;flex-direction:column;gap:8px;overflow:auto;margin-top:8px;
      scroll-behavior:smooth;
      padding-right:2px;
    }
  
    .row{
      border:1px solid var(--line);background:var(--panel-2);
      border-radius:8px;padding:10px
    }
    .row-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
	
    .name {
      font-weight: 600;
      font-size: 15px;
      color: #e6efff;
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      letter-spacing: 0.2px;
      transition: color .2s ease;
    }
    .name:hover { color: #2c8ae8; }

    .row-actions{display:flex;gap:6px}
  
    .manage{margin-top:8px;border-top:1px dashed var(--line);padding-top:8px;display:none}
    .manage.show{display:block}
  
    .grid{display:grid;gap:8px}
    .grid.cols-2{grid-template-columns:1fr 1fr}
    .grid.cols-2 > .btn{width:100%}
  
    .empty{
      padding:18px;border:1px dashed #263146;border-radius:8px;
      text-align:center;margin-top:8px;font-size:13px;color:var(--sub)
    }
  
    .create-form{margin-top:8px;display:none}
    .create-form.show{display:block}
  
    .sec-title{font-size:11px;color:var(--sub);margin:6px 0 2px}
    .tag {
      display: inline-block;
      background: rgba(44, 138, 232, 0.08);
      border: 1px solid rgba(44, 138, 232, 0.35);
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 500;
      color: #9fb5d9;
      margin-left: 6px;
      line-height: 1.3;
    }
    .toasts{
      position:fixed;right:12px;bottom:12px;display:flex;flex-direction:column;
      gap:8px;z-index:9999
    }
    .toast {
      background: #0f1624;
      border: 1px solid #1e2a3e;
      border-left: 3px solid #2c8ae8;
      padding: 10px 14px;
      border-radius: 8px;
      min-width: 220px;
      box-shadow: 0 8px 20px rgba(0,0,0,.35);
      opacity: 0;
      transform: translateY(6px);
      transition: opacity .25s ease, transform .25s ease;
    }
    
    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }
    
    .toast .tmsg {
      font-size: 13px;
      font-weight: 500;
      color: #d6e6ff;
      letter-spacing: 0.2px;
    }
  
    .drag-handle{cursor:grab;user-select:none;margin-right:6px;font-size:13px;color:#9aa7bd}
    .row.dragging{opacity:.6}
    .drop-indicator{height:6px;border-radius:6px;background:#233046;margin:6px 0;display:none}
    .drop-indicator.show{display:block}
	
    .update-wrap{ margin-left:auto; display:flex; align-items:center; gap:8px }
    .update-badge{ font-size:10px; color:#9aa7bd }
    .btn.sm{ padding:0px 3px 0px 3px; font-size:10px; border-radius:3px }
    .btn.gold{ background: linear-gradient(135deg, #d4af37, #b88a1e); color:#000; font-weight:700 }	
  
    @media (max-width:860px){
      .grid.cols-2{grid-template-columns:1fr}
      .card{width:100%;height:calc(100svh - 90px)}
    }
  
    .list::-webkit-scrollbar{width:8px}
    .list::-webkit-scrollbar-thumb{background:#1f2633;border-radius:8px}
    .list::-webkit-scrollbar-track{background:transparent}
  </style>

  </head>
  <body>
    <div class="top">
      <div class="brand">
        <div>
          <div class="muted">Multi-profile launcher by Toffee</div>
        </div>
      </div>
      <div class="update-wrap">
        <div class="muted" id="versionLink">
          <a href="#" onclick="require('electron').shell.openExternal('https://github.com/toffeegg/FlyffU-Launcher/releases')" style="color:inherit;text-decoration:none;">
            Version ${pkg.version}
          </a>
        </div>
        <button id="updateBtn" class="btn sm gold" style="display:none"></button>
      </div>
    </div>

    <div class="wrap">
      <section class="card">
        <div class="card-c">
          <div class="muted hint">Tip: Press <strong>Ctrl + Shift + L</strong> to show/hide this launcher while a session is running.</div>

          <div class="card-h" style="margin-top:10px">
            <button id="createBtn" class="btn primary" style="max-height:34px">Create Profile</button>
            <input id="searchInput" type="text" placeholder="Search profile name..." style="max-width:240px">
            <select id="jobFilter" style="max-width:180px;height:34px;padding:0 8px;">${jobFilterOptions}</select>
            <span class="muted" id="count">0</span>
          </div>

          <div id="createForm" class="create-form">
            <div class="sec-title">Profile Name</div>
            <div class="grid cols-2">
              <input id="createName" type="text" placeholder="Profile name (e.g. Main, Alt, FWC)">
              <select id="createJob">${JOB_OPTIONS_HTML}</select>
            </div>
            <div class="grid cols-2" style="margin-top:8px">
              <button id="createAdd" class="btn primary">Add</button>
              <button id="createCancel" class="btn">Cancel</button>
            </div>
          </div>

          <div id="emptyState" class="empty" style="display:none">No profiles yet. Create one to get started.</div>
          <div id="dropAbove" class="drop-indicator"></div>
          <div id="list" class="list"></div>
          <div id="dropBelow" class="drop-indicator"></div>
        </div>
      </section>
    </div>

    <div class="toasts" id="toasts"></div>

    <script>
      const { ipcRenderer, shell } = require('electron');
      let profiles = [];
      let manageOpen = null;
      let actives = [];
      let filterText = '';
      let jobFilter = 'all';
      let draggingName = null;

      const toastsEl = document.getElementById('toasts');
      function showToast(msg) {
        const el = document.createElement('div');
        el.className = 'toast';
        el.innerHTML = '<div class="tmsg"></div>';
        el.querySelector('.tmsg').textContent = msg;
        toastsEl.appendChild(el);
        setTimeout(()=> el.classList.add('show'), 10);
        setTimeout(()=>{
          el.classList.remove('show');
          setTimeout(()=> el.remove(), 200);
        }, 2600);
      }

      async function nativeConfirm(message, detail = '', title = 'Confirm') {
        try {
          const res = await ipcRenderer.invoke('ui:confirm', { message, detail, title });
          return !!(res && res.ok);
        } catch {
          // Fallback (should rarely happen)
          return window.confirm(message);
        }
      }

      // ----- Update check -----
      const updateBtn = document.getElementById('updateBtn');
      (async () => {
        try{
          const res = await ipcRenderer.invoke('app:check-update');
          if (res && res.ok && res.updateAvailable) {
            updateBtn.style.display = '';
            updateBtn.textContent = 'Update Available — ' + res.latest;
            updateBtn.onclick = () => shell.openExternal('https://github.com/toffeegg/FlyffU-Launcher/releases');
            showToast('New version ' + res.latest + ' available.');
          }
        } catch {}
      })();

      const createBtn = document.getElementById('createBtn');
      const createForm = document.getElementById('createForm');
      const createName = document.getElementById('createName');
      const createJob = document.getElementById('createJob');
      const createAdd = document.getElementById('createAdd');
      const createCancel = document.getElementById('createCancel');

      const searchInput = document.getElementById('searchInput');
      const jobFilterEl = document.getElementById('jobFilter');

      // Close expanded profile when toggling Create Profile; also reset job selector
      createBtn.onclick = () => { 
        manageOpen = null;
        document.querySelectorAll('.manage.show').forEach(el => el.classList.remove('show'));
        document.querySelectorAll('.manage-btn').forEach(btn => { btn.textContent = 'Manage'; });
        render();
        createForm.classList.toggle('show'); 
        if (createForm.classList.contains('show')) {
          if (createJob && createJob.options && createJob.options.length) createJob.selectedIndex = 0;
          createName.focus();
        }
      };
      createCancel.onclick = () => {
        createForm.classList.remove('show');
        createName.value = '';
        if (createJob && createJob.options && createJob.options.length) createJob.selectedIndex = 0;
      };

      // Close expanded profile AND collapse create form when typing in Search
      searchInput.addEventListener('input', () => {
        filterText = (searchInput.value || '').trim().toLowerCase();
        if (manageOpen !== null) manageOpen = null;
        createForm.classList.remove('show');
        render();
      });

      // Close expanded profile AND collapse create form when changing Job filter
      jobFilterEl.addEventListener('change', () => {
        jobFilter = (jobFilterEl.value || 'all').trim();
        if (manageOpen !== null) manageOpen = null;
        createForm.classList.remove('show');
        render();
      });

      function isActive(name){ return actives.includes(name); }
      function anySessionOpen(){ return (actives && actives.length > 0); }

      async function addProfile() {
        const val = (createName.value || '').trim();
        const job = (createJob.value || '').trim();
        if (!val) {
          showToast('Please enter a profile name.');
          createName.focus();
          return;
        }
        const res = await ipcRenderer.invoke('profiles:add', { name: val, job });
        if (!res.ok) {
          showToast(res.error || 'Failed to add profile.');
          createName.focus();
          return;
        }
        // Reset inputs after successful create
        createName.value = '';
        if (createJob && createJob.options && createJob.options.length) {
          createJob.selectedIndex = 0; // reset job selector to first option
        }
        createForm.classList.remove('show');
        await refresh();
        showToast('Profile created');
      }
      createAdd.onclick = addProfile;
      createName.addEventListener('keydown', (e) => { 
        if (e.key === 'Enter') {
          e.preventDefault();
          addProfile();
        }
      });

      const listEl = document.getElementById('list');
      const countEl = document.getElementById('count');
      const emptyEl = document.getElementById('emptyState');
      const dropAbove = document.getElementById('dropAbove');
      const dropBelow = document.getElementById('dropBelow');

      function applyFilters(list){
        const ft = filterText;
        const jf = jobFilter;
        return list.filter(p => {
          const byText = !ft || (p.name || '').toLowerCase().includes(ft);
          const byJob = (jf === 'all') || ((p.job || '').trim() === jf);
          return byText && byJob;
        });
      }

      function setUiBusy(busy) {
        try {
          document.body.style.cursor = busy ? 'progress' : '';
          document.body.style.pointerEvents = busy ? 'none' : '';
        } catch {}
      }

      function render() {
        const items = applyFilters(profiles);
        countEl.textContent = String(items.length);
        emptyEl.style.display = items.length ? 'none' : '';
        listEl.innerHTML = '';

        items.forEach(p => {
          const name = p.name;

          const row = document.createElement('div');
          row.className = 'row';
          row.setAttribute('draggable', 'true');
          row.dataset.name = name;

          row.addEventListener('dragstart', (e) => {
            draggingName = name;
            row.classList.add('dragging');
            e.dataTransfer.setData('text/plain', name);
            // Collapse any open manage panel without disrupting drag
            manageOpen = null;
            document.querySelectorAll('.manage.show').forEach(el => el.classList.remove('show'));
            // Make sure any "Close" label goes back to "Manage"
            document.querySelectorAll('.manage-btn').forEach(btn => { btn.textContent = 'Manage'; });
          });
          row.addEventListener('dragend', () => {
            draggingName = null;
            row.classList.remove('dragging');
            dropAbove.classList.remove('show');
            dropBelow.classList.remove('show');
          });
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
            const rect = row.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            if (e.clientY < mid) {
              dropAbove.classList.add('show');
              dropBelow.classList.remove('show');
              listEl.insertBefore(dropAbove, row);
            } else {
              dropBelow.classList.add('show');
              dropAbove.classList.remove('show');
              if (row.nextSibling) {
                listEl.insertBefore(dropBelow, row.nextSibling);
              } else {
                listEl.appendChild(dropBelow);
              }
            }
          });
          row.addEventListener('drop', async (e) => {
            e.preventDefault();
            const from = draggingName;
            const to = name;
            if (!from || from === to) return;
            let order = profiles.map(p => p.name);
            const fromIdx = order.indexOf(from);
            order.splice(fromIdx, 1);
            const targetIdx = order.indexOf(to);
            const insertIdx = dropAbove.classList.contains('show') ? targetIdx : targetIdx + 1;
            order.splice(insertIdx, 0, from);
            const res = await ipcRenderer.invoke('profiles:reorder', order);
            if (!res.ok) return alert(res.error || 'Failed to save order.');
            await refresh();
            showToast('Order saved.');
          });

          const top = document.createElement('div');
          top.className = 'row-top';

          const leftWrap = document.createElement('div');
          leftWrap.style.display = 'flex';
          leftWrap.style.alignItems = 'center';
          leftWrap.style.gap = '8px';

          const dragHandle = document.createElement('div');
          dragHandle.className = 'drag-handle';
          dragHandle.textContent = '≡';

          const nm = document.createElement('div');
          nm.className = 'name';
          const job = (p.job || '').trim();
          const jobTag = job ? ' <span class="tag">'+job+'</span>' : '';
          nm.innerHTML = name + jobTag;

          leftWrap.appendChild(dragHandle);
          leftWrap.appendChild(nm);

          const actions = document.createElement('div');
          actions.className = 'row-actions';

          const manage = document.createElement('button');
          manage.className = 'btn manage-btn';
          manage.dataset.name = name;
          manage.textContent = (manageOpen === name) ? 'Close' : 'Manage';
          if (isActive(name)) {
            manage.disabled = true;
          } else {
            manage.onclick = () => {
              // Collapse create form when clicking Manage
              createForm.classList.remove('show');
              manageOpen = (manageOpen === name) ? null : name;
              render();
            };
          }
          actions.appendChild(manage);

          if (isActive(name)) {
            const quitBtn = document.createElement('button');
            quitBtn.className = 'btn danger';
            quitBtn.textContent = 'Quit';
            quitBtn.onclick = async () => {
              await ipcRenderer.invoke('profiles:quit', name);
            };
            actions.appendChild(quitBtn);
          }

          const play = document.createElement('button');
          play.className = 'btn primary';
          if (isActive(name)) {
            play.textContent = 'Playing';
            play.disabled = true;
          } else {
            play.textContent = 'Play';
            play.onclick = async () => {
              // Collapse manage + create form when clicking Play
              manageOpen = null;
              createForm.classList.remove('show');
              render();
              await ipcRenderer.invoke('profiles:launch', name);
            };
          }
          actions.appendChild(play);

          top.appendChild(leftWrap);
          top.appendChild(actions);
          row.appendChild(top);

          const m = document.createElement('div');
          m.className = 'manage' + (manageOpen === name ? ' show' : '');

          const renameWrap = document.createElement('div');
          renameWrap.className = 'grid cols-2';
          const renameInput = document.createElement('input');
          renameInput.type = 'text';
          renameInput.placeholder = 'Rename profile';
          renameInput.value = name;
          renameWrap.appendChild(renameInput);

          const jobSel = document.createElement('select');
          jobSel.innerHTML = \`${JOB_OPTIONS_HTML}\`;
          jobSel.value = p.job || '${DEFAULT_JOB}';
          renameWrap.appendChild(jobSel);

          const saveRow = document.createElement('div');
          saveRow.className = 'grid cols-2';
          const saveBtn = document.createElement('button');
          saveBtn.className = 'btn';
          saveBtn.textContent = 'Save Changes';
          saveBtn.onclick = async () => {
            const newName = (renameInput.value || '').trim();
            const newJob = (jobSel.value || '').trim();
            if (!newName) return alert('Enter a valid name');
            const res = await ipcRenderer.invoke('profiles:update', { from: name, to: newName, job: newJob });
            if (!res.ok) return alert(res.error || 'Failed to update.');
            manageOpen = newName;
            await refresh();
            showToast('Changes saved.');
          };

          const frameBtn = document.createElement('button');
          frameBtn.className = 'btn';
          frameBtn.textContent = p.frame ? 'Disable Window Frame' : 'Enable Window Frame';
          frameBtn.onclick = async () => {
            const res = await ipcRenderer.invoke('profiles:update', { from: name, to: name, frame: !p.frame, job: jobSel.value });
            if (!res.ok) return alert(res.error || 'Failed to update.');
            await refresh();
            showToast('Window frame ' + (!p.frame ? 'enabled' : 'disabled') + '.');
          };

          saveRow.appendChild(saveBtn);
          saveRow.appendChild(frameBtn);
          m.appendChild(renameWrap);
          m.appendChild(saveRow);

          // Controls row
          const authRow = document.createElement('div');
          authRow.className = 'grid cols-2';

          const clearBtn = document.createElement('button');
          clearBtn.className = 'btn';
          clearBtn.textContent = 'Clear Profile Data';
          clearBtn.onclick = async () => {
            const ok = await nativeConfirm('Clear profile data (cookies, cached files, storage) for "'+name+'"?');
            if (!ok) return;
            const res = await ipcRenderer.invoke('profiles:clear', name);
            if (!res.ok) alert(res.error || 'Failed to clear profile data.');
            else showToast('Profile data cleared.');
          };
          authRow.appendChild(clearBtn);

          const resetWinBtn = document.createElement('button');
          resetWinBtn.className = 'btn';
          resetWinBtn.textContent = 'Reset Saved Window Size/Position';
          const hasWinState = !!(p.winState && (p.winState.isMaximized || (p.winState.bounds && p.winState.bounds.width && p.winState.bounds.height)));
          resetWinBtn.disabled = !hasWinState;
          resetWinBtn.title = hasWinState ? '' : 'No saved window size/position yet';
          resetWinBtn.onclick = async () => {
            const ok = await nativeConfirm('Reset saved window size/position for "'+name+'"?');
            if (!ok) return;
            const res = await ipcRenderer.invoke('profiles:resetWinState', name);
            if (!res.ok) alert(res.error || 'Failed to reset.');
            else {
              await refresh();
              showToast('Saved window size/position reset.');
            }
          };
          authRow.appendChild(resetWinBtn);

          m.appendChild(authRow);

          const dangerWrap = document.createElement('div');
          dangerWrap.className = 'grid cols-2';

          if (p.isClone) {
            const clonedBadge = document.createElement('button');
            clonedBadge.className = 'btn';
            clonedBadge.textContent = 'Cloned Profile';
            clonedBadge.disabled = true;
            dangerWrap.appendChild(clonedBadge);
          } else {
            const cloneBtn = document.createElement('button');
            cloneBtn.className = 'btn';
            cloneBtn.textContent = 'Clone Profile';
            cloneBtn.onclick = async () => {
              const res = await ipcRenderer.invoke('profiles:clone', { name });
              if (!res.ok) return alert(res.error || 'Failed to clone profile.');
              await refresh();
              showToast('Profile cloned.');
            };
            dangerWrap.appendChild(cloneBtn);
          }

          const delBtn = document.createElement('button');
          delBtn.className = 'btn danger';
          delBtn.textContent = 'Delete Profile';
          delBtn.disabled = anySessionOpen();
          delBtn.title = anySessionOpen() ? 'Close all running sessions to delete profiles.' : '';
          delBtn.onclick = async () => {
            if (anySessionOpen()) return;
            const ok = await nativeConfirm('Delete "'+name+'"? This will remove its saved cookies, cached files, storage and fully delete its partition folder(s). The launcher will restart to complete deletion.');
            if (!ok) return;
            setUiBusy(true);
            const res = await ipcRenderer.invoke('profiles:delete', { name, clear: true });
            if (!res.ok) {
              setUiBusy(false);
              return alert(res.error || 'Failed to delete profile.');
            }
            if (!res.restarting) {
              setUiBusy(false);
              await refresh();
              showToast('Profile deleted.');
            }
          };
          dangerWrap.appendChild(delBtn);

          m.appendChild(dangerWrap);

          row.appendChild(m);
          listEl.appendChild(row);
        });
      }

      async function refresh() {
        profiles = await ipcRenderer.invoke('profiles:get');
        actives = await ipcRenderer.invoke('profiles:active');
        render();
      }

      ipcRenderer.on('profiles:updated', refresh);
      ipcRenderer.on('profiles:active-updated', (_e, a) => { actives = a || []; render(); });

      ipcRenderer.on('app:restarted-cleanup-complete', () => {
        showToast('Profile list reloaded.');
      });

      refresh();
    </script>
  </body>
  </html>`;

  launcherWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  launcherWin.once('ready-to-show', () => launcherWin.show());
  launcherWin.on('closed', () => { launcherWin = null; });
}

// ---------- Launch Game (with window state restore/save) ----------

function applyWinStateOptionsFromProfile(profile) {
  // Default: maximize when no saved state exists
  const ws = sanitizeWinState(profile.winState);
  const opts = {};
  let postCreate = (win) => { try { win.maximize(); } catch {} };

  if (ws && ws.bounds) {
    if (typeof ws.bounds.width === 'number') opts.width = ws.bounds.width;
    if (typeof ws.bounds.height === 'number') opts.height = ws.bounds.height;
    if (typeof ws.bounds.x === 'number') opts.x = ws.bounds.x;
    if (typeof ws.bounds.y === 'number') opts.y = ws.bounds.y;
  }

  if (ws) {
    postCreate = ws.isMaximized
      ? (win) => { try { win.maximize(); } catch {} }
      : (_win) => {};
  }

  return { opts, postCreate };
}

function captureCurrentWinState(win) {
  try {
    const isMaximized = !!win.isMaximized();
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    if (!bounds || !bounds.width || !bounds.height) return undefined;
    return {
      bounds: {
        x: typeof bounds.x === 'number' ? bounds.x : undefined,
        y: typeof bounds.y === 'number' ? bounds.y : undefined,
        width: Math.max(200, bounds.width),
        height: Math.max(200, bounds.height)
      },
      isMaximized
    };
  } catch {
    return undefined;
  }
}

function saveWindowStateForProfile(profileName, win) {
  const ws = captureCurrentWinState(win);
  if (!ws) return;
  const list = readProfiles();
  const idx = getProfileIndex(list, profileName);
  if (idx === -1) return;
  list[idx].winState = sanitizeWinState(ws);
  writeProfiles(list);
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.send('profiles:updated');
  }
}

function exitAppNow() {
  try {
    quittingApp = true;
    // force-close all windows without prompts
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.__confirmedClose = true; } catch {}
      try { if (!w.isDestroyed()) w.close(); } catch {}
    }
  } finally {
    app.quit();
  }
}

function launchGameWithProfile(name) {
  const profile = getProfileByName(name);
  if (!profile) return;
  const part = partitionForProfile(profile);
  const url = 'https://universe.flyff.com/play';

  const { opts: winStateOpts, postCreate } = applyWinStateOptionsFromProfile(profile);

  const win = new BrowserWindow({
    width: winStateOpts.width || 1200,
    height: winStateOpts.height || 800,
    x: winStateOpts.x,
    y: winStateOpts.y,
    autoHideMenuBar: true,
    show: false,
    frame: !!profile.frame,
    icon: 'build-res/icon.png',
    webPreferences: {
      backgroundThrottling: false,
      partition: part,
      nativeWindowOpen: true
    }
  });

  win.__profileName = name;

  win.on('close', async (e) => {
    if (win.__confirmedClose) {
      // save window state before final close
      saveWindowStateForProfile(name, win);
      return;
    }
    e.preventDefault();
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Exit Session', 'Exit FlyffU Launcher', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Exit Session',
      message: 'Exit this game session?',
      detail: 'Profile: ' + (win.__profileName || name),
      noLink: true,
      normalizeAccessKeys: true
    });
    if (res.response === 0) {
      // Exit Session
      saveWindowStateForProfile(name, win);
      win.__confirmedClose = true;
      win.close();
    } else if (res.response === 1) {
      // Exit FlyffU Launcher
      saveWindowStateForProfile(name, win);
      exitAppNow();
    }
  });

  // Also save on maximization changes / move / resize (lightweight)
  const debouncedSave = debounce(() => saveWindowStateForProfile(name, win), 300);
  win.on('resize', debouncedSave);
  win.on('move', debouncedSave);
  win.on('maximize', debouncedSave);
  win.on('unmaximize', debouncedSave);

  win.webContents.setWindowOpenHandler(({ url }) => {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: win,
        modal: false,
        autoHideMenuBar: true,
        frame: true,
        width: 900,
        height: 700,
        webPreferences: {
          partition: part,
          backgroundThrottling: false
        }
      }
    };
  });

  win.on('closed', () => {
    const key = win.__profileName || name;
    const s = gameWindows.get(key);
    if (s) {
      s.delete(win);
      if (s.size === 0) gameWindows.delete(key);
    }

    broadcastActiveUpdate();

    if (!quittingApp && getActiveProfileNames().length === 0) {
      ensureLauncher();
      if (launcherWin && !launcherWin.isDestroyed()) {
        launcherWin.show();
        launcherWin.focus();
      }
    }
  });

  // Apply post-create (maximize) if needed
  try { postCreate(win); } catch {}

  win.loadURL(url);
  win.once('ready-to-show', () => win.show());

  if (!gameWindows.has(name)) gameWindows.set(name, new Set());
  const set = gameWindows.get(name);
  set.add(win);
  broadcastActiveUpdate();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Helpers: cookie cloning ----------

async function cloneCookiesBetweenPartitions(srcPartition, dstPartition) {
  try {
    const src = session.fromPartition(srcPartition);
    const dst = session.fromPartition(dstPartition);

    const cookies = await src.cookies.get({});
    const dstExisting = await dst.cookies.get({});
    await Promise.all(
      dstExisting.map(c =>
        dst.cookies.remove(
          `${c.secure ? 'https' : 'http'}://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`,
          c.name
        ).catch(() => {})
      )
    );

    await Promise.all(
      cookies.map(c => {
        const url = `${c.secure ? 'https' : 'http'}://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`;
        const payload = {
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate,
          sameSite: c.sameSite
        };
        return dst.cookies.set(payload).catch(() => {});
      })
    );
  } catch (e) {
    console.error('Cookie clone failed:', e);
  }
}

// ---------- IPC handlers ----------

ipcMain.handle('profiles:get', async () => {
  return readProfiles();
});

ipcMain.handle('profiles:active', async () => {
  return getActiveProfileNames();
});

ipcMain.handle('profiles:add', async (_e, payload) => {
  const list = readProfiles();
  const nameInput = typeof payload === 'string' ? payload : payload?.name;
  const jobInput = typeof payload === 'object' ? (payload?.job || '') : '';

  const name = safeProfileName(nameInput);
  if (!name) return { ok: false, error: 'Please enter a valid name.' };
  if (list.some(p => p.name === name)) return { ok: false, error: 'Name already exists!' };

  const job = JOBS_SET.has((jobInput || '').trim()) ? (jobInput || '').trim() : DEFAULT_JOB;

  const profile = { name, job, partition: partitionForProfile({ name }), frame: true, isClone: false, winState: undefined };
  writeProfiles([...list, profile]);
  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  return { ok: true };
});

// Clone profile: use "Name Copy", "Name Copy 2", ...
ipcMain.handle('profiles:clone', async (_e, { name }) => {
  const list = readProfiles();
  const src = list.find(p => p.name === name);
  if (!src) return { ok: false, error: 'Profile not found' };

  const base = `${src.name} Copy`;
  let newName = base;
  let n = 2;
  while (list.some(p => p.name === newName)) {
    newName = `${base} ${n++}`;
  }

  const targetName = safeProfileName(newName);
  const newPartition = partitionForProfile({ name: targetName });

  const cloned = {
    name: targetName,
    job: src.job || DEFAULT_JOB,
    partition: newPartition,
    frame: !!src.frame,
    isClone: true,
    winState: src.winState ? { ...src.winState } : undefined
  };

  writeProfiles([...list, cloned]);

  try {
    await cloneCookiesBetweenPartitions(partitionForProfile(src), newPartition);
  } catch (e) {
    console.error('Failed to clone profile cookies:', e);
  }

  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  return { ok: true, to: cloned.name };
});

ipcMain.handle('profiles:reorder', async (_e, orderNames) => {
  const list = readProfiles();
  if (!Array.isArray(orderNames) || !orderNames.length) return { ok: false, error: 'Invalid order' };
  const map = new Map(list.map(p => [p.name, p]));
  const next = [];
  for (const nm of orderNames) {
    if (map.has(nm)) {
      next.push(map.get(nm));
      map.delete(nm);
    }
  }
  for (const rest of map.values()) next.push(rest);

  writeProfiles(next);
  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  return { ok: true };
});

ipcMain.handle('profiles:update', async (_e, { from, to, frame, job }) => {
  const list = readProfiles();
  const idx = getProfileIndex(list, from);
  if (idx === -1) return { ok: false, error: 'Profile not found' };

  const newName = safeProfileName(to || from);
  if (!newName) return { ok: false, error: 'Enter a valid name' };
  if (newName !== from && list.some(p => p.name === newName)) return { ok: false, error: 'Target name already exists' };

  if (newName !== from && gameWindows.has(from)) {
    const wins = gameWindows.get(from);
    gameWindows.delete(from);
    gameWindows.set(newName, wins);
    if (wins) {
      for (const w of wins) {
        try { w.__profileName = newName; } catch {}
      }
    }
  }

  const oldPartition = list[idx].partition || partitionForProfile(list[idx]);
  const wasClone = typeof list[idx].isClone === 'boolean' ? list[idx].isClone : inferIsCloneFromName(list[idx].name);
  const nextJob = JOBS_SET.has((job || '').trim()) ? (job || '').trim() : (list[idx].job || DEFAULT_JOB);

  list[idx].name = newName;
  list[idx].partition = oldPartition;
  list[idx].frame = (typeof frame === 'boolean') ? frame : !!list[idx].frame;
  list[idx].isClone = wasClone;
  list[idx].job = nextJob;
  // Keep existing winState as-is

  writeProfiles(list);

  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  broadcastActiveUpdate();
  return { ok: true };
});

ipcMain.handle('profiles:rename', async (_e, { from, to }) => {
  const list = readProfiles();
  const idx = getProfileIndex(list, from);
  if (idx === -1) return { ok: false, error: 'Profile not found' };

  const newName = safeProfileName(to);
  if (!newName) return { ok: false, error: 'Enter a valid name' };
  if (list.some(p => p.name === newName)) return { ok: false, error: 'Target name already exists' };

  if (gameWindows.has(from)) {
    const wins = gameWindows.get(from);
    gameWindows.delete(from);
    gameWindows.set(newName, wins);
    if (wins) {
      for (const w of wins) {
        try { w.__profileName = newName; } catch {}
      }
    }
  }

  const oldPartition = list[idx].partition || partitionForProfile(list[idx]);
  const wasClone = typeof list[idx].isClone === 'boolean' ? list[idx].isClone : inferIsCloneFromName(list[idx].name);

  list[idx].name = newName;
  list[idx].partition = oldPartition;
  list[idx].isClone = wasClone;
  // winState carried forward

  writeProfiles(list);

  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  broadcastActiveUpdate();
  return { ok: true };
});

// Reset saved window size/position
ipcMain.handle('profiles:resetWinState', async (_e, name) => {
  const list = readProfiles();
  const idx = getProfileIndex(list, name);
  if (idx === -1) return { ok: false, error: 'Profile not found' };
  list[idx].winState = undefined;
  writeProfiles(list);
  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  return { ok: true };
});

// DELETE PROFILE with restart to complete full folder deletion
// (STRICT by partition; also removes partition-derived folder name variants)
ipcMain.handle('profiles:delete', async (_e, { name, clear }) => {
  const list = readProfiles();
  const p = list.find(x => x.name === name);
  if (!p) return { ok: false, error: 'Profile not found' };
  const part = partitionForProfile(p);

  // Close any open windows for this profile (force-close without prompt)
  if (gameWindows.has(name)) {
    for (const w of gameWindows.get(name)) {
      try {
        w.__confirmedClose = true;
        if (!w.isDestroyed()) w.close();
      } catch {}
    }
    gameWindows.delete(name);
  }

  // Remove from profiles.json
  const next = list.filter(x => x.name !== name);
  writeProfiles(next);

  let requiresRestart = false;

  // If no other profile shares this partition, nuke its data and directories
  const remainingRefs = next.filter(x => (x.partition || partitionForProfile(x)) === part).length;

  if (clear && remainingRefs === 0) {
    try {
      const s = session.fromPartition(part);
      await s.clearStorageData({
        storages: [
          'cookies',
          'localstorage',
          'filesystem',
          'serviceworkers',
          'cachestorage',
          'indexeddb',
          'websql'
        ]
      });
      if (typeof s.flushStorageData === 'function') {
        try { s.flushStorageData(); } catch {}
      }
      await s.clearCache().catch(() => {});
    } catch (e) {
      console.error('Failed clearing storage for', name, e);
    }

    // Queue deletion for primary, strict legacy, and partition-derived variants
    const primaryDir = getPartitionDir(part);
    enqueuePendingDelete(primaryDir);
    const legacyDirs = getLegacyPartitionDirsForProfile(p);
    for (const dir of legacyDirs) enqueuePendingDelete(dir);

    try {
      const partsRoot = path.join(USER_DATA, 'Partitions');
      for (const base of dirBasesFromPartition(part)) {
        const full = path.join(partsRoot, base);
        enqueuePendingDelete(full);
      }
    } catch (e) {
      console.error('Enqueue partition-variant dirs failed:', e);
    }

    requiresRestart = true;
  }

  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  broadcastActiveUpdate();

  if (requiresRestart) {
    app.relaunch();
    app.exit(0);
    return { ok: true, restarting: true };
  }

  return { ok: true, restarting: false };
});

ipcMain.handle('profiles:clear', async (_e, name) => {
  const p = getProfileByName(name);
  if (!p) return { ok: false, error: 'Profile not found' };
  try {
    const s = session.fromPartition(partitionForProfile(p));
    await s.clearStorageData({
      storages: [
        'cookies',
        'localstorage',
        'filesystem',
        'serviceworkers',
        'cachestorage',
        'indexeddb',
        'websql'
      ]
    });
    if (typeof s.flushStorageData === 'function') {
      try { s.flushStorageData(); } catch {}
    }
    await s.clearCache().catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Failed to clear profile data.' };
  }
});

ipcMain.handle('profiles:launch', async (_e, name) => {
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.hide();
  }
  launchGameWithProfile(name);
  return { ok: true };
});

ipcMain.handle('profiles:quit', async (_e, name) => {
  if (gameWindows.has(name)) {
    for (const w of gameWindows.get(name)) {
      try { if (!w.isDestroyed()) w.close(); } catch {}
    }
  }
  return { ok: true };
});

ipcMain.handle('app:check-update', async () => {
  try {
    const latest = await fetchLatestReleaseTag();
    const current = normalizeVersion(pkg.version);
    const updateAvailable = compareSemver(latest, current) === 1;
    return { ok: true, latest, current, updateAvailable };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('app:quit', () => {
  quittingApp = true;
  exitAppNow();
});

ipcMain.handle('ui:confirm', async (_e, { message, detail, title, yesLabel, noLabel }) => {
  const parent = (launcherWin && !launcherWin.isDestroyed()) ? launcherWin : BrowserWindow.getFocusedWindow();
  const buttons = [yesLabel || 'Yes', noLabel || 'No'];
  const res = await dialog.showMessageBox(parent, {
    type: 'question',
    buttons,
    defaultId: 0,
    cancelId: 1,
    title: title || 'Confirm',
    message: String(message || 'Are you sure?'),
    detail: detail ? String(detail) : undefined,
    normalizeAccessKeys: true,
    noLink: true
  });
  return { ok: res.response === 0 };
});

// ---------- App lifecycle ----------

app.on('ready', async () => {
  if (!fs.existsSync(PROFILES_FILE)) writeProfiles([]);
  // Normalize and migrate partitions (detect strict legacy dirs) on startup
  writeProfiles(readProfiles());

  // Process any queued deletions BEFORE creating windows/sessions to avoid locks
  await processPendingDeletes().catch(() => {});

  createLauncher();
  updateGlobalShortcut();

  // Optional notify renderer
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.send('app:restarted-cleanup-complete');
  }
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  await processPendingDeletes().catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!launcherWin) createLauncher();
  launcherWin.show();
});
