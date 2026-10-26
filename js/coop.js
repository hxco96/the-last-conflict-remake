// Online co-op glue between Net (transport), Session (round cycle) and Game (simulation).
// * The host simulates everything that is shared: zeds, spawns, NPCs, objectives, the round timer.
// * Each player simulates their own survivor (movement, shooting, inventory, loot) so controls feel
//   instant; hits on zeds are sent to the host, which applies them and reports kills back.
// * Loot is per player: whoever lands the kill rolls the drop on their own map.
// * Zeds hurt remote players through 'hurt' messages; acid/web spit is copied to clients, who test
//   it against their own survivor.
// * Going to 0 HP with a teammate still standing puts you DOWN instead of dead: crawl, bleed out in
//   25 s (faster while zeds keep chewing), or get revived by a teammate holding USE next to you.
import { Player, Mob, LOOKS } from './actors.js';
import { play } from './sfx.js';

const DIRS = ['n', 'e', 's', 'w'];
const STATES = ['walk', 'attack', 'rush'];
export const DOWN_TIME = 25;
const REVIVE_TIME = 2.5;
const SEND_HZ = 15;

class RemotePlayer extends Player {
  get jumpH() { return this.jh || 0; }
  get airborne() { return (this.jh || 0) > 0.5; }
}

export class Coop {
  constructor(net, me) {
    this.net = net;
    this.role = net.role;
    this.me = me;              // { name, look, cls }
    this.players = new Map();  // other players' latest state, by id
    this.session = null;
    this.sendT = 0;
    this.infoWanted = new Set();
    this.npcInfoWanted = new Set();
    this.mobInfo = new Map();  // client cache: nid -> info
    this.left = new Set();
    this.bind();
  }

  get host() { return this.role === 'host'; }
  get client() { return this.role === 'client'; }
  get id() { return this.net.id; }
  get code() { return this.net.code; }
  get count() { return 1 + [...this.players.values()].filter((p) => !this.left.has(p.id)).length; }

