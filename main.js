// main.js
const { app, BrowserWindow, ipcMain, session, dialog, globalShortcut, shell, nativeImage } = require('electron');
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
const SETTINGS_FILE = path.join(USER_DATA, 'settings.json');

// Screenshots dir (Pictures/FlyffU Launcher Screenshots)
const SHOTS_DIR = path.join(app.getPath('pictures'), 'FlyffU Launcher Screenshots');
try { fs.mkdirSync(SHOTS_DIR, { recursive: true }); } catch {}

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

// ---------- Settings ----------
function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { stayOpenAfterLaunch: false };
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const json = JSON.parse(raw);
    return {
      stayOpenAfterLaunch: (typeof json.stayOpenAfterLaunch === 'boolean') ? json.stayOpenAfterLaunch : false
    };
  } catch {
    return { stayOpenAfterLaunch: false };
  }
}
function writeSettings(s) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch {}
}
let settings = readSettings();

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

/** @typedef {{name:string, job:string, partition:string, frame?:boolean, isClone?:boolean, winState?:{bounds?:{x?:number,y?:number,width:number,height:number}, isMaximized?:boolean}, muted?:boolean}} Profile */

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
      return { name, job, partition, frame, isClone, winState, muted: !!item?.muted };
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
  if (!launcherWin) return;

  const shouldShow = !launcherWin.isVisible() || !launcherWin.isFocused();

  if (shouldShow) {
    launcherWin.show();
    launcherWin.focus();
  } else {
    launcherWin.hide();
  }
}

// Inside updateGlobalShortcut(), fully updated with audio sync

