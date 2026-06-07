/* =============================================================================
   PRINTER CONSOLE  —  unified monitor + control for two Elegoo printers.

   All-in-one packaged site. Zero npm dependencies. Just:   node server.js
   then open http://<this-machine>:8080 from any laptop on the LAN.

   Printer 1: Elegoo Centauri Carbon  @ 192.168.10.153  (SDCP protocol)
   Printer 2: Elegoo OrangeStorm Giga @ 192.168.10.119  (Klipper / Moonraker)

   Requires Node 20+ (uses the built-in global WebSocket + dgram + http).
   Node 22 LTS or newer recommended.
============================================================================= */

const http  = require('http');
const https = require('https');
const dgram = require('dgram');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

/* =============================== CONFIG =================================== */

const CONFIG = {
  PORT: 8080,
  HOST: '0.0.0.0',

  PRINTERS: [
    {
      name: 'Centauri Carbon',
      nickname: 'The Anvil',
      model: 'Elegoo Centauri Carbon',
      ip: '192.168.10.153',
      driver: 'sdcp',
      // SDCP defaults (rarely need changing):
      sdcpWsPort: 3030,
      sdcpDiscoveryPort: 3000,
      // If UDP discovery is blocked on your network, hard-set the board id here:
      mainboardId: null,
      // Pin the camera stream to the IP above (the printer occasionally reports a
      // stale host in the Cmd 386 response). Set false to trust the reported URL.
      forceVideoHost: true,
    },
    {
      name: 'OrangeStorm Giga',
      nickname: 'The Forge',
      model: 'Elegoo OrangeStorm Giga',
      ip: '192.168.10.119',
      driver: 'moonraker',
      moonrakerPort: 7125,
      // Override if you reach Moonraker at a specific base URL (e.g. the exact
      // address Fluidd opens at). Leave null to auto-detect port 80 vs :7125.
      moonrakerBase: null,
      // The camera MJPEG URL (what works directly in a browser). Klipper/crowsnest
      // default is /webcam/?action=stream on port 80. Swap to :8080 if needed.
      webcamUrl: 'http://192.168.10.119/webcam/?action=stream',
      // Name of the chamber temp sensor in your printer.cfg, if you have one:
      chamberSensor: 'chamber',
      // The Giga can run up to 4 bed zones and 4 extruders. Heater object names are
      // auto-discovered from Klipper; the server logs "[moonraker] heaters discovered ..."
      // on the first query so you can see what it found. If any are missed or misnamed,
      // hard-set them here (null = auto-discover):
      extruders: null,   // e.g. ['extruder','extruder1','extruder2','extruder3']
      bedHeaters: null,  // e.g. ['heater_bed','heater_generic bed_2','heater_generic bed_3','heater_generic bed_4']
    },
  ],

  // SDCP "ticks" units. The Centauri (firmware V1.1.46) reports CurrentTicks/
  // TotalTicks in SECONDS (29504 ticks == the "8h12m" in the filename). If a
  // future firmware reports milliseconds and the ETA looks 1000x off, set true.
  SDCP_TICKS_ARE_MS: false,

  // Log raw SDCP traffic (board ID, command replies, errors) to the console.
  // Handy while getting the Centauri camera working; set false once it's solid.
  SDCP_DEBUG: false,

  // The "3D Files" library page browses this folder. It's read by THIS server,
  // so the laptops don't need access to the share — only this machine does.
  // A UNC path (\\\\Host\\Share\\Folder) or a local path both work.
  FILE_BROWSER: {
    enabled: true,
    writable: true, // allow New folder / Rename / Move / Delete from the 3D Files page
    label: '3D Files',
    root: process.env.FILES_ROOT || '\\\\Chronos\\Brain\\3D Files',
  },

  // ===== AI spaghetti watchdog (self-hosted Obico ML API) =====
  // Watches the Giga's camera. Behaviour is set by `mode` (changeable live in the UI):
  //   off      - not watching
  //   notify   - alert + ntfy on a failure, but NEVER auto-cancel (you stop it)
  //   act      - auto-cancel on a failure (same cancel as the Abort button)
  //   schedule - auto-cancel inside the night window, notify-only outside it
  // Stand up the ML API container first (see SPAGHETTI-SETUP.md), set mlApi below,
  // then watch it in 'notify' before switching to 'act'/'schedule'. Settings changed in
  // the UI are saved to spaghetti.settings.json and survive a restart.
  SPAGHETTI: {
    mode: 'notify',            // 'off' | 'notify' | 'act' | 'schedule'  (UI can change this)
    printerIndex: null,        // null = auto (first Moonraker printer = the Giga)
    mlApi: 'http://192.168.10.168:3333',                                 // <-- box running the Obico ML API container
    snapshotUrl: 'http://192.168.10.119/webcam/?action=snapshot',   // a single JPEG the ML API will fetch
    pollSeconds: 25,
    startGraceSec: 150,        // ignore the first N seconds of a print (purge + first layer look weird)
    confFloor: 0.30,           // drop any single detection weaker than this
    frameScoreTrip: 0.60,      // a frame "trips" if the summed surviving confidence >= this
    highConf: 0.70,            // ...or if any single surviving box is at least this confident
    consecutiveTrips: 4,       // act/alert only after this many tripped frames in a row
    ignoreZones: [],           // [cx,cy,w,h] in source-image PIXELS; set these in the Calibrate UI
    schedule: { actStart: '22:00', actEnd: '07:00' },  // 'schedule' mode: AUTO-CANCEL inside this window, notify outside
    notify: { ntfy: false, ntfyTopic: '' },            // ntfy phone push; e.g. ntfyTopic:'https://ntfy.sh/my-giga-alerts'
    notifyOnFirstTrip: true,   // ping when a streak STARTS, not just when it acts/alerts
    httpTimeoutMs: 15000,
  },
};

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

const PUBLIC_DIR = path.join(__dirname, 'public');
const uuid = () => crypto.randomUUID();
const nowSec = () => Math.floor(Date.now() / 1000);

function round1(n) { return (typeof n === 'number' && isFinite(n)) ? Math.round(n * 10) / 10 : null; }
function round2(n) { return (typeof n === 'number' && isFinite(n)) ? Math.round(n * 100) / 100 : null; }
function numOrNull(n) { return (typeof n === 'number' && isFinite(n)) ? n : null; }

// Minimal HTTP JSON helper (GET or POST). Resolves {status, json, text}.
function httpRequest(method, urlStr, { timeout = 6000, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// Normalized status object every driver returns.
function blankStatus(extra = {}) {
  return Object.assign({
    online: false,
    state: 'offline',          // printing | paused | idle | complete | error | offline
    detail: '',
    nozzle: { cur: null, target: null },
    bed: { cur: null, target: null },
    chamber: { cur: null, target: null },
    progress: null,            // 0..1
    layer: { cur: null, total: null },
    elapsedSec: null,
    timeLeftSec: null,
    filename: '',
    pos: { x: null, y: null, z: null },
    speedPct: null,
    fans: { model: null, aux: null, box: null },
    light: null,                // { second:0|1, rgb:[r,g,b] } when supported
  }, extra);
}

/* ========================================================================== */
/*  File library browser  (the "3D Files" page)                               */
/* ========================================================================== */

const fsp = fs.promises;
const zlib = require('zlib');

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MODEL_EXT = new Set(['.stl', '.obj', '.step', '.stp', '.ply', '.amf', '.dae', '.f3d', '.scad', '.iges', '.igs']);
const ARCH_EXT = new Set(['.zip', '.7z', '.rar', '.gz', '.tar']);
const SLICED_EXT = new Set(['.gcode', '.g', '.gco', '.bgcode']);
const DOC_EXT = new Set(['.pdf', '.txt', '.md', '.csv', '.json']);
const CONTENT_TYPE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

function fileKind(ext) {
  if (IMG_EXT.has(ext)) return 'image';
  if (SLICED_EXT.has(ext)) return 'gcode';
  if (ext === '.3mf') return 'project';
  if (MODEL_EXT.has(ext)) return 'model';
  if (ARCH_EXT.has(ext)) return 'archive';
  if (DOC_EXT.has(ext)) return 'doc';
  return 'other';
}
function thumbable(ext) { return IMG_EXT.has(ext) || SLICED_EXT.has(ext) || ext === '.3mf' || ext === '.zip'; }

// Resolve a browser-supplied relative path INSIDE the configured root, or null
// if it would escape (path-traversal guard).
function safeResolve(rel) {
  const root = path.resolve(CONFIG.FILE_BROWSER.root);
  const target = path.resolve(root, (rel || '').replace(/^[/\\]+/, '').replace(/\\/g, '/'));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

// Validate a single new file/folder name (no paths, no traversal, no junk).
function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (!n || n === '.' || n === '..') return null;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) return null; // illegal on Windows + control chars
  if (n.length > 120) return null;
  return n;
}

async function listDir(rel) {
  const abs = safeResolve(rel);
  if (!abs) throw new Error('outside root');
  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    const isDir = d.isDirectory();
    const ext = isDir ? '' : path.extname(d.name).toLowerCase();
    let sizeMB = null, modified = null;
    try { const st = await fsp.stat(path.join(abs, d.name)); if (!isDir) sizeMB = +(st.size / 1048576).toFixed(2); modified = st.mtime.toISOString(); } catch {}
    entries.push({
      name: d.name, type: isDir ? 'dir' : 'file', ext,
      kind: isDir ? 'dir' : fileKind(ext), sizeMB, modified,
      thumb: !isDir && thumbable(ext),
      rel: (rel ? rel.replace(/\/+$/, '') + '/' : '') + d.name,
    });
  }
  entries.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })));
  const parts = (rel || '').split('/').filter(Boolean);
  const crumbs = [{ name: CONFIG.FILE_BROWSER.label, rel: '' }];
  let acc = '';
  for (const seg of parts) { acc = acc ? acc + '/' + seg : seg; crumbs.push({ name: seg, rel: acc }); }
  return { cwd: rel || '', crumbs, parent: parts.length ? parts.slice(0, -1).join('/') : null, entries };
}

