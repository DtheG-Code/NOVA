'use strict';
const {
  app, BrowserWindow, ipcMain, session, Menu, clipboard, shell,
  nativeTheme, protocol, nativeImage, net, dialog, webContents, components,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const http = require('node:http');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { execFile, spawn } = require('node:child_process');
const { JsonStore } = require('./store');
const { importEdgeBookmarks } = require('./edge-import');

app.setName('Nova Browser');
// Portable-Release (Marker neben der EXE) → eigene Profildaten dort = Werkseinstellungen,
// unabhängig von Entwickler-/Bestandsprofilen. Sonst normales AppData-Profil.
try {
  const portMarker = path.join(path.dirname(process.execPath), 'NOVA.portable');
  if (fs.existsSync(portMarker)) {
    app.setPath('userData', path.join(path.dirname(process.execPath), 'NovaData'));
  } else {
    app.setPath('userData', path.join(app.getPath('appData'), 'NovaBrowser'));
  }
} catch {
  app.setPath('userData', path.join(app.getPath('appData'), 'NovaBrowser'));
}
// Eigene App-Identität → Windows-Taskleiste nutzt unser Icon/Gruppierung
if (process.platform === 'win32') app.setAppUserModelId('com.spark.nova-browser');

// Der Ghostery-Adblocker injiziert Cosmetic-Filter per executeJavaScript in
// jeden Frame. Navigiert eine Seite (z. B. SPAs wie YouTube) währenddessen
// weiter, verschwindet der Ziel-Frame und die Injektion wirft harmlos
// "Script failed to execute". Diese bekannte Library-Eigenheit schlucken wir
// gezielt, damit echte Fehler weiter sichtbar bleiben.
process.on('unhandledRejection', (reason) => {
  const msg = (reason && (reason.message || reason)) + '';
  if (/Script failed to execute|Render frame was disposed|Object has been destroyed/i.test(msg)) return;
  console.error('[unhandledRejection]', reason);
});

const UI_DIR = path.join(__dirname, 'ui');
const APP_DIR = path.resolve(__dirname, '..');
const PARTITION = 'persist:nova';

let win = null;
let ses = null;
let blocker = null;
let blockingActive = false;
let settings, bookmarks, history, securityDb;
const tabBlockCounts = new Map(); // webContentsId -> count
const tabBlockHosts = new Map(); // webContentsId -> Map(host -> count)
const whitelistFilters = new Map(); // host -> filter[]
const downloads = new Map(); // id -> { item, meta }
let dlCounter = 0;
let widevineState = { available: false, ready: false, status: 'wird initialisiert' };

const DEFAULT_SETTINGS = {
  searchEngine: 'google',
  adblockEnabled: true,
  whitelist: [],
  filterLists: null, // null => Katalog-Defaults verwenden
  customFilters: '',
  cosmeticEnabled: true,
  restoreSession: true,
  forceDarkWeb: true,
  warpEnabled: true,
  warpDuration: 1500,
  musicService: 'spotify',
  musicWidth: 400,
  musicVolume: 100,
  musicMuted: false,
  accent: 'magenta',
  customAccent: { a: '#00e5ff', b: '#7c4dff' },
  sidebarCollapsed: false,
  edgeImported: false,
  totalBlocked: 0,
  lastSession: [],
  userName: 'Damian',
  zoomLevels: {},
  weatherEnabled: true,
  weatherCity: '',
  dials: [],
  dialHidden: [],
  dlGlobalLimit: 0,
  topbarTools: null,   // null => alle sichtbar
  bmCollapsed: false,
  tabBarPosition: 'top', // Werkseinstellung: Tabs oben
  tabSuspend: true,      // inaktive Tabs pausieren (RAM sparen)
  tabSuspendMin: 15,     // nach X Minuten Inaktivität
  claudeDock: 'float',   // float | left | right | bottom | split-left | split-right
  claudeFloat: null,
  plugins: {},           // { [nativePluginId]: bool } — Zustand der eingebauten NOVA-Plugins
  userscripts: [],       // [{ id, name, code, matches, enabled }] — eigene Skripte (wie Tampermonkey)
  extensions: [],        // [{ id, name, path, enabled }] — geladene entpackte Chrome-Erweiterungen
  topbarExtHidden: [],   // Erweiterungs-Toolbar-Icons, die in der Topbar ausgeblendet sind
};

// Eingebaute NOVA-Plugins, die standardmäßig AN sind (Adblock ist separat über adblockEnabled).
const NATIVE_PLUGIN_DEFAULTS = { darkmode: false, cookiekill: true, unblock: false, videospeed: false, scrolltop: false, autohttps: false, cinematicSpace: false };
function nativePluginState() {
  const saved = settings.get('plugins', {}) || {};
  const out = {};
  for (const id of Object.keys(NATIVE_PLUGIN_DEFAULTS)) out[id] = id in saved ? !!saved[id] : NATIVE_PLUGIN_DEFAULTS[id];
  return out;
}

// ---------------------------------------------------------------- protocol
protocol.registerSchemesAsPrivileged([
  { scheme: 'nova', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ------------------------------------------------------------ single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const url = argv.find((a) => /^https?:\/\//i.test(a));
    if (url) win.webContents.send('tabs:open', { url, background: false });
  });
}

// ---------------------------------------------------------------- helpers
function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function urlFromArgv(argv) {
  return argv.find((a) => /^https?:\/\//i.test(a)) || null;
}

// ---------------------------------------------------------------- adblock
// Offizielles AdGuard-Filterpaket (dieselben Listen, die die AdGuard-Erweiterung
// nutzt) über die uBlock-kompatiblen AdGuard-Endpunkte, kombiniert mit der
// Hochleistungs-Engine von Ghostery. Jede Liste ist einzeln zuschaltbar.
const FILTER_CATALOG = {
  easylist:    { name: 'EasyList (Werbung — Standard)', url: 'https://easylist.to/easylist/easylist.txt', def: true },
  easyGermany: { name: 'EasyList Germany (deutsche Werbung)', url: 'https://easylist.to/easylistgermany/easylistgermany.txt', def: true },
  easyPrivacy: { name: 'EasyPrivacy (Tracker)', url: 'https://easylist.to/easylist/easyprivacy.txt', def: true },
  agBase:      { name: 'AdGuard Basisfilter (Werbung)', url: 'https://filters.adtidy.org/extension/ublock/filters/2.txt', def: true },
  agTracking:  { name: 'AdGuard Tracking-Schutz', url: 'https://filters.adtidy.org/extension/ublock/filters/3.txt', def: true },
  agAnnoyance: { name: 'AdGuard Belästigungen (Popups, Banner)', url: 'https://filters.adtidy.org/extension/ublock/filters/14.txt', def: true },
  agUrlTrack:  { name: 'AdGuard URL-Tracking-Schutz', url: 'https://filters.adtidy.org/extension/ublock/filters/17.txt', def: true },
  agGerman:    { name: 'AdGuard Deutsch', url: 'https://filters.adtidy.org/extension/ublock/filters/6.txt', def: true },
  agSocial:    { name: 'AdGuard Soziale Medien (Like-Buttons)', url: 'https://filters.adtidy.org/extension/ublock/filters/4.txt', def: false },
  agMobile:    { name: 'AdGuard Mobile-Werbung', url: 'https://filters.adtidy.org/extension/ublock/filters/11.txt', def: false },
  ublockFilt:  { name: 'uBlock Origin — Kernfilter', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt', def: true },
  ublockBadware:{ name: 'uBlock Origin — Badware-Risiken', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt', def: true },
  ublockPriv:  { name: 'uBlock Origin — Privacy', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt', def: true },
  ublockQuick: { name: 'uBlock Origin — Quick-Fixes', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt', def: true },
  ublockUnbreak:{ name: 'uBlock Origin — Unbreak (verhindert Defekte)', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt', def: true },
  cookies:     { name: 'Cookie-Banner-Blocker (Fanboy)', url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt', def: true },
  annoyance:   { name: 'Fanboy Annoyances (Overlays, Widgets)', url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt', def: false },
  urlhaus:     { name: 'Malware-Schutz (URLhaus)', url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt', def: true },
  peterLowe:   { name: "Peter Lowe's Tracker- & Werbeserver", url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext', def: true },
};

function enabledFilterMap() {
  const saved = settings.get('filterLists', null);
  const map = {};
  for (const [key, item] of Object.entries(FILTER_CATALOG)) {
    map[key] = saved && key in saved ? !!saved[key] : item.def;
  }
  return map;
}
function enabledFilterUrls() {
  const map = enabledFilterMap();
  return Object.entries(FILTER_CATALOG).filter(([k]) => map[k]).map(([, v]) => v.url);
}

const ADBLOCK_CACHE = 'adblock-engine-v3.bin';
const ADBLOCK_MAX_AGE = 3 * 24 * 60 * 60 * 1000; // Listen alle 3 Tage aktualisieren

async function applyCustomFilters() {
  if (!blocker) return;
  const raw = (settings.get('customFilters', '') || '').trim();
  if (!raw) return;
  try {
    const { parseFilters } = await import('@ghostery/adblocker');
    const { networkFilters, cosmeticFilters } = parseFilters(raw);
    blocker.update({
      newNetworkFilters: networkFilters,
      newCosmeticFilters: cosmeticFilters,
    });
  } catch (err) {
    console.error('[adblock] custom filters failed:', err.message);
  }
}

async function initAdblock() {
  try {
    const { ElectronBlocker } = await import('@ghostery/adblocker-electron');
    const cachePath = path.join(app.getPath('userData'), ADBLOCK_CACHE);

    // Veralteten Cache verwerfen, damit die Listen frisch geladen werden
    try {
      const st = fs.statSync(cachePath);
      if (Date.now() - st.mtimeMs > ADBLOCK_MAX_AGE) fs.unlinkSync(cachePath);
    } catch {}

    whitelistFilters.clear();
    const urls = enabledFilterUrls();
    const cosmetic = settings.get('cosmeticEnabled', true);
    const engineConfig = {
      enableCompression: true,
      loadCosmeticFilters: cosmetic,
      loadGenericCosmeticsFilters: cosmetic,
      loadNetworkFilters: true,
      enableHtmlFiltering: true,
      enableMutationObserver: true,
    };
    try {
      blocker = await ElectronBlocker.fromLists(fetch, urls, engineConfig, {
        path: cachePath,
        read: fsp.readFile,
        write: fsp.writeFile,
      });
    } catch (err) {
      // Fallback: vorkompilierte Engine vom Ghostery-CDN
      console.error('[adblock] fromLists failed, falling back:', err.message);
      blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
        path: path.join(app.getPath('userData'), 'adblock-engine-fallback.bin'),
        read: fsp.readFile,
        write: fsp.writeFile,
      });
    }

    const onBlocked = (request) => {
      settings.set('totalBlocked', settings.get('totalBlocked', 0) + 1);
      const tabId = request.tabId;
      if (typeof tabId === 'number' && tabId >= 0) {
        tabBlockCounts.set(tabId, (tabBlockCounts.get(tabId) || 0) + 1);
        try {
          const host = new URL(request.url).hostname.replace(/^www\./, '');
          let hosts = tabBlockHosts.get(tabId);
          if (!hosts) { hosts = new Map(); tabBlockHosts.set(tabId, hosts); }
          hosts.set(host, (hosts.get(host) || 0) + 1);
        } catch {}
      }
      throttleStats();
    };
    blocker.on('request-blocked', onBlocked);
    blocker.on('request-redirected', onBlocked);

    // Eigene Filterregeln des Nutzers anwenden
    await applyCustomFilters();

    // Whitelist aus Settings anwenden
    for (const host of settings.get('whitelist', [])) await addWhitelistFilters(host);

    if (settings.get('adblockEnabled', true)) enableBlocking();
    console.log(`[adblock] engine ready — ${urls.length} Listen aktiv`);
  } catch (err) {
    console.error('[adblock] init failed:', err.message);
  }
}

function enableBlocking() {
  if (blocker && ses && !blockingActive) {
    blocker.enableBlockingInSession(ses);
    blockingActive = true;
  }
}
function disableBlocking() {
  if (blocker && ses && blockingActive) {
    try { blocker.disableBlockingInSession(ses); } catch {}
    blockingActive = false;
  }
}

async function addWhitelistFilters(host) {
  if (!blocker || whitelistFilters.has(host)) return;
  try {
    const { NetworkFilter } = await import('@ghostery/adblocker');
    const raws = [`@@*$domain=${host}`, `@@||${host}^$elemhide,generichide`];
    const filters = raws.map((r) => NetworkFilter.parse(r)).filter(Boolean);
    blocker.update({ newNetworkFilters: filters });
    whitelistFilters.set(host, filters);
  } catch (err) {
    console.error('[adblock] whitelist add failed', err.message);
  }
}

function removeWhitelistFilters(host) {
  const filters = whitelistFilters.get(host);
  if (!blocker || !filters) return;
  try {
    blocker.update({ removedNetworkFilters: filters.map((f) => f.getId()) });
  } catch (err) {
    console.error('[adblock] whitelist remove failed', err.message);
  }
  whitelistFilters.delete(host);
}

let statsTimer = null;
function throttleStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    broadcast('ab:stats', {
      total: settings.get('totalBlocked', 0),
      perTab: Object.fromEntries(tabBlockCounts),
    });
  }, 300);
}

// ---------------------------------------------------------------- history
function addHistory(url, title) {
  if (!url || url.startsWith('nova:') || url.startsWith('about:') || url.startsWith('devtools:')) return;
  const items = history.get('items', []);
  const last = items[0];
  if (last && last.url === url && Date.now() - last.ts < 30000) {
    last.title = title || last.title;
  } else {
    items.unshift({ url, title: title || url, ts: Date.now() });
    if (items.length > 8000) items.length = 8000;
  }
  history.set('items', items);
}

function topSites(limit = 8) {
  const counts = new Map();
  for (const it of history.get('items', [])) {
    let key;
    try { key = new URL(it.url).origin; } catch { continue; }
    const cur = counts.get(key) || { url: it.url, title: it.title, n: 0 };
    cur.n += 1;
    if (!cur.title || cur.title === cur.url) cur.title = it.title;
    counts.set(key, cur);
  }
  const top = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, limit);
  if (top.length < limit) {
    // Mit Favoriten auffüllen — Breitensuche, damit Top-Level-Links zuerst kommen
    const seen = new Set(top.map((t) => { try { return new URL(t.url).origin; } catch { return t.url; } }));
    const bfs = (roots) => {
      const acc = [];
      const queue = [...(roots || [])];
      while (queue.length) {
        const n = queue.shift();
        if (n.type === 'url') acc.push(n);
        else if (n.children) queue.push(...n.children);
      }
      return acc;
    };
    for (const b of bfs(bookmarks.get('tree', []))) {
      let origin; try { origin = new URL(b.url).origin; } catch { continue; }
      if (seen.has(origin)) continue;
      seen.add(origin);
      top.push({ url: b.url, title: b.name, n: 0 });
      if (top.length >= limit) break;
    }
  }
  return top;
}

// ---------------------------------------------------------------- bookmarks
function walkBookmarks(nodes, fn, parent = null) {
  for (const n of nodes || []) {
    if (fn(n, parent) === false) return false;
    if (n.children && walkBookmarks(n.children, fn, n) === false) return false;
  }
  return true;
}

function findBookmarkByUrl(url) {
  let found = null;
  walkBookmarks(bookmarks.get('tree', []), (n) => {
    if (n.type === 'url' && n.url === url) { found = n; return false; }
  });
  return found;
}

function removeBookmark(id) {
  const tree = bookmarks.get('tree', []);
  const prune = (nodes) => {
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx >= 0) { nodes.splice(idx, 1); return true; }
    return nodes.some((n) => n.children && prune(n.children));
  };
  prune(tree);
  bookmarks.set('tree', tree);
}

// ---------------------------------------------------------------- downloads
let globalDlLimit = 0; // Bytes/s, 0 = unbegrenzt (Summe aller Downloads)

function uniqueTarget(dir, name) {
  let target = path.join(dir, name || 'download');
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let i = 1;
  while (fs.existsSync(target)) target = path.join(dir, `${base} (${i++})${ext}`);
  return target;
}

// Wirksames Tempolimit eines Downloads: Minimum aus Einzel-Limit und
// (Gesamt-Limit / aktive Downloads). 0 = unbegrenzt.
function effectiveLimit(rec) {
  const per = rec.meta.limit || 0;
  let glob = 0;
  if (globalDlLimit > 0) {
    const active = [...downloads.values()].filter(
      (r) => r.meta.mode === 'custom' && r.meta.state === 'progressing' && !r.meta.paused,
    ).length || 1;
    glob = Math.floor(globalDlLimit / active);
  }
  if (per && glob) return Math.min(per, glob);
  return per || glob || 0;
}

let dlBroadcastTimer = null;
const dlDirty = new Set();
function scheduleDlBroadcast(rec) {
  dlDirty.add(rec);
  if (dlBroadcastTimer) return;
  dlBroadcastTimer = setTimeout(() => {
    dlBroadcastTimer = null;
    for (const r of dlDirty) broadcast('dl:update', r.meta);
    dlDirty.clear();
  }, 350);
}

// Token-Bucket-Drossel als Transform-Stream: gibt höchstens `limit` Bytes pro
// Sekunde weiter. Hält die Daten zurück (kein cb) → echte Backpressure bis zum
// TCP-Socket. Limit wird pro Chunk frisch abgefragt (live änderbar).
class ThrottleStream extends Transform {
  constructor(getLimit) { super(); this.getLimit = getLimit; this.win = { start: Date.now(), bytes: 0 }; }
  _transform(chunk, _enc, cb) {
    let offset = 0;
    const pump = () => {
      const limit = this.getLimit();
      if (!limit) { this.push(chunk.slice(offset)); return cb(); }
      const now = Date.now();
      if (now - this.win.start >= 1000) { this.win.start = now; this.win.bytes = 0; }
      const room = limit - this.win.bytes;
      if (room <= 0) { setTimeout(pump, Math.max(5, 1000 - (now - this.win.start))); return; }
      const take = Math.min(room, chunk.length - offset);
      this.push(chunk.slice(offset, offset + take));
      offset += take; this.win.bytes += take;
      if (offset < chunk.length) setTimeout(pump, Math.max(5, 1000 - (now - this.win.start)));
      else cb();
    };
    pump();
  }
}

// Eigener, gedrosselter Download über Node-http(s) mit echter Backpressure.
// Nutzt die Session-Cookies + Chrome-UA, folgt Redirects.
async function startCustomDownload(initialUrl, filename) {
  const id = ++dlCounter;
  let target = uniqueTarget(app.getPath('downloads'), filename);
  const meta = {
    id, file: path.basename(target), path: target, url: initialUrl,
    total: 0, received: 0, state: 'progressing', ts: Date.now(),
    paused: false, limit: 0, mode: 'custom',
  };
  const rec = { meta, cancelled: false, request: null, response: null, fileStream: null };
  downloads.set(id, rec);
  broadcast('dl:update', meta);

  // Cookies der Session mitsenden (für eingeloggte Downloads)
  let cookieHeader = '';
  try {
    const cookies = await ses.cookies.get({ url: initialUrl });
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {}
  if (rec.cancelled) return;

  const ua = ses.getUserAgent ? ses.getUserAgent() : '';
  const MAX_REDIRECT = 6;

  const doRequest = (urlStr, redirectsLeft) => {
    let u;
    try { u = new URL(urlStr); } catch { return fail(); }
    const mod = u.protocol === 'http:' ? http : https;
    const headers = { 'User-Agent': ua, 'Accept': '*/*' };
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    const request = mod.request(u, { method: 'GET', headers }, (response) => {
      const status = response.statusCode || 0;
      // Redirect folgen
      if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
        response.resume();
        const next = new URL(response.headers.location, u).toString();
        return doRequest(next, redirectsLeft - 1);
      }
      if (status >= 400) { return fail(); }
      rec.response = response;
      const cl = parseInt(response.headers['content-length'] || '0', 10) || 0;
      meta.total = cl;
      // Dateiname aus Content-Disposition übernehmen
      const cd = response.headers['content-disposition'];
      const m = cd && /filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i.exec(cd);
      if (m && m[1] && !filename) {
        try {
          const better = uniqueTarget(app.getPath('downloads'), decodeURIComponent(m[1]));
          target = better; meta.path = better; meta.file = path.basename(better);
        } catch {}
      }
      broadcast('dl:update', meta);

      const fileStream = fs.createWriteStream(target);
      rec.fileStream = fileStream;
      const throttle = new ThrottleStream(() => effectiveLimit(rec));
      rec.throttle = throttle;

      response.on('data', (chunk) => { meta.received += chunk.length; scheduleDlBroadcast(rec); });
      response.on('error', fail);
      response.pipe(throttle).pipe(fileStream);
      fileStream.on('finish', () => {
        if (rec.cancelled) return;
        meta.state = 'completed'; meta.received = meta.total || meta.received; broadcast('dl:update', meta);
      });
      fileStream.on('error', fail);
    });
    rec.request = request;
    request.on('error', fail);
    request.end();
  };

  function fail() {
    if (rec.cancelled || meta.state === 'completed') return;
    meta.state = 'interrupted';
    try { rec.fileStream && rec.fileStream.close(); } catch {}
    broadcast('dl:update', meta);
  }

  doRequest(initialUrl, MAX_REDIRECT);
  return rec;
}

function setupDownloads() {
  ses.on('will-download', (e, item) => {
    const url = item.getURL();
    // HTTP(S) -> eigener gedrosselter Downloader (Tempolimit steuerbar).
    if (/^https?:\/\//i.test(url)) {
      e.preventDefault();
      startCustomDownload(url, item.getFilename() || '');
      return;
    }
    // Sonst (blob:, data: …) -> nativer Electron-Download
    const id = ++dlCounter;
    const target = uniqueTarget(app.getPath('downloads'), item.getFilename() || 'download');
    item.setSavePath(target);
    const meta = {
      id, file: path.basename(target), path: target, url,
      total: item.getTotalBytes(), received: 0, state: 'progressing', ts: Date.now(), paused: false, limit: 0, mode: 'native',
    };
    downloads.set(id, { item, meta });
    broadcast('dl:update', meta);
    item.on('updated', (_ev, state) => {
      meta.received = item.getReceivedBytes();
      meta.total = item.getTotalBytes();
      meta.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      meta.paused = item.isPaused();
      broadcast('dl:update', meta);
    });
    item.once('done', (_ev, state) => {
      meta.received = item.getReceivedBytes();
      meta.state = state;
      broadcast('dl:update', meta);
    });
  });
}

// ---------------------------------------------------------------- network monitor
// Echte pro-Tab-Bandbreite über das DevTools-Protokoll (Network.dataReceived).
// Erfasst auch Streaming (4K-Video). Wird nur angehängt, solange das Monitor-
// Panel offen ist (kein Dauer-Overhead, kein Dauerkonflikt mit DevTools).
const netStats = new Map(); // wcId -> bytes im aktuellen Fenster
const netReq = new Map();   // wcId -> Anfragen im aktuellen Fenster
const netAttached = new Map(); // wcId -> handler
let netMonOn = false;
let netMonTimer = null;

function netAttach(wc) {
  if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || netAttached.has(wc.id)) return;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    const handler = (_e, method, params) => {
      if (method === 'Network.dataReceived') {
        const n = params.encodedDataLength || params.dataLength || 0;
        netStats.set(wc.id, (netStats.get(wc.id) || 0) + n);
      } else if (method === 'Network.requestWillBeSent') {
        netReq.set(wc.id, (netReq.get(wc.id) || 0) + 1);
      }
    };
    wc.debugger.on('message', handler);
    wc.debugger.sendCommand('Network.enable');
    netAttached.set(wc.id, { wc, handler });
  } catch { /* DevTools offen o. Ä. → Tab überspringen */ }
}
function netDetachAll() {
  for (const { wc, handler } of netAttached.values()) {
    try { wc.debugger.sendCommand('Network.disable'); } catch {}
    try { wc.debugger.removeListener('message', handler); } catch {}
    try { wc.debugger.detach(); } catch {}
  }
  netAttached.clear(); netStats.clear(); netReq.clear();
}
function startNetMon() {
  if (netMonOn) return;
  netMonOn = true;
  for (const wc of webContents.getAllWebContents()) netAttach(wc);
  netMonTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const tabs = []; let totalDown = 0, totalReq = 0;
    const ids = new Set([...netStats.keys(), ...netReq.keys()]);
    for (const wcId of ids) {
      const down = netStats.get(wcId) || 0, req = netReq.get(wcId) || 0;
      if (down > 0 || req > 0) { tabs.push({ wcId, down, req }); totalDown += down; totalReq += req; }
    }
    netStats.clear(); netReq.clear();
    broadcast('net:stats', { tabs, totalDown, totalReq, activeTabs: tabs.length });
  }, 1000);
}
function stopNetMon() {
  if (!netMonOn) return;
  netMonOn = false;
  clearInterval(netMonTimer); netMonTimer = null;
  netDetachAll();
}

// ---------------------------------------------------------------- context menu
function buildPageContextMenu(contents, params) {
  const items = [];
  const send = (channel, payload) => broadcast(channel, payload);

  if (params.linkURL) {
    items.push(
      { label: 'Link in neuem Tab öffnen', click: () => send('tabs:open', { url: params.linkURL, background: false }) },
      { label: 'Link in Hintergrund-Tab öffnen', click: () => send('tabs:open', { url: params.linkURL, background: true }) },
      { label: 'Link-Adresse kopieren', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' },
    );
  }
  if (params.hasImageContents || params.mediaType === 'image') {
    items.push(
      { label: 'Bild in neuem Tab öffnen', click: () => send('tabs:open', { url: params.srcURL, background: false }) },
      { label: 'Bild speichern', click: () => contents.downloadURL(params.srcURL) },
      { label: 'Bild-Adresse kopieren', click: () => clipboard.writeText(params.srcURL) },
      { type: 'separator' },
    );
  }
  if (params.selectionText) {
    const sel = params.selectionText.trim().slice(0, 60);
    items.push(
      { label: 'Kopieren', role: 'copy' },
      { label: `„${sel}${params.selectionText.trim().length > 60 ? '…' : ''}" suchen`,
        click: () => send('tabs:open', { url: searchUrl(params.selectionText.trim()), background: false }) },
      { type: 'separator' },
    );
  }
  if (params.isEditable) {
    items.push(
      { label: 'Ausschneiden', role: 'cut' },
      { label: 'Einfügen', role: 'paste' },
      { label: 'Alles auswählen', role: 'selectAll' },
      { type: 'separator' },
    );
  }
  items.push(
    { label: 'Zurück', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
    { label: 'Vorwärts', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
    { label: 'Neu laden', click: () => contents.reload() },
    { type: 'separator' },
    { label: 'Seitenquelltext anzeigen', click: () => send('tabs:open', { url: 'view-source:' + contents.getURL(), background: false }) },
    { label: 'Untersuchen', click: () => { contents.openDevTools(); contents.inspectElement(params.x, params.y); } },
  );
  Menu.buildFromTemplate(items).popup({ window: win });
}

function searchUrl(q) {
  const engines = {
    google: 'https://www.google.com/search?q=',
    ddg: 'https://duckduckgo.com/?q=',
    bing: 'https://www.bing.com/search?q=',
    brave: 'https://search.brave.com/search?q=',
  };
  return (engines[settings.get('searchEngine', 'google')] || engines.google) + encodeURIComponent(q);
}

// ---------------------------------------------------------------- shortcuts (aus Webviews)
const SHORTCUTS = [
  { ctrl: true, shift: true, key: 't', action: 'reopen-tab' },
  { ctrl: true, shift: true, key: 'tab', action: 'prev-tab' },
  { ctrl: true, shift: true, key: 'r', action: 'hard-reload' },
  { ctrl: true, shift: true, key: 's', action: 'screenshot' },
  { ctrl: true, shift: true, key: 'd', action: 'split' },
  { ctrl: true, shift: true, key: 'w', action: 'close-all-tabs' },
  { ctrl: true, shift: true, key: 'm', action: 'music' },
  { ctrl: true, shift: true, key: '/', action: 'cheatsheet' },
  { ctrl: true, key: '/', action: 'cheatsheet' },
  { key: 'f1', action: 'cheatsheet' },
  { ctrl: true, key: 't', action: 'new-tab' },
  { ctrl: true, key: 'w', action: 'close-tab' },
  { ctrl: true, key: 'tab', action: 'next-tab' },
  { ctrl: true, key: 'l', action: 'focus-omnibox' },
  { ctrl: true, key: 'k', action: 'palette' },
  { ctrl: true, key: 'e', action: 'palette' },
  { ctrl: true, key: 'f', action: 'find' },
  { ctrl: true, key: 'h', action: 'history' },
  { ctrl: true, key: 'j', action: 'downloads' },
  { ctrl: true, key: 'b', action: 'toggle-sidebar' },
  { ctrl: true, key: 'd', action: 'bookmark' },
  { ctrl: true, key: 'p', action: 'print' },
  { ctrl: true, key: 'r', action: 'reload' },
  { ctrl: true, key: '+', action: 'zoom-in' },
  { ctrl: true, key: '=', action: 'zoom-in' },
  { ctrl: true, key: '-', action: 'zoom-out' },
  { ctrl: true, key: '0', action: 'zoom-reset' },
  { key: 'f5', action: 'reload' },
  { key: 'f12', action: 'devtools' },
  { key: 'f11', action: 'fullscreen' },
  { alt: true, key: 'arrowleft', action: 'nav-back' },
  { alt: true, key: 'arrowright', action: 'nav-forward' },
];

function matchShortcut(input) {
  if (input.type !== 'keyDown') return null;
  const key = (input.key || '').toLowerCase();
  for (const s of SHORTCUTS) {
    if (!!s.ctrl !== !!input.control) continue;
    if (!!s.shift !== !!input.shift) continue;
    if (!!s.alt !== !!input.alt) continue;
    if (s.key !== key) continue;
    return s.action;
  }
  // Ziffern über input.code matchen (key wäre bei Shift layoutabhängig, z. B. '!')
  const dm = /^Digit([1-9])$/.exec(input.code || '');
  if (input.control && !input.alt && dm) return (input.shift ? 'space-' : 'tab-') + dm[1];
  return null;
}

// ---------------------------------------------------------------- web contents wiring
app.on('web-contents-created', (_e, contents) => {
  // Electron hängt pro <webview> intern Listener an WebContents — bei vielen
  // Tabs überschreitet das das Standardlimit von 10. Limit aufheben.
  contents.setMaxListeners(0);
  if (contents.getType() !== 'webview') return;

  // Läuft der Netzwerk-Monitor, neue Tabs sofort mit erfassen
  if (netMonOn) contents.once('dom-ready', () => netAttach(contents));

  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (/^https?:|^about:blank/i.test(url)) {
      broadcast('tabs:open', { url, background: disposition === 'background-tab', openerId: contents.id });
    }
    return { action: 'deny' };
  });

  contents.on('context-menu', (_ev, params) => buildPageContextMenu(contents, params));

  contents.on('before-input-event', (ev, input) => {
    const action = matchShortcut(input);
    if (action) {
      ev.preventDefault();
      broadcast('shortcut', action);
    }
  });

  const sendAudio = () => broadcast('tab:audio', { wcId: contents.id, audible: contents.isCurrentlyAudible() });
  contents.on('media-started-playing', sendAudio);
  contents.on('media-paused', () => setTimeout(() => { if (!contents.isDestroyed()) sendAudio(); }, 300));

  contents.on('destroyed', () => {
    tabBlockCounts.delete(contents.id);
    tabBlockHosts.delete(contents.id);
  });
});

// ---------------------------------------------------------------- window
function createWindow() {
  const iconPng = path.join(app.getPath('userData'), 'icon.png');
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundColor: '#07070e',
    icon: fs.existsSync(iconPng) ? iconPng : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
    },
  });

  // Jeder <webview> hängt intern Listener an den Host-WebContents — bei vielen
  // Tabs sprengt das Electrons Standard-Limit von 10 und spammt Warnungen.
  win.webContents.setMaxListeners(0);

  // Taskleisten-/Fenster-Icon zuverlässig setzen: PNG bevorzugt die ICO (für
  // Windows-Taskleiste am robustesten), per nativeImage explizit anwenden.
  function applyWindowIcon() {
    try {
      const ico = path.join(app.getPath('userData'), 'icon.ico');
      const png = path.join(app.getPath('userData'), 'icon.png');
      let img = null;
      if (fs.existsSync(png)) img = nativeImage.createFromPath(png);
      if ((!img || img.isEmpty()) && fs.existsSync(ico)) img = nativeImage.createFromPath(ico);
      if (img && !img.isEmpty() && win && !win.isDestroyed()) win.setIcon(img);
    } catch (err) { console.error('[icon] apply failed', err.message); }
  }
  applyWindowIcon();

  win.loadFile(path.join(UI_DIR, 'index.html'));
  win.once('ready-to-show', () => { win.show(); applyWindowIcon(); });

  if (process.env.NOVA_SHOT) {
    win.setPosition(0, 0);
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log('[renderer]', message);
    });
    win.webContents.once('did-finish-load', () => {
      if (process.env.NOVA_EXEC) {
        setTimeout(() => {
          win.webContents.executeJavaScript(process.env.NOVA_EXEC)
            .then((r) => console.log('[exec]', r))
            .catch((e) => console.error('[exec]', e.message));
        }, 2500);
      }
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.NOVA_SHOT, img.toPNG());
          console.log('[shot] saved', process.env.NOVA_SHOT);
          const { webContents } = require('electron');
          let i = 0;
          for (const wc of webContents.getAllWebContents()) {
            if (wc.getType() === 'webview') {
              console.log('[shot] webview url:', wc.getURL());
              const wimg = await wc.capturePage();
              fs.writeFileSync(process.env.NOVA_SHOT.replace('.png', `-wv${i++}.png`), wimg.toPNG());
            }
          }
        } catch (e) { console.error('[shot]', e.message); }
        if (process.env.NOVA_EXIT) app.quit();
      }, 6000);
    });
  }
  win.on('maximize', () => broadcast('win:maximized', true));
  win.on('unmaximize', () => broadcast('win:maximized', false));
  win.on('enter-full-screen', () => broadcast('win:fullscreen', true));
  win.on('leave-full-screen', () => broadcast('win:fullscreen', false));
  win.on('closed', () => { win = null; });

  win.webContents.on('before-input-event', (ev, input) => {
    // Shortcuts auch abfangen, wenn der Fokus in der Chrome-UI liegt
    const action = matchShortcut(input);
    if (action && !['reload', 'hard-reload'].includes(action)) {
      // reload würde sonst die Chrome-UI neu laden
      ev.preventDefault();
      broadcast('shortcut', action);
    } else if (action) {
      ev.preventDefault();
      broadcast('shortcut', action);
    }
  });
}

