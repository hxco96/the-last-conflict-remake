// Online co-op transport. Star topology: the host is authoritative and every client talks only
// to the host, which relays what other players need.
// * WebRTC data channels via PeerJS (free public matchmaker + TURN, no account). Room codes are
//   5 letters; the host's peer id is `tlcr-<code>`.
// * `?net=local` swaps in a BroadcastChannel transport so several tabs of the same browser can
//   play together (used for testing, works offline).
import { BROKER, ICE_SERVERS } from './config.js';

const PEERJS_URL = 'js/vendor/peerjs.min.js'; // PeerJS 1.5.4 (MIT), vendored so it works without a CDN
const PREFIX = 'tlcr-remake-';
export const MAX_PLAYERS = 4;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O: easy to read out loud

// PeerJS error types -> something a player can act on
const friendly = (e) => {
  const t = e && e.type;
  if (t === 'peer-unavailable') return new Error('no game with that code');
  if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed' || /lost connection|websocket/i.test(e && e.message))
    return new Error("couldn't reach the matchmaking server — check your internet connection");
  if (t === 'browser-incompatible' || t === 'webrtc') return new Error('this browser does not support online play (WebRTC)');
  return e instanceof Error ? e : new Error(String((e && e.message) || e));
};
const randomCode = () => Array.from({ length: 5 }, () => ALPHABET[(Math.random() * ALPHABET.length) | 0]).join('');
// Matchmaking servers to try in order: ?broker=host[:port] (testing) or config.js BROKER (your own server, see
// server/), then the free public PeerJS cloud (null). A room lives on whichever server the host reached.
function brokers() {
  const list = [];
  const q = new URLSearchParams(location.search).get('broker');
  if (q) { const [host, port] = q.split(':'); const p = +port || 443; list.push({ host, port: p, path: '/', secure: p === 443 }); }
  else if (BROKER) list.push(BROKER);
  list.push(null);
  return list;
}
const localMode = () => /[?&]net=local\b/.test(location.search);
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))]);

let peerjsLoading = null;
function loadPeerJS() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (!peerjsLoading) {
    peerjsLoading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = PEERJS_URL;
      s.onload = () => (window.Peer ? res(window.Peer) : rej(new Error('PeerJS failed to load')));
      s.onerror = () => { peerjsLoading = null; rej(new Error('could not load the multiplayer library (offline?)')); };
      document.head.append(s);
    });
  }
  return peerjsLoading;
}

// ---------- BroadcastChannel transport (same browser, test / LAN-less play) ----------
class LocalPeer {
  constructor(id) {
    this.id = id || 'p' + Math.random().toString(36).slice(2, 9);
    this.handlers = {};
    this.conns = new Map();
    this.bc = new BroadcastChannel('tlcr-net');
    this.bc.onmessage = (e) => this.route(e.data);
    setTimeout(() => this.emit('open', this.id), 0);
  }
  on(ev, f) { this.handlers[ev] = f; }
  emit(ev, ...a) { if (this.handlers[ev]) this.handlers[ev](...a); }
  route(m) {
    if (m.to !== this.id) return;
    if (m.kind === 'connect') {
      const c = new LocalConn(this, m.from);
      this.conns.set(m.from, c);
      this.emit('connection', c);
      this.bc.postMessage({ kind: 'accept', from: this.id, to: m.from });
      setTimeout(() => c.emit('open'), 0);
    } else if (m.kind === 'accept') { const c = this.conns.get(m.from); if (c) c.emit('open'); }
    else if (m.kind === 'data') { const c = this.conns.get(m.from); if (c) c.emit('data', m.data); }
    else if (m.kind === 'close') { const c = this.conns.get(m.from); if (c) { this.conns.delete(m.from); c.emit('close'); } }
  }
  connect(id) {
    const c = new LocalConn(this, id);
    this.conns.set(id, c);
    this.bc.postMessage({ kind: 'connect', from: this.id, to: id });
    return c;
  }
  destroy() { for (const c of this.conns.values()) c.close(); this.bc.close(); }
}
class LocalConn {
  constructor(peer, remote) { this.peer = peer; this.peer_ = remote; this.handlers = {}; this.open = true; }
  get peerId() { return this.peer_; }
  on(ev, f) { this.handlers[ev] = f; }
  emit(ev, ...a) { if (this.handlers[ev]) this.handlers[ev](...a); }
  send(data) { this.peer.bc.postMessage({ kind: 'data', from: this.peer.id, to: this.peer_, data }); }
  close() { if (!this.open) return; this.open = false; this.peer.bc.postMessage({ kind: 'close', from: this.peer.id, to: this.peer_ }); }
}

// ---------- Net: one per online session ----------
export class Net {
  constructor() {
    this.role = null;          // 'host' | 'client'
    this.code = '';
    this.id = '';              // my player id ('H' for the host, 'c1', 'c2'… for clients)
    this.conns = new Map();    // host: player id -> conn ; client: 'H' -> conn
    this.handlers = new Map();
    this.onPeerLeave = () => {};
    this.onPeerJoin = () => {};
    this.onLost = () => {};
    this.nextId = 1;
    this.closed = false;
  }

