// ZOMBIES online server: static hosting + WebSocket relay (host-authoritative, up to 4 players per room).
// Protocol matches the game client's net layer:
//  client -> server: host | join{code} | resume{code,id,token} | ka | lock{on} | leave
//                    all{d}      (host -> every guest, delivered as msg{d})
//                    to{id,d}    (host -> one guest,  delivered as msg{d})
//                    in{d}       (guest -> host,      delivered as from{id,d})
//  server -> client: room{code,token} | joined{id,host,started,code,token} | resumed{host}
//                    peer{id,join} (to host) | newhost{id} | err{msg,fatal} | ka | closed
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_PLAYERS = 4;
const HOST_GRACE_MS = +process.env.HOST_GRACE_MS || 8000;     // wait this long for a dropped host to resume before handing over
const GUEST_GRACE_MS = 45000;   // matches the client's 45s reconnect window
const MAX_CONN_PER_IP = 12;

// ---------------------------------------------------------------- static files
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const gzCache = new Map();
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    const h = { 'Content-Type': TYPES[ext] || 'application/octet-stream' };
    // html / service worker must always revalidate so players get new builds (the client kicks old versions)
    h['Cache-Control'] = (ext === '.html' || p === '/sw.js' || p === '/config.js') ? 'no-cache' : 'public, max-age=86400';
    const wantsGz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /\.(html|js|json|webmanifest|svg)$/.test(file);
    if (wantsGz) {
      const key = file + st.mtimeMs;
      let buf = gzCache.get(key);
      if (!buf) { buf = zlib.gzipSync(fs.readFileSync(file), { level: 9 }); gzCache.set(key, buf); }
      h['Content-Encoding'] = 'gzip'; h['Content-Length'] = buf.length; h.Vary = 'Accept-Encoding';
      res.writeHead(200, h); return res.end(buf);
    }
    h['Content-Length'] = st.size; res.writeHead(200, h);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- daily leaderboard (simple JSON file store)
fs.mkdirSync(DATA_DIR, { recursive: true });
const LB_FILE = path.join(DATA_DIR, 'leaderboard.json');
let LB = {};
try { LB = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')); } catch (_) {}
let lbDirty = false;
setInterval(() => { if (!lbDirty) return; lbDirty = false; fs.writeFile(LB_FILE, JSON.stringify(LB), () => {}); }, 15000);
const today = () => new Date().toISOString().slice(0, 10);
function lbTop(day, n = 20) { return (LB[day] || []).slice(0, n); }
function lbPrune() { const keys = Object.keys(LB).sort(); while (keys.length > 14) delete LB[keys.shift()]; }

function readBody(req, cb) {
  let s = ''; req.on('data', c => { s += c; if (s.length > 4096) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(s)); } catch (_) { cb(null); } });
}
function json(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST' });
    return res.end();
  }
  if (url.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size });
  if (url.pathname === '/api/daily' && req.method === 'GET') {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : today();
    return json(res, 200, { day, top: lbTop(day) });
  }
  if (url.pathname === '/api/daily' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b) return json(res, 400, { err: 'bad json' });
      const name = String(b.name || 'Survivor').replace(/[^\w \-]/g, '').slice(0, 12) || 'Survivor';
      const round = Math.floor(+b.round), kills = Math.floor(+b.kills) || 0;
      if (!(round >= 1 && round <= 500)) return json(res, 400, { err: 'bad round' });
      const day = today();
      const list = LB[day] || (LB[day] = []);
      list.push({ name, round, kills, mode: String(b.mode || '').slice(0, 16), at: Date.now() });
      list.sort((a, c) => c.round - a.round || c.kills - a.kills);
      if (list.length > 100) list.length = 100;
      lbDirty = true; lbPrune();
      json(res, 200, { day, top: lbTop(day) });
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
});

// ---------------------------------------------------------------- rooms
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() { for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; if (!rooms.has(c)) return c; } }
const token = () => crypto.randomBytes(12).toString('hex');
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(typeof o === 'string' ? o : JSON.stringify(o)); };

function addMember(room, ws) {
  const id = room.nextId++;
  const m = { id, token: token(), ws, name: '', timer: null };
  room.members.set(id, m); ws.ctx = { room, id }; return m;
}
function liveMembers(room) { return [...room.members.values()].filter(m => m.ws && m.ws.readyState === 1); }