  // ---------- message wiring ----------
  bind() {
    const N = this.net;
    N.on('st', (m, from) => { if (this.host) { m.id = from; this.players.set(from, m); } });
    N.on('w', (m) => this.onWorld(m));
    N.on('hello', (m, from) => {
      if (!this.host) return;
      this.players.set(from, { id: from, n: m.n, l: m.l, c: m.c, v: 'lobby', x: -9999, y: -9999 });
      this.left.delete(from);
      this.toast(`${m.n} joined (${this.count}/4)`);
      const S = this.session;
      if (S) { S.broadcastState(); if (S.state === 'running' && S.match) N.send(from, { t: 'start', round: S.round, next: S.match.netNext, spawn: S.match.teamSpawn }); }
    });
    N.onPeerLeave = (pid) => {
      const p = this.players.get(pid);
      this.players.delete(pid);
      if (this.session) { this.session.votes.delete(pid); this.session.joinedPeers.delete(pid); }
      for (const g of this.games()) if (g.avatars) g.avatars.delete(pid);
      this.toast(`${p ? p.n : 'A player'} left`);
    };
    N.on('hit', (m, from) => {
      const g = this.matchGame(); if (!g || !this.host) return;
      const mob = g.mobs.find((x) => x.nid === m.nid);
      if (mob && mob.alive) g.applyDamage(mob, m.d, { ang: m.a, melee: !!m.ml, by: from }, !!m.st);
    });
    N.on('kill', (m) => this.onKill(m));
    N.on('mi', (m, from) => {
      // client asks for zed looks it hasn't seen yet
      const g = this.matchGame(); if (!g || !this.host) return;
      const out = [];
      for (const nid of m.ids) { const x = g.mobs.find((o) => o.nid === nid); if (x) out.push({ nid, id: x.id, l: x.layers, mh: x.maxHp, e: x.elite || null }); }
      N.send(from, { t: 'mI', list: out });
    });
    N.on('mI', (m) => { for (const i of m.list) { this.mobInfo.set(i.nid, i); this.infoWanted.delete(i.nid); } });
    N.on('ni', (m, from) => {
      const g = this.matchGame(); if (!g || !this.host) return;
      const out = [];
      for (const nid of m.ids) { const n = g.npcs.find((o) => o.nid === nid); if (n) out.push({ nid, layers: n.look.layers, name: n.name, kind: n.kind, w: n.weapon ? n.weapon.name : null }); }
      N.send(from, { t: 'nI', list: out });
    });
    N.on('nI', (m) => { const g = this.matchGame(); if (!g) return; g.npcInfo = g.npcInfo || new Map(); for (const i of m.list) { g.npcInfo.set(i.nid, i); this.npcInfoWanted.delete(i.nid); } });
    N.on('hurt', (m) => {
      const g = this.matchGame();
      if (!g || g.ghost || this.session.view !== 'match') return;
      g.hurtPlayer(m.d, m.k);
    });
    N.on('proj', (m) => {
      const g = this.matchGame(); if (!g || g.z !== m.z) return;
      const p = m.p;
      if (p.grab != null) p.grab = g.mobs.find((x) => x.nid === p.grab) || null;
      g.projectiles.list.push({ kind: 'bullet', hostile: true, traveled: 0, hit: new Set(), ...p });
    });
    N.on('sh', (m, from) => {
      if (this.host) this.net.broadcast(m, from);
      if (m.id === this.id) return;
      const g = this.gameFor(m.v); if (!g || (m.v === 'match' && g.z !== m.z)) return;
      const it = g.data.item(m.w);
      if (it) play.shot(it, m.x, m.y);
      const av = g.avatars && g.avatars.get(m.id);
      if (av) { av.flashT = 0.06; av.recoilT = 0.08; }
    });
    N.on('bm', (m, from) => {
      if (this.host) this.net.broadcast(m, from);
      if (m.id === this.id) return;
      const g = this.matchGame(); if (!g || g.z !== m.z) return;
      g.explosion(m.x, m.y, m.r, 0, m.e, true);
    });
    N.on('rv', (m, from) => {
      // revive: host relays to the target, the target revives itself
      if (this.host && m.to !== 'H') { this.net.send(m.to, { ...m, by: m.by || from }); return; }
      const g = this.matchGame();
      if (g && g.player.down) g.revive(m.byName || 'A teammate');
    });
    N.on('stairs', (m) => {
      const g = this.matchGame(); if (!g || !this.host) return;
      const st = [...g.map.stairs.values()].find((s) => s.cx === m.cx && s.cy === m.cy);
      if (st) g.changeFloor(st, true);
    });
    N.on('floor', (m) => {
      const g = this.matchGame(); if (!g || this.host) return;
      g.teamFloor(m);
    });
    N.on('dir', (m) => { const g = this.matchGame(); if (g && g.dir && m.r === this.session.round) g.dir.applyNet(m); });
    N.on('win', (m) => { const g = this.matchGame(); if (g && this.host && g.ext) g.ext.win(m.text); });
    N.on('ss', (m) => { if (this.client && this.session) this.session.applyState(m); });
    N.on('vote', (m, from) => { if (this.host && this.session) this.session.remoteVote(from, m.cat, m.value); });
    N.on('join', (m, from) => { if (this.host && this.session) this.session.remoteJoin(from, m.on); });
    N.on('soon', () => { if (this.host && this.session) this.session.startSoon(); });
    N.on('start', (m) => { if (this.client && this.session) this.session.startMatch(m); });
    N.on('end', (m) => { if (this.client && this.session) this.session.hostEnded(m); });
    N.on('chat', (m, from) => { if (this.host) this.net.broadcast(m, from); const g = this.session && this.session.active; if (g) g.msg(`${m.n}: ${m.text}`, '#9cd4ff'); });
  }

  toast(text) { const g = this.session && this.session.active; if (g) g.msg(text, '#9cd4ff'); }
  games() { const S = this.session; return S ? [S.lobby, S.match].filter(Boolean) : []; }
  matchGame() { return this.session && this.session.match; }
  gameFor(v) { return v === 'match' ? this.matchGame() : this.session && this.session.lobby; }

  hello() { this.net.toHost({ t: 'hello', n: this.me.name, l: this.me.look, c: this.me.cls }); }