// gcode: slicers embed "; thumbnail begin WxH LEN <base64...> ; thumbnail end".
async function gcodeThumb(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const len = Math.min((await fh.stat()).size, 1048576); // header is near the top
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    const text = buf.toString('latin1');
    const re = /;\s*thumbnail(_[A-Z]+)?\s+begin\s+(\d+)x(\d+)\s+(\d+)([\s\S]*?);\s*thumbnail(?:_[A-Z]+)?\s+end/gi;
    let m, best = null;
    while ((m = re.exec(text))) {
      const declared = parseInt(m[4], 10);
      const b64 = m[5].replace(/;/g, '').replace(/\s+/g, '');
      if (!best || declared > best.declared) best = { declared, b64, jpg: m[1] ? /JPG|JPEG/i.test(m[1]) : false };
    }
    if (!best || !best.b64) return null;
    return { buffer: Buffer.from(best.b64, 'base64'), contentType: best.jpg ? 'image/jpeg' : 'image/png' };
  } finally { await fh.close(); }
}

// zip/3mf: read the central directory, then inflate just one image entry.
async function zipImage(abs, preferRe) {
  const fh = await fsp.open(abs, 'r');
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) { if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) return null;
    const cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOff);
    const items = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const method = cd.readUInt16LE(p + 10), compSize = cd.readUInt32LE(p + 20);
      const fnLen = cd.readUInt16LE(p + 28), exLen = cd.readUInt16LE(p + 30), cmLen = cd.readUInt16LE(p + 32);
      const lho = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + fnLen);
      items.push({ name, method, compSize, lho });
      p += 46 + fnLen + exLen + cmLen;
    }
    const imgs = items.filter((it) => /\.(png|jpe?g|webp)$/i.test(it.name) && it.compSize < 8 * 1048576);
    if (!imgs.length) return null;
    let chosen = preferRe ? imgs.find((it) => preferRe.test(it.name)) : null;
    if (!chosen) chosen = imgs.sort((a, b) => b.compSize - a.compSize)[0];
    const lh = Buffer.alloc(30);
    await fh.read(lh, 0, 30, chosen.lho);
    if (lh.readUInt32LE(0) !== 0x04034b50) return null;
    const dataOff = chosen.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const comp = Buffer.alloc(chosen.compSize);
    await fh.read(comp, 0, chosen.compSize, dataOff);
    let data;
    if (chosen.method === 0) data = comp;
    else if (chosen.method === 8) data = zlib.inflateRawSync(comp);
    else return null;
    return { buffer: data, contentType: CONTENT_TYPE[path.extname(chosen.name).toLowerCase()] || 'image/png' };
  } finally { await fh.close(); }
}

async function getThumb(rel) {
  const abs = safeResolve(rel);
  if (!abs) return null;
  const ext = path.extname(abs).toLowerCase();
  try {
    if (IMG_EXT.has(ext)) return { buffer: await fsp.readFile(abs), contentType: CONTENT_TYPE[ext] || 'application/octet-stream' };
    if (SLICED_EXT.has(ext)) return await gcodeThumb(abs);
    if (ext === '.3mf') return await zipImage(abs, /thumbnail|plate_?\d*\.png/i);
    if (ext === '.zip') return await zipImage(abs, null);
  } catch { return null; }
  return null;
}

/* ========================================================================== */
/*  Moonraker driver (OrangeStorm Giga)                                       */
/* ========================================================================== */

class MoonrakerDriver {
  constructor(p) {
    this.kind = 'moonraker';
    this.p = p;
    this.webcamUrl = p.webcamUrl || `http://${p.ip}/webcam/?action=stream`;
    this.caps = { jog: true, setTemp: true, pause: true, resume: true, abort: true, speed: true, fans: true };
    // Moonraker is commonly reached via the nginx proxy on port 80 (same origin
    // as Fluidd + the webcam) rather than :7125 directly. Try the proxy first
    // (we know port 80 is up since the camera works), then the direct port.
    this.candidates = p.moonrakerBase ? [p.moonrakerBase] : [
      `http://${p.ip}`,
      `http://${p.ip}:${p.moonrakerPort || 7125}`,
    ];
    this.activeBase = null;
    this.lastConn = { ok: false, base: null, tried: [], reason: 'connecting…' };
  }

  async _probe(base) {
    try {
      const r = await httpRequest('GET', base + '/printer/info', { timeout: 3500 });
      if (r.status === 200 && r.json && r.json.result) return { ok: true, status: 200 };
      return { ok: false, status: r.status };
    } catch (e) { return { ok: false, error: e.code || e.message }; }
  }

  // Resolve which base URL actually answers; cache it. Re-probes if cleared,
  // but no more than once per 10s while it stays down (avoids probe pileups).
  async _ensureBase() {
    if (this.activeBase) return this.activeBase;
    if (this._probeAt && Date.now() - this._probeAt < 10000) return null;
    this._probeAt = Date.now();
    const tried = [];
    for (const base of this.candidates) {
      const res = await this._probe(base);
      tried.push(Object.assign({ url: base }, res.status != null ? { status: res.status } : { error: res.error }));
      if (res.ok) { this.activeBase = base; this.lastConn = { ok: true, base, tried, reason: '' }; return base; }
    }
    let reason;
    if (tried.some((t) => t.status === 401 || t.status === 403))
      reason = 'Moonraker answered but refused the request (' + (tried.find((t) => t.status === 401 || t.status === 403).status) + '). Add this server’s IP to [authorization] trusted_clients in moonraker.conf (or disable force_logins), then restart Moonraker.';
    else if (tried.some((t) => t.error === 'timeout' || t.error === 'ECONNREFUSED'))
      reason = 'No Moonraker on :7125 or the port-80 path. If Fluidd opens in a browser, set moonrakerBase in CONFIG to the exact base URL Fluidd uses.';
    else
      reason = 'Could not reach Moonraker. Tried ' + tried.map((t) => t.url + ' → ' + (t.status || t.error)).join('; ') + '.';
    this.lastConn = { ok: false, base: null, tried, reason };
    return null;
  }

  async connectionInfo() { await this._ensureBase(); return this.lastConn; }

  // Discover which heater objects this printer exposes (up to 4 extruders + N bed
  // zones), classify them, and cache for 60s. CONFIG.extruders / .bedHeaters override.
  async _ensureHeaters(base) {
    if (this._heaters && (Date.now() - (this._heatersAt || 0) < 60000)) return this._heaters;
    const ov = this.p;
    let nozzles = [], beds = [];
    try {
      const r = await httpRequest('GET', base + '/printer/objects/list', { timeout: 4000 });
      const objs = (r.json && r.json.result && r.json.result.objects) || [];
      let exNames = (Array.isArray(ov.extruders) && ov.extruders.length) ? ov.extruders.slice()
        : objs.filter((o) => /^extruder\d*$/.test(o));
      exNames.sort((a, b) => (a === 'extruder' ? 0 : parseInt(a.slice(8), 10) || 0) - (b === 'extruder' ? 0 : parseInt(b.slice(8), 10) || 0));
      let bedNames = (Array.isArray(ov.bedHeaters) && ov.bedHeaters.length) ? ov.bedHeaters.slice()
        : objs.filter((o) => o === 'heater_bed' || (/^heater_generic /.test(o) && /bed|plate/i.test(o)));
      bedNames.sort((a, b) => (a === 'heater_bed' ? -1 : 0) - (b === 'heater_bed' ? -1 : 0));
      nozzles = exNames.map((k, i) => ({ key: k, label: 'T' + i }));
      beds = bedNames.map((k, i) => ({ key: k, label: bedNames.length > 1 ? ('Bed ' + (i + 1)) : 'Bed' }));
    } catch (e) { /* fall through to single-heater defaults */ }
    if (!nozzles.length) nozzles = [{ key: 'extruder', label: 'T0' }];
    if (!beds.length) beds = [{ key: 'heater_bed', label: 'Bed' }];
    this._heaters = { nozzles, beds };
    this._heatersAt = Date.now();
    if (!this._loggedHeaters) { this._loggedHeaters = true; console.log('[moonraker] heaters discovered - nozzles: ' + nozzles.map((n) => n.key).join(', ') + ' | beds: ' + beds.map((b) => b.key).join(', ')); }
    return this._heaters;
  }

