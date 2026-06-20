'use strict';
/*
 * NOVA Share — sicherer Datei-Share-Server
 * --------------------------------------------------------------
 * - Konten mit bcrypt-gehashten Passwörtern, JWT-Auth (Bearer-Token)
 * - Rollen: admin | user ; pro Konto: Kontingent (quota) + max. Dateigröße
 * - Upload als Stream (kein Multipart) mit Quota-/Größen-Prüfung
 * - Admin-API: Konten anlegen/ändern/sperren/löschen, Kontingente setzen
 * - Speicherung lokal: data/users.json, data/files.json, data/files/<id>
 * - CORS offen (Desktop-Client, Auth per Bearer-Token statt Cookies)
 * - Optional TLS (TLS_CERT + TLS_KEY) — sonst HTTP (dann hinter HTTPS-Proxy betreiben!)
 *
 * Start:  npm install  &&  npm start
 * Erstkonto: beim ersten Start wird ein Admin angelegt (Passwort wird EINMALIG im Log ausgegeben),
 *            oder via Umgebungsvariablen ADMIN_USER / ADMIN_PASS vorgeben.
 */
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const FILES_DIR = path.join(DATA, 'files');
const USERS_FILE = path.join(DATA, 'users.json');
const FILES_FILE = path.join(DATA, 'files.json');
const CONFIG_FILE = path.join(DATA, 'config.json');
fs.mkdirSync(FILES_DIR, { recursive: true });

const loadJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const saveJson = (f, o) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o, null, 2)); fs.renameSync(tmp, f); };

// ---- Konfiguration ----
let config = loadJson(CONFIG_FILE, null);
if (!config) {
  config = {
    port: Number(process.env.PORT) || 8787,
    jwtSecret: crypto.randomBytes(48).toString('base64'),
    tokenTtl: '12h',
    defaultQuotaBytes: 2 * 1024 * 1024 * 1024,   // 2 GB
    defaultMaxFileBytes: 512 * 1024 * 1024,      // 512 MB
  };
  saveJson(CONFIG_FILE, config);
}

let usersDb = loadJson(USERS_FILE, { users: [] });
let filesDb = loadJson(FILES_FILE, { files: [] });
const saveUsers = () => saveJson(USERS_FILE, usersDb);
const saveFiles = () => saveJson(FILES_FILE, filesDb);

// ---- Erstkonto (Admin) ----
(function ensureAdmin() {
  if (usersDb.users.some((u) => u.role === 'admin')) return;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASS || crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 14);
  usersDb.users.push({
    id: crypto.randomUUID(), username, role: 'admin', passHash: bcrypt.hashSync(password, 12),
    quotaBytes: config.defaultQuotaBytes, maxFileBytes: config.defaultMaxFileBytes, usedBytes: 0, disabled: false, createdAt: Date.now(),
  });
  saveUsers();
  console.log('\n=================== NOVA Share ===================');
  console.log(' Admin-Konto angelegt:');
  console.log('   Benutzer: ' + username);
  console.log('   Passwort: ' + password);
  console.log(' >> JETZT NOTIEREN — wird nur dieses eine Mal angezeigt. <<');
  console.log('==================================================\n');
})();