// ---------------------------------------------------------------- app ready
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  // Widevine-DRM (castLabs-Electron-Build): nötig, damit Spotify & Apple Music
  // tatsächlich Töne abspielen. Auf einem Standard-Electron ohne `components`
  // läuft der Browser normal weiter (nur ohne DRM-Wiedergabe).
  if (components && typeof components.whenReady === 'function') {
    try {
      await components.whenReady();
      const status = components.status ? components.status() : {};
      const wv = status['Widevine Content Decryption Module'] || status.WidevineCdm;
      widevineState = { available: true, ready: true, status: wv || 'geladen' };
      console.log('[widevine] bereit:', status);
    } catch (err) {
      widevineState = { available: true, ready: false, status: 'Fehler: ' + err.message };
      console.error('[widevine] konnte nicht geladen werden:', err.message);
    }
  } else {
    widevineState = { available: false, ready: false, status: 'Standard-Electron ohne Widevine' };
    console.warn('[widevine] Standard-Electron erkannt — DRM-Wiedergabe (Spotify/Apple Music) deaktiviert. Für Musik: castLabs-Electron installieren.');
  }

  settings = new JsonStore(path.join(app.getPath('userData'), 'settings.json'), DEFAULT_SETTINGS);
  bookmarks = new JsonStore(path.join(app.getPath('userData'), 'bookmarks.json'), { tree: [] });
  history = new JsonStore(path.join(app.getPath('userData'), 'history.json'), { items: [] });
  securityDb = new JsonStore(path.join(app.getPath('userData'), 'security-db.json'), {});   // host → Security-Report
  globalDlLimit = settings.get('dlGlobalLimit', 0) || 0;
  setTimeout(() => { secPull(); }, 4000);                 // geteilte Security-DB beim Start holen
  setInterval(() => { secPull(); }, 6 * 60 * 60 * 1000);  // danach alle 6 h aktualisieren

  nativeTheme.themeSource = settings.get('forceDarkWeb', true) ? 'dark' : 'system';

  // Edge-Favoriten beim ersten Start automatisch übernehmen
  if (!settings.get('edgeImported', false)) {
    const res = importEdgeBookmarks();
    if (res.ok) {
      bookmarks.set('tree', res.tree);
      settings.set('edgeImported', true);
      console.log(`[import] ${res.count} Edge-Favoriten importiert`);
    }
  }

  // nova:// Protokoll (liefert auch Assets wie Fonts aus)
  const studioDataDir = path.join(app.getPath('userData'), 'studio');
  const novaFallback = () => net.fetch(pathToFileURL(path.join(UI_DIR, 'newtab.html')).toString());
  const novaHandler = (req) => {
    try {
      const u = new URL(req.url);
      let p = decodeURIComponent(u.pathname || '/');
      // NOVA Studio (contained Windows-VM) als eigene Seite
      if (u.hostname === 'studio' && (p === '/' || p === '')) {
        return net.fetch(pathToFileURL(path.join(UI_DIR, 'studio.html')).toString());
      }
      // Heruntergeladene VM-Images aus dem Container-Verzeichnis (außerhalb von UI_DIR) ausliefern
      if (u.hostname === 'studio-data') {
        const f = path.normalize(path.join(studioDataDir, p));
        if (!f.startsWith(studioDataDir)) return new Response('forbidden', { status: 403 });
        if (fs.existsSync(f) && fs.statSync(f).isFile()) return net.fetch(pathToFileURL(f).toString());
        return new Response('not found', { status: 404 });
      }
      if (p === '/' || p === '') return novaFallback();
      const file = path.normalize(path.join(UI_DIR, p));
      if (!file.startsWith(UI_DIR)) return new Response('forbidden', { status: 403 });
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        return net.fetch(pathToFileURL(file).toString());
      }
      return novaFallback();
    } catch {
      return novaFallback();
    }
  };
  protocol.handle('nova', novaHandler);

  ses = session.fromPartition(PARTITION);
  // Auch in der Webview-Session registrieren (eigener Protokoll-Namespace)
  ses.protocol.handle('nova', novaHandler);
  // Chrome-UA ohne Electron-Kennung (bessere Website-Kompatibilität)
  const chromeUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
  ses.setUserAgent(chromeUA);

  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    const allowed = ['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'media', 'mediaKeySystem'];
    cb(allowed.includes(permission));
  });

  // Eigene, persistente Session für den Musik-Player (Spotify & Apple Music
  // bleiben angemeldet). Gleicher Chrome-UA, Adblock greift hier NICHT, damit
  // die Web-Player nicht beeinträchtigt werden.
  const musicSes = session.fromPartition('persist:nova-music');
  musicSes.setUserAgent(chromeUA);
  musicSes.setPermissionRequestHandler((_wc, permission, cb) => {
    const allowed = ['fullscreen', 'media', 'mediaKeySystem', 'clipboard-sanitized-write', 'pointerLock', 'notifications'];
    cb(allowed.includes(permission));
  });

  // Eigene, persistente Session für die Claude-Integration (claude.ai-Login bleibt
  // erhalten). Adblock greift hier NICHT. Chrome-UA für volle Kompatibilität.
  const claudeSes = session.fromPartition('persist:nova-claude');
  claudeSes.setUserAgent(chromeUA);
  claudeSes.setPermissionRequestHandler((_wc, permission, cb) => {
    const allowed = ['fullscreen', 'clipboard-sanitized-write', 'clipboard-read', 'media', 'notifications', 'pointerLock'];
    cb(allowed.includes(permission));
  });

  // ---- Google/YouTube-Login: User-Agent Client Hints säubern ----
  // Google blockt Sign-in ("Browser nicht unterstützt/sicher"), wenn es im UA ODER in den
  // Sec-CH-UA-Client-Hints die Marke "Electron"/Headless erkennt. Wir erzwingen den sauberen
  // Chrome-UA und schreiben die Brand-Hints auf echtes Google Chrome um.
  const chMajor = String(process.versions.chrome || '138').split('.')[0];
  const chFull = process.versions.chrome || (chMajor + '.0.0.0');
  const chBrand = `"Chromium";v="${chMajor}", "Google Chrome";v="${chMajor}", "Not.A/Brand";v="24"`;
  const chBrandFull = `"Chromium";v="${chFull}", "Google Chrome";v="${chFull}", "Not.A/Brand";v="24.0.0.0"`;
  function cleanClientHints(s) {
    s.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      for (const k of Object.keys(h)) {
        const lk = k.toLowerCase();
        if (lk === 'user-agent') h[k] = chromeUA;
        else if (lk === 'sec-ch-ua') h[k] = chBrand;
        else if (lk === 'sec-ch-ua-full-version-list') h[k] = chBrandFull;
      }
      cb({ requestHeaders: h });
    });
  }
  cleanClientHints(ses);
  cleanClientHints(musicSes);

  setupDownloads();
  createWindow();
  initAdblock(); // läuft asynchron weiter
  loadStoredExtensions(); // gespeicherte Chrome-Erweiterungen laden (asynchron)

  // Start-Menü-Verknüpfung sicherstellen → korrektes Taskleisten-Icon (auch angeheftet)
  if (process.platform === 'win32') {
    setTimeout(() => { try { ensureStartMenuShortcut(); } catch {} }, 2500);
  }

  // Beim Start einmal nach Updates schauen (nur Hinweis, kein Auto-Neustart)
  setTimeout(async () => {
    const r = await checkUpdate();
    if (r && r.available) broadcast('update:available', r);
  }, 6000);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