  async getStatus() {
    const base = await this._ensureBase();
    if (!base) return blankStatus({ detail: this.lastConn.reason });
    const H = await this._ensureHeaters(base);
    const heaterKeys = [...H.nozzles.map((n) => n.key), ...H.beds.map((b) => b.key)];
    const objs = [
      ...heaterKeys,
      'print_stats', 'display_status', 'virtual_sdcard', 'toolhead', 'gcode_move', 'fan',
      `temperature_sensor ${this.p.chamberSensor || 'chamber'}`,
    ].map(encodeURIComponent).join('&');
    let r;
    try {
      r = await httpRequest('GET', `${base}/printer/objects/query?${objs}`, { timeout: 4000 });
    } catch (e) {
      this.activeBase = null; // force re-probe next time (printer may have rebooted)
      return blankStatus({ detail: 'unreachable (' + (e.code || e.message) + ')' });
    }
    if (!r.json || !r.json.result || !r.json.result.status) {
      this.activeBase = null;
      return blankStatus({ detail: 'no data from Moonraker (got HTTP ' + r.status + ')' });
    }
    const s = r.json.result.status;
    const ps = s.print_stats || {}, ds = s.display_status || {}, vsd = s.virtual_sdcard || {};
    const th = s.toolhead || {}, gm = s.gcode_move || {}, fan = s.fan || {};
    const cham = s[`temperature_sensor ${this.p.chamberSensor || 'chamber'}`] || {};

    const nozzles = H.nozzles.map((n) => { const o = s[n.key] || {}; return { key: n.key, label: n.label, cur: round1(o.temperature), target: round1(o.target) }; });
    const beds = H.beds.map((b) => { const o = s[b.key] || {}; return { key: b.key, label: b.label, cur: round1(o.temperature), target: round1(o.target) }; });

    const klipperState = (ps.state || '').toLowerCase(); // standby|printing|paused|complete|cancelled|error
    let state = 'idle';
    if (klipperState === 'printing') state = 'printing';
    else if (klipperState === 'paused') state = 'paused';
    else if (klipperState === 'complete') state = 'complete';
    else if (klipperState === 'error') state = 'error';

    const progress = (typeof ds.progress === 'number') ? ds.progress
                    : (typeof vsd.progress === 'number') ? vsd.progress : null;
    const elapsed = (typeof ps.print_duration === 'number') ? ps.print_duration : null;
    let timeLeft = null;
    if (progress && progress > 0.001 && elapsed) timeLeft = Math.max(0, elapsed / progress - elapsed);

    const info = ps.info || {};
    const posArr = th.position || [];

    return blankStatus({
      online: true,
      state,
      detail: klipperState,
      nozzle: nozzles[0] ? { cur: nozzles[0].cur, target: nozzles[0].target } : { cur: null, target: null },
      bed: beds[0] ? { cur: beds[0].cur, target: beds[0].target } : { cur: null, target: null },
      nozzles,
      beds,
      chamber: { cur: round1(cham.temperature), target: null },
      progress,
      layer: { cur: numOrNull(info.current_layer), total: numOrNull(info.total_layer) },
      elapsedSec: elapsed,
      timeLeftSec: timeLeft,
      filename: ps.filename || '',
      pos: { x: round2(posArr[0]), y: round2(posArr[1]), z: round2(posArr[2]) },
      speedPct: gm.speed_factor != null ? Math.round(gm.speed_factor * 100) : null,
      fans: { model: fan.speed != null ? Math.round(fan.speed * 100) : null, aux: null, box: null },
    });
  }

  async _gcode(script) {
    const base = await this._ensureBase();
    if (!base) throw new Error(this.lastConn.reason || 'Moonraker unreachable');
    return httpRequest('POST', `${base}/printer/gcode/script?script=${encodeURIComponent(script)}`, { timeout: 6000 });
  }

  async action(name, params = {}) {
    const base = await this._ensureBase();
    if (!base) throw new Error(this.lastConn.reason || 'Moonraker unreachable');
    switch (name) {
      case 'pause':  return httpRequest('POST', `${base}/printer/print/pause`,  { timeout: 6000 });
      case 'resume': return httpRequest('POST', `${base}/printer/print/resume`, { timeout: 6000 });
      case 'abort':  return httpRequest('POST', `${base}/printer/print/cancel`, { timeout: 6000 });
      case 'home': {
        const ax = (params.axes || '').toUpperCase().trim();
        return this._gcode(ax ? `G28 ${ax}` : 'G28');
      }
      case 'jog': {
        const f = params.feed || 3000;
        return this._gcode(`G91\nG1 ${params.axis}${params.dist} F${f}\nG90`);
      }
      case 'setTemp': {
        const val = Number(params.value) || 0;
        let key = params.heater || 'extruder';
        // Back-compat with the old single-heater UI:
        if (key === 'bed') key = 'heater_bed';
        if (key === 'nozzle') key = 'extruder';
        // SET_HEATER_TEMPERATURE works for every heater (extruders, heater_bed, and
        // heater_generic zones) and takes the config-section name, which for a
        // "heater_generic bed_2" object is just "bed_2".
        const heaterName = String(key).replace(/^heater_generic\s+/, '');
        return this._gcode(`SET_HEATER_TEMPERATURE HEATER=${heaterName} TARGET=${val}`);
      }
      case 'setFan':   return this._gcode(`M106 S${Math.round((Number(params.pct) || 0) * 255 / 100)}`);
      case 'setSpeed': return this._gcode(`M220 S${Math.round(Number(params.pct) || 100)}`);
      default: throw new Error('unsupported action: ' + name);
    }
  }

  async files() {
    try {
      const base = await this._ensureBase(); if (!base) return [];
      const r = await httpRequest('GET', `${base}/server/files/list?root=gcodes`, { timeout: 6000 });
      const list = (r.json && r.json.result) || [];
      return list.map((f) => ({
        name: f.path, sizeMB: f.size ? (f.size / 1048576).toFixed(2) : null,
        modified: f.modified ? new Date(f.modified * 1000).toISOString() : null,
      }));
    } catch { return []; }
  }

  async history() {
    try {
      const base = await this._ensureBase(); if (!base) return [];
      const r = await httpRequest('GET', `${base}/server/history/list?limit=50&order=desc`, { timeout: 6000 });
      const jobs = (r.json && r.json.result && r.json.result.jobs) || [];
      return jobs.map((j) => ({
        name: j.filename, status: j.status,
        started: j.start_time ? new Date(j.start_time * 1000).toISOString() : null,
        durationSec: j.print_duration ? Math.round(j.print_duration) : null,
      }));
    } catch { return []; }
  }

  async videoUrl() { return this.webcamUrl; }
  async cameraInfo() { return { ok: true, url: this.webcamUrl, ack: 0, reason: '' }; }
  invalidateVideo() {}
}

/* ========================================================================== */
/*  SDCP driver (Centauri Carbon)                                             */
/*  Spec: https://docs.opencentauri.cc/software/api/                          */
/* ========================================================================== */

const SDCP_CMD = { STATUS: 0, ATTRS: 1, PAUSE: 129, STOP: 130, CONTINUE: 131, CONFIG: 403, FILES: 258, HISTORY: 320, HIST_DETAIL: 321, VIDEO: 386 };

// Cmd 386 (enable video) Ack codes -> human reasons.
const VIDEO_ACK_REASON = {
  1: 'Camera busy: the Centauri allows only ONE video stream at a time. Close the ELEGOO app / slicer camera (or any other viewer) and it will appear here within a few seconds.',
  2: 'No camera detected on the printer.',
  3: 'Printer reported an unknown camera error.',
};