  // ---------- my state ----------
  myState() {
    const S = this.session;
    const inMatch = S.view === 'match' && S.match && !S.match.ghost;
    const g = inMatch ? S.match : S.lobby;
    const pl = g.player, s = g.slots[g.cur];
    return {
      t: 'st', id: this.id, n: this.me.name, l: this.me.look, c: this.me.cls,
      v: inMatch ? 'match' : S.view === 'spectate' ? 'spec' : 'lobby', r: S.round, z: g.z,
      x: Math.round(pl.x), y: Math.round(pl.y), d: pl.dir, a: Math.round(pl.aim * 100) / 100,
      mv: pl.moving ? 1 : 0, rn: pl.running ? 1 : 0, al: pl.alive ? 1 : 0, dn: pl.down ? 1 : 0, dt: pl.down ? Math.ceil(pl.downT) : 0,
      hp: Math.max(0, Math.round(pl.hp)), mh: pl.maxHp, w: s && !s.isThrowable ? s.item.name : null, j: Math.round(pl.jumpH),
      k: inMatch ? g.kills : 0, cb: S.profile ? S.profile.coins : 0, // bank balance shown to teammates
    };
  }

  // Called once per frame by the Session.
  update(dt) {
    const S = this.session;
    if (!S || !S.lobby) return;
    this.sendT -= dt;
    if (this.sendT <= 0) {
      this.sendT = 1 / SEND_HZ;
      const st = this.myState();
      if (this.client) this.net.toHost(st);
      else this.net.broadcast(this.worldSnapshot(st));
      if (this.client && this.infoWanted.size) this.net.toHost({ t: 'mi', ids: [...this.infoWanted].slice(0, 40) });
      if (this.client && this.npcInfoWanted.size) this.net.toHost({ t: 'ni', ids: [...this.npcInfoWanted] });
    }
    for (const g of this.games()) this.updateAvatars(g, dt);
    if (S.match && this.client) this.updateMirror(S.match, dt);
  }

  // ---------- host: world snapshot ----------
  worldSnapshot(myState) {
    const S = this.session, g = S.match;
    const msg = { t: 'w', p: [myState, ...this.players.values()], r: S.round };
    if (g && S.state === 'running') {
      msg.z = g.z;
      msg.m = g.mobs.map((m) => [m.nid, Math.round(m.x), Math.round(m.y), DIRS.indexOf(m.dir), Math.max(0, STATES.indexOf(m.state)), Math.max(0, Math.round(m.hp)), m.alive ? 1 : 0]);
      msg.n = g.npcs.filter((n) => !n.dead).map((n) => { if (!n.nid) n.nid = ++g.nidSeq; return [n.nid, Math.round(n.x), Math.round(n.y), DIRS.indexOf(n.dir), n.alive ? 1 : 0, n.moving ? 1 : 0, Math.round(n.aim * 100) / 100, n.flashT > 0 ? 1 : 0]; });
    }
    return msg;
  }

  // ---------- client: apply snapshot ----------
  onWorld(m) {
    if (!this.client) return;
    for (const p of m.p) if (p.id !== this.id) this.players.set(p.id, p);
    const known = new Set(m.p.map((p) => p.id));
    for (const id of [...this.players.keys()]) if (!known.has(id)) { this.players.delete(id); for (const g of this.games()) if (g.avatars) g.avatars.delete(id); }
    const g = this.matchGame();
    if (!g || !m.m || m.r !== this.session.round || g.z !== m.z) return;
    g.mirror = g.mirror || new Map();
    const now = g.time;
    for (const e of m.m) {
      const [nid, x, y, d, s, hp, alive] = e;
      let mob = g.mirror.get(nid);
      if (!mob) {
        const info = this.mobInfo.get(nid);
        if (!info) { if (alive) this.infoWanted.add(nid); continue; }
        const def = g.data.mobs.get(info.id);
        if (!def) continue;
        mob = new Mob(def, x, y, g.mobAtlas(def), g.data.outfits);
        mob.layers = info.l.length ? info.l : mob.layers;
        mob.maxHp = info.mh;
        mob.nid = nid;
        if (info.e) g.dir.makeElite(mob, info.e);
        if (!alive) { mob.alive = false; mob.deadT = 2; }
        g.mirror.set(nid, mob);
        g.mobs.push(mob);
      }
      mob.tx = x; mob.ty = y; mob.dir = DIRS[d] || 's'; mob.state = STATES[s] || 'walk';
      if (mob.alive && !mob.localHitT) mob.hp = hp;
      mob.seenAt = now;
      if (!alive && mob.alive) g.killFx(mob);
    }
    g.npcMirror = (m.n || []).map(([nid, x, y, d, alive, moving, aim, flash]) => {
      const info = g.npcInfo && g.npcInfo.get(nid);
      if (!info) { this.npcInfoWanted.add(nid); return null; }
      let a = g.npcAvatars && g.npcAvatars.get(nid);
      if (!a) {
        g.npcAvatars = g.npcAvatars || new Map();
        a = new RemotePlayer(x, y, { name: info.name, layers: info.layers }, info.kind);
        a.name = info.name; a.kind = info.kind; a.weapon = info.w ? g.data.item(info.w) : null;
        g.npcAvatars.set(nid, a);
      }
      a.tx = x; a.ty = y; a.dir = DIRS[d] || 's'; a.alive = !!alive; a.moving = !!moving; a.aim = aim; a.flashT = flash ? 0.05 : a.flashT;
      return a;
    }).filter(Boolean);
  }