function removeMember(room, id, explicit) {
  const m = room.members.get(id); if (!m) return;
  clearTimeout(m.timer); room.members.delete(id);
  if (room.members.size === 0) { rooms.delete(room.code); return; }
  if (id === room.host) {
    const next = [...room.members.values()].sort((a, b) => a.id - b.id).find(x => x.ws && x.ws.readyState === 1) || [...room.members.values()][0];
    room.host = next.id;
    broadcast(room, { t: 'newhost', id: next.id });
    send(next.ws, { t: 'peer', id, join: false });
  } else {
    const h = room.members.get(room.host); if (h) send(h.ws, { t: 'peer', id, join: false });
  }
}
function broadcast(room, o, exceptId) {
  const s = JSON.stringify(o);
  for (const m of room.members.values()) if (m.id !== exceptId) send(m.ws, s);
}

function onDisconnect(ws) {
  const c = ws.ctx; if (!c) return; ws.ctx = null;
  const { room, id } = c; const m = room.members.get(id);
  if (!m || m.ws !== ws) return;
  m.ws = null;
  const grace = id === room.host ? HOST_GRACE_MS : GUEST_GRACE_MS;
  // only the host's grace period is short; a lone dropped host keeps the room for the full window
  const solo = liveMembers(room).length === 0;
  m.timer = setTimeout(() => removeMember(room, id, false), solo ? GUEST_GRACE_MS : grace);
}

function handle(ws, m) {
  const t = m.t;
  if (t === 'ka') return send(ws, { t: 'ka' });
  if (t === 'host') {
    if (ws.ctx) return;
    const code = newCode();
    const room = { code, host: 0, nextId: 0, started: false, members: new Map() };
    rooms.set(code, room);
    const mem = addMember(room, ws);
    return send(ws, { t: 'room', code, token: mem.token });
  }
  if (t === 'join') {
    if (ws.ctx) return;
    const room = rooms.get(String(m.code || '').toUpperCase());
    if (!room) return send(ws, { t: 'err', msg: 'Room not found' });
    if (room.members.size >= MAX_PLAYERS) return send(ws, { t: 'err', msg: 'Room is full' });
    const mem = addMember(room, ws);
    send(ws, { t: 'joined', id: mem.id, host: room.host, started: room.started, code: room.code, token: mem.token });
    const h = room.members.get(room.host);
    return h && send(h.ws, { t: 'peer', id: mem.id, join: true });
  }
  if (t === 'resume') {
    if (ws.ctx) return;
    const room = rooms.get(String(m.code || '').toUpperCase());
    const mem = room && room.members.get(m.id | 0);
    if (!mem || mem.token !== m.token) return send(ws, { t: 'err', msg: 'Session expired', fatal: true });
    clearTimeout(mem.timer); mem.timer = null;
    if (mem.ws && mem.ws !== ws) { const old = mem.ws; old.ctx = null; try { old.close(); } catch (_) {} }
    mem.ws = ws; ws.ctx = { room, id: mem.id };
    return send(ws, { t: 'resumed', host: room.host });
  }
  const c = ws.ctx; if (!c) return;
  const room = c.room, me = c.id;
  if (t === 'leave') { ws.ctx = null; return removeMember(room, me, true); }
  if (t === 'lock') { if (me === room.host) room.started = !!m.on; return; }
  if (t === 'all') { if (me !== room.host) return; return broadcast(room, { t: 'msg', d: m.d }, me); }
  if (t === 'to') {
    if (me !== room.host) return;
    const target = room.members.get(m.id | 0); return target && send(target.ws, { t: 'msg', d: m.d });
  }
  if (t === 'in') {
    const h = room.members.get(room.host); if (!h || me === room.host) return;
    return send(h.ws, { t: 'from', id: me, d: m.d });
  }
}

// ---------------------------------------------------------------- websocket plumbing
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024, perMessageDeflate: false });
const perIp = new Map();
wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const n = (perIp.get(ip) || 0) + 1; perIp.set(ip, n);
  if (n > MAX_CONN_PER_IP) { ws.close(1013, 'too many connections'); }
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  let budget = 400, last = Date.now();   // ~simple flood guard: tokens refill 400/s
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const now = Date.now(); budget = Math.min(400, budget + (now - last) * 0.4); last = now;
    if (--budget < 0) return;
    let m; try { m = JSON.parse(data); } catch (_) { return; }
    if (m && typeof m.t === 'string') { try { handle(ws, m); } catch (e) { console.error('handler error', e); } }
  });
  ws.on('close', () => { const k = (perIp.get(ip) || 1) - 1; k ? perIp.set(ip, k) : perIp.delete(ip); onDisconnect(ws); });
  ws.on('error', () => {});
});
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (_) {} }
}, 20000);

server.listen(PORT, () => console.log('ZOMBIES server listening on :' + PORT));
module.exports = { server, rooms };