class SdcpDriver {
  constructor(p) {
    this.kind = 'sdcp';
    this.p = p;
    this.ip = p.ip;
    this.wsUrl = `ws://${p.ip}:${p.sdcpWsPort || 3030}/websocket`;
    this.mainboardId = p.mainboardId || null;
    this.ws = null;
    this.connected = false;
    this.lastStatus = blankStatus({ detail: 'connecting…' });
    this.lastStatusAt = 0;
    this.pending = new Map();      // RequestID -> {resolve, timer}
    this.videoUrlCached = null;
    this.videoUrlAt = 0;
    // SDCP exposes no jog or direct temperature-set command:
    this.caps = { jog: false, setTemp: false, pause: true, resume: true, abort: true, speed: true, fans: true, light: true };

    if (typeof WebSocket === 'undefined') {
      console.warn('  [SDCP] This Node build has no global WebSocket (need Node 20+). Centauri control disabled.');
      this.lastStatus = blankStatus({ detail: 'Node too old for SDCP' });
      return;
    }
    this._discoverThenConnect();
    setInterval(() => { if (this.connected) this._send(SDCP_CMD.STATUS, {}); }, 4000);
    setInterval(() => { if (this.connected && this.ws) { try { this.ws.send('ping'); } catch {} } }, 5000);
  }

  // UDP broadcast discovery to learn the MainboardID, then open the WebSocket.
  _discoverThenConnect() {
    if (this.mainboardId) return this._connect();
    let settled = false;
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => { try { sock.close(); } catch {} this._connect(); });
    sock.on('message', (msg) => {
      try {
        const d = JSON.parse(msg.toString());
        const data = d.Data || d.data || {};
        if (data.MainboardID) {
          this.mainboardId = data.MainboardID;
          settled = true;
          try { sock.close(); } catch {}
          this._connect();
        }
      } catch {}
    });
    sock.bind(() => {
      try {
        sock.setBroadcast(true);
        const m = Buffer.from('M99999');
        sock.send(m, 0, m.length, this.p.sdcpDiscoveryPort || 3000, this.ip);            // unicast
        sock.send(m, 0, m.length, this.p.sdcpDiscoveryPort || 3000, '255.255.255.255');  // broadcast
      } catch {}
    });
    // Connect anyway after a moment; the board id can also arrive in pushed status.
    setTimeout(() => { if (!settled) this._connect(); }, 2500);
  }

  _connect() {
    if (this.ws) return;
    try {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => {
        this.connected = true;
        this.lastStatus = blankStatus({ detail: 'connected, awaiting status…' });
        this._send(SDCP_CMD.ATTRS, {});
        this._send(SDCP_CMD.STATUS, {});
      });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
      ws.addEventListener('close', () => this._reset());
      ws.addEventListener('error', () => this._reset());
    } catch (e) {
      this._reset();
    }
  }

  _reset() {
    this.connected = false;
    try { if (this.ws) this.ws.close(); } catch {}
    this.ws = null;
    this.lastStatus = blankStatus({ detail: 'offline (reconnecting)' });
    clearTimeout(this._reconnectT);
    this._reconnectT = setTimeout(() => this._discoverThenConnect(), 5000);
  }

  _onMessage(raw) {
    if (raw === 'pong' || raw === 'ping') return;
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }

    const topic = msg.Topic || '';

    // Learn MainboardID from a field OR from the topic (sdcp/<kind>/<id>).
    if (!this.mainboardId) {
      let id = msg.MainboardID || (msg.Data && msg.Data.MainboardID) || null;
      if (!id && topic) { const last = topic.split('/').pop(); if (/^[0-9a-fA-F]{6,}$/.test(last || '')) id = last; }
      if (id) { this.mainboardId = id; if (CONFIG.SDCP_DEBUG) console.log('[SDCP ' + this.ip + '] learned MainboardID: ' + id); }
    }

    // Debug: show non-routine traffic (replies, errors, notices, attributes) and
    // the first status message so we can see the field layout this firmware uses.
    if (CONFIG.SDCP_DEBUG) {
      const routine = topic.includes('/status/');
      if (!routine) console.log('[SDCP ' + this.ip + '] <= ' + JSON.stringify(msg).slice(0, 700));
      else if (!this._loggedStatus) { this._loggedStatus = true; console.log('[SDCP ' + this.ip + '] first status: ' + JSON.stringify(msg).slice(0, 700)); }
    }

    // Command replies -> resolve the matching pending request. Match by RequestID;
    // fall back to matching by Cmd, or the sole outstanding request, since some
    // firmware echoes the id differently than the public spec shows.
    if (topic.includes('/response/') && msg.Data) {
      const d = msg.Data;
      let key = null;
      const rid = typeof d.RequestID === 'string' ? d.RequestID.replace(/[\u0000-\u001f]+$/g, '') : d.RequestID;
      if (rid && this.pending.has(rid)) key = rid;
      if (!key) { for (const [k, v] of this.pending) { if (v.cmd != null && d.Cmd === v.cmd) { key = k; break; } } }
      if (!key && this.pending.size === 1) key = this.pending.keys().next().value;
      if (key) {
        const { resolve, timer } = this.pending.get(key);
        clearTimeout(timer);
        this.pending.delete(key);
        resolve(d.Data || d || {});
      }
    }

    // Status messages (pushed automatically). Field locations vary; dig around.
    const status = msg.Status || (msg.Data && msg.Data.Status) || (topic.includes('/status/') ? msg.Data : null);
    if (status && (status.PrintInfo || status.TempOfNozzle != null)) {
      this.lastStatus = this._normalize(status);
      this.lastStatusAt = Date.now();
    }
  }

  _normalize(s) {
    const pi = s.PrintInfo || {};
    const coord = (s.CurrenCoord || s.CurrentCoord || '').split(',').map((n) => parseFloat(n));
    const fans = s.CurrentFanSpeed || {};
    const ticks = (n) => (n == null ? null : (CONFIG.SDCP_TICKS_ARE_MS ? n / 1000 : n));
    const cur = ticks(pi.CurrentTicks), tot = ticks(pi.TotalTicks);

    // Print status codes (PrintInfo.Status): 5/6 paused, 7/8 stopped, 9 complete.
    const ps = pi.Status;
    let state = 'idle';
    if (ps === 6 || ps === 5) state = 'paused';
    else if (ps === 8 || ps === 7) state = 'idle';
    else if (ps === 9) state = 'complete';
    else if (ps != null && ps >= 1 && ps <= 4) state = 'printing';
    // Fall back to machine status if needed.
    const machine = Array.isArray(s.CurrentStatus) ? s.CurrentStatus[0] : s.CurrentStatus;
    if (state === 'idle' && machine === 1) state = 'printing';

    const ls = s.LightStatus || {};
    const rgb = Array.isArray(ls.RgbLight) ? ls.RgbLight : (Array.isArray(s.RgbLight) ? s.RgbLight : [0, 0, 0]);
    const light = { second: ls.SecondLight ? 1 : 0, rgb: [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0] };
    this.light = light;

    return blankStatus({
      online: true,
      state,
      detail: 'sdcp',
      light,
      nozzle: { cur: round1(s.TempOfNozzle), target: round1(s.TempTargetNozzle) },
      bed: { cur: round1(s.TempOfHotbed), target: round1(s.TempTargetHotbed) },
      chamber: { cur: round1(s.TempOfBox), target: round1(s.TempTargetBox) },
      progress: (cur != null && tot) ? Math.min(1, cur / tot) : null,
      layer: { cur: numOrNull(pi.CurrentLayer), total: numOrNull(pi.TotalLayer) },
      elapsedSec: cur,
      timeLeftSec: (cur != null && tot != null) ? Math.max(0, tot - cur) : null,
      filename: pi.Filename || '',
      pos: { x: round2(coord[0]), y: round2(coord[1]), z: round2(coord[2]) },
      speedPct: numOrNull(s.PrintSpeed != null ? s.PrintSpeed : pi.PrintSpeed),
      fans: { model: numOrNull(fans.ModelFan), aux: numOrNull(fans.AuxiliaryFan), box: numOrNull(fans.BoxFan) },
    });
  }

  _send(cmd, dataObj) {
    if (!this.ws || !this.connected) return Promise.reject(new Error('not connected'));
    const requestId = uuid();
    const payload = {
      Id: uuid(),
      Data: { Cmd: cmd, Data: dataObj || {}, RequestID: requestId, MainboardID: this.mainboardId || '', TimeStamp: nowSec(), From: 1 },
      Topic: `sdcp/request/${this.mainboardId || ''}`,
    };
    if (CONFIG.SDCP_DEBUG) console.log('[SDCP ' + this.ip + '] => Cmd ' + cmd + ' (board "' + (this.mainboardId || '') + '")');
    try { this.ws.send(JSON.stringify(payload)); } catch (e) { return Promise.reject(e); }
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve({ _timeout: true }); }, 6000);
      this.pending.set(requestId, { resolve, timer, cmd });
    });
  }

  async getStatus() {
    // Mark stale if we haven't heard from the board in a while.
    if (this.connected && this.lastStatusAt && Date.now() - this.lastStatusAt > 15000) {
      return Object.assign({}, this.lastStatus, { detail: 'stale (no recent update)' });
    }
    return this.lastStatus;
  }

  async action(name, params = {}) {
    switch (name) {
      case 'pause':  return this._send(SDCP_CMD.PAUSE, {});
      case 'resume': return this._send(SDCP_CMD.CONTINUE, {});
      case 'abort':  return this._send(SDCP_CMD.STOP, {});
      case 'setSpeed': return this._send(SDCP_CMD.CONFIG, { PrintSpeedPct: Math.round(Number(params.pct) || 100) });
      case 'setFan': {
        const cur = this.lastStatus.fans || {};
        const fanObj = {
          ModelFan: params.fan === 'model' ? Math.round(params.pct) : (cur.model == null ? 0 : cur.model),
          AuxiliaryFan: params.fan === 'aux' ? Math.round(params.pct) : (cur.aux == null ? 0 : cur.aux),
          BoxFan: params.fan === 'box' ? Math.round(params.pct) : (cur.box == null ? 0 : cur.box),
        };
        return this._send(SDCP_CMD.CONFIG, { TargetFanSpeed: fanObj });
      }
      case 'setLight': {
        // Cmd 403 with a LightStatus payload (SecondLight = white LED on/off,
        // RgbLight = [r,g,b] accent lighting). Merge over last known so toggling
        // one doesn't clobber the other.
        const cur = this.light || { second: 0, rgb: [0, 0, 0] };
        const second = (params.second != null) ? !!params.second : !!cur.second;
        let rgb = Array.isArray(params.rgb) ? params.rgb : cur.rgb;
        rgb = [Number(rgb[0]) || 0, Number(rgb[1]) || 0, Number(rgb[2]) || 0].map((n) => Math.max(0, Math.min(255, Math.round(n))));
        return this._send(SDCP_CMD.CONFIG, { LightStatus: { SecondLight: second, RgbLight: rgb } });
      }
      case 'jog':
      case 'setTemp':
        throw new Error('not supported by the Centauri SDCP API');
      default: throw new Error('unsupported action: ' + name);
    }
  }

  async files() {
    const r = await this._send(SDCP_CMD.FILES, { Url: '/local/' });
    const list = (r && r.FileList) || [];
    return list.filter((f) => f.type === 1).map((f) => ({
      name: f.name, sizeMB: f.usedSize ? (f.usedSize / 1048576).toFixed(2) : null, modified: null,
    }));
  }

  async history() {
    const ids = await this._send(SDCP_CMD.HISTORY, {});
    const idList = (ids && ids.HistoryData) || [];
    if (!idList.length) return [];
    const det = await this._send(SDCP_CMD.HIST_DETAIL, { Id: idList.slice(0, 50) });
    const detail = (det && det.HistoryDetailList) || [];
    const TASK = { 0: 'other', 1: 'completed', 2: 'error', 3: 'stopped' };
    return detail.map((d) => ({
      name: d.TaskName, status: TASK[d.TaskStatus] || String(d.TaskStatus),
      started: d.BeginTime ? new Date(d.BeginTime * 1000).toISOString() : null,
      durationSec: (d.BeginTime && d.EndTime) ? d.EndTime - d.BeginTime : null,
    }));
  }

  async videoUrl() {
    const info = await this.cameraInfo();
    return info.ok ? info.url : null;
  }

  invalidateVideo() { this.videoUrlCached = null; this.videoUrlAt = 0; }

  // Sends Cmd 386 (enable video) and returns {ok, url, ack, reason, board}.
  async cameraInfo() {
    if (this.videoUrlCached && Date.now() - this.videoUrlAt < 45000)
      return { ok: true, url: this.videoUrlCached, ack: 0, reason: '', board: this.mainboardId };
    if (!this.connected)
      return { ok: false, url: null, ack: null, reason: 'Printer not connected yet.', board: this.mainboardId };

    const r = await this._send(SDCP_CMD.VIDEO, { Enable: 1 });
    console.log('[SDCP ' + this.ip + '] Cmd386 (enable video) response:', JSON.stringify(r));

    if (r && r._timeout) {
      const idNote = this.mainboardId ? '' : ' (no MainboardID resolved — the printer may be ignoring commands; UDP discovery on port 3000 is likely blocked)';
      return { ok: false, url: null, ack: null, reason: 'No response from printer to enable-video (Cmd 386 timed out)' + idNote + '.', board: this.mainboardId };
    }

    // VideoUrl may sit at the top of the reply or one level down.
    const url0 = (r && (r.VideoUrl || (r.Data && r.Data.VideoUrl))) || null;
    const ack = r ? (r.Ack != null ? r.Ack : (r.Data && r.Data.Ack)) : null;
    if (url0 && (ack === 0 || ack == null)) {
      let url = url0;
      if (!/^https?:\/\//i.test(url)) url = 'http://' + url; // V1.1.46 firmware omits the scheme
      if (this.p.forceVideoHost !== false) {
        try { const u = new URL(url); u.hostname = this.ip; url = u.toString(); } catch {}
      }
      this.videoUrlCached = url; this.videoUrlAt = Date.now();
      console.log('[SDCP ' + this.ip + '] camera stream URL:', url);
      return { ok: true, url, ack: 0, reason: '', board: this.mainboardId };
    }
    const reason = VIDEO_ACK_REASON[ack] || ('Camera unavailable (the printer replied but with no video URL; ack=' + ack + ').');
    return { ok: false, url: null, ack, reason, board: this.mainboardId };
  }
}