function updateGlobalShortcut() {
  globalShortcut.unregister('CommandOrControl+Shift+L');
  globalShortcut.unregister('CommandOrControl+Shift+M');
  globalShortcut.unregister('CommandOrControl+Shift+P');
  globalShortcut.unregister('Control+Tab');
  globalShortcut.unregister('Control+Shift+Tab');

  if (getActiveProfileNames().length > 0) {
    // Toggle launcher visibility
    globalShortcut.register('CommandOrControl+Shift+L', () => {
      toggleLauncherVisibility();
    });

    // Mute/unmute current session
    globalShortcut.register('CommandOrControl+Shift+M', async () => {
      try {
        let target = BrowserWindow.getFocusedWindow();
        let profileName = null;

        if (target) {
          for (const [name, set] of gameWindows.entries()) {
            if (set && set.has(target)) { profileName = name; break; }
          }
        }

        if (!profileName) {
          const all = [];
          for (const [name, set] of gameWindows.entries()) {
            for (const w of set) all.push({ name, w });
          }
          if (all.length) profileName = all[all.length - 1].name;
        }

        if (profileName) {
          const wins = getAllGameWindowsForProfile(profileName);
          if (!wins.length) return;

          const currentlyMuted = wins.every(w => w.webContents.isAudioMuted());
          const next = !currentlyMuted;
          for (const w of wins) {
            try { w.webContents.setAudioMuted(next); } catch {}
          }

          const msg = next ? 'Session muted.' : 'Session unmuted.';
          for (const w of wins) {
            try { await showToastInWindow(w, msg); } catch {}
          }

          if (launcherWin && !launcherWin.isDestroyed()) {
            launcherWin.webContents.send('profiles:audio-updated', { name: profileName, muted: next });
          }
        }
      } catch (e) {
        console.error('Mute shortcut failed:', e);
      }
    });

    // Screenshot of focused session
    globalShortcut.register('CommandOrControl+Shift+P', async () => {
      try { await captureScreenshotOfFocusedSession(); } catch {}
    });

    // --- Session switching (Ctrl+Tab / Ctrl+Shift+Tab) ---
    function cycleSession(dir = 1) {
      const all = [];
      for (const [, set] of gameWindows.entries()) {
        for (const w of set) {
          if (w && !w.isDestroyed()) all.push(w);
        }
      }
      if (all.length < 2) return;

      const focused = BrowserWindow.getFocusedWindow();

      if (!focused || focused === launcherWin) return;

      const idx = all.findIndex(w => w === focused);
      if (idx === -1) return;

      let nextIdx = (idx + dir + all.length) % all.length;
      const nextWin = all[nextIdx];
      if (nextWin && !nextWin.isDestroyed()) {
        try {
          nextWin.show();
          nextWin.focus();
        } catch (e) {
          console.error('Focus failed:', e);
        }
      }
    }

    globalShortcut.register('Control+Tab', () => cycleSession(1));
    globalShortcut.register('Control+Shift+Tab', () => cycleSession(-1));
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

  let decoded = base;
  try { decoded = decodeURIComponent(base); } catch {}
  const encoded = encodeURIComponent(decoded);
  bases.add(decoded);
  bases.add(encoded);

  const underscored = decoded.replace(/[^a-z0-9-_ ]/gi, '_');
  bases.add(underscored);

  for (const b of Array.from(bases)) {
    if (!/^profile-/.test(b)) bases.add(`profile-${b}`);
  }

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
  const primary = getPartitionDir(partition);
  let ok = await safeRemovePartitionDirByPath(primary);

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

  try {
    const partsRoot = path.join(USER_DATA, 'Partitions');
    const candidates = dirBasesFromPartition(partition);
    for (const base of candidates) {
      const full = path.join(partsRoot, base);
      if (full === primary) continue;
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

// ---------- Update check + News/Tools helpers ----------

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

function httpGetText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'FlyffU-Launcher',
        'Accept': 'text/html,application/xhtml+xml',
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(data));
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
  return normalizeVersion(json.tag_name || json.name || '');
}

// ---------- Screenshots & Audio helpers ----------

function getAllGameWindowsForProfile(name) {
  const set = gameWindows.get(name);
  if (!set) return [];
  return Array.from(set).filter(w => w && !w.isDestroyed());
}

async function captureScreenshotOfFocusedSession() {
  try {
    let target = BrowserWindow.getFocusedWindow();

    let isGame = false;
    if (target) {
      for (const [, set] of gameWindows.entries()) {
        if (set && set.has(target)) { isGame = true; break; }
      }
    }

    if (!isGame) {
      const all = [];
      for (const [, set] of gameWindows.entries()) {
        for (const w of set) all.push(w);
      }
      target = all[all.length - 1];
    }

    if (!target || target.isDestroyed()) return;

    const image = await target.capturePage();
    if (!image || image.isEmpty?.()) {
      try { await showToastInWindow?.(target, 'Screenshot failed (empty image).'); } catch {}
      if (launcherWin && !launcherWin.isDestroyed()) {
        launcherWin.webContents.send('shots:done', { error: 'empty_image' });
      }
      return;
    }

    try { await fs.promises.mkdir(SHOTS_DIR, { recursive: true }); } catch {}

    const ts = new Date();
    const pad = n => String(n).padStart(2, '0');
    const filename = `FlyffU_${ts.getFullYear()}-${pad(ts.getMonth()+1)}-${pad(ts.getDate())}_${pad(ts.getHours())}-${pad(ts.getMinutes())}-${pad(ts.getSeconds())}.png`;
    const out = path.join(SHOTS_DIR, filename);

    const pngBuffer = image.toPNG();
    await fs.promises.writeFile(out, pngBuffer);

    try { await showToastInWindow?.(target, 'Screenshot saved.'); } catch {}

    if (launcherWin && !launcherWin.isDestroyed()) {
      launcherWin.webContents.send('shots:done', { file: out });
    }

    return out;
  } catch (e) {
    console.error('Screenshot failed:', e);
    if (launcherWin && !launcherWin.isDestroyed()) {
      launcherWin.webContents.send('shots:done', { error: String(e && e.message || e) });
    }
  }
}

async function showToastInWindow(win, message = 'Screenshot saved.') {
  if (!win || win.isDestroyed()) return;
  const js = `
    (function(){
      try {
        const id = '__flyffu_toast_styles__';
        if (!document.getElementById(id)) {
          const st = document.createElement('style');
          st.id = id;
          st.textContent = \`
            @keyframes flyffu-toast-in { from {opacity:0; transform: translateY(6px)} to {opacity:1; transform:none} }
            @keyframes flyffu-toast-out { to {opacity:0; transform: translateY(6px)} }
            .flyffu-toast-wrap {
              position: fixed;
              right: 12px;
              bottom: 12px;
              z-index: 2147483647;
              display: flex;
              flex-direction: column;
              gap: 8px;
              pointer-events: none;
            }
            .flyffu-toast {
              background: rgba(15,22,36,.96);
              border: 1px solid #1e2a3e;
              border-left: 3px solid #2c8ae8;
              padding: 10px 14px;
              border-radius: 8px;
              max-width: 150px;
              color: #d6e6ff;
              font: 500 13px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Arial;
              box-shadow: 0 8px 20px rgba(0,0,0,.35);
              animation: flyffu-toast-in .22s ease forwards;
			  margin: 10px 10px -2px 10px;
            }
            .flyffu-toast.hide { animation: flyffu-toast-out .22s ease forwards }
          \`;
          document.head.appendChild(st);
        }
        let wrap = document.querySelector('.flyffu-toast-wrap');
        if (!wrap) {
          wrap = document.createElement('div');
          wrap.className = 'flyffu-toast-wrap';
          document.body.appendChild(wrap);
        }
        const el = document.createElement('div');
        el.className = 'flyffu-toast';
        el.textContent = ${JSON.stringify(message)};
        wrap.appendChild(el);
        setTimeout(() => { el.classList.add('hide'); }, 2200);
        setTimeout(() => { el.remove(); if (wrap && !wrap.children.length) wrap.remove(); }, 2600);
      } catch(e) {}
    })();
  `;
  try { await win.webContents.executeJavaScript(js, true); } catch {}
}

// ---------- UI ----------

function createLauncher() {
  launcherWin = new BrowserWindow({
    width: 1000,
    height: 760,
    resizable: false,
    autoHideMenuBar: true,
    show: false,
    icon: 'icon.png',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  launcherWin.on('close', (e) => {
    if (quittingApp) return;
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && focused !== launcherWin) return;

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
      padding:2px 8px 2px 8px;border-bottom:1px solid var(--line);
      position:sticky;top:0;background:var(--bg);z-index:1000
    }
    .menubar{display:flex;align-items:center;gap:8px}
    .menu-item{font-size:12px;color:#d7e2f1;padding:4px 6px;cursor:pointer;user-select:none}
    .menu-item:hover{background:#111829}
    .menu-dropdown{
      position:absolute;
      background:#0f1624;
      padding:6px;
      min-width:180px;
      display:flex;
      flex-direction:column;
      gap:2px;
      border-radius:8px;
      border:1px solid var(--line);
      box-shadow:0 10px 24px rgba(0,0,0,.4);
      opacity:0;
      transform:translateY(-6px) scale(0.98);
      pointer-events:none;
      visibility:hidden;
      transition:
        opacity .15s ease,
        transform .15s ease,
        visibility 0s linear .15s;
    }
    .menu-dropdown.show{
      opacity:1;
      transform:none;
      pointer-events:auto;
      visibility:visible;
      transition:
        opacity .16s ease,
        transform .16s ease,
        visibility 0s;
    }

    .menu-btn {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      text-align: left;
      padding: 8px 14px;
      margin: 2px 0;
      border: none;
      border-radius: 0px;
      background: #0f1624;
      color: #fff;         
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      letter-spacing: .3px;
      transition: transform .1s ease, 
      filter .2s ease, 
      background .2s ease;
    }
    .menu-btn:hover { 
      filter: brightness(1.25);
      border-radius: 6px;
    }
    .menu-sep{height:1px;background:#22304a;margin:4px 6px}
	
    .update-wrap{ margin-left:auto; display:flex; align-items:center; gap:8px }
    .btn.sm{ padding:0px 3px 0px 3px; font-size:10px; border-radius:3px }
    .btn.gold {
    background: linear-gradient(135deg, #d4af37, #b88a1e);
    color: #000;
    font-weight: 700;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    box-sizing: border-box;
    animation: glow 1.5s infinite alternate;
	}
	
	@keyframes glow {
	  from {
	    box-shadow: 0 0 5px 2px #d4af37;
	  }
	  to {
	    box-shadow: 0 0 15px 4px #ffd700;
	  }
	}

	.muted{color:var(--sub);font-size:12px;line-height:1.25;margin-right:5px}

    .wrap{
      flex:1;display:flex;align-items:stretch;justify-content:center;
      padding:0 12px 0 3px
    }

    .content{
      width:min(1000px, 100vw);
      display:grid;
      grid-template-columns: 7fr 3fr;
      gap:12px;
      height:94svh;
    }

    .card { display:flex; flex-direction:column; border-radius:0; background:transparent; min-height:0; }
    .card-h { flex:0 0 auto; padding:1px 0px 10px 0px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:8px }
    .card-h #count { margin-left:auto; }
    .card-c{ flex:1; display:flex; flex-direction:column; padding:1px 12px; min-height:0; }

    .news{ border:1px solid var(--line); margin-top:10px; margin-left:-10px; background:var(--panel-2); border-radius:10px; display:flex; flex-direction:column; min-height:0; overflow:hidden; }
    .news-h{ padding:10px 12px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;flex:0 0 auto }
    .news-title{font-size:14px;font-weight:600}
    .news-c{ padding:10px 12px; display:flex; flex-direction:column; gap:8px; flex:1 1 auto; min-height:0; overflow:auto; }
	.news-c::-webkit-scrollbar{width:8px}
    .news-c::-webkit-scrollbar-thumb{background:#1f2633;border-radius:8px}
    .news-c::-webkit-scrollbar-track{background:transparent}
    .news-item{ padding:9px 10px;border:1px solid #1e2a3e;border-radius:8px;background:#0f1624 }
    .news-item a{color:#8fbaff;text-decoration:none}
    .news-item a:hover{text-decoration:underline}
    .news-item .nt{font-size:13px;font-weight:600;color:#d6e6ff}
    .news-item .ns{font-size:11px;color:#9aa7bd;margin-top:2px}
	.news-item:hover { background: var(--panel-5); }
    .news-empty{ padding:18px;border:1px dashed #263146;border-radius:8px; text-align:center;font-size:13px;color:var(--sub) }

    .btn { border:none; padding:8px 14px; margin:2px 0; border-radius:6px; background:#1b2334; color:#fff; cursor:pointer; font-size:13px; font-weight:500; letter-spacing:.3px; transition: transform .1s ease, filter .2s ease, background .2s ease; }
    .btn:hover { filter: brightness(1.15); }
    .btn:active { transform: scale(.97); }
    .btn.primary { background: linear-gradient(135deg, #2c8ae8, #1f6fc2); color:#fff; box-shadow:0 2px 6px rgba(44, 138, 232, 0.35); }
    .btn.primary:hover { filter: brightness(1.15); box-shadow:0 3px 8px rgba(44, 138, 232, 0.45); }
    .btn.primary:active { transform: scale(.97); box-shadow:0 1px 4px rgba(44, 138, 232, 0.25); }
    .btn.danger { background: linear-gradient(135deg, #c62828, #a91d1d); color:#fff; }
    .btn[disabled] { opacity:.5; cursor:not-allowed; }

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

    .list{ flex:1 1 auto; min-height:0; display:flex; flex-direction:column; gap:8px; overflow:auto; margin-top:8px; scroll-behavior:smooth; padding-right:8px; margin-right:0; }
    .row{ border:1px solid var(--line); background:var(--panel-2); border-radius:8px; padding:10px }
	.row:hover { background: var(--panel-5); }
	.row:hover .name { color: #2c8ae8; }
    .row-top{ display:flex; align-items:center; justify-content:space-between; gap:8px }
    .name { font-weight:600; font-size:15px; color:#e6efff; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; letter-spacing:.2px; transition: color .2s ease; }
    .row-actions{display:flex;gap:6px}
    .manage{margin-top:8px;border-top:1px dashed var(--line);padding-top:8px;display:none}
    .manage.show{display:block}
    .grid{display:grid;gap:8px}
    .grid.cols-2{grid-template-columns:1fr 1fr}
    .grid.cols-2 > .btn{width:100%}
    .empty{ padding:18px;border:1px dashed #263146;border-radius:8px; text-align:center;margin-top:8px;font-size:13px;color:var(--sub) }
    .create-form{margin-top:8px;display:none}
    .create-form.show{display:block}
    .sec-title{font-size:11px;color:var(--sub);margin:6px 0 2px}
    .tag { display:inline-block; background: rgba(44, 138, 232, 0.08); border: 1px solid rgba(44, 138, 232, 0.35); border-radius:999px; padding:3px 8px; font-size:11px; font-weight:500; color:#9fb5d9; margin-left:6px; line-height:1.3; }
    .toasts{ position:fixed;right:12px;bottom:12px;display:flex;flex-direction:column; gap:8px; z-index:9999 }
    .toast { background:#0f1624; border:1px solid #1e2a3e; border-left:3px solid #2c8ae8; padding:10px 14px; border-radius:8px; min-width:220px; box-shadow:0 8px 20px rgba(0,0,0,.35); opacity:0; transform: translateY(6px); transition: opacity .25s ease, transform .25s ease; }
    .toast.show { opacity:1; transform: translateY(0); }
    .toast .tmsg { font-size:13px; font-weight:500; color:#d6e6ff; letter-spacing:.2px; }
    .drag-handle{cursor:grab;user-select:none;margin-right:6px;font-size:13px;color:#9aa7bd}
    .row.dragging{opacity:.6}
    .drop-indicator{height:6px;border-radius:6px;background:#233046;margin:6px 0;display:none}
    .drop-indicator.show{display:block}

    @media (max-width:880px){ .content{grid-template-columns:1fr} }
    .list::-webkit-scrollbar{width:8px}
    .list::-webkit-scrollbar-thumb{background:#1f2633;border-radius:8px}
    .list::-webkit-scrollbar-track{background:transparent}

    .tips { border:1px solid var(--line); background:var(--panel-2); border-radius:8px; padding:10px; margin-top:12px; font-size:13px; color:var(--sub); }
    .tips-title { font-weight:600; color:var(--text); margin-bottom:6px; }
    .tips-content { margin-bottom:8px; line-height:1.4; }

  </style>

  </head>
  <body>
    <div class="top">
      <div class="menubar">
        <div class="menu-item" id="menuOptions">Options</div>
        <div class="menu-item" id="menuTools">Tools</div>
        <div class="menu-item" id="menuHelp">Help</div>

        <!-- Options dropdown -->
        <div class="menu-dropdown" id="dropOptions">
          <button class="menu-btn" id="optImport">Import profiles.json</button>
          <button class="menu-btn" id="optExport">Export profiles.json</button>
          <div class="menu-sep"></div>
          <button class="menu-btn" id="optScreenshots">Open Screenshots folder</button>
          <div class="menu-sep"></div>
          <button class="menu-btn" id="optStayOpen">Stay Open After Launch</button>
        </div>

        <!-- Tools dropdown -->
        <div class="menu-dropdown" id="dropTools"></div>

        <!-- Help dropdown -->
        <div class="menu-dropdown" id="dropHelp">
          <button class="menu-btn" id="helpShortcuts">Shortcuts</button>
          <button class="menu-btn" id="helpAbout">About</button>
        </div>
      </div>

      <div class="update-wrap" style="margin-left:auto">
	    <button id="updateBtn" class="btn sm gold" style="display:none"></button>
        <div class="muted" id="versionLink">
          <a href="#" onclick="require('electron').shell.openExternal('https://github.com/toffeegg/FlyffU-Launcher/releases')" style="color:inherit;text-decoration:none;">
            Version ${pkg.version}
          </a>
        </div>
      </div>
    </div>

    <div class="wrap">
      <div class="content">
        <!-- LEFT: Profiles (70%) -->
        <section class="card">
          <div class="card-c">

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
			
			<div id="tipsBox" class="tips">
			<div class="tips-title">💡 Tip</div>
			<div id="tipsContent" class="tips-content"></div>
			</div>

          </div>
        </section>

        <!-- RIGHT: News (30%) -->
        <aside class="news">
          <div class="news-h">
            <div class="news-title">Flyff Universe Newsfeed</div>
          </div>
          <div id="newsContainer" class="news-c">
            <div class="news-empty">Loading…</div>
          </div>
        </aside>
      </div>
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
      let audioStates = {};
      let stayOpenAfterLaunch = false;

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
          return window.confirm(message);
        }
      }

      function showShortcutsDialog(){
        return ipcRenderer.invoke('ui:shortcuts');
      }

      const menuOptions = document.getElementById('menuOptions');
      const menuTools = document.getElementById('menuTools');
      const menuHelp = document.getElementById('menuHelp');
      const dropOptions = document.getElementById('dropOptions');
      const dropTools = document.getElementById('dropTools');
      const dropHelp = document.getElementById('dropHelp');

      let menuMode = false;
      let activeMenu = null;
      let toolsLoaded = false;

      function positionDropdown(anchorEl, dropdownEl){
        const rect = anchorEl.getBoundingClientRect();
        dropdownEl.style.left = rect.left + 'px';
        dropdownEl.style.top = (rect.bottom + 4) + 'px';
      }

      function closeAllMenus() {
        dropOptions.classList.remove('show');
        dropTools.classList.remove('show');
        dropHelp.classList.remove('show');
        activeMenu = null;
      }

      async function ensureToolsItems() {
        if (toolsLoaded) return;
        const items = await ipcRenderer.invoke('tools:list');
        dropTools.innerHTML = '';
        items.forEach(it => {
          const btn = document.createElement('button');
          btn.className = 'menu-btn';
          btn.textContent = it.title;
          btn.addEventListener('click', () => {
            shell.openExternal(it.link);
            closeAllMenus();
            menuMode = false;
          });
          dropTools.appendChild(btn);
        });
        toolsLoaded = true;
      }

      async function openMenu(key){
        if (key === 'options') {
          positionDropdown(menuOptions, dropOptions);
          dropOptions.classList.add('show');
          dropTools.classList.remove('show');
          dropHelp.classList.remove('show');
          activeMenu = 'options';
        } else if (key === 'tools') {
          positionDropdown(menuTools, dropTools);
          dropTools.classList.add('show');
          dropOptions.classList.remove('show');
          dropHelp.classList.remove('show');
          activeMenu = 'tools';
          ensureToolsItems();
        } else if (key === 'help') {
          positionDropdown(menuHelp, dropHelp);
          dropHelp.classList.add('show');
          dropOptions.classList.remove('show');
          dropTools.classList.remove('show');
          activeMenu = 'help';
        }
      }

      document.addEventListener('click', (e) => {
        const withinMenu = e.target.closest('.menu-item') || e.target.closest('.menu-dropdown');
        if (!withinMenu) {
          closeAllMenus();
          menuMode = false;
        }
      });
	  
	  window.addEventListener('blur', () => {
        closeAllMenus();
        menuMode = false;
      });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          closeAllMenus();
          menuMode = false;
        }
      });

      menuOptions.addEventListener('click', () => {
        if (menuMode && activeMenu === 'options') {
          closeAllMenus();
          menuMode = false;
        } else {
          menuMode = true;
          openMenu('options');
        }
      });

      menuTools.addEventListener('click', () => {
        if (menuMode && activeMenu === 'tools') {
          closeAllMenus();
          menuMode = false;
        } else {
          menuMode = true;
          openMenu('tools');
        }
      });

      menuHelp.addEventListener('click', () => {
        if (menuMode && activeMenu === 'help') {
          closeAllMenus();
          menuMode = false;
        } else {
          menuMode = true;
          openMenu('help');
        }
      });

      menuOptions.addEventListener('mouseenter', () => { if (menuMode) openMenu('options'); });
      menuTools.addEventListener('mouseenter', () => { if (menuMode) openMenu('tools'); });
      menuHelp.addEventListener('mouseenter', () => { if (menuMode) openMenu('help'); });

      document.getElementById('helpAbout').onclick = async () => {
        closeAllMenus();
        menuMode = false;
        await ipcRenderer.invoke('ui:about');
      };
      document.getElementById('helpShortcuts').onclick = async () => {
        closeAllMenus();
        menuMode = false;
        await showShortcutsDialog();
      };

      document.getElementById('optImport').onclick = async () => {
        closeAllMenus();
        menuMode = false;
        const res = await ipcRenderer.invoke('profiles:import');
        if (res && res.ok) {
          await refresh();
          showToast('Profiles imported.');
        } else if (res && res.error) {
          alert(res.error);
        }
      };
      document.getElementById('optExport').onclick = async () => {
        closeAllMenus();
        menuMode = false;
        const res = await ipcRenderer.invoke('profiles:export');
        if (res && res.ok) showToast('Profiles exported.');
        else if (res && res.error) alert(res.error);
      };
      document.getElementById('optScreenshots').onclick = async () => {
        closeAllMenus();
        menuMode = false;
        await ipcRenderer.invoke('shots:open-folder');
      };

      const optStayOpen = document.getElementById('optStayOpen');
      function updateStayOpenLabel() {
        if (optStayOpen) {
          optStayOpen.textContent = stayOpenAfterLaunch
            ? 'Hide Launcher After Launch'
            : 'Stay Open After Launch';
        }
      }
      (async () => {
        try {
          const s = await ipcRenderer.invoke('settings:get');
          stayOpenAfterLaunch = !!(s && s.stayOpenAfterLaunch);
        } catch { stayOpenAfterLaunch = false; }
        updateStayOpenLabel();
      })();

      optStayOpen.onclick = async() => {
          stayOpenAfterLaunch = !stayOpenAfterLaunch;
          updateStayOpenLabel();
          await ipcRenderer.invoke('settings:update', {
              stayOpenAfterLaunch
          });
          showToast(
              stayOpenAfterLaunch ?
              'Launcher will stay open after launching.' :
              'Launcher will hide after launching.'
          );
          closeAllMenus();
          menuMode = false;
      };

      const updateBtn = document.getElementById('updateBtn');
      (async() => {
          try {
              const res = await ipcRenderer.invoke('app:check-update');
              if (res && res.ok && res.updateAvailable) {
                  updateBtn.style.display = '';
                  updateBtn.textContent = 'Update available — ' + res.latest;
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

      searchInput.addEventListener('input', () => {
        filterText = (searchInput.value || '').trim().toLowerCase();
        if (manageOpen !== null) manageOpen = null;
        createForm.classList.remove('show');
        render();
      });

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
        createName.value = '';
        if (createJob && createJob.options && createJob.options.length) {
          createJob.selectedIndex = 0;
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

      async function queryAudioState(name){
        try{
          const res = await ipcRenderer.invoke('profiles:audio-state', name);
        if (res && res.ok) audioStates[name] = !!res.muted;
        }catch{}
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
            manageOpen = null;
            document.querySelectorAll('.manage.show').forEach(el => el.classList.remove('show'));
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

          if (isActive(name)) {
            const muteBtn = document.createElement('button');
            muteBtn.className = 'btn';
            muteBtn.textContent = (audioStates[name] ? 'Unmute' : 'Mute');
            muteBtn.onclick = async () => {
              const res = await ipcRenderer.invoke('profiles:toggle-audio', name);
              if (res && res.ok) {
                audioStates[name] = !!res.muted;
                muteBtn.textContent = (audioStates[name] ? 'Unmute' : 'Mute');
                showToast(audioStates[name] ? 'Session muted.' : 'Session unmuted.');
              }
            };
            actions.appendChild(muteBtn);
          }

          const manage = document.createElement('button');
          manage.className = 'btn manage-btn';
          manage.dataset.name = name;
          manage.textContent = (manageOpen === name) ? 'Close' : 'Manage';
          if (isActive(name)) {
            manage.disabled = true;
          } else {
            manage.onclick = () => {
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
            play.textContent = 'Show';
            play.onclick = async () => {
              await ipcRenderer.invoke('profiles:focus', name);
            };
          } else {
            play.textContent = 'Play';
            play.onclick = async () => {
              manageOpen = null;
              createForm.classList.remove('show');
              render();
              await ipcRenderer.invoke('profiles:launch', { name });
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

          if (isActive(name)) { queryAudioState(name); }
        });
      }

      async function refresh() {
        profiles = await ipcRenderer.invoke('profiles:get');
        actives = await ipcRenderer.invoke('profiles:active');
        render();
      }

      ipcRenderer.on('profiles:updated', refresh);
      ipcRenderer.on('profiles:active-updated', (_e, a) => { actives = a || []; render(); });
      ipcRenderer.on('profiles:audio-updated', (_e, { name, muted }) => {
        audioStates[name] = !!muted;
        render();
      });
      ipcRenderer.on('shots:done', (_e, payload) => {
        if (payload && payload.file) {
          showToast('Screenshot saved.');
        }
      });

      ipcRenderer.on('app:restarted-cleanup-complete', () => {
        showToast('Profile list reloaded.');
      });

      refresh();

      // ---------- Tips ----------
      const tips = [
        "Press Ctrl+Shift+L while playing to show or hide the launcher and open another profile.",
        "Easily import or export your profile list and settings from Options → Import/Export Profiles.json.",
        "Press Ctrl+Shift+P to capture a screenshot of the focused session.",
        "Access your screenshots from Options → Open Screenshots folder.",
        "Press Ctrl+Shift+M to mute or unmute your current session.",
        "Drag and reorder your profiles and the order saves automatically.",
        "Filter profiles quickly by typing in the search bar.",
        "Use the job dropdown to filter characters by their class.",
        "Clone an existing profile to copy its settings instantly.",
        "Want a wider view? Toggle the window frame for each profile by clicking the Manage button.",
        "Reset saved window size or position from the Manage panel if needed.",
        "Clear profile data (cookies, cache, storage) safely from Manage.",
        "A gold button appears when a new version is available.",
        "Press Ctrl+Tab or Ctrl+Shift+Tab to cycle between active sessions.",
        "To switch to a specific active session, press Ctrl+Shift+L and click 'Show'.",
        "Prefer to keep the launcher visible after pressing Play? Toggle it in Options → Stay Open After Launch."
      ];

      function shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
      }
      
      function initTips() {
        const tipsBox = document.getElementById("tipsBox");
        const tipsContent = document.getElementById("tipsContent");
        if (!tipsBox || !tipsContent) return;
      
        let shuffledTips = shuffle([...tips]);
        let tipIndex = 0;
        let intervalId;
      
        function showTip() {
          tipsContent.textContent = shuffledTips[tipIndex];
          tipIndex = (tipIndex + 1) % shuffledTips.length;
          if (tipIndex === 0) {
            shuffledTips = shuffle([...tips]);
          }
        }
      
        function startRotation() {
          if (!intervalId) {
            intervalId = setInterval(showTip, 8000);
          }
        }
      
        function stopRotation() {
          clearInterval(intervalId);
          intervalId = null;
        }
      
        showTip();
        startRotation();
      
        tipsBox.addEventListener("mouseenter", stopRotation);
        tipsBox.addEventListener("mouseleave", startRotation);
        tipsBox.addEventListener("click", () => {
          stopRotation();
          showTip();
          startRotation();
        });
      }

      window.addEventListener("DOMContentLoaded", initTips);

      // ---------- News (right column) ----------
      const newsEl = document.getElementById('newsContainer');

      function renderNewsItems(items){
        newsEl.innerHTML = '';
        if (!items || !items.length) {
          const empty = document.createElement('div');
          empty.className = 'news-empty';
          empty.textContent = 'No updates found.';
          newsEl.appendChild(empty);
          return;
        }
        items.forEach(item => {
          const card = document.createElement('div');
          card.className = 'news-item';
          card.innerHTML = \`
            <div class="nt"><a href="#">\${item.title}</a></div>
            <div class="ns">\${item.section}</div>
          \`;
          const a = card.querySelector('a');
          a.onclick = (e) => {
            e.preventDefault();
            try { require('electron').shell.openExternal(item.link); } catch {}
          };
          newsEl.appendChild(card);
        });
      }

      (async () => {
        try{
          const html = await ipcRenderer.invoke('news:get');
          const doc = new (window.DOMParser)().parseFromString(html, 'text/html');

          function collect(selector, sectionLabel){
            const anchors = doc.querySelectorAll(selector);
            const arr = [];
            anchors.forEach(a => {
              try{
                const title = a.querySelector('h5')?.textContent?.trim() || a.textContent.trim();
                const subtitle = a.querySelector('h6')?.textContent?.trim() || '';
                const href = a.getAttribute('href');
                if (href && title) arr.push({ title, subtitle, link: href.startsWith('http') ? href : ('https://universe.flyff.com' + href), section: sectionLabel });
              }catch {}
            });
            return arr;
          }

          const updates = collect('#nav-1 .card a', 'Updates');
          const events = collect('#nav-2 .card a', 'Events');
          const shop   = collect('#nav-3 .card a', 'Item Shop News');

          const combined = [...updates, ...events, ...shop];
          renderNewsItems(combined);
        } catch (e){
          renderNewsItems([]);
        }
      })();
    </script>
  </body>
  </html>`;

  launcherWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  launcherWin.once('ready-to-show', () => launcherWin.show());
  launcherWin.on('closed', () => { launcherWin = null; });
}

// ---------- Launch Game (with window state restore/save) ----------

function applyWinStateOptionsFromProfile(profile) {
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
    icon: 'icon.png',
    webPreferences: {
      backgroundThrottling: false,
      partition: part,
      nativeWindowOpen: true
    }
  });

  win.__profileName = name;
  
  if (profile.muted) {
    try { win.webContents.setAudioMuted(true); } catch {}
  }

  win.on('close', async(e) => {
    if (win.__confirmedClose) {
        saveWindowStateForProfile(name, win);
        return;
    }

    if (win.__closingPrompt) {
        e.preventDefault();
        return;
    }

    e.preventDefault();
    win.__closingPrompt = true;

    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();

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
        saveWindowStateForProfile(name, win);
        win.__confirmedClose = true;
        win.close();
        return;
    } else if (res.response === 1) {
        saveWindowStateForProfile(name, win);
        if (getActiveProfileNames().length > 1) {
            const confirm = await dialog.showMessageBox(win, {
                type: 'warning',
                buttons: ['Yes, Exit All', 'Cancel'],
                defaultId: 0,
                cancelId: 1,
                title: 'Confirm Exit',
                message: 'Multiple sessions are still running.',
                detail: 'Are you sure you want to close FlyffU Launcher and all running profiles?',
                noLink: true,
                normalizeAccessKeys: true
            });
            if (confirm.response !== 0) {
                win.__closingPrompt = false;
                return;
            }
        }
        exitAppNow();
        return;
    }

    win.__closingPrompt = false;
  });

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
        width: 1000,
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

ipcMain.handle('settings:get', async () => {
  return settings;
});

ipcMain.handle('settings:update', async (_e, patch) => {
  settings = { ...settings, ...patch };
  writeSettings(settings);
  return { ok: true, settings };
});

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

  writeProfiles(list);

  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  broadcastActiveUpdate();
  return { ok: true };
});

ipcMain.handle('profiles:resetWinState', async (_e, name) => {
  const list = readProfiles();
  const idx = getProfileIndex(list, name);
  if (idx === -1) return { ok: false, error: 'Profile not found' };
  list[idx].winState = undefined;
  writeProfiles(list);
  if (launcherWin) launcherWin.webContents.send('profiles:updated');
  return { ok: true };
});

ipcMain.handle('profiles:delete', async (_e, { name, clear }) => {
  const list = readProfiles();
  const p = list.find(x => x.name === name);
  if (!p) return { ok: false, error: 'Profile not found' };
  const part = partitionForProfile(p);

  if (gameWindows.has(name)) {
    for (const w of gameWindows.get(name)) {
      try {
        w.__confirmedClose = true;
        if (!w.isDestroyed()) w.close();
      } catch {}
    }
    gameWindows.delete(name);
  }

  const next = list.filter(x => x.name !== name);
  writeProfiles(next);

  let requiresRestart = false;

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

ipcMain.handle('profiles:launch', async (_e, payload) => {
  const name = (typeof payload === 'string') ? payload : payload?.name;
  const stayOpen = !!settings.stayOpenAfterLaunch;

  launchGameWithProfile(name);

  if (launcherWin && !launcherWin.isDestroyed()) {
    if (!stayOpen) {
      try { launcherWin.hide(); } catch {}
    } else {
      if (launcherWin.isVisible() && !launcherWin.isMinimized()) {
        setTimeout(() => {
          try {
            launcherWin.setAlwaysOnTop(true, 'screen-saver');
            launcherWin.show();
            launcherWin.focus();
            setTimeout(() => { try { launcherWin.setAlwaysOnTop(false); } catch {} }, 300);
          } catch {}
        }, 120);
      }
    }
  }
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

ipcMain.handle('profiles:focus', async (_e, name) => {
  const wins = getAllGameWindowsForProfile(name);
  if (!wins.length) return { ok: false, error: 'No session running' };

  const target = wins[0];
  if (target && !target.isDestroyed()) {
    try {
      target.show();
      target.focus();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return { ok: false, error: 'Window destroyed' };
});

ipcMain.handle('profiles:audio-state', async (_e, name) => {
  const list = readProfiles();
  const idx = getProfileIndex(list, name);
  if (idx === -1) return { ok: false, error: 'Profile not found' };

  const wins = getAllGameWindowsForProfile(name);
  if (wins.length === 0) {
    return { ok: true, muted: !!list[idx].muted };
  }

  const anyUnmuted = wins.some(w => !w.webContents.isAudioMuted());
  const muted = !anyUnmuted;

  list[idx].muted = muted;
  writeProfiles(list);

  return { ok: true, muted };
});

ipcMain.handle('profiles:toggle-audio', async (_e, name) => {
  const list = readProfiles();
  const idx = getProfileIndex(list, name);
  if (idx === -1) return { ok: false, error: 'Profile not found' };

  const wins = getAllGameWindowsForProfile(name);
  let next;
  if (wins.length === 0) {
    next = !list[idx].muted;
  } else {
    const currentlyMuted = wins.every(w => w.webContents.isAudioMuted());
    next = !currentlyMuted;
    for (const w of wins) {
      try { w.webContents.setAudioMuted(next); } catch {}
    }
  }

  list[idx].muted = next;
  writeProfiles(list);

  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.send('profiles:audio-updated', { name, muted: next });
  }

  return { ok: true, muted: next };
});

ipcMain.handle('profiles:export', async () => {
  try {
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Export profiles.json',
      defaultPath: path.join(app.getPath('documents'), 'profiles.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false };
    const data = JSON.stringify(readProfiles(), null, 2);
    fs.writeFileSync(filePath, data, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Failed to export: ' + (e.message || e) };
  }
});

ipcMain.handle('profiles:import', async () => {
  try {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: 'Import profiles.json',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false };
    const raw = fs.readFileSync(filePaths[0], 'utf8');
    const arr = JSON.parse(raw);
    const normalized = normalizeProfiles(arr);
    writeProfiles(normalized);
    if (launcherWin) launcherWin.webContents.send('profiles:updated');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Failed to import: ' + (e.message || e) };
  }
});

ipcMain.handle('shots:open-folder', async () => {
  try {
    await shell.openPath(SHOTS_DIR);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Failed to open folder' };
  }
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

ipcMain.handle('news:get', async () => {
  try {
    const html = await httpGetText('https://universe.flyff.com/news');
    return html;
  } catch (e) {
    return '';
  }
});

ipcMain.handle('tools:list', async () => {
  return [
    { title: 'Flyffipedia', link: 'https://flyffipedia.com/' },
    { title: 'Gothante', link: 'https://gothante.wiki/' },
    { title: 'Madrigalinside', link: 'https://madrigalinside.com/' },
    { title: 'Flyff.me', link: 'https://www.flyff.me/' },
    { title: 'SiegeStats', link: 'https://siegestats.cc/' },
    { title: 'Flyff Model Viewer', link: 'https://flyffmodelviewer.com/' },
    { title: 'Flyffulator', link: 'https://flyffulator.com/' },
    { title: 'Farmito Flyff', link: 'https://farmito-flyff.me/' }
  ];
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

ipcMain.handle('ui:alert', async (_e, { message, title }) => {
  const parent = (launcherWin && !launcherWin.isDestroyed()) ? launcherWin : BrowserWindow.getFocusedWindow();
  await dialog.showMessageBox(parent, {
    type: 'info',
    buttons: ['OK'],
    defaultId: 0,
    title: title || 'Info',
    message: String(message || '')
  });
  return { ok: true };
});

ipcMain.handle('ui:about', async () => {
  const parent = (launcherWin && !launcherWin.isDestroyed())
    ? launcherWin
    : BrowserWindow.getFocusedWindow();

  const iconPath = path.join(__dirname, 'icon.png');
  const iconDataUrl = nativeImage.createFromPath(iconPath)
    .resize({ width: 40, height: 40 })
    .toDataURL();

  const aboutWin = new BrowserWindow({
    parent,
    modal: true,
    width: 400,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    show: false,
    icon: iconPath,
    backgroundColor: '#0b0f16',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });

  const html = `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>About</title>
    <style>
      :root{ --bg:#0b0f16; --text:#e6edf3; --sub:#9aa7bd; }
      *{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial}
      html,body{height:100%}
      body{margin:0;background:var(--bg);color:var(--text);display:flex;align-items:center;justify-content:center}
      .wrap{width:min(92vw,440px);padding:8px 6px}
      .head{display:flex;align-items:center;gap:12px;margin-bottom:10px}
      .head img{width:40px;height:40px;border-radius:10px}
      .title{font-size:18px;font-weight:800;letter-spacing:.2px}
      .sub{font-size:12px;color:var(--sub)}
	  .abt{font-size:12px;justify-content:center;align-items:center}
      .row{font-size:13px;margin:6px 2px;letter-spacing:.2px;display:flex;justify-content:center;align-items:center;gap:14px;flex-wrap:wrap;}.row a{color:#9ab4ff;text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px;}.row a:hover{filter:brightness(1.15);}
      a{color:#8fbaff;text-decoration:none}
      a:hover{text-decoration:underline}
    </style>
  </head>
  
  <body>
    <div class="wrap">
      <div class="head">
        <img src="${iconDataUrl}" alt="icon">
        <div>
          <div class="title">FlyffU Launcher v${pkg.version}</div>
          <div class="sub">Multi-profile launcher for Flyff Universe by Toffee</div>
        </div>
      </div>
	  
	  <div class="abt">
	  FlyffU Launcher is an open-source multi-profile launcher for Flyff Universe, built by Toffee and community contributors.
	  <br/><br/>
	  FlyffU Launcher packs isolated profiles, instant screenshots, streamlined session controls, and a built-in news pane. Run multiple sessions effortlessly, with saved window layouts and neatly organized profiles for a smoother, more focused play experience.
	  </div>
	  
	  <br/>
	  
      <div class="row">
        <a href="#" data-link="https://discord.gg/DNyvbaPqyt">Discord</a>
        <a href="#" data-link="https://github.com/toffeegg/FlyffU-Launcher">GitHub</a>
		<a href="#" data-link="https://github.com/toffeegg/FlyffU-Launcher/blob/main/privacy-policy.md">Privacy Policy</a>
		<a href="#" data-link="https://github.com/toffeegg/FlyffU-Launcher/blob/main/LICENSE">License</a>
      </div>
	</div>
	
    <script>
      const { shell } = require('electron');
      document.querySelectorAll('a[data-link]').forEach(a=>{
        a.addEventListener('click', (e) => {
          e.preventDefault();
          shell.openExternal(a.getAttribute('data-link'));
        });
      });
      window.addEventListener('keydown', (e)=>{ if(e.key==='Escape') window.close(); });
    </script>
  </body>
  </html>`.trim();

  aboutWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  aboutWin.once('ready-to-show', () => aboutWin.show());
  return { ok: true };
});

ipcMain.handle('ui:shortcuts', async () => {
  const parent = (launcherWin && !launcherWin.isDestroyed())
    ? launcherWin
    : BrowserWindow.getFocusedWindow();
	
  const iconPath = path.join(__dirname, 'icon.png');
  const iconDataUrl = nativeImage.createFromPath(iconPath)
    .resize({ width: 40, height: 40 })
    .toDataURL();	

  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 500,
    height: 400,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    show: false,
    icon: iconPath,	
    backgroundColor: '#0b0f16',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });

  const html = `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>Shortcuts</title>
    <style>
      :root{ --bg:#0b0f16; --text:#e6edf3; --sub:#9aa7bd; --line:#1c2533; }
      *{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial}
      html,body{height:100%}
      body{margin:0;background:var(--bg);color:var(--text);display:flex;align-items:center;justify-content:center}
      .wrap{width:min(92vw,460px);padding:12px}
      .list{display:flex;flex-direction:column;gap:8px}
      .item{display:flex;align-items:center;justify-content:space-between;background:#0f1624;border:1px solid #1e2a3e;border-radius:8px;padding:10px 12px}
      .label{font-size:13px;color:#d6e6ff}
      .kbd{font:600 12px/1.2 ui-monospace,SFMono-Regular,Consolas,Monaco,monospace;background:#0b1220;border:1px solid #1e2a3e;border-bottom-width:2px;padding:6px 8px;border-radius:6px}
      a{color:#8fbaff;text-decoration:none}
      a:hover{text-decoration:underline}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="list">
        <div class="item"><div class="label">Toggle Launcher</div><div class="kbd">Ctrl + Shift + L</div></div>
		<div class="item"><div class="label">Mute/Unmute focused session</div><div class="kbd">Ctrl + Shift + M</div></div>
        <div class="item"><div class="label">Screenshot focused session</div><div class="kbd">Ctrl + Shift + P</div></div>
		<div class="item"><div class="label">Cycle forward active sessions</div><div class="kbd">Ctrl + Tab</div></div>
		<div class="item"><div class="label">Cycle backward active sessions</div><div class="kbd">Ctrl + Shift + Tab</div></div>
      </div>
    </div>
    <script>
      window.addEventListener('keydown', (e)=>{ if(e.key==='Escape') window.close(); });
    </script>
  </body>
  </html>`.trim();

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.once('ready-to-show', () => win.show());
  return { ok: true };
});

// ---------- App lifecycle ----------

app.on('ready', async () => {
  if (!fs.existsSync(PROFILES_FILE)) writeProfiles([]);
  writeProfiles(readProfiles());
  settings = readSettings();

  await processPendingDeletes().catch(() => {});

  createLauncher();
  updateGlobalShortcut();

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