// ---- App ----
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {                  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Filename');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const pubUser = (u) => ({ id: u.id, username: u.username, role: u.role, quotaBytes: u.quotaBytes, maxFileBytes: u.maxFileBytes, usedBytes: u.usedBytes, disabled: !!u.disabled, createdAt: u.createdAt });
const sign = (u) => jwt.sign({ sub: u.id, u: u.username }, config.jwtSecret, { expiresIn: config.tokenTtl });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  try {
    const p = jwt.verify(tok, config.jwtSecret);
    const user = usersDb.users.find((x) => x.id === p.sub);
    if (!user || user.disabled) return res.status(401).json({ error: 'unauthorized' });
    req.user = user; next();
  } catch { res.status(401).json({ error: 'unauthorized' }); }
}
function admin(req, res, next) { if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' }); next(); }

// ---- Login (mit einfachem Brute-Force-Schutz) ----
const fails = new Map();
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = (req.ip || '') + ':' + (username || '');
  const f = fails.get(key) || { n: 0, t: 0 };
  if (f.n >= 6 && Date.now() - f.t < 60000) return res.status(429).json({ error: 'too_many' });
  const user = usersDb.users.find((u) => u.username === username);
  const ok = user && !user.disabled && bcrypt.compareSync(String(password || ''), user.passHash);
  if (!ok) { fails.set(key, { n: f.n + 1, t: Date.now() }); return res.status(401).json({ error: 'bad_credentials' }); }
  fails.delete(key);
  res.json({ token: sign(user), user: pubUser(user) });
});
app.get('/api/me', auth, (req, res) => res.json({ user: pubUser(req.user) }));
app.post('/api/changePassword', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!bcrypt.compareSync(String(oldPassword || ''), req.user.passHash)) return res.status(403).json({ error: 'wrong' });
  if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: 'weak' });
  req.user.passHash = bcrypt.hashSync(String(newPassword), 12); saveUsers();
  res.json({ ok: true });
});

// ---- Dateien ----
app.get('/api/files', auth, (req, res) => {
  res.json({
    files: filesDb.files.map((f) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, ownerName: f.ownerName, createdAt: f.createdAt, downloads: f.downloads || 0, mine: f.ownerId === req.user.id })),
    me: pubUser(req.user),
  });
});
app.post('/api/upload', auth, (req, res) => {
  const max = req.user.maxFileBytes || config.defaultMaxFileBytes;
  const remaining = Math.max(0, (req.user.quotaBytes || 0) - (req.user.usedBytes || 0));
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > max) return res.status(413).json({ error: 'too_large', max });
  if (declared && declared > remaining) return res.status(507).json({ error: 'quota', remaining });
  let name = 'datei';
  try { if (req.headers['x-filename']) name = Buffer.from(req.headers['x-filename'], 'base64').toString('utf8'); } catch {}
  name = String(name).replace(/[\\/\x00-\x1f]/g, '_').slice(0, 255) || 'datei';
  const id = crypto.randomUUID();
  const dest = path.join(FILES_DIR, id);
  const out = fs.createWriteStream(dest);
  let size = 0, killed = false;
  const fail = (code, err) => { if (killed) return; killed = true; try { req.unpipe(out); } catch {} out.destroy(); try { fs.unlinkSync(dest); } catch {} if (!res.headersSent) res.status(code).json({ error: err }); try { req.destroy(); } catch {} };
  req.on('data', (c) => { size += c.length; if (size > max) fail(413, 'too_large'); else if (size > remaining) fail(507, 'quota'); });
  out.on('error', () => fail(500, 'write'));
  out.on('finish', () => {
    if (killed) return;
    const rec = { id, name, size, mime: (req.headers['content-type'] || 'application/octet-stream').split(';')[0], ownerId: req.user.id, ownerName: req.user.username, createdAt: Date.now(), downloads: 0 };
    filesDb.files.push(rec); saveFiles();
    req.user.usedBytes = (req.user.usedBytes || 0) + size; saveUsers();
    res.json({ ok: true, file: rec });
  });
  req.pipe(out);
});
app.get('/api/download/:id', auth, (req, res) => {
  const f = filesDb.files.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'notfound' });
  const p = path.join(FILES_DIR, f.id);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'gone' });
  f.downloads = (f.downloads || 0) + 1; saveFiles();
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Content-Length', f.size);
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(f.name));
  fs.createReadStream(p).pipe(res);
});
app.delete('/api/files/:id', auth, (req, res) => {
  const i = filesDb.files.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'notfound' });
  const f = filesDb.files[i];
  if (f.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try { fs.unlinkSync(path.join(FILES_DIR, f.id)); } catch {}
  const owner = usersDb.users.find((u) => u.id === f.ownerId);
  if (owner) { owner.usedBytes = Math.max(0, (owner.usedBytes || 0) - f.size); saveUsers(); }
  filesDb.files.splice(i, 1); saveFiles();
  res.json({ ok: true });
});