/* ========================================================================== */
/*  Shared MJPEG hub — one upstream per printer, fanned out to all viewers.   */
/*  (The Centauri allows only ONE camera stream, so sharing is required.)     */
/* ========================================================================== */

class MjpegHub {
  constructor() { this.clients = new Set(); this.upstream = null; this.url = null; this.headers = null; }
  setUrl(url) { if (url && url !== this.url) { this.url = url; this._fail(); } }

  attach(res) {
    this.clients.add(res);
    if (this.headers && !res.headersSent) res.writeHead(200, this.headers);
    if (!this.upstream) this._open();
    res.on('close', () => { this.clients.delete(res); if (this.clients.size === 0) this._close(); });
  }

  _open() {
    if (!this.url) return;
    let u;
    try { u = new URL(this.url); } catch { return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, (up) => {
      this.headers = {
        'Content-Type': up.headers['content-type'] || 'multipart/x-mixed-replace; boundary=BoundaryString',
        'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Connection': 'close',
      };
      for (const res of this.clients) if (!res.headersSent) res.writeHead(200, this.headers);
      up.on('data', (chunk) => { for (const res of this.clients) { try { res.write(chunk); } catch {} } });
      up.on('end', () => this._fail());
      up.on('error', () => this._fail());
    });
    req.on('error', () => this._fail());
    this.upstream = req;
  }

  _close() { try { if (this.upstream) this.upstream.destroy(); } catch {} this.upstream = null; this.headers = null; }

  // Upstream died -> end all client responses so their <img> retries, then reset.
  _fail() {
    this._close();
    for (const res of this.clients) { try { res.end(); } catch {} }
    this.clients.clear();
    if (this.onFail) { try { this.onFail(); } catch {} }
  }
}

/* ========================================================================== */
/*  Wire up drivers + hubs                                                    */
/* ========================================================================== */

const drivers = CONFIG.PRINTERS.map((p) => (p.driver === 'sdcp' ? new SdcpDriver(p) : new MoonrakerDriver(p)));
const hubs = CONFIG.PRINTERS.map(() => new MjpegHub());
hubs.forEach((h, i) => { h.onFail = () => { if (drivers[i].invalidateVideo) drivers[i].invalidateVideo(); }; });

/* ========================================================================== */
/*  AI spaghetti watchdog                                                      */
/*  Polls a self-hosted Obico ML API on the Giga's snapshot. Behaviour depends  */
/*  on `mode`: notify (alert only), act (auto-cancel), schedule (act at night,  */
/*  notify by day), off. Auto-cancel reuses the Giga's existing Moonraker        */
/*  cancel - the SAME call as the Abort button. Settings persist to a JSON file.*/
/* ========================================================================== */

const SPAG_SETTINGS_PATH = path.join(__dirname, 'spaghetti.settings.json');