  updateMirror(g, dt) {
    const k = Math.min(1, dt * 12);
    for (const m of g.mobs) {
      m.flash -= dt;
      if (m.localHitT) m.localHitT -= dt;
      if (!m.alive) { m.deadT += dt; continue; }
      m.animT += dt * 1000;
      if (m.tx != null) {
        if (Math.hypot(m.tx - m.x, m.ty - m.y) > 64) { m.x = m.tx; m.y = m.ty; }
        else { m.x += (m.tx - m.x) * k; m.y += (m.ty - m.y) * k; }
      }
      if (g.time - (m.seenAt || 0) > 1.5) { m.alive = false; m.deadT = 2; } // gone from the host's view
    }
    g.mobs = g.mobs.filter((m) => m.alive || m.deadT < 2);
    for (const nid of [...g.mirror?.keys() || []]) { const m = g.mirror.get(nid); if (!m.alive && m.deadT >= 2) g.mirror.delete(nid); }
    for (const a of g.npcMirror || []) {
      a.animT += dt * 1000; a.flashT = (a.flashT || 0) - dt;
      a.x += (a.tx - a.x) * k; a.y += (a.ty - a.y) * k;
    }
  }

  // ---------- kills ----------
  // host: a zed died (killed by `by`)
  hostKill(g, m, by) { this.net.broadcast({ t: 'kill', nid: m.nid, by, r: this.session.round }); }

  onKill(m) {
    const g = this.matchGame();
    if (!g || m.r !== this.session.round) return;
    g.teamKills = (g.teamKills || 0) + 1;
    const mob = g.mirror && g.mirror.get(m.nid);
    if (mob && mob.alive) g.killFx(mob);
    if (m.by === this.id && mob && !g.ghost) g.killReward(mob);
  }

  // ---------- host: targets for zeds ----------
  // Remote survivors standing in the match on the host's floor.
  targets(g) {
    if (!g.avatars) return [];
    const out = [];
    for (const [id, av] of g.avatars) if (av.alive && av.visible) { av.remote = id; out.push(av); }
    return out;
  }

  hurtRemote(av, dmg, kind) { this.net.send(av.remote, { t: 'hurt', d: dmg, k: kind }); }

  sendHit(m, d, src, stunned) {
    if (m.nid == null) return;
    this.net.toHost({ t: 'hit', nid: m.nid, d: Math.round(d * 10) / 10, a: Math.round((src.ang ?? Math.atan2(src.vy || 0, src.vx || 0)) * 100) / 100, ml: src.melee ? 1 : 0, st: stunned ? 1 : 0 });
  }