// ---- Admin: Benutzerverwaltung ----
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
app.get('/api/admin/users', auth, admin, (req, res) => res.json({ users: usersDb.users.map(pubUser) }));
app.get('/api/admin/stats', auth, admin, (req, res) => res.json({
  users: usersDb.users.length, files: filesDb.files.length,
  totalBytes: filesDb.files.reduce((a, f) => a + (f.size || 0), 0),
  defaultQuotaBytes: config.defaultQuotaBytes, defaultMaxFileBytes: config.defaultMaxFileBytes,
}));
app.post('/api/admin/users', auth, admin, (req, res) => {
  const { username, password, role, quotaBytes, maxFileBytes } = req.body || {};
  if (!USERNAME_RE.test(String(username || ''))) return res.status(400).json({ error: 'bad_username' });
  if (usersDb.users.some((u) => u.username.toLowerCase() === String(username).toLowerCase())) return res.status(409).json({ error: 'exists' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'weak' });
  const u = {
    id: crypto.randomUUID(), username: String(username), role: role === 'admin' ? 'admin' : 'user',
    passHash: bcrypt.hashSync(String(password), 12),
    quotaBytes: Number(quotaBytes) >= 0 ? Number(quotaBytes) : config.defaultQuotaBytes,
    maxFileBytes: Number(maxFileBytes) >= 0 ? Number(maxFileBytes) : config.defaultMaxFileBytes,
    usedBytes: 0, disabled: false, createdAt: Date.now(),
  };
  usersDb.users.push(u); saveUsers();
  res.json({ user: pubUser(u) });
});
app.patch('/api/admin/users/:id', auth, admin, (req, res) => {
  const u = usersDb.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'notfound' });
  const b = req.body || {};
  if (u.id === req.user.id && 'role' in b && b.role !== 'admin') return res.status(400).json({ error: 'self_demote' });
  if ('role' in b) u.role = b.role === 'admin' ? 'admin' : 'user';
  if ('quotaBytes' in b) u.quotaBytes = Math.max(0, Number(b.quotaBytes) || 0);
  if ('maxFileBytes' in b) u.maxFileBytes = Math.max(0, Number(b.maxFileBytes) || 0);
  if ('disabled' in b) u.disabled = !!b.disabled;
  if (b.password) { if (String(b.password).length < 8) return res.status(400).json({ error: 'weak' }); u.passHash = bcrypt.hashSync(String(b.password), 12); }
  saveUsers();
  res.json({ user: pubUser(u) });
});
app.delete('/api/admin/users/:id', auth, admin, (req, res) => {
  const i = usersDb.users.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'notfound' });
  if (usersDb.users[i].id === req.user.id) return res.status(400).json({ error: 'self' });
  const uid = usersDb.users[i].id;
  filesDb.files = filesDb.files.filter((f) => { if (f.ownerId === uid) { try { fs.unlinkSync(path.join(FILES_DIR, f.id)); } catch {} return false; } return true; });
  saveFiles();
  usersDb.users.splice(i, 1); saveUsers();
  res.json({ ok: true });
});

app.get('/api/ping', (req, res) => res.json({ ok: true, service: 'nova-share', time: Date.now() }));
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// ---- Start ----
// PORT/HOST aus der Umgebung haben Vorrang (z. B. hinter nginx: HOST=127.0.0.1 PORT=8790)
const port = Number(process.env.PORT) || config.port;
const host = process.env.HOST || '0.0.0.0';
if (process.env.TLS_CERT && process.env.TLS_KEY) {
  const opt = { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) };
  https.createServer(opt, app).listen(port, host, () => console.log('NOVA Share läuft via HTTPS auf ' + host + ':' + port));
} else {
  http.createServer(app).listen(port, host, () => console.log('NOVA Share läuft via HTTP auf ' + host + ':' + port + '  (öffentlich: HTTPS-Proxy davorschalten!)'));
}