function flushAll() {
  try { settings?.flush(); } catch {}
  try { bookmarks?.flush(); } catch {}
  try { history?.flush(); } catch {}
}
app.on('window-all-closed', () => { flushAll(); app.quit(); });
app.on('before-quit', flushAll);
app.on('will-quit', flushAll);

// ================================================================ IPC
ipcMain.handle('ui:ready', () => {
  const startUrl = urlFromArgv(process.argv);
  return {
    settings: settings.data,
    bookmarks: bookmarks.get('tree', []),
    sessionTabs: settings.get('lastSession', []),
    startUrl,
    webviewPreload: pathToFileURL(path.join(__dirname, 'webview-preload.js')).toString(),
    versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome },
    totalBlocked: settings.get('totalBlocked', 0),
    isMaximized: win?.isMaximized() || false,
  };
});

// Fenster
ipcMain.on('win:min', () => win?.minimize());
ipcMain.on('win:max', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
ipcMain.on('win:close', () => win?.close());
ipcMain.on('win:fullscreen', () => win?.setFullScreen(!win.isFullScreen()));

// Einstellungen
ipcMain.handle('settings:set', (_e, patch) => {
  settings.merge(patch);
  if ('forceDarkWeb' in patch) nativeTheme.themeSource = patch.forceDarkWeb ? 'dark' : 'system';
  if ('adblockEnabled' in patch) patch.adblockEnabled ? enableBlocking() : disableBlocking();
  // Listen-/Cosmetic-Änderungen erfordern einen Engine-Neuaufbau
  if ('filterLists' in patch || 'cosmeticEnabled' in patch) rebuildAdblock();
  else if ('customFilters' in patch) applyCustomFilters();
  broadcast('settings:changed', settings.data);
  return settings.data;
});

// ---------------------------------------------------------------- Plugins
// Aktive Konfiguration für die Webview-Preload (synchron, läuft beim Seitenstart).
ipcMain.on('plugins:getActive', (e) => {
  e.returnValue = {
    native: nativePluginState(),
    userscripts: (settings.get('userscripts', []) || []).filter((u) => u && u.enabled && u.code),
  };
});

ipcMain.handle('plugins:state', () => ({
  native: nativePluginState(),
  userscripts: settings.get('userscripts', []) || [],
  extensions: settings.get('extensions', []) || [],
}));

// Toolbar-Icons (browser actions) der geladenen Erweiterungen für die Topbar.
function pickActionIcon(manifest) {
  const a = manifest.action || manifest.browser_action || {};
  const di = a.default_icon || manifest.icons || null;
  if (!di) return null;
  if (typeof di === 'string') return di;
  for (const s of ['32', '48', '38', '24', '128', '16']) if (di[s]) return di[s];
  const k = Object.keys(di)[0];
  return k ? di[k] : null;
}
ipcMain.handle('plugins:actions', () => {
  if (!ses || !ses.getAllExtensions) return [];
  const out = [];
  for (const e of ses.getAllExtensions()) {
    const m = e.manifest || {};
    const a = m.action || m.browser_action;
    if (!a) continue; // nur Erweiterungen mit Toolbar-Button
    let iconData = null;
    const rel = pickActionIcon(m);
    if (rel) {
      try {
        const p = path.join(e.path, String(rel).replace(/^\/+/, ''));
        if (fs.existsSync(p)) {
          const ext = path.extname(p).slice(1).toLowerCase();
          const mime = ext === 'svg' ? 'image/svg+xml' : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : 'image/png';
          iconData = 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64');
        }
      } catch {}
    }
    // Popup-URL bestimmen: bevorzugt default_popup, sonst eine sinnvolle Einstiegsseite
    // raten (viele Erweiterungen wie NordPass deklarieren keinen Popup, sondern öffnen
    // ihre UI per Klick-Handler → wir öffnen ihre Hauptseite app.html/popup.html/index.html).
    let popupRel = a.default_popup ? String(a.default_popup).replace(/^\/+/, '') : null;
    if (!popupRel) {
      for (const cand of ['popup.html', 'popup/popup.html', 'popup/index.html', 'app.html', 'index.html', 'main.html', 'dialog.html', 'page.html']) {
        if (fs.existsSync(path.join(e.path, cand))) { popupRel = cand; break; }
      }
    }
    const popup = popupRel ? e.url + popupRel : null;
    out.push({ id: e.id, name: e.name, title: a.default_title || e.name, icon: iconData, popup });
  }
  return out;
});

ipcMain.handle('plugins:setNative', (_e, { id, on }) => {
  const p = { ...(settings.get('plugins', {}) || {}) };
  p[id] = !!on;
  settings.set('plugins', p);
  broadcast('settings:changed', settings.data);
  return nativePluginState();
});

function uid() { return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

ipcMain.handle('plugins:saveUserscript', (_e, script) => {
  const list = (settings.get('userscripts', []) || []).slice();
  const clean = {
    id: script.id || uid(),
    name: (script.name || 'Neues Skript').slice(0, 80),
    code: String(script.code || ''),
    matches: (script.matches || '*').trim() || '*',
    enabled: script.enabled !== false,
  };
  const i = list.findIndex((u) => u.id === clean.id);
  if (i >= 0) list[i] = clean; else list.push(clean);
  settings.set('userscripts', list);
  return list;
});

ipcMain.handle('plugins:removeUserscript', (_e, id) => {
  const list = (settings.get('userscripts', []) || []).filter((u) => u.id !== id);
  settings.set('userscripts', list);
  return list;
});

ipcMain.handle('plugins:toggleUserscript', (_e, { id, on }) => {
  const list = (settings.get('userscripts', []) || []).map((u) => (u.id === id ? { ...u, enabled: !!on } : u));
  settings.set('userscripts', list);
  return list;
});

// Echte (entpackte) Chrome-Erweiterung über einen Ordner-Dialog laden.
ipcMain.handle('plugins:loadExtension', async () => {
  if (!ses) return { ok: false, error: 'Session nicht bereit' };
  const r = await dialog.showOpenDialog(win, {
    title: 'Entpackte Erweiterung laden (Ordner mit manifest.json)',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  const dir = r.filePaths[0];
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    return { ok: false, error: 'Kein manifest.json im gewählten Ordner gefunden.' };
  }
  try {
    const ext = await ses.loadExtension(dir, { allowFileAccess: true });
    const list = (settings.get('extensions', []) || []).filter((x) => x.path !== dir);
    const entry = { id: ext.id, name: ext.name, version: ext.version, path: dir, enabled: true };
    list.push(entry);
    settings.set('extensions', list);
    broadcast('plugins:actionsChanged');
    return { ok: true, ext: entry };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('plugins:removeExtension', (_e, id) => {
  try { if (ses) ses.removeExtension(id); } catch {}
  const list = (settings.get('extensions', []) || []).filter((x) => x.id !== id);
  settings.set('extensions', list);
  broadcast('plugins:actionsChanged');
  return list;
});

ipcMain.handle('plugins:toggleExtension', async (_e, { id, on }) => {
  const list = (settings.get('extensions', []) || []).slice();
  const ext = list.find((x) => x.id === id);
  if (!ext) return list;
  try {
    if (on) { if (ses) await ses.loadExtension(ext.path, { allowFileAccess: true }); }
    else { if (ses) ses.removeExtension(id); }
    ext.enabled = !!on;
    settings.set('extensions', list);
  } catch (err) { ext.error = err.message; }
  broadcast('plugins:actionsChanged');
  return list;
});

// ---- Echte Chrome-Web-Store-Erweiterung installieren (CRX laden → entpacken → laden) ----
// Extension-ID aus einer Store-URL oder Roh-Eingabe ziehen (32 Zeichen a–p).
function parseExtId(input) {
  const s = String(input || '').trim();
  const m = s.match(/([a-p]{32})/i);
  return m ? m[1].toLowerCase() : null;
}

// CRX-Container (Cr24, v2/v3) auf das enthaltene ZIP zurechtschneiden.
function crxToZip(buf) {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return buf; // schon ZIP (PK)
  if (!(buf[0] === 0x43 && buf[1] === 0x72 && buf[2] === 0x32 && buf[3] === 0x34)) {
    throw new Error('Antwort ist keine CRX-Datei (evtl. Erweiterung nicht verfügbar).');
  }
  const version = buf.readUInt32LE(4);
  if (version === 3) { const headerLen = buf.readUInt32LE(8); return buf.subarray(12 + headerLen); }
  if (version === 2) { const pub = buf.readUInt32LE(8), sig = buf.readUInt32LE(12); return buf.subarray(16 + pub + sig); }
  throw new Error('Unbekannte CRX-Version ' + version);
}

// Minimaler ZIP-Entpacker (Store + Deflate) ohne externe Abhängigkeit.
function unzipTo(buf, dest) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP: Zentralverzeichnis nicht gefunden');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const destAbs = path.resolve(dest);
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(lho) !== 0x04034b50) continue;
    const lName = buf.readUInt16LE(lho + 26);
    const lExtra = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lName + lExtra;
    const outPath = path.join(dest, name);
    if (!path.resolve(outPath).startsWith(destAbs)) continue; // Zip-Slip-Schutz
    if (name.endsWith('/')) { fs.mkdirSync(outPath, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) { try { data = zlib.inflateRawSync(raw); } catch { continue; } }
    else continue;
    fs.writeFileSync(outPath, data);
  }
}

async function installChromeExtension(idOrUrl) {
  if (!ses) return { ok: false, error: 'Session nicht bereit' };
  const id = parseExtId(idOrUrl);
  if (!id) return { ok: false, error: 'Keine gültige Erweiterungs-ID/URL erkannt.' };
  const ver = process.versions.chrome || '120.0.0.0';
  const url = 'https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3'
    + '&prodversion=' + encodeURIComponent(ver)
    + '&x=' + encodeURIComponent('id=' + id + '&installsource=ondemand&uc');
  try {
    const res = await net.fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36` },
    });
    if (!res.ok) return { ok: false, error: 'Download fehlgeschlagen (HTTP ' + res.status + ')' };
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = crxToZip(buf);
    const dir = path.join(app.getPath('userData'), 'extensions', id);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(dir, { recursive: true });
    unzipTo(zip, dir);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) return { ok: false, error: 'Im Paket wurde keine manifest.json gefunden.' };
    const ext = await ses.loadExtension(dir, { allowFileAccess: true });
    const list = (settings.get('extensions', []) || []).filter((x) => x.id !== ext.id && x.storeId !== id);
    const entry = { id: ext.id, name: ext.name, version: ext.version, path: dir, enabled: true, source: 'store', storeId: id };
    list.push(entry);
    settings.set('extensions', list);
    broadcast('plugins:actionsChanged');
    return { ok: true, ext: entry };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('plugins:installFromStore', (_e, idOrUrl) => installChromeExtension(idOrUrl));

// Von einer Chrome-Web-Store-Seite aus installieren (Button wird per webview-preload
// auf der Store-Seite eingeblendet) → Ergebnis als Toast ans Chrome-Fenster.
ipcMain.on('plugins:installFromPage', async (_e, idOrUrl) => {
  const r = await installChromeExtension(idOrUrl);
  broadcast('plugins:installed', r);
});

// Beim Start alle aktivierten Erweiterungen in die Haupt-Session laden.
async function loadStoredExtensions() {
  if (!ses) return;
  const list = (settings.get('extensions', []) || []).slice();
  let changed = false;
  for (const ext of list) {
    if (ext.enabled === false) continue;
    try {
      if (fs.existsSync(path.join(ext.path, 'manifest.json'))) {
        const loaded = await ses.loadExtension(ext.path, { allowFileAccess: true });
        ext.id = loaded.id; ext.name = loaded.name; delete ext.error;
      } else { ext.error = 'Ordner fehlt'; }
    } catch (err) { ext.error = err.message; }
    changed = true;
  }
  if (changed) settings.set('extensions', list);
  broadcast('plugins:actionsChanged');
}

// Adblock
let adblockBusy = false;
async function rebuildAdblock() {
  if (adblockBusy) return false;
  adblockBusy = true;
  try {
    disableBlocking();
    blocker = null;
    try { fs.unlinkSync(path.join(app.getPath('userData'), ADBLOCK_CACHE)); } catch {}
    await initAdblock();
    return !!blocker;
  } catch (err) {
    console.error('[adblock] rebuild failed', err.message);
    return false;
  } finally {
    adblockBusy = false;
  }
}
ipcMain.handle('ab:catalog', () => {
  const map = enabledFilterMap();
  return Object.entries(FILTER_CATALOG).map(([key, v]) => ({ key, name: v.name, enabled: map[key] }));
});
ipcMain.handle('ab:site', async (_e, { host, allow }) => {
  const list = new Set(settings.get('whitelist', []));
  if (allow) { list.add(host); await addWhitelistFilters(host); }
  else { list.delete(host); removeWhitelistFilters(host); }
  settings.set('whitelist', [...list]);
  return [...list];
});
ipcMain.on('ab:resetTab', (_e, wcId) => { tabBlockCounts.set(wcId, 0); tabBlockHosts.delete(wcId); });
ipcMain.handle('ab:tabDetail', (_e, wcId) => {
  const hosts = tabBlockHosts.get(wcId);
  if (!hosts) return [];
  return [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([host, n]) => ({ host, n }));
});
ipcMain.handle('ab:refresh', () => rebuildAdblock());

// Widevine-/DRM-Status (für den Musik-Player)
ipcMain.handle('music:drm', () => widevineState);
// Medientaste an einen Musik-Webview senden (löst dessen MediaSession-Handler
// aus → zuverlässig für Spotify & Apple Music, auch über Shadow-DOM hinweg).
ipcMain.on('music:mediaKey', (_e, { wcId, key }) => {
  try {
    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) return;
    wc.sendInputEvent({ type: 'keyDown', keyCode: key });
    wc.sendInputEvent({ type: 'keyUp', keyCode: key });
  } catch {}
});

// ECHTE Hardware-Medientaste auf Systemebene auslösen (Win32 keybd_event). Das ist
// exakt das, was die Multimedia-Tasten der Tastatur tun → Chromium routet es an die
// aktive MediaSession (= der spielende Musik-Webview). Funktioniert für Apple Music,
// wo DOM-Klicks/synthetische Tasten nicht greifen.
let hwKeyBusy = false;
ipcMain.on('music:hwMediaKey', (_e, which) => {
  if (process.platform !== 'win32' || hwKeyBusy) return;
  const VK = which === 'next' ? '0xB0' : which === 'prev' ? '0xB1' : which === 'playpause' ? '0xB3' : null;
  if (!VK) return;
  hwKeyBusy = true;
  // KEYEVENTF_EXTENDEDKEY(0x1) für Medientasten, KEYEVENTF_KEYUP(0x2) beim Loslassen.
  const ps = `Add-Type -Namespace NovaMk -Name K -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);' -ErrorAction SilentlyContinue; [NovaMk.K]::keybd_event(${VK},0,1,[System.UIntPtr]::Zero); [NovaMk.K]::keybd_event(${VK},0,3,[System.UIntPtr]::Zero)`;
  try {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      { windowsHide: true, timeout: 4000 }, () => { hwKeyBusy = false; });
  } catch { hwKeyBusy = false; }
});

// Suche / Vorschläge
async function fetchJson(url, ms = 4000, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: headers || undefined });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSuggestions(q) {
  if (!q || q.length < 2) return [];
  const engine = settings.get('searchEngine', 'google');
  const urls = {
    google: `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`,
    bing: `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`,
    ddg: `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`,
    brave: `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`,
  };
  try {
    const json = await fetchJson(urls[engine] || urls.google, 1500);
    return Array.isArray(json?.[1]) ? json[1].slice(0, 6) : [];
  } catch { return []; }
}
ipcMain.handle('omni:suggest', (_e, q) => fetchSuggestions(q));
ipcMain.handle('omni:searchUrl', (_e, q) => searchUrl(q));

// Wetter (open-meteo, 15-min-Cache)
let weatherCache = { ts: 0, key: '', data: null };
async function getWeather() {
  if (!settings.get('weatherEnabled', true)) return null;
  const city = (settings.get('weatherCity', '') || '').trim();
  const key = city || '@auto';
  if (weatherCache.data && weatherCache.key === key && Date.now() - weatherCache.ts < 15 * 60000) {
    return weatherCache.data;
  }
  try {
    let lat, lon, label;
    if (city) {
      const g = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=de`);
      const r = g?.results?.[0];
      if (!r) return null;
      lat = r.latitude; lon = r.longitude; label = r.name;
    } else {
      // IP-Lokalisierung mit Fallback-Kette
      try {
        const ip = await fetchJson('http://ip-api.com/json/?fields=status,city,lat,lon');
        if (ip?.status === 'success') { lat = ip.lat; lon = ip.lon; label = ip.city; }
      } catch {}
      if (lat == null) {
        try {
          const ip = await fetchJson('https://ipapi.co/json/');
          if (ip?.latitude != null) { lat = ip.latitude; lon = ip.longitude; label = ip.city; }
        } catch {}
      }
      if (lat == null) return null;
    }
    const w = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`);
    if (!w?.current) return null;
    const data = { temp: Math.round(w.current.temperature_2m), code: w.current.weather_code, city: label || '' };
    weatherCache = { ts: Date.now(), key, data };
    return data;
  } catch { return null; }
}

// Speed-Dial: gepinnte Dials + automatische Top-Sites
function originOf(url) { try { return new URL(url).origin; } catch { return null; } }
function buildDials(limit = 10) {
  const pinned = settings.get('dials', []).map((d) => ({ ...d, pinned: true }));
  const hidden = new Set(settings.get('dialHidden', []));
  const seen = new Set(pinned.map((d) => originOf(d.url)).filter(Boolean));
  const out = [...pinned];
  for (const t of topSites(18)) {
    if (out.length >= limit) break;
    const o = originOf(t.url);
    if (!o || seen.has(o) || hidden.has(o)) continue;
    seen.add(o);
    out.push({ name: t.title, url: t.url, pinned: false });
  }
  return out.slice(0, limit);
}

// Verlauf
ipcMain.on('history:add', (_e, { url, title }) => addHistory(url, title));
ipcMain.handle('history:query', (_e, { q = '', limit = 300 } = {}) => {
  const items = history.get('items', []);
  if (!q) return items.slice(0, limit);
  const needle = q.toLowerCase();
  return items.filter((it) => (it.title || '').toLowerCase().includes(needle) || it.url.toLowerCase().includes(needle)).slice(0, limit);
});
ipcMain.handle('history:delete', (_e, url) => {
  history.set('items', history.get('items', []).filter((it) => it.url !== url));
  return true;
});
ipcMain.handle('history:clear', () => { history.set('items', []); return true; });
ipcMain.handle('history:top', (_e, limit) => topSites(limit || 8));

// Favoriten
ipcMain.handle('bm:get', () => bookmarks.get('tree', []));
ipcMain.handle('bm:add', (_e, { url, title, folderId }) => {
  const tree = bookmarks.get('tree', []);
  const node = { id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: 'url', name: title || url, url };
  let placed = false;
  if (folderId) {
    walkBookmarks(tree, (n) => {
      if (n.id === folderId && n.type === 'folder') { n.children.push(node); placed = true; return false; }
    });
  }
  if (!placed) {
    let bar = tree.find((n) => n.type === 'folder');
    if (!bar) { bar = { id: 'root_bar', type: 'folder', name: 'Favoritenleiste', open: true, children: [] }; tree.unshift(bar); }
    bar.children.push(node);
  }
  bookmarks.set('tree', tree);
  broadcast('bm:changed', tree);
  return node;
});
ipcMain.handle('bm:remove', (_e, id) => {
  removeBookmark(id);
  broadcast('bm:changed', bookmarks.get('tree', []));
  return true;
});
ipcMain.handle('bm:rename', (_e, { id, name }) => {
  const tree = bookmarks.get('tree', []);
  walkBookmarks(tree, (n) => { if (n.id === id) { n.name = name; return false; } });
  bookmarks.set('tree', tree);
  broadcast('bm:changed', tree);
  return true;
});
ipcMain.handle('bm:setOpen', (_e, { id, open }) => {
  const tree = bookmarks.get('tree', []);
  walkBookmarks(tree, (n) => { if (n.id === id) { n.open = open; return false; } });
  bookmarks.set('tree', tree);
  return true;
});
ipcMain.handle('bm:find', (_e, url) => findBookmarkByUrl(url));
ipcMain.handle('bm:createFolder', (_e, { name, parentId }) => {
  const tree = bookmarks.get('tree', []);
  const folder = { id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: 'folder', name: name || 'Neuer Ordner', open: true, children: [] };
  let placed = false;
  if (parentId) {
    walkBookmarks(tree, (n) => { if (n.id === parentId && n.type === 'folder') { n.children.unshift(folder); placed = true; return false; } });
  }
  if (!placed) tree.unshift(folder);
  bookmarks.set('tree', tree);
  broadcast('bm:changed', tree);
  return folder;
});
// Knoten verschieben: in einen Zielordner an Position index (oder ans Ende).
ipcMain.handle('bm:move', (_e, { id, targetParentId, index }) => {
  const tree = bookmarks.get('tree', []);
  // Knoten + aktuelle Elternliste finden und herauslösen
  let moved = null;
  const detach = (list) => {
    const i = list.findIndex((n) => n.id === id);
    if (i >= 0) { moved = list[i]; list.splice(i, 1); return true; }
    return list.some((n) => n.children && detach(n.children));
  };
  detach(tree);
  if (!moved) return false;
  // Verhindern, dass ein Ordner in sich selbst verschoben wird
  if (moved.type === 'folder' && targetParentId) {
    let bad = false;
    walkBookmarks([moved], (n) => { if (n.id === targetParentId) bad = true; });
    if (bad) { bookmarks.set('tree', tree); broadcast('bm:changed', tree); return false; }
  }
  let targetList = tree;
  if (targetParentId) {
    walkBookmarks(tree, (n) => { if (n.id === targetParentId && n.type === 'folder') { targetList = n.children; n.open = true; return false; } });
  }
  if (typeof index === 'number' && index >= 0 && index <= targetList.length) targetList.splice(index, 0, moved);
  else targetList.push(moved);
  bookmarks.set('tree', tree);
  broadcast('bm:changed', tree);
  return true;
});
ipcMain.handle('bm:export', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: 'nova-favoriten.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, JSON.stringify(bookmarks.get('tree', []), null, 2));
  return true;
});
ipcMain.handle('bm:importJson', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths?.[0]) return { ok: false };
  try {
    const tree = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (!Array.isArray(tree)) return { ok: false, error: 'Ungültiges Format' };
    bookmarks.set('tree', tree);
    broadcast('bm:changed', tree);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('bm:importEdge', () => {
  const res = importEdgeBookmarks();
  if (res.ok) {
    bookmarks.set('tree', res.tree);
    settings.set('edgeImported', true);
    broadcast('bm:changed', res.tree);
  }
  return res;
});

// Downloads
ipcMain.handle('dl:list', () => [...downloads.values()].map((d) => d.meta).sort((a, b) => b.ts - a.ts));
ipcMain.handle('dl:action', (_e, { id, action }) => {
  const d = downloads.get(id);
  if (!d) return false;
  const custom = d.meta.mode === 'custom';
  if (action === 'cancel') {
    if (custom) {
      d.cancelled = true;
      try { d.response && d.response.destroy(); } catch {}
      try { d.request && d.request.destroy(); } catch {}
      try { d.fileStream && d.fileStream.close(); } catch {}
      setTimeout(() => { try { fs.existsSync(d.meta.path) && fs.unlinkSync(d.meta.path); } catch {} }, 200);
      d.meta.state = 'cancelled'; broadcast('dl:update', d.meta);
    } else { d.item.cancel(); }
  } else if (action === 'pause') {
    if (custom) { d.meta.paused = true; try { d.response && d.response.pause(); } catch {} broadcast('dl:update', d.meta); }
    else { d.item.pause(); }
  } else if (action === 'resume') {
    if (custom) { d.meta.paused = false; try { d.response && d.response.resume(); } catch {} broadcast('dl:update', d.meta); }
    else { d.item.resume(); }
  } else if (action === 'open') { shell.openPath(d.meta.path); }
  else if (action === 'show') { shell.showItemInFolder(d.meta.path); }
  return true;
});
ipcMain.handle('dl:limit', (_e, { id, limit }) => {
  const d = downloads.get(id);
  if (!d) return false;
  d.meta.limit = Math.max(0, limit | 0);
  // sofortiges Weiterlaufen erlauben, falls gerade gedrosselt pausiert
  if (d.meta.mode === 'custom' && !d.meta.paused && d.response) { try { d.response.resume(); } catch {} }
  broadcast('dl:update', d.meta);
  return true;
});
ipcMain.handle('dl:globalLimit', (_e, limit) => {
  globalDlLimit = Math.max(0, limit | 0);
  settings.set('dlGlobalLimit', globalDlLimit);
  for (const d of downloads.values()) {
    if (d.meta.mode === 'custom' && !d.meta.paused && d.response) { try { d.response.resume(); } catch {} }
  }
  return globalDlLimit;
});
ipcMain.handle('dl:clear', () => {
  for (const [id, d] of [...downloads.entries()]) {
    if (d.meta.state !== 'progressing') downloads.delete(id);
  }
  return [...downloads.values()].map((d) => d.meta).sort((a, b) => b.ts - a.ts);
});
ipcMain.on('dl:openFolder', () => shell.openPath(app.getPath('downloads')));

// Netzwerk-Monitor an-/abschalten (nur wenn Panel offen)
ipcMain.on('net:monitor', (_e, on) => { on ? startNetMon() : stopNetMon(); });

// ---------------------------------------------------------------- Auto-Updater
// Prüft GitHub-Releases, lädt nur nach Zustimmung, startet nie von allein neu.
const UPDATE_REPO = 'DtheG-Code/NOVA';
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
let updateInfo = null;
async function checkUpdate() {
  try {
    const json = await fetchJson(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, 8000);
    if (!json || !json.tag_name) return { available: false };
    if (cmpVer(json.tag_name, app.getVersion()) <= 0) return { available: false, version: json.tag_name };
    const assets = json.assets || [];
    const asset = assets.find((a) => /setup.*\.exe$/i.test(a.name)) ||
      assets.find((a) => /\.exe$/i.test(a.name)) || assets.find((a) => /\.zip$/i.test(a.name));
    updateInfo = {
      version: json.tag_name, notes: (json.body || '').slice(0, 1200), url: json.html_url,
      assetUrl: asset ? asset.browser_download_url : null, assetName: asset ? asset.name : null,
      date: json.published_at || '',
    };
    return { available: true, ...updateInfo };
  } catch (err) {
    return { available: false, error: err.message };
  }
}
ipcMain.handle('update:check', () => checkUpdate());
ipcMain.handle('update:openPage', () => { if (updateInfo) shell.openExternal(updateInfo.url); return true; });
ipcMain.handle('update:download', async () => {
  if (!updateInfo) return { ok: false };
  if (!updateInfo.assetUrl) { return { ok: false, noAsset: true }; }   // keine Webseite aufmachen — still scheitern
  return new Promise((resolve) => {
    const dest = path.join(app.getPath('temp'), updateInfo.assetName);
    let file;
    try { file = fs.createWriteStream(dest); } catch { return resolve({ ok: false }); }
    const req = net.request(updateInfo.assetUrl);
    req.on('response', (res) => {
      if ((res.statusCode || 0) >= 400) { try { file.close(); } catch {} return resolve({ ok: false }); }
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      let recv = 0;
      res.on('data', (c) => { recv += c.length; file.write(c); if (total) broadcast('update:progress', Math.round((recv / total) * 100)); });
      res.on('end', () => file.end(() => resolve({ ok: true, path: dest })));
      res.on('error', () => resolve({ ok: false }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.end();
  });
});
// ECHTES In-Place-Update am EXAKTEN Installationsort (dirname(process.execPath) — stimmt auch bei Start
// über Verknüpfungen). Ein .bat wird über `cmd /c start` LOSGELÖST gestartet (eigener Prozess, NICHT in
// NOVAs Job-Object → überlebt das Beenden), beendet NOVA hart (taskkill), entpackt, spiegelt (robocopy /E,
// NovaData bleibt) und STARTET NOVA NEU. Sichtbares „wird aktualisiert"-Fenster + Log. UAC nur falls nötig.
ipcMain.handle('update:install', async (_e, zipPath) => {
  try {
    if (!zipPath || !fs.existsSync(zipPath)) return { ok: false };
    // KEIN Auto-Update im Entwicklungsmodus (npm start / electron .): process.execPath ist dann das
    // Dev-Electron (node_modules\electron\dist\electron.exe) — ein In-Place-Update wuerde das Dev-Setup
    // treffen und kann nicht korrekt neu starten. Nur die gepackte NOVA.exe darf sich selbst updaten.
    if (process.defaultApp || /(^|[\\/])electron\.exe$/i.test(process.execPath)) {
      return { ok: false, dev: true };
    }
    if (process.platform !== 'win32') { shell.openPath(zipPath); setTimeout(() => app.quit(), 800); return { ok: true }; }
    const exePath = process.execPath;
    const installDir = path.dirname(exePath);
    const exeName = path.basename(exePath);
    const ts = Date.now();
    const tmp = app.getPath('temp');
    const stage = path.join(tmp, 'nova-upd-' + ts);
    const stageNOVA = path.join(stage, 'NOVA');
    const stageNOVAExe = path.join(stageNOVA, exeName);
    const vbsPath = path.join(tmp, 'nova-upd-' + ts + '.vbs');
    const htaPath = path.join(tmp, 'nova-upd-' + ts + '.hta');

    // Akzentfarbe für den Splash
    const ACC_HEX = { cyan: ['#00e5ff', '#7c4dff'], violet: ['#a78bfa', '#ec4899'], magenta: ['#f471b5', '#7c3aed'], lime: ['#a3e635', '#22d3ee'], amber: ['#fbbf24', '#fb7185'], ice: ['#7dd3fc', '#818cf8'] };
    const accName = settings.get('accent', 'cyan');
    let A1 = '#00e5ff', A2 = '#7c4dff';
    if (accName === 'custom') { const c = settings.get('customAccent', null); if (c && c.a) { A1 = c.a; A2 = c.b || c.a; } }
    else if (ACC_HEX[accName]) { [A1, A2] = ACC_HEX[accName]; }

    // ---- Animierter Nebula-Splash (HTA / mshta, IE-Engine → CSS-Animationen, kein WebGL) ----
    const hta = `<!doctype html><html><head><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta http-equiv="Content-Type" content="text/html;charset=utf-8">
<HTA:APPLICATION ID="nova" BORDER="none" CAPTION="no" SHOWINTASKBAR="yes" SINGLEINSTANCE="yes" SCROLL="no" SYSMENU="no" CONTEXTMENU="no" SELECTION="no" INNERBORDER="no" MAXIMIZEBUTTON="no" MINIMIZEBUTTON="no" />
<style>
 html,body{margin:0;height:100%;background:#06060e;overflow:hidden;font-family:'Segoe UI',sans-serif;color:#eef0fa;}
 .neb{position:absolute;border-radius:50%;}
 .n1{width:560px;height:560px;left:-160px;top:-200px;background:radial-gradient(circle,${A1},rgba(0,0,0,0) 60%);opacity:.55;animation:d1 9s ease-in-out infinite alternate;}
 .n2{width:600px;height:600px;right:-200px;bottom:-220px;background:radial-gradient(circle,${A2},rgba(0,0,0,0) 60%);opacity:.55;animation:d2 11s ease-in-out infinite alternate;}
 .n3{width:320px;height:320px;left:38%;top:26%;background:radial-gradient(circle,${A1},rgba(0,0,0,0) 60%);opacity:.3;animation:d3 15s linear infinite;}
 @keyframes d1{to{transform:translate(64px,52px) scale(1.22);}}
 @keyframes d2{to{transform:translate(-64px,-44px) scale(1.26);}}
 @keyframes d3{50%{transform:translate(-42px,32px);}}
 .vig{position:absolute;left:0;top:0;right:0;bottom:0;box-shadow:inset 0 0 150px rgba(0,0,6,.72);}
 .wrap{position:relative;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;}
 .ring{width:76px;height:76px;border-radius:50%;border:3px solid rgba(255,255,255,.12);border-top-color:${A1};box-shadow:0 0 34px ${A1};animation:spin 1.05s linear infinite;margin-bottom:22px;}
 @keyframes spin{to{transform:rotate(360deg);}}
 .t{font-size:22px;font-weight:700;letter-spacing:.4px;}
 .t b{color:${A1};}
 .s{font-size:13px;color:#9aa0bb;margin-top:8px;}
 .bar{margin-top:24px;width:300px;height:5px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;position:relative;}
 .bar i{position:absolute;left:-42%;top:0;height:100%;width:42%;border-radius:99px;background:${A1};box-shadow:0 0 16px ${A1};animation:slide 1.3s ease-in-out infinite;}
 @keyframes slide{to{left:100%;}}
</style></head>
<body><div class="neb n1"></div><div class="neb n2"></div><div class="neb n3"></div><div class="vig"></div>
<div class="wrap"><div class="ring"></div><div class="t">NOVA <b>wird aktualisiert</b></div><div class="s">Neue Version wird installiert &mdash; NOVA startet gleich automatisch neu.</div><div class="bar"><i></i></div></div>
<script>window.resizeTo(600,380);window.moveTo((screen.availWidth-600)/2,(screen.availHeight-380)/2);</script>
</body></html>`;
    fs.writeFileSync(htaPath, hta, 'utf8');

    // ---- VBS-Updater (komplett OHNE sichtbare Konsole; Q=Chr(34) für saubere Quotes) ----
    const vbs = [
      'Set sh = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'Dim Q : Q = Chr(34)',
      'On Error Resume Next',
      `Set splash = sh.Exec("mshta.exe " & Q & "${htaPath}" & Q)`,
      'On Error GoTo 0',
      'WScript.Sleep 1500',
      `sh.Run "taskkill /IM " & Q & "${exeName}" & Q & " /F", 0, True`,
      'WScript.Sleep 1800',
      `sh.Run "taskkill /IM " & Q & "${exeName}" & Q & " /F", 0, True`,
      `sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -Command " & Q & "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${stage}' -Force" & Q, 0, True`,
      `Dim src : src = "${stageNOVA}"`,
      `If Not fso.FileExists("${stageNOVAExe}") Then src = "${stage}"`,
      `sh.Run "robocopy " & Q & src & Q & " " & Q & "${installDir}" & Q & " /E /R:3 /W:2 /NFL /NDL /NJH /NJS", 0, True`,
      'On Error Resume Next',
      'splash.Terminate()',
      'On Error GoTo 0',
      `sh.Run Q & "${exePath}" & Q, 1, False`,
      'WScript.Sleep 1200',
      `sh.Run "cmd /c rmdir /S /Q " & Q & "${stage}" & Q & " & del /Q " & Q & "${zipPath}" & Q & " & del /Q " & Q & "${htaPath}" & Q, 0, False`,
      'fso.DeleteFile WScript.ScriptFullName',
    ].join('\r\n');
    fs.writeFileSync(vbsPath, '﻿' + vbs, 'utf16le');   // BOM + UTF-16 → wscript liest Umlaut-Pfade korrekt

    // Schreibrecht am Installationsort prüfen → sonst per UAC elevated ausführen
    let writable = true;
    try { const t = path.join(installDir, '.nova-wtest-' + ts); fs.writeFileSync(t, 'x'); fs.unlinkSync(t); } catch { writable = false; }
    if (writable) {
      // cmd /c start /b wscript → losgelöst (überlebt app.quit) UND ohne Konsolenfenster
      spawn('cmd.exe', ['/c', 'start "" /b wscript.exe "' + vbsPath + '"'], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
      setTimeout(() => app.quit(), 500);
    } else {
      // UAC: wscript elevated; das VBS beendet NOVA selbst (bei UAC-Abbruch bleibt NOVA offen)
      spawn('powershell.exe', ['-NoProfile', '-Command', "Start-Process -FilePath 'wscript.exe' -ArgumentList '\"" + vbsPath + "\"' -Verb RunAs"], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    return { ok: true, elevated: !writable };
  } catch { return { ok: false }; }
});

// ---- Website-Security-Datenbank (lokal + Lese-Sync vom öffentlichen GitHub-Repo) ----
// Liste der Reports ist NICHT einsehbar; nur der Report zur aktuell besuchten Seite wird abgefragt.
const SEC_DB_RAW = 'https://raw.githubusercontent.com/DtheG-Code/NOVA/main/security-db.json';
const SEC_DB_API = 'https://api.github.com/repos/DtheG-Code/NOVA/contents/security-db.json';
const secHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '').replace(/[:/].*$/, '').trim();
async function secPull() {
  try {
    const json = await fetchJson(SEC_DB_RAW + '?t=' + Date.now(), 9000);
    if (!json || typeof json !== 'object') return { ok: false };
    let merged = 0;
    for (const h of Object.keys(json)) {
      const remote = json[h]; if (!remote || !remote.ts) continue;
      const local = securityDb.get(h);
      if (!local || (remote.ts || 0) > (local.ts || 0)) { securityDb.set(h, remote); merged++; }
    }
    return { ok: true, merged };
  } catch { return { ok: false }; }
}
// Beitrag ins ÖFFENTLICHE Repo — nur mit hinterlegtem GitHub-Token (Schreiben braucht IMMER Auth, auch bei public).
async function secContribute() {
  const token = (settings.get('securityToken', '') || '').trim();
  const pending = settings.get('securityPending', {}) || {};
  if (!token) return { ok: false, reason: 'notoken' };
  if (!Object.keys(pending).length) return { ok: false, reason: 'empty' };
  try {
    const headers = { 'User-Agent': 'NOVA', 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' };
    let sha = null, db = {};
    const cur = await fetchJson(SEC_DB_API + '?ref=main', 9000, headers).catch(() => null);
    if (cur && cur.sha) { sha = cur.sha; try { db = JSON.parse(Buffer.from(cur.content || '', 'base64').toString('utf8')) || {}; } catch {} }
    for (const h of Object.keys(pending)) { const r = pending[h]; if (!db[h] || (r.ts || 0) > (db[h].ts || 0)) db[h] = r; }
    const body = JSON.stringify({
      message: 'security-db: +' + Object.keys(pending).length + ' Reports (NOVA)',
      content: Buffer.from(JSON.stringify(db, null, 0), 'utf8').toString('base64'),
      sha: sha || undefined, branch: 'main',
    });
    const ok = await new Promise((resolve) => {
      const req = net.request({ method: 'PUT', url: SEC_DB_API });
      Object.entries(headers).forEach(([k, v]) => req.setHeader(k, v));
      req.on('response', (res) => { resolve((res.statusCode || 0) < 300); res.on('data', () => {}); });
      req.on('error', () => resolve(false));
      req.write(body); req.end();
    });
    if (ok) { settings.set('securityPending', {}); return { ok: true }; }
    return { ok: false, reason: 'put' };
  } catch (e) { return { ok: false, reason: 'err' }; }
}
ipcMain.handle('sec:get', (_e, host) => { try { return securityDb.get(secHost(host)) || null; } catch { return null; } });
ipcMain.handle('sec:save', (_e, rep) => {
  try {
    if (!rep || !rep.host) return false;
    const h = secHost(rep.host); rep.host = h; rep.ts = rep.ts || Date.now();
    securityDb.set(h, rep);
    const p = settings.get('securityPending', {}) || {}; p[h] = rep; settings.set('securityPending', p);
    secContribute().catch(() => {});   // best-effort (nur mit Token)
    return true;
  } catch { return false; }
});
ipcMain.handle('sec:pull', () => secPull());
ipcMain.handle('sec:contribute', () => secContribute());

// Session
ipcMain.on('session:save', (_e, tabs) => settings.set('lastSession', tabs));

// Neuer-Tab-Seite
const fromNova = (e) => !!e.senderFrame?.url?.startsWith('nova:');

// ---- NOVA Studio: contained-VM Speicher (Snapshots als Container) + Image-Download ----
const STUDIO_DIR = path.join(app.getPath('userData'), 'studio');
const STUDIO_IMG_DIR = path.join(STUDIO_DIR, 'images');
const studioMkdir = (d) => { try { fs.mkdirSync(d, { recursive: true }); } catch {} };
const studioSafeId = (id) => String(id || '').replace(/[^a-z0-9\-]/gi, '');

ipcMain.handle('studio:list', (e) => {
  if (!fromNova(e)) return [];
  try {
    studioMkdir(STUDIO_DIR);
    const out = [];
    for (const name of fs.readdirSync(STUDIO_DIR)) {
      const metaF = path.join(STUDIO_DIR, name, 'meta.json');
      if (!fs.existsSync(metaF)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaF, 'utf8'));
        let size = 0; try { size = fs.statSync(path.join(STUDIO_DIR, name, 'state.bin')).size; } catch {}
        out.push({ id: meta.id || name, name: meta.name || name, os: meta.os || 'linux', created: meta.created || 0, size });
      } catch {}
    }
    out.sort((a, b) => (b.created || 0) - (a.created || 0));
    return out;
  } catch { return []; }
});

ipcMain.handle('studio:save', (e, meta, state) => {
  if (!fromNova(e)) return { ok: false };
  try {
    const id = studioSafeId(meta && meta.id);
    if (!id || !state) return { ok: false };
    const dir = path.join(STUDIO_DIR, id);
    studioMkdir(dir);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, name: (meta.name || 'VM'), os: (meta.os || 'linux'), created: Date.now() }));
    fs.writeFileSync(path.join(dir, 'state.bin'), Buffer.from(state));
    return { ok: true };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle('studio:load', (e, id) => {
  if (!fromNova(e)) return null;
  try {
    const f = path.join(STUDIO_DIR, studioSafeId(id), 'state.bin');
    if (!fs.existsSync(f)) return null;
    const buf = fs.readFileSync(f);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);   // ArrayBuffer für v86.restore_state
  } catch { return null; }
});

ipcMain.handle('studio:delete', (e, id) => {
  if (!fromNova(e)) return { ok: false };
  try {
    const sid = studioSafeId(id);
    if (!sid) return { ok: false };
    fs.rmSync(path.join(STUDIO_DIR, sid), { recursive: true, force: true });   // restlos löschen
    return { ok: true };
  } catch { return { ok: false }; }
});

ipcMain.handle('studio:image', (e, os) => {
  if (!fromNova(e)) return { ready: false };
  try {
    if (os === 'reactos') {
      const f = path.join(STUDIO_IMG_DIR, 'reactos.img');
      if (fs.existsSync(f)) return { ready: true, url: 'nova://studio-data/images/reactos.img', size: fs.statSync(f).size };
      return { ready: false };
    }
    return { ready: true };   // Linux ist gebündelt
  } catch { return { ready: false }; }
});

ipcMain.handle('studio:download', async (e, os) => {
  if (!fromNova(e)) return { ok: false };
  if (os !== 'reactos') return { ok: true };
  const url = settings.get('studioReactosUrl', '');
  if (!url) return { ok: false, error: 'Kein ReactOS-Image hinterlegt. In den NOVA-Einstellungen eine Image-URL setzen (studioReactosUrl).' };
  try {
    studioMkdir(STUDIO_IMG_DIR);
    const dest = path.join(STUDIO_IMG_DIR, 'reactos.img');
    const tmp = dest + '.part';
    await new Promise((resolve, reject) => {
      const req = net.request(url);
      req.on('response', (res) => {
        if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode)); return; }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0;
        const out = fs.createWriteStream(tmp);
        res.on('data', (chunk) => {
          got += chunk.length; out.write(chunk);
          if (total && !e.sender.isDestroyed()) e.sender.send('studio:progress', { pct: Math.round((got / total) * 100), status: 'Lade ReactOS … ' + (got / 1048576).toFixed(0) + ' / ' + (total / 1048576).toFixed(0) + ' MB' });
        });
        res.on('end', () => out.end(() => { try { fs.renameSync(tmp, dest); resolve(); } catch (err) { reject(err); } }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    return { ok: true, url: 'nova://studio-data/images/reactos.img', size: fs.statSync(dest).size };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle('newtab:data', async (e) => {
  if (!fromNova(e)) return null;
  return {
    name: settings.get('userName', 'Damian'),
    accent: settings.get('accent', 'cyan'),
    customAccent: settings.get('customAccent', { a: '#00e5ff', b: '#7c4dff' }),
    searchEngine: settings.get('searchEngine', 'google'),
    dials: buildDials(10),
    totalBlocked: settings.get('totalBlocked', 0),
    weather: await getWeather(),
    plugins: nativePluginState(),
    nebulaQuality: settings.get('nebulaQuality', 'mid'),
  };
});
ipcMain.handle('newtab:suggest', (e, q) => (fromNova(e) ? fetchSuggestions(q) : []));
ipcMain.handle('newtab:addDial', (e, { name, url }) => {
  if (!fromNova(e) || !url) return false;
  const dials = settings.get('dials', []);
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  dials.push({ name: (name || '').trim() || hostnameOf(url) || url, url });
  settings.set('dials', dials);
  broadcastDials();
  return true;
});
ipcMain.handle('newtab:removeDial', (e, { url, pinned }) => {
  if (!fromNova(e)) return false;
  if (pinned) {
    settings.set('dials', settings.get('dials', []).filter((d) => d.url !== url));
  } else {
    const o = originOf(url);
    if (o) settings.set('dialHidden', [...new Set([...settings.get('dialHidden', []), o])]);
  }
  broadcastDials();
  return true;
});
// Aktualisierte Speed-Dials an ALLE offenen Neuer-Tab-Seiten senden,
// damit Änderungen sofort in jedem Tab erscheinen (und dauerhaft gespeichert sind).
function broadcastDials() {
  const dials = buildDials(10);
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (wc.getType() === 'webview' && (wc.getURL() || '').startsWith('nova:')) {
        wc.send('newtab:dials', dials);
      }
    } catch {}
  }
}
function hostnameOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; } }

// Tab-Vorschau & Screenshot
ipcMain.handle('tab:thumb', async (_e, wcId) => {
  try {
    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) return null;
    const img = await wc.capturePage();
    if (img.isEmpty()) return null;
    return img.resize({ width: 320 }).toDataURL();
  } catch { return null; }
});
ipcMain.handle('tab:screenshot', async (_e, wcId) => {
  try {
    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) return null;
    const img = await wc.capturePage();
    if (img.isEmpty()) return null;
    clipboard.writeImage(img);
    const dir = path.join(app.getPath('pictures'), 'Nova Screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = path.join(dir, `nova-${stamp}.png`);
    fs.writeFileSync(file, img.toPNG());
    return file;
  } catch { return null; }
});

// System
ipcMain.handle('sys:icon', async (_e, dataUrl) => {
  try {
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    const dir = app.getPath('userData');
    await fsp.writeFile(path.join(dir, 'icon.png'), png);
    // ICO mit eingebettetem PNG (ab Vista gültig)
    const header = Buffer.alloc(6 + 16);
    header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
    header[6] = 0; header[7] = 0; // 256x256
    header[8] = 0; header[9] = 0;
    header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
    header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
    await fsp.writeFile(path.join(dir, 'icon.ico'), Buffer.concat([header, png]));
    const img = nativeImage.createFromBuffer(png);
    if (win && !img.isEmpty()) win.setIcon(img);
    return true;
  } catch (err) {
    console.error('[icon]', err.message);
    return false;
  }
});
ipcMain.handle('sys:iconExists', () => fs.existsSync(path.join(app.getPath('userData'), 'icon.png')));

function writeNovaShortcut(lnkPath) {
  const ico = path.join(app.getPath('userData'), 'icon.ico');
  return shell.writeShortcutLink(lnkPath, {
    target: process.execPath,
    args: `"${APP_DIR}"`,
    cwd: APP_DIR,
    icon: fs.existsSync(ico) ? ico : process.execPath,
    iconIndex: 0,
    description: 'NOVA — Dein futuristischer Browser',
    appUserModelId: 'com.spark.nova-browser',
  });
}

// Start-Menü-Verknüpfung: Windows löst die AppUserModelID des laufenden Fensters
// auf diese .lnk auf und nutzt DEREN Icon für die Taskleiste — auch angeheftet.
function ensureStartMenuShortcut() {
  try {
    const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    fs.mkdirSync(dir, { recursive: true });
    writeNovaShortcut(path.join(dir, 'Nova Browser.lnk'));
  } catch (err) { console.error('[startmenu]', err.message); }
}

ipcMain.handle('sys:shortcut', () => {
  try {
    ensureStartMenuShortcut(); // für korrektes Taskleisten-Icon
    return writeNovaShortcut(path.join(app.getPath('desktop'), 'Nova Browser.lnk'));
  } catch (err) {
    console.error('[shortcut]', err.message);
    return false;
  }
});

ipcMain.handle('sys:registerDefault', async () => {
  const exe = process.execPath;
  const ico = path.join(app.getPath('userData'), 'icon.ico');
  const iconRef = fs.existsSync(ico) ? ico : `${exe},0`;
  const launch = `"${exe}" "${APP_DIR}" -- "%1"`;
  const open = `"${exe}" "${APP_DIR}"`;
  const HKCU = 'HKCU\\Software';
  const cmds = [
    [`${HKCU}\\Classes\\NovaBrowserHTM`, '/ve', '/d', 'Nova Browser Dokument'],
    [`${HKCU}\\Classes\\NovaBrowserHTM\\DefaultIcon`, '/ve', '/d', iconRef],
    [`${HKCU}\\Classes\\NovaBrowserHTM\\shell\\open\\command`, '/ve', '/d', launch],
    [`${HKCU}\\Clients\\StartMenuInternet`, null],
    [`${HKCU}\\Clients\\StartMenuInternet\\NovaBrowser`, '/ve', '/d', 'Nova Browser'],
    [`${HKCU}\\Clients\\StartMenuInternet\\NovaBrowser\\DefaultIcon`, '/ve', '/d', iconRef],
    [`${HKCU}\\Clients\\StartMenuInternet\\NovaBrowser\\shell\\open\\command`, '/ve', '/d', open],
    [`${HKCU}\\Clients\\StartMenuInternet\\NovaBrowser\\Capabilities`, '/v', 'ApplicationName', '/d', 'Nova Browser'],
    [`${HKCU}\\Clients\\StartMenuInternet\\NovaBrowser\\Capabilities`, '/v', 'ApplicationIcon', '/d', iconRef],
    [`${HKCU}\\Clients\\StartMenuInternet\\NovaBrowser\\Capabilities`, '/v', 'ApplicationDescription', '/d', 'NOVA — Dein futuristischer Browser'],
    [`${HKCU}\\Clients\\StartMenuInternet\\NovaBrowser\\Capabilities\\URLAssociations`, '/v', 'http', '/d', 'NovaBrowserHTM'],
    [`${HKCU}\\Clients\\StartMenuInternet\\NovaBrowser\\Capabilities\\URLAssociations`, '/v', 'https', '/d', 'NovaBrowserHTM'],
    [`${HKCU}\\Clients\\StartMenuInternet\\NovaBrowser\\Capabilities\\FileAssociations`, '/v', '.htm', '/d', 'NovaBrowserHTM'],
    [`${HKCU}\\Clients\\StartMenuInternet\\NovaBrowser\\Capabilities\\FileAssociations`, '/v', '.html', '/d', 'NovaBrowserHTM'],
    [`${HKCU}\\RegisteredApplications`, '/v', 'Nova Browser', '/d', 'Software\\Clients\\StartMenuInternet\\NovaBrowser\\Capabilities'],
  ];
  const regAdd = (args) => new Promise((resolve) => {
    execFile('reg', ['add', args[0], ...args.slice(1).filter((a) => a !== null), '/f'], () => resolve());
  });
  for (const c of cmds) await regAdd(c);
  shell.openExternal('ms-settings:defaultapps');
  return true;
});

ipcMain.handle('sys:clearData', async (_e, what) => {
  if (!ses) return false;
  if (what === 'cache') await ses.clearCache();
  if (what === 'cookies') await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
  return true;
});