const Spaghetti = (() => {
  const C = CONFIG.SPAGHETTI || {};
  const MODES = ['off', 'notify', 'act', 'schedule'];
  const idx = (typeof C.printerIndex === 'number' && C.printerIndex >= 0)
    ? C.printerIndex
    : CONFIG.PRINTERS.findIndex((pr) => pr.driver === 'moonraker');

  const state = {
    printerIndex: idx,
    mode: MODES.includes(C.mode) ? C.mode : 'notify',
    schedule: { actStart: (C.schedule && C.schedule.actStart) || '22:00', actEnd: (C.schedule && C.schedule.actEnd) || '07:00' },
    thresholds: {
      consecutiveTrips: C.consecutiveTrips || 4,
      frameScoreTrip: C.frameScoreTrip != null ? C.frameScoreTrip : 0.6,
      highConf: C.highConf != null ? C.highConf : 0.7,
      confFloor: C.confFloor != null ? C.confFloor : 0.3,
      startGraceSec: C.startGraceSec != null ? C.startGraceSec : 150,
    },
    ignoreZones: Array.isArray(C.ignoreZones) ? C.ignoreZones.slice() : [],
    notify: { ntfy: !!(C.notify && C.notify.ntfy), ntfyTopic: ((C.notify && C.notify.ntfyTopic) || C.ntfyTopic || '') },
    // live (not persisted):
    status: 'idle',          // disabled|idle|offline|grace|watching|warning|alert|acted|error
    streak: 0,
    lastScore: 0, lastMax: 0, boxes: 0,
    lastCheckSec: null, lastActionSec: null, alertSince: null,
    message: 'starting…',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('[spaghetti]', ...a);
  const pname = () => (CONFIG.PRINTERS[idx] && (CONFIG.PRINTERS[idx].nickname || CONFIG.PRINTERS[idx].name)) || 'the printer';
  // The topic can be set live in the UI (state.notify.ntfyTopic); fall back to CONFIG.
  const ntfyTopic = () => state.notify.ntfyTopic || (C.notify && C.notify.ntfyTopic) || C.ntfyTopic || '';

  function sanitizeThresholds(t) {
    const o = {};
    if (t.consecutiveTrips != null) o.consecutiveTrips = Math.max(1, Math.min(20, Math.round(Number(t.consecutiveTrips)) || 4));
    if (t.frameScoreTrip != null) o.frameScoreTrip = Math.max(0.1, Math.min(5, Number(t.frameScoreTrip) || 0.6));
    if (t.highConf != null) o.highConf = Math.max(0.3, Math.min(0.99, Number(t.highConf) || 0.7));
    if (t.confFloor != null) o.confFloor = Math.max(0.05, Math.min(0.9, Number(t.confFloor) || 0.3));
    if (t.startGraceSec != null) o.startGraceSec = Math.max(0, Math.min(3600, Math.round(Number(t.startGraceSec)) || 150));
    return o;
  }
  function persistable() { return { mode: state.mode, schedule: state.schedule, thresholds: state.thresholds, ignoreZones: state.ignoreZones, notify: { ntfy: state.notify.ntfy, ntfyTopic: state.notify.ntfyTopic } }; }
  function save() {
    try { fs.writeFileSync(SPAG_SETTINGS_PATH, JSON.stringify(persistable(), null, 2)); return true; }
    catch (e) { log('save failed:', e.message); return false; }
  }
  function load() {
    let raw; try { raw = fs.readFileSync(SPAG_SETTINGS_PATH, 'utf8'); } catch { return; }
    try {
      const j = JSON.parse(raw); if (!j || typeof j !== 'object') return;
      if (MODES.includes(j.mode)) state.mode = j.mode;
      if (j.schedule && /^\d{1,2}:\d{2}$/.test(j.schedule.actStart || '') && /^\d{1,2}:\d{2}$/.test(j.schedule.actEnd || '')) state.schedule = { actStart: j.schedule.actStart, actEnd: j.schedule.actEnd };
      if (j.thresholds) Object.assign(state.thresholds, sanitizeThresholds(j.thresholds));
      if (Array.isArray(j.ignoreZones)) state.ignoreZones = j.ignoreZones.filter((z) => Array.isArray(z) && z.length >= 4).map((z) => z.slice(0, 4).map((n) => Math.round(Number(n))));
      if (j.notify && 'ntfy' in j.notify) state.notify.ntfy = !!j.notify.ntfy;
      if (j.notify && typeof j.notify.ntfyTopic === 'string') state.notify.ntfyTopic = j.notify.ntfyTopic.trim();
      log('loaded saved settings (mode=' + state.mode + ')');
    } catch (e) { log('settings file unreadable, using CONFIG defaults:', e.message); }
  }

  function parseHM(str, dflt) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '')); if (!m) return dflt; const h = +m[1], mi = +m[2]; return (h > 23 || mi > 59) ? dflt : h * 60 + mi; }
  function inActWindow() {
    const s = parseHM(state.schedule.actStart, 1320), e = parseHM(state.schedule.actEnd, 420);
    if (s === e) return false;
    const n = new Date(); const cur = n.getHours() * 60 + n.getMinutes();
    return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e); // wraps past midnight
  }
  function effectiveMode() { return state.mode === 'schedule' ? (inActWindow() ? 'act' : 'notify') : state.mode; }

  // Low-level ntfy push. ntfy reads Title/Priority/Tags from HTTP headers and the
  // alert text from the body. Header values must be ASCII (Latin-1), so emoji go in
  // Tags (ntfy renders e.g. "warning" as ⚠️); the UTF-8 body can hold anything.
  async function ntfyPush(text, { title, priority, tags } = {}) {
    const topic = ntfyTopic();
    if (!topic) return { ok: false, reason: 'no ntfy topic set' };
    const headers = {};
    if (title) headers.Title = String(title).replace(/[^\x20-\x7e]/g, '').slice(0, 120);
    if (priority) headers.Priority = String(priority);
    if (tags) headers.Tags = String(tags);
    try { await httpRequest('POST', topic, { body: text, headers, timeout: 8000 }); return { ok: true }; }
    catch (e) { log('ntfy failed:', e.message); return { ok: false, reason: (e.code || e.message) }; }
  }
  async function notify(text, opts) {
    if (!state.notify.ntfy || !ntfyTopic()) return;
    await ntfyPush(text, opts);
  }

  function inIgnore(cx, cy) {
    for (const z of state.ignoreZones) {
      if (!Array.isArray(z) || z.length < 4) continue;
      if (Math.abs(cx - z[0]) <= z[2] / 2 && Math.abs(cy - z[1]) <= z[3] / 2) return true;
    }
    return false;
  }
  async function rawDetections() {
    const api = String(C.mlApi || '').replace(/\/+$/, '') + '/p/?img=' + encodeURIComponent(C.snapshotUrl || '');
    const r = await httpRequest('GET', api, { timeout: C.httpTimeoutMs || 15000 });
    return Array.isArray(r.json) ? r.json : [];   // [["failure", conf, [cx,cy,w,h]], ...]
  }
  function scoreOf(dets) {
    let summed = 0, mx = 0, kept = 0;
    for (const d of dets) {
      const conf = Number(d && d[1]); const box = d && d[2];
      if (!isFinite(conf) || !Array.isArray(box)) continue;
      if (conf < state.thresholds.confFloor) continue;
      if (inIgnore(Number(box[0]), Number(box[1]))) continue;
      summed += conf; if (conf > mx) mx = conf; kept++;
    }
    return { summed, mx, kept };
  }

  async function fire() {
    try {
      await drivers[idx].action('abort');                       // <-- SAME call the Abort button makes
      state.status = 'acted'; state.lastActionSec = nowSec(); state.message = 'CANCELLED - spaghetti detected';
      log('CANCEL sent to', pname());
      await notify('Spaghetti detected on ' + pname() + ' - print CANCELLED.', { title: 'Print cancelled - ' + pname(), priority: 'urgent', tags: 'rotating_light' });
    } catch (e) {
      state.status = 'error'; state.message = 'cancel FAILED: ' + e.message; log('cancel failed:', e.message);
      await notify('Spaghetti on ' + pname() + ' but CANCEL FAILED: ' + e.message, { title: 'CANCEL FAILED - ' + pname(), priority: 'urgent', tags: 'rotating_light' });
    }
  }
  function raiseAlert() {
    if (state.status === 'alert') return;                       // already latched
    state.status = 'alert'; state.alertSince = nowSec(); state.message = 'ALERT - spaghetti detected; stop it manually';
    log('ALERT (notify) on', pname());
    notify('\u26a0 Possible spaghetti on ' + pname() + ' - open the console and stop the print.', { title: 'Failure detected - ' + pname(), priority: 'high', tags: 'warning' });
  }

  async function tick() {
    if (idx < 0 || !drivers[idx]) { state.status = 'disabled'; state.message = 'no Moonraker printer to watch'; return; }
    if (state.mode === 'off') { state.status = 'disabled'; state.streak = 0; state.message = 'off'; return; }

    const st = await drivers[idx].getStatus();
    state.lastCheckSec = nowSec();

    if (st.state !== 'printing') {
      state.streak = 0;
      if ((state.status === 'acted' || state.status === 'alert') && (nowSec() - (state.lastActionSec || state.alertSince || 0) < 10)) return; // brief hold
      state.status = st.online ? 'idle' : 'offline';
      state.message = st.online ? ('printer ' + st.state) : 'printer offline';
      state.alertSince = null;
      return;
    }
    if (state.status === 'alert') { state.message = 'ALERT - stop it manually'; return; }   // latched until reset/stop
    if (state.status === 'acted') return;

    if ((st.elapsedSec || 0) < state.thresholds.startGraceSec) {
      state.streak = 0; state.status = 'grace';
      state.message = 'start grace (' + Math.round(st.elapsedSec || 0) + 's/' + state.thresholds.startGraceSec + 's)';
      return;
    }

    let dets;
    try { dets = await rawDetections(); }
    catch (e) { state.streak = 0; state.status = 'error'; state.message = 'ML API: ' + (e.code || e.message); return; }
    const { summed, mx, kept } = scoreOf(dets);
    state.lastScore = round2(summed); state.lastMax = round2(mx); state.boxes = kept;
    const need = state.thresholds.consecutiveTrips;
    const tripped = summed >= state.thresholds.frameScoreTrip || mx >= state.thresholds.highConf;

    if (tripped) {
      state.streak++;
      state.status = state.streak >= need ? 'tripped' : 'warning';
      state.message = 'trip ' + state.streak + '/' + need + ' (sum ' + round2(summed) + ', max ' + round2(mx) + ')';
      log('TRIP', state.streak + '/' + need, 'sum=' + round2(summed), 'max=' + round2(mx), 'boxes=' + kept);
      if (state.streak === 1 && C.notifyOnFirstTrip) notify('Possible spaghetti forming on ' + pname() + '…', { title: 'Watching - ' + pname(), priority: 'low', tags: 'eyes' });
      if (state.streak >= need) {
        if (effectiveMode() === 'act') { await fire(); state.streak = 0; await sleep((C.pollSeconds || 25) * 3 * 1000); }
        else { raiseAlert(); state.streak = 0; }                // notify: latch, don't cancel
      }
    } else {
      state.streak = 0; state.status = 'watching';
      state.message = 'watching (sum ' + round2(summed) + ', max ' + round2(mx) + ')';
    }
  }

  let running = false;
  async function loop() {
    running = true;
    log('watchdog mode=' + state.mode, '- printer #' + idx, '(' + pname() + ')', state.mode === 'schedule' ? ('| auto-cancel ' + state.schedule.actStart + '-' + state.schedule.actEnd) : '');
    if (!C.mlApi || /CHANGE-ME/i.test(C.mlApi)) { state.status = 'error'; state.message = 'set CONFIG.SPAGHETTI.mlApi to your ML API address'; log(state.message); }
    for (;;) {
      try { await tick(); }
      catch (e) { state.streak = 0; state.status = 'error'; state.message = 'check error: ' + (e.code || e.message); log('tick error (ignored):', e.message); }
      await sleep((C.pollSeconds || 25) * 1000);
    }
  }

  function snapshot() {
    return {
      printerIndex: state.printerIndex,
      mode: state.mode,
      effectiveMode: effectiveMode(),
      inActWindow: state.mode === 'schedule' ? inActWindow() : (state.mode === 'act'),
      schedule: state.schedule,
      thresholds: state.thresholds,
      ignoreZones: state.ignoreZones,
      notify: { ntfy: state.notify.ntfy, ntfyTopic: ntfyTopic(), ntfyConfigured: !!ntfyTopic() },
      status: state.status,
      streak: state.streak,
      need: state.thresholds.consecutiveTrips,
      lastScore: state.lastScore, lastMax: state.lastMax, boxes: state.boxes,
      lastCheckSec: state.lastCheckSec, lastActionSec: state.lastActionSec,
      message: state.message,
      snapshotUrl: C.snapshotUrl || '',
      mlConfigured: !(!C.mlApi || /CHANGE-ME/i.test(C.mlApi)),
    };
  }

  function applySettings(patch) {
    let changed = false;
    if (patch && MODES.includes(patch.mode) && patch.mode !== state.mode) {
      state.mode = patch.mode; state.streak = 0; state.alertSince = null;
      if (['alert', 'acted', 'error'].includes(state.status)) state.status = 'idle';
      changed = true;
    }
    if (patch && patch.schedule && typeof patch.schedule === 'object') {
      if (/^\d{1,2}:\d{2}$/.test(patch.schedule.actStart || '')) { state.schedule.actStart = patch.schedule.actStart; changed = true; }
      if (/^\d{1,2}:\d{2}$/.test(patch.schedule.actEnd || '')) { state.schedule.actEnd = patch.schedule.actEnd; changed = true; }
    }
    if (patch && patch.thresholds && typeof patch.thresholds === 'object') { Object.assign(state.thresholds, sanitizeThresholds(patch.thresholds)); changed = true; }
    if (patch && Array.isArray(patch.ignoreZones)) { state.ignoreZones = patch.ignoreZones.filter((z) => Array.isArray(z) && z.length >= 4).map((z) => z.slice(0, 4).map((n) => Math.round(Number(n)))); changed = true; }
    if (patch && patch.notify && typeof patch.notify === 'object') {
      if ('ntfy' in patch.notify) { state.notify.ntfy = !!patch.notify.ntfy; changed = true; }
      if (typeof patch.notify.ntfyTopic === 'string') { state.notify.ntfyTopic = patch.notify.ntfyTopic.trim(); changed = true; }
    }
    if (changed) save();
    return changed;
  }

  async function probe() {
    const base = { snapshotUrl: C.snapshotUrl || '', ignoreZones: state.ignoreZones, thresholds: state.thresholds };
    if (!C.mlApi || /CHANGE-ME/i.test(C.mlApi)) return Object.assign({ ok: false, reason: 'mlApi not set in CONFIG' }, base);
    try { const dets = await rawDetections(); return Object.assign({ ok: true, detections: dets, score: scoreOf(dets) }, base); }
    catch (e) { return Object.assign({ ok: false, reason: (e.code || e.message) }, base); }
  }

  async function testNotify() {
    if (!ntfyTopic()) return { ok: false, reason: 'no ntfy topic set - enter one in the Notifications panel (or CONFIG.SPAGHETTI.notify.ntfyTopic)' };
    return ntfyPush('Test alert from the Forge console - phone notifications are working.', { title: 'Forge console test', priority: 'high', tags: 'white_check_mark' });
  }

  load(); // overlay any saved settings on top of CONFIG defaults

  return {
    snapshot, applySettings, probe, testNotify,
    start() { if (!running) loop(); },
    reset() { state.streak = 0; state.alertSince = null; if (['alert', 'acted', 'tripped', 'error'].includes(state.status)) { state.status = 'idle'; state.message = 'reset'; } return true; },
  };
})();