  sendProj(g, p) {
    const q = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, range: p.range, dmg: p.dmg, webbed: p.webbed, sprite: p.sprite, grab: p.grab ? p.grab.nid : null };
    this.net.broadcast({ t: 'proj', z: g.z, p: q });
  }

  shot(g, item) {
    const pl = g.player;
    const msg = { t: 'sh', id: this.id, v: g.opts.lobby ? 'lobby' : 'match', z: g.z, w: item.name, x: Math.round(pl.x), y: Math.round(pl.y - 11) };
    if (this.host) this.net.broadcast(msg); else this.net.toHost(msg);
  }

  boom(g, x, y, r, e) {
    const msg = { t: 'bm', id: this.id, z: g.z, x: Math.round(x), y: Math.round(y), r, e };
    if (this.host) this.net.broadcast(msg); else this.net.toHost(msg);
  }

  // Are any teammates still standing in this round (used to go DOWN instead of dying)?
  teammatesUp() {
    for (const p of this.players.values()) if (p.v === 'match' && p.al && !p.dn && p.r === this.session.round) return true;
    return false;
  }
  anyRemoteInMatch() {
    for (const p of this.players.values()) if (p.v === 'match' && p.al && p.r === this.session.round) return true;
    return false;
  }

  // ---------- avatars of other players ----------
  updateAvatars(g, dt) {
    g.avatars = g.avatars || new Map();
    const ctx = g.opts.lobby ? 'lobby' : 'match';
    const k = Math.min(1, dt * 14);
    for (const p of this.players.values()) {
      if (p.id === this.id || p.x == null) continue;
      let av = g.avatars.get(p.id);
      const visible = ctx === 'lobby' ? p.v === 'lobby' : p.v === 'match' && p.z === g.z && p.r === this.session.round;
      if (!av) {
        av = new RemotePlayer(p.x, p.y, LOOKS[p.l] || LOOKS[0], p.c);
        av.tx = p.x; av.ty = p.y;
        g.avatars.set(p.id, av);
      }
      if (!av.visible && visible) { av.x = p.x; av.y = p.y; }
      av.visible = visible;
      av.name = p.n; av.tx = p.x; av.ty = p.y; av.dir = p.d || 's'; av.aim = p.a || 0;
      av.moving = !!p.mv; av.running = !!p.rn; av.alive = !!p.al; av.down = !!p.dn; av.downT = p.dt || 0;
      av.hp = p.hp; av.maxHp = p.mh || 100; av.jh = p.j || 0;
      av.weapon = p.w ? g.data.item(p.w) : null;
      if (Math.hypot(av.tx - av.x, av.ty - av.y) > 96) { av.x = av.tx; av.y = av.ty; }
      else { av.x += (av.tx - av.x) * k; av.y += (av.ty - av.y) * k; }
      av.animT += dt * 1000;
      av.flashT = (av.flashT || 0) - dt; av.recoilT = (av.recoilT || 0) - dt;
    }
    for (const id of [...g.avatars.keys()]) if (!this.players.has(id)) g.avatars.delete(id);
  }

  // Hold USE next to a downed teammate to revive them.
  updateRevive(g, dt) {
    const pl = g.player, inp = g.input;
    let target = null;
    if (pl.alive && !pl.down && g.avatars) {
      for (const [id, av] of g.avatars) if (av.visible && av.down && av.alive && Math.hypot(av.x - pl.x, av.y - pl.y) < 30) { target = [id, av]; break; }
    }
    if (!target || !inp || !(inp.isDown('interact') || inp.isDown('context'))) { g.reviving = target ? { id: target[0], t: 0, av: target[1] } : null; return; }
    if (!g.reviving || g.reviving.id !== target[0]) g.reviving = { id: target[0], t: 0, av: target[1] };
    g.reviving.t += dt;
    if (g.reviving.t >= REVIVE_TIME) {
      const msg = { t: 'rv', to: target[0], by: this.id, byName: this.me.name };
      if (this.host) this.net.send(target[0], msg); else this.net.toHost(msg);
      g.msg(`You revived ${target[1].name}!`, '#7dff8a');
      g.reviveBonus = (g.reviveBonus || 0) + 15;
      g.reviving = null;
      target[1].down = false;
    }
  }

  drawAvatars(g, list, ctx, inView) {
    if (!g.avatars) return;
    for (const av of g.avatars.values()) {
      if (!av.visible || !inView(av.x, av.y)) continue;
      list.push([av.y, () => {
        if (av.down) { ctx.save(); ctx.globalAlpha = 0.8; }
        av.draw(ctx, g.atlas.core, av.weapon && !av.down ? () => g.drawWeapon(ctx, av, av.weapon, av.recoilT > 0, av.flashT > 0) : null);
        if (av.down) ctx.restore();
      }]);
    }
    for (const a of g.npcMirror || []) {
      if (!inView(a.x, a.y)) continue;
      list.push([a.alive ? a.y : a.y - 30, () => a.draw(ctx, g.atlas.core, a.weapon && a.alive ? () => g.drawWeapon(ctx, a, a.weapon, false, a.flashT > 0) : null)]);
    }
  }

  drawOverheads(g, ctx) {
    if (!g.avatars) return;
    ctx.textAlign = 'center';
    for (const av of g.avatars.values()) {
      if (!av.visible) continue;
      ctx.font = '7px Bebas, sans-serif';
      ctx.fillStyle = !av.alive ? '#888' : av.down ? '#ff6b6b' : '#7dd3ff';
      ctx.fillText(av.down ? `${av.name} — DOWN ${av.downT}s` : av.name, av.x, av.y - 36);
      if (av.alive && !av.down) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(av.x - 9, av.y - 34, 18, 2.5);
        ctx.fillStyle = av.hp / av.maxHp > 0.35 ? '#5fd35f' : '#ff5a3a'; ctx.fillRect(av.x - 9, av.y - 34, 18 * Math.max(0, av.hp / av.maxHp), 2.5);
      }
      if (av.down && av.alive && Math.hypot(av.x - g.player.x, av.y - g.player.y) < 30 && !g.player.down) {
        const r = g.reviving && g.reviving.av === av ? g.reviving.t / REVIVE_TIME : 0;
        ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(av.x - 24, av.y + 4, 48, 10);
        ctx.fillStyle = '#7dff8a'; ctx.fillRect(av.x - 24, av.y + 12, 48 * r, 2);
        ctx.fillText('HOLD [E] REVIVE', av.x, av.y + 11);
      }
    }
    for (const a of g.npcMirror || []) {
      ctx.font = '6px Bebas, sans-serif';
      ctx.fillStyle = a.alive ? '#cfe8cf' : '#ff8b6b';
      ctx.fillText(a.name, a.x, a.y - 34);
    }
    ctx.textAlign = 'left';
  }

  drawScreen(g, ctx, W, H) {
    const inp = g.input, touch = !!(inp && inp.touchUI && inp.lastDevice === 'touch');
    const u = touch ? Math.max(0.75, Math.min(W, H) / 430) : Math.max(1, Math.round(H / 400));
    this.drawParty(g, ctx, W, u);
    const pl = g.player;
    if (pl.down && !g.ghost) {
      const k = Math.max(0, Math.min(1, pl.downT / DOWN_TIME));
      const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.7);
      grad.addColorStop(0, 'rgba(120,0,0,0)'); grad.addColorStop(1, `rgba(120,0,0,${0.85 - k * 0.4})`);
      ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.font = `${Math.round(30 * u)}px Bebas, Impact, sans-serif`;
      ctx.fillStyle = '#ff4b4b';
      ctx.fillText(`YOU'RE DOWN — ${Math.ceil(pl.downT)}s`, W / 2, H * 0.38);
      ctx.font = `${Math.round(14 * u)}px Bebas, sans-serif`;
      ctx.fillStyle = '#ffd0d0';
      ctx.fillText(this.teammatesUp() ? 'Crawl toward a teammate — they can hold USE on you to revive' : 'Nobody is left to save you…', W / 2, H * 0.38 + 22 * u);
      ctx.textAlign = 'left';
    }
  }

  // Party list in the top-right of the HUD.
  drawParty(g, ctx, W, u) {
    const rows = [...this.players.values()];
    if (!rows.length && !this.code) return;
    ctx.font = `${Math.round(11 * u)}px Bebas, sans-serif`;
    ctx.textAlign = 'right';
    // under the minimap (see Game.drawMinimap)
    const mb = g.miniBox;
    let y = Math.round(mb && mb.x > W / 2 ? mb.y + mb.h + 16 * u : (g.input && g.input.touchUI && g.input.lastDevice === 'touch' ? 132 : 70) * u);
    ctx.fillStyle = 'rgba(8,10,14,0.6)';
    ctx.fillRect(W - 200 * u, y - 13 * u, 192 * u, (rows.length + 1) * 14 * u + 6 * u);
    ctx.fillStyle = '#ffd36b';
    ctx.fillText(`CO-OP ${this.code} · ${rows.length + 1}/4 · YOU ${this.session.profile.coins}c`, W - 14 * u, y);
    for (const p of rows) {
      y += 14 * u;
      const where = p.v === 'match' ? (p.r === this.session.round ? (p.dn ? `DOWN ${p.dt}s` : p.al ? `${p.hp} HP · ${p.k || 0} kills` : 'dead') : 'match') : p.v === 'spec' ? 'spectating' : 'in base';
      ctx.fillStyle = p.dn ? '#ff6b6b' : p.v === 'match' && p.al ? '#7dff8a' : '#9cd4ff';
      ctx.fillText(`${p.n} · ${p.cb ?? 0}c · ${where}`, W - 14 * u, y);
    }
    ctx.textAlign = 'left';
  }

  close() { this.net.close(); }
}