  on(type, f) { this.handlers.set(type, f); }
  dispatch(from, msg) {
    if (from === 'H') this.heardAt = performance.now(); // client: last time the host said anything
    const f = this.handlers.get(msg.t);
    if (f) { try { f(msg, from); } catch (e) { console.error('net handler', msg.t, e); } }
  }

  async makePeer(id, broker = null) {
    if (localMode()) return new LocalPeer(id);
    const Peer = await loadPeerJS();
    // extra STUN/TURN on top of PeerJS's defaults so phones on mobile data can still connect
    return new Peer(id, { debug: 0, ...(broker || {}), config: { iceServers: ICE_SERVERS, sdpSemantics: 'unified-plan' } });
  }

  async host() {
    this.role = 'host';
    this.id = 'H';
    let lastErr = null;
    for (const broker of brokers()) {
      for (let attempt = 0; attempt < 4 && !this.peer; attempt++) {
        this.code = randomCode();
        try {
          const peer = await this.makePeer(PREFIX + this.code, broker);
          await withTimeout(new Promise((res, rej) => { peer.on('open', res); peer.on('error', rej); }), broker ? 9000 : 12000, 'connecting to the matchmaker');
          this.peer = peer;
          this.broker = broker;
        } catch (e) {
          lastErr = e;
          if (!/unavailable|taken/i.test(String(e && (e.type || e.message)))) break; // this server is unreachable: try the next one
        }
      }
      if (this.peer) break;
    }
    if (!this.peer) throw lastErr ? friendly(lastErr) : new Error('could not reserve a room code');
    this.peer.on('error', (e) => console.warn('peer error', e && e.type));
    // keep the room code reachable if the matchmaker connection drops (open games keep playing)
    this.peer.on('disconnected', () => { if (!this.closed) setTimeout(() => { try { if (!this.closed && this.peer.disconnected) this.peer.reconnect(); } catch { /* gone */ } }, 2000); });
    this.peer.on('connection', (conn) => {
      conn.on('open', () => {
        if (this.conns.size >= MAX_PLAYERS - 1) { conn.send({ t: 'full' }); setTimeout(() => conn.close(), 300); return; }
        const pid = 'c' + this.nextId++;
        conn.pid = pid;
        this.conns.set(pid, conn);
        conn.on('data', (m) => this.dispatch(pid, m));
        conn.on('close', () => { if (this.conns.get(pid) === conn) { this.conns.delete(pid); this.onPeerLeave(pid); } });
        conn.send({ t: 'welcome', id: pid });
        this.onPeerJoin(pid);
      });
    });
    return this.code;
  }

  async join(code) {
    this.role = 'client';
    this.code = code.trim().toUpperCase();
    let conn = null, welcome = null, lastErr = null;
    for (const broker of brokers()) {
      let peer = null;
      try {
        peer = await this.makePeer(undefined, broker);
        await withTimeout(new Promise((res, rej) => { peer.on('open', res); peer.on('error', (e) => rej(friendly(e))); }), broker ? 9000 : 12000, 'connecting to the matchmaker');
        const c = peer.connect(PREFIX + this.code, { reliable: true });
        welcome = await withTimeout(new Promise((res, rej) => {
          peer.on('error', (e) => rej(friendly(e)));
          c.on('data', (m) => {
            if (m.t === 'welcome') res(m);
            else if (m.t === 'full') rej(new Error('that game is full (4 players)'));
            else this.dispatch('H', m);
          });
        }), broker ? 9000 : 15000, 'joining the game');
        this.peer = peer; this.broker = broker; conn = c;
        break;
      } catch (e) {
        lastErr = e;
        try { peer && peer.destroy(); } catch { /* gone */ }
        if (/full/.test(String(e && e.message))) throw e; // a real answer, not a routing miss
      }
    }
    if (!conn) throw lastErr || new Error('no game with that code');
    this.id = welcome.id;
    this.conns.set('H', conn);
    conn.on('close', () => { if (!this.closed) this.onLost(); });
    return this.id;
  }

  // host: to one client, or everyone (optionally except one); client: to the host
  send(to, msg) { const c = this.conns.get(to); if (c && c.open !== false) { try { c.send(msg); } catch { /* closed */ } } }
  broadcast(msg, except = null) { for (const [id, c] of this.conns) if (id !== except && c.open !== false) { try { c.send(msg); } catch { /* closed */ } } }
  toHost(msg) { this.send('H', msg); }
  get count() { return this.role === 'host' ? this.conns.size + 1 : 0; }

  close() {
    this.closed = true;
    for (const c of this.conns.values()) { try { c.close(); } catch { /* already closed */ } }
    this.conns.clear();
    try { this.peer && this.peer.destroy(); } catch { /* ignore */ }
  }
}