/* ========================================================================== */
/*  HTTP server                                                               */
/* ========================================================================== */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };

function serveStatic(file, res) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}
function sendJson(res, obj, code = 200) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } }); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') return serveStatic('index.html', res);
    if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }

    if (p === '/api/printers') {
      return sendJson(res, CONFIG.PRINTERS.map((pr, i) => ({
        id: i, name: pr.name, nickname: pr.nickname || null, model: pr.model, driver: pr.driver, caps: drivers[i].caps,
      })));
    }

    if (p === '/api/spaghetti') return sendJson(res, Spaghetti.snapshot());
    if (p === '/api/spaghetti/settings' && req.method === 'POST') {
      const body = await readBody(req);
      Spaghetti.applySettings(body);
      return sendJson(res, { ok: true, state: Spaghetti.snapshot() });
    }
    if (p === '/api/spaghetti/reset' && req.method === 'POST') {
      Spaghetti.reset();
      return sendJson(res, { ok: true, state: Spaghetti.snapshot() });
    }
    if (p === '/api/spaghetti/probe') return sendJson(res, await Spaghetti.probe());
    if (p === '/api/spaghetti/test-notify' && req.method === 'POST') return sendJson(res, await Spaghetti.testNotify());

    if (p === '/api/files/config') {
      return sendJson(res, { enabled: !!CONFIG.FILE_BROWSER.enabled, writable: !!CONFIG.FILE_BROWSER.writable, label: CONFIG.FILE_BROWSER.label, root: CONFIG.FILE_BROWSER.root });
    }
    if (p === '/api/files/browse') {
      if (!CONFIG.FILE_BROWSER.enabled) return sendJson(res, { error: 'disabled' }, 404);
      try { return sendJson(res, await listDir(url.searchParams.get('path') || '')); }
      catch (e) {
        return sendJson(res, { error: e.code === 'ENOENT' ? 'folder not found' : (e.message || 'error'), cwd: url.searchParams.get('path') || '', crumbs: [{ name: CONFIG.FILE_BROWSER.label, rel: '' }], parent: null, entries: [] });
      }
    }
    if (p === '/api/files/thumb') {
      const t = await getThumb(url.searchParams.get('path') || '').catch(() => null);
      if (!t || !t.buffer) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': t.contentType, 'Cache-Control': 'max-age=300' });
      return res.end(t.buffer);
    }
    if (p === '/api/files/mkdir' && req.method === 'POST') {
      if (!CONFIG.FILE_BROWSER.writable) return sendJson(res, { ok: false, error: 'library is read-only' }, 403);
      const body = await readBody(req);
      const parent = safeResolve(body.path || '');
      const name = sanitizeName(body.name);
      if (!parent || !name) return sendJson(res, { ok: false, error: 'bad name or path' }, 400);
      try { await fsp.mkdir(path.join(parent, name)); return sendJson(res, { ok: true }); }
      catch (e) { return sendJson(res, { ok: false, error: e.code === 'EEXIST' ? 'a folder with that name already exists' : (e.message || 'error') }, 200); }
    }
    if (p === '/api/files/rename' && req.method === 'POST') {
      if (!CONFIG.FILE_BROWSER.writable) return sendJson(res, { ok: false, error: 'library is read-only' }, 403);
      const body = await readBody(req);
      const src = safeResolve(body.from || '');
      const name = sanitizeName(body.name);
      if (!src || !name) return sendJson(res, { ok: false, error: 'bad name or path' }, 400);
      const dst = path.join(path.dirname(src), name);
      if (safeResolve(path.relative(path.resolve(CONFIG.FILE_BROWSER.root), dst).replace(/\\/g, '/')) == null) return sendJson(res, { ok: false, error: 'outside root' }, 400);
      try { await fsp.rename(src, dst); return sendJson(res, { ok: true }); }
      catch (e) { return sendJson(res, { ok: false, error: e.code === 'EEXIST' ? 'name already in use' : (e.message || 'error') }, 200); }
    }
    if (p === '/api/files/move' && req.method === 'POST') {
      if (!CONFIG.FILE_BROWSER.writable) return sendJson(res, { ok: false, error: 'library is read-only' }, 403);
      const body = await readBody(req);
      const src = safeResolve(body.from || '');
      const destDir = safeResolve(body.toDir || '');
      if (!src || !destDir) return sendJson(res, { ok: false, error: 'bad path' }, 400);
      try {
        const dstat = await fsp.stat(destDir);
        if (!dstat.isDirectory()) return sendJson(res, { ok: false, error: 'destination is not a folder' }, 200);
        const dst = path.join(destDir, path.basename(src));
        if (dst === src) return sendJson(res, { ok: false, error: 'already there' }, 200);
        // Don't move a folder into itself/its own subtree.
        if ((dst + path.sep).startsWith(src + path.sep)) return sendJson(res, { ok: false, error: "can't move a folder into itself" }, 200);
        try { await fsp.access(dst); return sendJson(res, { ok: false, error: 'an item with that name already exists there' }, 200); } catch {}
        await fsp.rename(src, dst);
        return sendJson(res, { ok: true });
      } catch (e) { return sendJson(res, { ok: false, error: e.code === 'ENOENT' ? 'not found' : (e.message || 'error') }, 200); }
    }
    if (p === '/api/files/download') {
      const abs = safeResolve(url.searchParams.get('path') || '');
      if (!abs) { res.writeHead(403); return res.end('forbidden'); }
      return fs.stat(abs, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="' + path.basename(abs).replace(/"/g, '') + '"',
          'Content-Length': st.size,
        });
        fs.createReadStream(abs).pipe(res);
      });
    }
    if (p === '/api/files/delete' && req.method === 'POST') {
      if (!CONFIG.FILE_BROWSER.writable) return sendJson(res, { ok: false, error: 'library is read-only' }, 403);
      const body = await readBody(req);
      const src = safeResolve(body.path || '');
      const root = path.resolve(CONFIG.FILE_BROWSER.root);
      if (!src || src === root) return sendJson(res, { ok: false, error: 'bad path' }, 400);
      // Don't hard-delete: move into a hidden .trash folder (recoverable on the
      // server). .trash is filtered out of listings (starts with a dot).
      try {
        const trash = path.join(root, '.trash');
        await fsp.mkdir(trash, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        await fsp.rename(src, path.join(trash, stamp + '__' + path.basename(src)));
        return sendJson(res, { ok: true, trashed: true });
      } catch (e) { return sendJson(res, { ok: false, error: e.code === 'ENOENT' ? 'not found' : (e.message || 'error') }, 200); }
    }

    let m;
    if ((m = p.match(/^\/api\/(\d+)\/status$/))) {
      const d = drivers[+m[1]]; if (!d) return sendJson(res, { error: 'no such printer' }, 404);
      return sendJson(res, await d.getStatus());
    }

    if ((m = p.match(/^\/api\/(\d+)\/files$/))) {
      const d = drivers[+m[1]]; if (!d) return sendJson(res, [], 404);
      return sendJson(res, await d.files());
    }

    if ((m = p.match(/^\/api\/(\d+)\/history$/))) {
      const d = drivers[+m[1]]; if (!d) return sendJson(res, [], 404);
      return sendJson(res, await d.history());
    }

    if ((m = p.match(/^\/api\/(\d+)\/action$/)) && req.method === 'POST') {
      const i = +m[1]; const d = drivers[i]; if (!d) return sendJson(res, { error: 'no such printer' }, 404);
      const body = await readBody(req);
      if (['jog', 'setTemp'].includes(body.action) && !d.caps[body.action])
        return sendJson(res, { error: 'unsupported on this printer' }, 400);
      try { const r = await d.action(body.action, body); return sendJson(res, { ok: true, result: r || null }); }
      catch (e) { return sendJson(res, { ok: false, error: e.message }, 400); }
    }

    if ((m = p.match(/^\/api\/(\d+)\/connection$/))) {
      const d = drivers[+m[1]]; if (!d) return sendJson(res, { ok: false, reason: 'no such printer' }, 404);
      if (d.connectionInfo) { try { return sendJson(res, await d.connectionInfo()); } catch (e) { return sendJson(res, { ok: false, reason: e.message }); } }
      return sendJson(res, { ok: d.connected !== false, base: null, reason: 'n/a for this driver' });
    }

    if ((m = p.match(/^\/api\/(\d+)\/camera$/))) {
      const d = drivers[+m[1]]; if (!d) return sendJson(res, { ok: false, reason: 'no such printer' }, 404);
      try { return sendJson(res, await d.cameraInfo()); }
      catch (e) { return sendJson(res, { ok: false, reason: e.message }); }
    }

    if ((m = p.match(/^\/api\/(\d+)\/stream$/))) {
      const i = +m[1]; const d = drivers[i]; const hub = hubs[i];
      if (!d) { res.writeHead(404); return res.end(); }
      let info = { ok: false, url: null, reason: 'camera unavailable' };
      try { info = await d.cameraInfo(); } catch (e) { info.reason = e.message; }
      if (!info.ok || !info.url) {
        res.writeHead(503, { 'Content-Type': 'text/plain', 'X-Camera-Reason': String(info.reason || 'camera unavailable').slice(0, 200) });
        return res.end(info.reason || 'camera unavailable');
      }
      hub.setUrl(info.url);
      return hub.attach(res);
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('server error'); }
  }
});

if (require.main === module) {
  server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log('\n  Printer Console running.');
    console.log('  Local:    http://localhost:' + CONFIG.PORT);
    console.log('  Network:  http://<this-server-ip>:' + CONFIG.PORT + '   <-- open on the laptops\n');
    CONFIG.PRINTERS.forEach((pr, i) => console.log('   [' + i + '] ' + pr.name + '  (' + pr.driver + ')  ' + pr.ip));
    console.log('\n  Ctrl+C to stop.\n');
  });
  Spaghetti.start();
}

module.exports = { MjpegHub, MoonrakerDriver, SdcpDriver, blankStatus, CONFIG, listDir, getThumb, safeResolve, Spaghetti };
