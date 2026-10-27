// Free-tier friendly matchmaking server for The Last Conflict co-op:
//  * PeerJS signaling (helps two browsers find each other; gameplay data goes peer to peer)
//  * a tiny public room registry: GET /rooms lists open games, hosts POST /rooms every few seconds to
//    stay listed and DELETE /rooms/:code to leave. Private rooms simply never register.
const express = require('express');
const { ExpressPeerServer } = require('peer');

const port = +process.env.PORT || 9000;
const TTL = 30000;         // a room disappears 30 s after its last heartbeat
const MAX_ROOMS = 300;
const rooms = new Map();   // code -> room

const app = express();
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '2kb' }));

const str = (v, n) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, n);
const sweep = () => { const now = Date.now(); for (const [k, r] of rooms) if (now - r.t > TTL) rooms.delete(k); };

app.get('/rooms', (req, res) => {
  sweep();
  const list = [...rooms.values()].sort((a, b) => b.players - a.players || b.t - a.t).map(({ t, ...r }) => ({ ...r, age: Math.round((Date.now() - t) / 1000) }));
  res.json({ rooms: list });
});

app.post('/rooms', (req, res) => {
  const b = req.body || {};
  const code = str(b.code, 5).toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(code)) return res.status(400).json({ error: 'bad code' });
  sweep();
  if (!rooms.has(code) && rooms.size >= MAX_ROOMS) return res.status(503).json({ error: 'full' });
  rooms.set(code, {
    code, name: str(b.name, 14) || 'Survivor', players: Math.max(1, Math.min(4, +b.players || 1)), max: Math.max(1, Math.min(4, +b.max || 4)),
    mode: str(b.mode, 20), map: str(b.map, 40), state: b.state === 'running' ? 'running' : 'lobby', t: Date.now(),
  });
  res.json({ ok: true });
});

app.delete('/rooms/:code', (req, res) => { rooms.delete(str(req.params.code, 5).toUpperCase()); res.json({ ok: true }); });

const server = app.listen(port, () => console.log(`Matchmaking server listening on :${port}`));
const peerServer = ExpressPeerServer(server, { path: '/', proxied: true, allow_discovery: false, concurrent_limit: 500, alive_timeout: 60000 });
peerServer.on('connection', (c) => console.log('peer connected', c.getId()));
peerServer.on('disconnect', (c) => console.log('peer left', c.getId()));
app.use('/', peerServer);
