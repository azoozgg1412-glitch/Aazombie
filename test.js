// End-to-end protocol test: run `npm test` (starts its own server on a random port).
process.env.PORT = process.env.PORT || '0';
process.env.HOST_GRACE_MS = '400';
process.env.DATA_DIR = require('os').tmpdir() + '/zombies-test-' + process.pid;
const WebSocket = require('ws');
const { server, rooms } = require('./server');
const assert = require('assert');

const wait = ms => new Promise(r => setTimeout(r, ms));
function client(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port); const inbox = [];
  ws.on('message', d => inbox.push(JSON.parse(d)));
  const c = { ws, inbox, send: o => ws.send(JSON.stringify(o)),
    open: () => new Promise(r => ws.on('open', r)),
    next: async (t, ms = 1500) => { const end = Date.now() + ms; for (;;) { const i = inbox.findIndex(m => m.t === t); if (i >= 0) return inbox.splice(i, 1)[0]; if (Date.now() > end) throw new Error('timeout waiting for ' + t + ' got ' + JSON.stringify(inbox)); await wait(10); } } };
  return c;
}

(async () => {
  await wait(100);
  const port = server.address().port;
  // host creates a room
  const H = client(port); await H.open(); H.send({ t: 'host' });
  const room = await H.next('room'); assert.match(room.code, /^[A-Z]{4}$/);
  // two guests join
  const G1 = client(port); await G1.open(); G1.send({ t: 'join', code: room.code });
  const j1 = await G1.next('joined'); assert.equal(j1.id, 1); assert.equal(j1.host, 0); assert.equal(j1.started, false);
  assert.deepEqual(await H.next('peer'), { t: 'peer', id: 1, join: true });
  const G2 = client(port); await G2.open(); G2.send({ t: 'join', code: room.code.toLowerCase() });
  const j2 = await G2.next('joined'); assert.equal(j2.id, 2); await H.next('peer');
  // guest input reaches only the host, tagged with the sender id
  G1.send({ t: 'in', d: { k: 'i', x: 5 } });
  const f = await H.next('from'); assert.equal(f.id, 1); assert.equal(f.d.x, 5);
  // host broadcast reaches every guest but not the host
  H.send({ t: 'all', d: { k: 's', n: 1 } });
  assert.equal((await G1.next('msg')).d.n, 1); assert.equal((await G2.next('msg')).d.n, 1);
  // host direct message
  H.send({ t: 'to', id: 2, d: { k: 'start' } });
  assert.equal((await G2.next('msg')).d.k, 'start');
  await wait(50); assert.equal(G1.inbox.filter(m => m.t === 'msg').length, 0, 'G1 must not receive a "to" for G2');
  assert.equal(H.inbox.filter(m => m.t === 'msg').length, 0, 'host must not echo');
  // guests cannot broadcast
  G1.send({ t: 'all', d: { evil: 1 } }); await wait(50);
  assert.equal(G2.inbox.length, 0);
  // lock + late join + full room
  H.send({ t: 'lock', on: true });
  const G3 = client(port); await G3.open(); G3.send({ t: 'join', code: room.code });
  const j3 = await G3.next('joined'); assert.equal(j3.started, true); await H.next('peer');
  const G4 = client(port); await G4.open(); G4.send({ t: 'join', code: room.code });
  assert.equal((await G4.next('err')).msg, 'Room is full');
  const G5 = client(port); await G5.open(); G5.send({ t: 'join', code: 'ZZZZ' });
  assert.equal((await G5.next('err')).msg, 'Room not found');
  // guest drops and resumes with token
  G1.ws.terminate(); await wait(100);
  const G1b = client(port); await G1b.open(); G1b.send({ t: 'resume', code: room.code, id: 1, token: j1.token });
  assert.equal((await G1b.next('resumed')).host, 0);
  G1b.send({ t: 'in', d: { k: 'i', x: 9 } }); assert.equal((await H.next('from')).d.x, 9);
  // bad token is a fatal error
  const bad = client(port); await bad.open(); bad.send({ t: 'resume', code: room.code, id: 1, token: 'nope' });
  assert.equal((await bad.next('err')).fatal, true);
  // host leaves explicitly -> lowest id guest becomes host immediately
  H.send({ t: 'leave' });
  const nh = await G1b.next('newhost'); assert.equal(nh.id, 1);
  await G2.next('newhost');
  assert.deepEqual(await G1b.next('peer'), { t: 'peer', id: 0, join: false });
  G2.send({ t: 'in', d: { k: 'i', x: 7 } });
  assert.equal((await G1b.next('from')).id, 2);
  // new host keeps broadcasting
  G1b.send({ t: 'all', d: { k: 's', n: 2 } }); assert.equal((await G2.next('msg')).d.n, 2);
  // host crash (no leave): G2 must be promoted after the grace period, and the old host can no longer resume
  G1b.ws.terminate();
  const nh2 = await G2.next('newhost', 3000); assert.equal(nh2.id, 2);
  const old = client(port); await old.open(); old.send({ t: 'resume', code: room.code, id: 1, token: j1.token });
  assert.equal((await old.next('err')).fatal, true);
  // room is deleted once everyone has left
  G2.send({ t: 'leave' }); G3.send({ t: 'leave' }); await wait(150);
  assert.equal(rooms.size, 0);
  // keepalive + http endpoints
  const g = client(port); await g.open(); g.send({ t: 'ka' }); await g.next('ka');
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json(); assert.equal(health.ok, true);
  let r = await fetch(`http://127.0.0.1:${port}/api/daily`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Tester', round: 12, kills: 99 }) });
  assert.equal((await r.json()).top[0].round, 12);
  r = await fetch(`http://127.0.0.1:${port}/api/daily`, { method: 'POST', body: '{"round":0}' }); assert.equal(r.status, 400);
  const idx = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(idx.status, 200); assert.equal(idx.headers.get('content-encoding'), 'gzip');
  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
