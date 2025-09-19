// main.js
const { app, BrowserWindow, ipcMain, session, dialog, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');

let launcherWin = null;

// Track multiple game windows per profile
// Map<string, Set<BrowserWindow>>
const gameWindows = new Map();

const USER_DATA = app.getPath('userData');
const PROFILES_FILE = path.join(USER_DATA, 'profiles.json');
const PENDING_FILE = path.join(USER_DATA, 'pending_deletes.json');
const TRASH_DIR = path.join(USER_DATA, 'Trash');

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

// Server options (Live only)
const SERVERS = {
  live: { label: 'Live Server', url: 'https://universe.flyff.com/play', dev: false }
};

// ---------- Profiles storage helpers ----------

/** @typedef {{name:string, server:keyof SERVERS, savedAuth?:Record<string,{u:string,p:string}>, partition:string, frame?:boolean, isClone?:boolean}} Profile */

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

function normalizeProfiles(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(Boolean)
    .map(item => {
      if (typeof item === 'string') {
        const name = safeProfileName(item);
        return { name, server: 'live', savedAuth: {}, partition: partitionForProfile({ name }), frame: false, isClone: inferIsCloneFromName(name) };
      }
      const name = safeProfileName(item?.name);
      if (!name) return null;
      const server = (item?.server && SERVERS[item.server]) ? item.server : 'live';
      const savedAuth = (item?.savedAuth && typeof item.savedAuth === 'object') ? item.savedAuth : {};
      const partition = (typeof item?.partition === 'string' && item.partition) ? item.partition : partitionForProfile({ name });
      const frame = !!item?.frame;
      const isClone = (typeof item?.isClone === 'boolean') ? item.isClone : inferIsCloneFromName(name);
      return { name, server, savedAuth, partition, frame, isClone };
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

// ---------- UI ----------

function createLauncher() {
  launcherWin = new BrowserWindow({
    width: 900,
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
    if (getActiveProfileNames().length > 0) {
      e.preventDefault();
      launcherWin.hide();
    }
  });

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
      flex:1;display:flex;flex-direction:column;padding:1px 12px; 1px 12px;min-height:0;
    }
  
    .btn{
      border:0;padding:8px 10px;margin:1px 0;border-radius:8px;
      background:#1b2334;color:var(--text);cursor:pointer;
      transition:transform .05s,filter .15s;line-height:1.1;font-size:13px
    }
    .btn:hover{filter:brightness(1.06)}
    .btn:active{transform:translateY(1px)}
    .btn.primary{background:var(--accent)}
    .btn.danger{background:var(--danger)}
    .btn[disabled]{opacity:.55;cursor:not-allowed}
  
    input[type="text"], select{
      width:100%;padding:8px 10px;margin:1px 0;border-radius:8px;
      border:1px solid #233046;background:var(--panel-2);color:var(--text);
      font-size:13px;line-height:1.2
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
    .name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;margin-top:3px}
    .row-actions{display:flex;gap:6px}
  
    .manage{margin-top:8px;border-top:1px dashed var(--line);padding-top:8px;display:none}
    .manage.show{display:block}
  
    .grid{display:grid;gap:8px}
    .grid.cols-2{grid-template-columns:1fr 1fr}
  
    .empty{
      padding:18px;border:1px dashed #263146;border-radius:8px;
      text-align:center;margin-top:8px;font-size:13px;color:var(--sub)
    }
  
    .create-form{margin-top:8px;display:none}
    .create-form.show{display:block}
  
    .sec-title{font-size:11px;color:var(--sub);margin:6px 0 2px}
    .tag{
      display:inline-block;background:#162033;border:1px solid #233046;
      border-radius:999px;padding:3px 6px;font-size:10.5px;color:#9aa7bd;margin-left:6px
    }
  
    .toasts{
      position:fixed;right:12px;bottom:12px;display:flex;flex-direction:column;
      gap:8px;z-index:9999
    }
    .toast{
      background:#0f1522;border:1px solid #1f2633;border-left:3px solid var(--ok);
      padding:10px 12px;border-radius:8px;min-width:200px;
      box-shadow:0 8px 20px rgba(0,0,0,.3);opacity:0;transform:translateY(6px);
      transition:opacity .2s ease, transform .2s ease
    }
    .toast.show{opacity:1;transform:translateY(0)}
    .toast .tmsg{font-size:12.5px;color:#cfe3ff}
  
    .drag-handle{cursor:grab;user-select:none;margin-right:6px;font-size:13px;color:#9aa7bd}
    .row.dragging{opacity:.6}
    .drop-indicator{height:6px;border-radius:6px;background:#233046;margin:6px 0;display:none}
    .drop-indicator.show{display:block}
  
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
      <div class="muted" style="margin-left:auto;">Version ${pkg.version}</div>
    </div>

    <div class="wrap">
      <section class="card">
        <div class="card-c">
          <div class="muted hint">Tip: Press <strong>Ctrl + Shift + L</strong> to show/hide this launcher while a session is running.</div>

          <div class="card-h" style="margin-top:10px">
            <button id="createBtn" class="btn primary" style="max-height:34px">Create Profile</button>
            <input id="searchInput" type="text" placeholder="Search profile name..." style="max-width:240px">
            <span class="muted" id="count">0</span>
          </div>

          <div id="createForm" class="create-form">
            <div class="sec-title">Profile Name</div>
            <div class="grid cols-2">
              <input id="createName" type="text" placeholder="Profile name (e.g. Main, Alt, Archer SEA)">
              <div></div>
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
      const { ipcRenderer } = require('electron');
      let profiles = [];
      let manageOpen = null;
      let actives = [];
      let filterText = '';
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

      const createBtn = document.getElementById('createBtn');
      const createForm = document.getElementById('createForm');
      const createName = document.getElementById('createName');
      const createAdd = document.getElementById('createAdd');
      const createCancel = document.getElementById('createCancel');

      const searchInput = document.getElementById('searchInput');

      createBtn.onclick = () => { 
        createForm.classList.toggle('show'); 
        if (createForm.classList.contains('show')) createName.focus(); 
      };
      createCancel.onclick = () => {
        createForm.classList.remove('show');
        createName.value = '';
      };

      searchInput.addEventListener('input', () => {
        filterText = (searchInput.value || '').trim().toLowerCase();
        render();
      });

      function isActive(name){ return actives.includes(name); }
      function anySessionOpen(){ return (actives && actives.length > 0); }

      async function addProfile() {
        const val = (createName.value || '').trim();
        if (!val) return alert('Enter a profile name');
        const res = await ipcRenderer.invoke('profiles:add', { name: val });
        if (!res.ok) return alert(res.error || 'Failed to add profile');
        createName.value = '';
        createForm.classList.remove('show');
        await refresh();
        showToast('Profile created.');
      }
      createAdd.onclick = addProfile;
      createName.addEventListener('keydown', (e) => { if (e.key === 'Enter') addProfile(); });

      const listEl = document.getElementById('list');
      const countEl = document.getElementById('count');
      const emptyEl = document.getElementById('emptyState');
      const dropAbove = document.getElementById('dropAbove');
      const dropBelow = document.getElementById('dropBelow');

      function tagFor(){ return 'Live Server'; }

      function applyFilters(list){
        const ft = filterText;
        return list.filter(p => {
          const byText = !ft || (p.name || '').toLowerCase().includes(ft);
          return byText;
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
            if (!res.ok) return alert(res.error || 'Failed to save order');
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
          nm.innerHTML = name + ' <span class="tag">' + tagFor() + '</span>';

          leftWrap.appendChild(dragHandle);
          leftWrap.appendChild(nm);

          const actions = document.createElement('div');
          actions.className = 'row-actions';

          const manage = document.createElement('button');
          manage.className = 'btn';
          manage.textContent = (manageOpen === name) ? 'Close' : 'Manage';
          if (isActive(name)) {
            manage.disabled = true;
          } else {
            manage.onclick = () => {
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
              manageOpen = null;
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
          const spacer = document.createElement('div');
          renameWrap.appendChild(spacer);

          const saveRow = document.createElement('div');
          saveRow.className = 'grid cols-2';
          const saveBtn = document.createElement('button');
          saveBtn.className = 'btn';
          saveBtn.textContent = 'Save Changes';
          saveBtn.onclick = async () => {
            const newName = (renameInput.value || '').trim();
            if (!newName) return alert('Enter a valid name');
            const res = await ipcRenderer.invoke('profiles:update', { from: name, to: newName });
            if (!res.ok) return alert(res.error || 'Failed to update');
            manageOpen = newName;
            await refresh();
            showToast('Changes saved.');
          };

          const frameBtn = document.createElement('button');
          frameBtn.className = 'btn';
          frameBtn.textContent = p.frame ? 'Disable Window Frame' : 'Enable Window Frame';
          frameBtn.onclick = async () => {
            const res = await ipcRenderer.invoke('profiles:update', { from: name, to: name, frame: !p.frame });
            if (!res.ok) return alert(res.error || 'Failed to update');
            await refresh();
            showToast('Window frame ' + (!p.frame ? 'enabled' : 'disabled') + '.');
          };

          saveRow.appendChild(saveBtn);
          saveRow.appendChild(frameBtn);
          m.appendChild(renameWrap);
          m.appendChild(saveRow);

          const authRow = document.createElement('div');
          authRow.className = 'grid cols-2';
          const clearAuthBtn = document.createElement('button');
          clearAuthBtn.className = 'btn';
          clearAuthBtn.textContent = 'Clear Saved Logins';
          clearAuthBtn.onclick = async () => {
            if (!confirm('Clear saved HTTP auth credentials for "'+name+'"?')) return;
            const res = await ipcRenderer.invoke('profiles:clear-auth', name);
            if (!res.ok) alert(res.error || 'Failed to clear saved logins');
            else showToast('Saved logins cleared.');
          };
          const clearBtn = document.createElement('button');
          clearBtn.className = 'btn';
          clearBtn.textContent = 'Clear Session Data';
          clearBtn.onclick = async () => {
            if (!confirm('Clear saved session (cookies, storage) for "'+name+'"?')) return;
            const res = await ipcRenderer.invoke('profiles:clear', name);
            if (!res.ok) alert(res.error || 'Failed to clear session');
            else showToast('Session data cleared.');
          };
          authRow.appendChild(clearAuthBtn);
          authRow.appendChild(clearBtn);
          m.appendChild(authRow);

          const dangerWrap = document.createElement('div');
          dangerWrap.className = 'grid cols-2';

          // --- Clone button logic: disable for cloned profiles via persisted flag ---
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
              if (!res.ok) return alert(res.error || 'Failed to clone');
              await refresh();
              showToast('Profile cloned.');
            };
            dangerWrap.appendChild(cloneBtn);
          }

          const delBtn = document.createElement('button');
          delBtn.className = 'btn danger';
          delBtn.textContent = 'Delete Profile';
          // Disable ALL delete buttons while any session is running
          delBtn.disabled = anySessionOpen();
          delBtn.title = anySessionOpen() ? 'Close all running sessions to delete profiles.' : '';
          delBtn.onclick = async () => {
            if (anySessionOpen()) return; // safety guard on click
            const ok = confirm('Delete "'+name+'"? This will remove its saved cookies/storage and fully delete its partition folder(s). The launcher will restart to complete deletion.');
            if (!ok) return;
            setUiBusy(true); // lock UI interactions + show loading cursor
            const res = await ipcRenderer.invoke('profiles:delete', { name, clear: true });
            if (!res.ok) {
              setUiBusy(false);
              return alert(res.error || 'Failed to delete');
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

// ---------- HTTP Auth Modal ----------

function promptHTTPAuth(parent, host) {
  return new Promise((resolve) => {
    const modal = new BrowserWindow({
      parent,
      modal: true,
      width: 400,
      height: 380,
      resizable: false,
      autoHideMenuBar: true,
      title: 'Authentication Required',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    const html = `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body{margin:0;background:#0b0f16;color:#e6edf3;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial}
        .wrap{padding:16px}
        h1{font-size:16px;margin:0 0 10px}
        p{color:#9aa7bd;margin:0 0 14px}
        label:not(.chk){display:block;font-size:12px;color:#9aa7bd;margin-bottom:6px}
        input[type="text"], input[type="password"]{
          width:90%;padding:10px 12px;border-radius:10px;border:1px solid #233046;background:#0c1220;color:#e6edf3;margin-bottom:12px
        }
        label.chk{
          display:inline-flex;align-items:center;gap:8px;color:#9aa7bd;font-size:12px;margin-top:2px;margin-bottom:0
        }
        input[type="checkbox"]{width:auto;height:auto;margin:0;padding:0;}
        .row{display:flex;justify-content:flex-end;gap:10px;margin-top:6px}
        button{border:0;padding:10px 14px;border-radius:10px;background:#1b2334;color:#e6edf3;cursor:pointer}
        button.primary{background:#2563eb}
      </style>
    </head>
    <body>
      <div class="wrap">
        <h1>Authentication Required</h1>
        <p>Server <strong>${host}</strong> requires a username and password.</p>
        <label>Username</label>
        <input id="u" type="text" autofocus />
        <label>Password</label>
        <input id="p" type="password" />
        <label class="chk"><input id="r" type="checkbox" /> Save Login</label>
        <div class="row">
          <button id="cancel">Cancel</button>
          <button id="ok" class="primary">OK</button>
        </div>
      </div>
      <script>
        const { ipcRenderer } = require('electron');
        document.getElementById('cancel').onclick = () => ipcRenderer.send('auth:cancel');
        function submit() {
          const u = document.getElementById('u').value || '';
          const p = document.getElementById('p').value || '';
          const r = document.getElementById('r').checked || false;
          ipcRenderer.send('auth:submit', { u, p, remember: r });
        }
        document.getElementById('ok').onclick = submit;
        document.getElementById('p').addEventListener('keydown', (e)=>{ if(e.key==='Enter') submit(); });
      </script>
    </body>
    </html>`;
    modal.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    const cleanup = () => {
      try { if (!modal.isDestroyed()) modal.close(); } catch {}
      ipcMain.removeAllListeners('auth:submit');
      ipcMain.removeAllListeners('auth:cancel');
    };

    ipcMain.once('auth:submit', (_e, data) => { cleanup(); resolve({ ok: true, ...data }); });
    ipcMain.once('auth:cancel', () => { cleanup(); resolve({ ok: false }); });

    modal.on('closed', () => {
      resolve({ ok: false });
    });
  });
}

// ---------- Launch Game ----------

function launchGameWithProfile(name) {
  const profile = getProfileByName(name);
  if (!profile) return;
  const part = partitionForProfile(profile);
  const server = SERVERS[profile.server] ? profile.server : 'live';
  const url = SERVERS[server].url;
  const isDev = !!SERVERS[server].dev;

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    show: false,
    frame: !!profile.frame,
    icon: isDev ? 'dev.png' : 'icon.png',
    webPreferences: {
      backgroundThrottling: false,
      partition: part,
      nativeWindowOpen: true
    }
  });

  win.__profileName = name;

  win.on('close', async (e) => {
    if (win.__confirmedClose) return;
    e.preventDefault();
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Exit Session', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Exit Session',
      message: 'Exit this game session?',
      detail: 'Profile: ' + (win.__profileName || name)
    });
    if (res.response === 0) {
      win.__confirmedClose = true;
      win.close();
    }
  });

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

  const onLogin = async (event, webContents, request, authInfo, callback) => {
    if (webContents.id !== win.webContents.id) return;
    event.preventDefault();

    const hostKey = (authInfo.host || '').trim() || 'server';
    const current = getProfileByName(win.__profileName || name);
    const saved = current?.savedAuth?.[hostKey];

    if (saved && saved.u && saved.p !== undefined) {
      callback(saved.u, saved.p);
      return;
    }

    const res = await promptHTTPAuth(win, hostKey);
    if (res.ok && res.u !== undefined) {
      if (res.remember) {
        const updated = getProfileByName(win.__profileName || name);
        if (updated) {
          updated.savedAuth = updated.savedAuth || {};
          updated.savedAuth[hostKey] = { u: res.u, p: res.p || '' };
          saveProfile(updated);
          if (launcherWin && !launcherWin.isDestroyed()) launcherWin.webContents.send('profiles:updated');
        }
      }
      callback(res.u, res.p || '');
    } else {
      callback();
    }
  };
  app.on('login', onLogin);

  win.on('closed', () => {
    app.removeListener('login', onLogin);

    const key = win.__profileName || name;
    const s = gameWindows.get(key);
    if (s) {
      s.delete(win);
      if (s.size === 0) gameWindows.delete(key);
    }

    broadcastActiveUpdate();

    if (getActiveProfileNames().length === 0) {
      ensureLauncher();
      if (launcherWin && !launcherWin.isDestroyed()) {
        launcherWin.show();
        launcherWin.focus();
      }
    }
  });

  win.maximize();
  win.loadURL(url);
  win.once('ready-to-show', () => win.show());

  if (!gameWindows.has(name)) gameWindows.set(name, new Set());
  const set = gameWindows.get(name);
  set.add(win);
  broadcastActiveUpdate();
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

  const name = safeProfileName(nameInput);
  if (!name) return { ok: false, error: 'Enter a valid name' };
  if (list.some(p => p.name === name)) return { ok: false, error: 'Name already exists' };

  const profile = { name, server: 'live', savedAuth: {}, partition: partitionForProfile({ name }), frame: true, isClone: false };
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
    server: 'live',
    savedAuth: { ...(src.savedAuth || {}) },
    partition: newPartition,
    frame: !!src.frame,
    isClone: true
  };

  writeProfiles([...list, cloned]);

  try {
    await cloneCookiesBetweenPartitions(partitionForProfile(src), newPartition);
  } catch (e) {
    console.error('Failed to clone session cookies:', e);
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

ipcMain.handle('profiles:update', async (_e, { from, to, server, frame }) => {
  const list = readProfiles();
  const idx = getProfileIndex(list, from);
  if (idx === -1) return { ok: false, error: 'Profile not found' };

  const newName = safeProfileName(to || from);
  if (!newName) return { ok: false, error: 'Enter a valid name' };
  if (newName !== from && list.some(p => p.name === newName)) return { ok: false, error: 'Target name already exists' };

  const newServer = SERVERS[server] ? server : (list[idx].server || 'live');
  const newFrame = (typeof frame === 'boolean') ? frame : !!list[idx].frame;

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

  list[idx].name = newName;
  list[idx].server = newServer; // will always be 'live' in UI
  list[idx].partition = oldPartition;
  list[idx].frame = newFrame;
  list[idx].isClone = wasClone;

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

ipcMain.handle('profiles:clear-auth', async (_e, name) => {
  const p = getProfileByName(name);
  if (!p) return { ok: false, error: 'Profile not found' };
  p.savedAuth = {};
  const ok = saveProfile(p);
  if (!ok) return { ok: false, error: 'Failed to clear' };
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
    return { ok: false, error: 'Failed to clear session' };
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

ipcMain.handle('app:quit', () => app.quit());

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
