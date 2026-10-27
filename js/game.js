import { Atlas } from './assets.js';
import { GameMap, T } from './map.js';
import { FlowField } from './nav.js';
import { Player, Mob, dirOf, cellOf, WALK, RUN, JUMP_TIME } from './actors.js';
import { WeaponSlot, Effects, Projectiles, fireWeapon } from './combat.js';
import { AmmoBag, Throwables, DIFFICULTY, payout } from './profile.js';
import { tierOf, lootCap } from './tiers.js';
import { play, sfx, music, sample } from './sfx.js';
import { norm } from './data.js';
import { Extras, THEMES } from './modes.js';
import { LobbyExt } from './lobby.js';
import { spawnNPC, updateNPC, hurtNPC, reviveNPC, rescueSurvivor } from './npc.js';
import { Director } from './survival.js';
import { ZOMBIE_COUNT } from './profile.js';

// Group unlock delays from spawn_levels_*.rktd are in seconds; scaled so a solo run sees them sooner.
const TIME_SCALE = 1 / 3;
const AMBIENT_DARK = 0.8;

export const CLASSES = {
  Riot: { icon: 'Riot-Specialist_default_x_0', loadout: ['Beretta92'],
    perks: ['Juggernaut', 'HeavyHits', 'BloodLust', 'Agile', 'BluntForce', 'Savagery'] },
  Sniper: { icon: 'crossx_default_x_0', loadout: ['Beretta92'],
    perks: ['Steady', 'Marksman', 'Hypersonic', 'Headshot', 'Dazzle'] },
  Demo: { icon: 'Demolition_default_x_0', loadout: ['Beretta92'],
    perks: ['ShortFuse', 'BombsAway', 'Kamikaze', 'BigBang'] },
  Medic: { icon: 'Medic_default_x_0', loadout: ['Beretta92'],
    perks: ['MutualCare', 'PainTolerance', 'TraumaCare', 'Sanitation', 'HealingPulse', 'VitalSigns'] },
};
// HUD scale: phones size the HUD to the short screen edge; tablets cap it so panels stay
// compact instead of blowing up; desktops use whole steps so pixel fonts stay crisp.
export const hudScale = (W, H, touch) => (touch ? Math.max(0.75, Math.min(1.3, Math.min(W, H) / 430)) : Math.max(1, Math.round((H - 100) / 400)));
const FRENZY_PERKS = new Set(['BluntForce', 'Savagery', 'Headshot', 'Dazzle', 'BigBang', 'HealingPulse', 'VitalSigns']);
const GROUP_NAMES = { 41000: 'Crows', 42000: 'Dogs', 45000: 'Seekers', 46000: 'Reptiles', 44000: 'Venus plants', 49003: 'Roachmen', 47000: 'A boss' };

export class Game {
  constructor(canvas, assets, data, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.assets = assets;
    this.data = data;
    this.opts = opts;
    this.atlas = assets.atlas;
    this.input = opts.input || null;
    this.mouse = { x: 0, y: 0, down: false, clicked: false }; // scripted-trigger fallback + world aim point
    this.messages = [];
    this.paused = false;
    this.over = false;
    this.light = document.createElement('canvas');
    this.onEnd = () => {};
  }

  async start() {
    const json = await this.assets.loadMap(this.opts.map.file);
    this.json = json;
    this.floorCount = GameMap.floorCount(json);
    this.floors = [];
    this.z = -1;
    this.pendingFollow = [];
    this.onStairs = false;
    this.coop = this.opts.coop || null; // online co-op (see coop.js); null = solo
    this.nidSeq = 0;
    this.fx = new Effects(this.atlas.combat);
    this.projectiles = new Projectiles(this);
    this.coinsList = [];
    this.setFloor(this.spawnFloor());
    this.time = 0;
    this.kills = 0;
    this.coins = 0;
    this.frenzy = 0;
    this.frenzyT = 0;
    this.shake = 0;
    this.muzzle = 0;
    this.webbed = 0;
    this.bleed = 0;
    this.flashlight = !this.opts.lobby;
    this.tempLights = [];
    this.barkT = 8;
    this.cls = CLASSES[this.opts.cls];
    this.female = /jill|claire/i.test(this.opts.look.name);
    this.perks = new Set(this.cls.perks);

    const sp = this.pickSpawn();
    this.player = new Player(sp.x, sp.y, this.opts.look, this.opts.cls);
    if (this.hasPerk('Juggernaut')) this.player.maxHp *= 2;
    if (this.hasPerk('MutualCare')) this.player.maxHp = Math.round(this.player.maxHp * 1.25);
    this.player.hp = this.player.maxHp;

    // Inventory: generic weapon slots, typed ammo slots and a separate throwables pouch.
    // Sizes and weapon upgrades come from the persistent profile.
    this.profile = this.opts.profile || null;
    this.diff = DIFFICULTY[this.opts.difficulty] || DIFFICULTY.Normal;
    const PR = this.profile;
    this.slots = new Array(PR ? PR.level('weaponSlots') : 3).fill(null);
    this.cur = 0;
    this.prev = 0;
    this.ammo = new AmmoBag(PR ? PR.level('ammoSlots') : 2, (k) => this.data.ammoCap.get(k) || 100);
    this.throwables = new Throwables(1 + 0.5 * (PR ? PR.inv.throwCap : 0));
    this.items = new Map(); // consumables, materials, boards
    this.reload = null;
    this.applyLoadout(this.opts.loadout || this.classLoadout());

    this.setupSpawner();
    this.floors[this.z].populated = true;
    if (!this.opts.lobby) this.populate();
    if (!this.opts.lobby) this.msg(`${this.opts.mode || 'Survival'} · ${this.opts.theme || 'Zeds'} — ${this.opts.map.name}, ${this.opts.cls} class`, '#ffd36b');
    this.ext = this.opts.lobby ? new LobbyExt(this) : new Extras(this);
    this.dir = new Director(this);
    this.ghost = !!this.opts.spectate;
    this.spec = { x: this.player.x, y: this.player.y };
  }

  // ---------- floors ----------
  // First floor that has PlayerSpawn markers (usually floor_0).
  spawnFloor() {
    for (let z = 0; z < this.floorCount; z++) {
      const g = this.json.layers.find((l) => l.name === 'floor_' + z);
      if (g && (g.layers || []).some((l) => (l.objects || []).some((o) => o.type === 'PlayerSpawn'))) return z;
    }
    return 0;
  }

  floorState(z) {
    if (!this.floors[z]) {
      const map = new GameMap(this.json, this.assets, z, { clean: !!this.opts.lobby });
      this.floors[z] = { map, flow: new FlowField(map), mobs: [], pickups: map.pickups.map((p) => this.makePickup(p.name, p.x, p.y, p.amount, p.tile)), npcs: [], populated: false };
    }
    return this.floors[z];
  }

  // Swap the active floor; other floors keep their mobs and loot frozen until revisited.
  setFloor(z) {
    if (this.z >= 0 && this.floors[this.z]) { const f = this.floors[this.z]; f.mobs = this.mobs; f.pickups = this.pickups; f.npcs = this.npcs; }
    const s = this.floorState(z);
    this.z = z;
    this.map = s.map;
    this.flow = s.flow;
    this.mobs = s.mobs;
    this.pickups = s.pickups;
    this.npcs = s.npcs;
    this.flowT = 0;
    this.flowCell = null;
    if (!s.populated && this.player) { s.populated = true; this.populate(); }
  }

  checkStairs() {
    const pl = this.player;
    if (!pl.alive || pl.airborne || this.floorCount < 2) return;
    // Stair triggers usually sit on the void/obstruction cell at the stairwell edge, so travel
    // happens when the player touches the cell (within a few px), not only when standing on it.
    let st = null;
    for (const s of this.map.stairs.values()) {
      const x0 = s.cx * T - 7, x1 = s.cx * T + T + 7, y0 = s.cy * T - 6, y1 = s.cy * T + T + 8;
      if (pl.x > x0 && pl.x < x1 && pl.y > y0 && pl.y < y1) { st = s; break; }
    }
    if (st && !this.onStairs) {
      if (this.isClient) { this.coop.net.toHost({ t: 'stairs', cx: st.cx, cy: st.cy }); this.onStairs = true; return; }
      this.changeFloor(st); return;
    }
    this.onStairs = !!st;
  }

  changeFloor(st, remote = false) {
    const pl = this.player;
    if (this.isHost) this.coop.net.broadcast({ t: 'floor', to: st.to, x: st.x, y: st.y });
    if (remote && this.ghost) { this.setFloor(st.to); this.spec.x = st.x; this.spec.y = st.y; return; }
    // zeds that are on your heels follow you up/down a moment later
    const followers = this.mobs.filter((m) => m.alive && m.seen && !m.boss && Math.hypot(m.x - pl.x, m.y - pl.y) < 96);
    this.mobs = this.mobs.filter((m) => !followers.includes(m));
    const squad = this.npcs.filter((n) => n.alive && n.mode === 'follow' && Math.hypot(n.x - pl.x, n.y - pl.y) < 260);
    this.npcs = this.npcs.filter((n) => !squad.includes(n));
    this.setFloor(st.to);
    pl.x = st.x; pl.y = st.y;
    if (this.map.boxHits(pl.x, pl.y, pl.hw, pl.hh)) this.unstick(pl);
    this.onStairs = true;
    this.projectiles.list.length = 0;
    this.coinsList.length = 0;
    squad.forEach((n, i) => this.pendingFollow.push({ m: n, npc: true, t: 0.5 + i * 0.35, z: st.to, x: st.x, y: st.y }));
    followers.forEach((m, i) => this.pendingFollow.push({ m, t: 1.2 + i * 0.5, z: st.to, x: st.x, y: st.y }));
    this.msg(`Floor ${st.to + 1} / ${this.floorCount}`, '#9cd4ff');
    play.step(pl.x, pl.y);
  }

  updateFollowers(dt) {
    for (const f of this.pendingFollow) {
      f.t -= dt;
      if (f.t > 0) continue;
      f.m.x = f.x + (Math.random() - 0.5) * 8; f.m.y = f.y;
      if (f.npc) { f.m.homeX = f.x; f.m.homeY = f.y; (f.z === this.z ? this.npcs : this.floorState(f.z).npcs).push(f.m); f.done = true; continue; }
      f.m.state = 'walk';
      (f.z === this.z ? this.mobs : this.floorState(f.z).mobs).push(f.m);
      f.done = true;
    }
    this.pendingFollow = this.pendingFollow.filter((f) => !f.done);
  }

  // ---------- setup ----------
  pickSpawn() {
    const ps = this.map.markers.PlayerSpawn || [];
    for (let i = 0; i < 12 && ps.length; i++) {
      const m = ps[Math.floor(Math.random() * ps.length)];
      const p = this.map.randomWalkable({ x: m.x, y: m.y, w: m.w, h: m.h });
      if (p) return p;
    }
    return this.map.randomWalkable() || { x: this.map.pw / 2, y: this.map.ph / 2 };
  }

  // Infected atlas for most mobs; mechs live in their own robot atlases.
  mobAtlas(def) {
    if (Mob.layersFor(def, this.atlas.infected, this.data.outfits).length) return this.atlas.infected;
    return (this.assets.robots || []).find((a) => Mob.layersFor(def, a, this.data.outfits).length) || this.atlas.infected;
  }

  setupSpawner() {
    const table = this.assets.tables[(THEMES[this.opts.theme] || THEMES.Zeds).table] || this.assets.tables.spawn_levels_zeds;
    this.groups = table.map((g) => {
      let ids = g['mob-ids'];
      if (typeof ids[0] === 'number') ids = [ids];
      ids = ids.filter(([id]) => {
        const def = this.data.mobs.get(id);
        return def && Mob.layersFor(def, this.mobAtlas(def), this.data.outfits).length;
      });
      return { ids, unlock: g.delay * TIME_SCALE, cap: g['max-mobs'], announced: g.delay === 0, firstId: (Array.isArray(g['mob-ids'][0]) ? g['mob-ids'][0][0] : g['mob-ids'][0]) };
    }).filter((g) => g.ids.length);
    this.spawnT = 2;
  }

  populate() {
    const map = this.map;
    // Loot markers often sit on tables/shelves, so any cell in the rect is fine.
    const cellIn = (r) => {
      const cx = Math.floor((r.x + Math.random() * Math.max(1, r.w - 1)) / T);
      const cy = Math.floor((r.y + Math.random() * Math.max(1, r.h - 1)) / T);
      return map.inBounds(cx, cy) && !map.shotBlock[map.idx(cx, cy)] ? { x: cx * T + 16, y: cy * T + 16 } : null;
    };
    for (const r of map.markers.RanAmmo || []) {
      const d = this.data.rollDrop(0);
      const p = cellIn(r);
      if (d && p) this.pickups.push(this.makePickup(d.name, p.x, p.y, null));
    }
    for (const r of map.markers.RanHerb || []) {
      const p = cellIn(r);
      const roll = Math.random();
      if (p) this.pickups.push(this.makePickup(roll < 0.6 ? 'Herb-G' : roll < 0.8 ? 'Herb-R' : 'Herb-B', p.x, p.y, 1));
    }
    for (const r of map.markers.RanMelee || []) {
      const d = this.rollLoot(3);
      const p = cellIn(r);
      if (d && p) this.pickups.push(this.makePickup(d.name, p.x, p.y, null));
    }
    // A few random guns from the gun drop table.
    for (let i = 0; i < 3; i++) {
      const d = this.rollLoot(2);
      const p = map.randomWalkable();
      if (d && p) this.pickups.push(this.makePickup(d.name, p.x, p.y - 8, null));
    }
    if (this.isClient) return; // the host owns NPCs and zeds
    if (this.opts.mode === 'Siege') return; // the siege brings its own survivors (siege.js)
    // Friendly NPCs: "Soilder" markers are soldiers, "Survivor" markers civilians to rescue.
    const placeSome = (list, max, kind) => {
      const pool = [...(list || [])].sort(() => Math.random() - 0.5).slice(0, max);
      for (const s of pool) { const p = map.randomWalkable({ x: s.x, y: s.y, w: s.w, h: s.h }); if (p) spawnNPC(this, kind, p.x, p.y); }
      return pool.length;
    };
    placeSome(map.markers.Soilder, 4, 'soldier');
    if (!placeSome(map.markers.Survivor, 3, 'survivor')) {
      // maps without survivor markers still get a couple of people to find
      for (let i = 0; i < 2; i++) { const p = map.randomWalkable(); if (p && Math.hypot(p.x - this.player.x, p.y - this.player.y) > 250) spawnNPC(this, 'survivor', p.x, p.y); }
    }
    // a few infected already roaming, away from the player
    const zeds = this.groups[0];
    for (let i = 0; i < Math.round(5 * this.density) && zeds && this.opts.mode !== 'Peaceful' && this.opts.mode !== 'Siege'; i++) {
      const p = this.spawnPoint();
      if (p) this.spawnMob(this.pickId(zeds.ids), p.x, p.y);
    }
  }

  // Loot found on maps is limited to low weapon tiers early in a match (see tiers.js lootCap).
  rollLoot(table, boss = false) {
    const cap = lootCap(this.time, boss);
    for (let i = 0; i < 16; i++) {
      const d = this.data.rollDrop(table);
      if (!d) return null;
      const it = this.data.item(d.name);
      if (it && (it.kind === 'gun' || it.kind === 'melee') && tierOf(it) > cap) continue;
      return d;
    }
    return null;
  }

  makePickup(name, x, y, amount, tile = null, force = false) {
    let it = this.data.item(name);
    if (!force && !this.opts.lobby && it && (it.kind === 'gun' || it.kind === 'melee') && tierOf(it) > lootCap(this.time, false)) {
      const d = this.rollLoot(it.kind === 'melee' ? 3 : 2);
      if (d) { name = d.name; tile = null; it = this.data.item(name); }
    }
    let kind = 'misc';
    if (/gunpowder/i.test(name)) kind = 'material';
    else if (/^boards$/i.test(name)) kind = 'board';
    else if (it && it.kind === 'ammo') kind = 'ammo';
    else if (it && it.kind === 'consumable') kind = 'consumable';
    else if (it && (it.kind === 'throwable' || it.kind === 'mine')) kind = 'throwable';
    else if (it && (it.kind === 'gun' || it.kind === 'melee')) kind = 'weapon';
    return { name: it ? it.name : name, item: it, kind, x, y, amount, tile, bob: Math.random() * 6 };
  }

  // ---------- helpers ----------
  // "Zombie count" picked on the mission board (Few … Apocalypse)
  get density() { return (ZOMBIE_COUNT[this.opts.density] || ZOMBIE_COUNT.Normal).mul; }
  get isClient() { return !!(this.coop && this.coop.client && !this.opts.lobby); }
  get isHost() { return !!(this.coop && this.coop.host && !this.opts.lobby); }
  hasPerk(p) { return this.perks.has(p) && (!FRENZY_PERKS.has(p) || this.frenzyT > 0); }
  msg(text, color = '#e8e8e8') { this.messages.push({ text, color, t: 5 }); if (this.messages.length > 6) this.messages.shift(); }
  bark(kind) {
    const list = this.assets.barks[kind];
    if (list && list.length) this.player.bark = { text: list[Math.floor(Math.random() * list.length)], t: 2.5 };
  }
  // Starting kit for the chosen class (weapons, two mags of ammo each, throwables, extras).
  classLoadout() {
    const L = { weapons: [], ammo: [], throwables: [], items: [] };
    const carried = this.profile && this.profile.inventory.length ? this.profile.inventory : ['Beretta92'];
    for (const name of carried) {
      const it = this.data.item(name);
      if (!it || (it.kind !== 'gun' && it.kind !== 'melee')) continue;
      L.weapons.push(it.name);
      if (it.kind === 'gun') L.ammo.push([it['ammo-kind'], it['max-mag'] * (it.class === 'handgun' ? 3 : 2)]);
    }
    if (!L.weapons.length) { const p = this.data.item('Beretta92'); L.weapons.push(p.name); L.ammo.push([p['ammo-kind'], p['max-mag'] * 3]); }
    return L;
  }

  applyLoadout(L) {
    this.slots.fill(null);
    L.weapons.slice(0, this.slots.length).forEach((name, i) => { const it = this.data.item(name); if (it) this.slots[i] = this.newSlot(it); });
    for (const [k, n] of L.ammo) this.ammo.claim(k, n);
    for (const [name, n] of L.throwables) { const it = this.data.item(name); if (it) this.throwables.add(it, n); }
    for (const [name, n] of L.items) this.items.set(name, (this.items.get(name) || 0) + n);
    this.cur = Math.max(0, this.slots.findIndex((s) => s && s.isGun && s.item.class !== 'handgun'));
    if (!this.slots[this.cur]) this.cur = Math.max(0, this.slots.findIndex(Boolean));
  }

  // Snapshot of what the player carries (lobby -> match hand-off).
  loadoutSnapshot() {
    return { weapons: this.slots.filter(Boolean).map((s) => s.item.name), ammo: [...this.ammo], throwables: [...this.throwables.counts].filter(([, n]) => n > 0), items: [...this.items].filter(([, n]) => n > 0) };
  }

  newSlot(it) {
    const ups = this.profile ? this.profile.ups(it['sprite-id']) : {};
    const s = new WeaponSlot(it, this.data, undefined, ups);
    s.mag = s.stat('max-mag') ?? it['max-mag'];
    return s;
  }

  addAmmo(kind, n) { return this.ammo.claim(kind, n); }

  // Estimated payout so far (kills, time alive, difficulty).
  get earnings() { return payout({ kills: this.kills, alive: this.aliveTime || 0, won: !!this.won, difficulty: this.opts.difficulty }); }

  perkMods(slot) {
    const it = slot.item;
    const rifle = it.class === 'rifle', melee = slot.isMelee;
    const m = { dmg: 1, crit: 0, stun: 0, explosive: 1, radius: 1, rate: 1 };
    if (melee && this.hasPerk('BloodLust')) m.dmg *= 1.25;
    if (rifle && this.hasPerk('Steady') && !this.player.moving) m.dmg *= 1.25;
    if (rifle && this.hasPerk('Hypersonic')) m.crit += 0.2;
    if (rifle && this.hasPerk('Headshot')) m.crit += 0.5;
    if (melee && this.hasPerk('Savagery')) m.crit += 0.5;
    if (this.hasPerk('VitalSigns')) m.crit += 0.5;
    if ((melee && this.hasPerk('BluntForce')) || (rifle && this.hasPerk('Dazzle'))) m.stun = 1;
    if (this.hasPerk('BombsAway')) m.explosive = 1.25;
    if (this.hasPerk('BigBang')) m.radius = 1.5;
    if (rifle && this.hasPerk('Marksman')) m.rate = 0.75;
    if (melee && this.hasPerk('Agile')) m.rate = 0.75;
    return m;
  }

  // ---------- spawning ----------
  pickId(ids) {
    let total = 0;
    for (const [, w] of ids) total += w;
    let r = Math.random() * total;
    for (const [id, w] of ids) { r -= w; if (r <= 0) return id; }
    return ids[0][0];
  }

  spawnMob(id, x, y) {
    if (this.isClient) return null; // zeds come from the host's snapshots
    const def = this.data.mobs.get(id);
    if (!def) return null;
    const m = new Mob(def, x, y, this.mobAtlas(def), this.data.outfits);
    if (!m.layers.length) return null;
    m.maxHp = m.hp = Math.round(m.maxHp * (this.diff ? this.diff.hp : 1));
    if (this.dir) this.dir.onSpawn(m); // endless threat scaling + elites
    m.nid = ++this.nidSeq;
    this.mobs.push(m);
    return m;
  }

  // ---------- spectating & joining a running match ----------
  // While spectating, the player body is parked off-map: mobs have no route to it and wander.
  updateSpectator(dt) {
    const inp = this.input, pl = this.player;
    pl.x = -5000; pl.y = -5000;
    if (inp && (!this.session || this.session.view === 'spectate')) {
      const sp = (inp.isDown('run') ? 600 : 300) * dt;
      this.spec.x = Math.max(0, Math.min(this.map.pw, this.spec.x + inp.move.x * sp));
      this.spec.y = Math.max(0, Math.min(this.map.ph, this.spec.y + inp.move.y * sp));
    }
    sfx.listener.x = this.spec.x; sfx.listener.y = this.spec.y;
  }

  deploy(loadout) {
    const sp = this.squadSpawn() || this.pickSpawn();
    const pl = this.player;
    if (loadout) { this.ammo.slots.length = 0; this.throwables.counts.clear(); this.items.clear(); this.applyLoadout(loadout); }
    pl.x = sp.x; pl.y = sp.y; pl.hp = pl.maxHp; pl.alive = true; pl.jumpT = 0;
    this.ghost = false;
    this.deployedAt = this.time;
    this.aliveTime = 0; this.kills = 0;
    this.flowT = 0;
    this.msg('Deployed! ' + (this.ext.cfg ? this.ext.cfg.desc : ''), '#7dff8a');
  }

  // co-op: deploy next to a teammate (or the host's chosen start) instead of a random spawn marker
  squadSpawn() {
    if (!this.coop) return null;
    const near = (x, y) => this.map.randomWalkable({ x: x - 40, y: y - 40, w: 80, h: 80 });
    const mate = this.avatars && [...this.avatars.values()].find((a) => a.visible && a.alive && !a.down);
    if (mate) return near(mate.x, mate.y);
    if (this.teamSpawn && this.z === this.spawnFloor()) return near(this.teamSpawn.x, this.teamSpawn.y) || this.teamSpawn;
    return null;
  }

  spawnPoint() {
    // Original behaviour: infected come in from the map's MobSpawn rects (outer edges on almost
    // every map). Uniform pick, never on screen, never close, never in a sealed room.
    let cells = this.spawnCells(this.map);
    // rects walled off from the playable area (e.g. Hospital's river strip): use the outer ring instead
    if (!this.ghost && cells.length && this.flow.dist.some((d) => d !== -1) && !cells.some(([x, y]) => this.flow.dist[y * this.map.w + x] !== -1)) {
      if (!this.map._ringCells || !this.map._ringCells.length) {
        // outer ring of the area the player can actually reach (6 cells in from its bounding box)
        const W = this.map.w, reach = [];
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        this.flow.dist.forEach((d, i) => { if (d === -1) return; const x = i % W, y = (i / W) | 0; if (this.map.blocking(x, y)) return; reach.push([x, y]); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
        const ring = reach.filter(([x, y]) => Math.min(x - x0, x1 - x, y - y0, y1 - y) < 6);
        this.map._ringCells = ring.some(([x, y]) => !this.map.isInterior(x, y)) ? ring.filter(([x, y]) => !this.map.isInterior(x, y)) : ring;
      }
      cells = this.map._ringCells;
    }
    if (!cells.length) return null;
    const pl = this.player, cam = this.cam, map = this.map;
    const mates = this.coop ? this.coop.targets(this) : [];
    for (let i = 0; i < 16; i++) {
      const [cx, cy] = cells[(Math.random() * cells.length) | 0];
      const x = cx * T + 16, y = cy * T + 24;
      if (mates.some((a) => Math.hypot(x - a.x, y - a.y) < 420)) continue;
      if (!this.ghost) {
        if (Math.hypot(x - pl.x, y - pl.y) < 480) continue;
        if (cam && x > cam.x - 48 && x < cam.x + cam.vw + 48 && y > cam.y - 48 && y < cam.y + cam.vh + 64) continue;
        if (this.flow.dist[cy * map.w + cx] === -1) continue;
      }
      if (map.blocking(cx, cy)) continue;
      return { x, y };
    }
    return null;
  }

  // Spawn cells for a floor: its MobSpawn rects, else the outer ring reachable from the border
  // (closed doors and barricades count as walls so sealed rooms never spawn).
  spawnCells(map) {
    if (map._spawnCells) return map._spawnCells;
    let cells = (map.markers.MobSpawn || []).flatMap((r) => map.walkableCellsIn(r));
    if (!cells.length) {
      const W = map.w, H = map.h, seen = new Uint8Array(W * H), q = [];
      const push = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = y * W + x; if (seen[i] || map.blocking(x, y)) return; seen[i] = 1; q.push(i); };
      for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
      for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
      while (q.length) { const i = q.pop(), x = i % W, y = (i / W) | 0; push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1); }
      for (let i = 0; i < W * H; i++) if (seen[i]) { const x = i % W, y = (i / W) | 0; if (Math.min(x, y, W - 1 - x, H - 1 - y) < 6) cells.push([x, y]); }
      if (!cells.length) for (let i = 0; i < W * H; i++) if (seen[i]) cells.push([i % W, (i / W) | 0]);
    }
    // buildings are the safest places: never spawn infected inside one (unless that leaves no cells)
    const outdoor = cells.filter(([x, y]) => !map.isInterior(x, y));
    if (outdoor.length) cells = outdoor;
    return (map._spawnCells = cells);
  }

  updateSpawner(dt) {
    if (this.ext && this.ext.noSpawn) return;
    this.spawnT -= dt;
    for (const g of this.groups) {
      if (!g.announced && this.time >= g.unlock) {
        g.announced = true;
        this.msg((GROUP_NAMES[g.firstId] || 'New threat') + ' incoming!', '#ff7a5c');
      }
    }
    if (this.spawnT > 0) return;
    const alive = this.mobs.filter((m) => m.alive).length;
    // bigger hordes for bigger squads (Left 4 Dead style: +60% per extra survivor)
    const squad = 1 + (this.coop ? this.coop.targets(this).length : 0);
    let [cap, interval] = this.dir.spawnTuning(Math.min(8 + this.time / 8, 50) * (this.diff ? this.diff.spawn : 1), Math.max(0.5, 2.2 - this.time / 200));
    cap *= (1 + 0.6 * (squad - 1)) * this.density;
    this.spawnT = this.density > 1 ? interval / Math.sqrt(this.density) : interval;
    if (alive >= cap) return;
    const open = this.groups.filter((g) => this.time >= g.unlock);
    if (!open.length) return;
    // Base zeds are the bulk; later groups trickle in, bosses are one at a time.
    const weighted = open.map((g, i) => [g, i === 0 ? 8 : 1]);
    let total = weighted.reduce((a, [, w]) => a + w, 0), r = Math.random() * total, g = open[0];
    for (const [gg, w] of weighted) { r -= w; if (r <= 0) { g = gg; break; } }
    const id = this.pickId(g.ids);
    const def = this.data.mobs.get(id);
    if (def && def.hp >= 15000 && this.mobs.some((m) => m.alive && m.boss)) return;
    const live = this.mobs.filter((m) => m.alive && g.ids.some(([i]) => i === m.id)).length;
    if (live >= g.cap) return;
    const n = g === open[0] ? 1 + (Math.random() < this.time / 400 ? 1 : 0) : 1;
    for (let k = 0; k < n; k++) {
      const p = this.spawnPoint();
      if (p) {
        const m = this.spawnMob(id, p.x, p.y);
        if (m && m.boss) { this.msg('A ' + def.name + ' has appeared!', '#ff4b4b'); music('Plant 42 - Boss Theme RE'); play.radio(); }
      }
    }
  }

  // ---------- combat callbacks ----------
  damageMob(m, dmg, src) {
    if (!m.alive) return;
    let d = dmg * (src.mul || 1);
    if (src.crit && Math.random() < src.crit) { d *= src.critMul || 2; this.fx.spawn('bspark', m.x, m.cy, { scale: 0.8 }); play.crit(m.x, m.cy); }
    d *= (1 - (m.def.armor || 0)) * (1 - (m.eliteArmor || 0));
    const stunned = !!(src.stun && Math.random() < src.stun);
    if (this.isClient) {
      // the host applies the damage; show the hit right away
      m.hp -= d; m.flash = 0.08; m.localHitT = 0.3;
      if (stunned) this.fx.spawn('stun', m.x, m.cy - 12);
      if (Math.random() < 0.12) this.bloodDecal(m.x + (Math.random() - 0.5) * 10, m.y - 2, 0.5);
      this.coop.sendHit(m, d, src, stunned);
      return;
    }
    this.applyDamage(m, d, src, stunned);
  }

  applyDamage(m, d, src, stunned) {
    m.hp -= d;
    m.flash = 0.08;
    m.seen = true;
    if (stunned) { m.stun = 0.8; this.fx.spawn('stun', m.x, m.cy - 12); }
    const a = src.ang ?? Math.atan2(src.vy || 0, src.vx || 0);
    if (!m.boss) m.move(this.map, Math.cos(a) * (src.melee ? 5 : 1.5), Math.sin(a) * (src.melee ? 5 : 1.5));
    if (Math.random() < 0.12) this.bloodDecal(m.x + (Math.random() - 0.5) * 10, m.y - 2, 0.5);
    if (m.hp <= 0) this.killMob(m, src);
    else if (Math.random() < 0.3) play.mob('pain', m.def.name, m.x, m.y);
  }

  killMob(m, src = {}) {
    this.killFx(m);
    this.teamKills = (this.teamKills || 0) + 1;
    const by = src.by || 'H';
    if (this.isHost) this.coop.hostKill(this, m, by);
    if (this.dir) this.dir.onKill(m);
    if (by === 'H') this.killReward(m);
  }

  killFx(m) {
    m.alive = false;
    m.deadT = 0;
    play.mob('death', m.def.name, m.x, m.y);
    if (m.boss && !this.mobs.some((o) => o.alive && o.boss)) music('playlist');
    this.fx.spawn('blood-explode', m.x, m.cy, { scale: m.boss ? 2 : 1 });
    this.bloodDecal(m.x, m.y - 2, 1);
    if (this.dir && (m.boss || Math.random() < 0.6)) this.dir.goreBurst(m);
  }

  // Credit for a kill you landed: frenzy, perks and the loot roll (loot is per player in co-op).
  killReward(m) {
    this.kills++;
    if (this.dir) this.dir.onMyKill();
    this.fx.spawn('coin', m.x, m.y - 14, { scale: 0.35 });
    if (this.frenzyT <= 0) this.frenzy = Math.min(25, this.frenzy + 1);
    if (this.hasPerk('HeavyHits')) this.player.hp = Math.min(this.player.maxHp, this.player.hp + 3);
    const d = Math.random() < this.dir.dropChance() ? this.data.rollDrop(1) : null;
    if (d) this.pickups.push(this.makePickup(d.name, m.x, m.y - 6, null));
    if (m.boss) for (let i = 0; i < 3; i++) { const g = this.rollLoot(2, true); if (g) this.pickups.push(this.makePickup(g.name, m.x + i * 12 - 12, m.y, null, null, true)); }
  }

  bloodDecal(x, y, scale) {
    if (this.hasPerk('Sanitation') || this.opts.lobby) return;
    const a = this.atlas.infected;
    const n = Math.floor(Math.random() * 7);
    const found = a.find('bpuddle-' + n, ['default', 'walk', 'death'], ['x', 's', 'e']);
    const ctx = this.map.bot.getContext('2d');
    if (found) {
      ctx.globalAlpha = 0.55;
      a.drawCentered(ctx, found.list[0].f, x, y, scale, Math.floor(Math.random() * 4) * Math.PI / 2);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = 'rgba(90,0,0,0.6)';
      ctx.beginPath(); ctx.arc(x, y, 5 * scale, 0, 7); ctx.fill();
    }
  }

  ejectShell(it, who = this.player) {
    const kind = it.class === 'shotgun' ? 'shell-shotgun' : it.class === 'magnum' ? 'shell-magnum' : it.class === 'rifle' ? 'shell-rifle'
      : it.class === 'ar' || it.class === 'lmg' ? 'shell-nato' : 'shell-basic';
    const found = this.atlas.combat.find(kind, ['default'], ['x']);
    if (!found) return;
    const pl = who;
    const ctx = this.map.bot.getContext('2d');
    this.atlas.combat.drawCentered(ctx, found.list[0].f, pl.x + (Math.random() - 0.5) * 24, pl.y + (Math.random() - 0.3) * 10, 1, Math.random() * 6);
  }

  explosion(x, y, radius, dmg, element, visualOnly = false) {
    const base = element === 'fire' ? 'explode-fire' : element === 'acid' ? 'explode-acid' : element === 'freeze' ? 'explode-freeze' : 'explosion';
    this.fx.spawn(base, x, y, { scale: radius / 40 });
    if (base !== 'explosion') this.fx.spawn('explosion', x, y, { scale: radius / 64 });
    this.tempLights.push({ x, y, r: radius * 3, t: 0.35, max: 0.35 });
    this.shake = Math.max(this.shake, 7);
    play.explode(x, y);
    if (visualOnly) return; // a teammate's blast: their game applies the damage
    if (this.coop && !this.opts.lobby) this.coop.boom(this, x, y, radius, element);
    if (this.input) this.input.rumble('boom');
    if (element === 'fire' && this.ext) this.ext.addFire(x, y, radius * 0.7, this.hasPerk('Scorched') ? 12 : 6);
    for (const m of this.mobs) {
      if (!m.alive) continue;
      const d = Math.hypot(m.x - x, m.cy - y);
      if (d > radius + m.radius) continue;
      this.damageMob(m, dmg * Math.max(0.4, 1 - d / (radius + m.radius)), { ang: Math.atan2(m.cy - y, m.x - x), melee: true, stun: element === 'freeze' ? 1 : 0 });
    }
    for (const c of this.map.cades) {
      if (c.hp <= 0) continue;
      if (Math.hypot(c.x + 16 - x, c.y + 16 - y) < radius) { c.hp -= dmg * 0.3; c.hit = 0.2; if (c.hp <= 0) this.flowT = 0; }
    }
    const pl = this.player;
    const pd = Math.hypot(pl.x - x, pl.y - 10 - y);
    if (pd < radius * 0.6) this.hurtPlayer(Math.min(30, dmg * 0.04), 'blast');
    const ctx = this.map.bot.getContext('2d');
    ctx.fillStyle = 'rgba(20,16,12,0.35)';
    ctx.beginPath(); ctx.arc(x, y, radius * 0.4, 0, 7); ctx.fill();
  }

  hurtPlayer(dmg, kind) {
    const pl = this.player;
    if (!pl.alive) return;
    if (pl.down) { pl.downT -= dmg * 0.08; pl.hurtT = 0.15; return; } // zeds keep feeding on you
    if (/^(bite|rush|acid|web)$/.test(kind)) dmg *= (this.diff ? this.diff.dmg : 1) * (this.dir ? this.dir.dmgMul : 1);
    this.lastHurt = kind;
    if (this.dir) this.dir.hurt(dmg);
    if (this.hasPerk('PainTolerance')) dmg *= 1 - Math.min(0.5, (pl.maxHp - pl.hp) / 100);
    pl.hp -= dmg;
    pl.hurtT = 0.15;
    this.shake = Math.max(this.shake, 3);
    if (this.input) this.input.rumble('hurt');
    play.hurt(this.female);
    if (kind === 'bite' && Math.random() < 0.25) {
      pl.infection = Math.min(3, pl.infection + 1);
      this.msg('You have been infected! (Herb-B / mixed herbs cure it)', '#9cff6b');
    }
    if (kind === 'rush' && Math.random() < 0.5) { this.bleed = 8; this.msg('Bleeding! Use a bandage or herb', '#ff6b6b'); }
    if (pl.hp <= 0) {
      if (this.hasPerk('Kamikaze') && !pl.revives) {
        pl.revives = 1;
        pl.hp = pl.maxHp * 0.25;
        this.explosion(pl.x, pl.y - 10, 120, 1500, 'fire');
        this.msg('Kamikaze! Revived with 25% health', '#ffb347');
        return;
      }
      pl.hp = 0;
      if (this.coop && !this.opts.lobby && this.coop.teammatesUp()) {
        pl.down = true; pl.downT = 25; this.reload = null; this.bleed = 0;
        play.die(this.female);
        this.msg('You are DOWN! A teammate can revive you — hold on.', '#ff4b4b');
        return;
      }
      this.die();
    }
  }

  die() {
    const pl = this.player;
    pl.hp = 0; pl.down = false;
    pl.alive = false;
    this.deathT = 0;
    play.die(this.female);
    this.msg('You died.', '#ff4b4b');
  }

  revive(by) {
    const pl = this.player;
    pl.down = false; pl.downT = 0;
    pl.hp = Math.round(pl.maxHp * 0.3);
    this.fx.spawn('heal-quick', pl.x, pl.y - 14);
    this.msg(`${by} picked you up!`, '#7dff8a');
  }

  // co-op: a downed survivor crawls and bleeds out
  updateDowned(dt) {
    const pl = this.player, inp = this.input;
    pl.downT -= dt;
    pl.moving = false; pl.running = false;
    if (pl.downT <= 0) { this.die(); return; }
    if (!this.coop.teammatesUp() && pl.downT > 3) pl.downT = 3; // nobody left to save you
    const mv = inp ? inp.move : { mag: 0 };
    if (mv.mag > 0) { pl.move(this.map, (mv.x / mv.mag) * 18 * dt, (mv.y / mv.mag) * 18 * dt); pl.moving = true; }
  }

  // co-op client: the team changed floor (host decides)
  teamFloor(m) {
    if (m.to === this.z) return;
    const pl = this.player;
    this.setFloor(m.to);
    if (this.mirror) this.mirror.clear();
    this.mobs.length = 0;
    this.npcMirror = [];
    if (!this.ghost) { pl.x = m.x; pl.y = m.y; if (this.map.boxHits(pl.x, pl.y, pl.hw, pl.hh)) this.unstick(pl); }
    else { this.spec.x = m.x; this.spec.y = m.y; }
    this.onStairs = true;
    this.projectiles.list.length = 0;
    this.msg(`Team moved to floor ${m.to + 1} / ${this.floorCount}`, '#9cd4ff');
  }


  alertMobs(x, y, radius) {
    for (const m of this.mobs) if (m.alive && Math.abs(m.x - x) < radius * 2 && Math.abs(m.y - y) < radius * 2) m.seen = true;
  }

  startReload() {
    const s = this.slots[this.cur];
    if (!s || !s.isGun || this.reload) return;
    const max = s.stat('max-mag');
    if (s.mag >= max || !(this.ammo.get(s.ammoKind) > 0)) {
      if (!(this.ammo.get(s.ammoKind) > 0) && s.mag <= 0) this.msg('No ammo for ' + s.name, '#ffb0b0');
      return;
    }
    this.reload = { slot: s, t: 0, dur: s.stat('reload-time') / 1000 };
    play.reload(s.item);
  }

  // ---------- items ----------
  useItem(name) {
    const n = this.items.get(name) || 0;
    if (!n) return false;
    const it = this.data.item(name);
    if (it && it.kind === 'mine') return this.ext.placeMine(name);
    const pl = this.player;
    if (!it || it.kind !== 'consumable') return false;
    const heal = it['hp-heal'] || 0, cure = it.cure || 0;
    if (it['up-inv-cap']) { this.msg('Hip pouch equipped'); }
    if (heal <= 0 && !(cure & 2 && pl.infection) && !(cure & 1 && this.bleed > 0) && !it['up-inv-cap']) { this.msg(name + ' would have no effect'); return false; }
    pl.hp = Math.min(pl.maxHp, pl.hp + heal * pl.maxHp);
    if (cure & 2) pl.infection = 0;
    if (cure & 1) this.bleed = 0;
    if (!(this.hasPerk('TraumaCare') && Math.random() < 0.5)) this.items.set(name, n - 1);
    this.fx.spawn('heal-quick', pl.x, pl.y - 14);
    play.heal();
    this.msg('Used ' + name, '#9cff9c');
    if (Math.random() < 0.3) this.bark('relief');
    return true;
  }

  quickHeal() {
    const pl = this.player;
    const order = pl.infection ? ['Herb-RGB', 'Herb-BG', 'Herb-B', 'Herb-RG', 'Herb-GGG', 'Herb-GG', 'Herb-G', 'F.-Aid-Spray', 'Med-Kit', 'Antibiotics', 'Bandage']
      : ['Herb-G', 'Bandage', 'Antibiotics', 'Herb-GG', 'Med-Kit', 'Herb-RG', 'Herb-GGG', 'F.-Aid-Spray', 'Herb-BG', 'Herb-RGB'];
    for (const n of order) if ((this.items.get(n) || 0) > 0 && this.useItem(n)) return;
    this.msg('No healing items', '#ffb0b0');
  }

  craftable() {
    const have = (n) => this.items.get(this.canonical(n)) || 0;
    return this.data.recipes.filter((r) => {
      const need = {};
      for (const [p, k] of r.parts) need[this.canonical(p)] = (need[this.canonical(p)] || 0) + k;
      return Object.entries(need).every(([p, k]) => have(p) >= k);
    });
  }

  canonical(n) {
    const it = this.data.item(n);
    if (it) return it.name;
    const id = [...this.data.names].find(([, v]) => norm(v) === norm(n));
    return id ? id[1] : n;
  }

  craft(r) {
    for (const [p, k] of r.parts) { const c = this.canonical(p); this.items.set(c, (this.items.get(c) || 0) - k); }
    const out = this.data.item(r.out);
    if (out && out.kind === 'ammo') this.addAmmo(out['sprite-id'], r.n);
    else if (out && out.kind === 'throwable') this.throwables.add(out, r.n);
    else { const c = this.canonical(r.out); this.items.set(c, (this.items.get(c) || 0) + r.n); }
    this.msg('Crafted ' + this.canonical(r.out) + (r.n > 1 ? ' x' + r.n : ''), '#9cd4ff');
    play.pickup();
  }

  // Weapons go into a free slot, otherwise replace the one in hand (dropped at your feet).
  giveWeapon(it) {
    if (it.kind === 'throwable' || it.kind === 'mine') return this.throwables.add(it, 1);
    let si = this.slots.findIndex((s) => !s);
    if (si < 0) {
      si = this.cur;
      const old = this.slots[si];
      if (old && !this.opts.lobby) this.pickups.push(this.makePickup(old.item.name, this.player.x + 6, this.player.y - 4, null, null, true));
    }
    this.slots[si] = this.newSlot(it);
    this.prev = this.cur; this.cur = si; this.reload = null;
    if (this.slots[si].isGun && !this.opts.lobby) this.ammo.topUp(it['ammo-kind'], it['max-mag']);
  }

  ammoAmount(p) {
    const cap = this.data.ammoCap.get(p.item['sprite-id']) || 60;
    return Math.max(1, Math.round((p.amount ?? 0.5) <= 1 ? cap * (p.amount ?? 0.5) : p.amount));
  }

  collect(p, manual) {
    const pl = this.player;
    if (p.kind === 'ammo') {
      // auto: only tops up a slot already holding this type; manual (Use) claims a free slot
      // or replaces a slot whose ammo none of your weapons use
      const id = p.item['sprite-id'];
      let got = this.ammo.topUp(id, this.ammoAmount(p));
      if (!got && manual && !this.ammo.has(id)) {
        const used = new Set(this.slots.filter((s) => s && s.isGun).map((s) => s.ammoKind));
        const repl = this.ammo.slots.findIndex((s) => !used.has(s.kind));
        got = this.ammo.claim(id, this.ammoAmount(p), repl);
        if (!got) { this.msg('Ammo slots full — every slot feeds one of your guns', '#ffb0b0'); return false; }
      }
      if (!got) return false;
      this.msg('+' + got + ' ' + p.name);
    } else if (p.kind === 'throwable') {
      const n = Math.max(1, typeof p.amount === 'number' && p.amount >= 1 ? p.amount : 1);
      const got = this.throwables.add(p.item, n);
      if (!got) { if (manual) this.msg(p.name + ' pouch full'); return false; }
      this.msg('+' + got + ' ' + p.name, '#ffd36b');
    } else if (p.kind === 'consumable' || p.kind === 'material' || p.kind === 'board') {
      const n = Math.max(1, typeof p.amount === 'number' && p.amount >= 1 ? p.amount : 1);
      this.items.set(p.name, (this.items.get(p.name) || 0) + n);
      this.msg('+' + n + ' ' + p.name);
    } else if (p.kind === 'weapon') {
      if (!manual) return false;
      this.giveWeapon(p.item);
      this.msg('Picked up ' + p.name, '#ffd36b');
    } else {
      if (!manual) return false;
      this.msg('Found ' + p.name);
    }
    play.pickup();
    p.dead = true;
    return true;
  }

  interact() {
    const pl = this.player;
    const target = this.nearestInteractable();
    if (!target) return;
    if (target.type === 'ext') { target.run(); return; }
    if (target.type === 'pickup') this.collect(target.p, true);
    else if (target.type === 'revive') reviveNPC(this, target.n);
    else if (target.type === 'rescue') rescueSurvivor(this, target.n);
    else if (target.type === 'door') {
      const d = target.d;
      const occupied = this.mobs.some((m) => m.alive && Math.floor(m.x / T) === d.cx && Math.floor((m.y - 2) / T) === d.cy);
      if (d.open && occupied) return;
      d.open = !d.open;
      d.bash = 0;
      this.flowT = 0;
      play.door(d.open, d.x + 16, d.y + 16);
      // closing on yourself shoves you clear instead of trapping you in the frame
      if (!d.open && this.map.boxHits(pl.x, pl.y, pl.hw, pl.hh)) this.unstick(pl);
    } else if (target.type === 'board') {
      const c = target.c;
      const n = this.items.get('Boards') || 0;
      if (!n) { this.msg('You need boards to barricade this window'); return; }
      this.items.set('Boards', n - 1);
      c.hp = c.maxHp;
      this.flowT = 0;
      play.hammer();
      this.msg('Window boarded up', '#d7b98a');
    }
  }

  nearestInteractable() {
    if (this.ext && this.ext.interactable) { const t = this.ext.interactable(); if (t) return t; }
    const pl = this.player;
    let best = null, bd = 34;
    for (const n of this.npcs) {
      if (n.dead) continue;
      const d = Math.hypot(n.x - pl.x, n.y - pl.y);
      if (!n.alive && d < 34) return { type: 'revive', n, label: `Revive ${n.name}` };
      if (n.alive && n.mode === 'idle' && d < 34) return { type: 'rescue', n, label: `Rescue ${n.name}` };
    }
    for (const p of this.pickups) {
      if (p.dead) continue;
      const d = Math.hypot(p.x - pl.x, p.y - (pl.y - 12));
      if (d < bd) { bd = d; best = { type: 'pickup', p, label: (p.kind === 'weapon' ? 'Pick up ' : 'Take ') + p.name }; }
    }
    if (best) return best;
    bd = 36;
    for (const d of this.map.doors) {
      const dist = Math.hypot(d.x + 16 - pl.x, d.y + 16 - (pl.y - 8));
      if (dist < bd) { bd = dist; best = { type: 'door', d, label: d.open ? 'Close door' : 'Open door' }; }
    }
    for (const c of this.map.cades) {
      if (c.type !== 'Boarded' || c.hp >= c.maxHp) continue;
      const dist = Math.hypot(c.x + 16 - pl.x, c.y + 16 - (pl.y - 8));
      if (dist < bd) { bd = dist; best = { type: 'board', c, label: 'Board up window (' + (this.items.get('Boards') || 0) + ' boards)' }; }
    }
    return best;
  }

  // ---------- main update ----------
  update(dt) {
    if (this.paused || this.over) return;
    const pl = this.player, map = this.map;
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 20);
    this.muzzle -= dt;
    for (const l of this.tempLights) l.t -= dt;
    this.tempLights = this.tempLights.filter((l) => l.t > 0);
    for (const m of this.messages) m.t -= dt;
    this.messages = this.messages.filter((m) => m.t > 0);
    if (pl.bark) { pl.bark.t -= dt; if (pl.bark.t <= 0) pl.bark = null; }

    if (this.ghost) this.updateSpectator(dt);
    else {
      // co-op: menus don't pause the world, they only take your hands off the controls
      const inp = this.input;
      if (this.noInput) this.input = null;
      this.handleActions();
      this.updatePlayer(dt);
      if (this.coop) this.coop.updateRevive(this, dt);
      this.input = inp;
      this.checkStairs();
      this.updateFollowers(dt);
      sfx.listener.x = pl.x; sfx.listener.y = pl.y;
    }
    if (!pl.alive && !this.ghost) {
      this.deathT += dt;
      if (this.deathT > 2.2 && !this.over) { this.over = true; this.onEnd(); }
    }

    if (this.isClient) {
      // zeds and NPCs are simulated by the host and mirrored here (coop.updateMirror)
      if (this.ext) this.ext.update(dt);
    } else {
      this.flowT -= dt;
      const [pcx, pcy] = cellOf(pl);
      if (this.flowT <= 0 || pcx !== this.flowCell?.[0] || pcy !== this.flowCell?.[1]) {
        if (this.flowT <= 0 || this.flowT < 0.2) {
          // zeds path to the nearest survivor: you plus any teammates on this floor
          const more = this.coop ? this.coop.targets(this).map(cellOf) : [];
          this.flow.compute(pcx, pcy, more);
          this.flowCell = [pcx, pcy];
          this.flowT = 0.4;
        }
      }

      this.updateSpawner(dt);
      if (this.ext) this.ext.update(dt);
      for (const m of this.mobs) this.updateMob(m, dt);
      for (const n of this.npcs) updateNPC(this, n, dt);
      this.separateHumans();
      this.separateMobs();
      this.mobs = this.mobs.filter((m) => m.alive || m.deadT < 2);
    }
    this.projectiles.update(dt);
    this.fx.update(dt);
    if (this.dir) this.dir.update(dt);
    for (const c of map.cades) c.hit = Math.max(0, c.hit - dt);

    // coins fly to the player
    for (const c of this.coinsList) {
      c.t += dt;
      const dx = pl.x - c.x, dy = pl.y - 8 - c.y, d = Math.hypot(dx, dy);
      if (c.t > 0.5 && pl.alive) { c.x += (dx / d) * 260 * dt; c.y += (dy / d) * 260 * dt; }
      else { c.x += c.vx * dt; c.y += c.vy * dt; c.vy += 120 * dt; }
      if (d < 10 && c.t > 0.5) { c.dead = true; this.coins += c.v; play.coin(); }
    }
    this.coinsList = this.coinsList.filter((c) => !c.dead);

    for (const p of this.pickups) {
      if (p.dead || p.kind === 'weapon' && !(p.item.kind === 'throwable')) continue;
      if (Math.hypot(p.x - pl.x, p.y - (pl.y - 12)) < 30 && pl.alive) this.collect(p, false);
    }
    this.pickups = this.pickups.filter((p) => !p.dead);

    // swarmed bark
    this.barkT -= dt;
    if (this.barkT <= 0) {
      const near = this.mobs.filter((m) => m.alive && Math.hypot(m.x - pl.x, m.y - pl.y) < 140).length;
      if (near >= 7) { this.bark('swarmed'); this.barkT = 14; } else this.barkT = 2;
    }
  }

  // ---------- input ----------
  handleActions() {
    const inp = this.input;
    if (!inp || !this.player.alive || this.player.down) return;
    const P = (a) => inp.pressed(a);
    const select = (i) => { if (this.slots[i] && i !== this.cur) { this.prev = this.cur; this.cur = i; this.reload = null; } };
    const cycle = (dir) => {
      const N = this.slots.length;
      for (let k = 1; k <= N; k++) { const i = (((this.cur + dir * k) % N) + N) % N; if (this.slots[i]) { select(i); return; } }
    };
    if (P('jump')) this.jump();
    if (P('context')) { if (this.nearestInteractable()) this.interact(); else this.jump(); }
    if (P('mine')) { const m = [...this.throwables.counts].find(([k, v]) => v > 0 && /^mine/i.test(k)); if (m && this.ext.placeMineItem(this.data.item(m[0]))) this.throwables.counts.set(m[0], m[1] - 1); else if (!m) this.msg('No mines in your pouch'); }
    if (P('reload')) this.startReload();
    if (P('interact')) this.interact();
    if (P('grenade')) this.throwGrenade();
    if (P('toggleThrowable')) { const n = this.throwables.cycle(); this.msg(n ? `Throwable: ${n} ×${this.throwables.counts.get(n)}` : 'No throwables', '#ffd36b'); }
    if (P('heal')) this.quickHeal();
    if (P('flashlight')) { this.flashlight = !this.flashlight; play.flashlight(); }
    if (P('frenzy') && this.frenzy >= 25 && this.frenzyT <= 0) { this.frenzyT = 15; this.frenzy = 0; this.msg('FRENZY!', '#ff4bd1'); play.frenzy(); }
    for (let i = 0; i < this.slots.length; i++) if (P('slot' + (i + 1))) select(i);
    if (P('nextWeapon')) cycle(1);
    if (P('prevWeapon')) cycle(-1);
    if (P('lastWeapon') && this.slots[this.prev]) { [this.cur, this.prev] = [this.prev, this.cur]; this.reload = null; }
  }

  // Jump: clears fences, barricades and boarded windows; costs stamina, dodges bites mid-air.
  jump() {
    const pl = this.player;
    if (pl.airborne || pl.stamina < 8) return;
    pl.jumpT = JUMP_TIME;
    pl.stamina -= 8;
    play.jump();
  }

  get legacy() { return !!(this.input && this.input.settings.legacy); }

  // Legacy shooting: closest visible zed within the current weapon's reach.
  pickLegacyTarget(slot) {
    if (!slot || slot.isThrowable && false) return null;
    const pl = this.player, ox = pl.x, oy = pl.y - 11;
    const reach = slot.isMelee ? (slot.item.range || 32) + 40 : Math.min(slot.item.range || 320, 340);
    const cam = this.cam;
    const cands = [];
    for (const m of this.mobs) {
      if (!m.alive) continue;
      const d = Math.hypot(m.x - ox, m.cy - oy);
      if (d > reach + m.radius) continue;
      if (cam && (m.x < cam.x - 8 || m.x > cam.x + cam.vw + 8 || m.y < cam.y - 8 || m.y > cam.y + cam.vh + 24)) continue;
      cands.push([d, m]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    for (const [, m] of cands.slice(0, 8)) if (this.map.los(ox, oy, m.x, m.cy)) return m;
    return null;
  }

  // Balanced weighted accuracy: weapon class base, distance falloff vs. the weapon's range,
  // shooter movement, target size/state, plus a pity bonus after consecutive misses.
  hitChance(slot, m) {
    if (!slot || slot.isMelee) return 1;
    const pl = this.player;
    const base = { handgun: 0.82, smg: 0.72, ar: 0.78, lmg: 0.66, shotgun: 0.9, rifle: 0.9, magnum: 0.84, bow: 0.86,
      launcher: 0.9, 'rocket-launcher': 0.92, thrower: 1, special: 0.75, throwable: 0.85 }[slot.item.class] ?? 0.75;
    const d = Math.hypot(m.x - pl.x, m.cy - (pl.y - 11));
    const f = Math.min(1, d / (slot.item.range || 320));
    let c = base * (1 - 0.45 * Math.pow(f, 1.5));
    if (pl.running) c *= 0.6; else if (pl.moving) c *= 0.85;
    if (m.boss) c *= 1.2; else if (m.radius < 8) c *= 0.85;
    if (m.state === 'rush') c *= 0.85;
    if (slot.item.class === 'rifle' && this.hasPerk('Steady') && !pl.moving) c += 0.05;
    if (this.frenzyT > 0) c += 0.1;
    c += (this.missStreak || 0) * 0.07;
    return Math.max(0.12, Math.min(0.97, c));
  }

  // Angle for one legacy shot at m: inside the body on a hit, just outside it on a miss.
  legacyShotAngle(slot, m) {
    const pl = this.player, ox = pl.x, oy = pl.y - 11;
    const a = Math.atan2(m.cy - oy, m.x - ox), d = Math.max(8, Math.hypot(m.x - ox, m.cy - oy));
    const ang = Math.atan(m.radius / d);
    if (Math.random() < this.hitChance(slot, m)) { this.missStreak = 0; return a + (Math.random() - 0.5) * ang; }
    this.missStreak = (this.missStreak || 0) + 1;
    return a + (Math.random() < 0.5 ? -1 : 1) * (ang + 0.04 + Math.random() * 0.12);
  }

  updatePlayer(dt) {
    const pl = this.player, inp = this.input;
    pl.animT += dt * 1000;
    pl.hurtT -= dt;
    if (!pl.alive) return;
    if (pl.jumpT > 0) {
      pl.jumpT -= dt;
      // never land inside a fence/barricade: hang until clear (short grace window)
      if (pl.jumpT <= 0 && this.map.boxHits(pl.x, pl.y, pl.hw, pl.hh)) {
        pl.landGrace = (pl.landGrace || 0) + dt;
        pl.jumpT = pl.landGrace < 0.6 ? 0.02 : 0;
        if (!pl.jumpT) this.unstick(pl);
      } else if (pl.jumpT <= 0) { pl.jumpT = 0; pl.landGrace = 0; play.step(pl.x, pl.y); }
    }
    if (!pl.jumpT && this.map.boxHits(pl.x, pl.y, pl.hw, pl.hh)) {
      pl.stuckT = (pl.stuckT || 0) + dt;
      if (pl.stuckT > 0.15) { this.unstick(pl); pl.stuckT = 0; }
    } else pl.stuckT = 0;
    if (pl.down) { this.updateDowned(dt); return; }
    const s = this.slots[this.cur];

    // legacy lock-on (always computed in legacy mode so the reticle shows)
    this.lockTarget = this.legacy ? this.pickLegacyTarget(s) : null;
    const legacyFire = this.legacy && inp && (inp.isDown('autofire') || (inp.lastDevice !== 'kbm' && (inp.isDown('fire') || inp.aimFire)));
    let wx = this.mouse.wx, wy = this.mouse.wy;
    if (this.lockTarget && (legacyFire || (inp && inp.lastDevice !== 'kbm' && !inp.aimMag))) { wx = this.lockTarget.x; wy = this.lockTarget.cy; }
    pl.aim = Math.atan2(wy - (pl.y - 11), wx - pl.x);

    const mv = inp ? inp.move : { x: 0, y: 0, mag: 0 };
    const mx = mv.x, my = mv.y;
    pl.moving = mv.mag > 0;
    const wantRun = inp && (inp.isDown('run') || inp.stickRun);
    pl.running = pl.moving && wantRun && !pl.tired;
    if (pl.running) { pl.stamina -= 12 * dt; if (pl.stamina <= 0) { pl.stamina = 0; pl.tired = true; } }
    else pl.stamina = Math.min(100, pl.stamina + (pl.moving ? 14 : 24) * dt);
    if (pl.tired && pl.stamina > 20) pl.tired = false;
    let speed = pl.running ? RUN : WALK;
    if (s && !this.hasPerk('Agile')) speed *= 1 - Math.min(0.25, (s.item.weight || 0) * 0.3);
    if (this.webbed > 0) { this.webbed -= dt; speed *= 0.45; }
    if (pl.moving) {
      this.stepT = (this.stepT || 0) - dt * (pl.running ? 1.6 : 1);
      if (this.stepT <= 0) { this.stepT = 0.42; play.step(pl.x, pl.y); }
      const k = pl.running ? 1 : Math.max(0.45, mv.mag);
      pl.move(this.map, mx / mv.mag * k * speed * dt, my / mv.mag * k * speed * dt);
    }
    pl.dir = dirOf(Math.cos(pl.aim), Math.sin(pl.aim));

    // statuses
    if (pl.infection) {
      pl.infectT += dt;
      if (pl.infectT > 5 / pl.infection) { pl.infectT = 0; pl.hp -= 1; if (pl.hp <= 0) this.hurtPlayer(1, 'infection'); }
    }
    if (this.bleed > 0) { this.bleed -= dt; pl.hp -= 1.2 * dt; if (pl.hp <= 0) this.hurtPlayer(1, 'bleed'); }
    if (this.frenzyT > 0) {
      this.frenzyT -= dt;
      if (this.hasPerk('HealingPulse')) { this.pulseT = (this.pulseT || 0) - dt; if (this.pulseT <= 0) { this.pulseT = 3; pl.hp = Math.min(pl.maxHp, pl.hp + pl.maxHp * 0.05); this.fx.spawn('heal-quick', pl.x, pl.y - 14); } }
    }

    // reload
    if (this.reload) {
      this.reload.t += dt;
      if (this.slots[this.cur] !== this.reload.slot) this.reload = null;
      else if (this.reload.t >= this.reload.dur) {
        const r = this.reload.slot;
        const need = r.stat('max-mag') - r.mag;
        const have = this.ammo.get(r.ammoKind) || 0;
        const take = Math.min(need, have);
        r.mag += take;
        this.ammo.set(r.ammoKind, have - take);
        this.reload = null;
        play.reloaded(r.item);
      }
    }

    // attack
    for (const sl of this.slots) if (sl) sl.cd -= dt * 1000;
    this.throwCd = (this.throwCd || 0) - dt;
    // tactical auto-reload: quiet for 2 s and the mag is under half
    const quiet = !this.mobs.some((m) => m.alive && Math.hypot(m.x - pl.x, m.y - pl.y) < 300);
    this.quietT = quiet ? (this.quietT || 0) + dt : 0;
    if (s && s.isGun && !this.reload && this.quietT > 2 && s.mag < s.stat('max-mag') * 0.5 && this.ammo.get(s.ammoKind) > 0) this.startReload();
    if (!this.opts.lobby) this.aliveTime = (this.aliveTime || 0) + dt; // pay only accrues on a real map
    if (s && !this.reload && !this.opts.lobby) {
      const rate = s.stat('fire-rate') * this.perkMods(s).rate;
      const auto = s.isMelee || (s.isGun && s.item['fire-rate'] <= 150);
      const held = this.mouse.down || (inp && (inp.isDown('fire') && !(this.legacy && inp.lastDevice !== 'kbm') || (!this.legacy && inp.aimFire)));
      const tap = this.mouse.clicked || (inp && inp.pressed('fire'));
      let trigger = auto ? held : tap || (held && inp && inp.lastDevice !== 'kbm');
      let fx = wx, fy = wy;
      if (legacyFire) {
        // legacy auto-fire keeps shooting (semi-autos at their fire rate) at the locked zed
        trigger = !!this.lockTarget;
        if (this.lockTarget && !s.isMelee) {
          const a = this.legacyShotAngle(s, this.lockTarget);
          fx = pl.x + Math.cos(a) * 200; fy = pl.y - 11 + Math.sin(a) * 200;
        }
      }
      if (trigger && s.cd <= 0) {
        if (fireWeapon(this, s, fx, fy)) {
          if (this.coop && s.isGun) this.coop.shot(this, s.item);
          if (inp && s.isGun) inp.rumble(s.item.damage >= 140 || (s.item.spread || 1) > 1 ? 'heavy' : 'shot');
          s.cd = rate;
          this.recoilT = 0.08;
        } else s.cd = 250;
      }
      if (s.isGun && s.mag <= 0 && (this.ammo.get(s.ammoKind) || 0) > 0 && s.cd <= 0) this.startReload();
    }
    this.recoilT = (this.recoilT || 0) - dt;
    this.mouse.clicked = false;
  }

  throwGrenade() {
    if (this.opts.lobby || !this.player.alive || (this.throwCd || 0) > 0) return;
    const name = this.throwables.sel;
    const it = name && this.data.item(name);
    if (!it || !(this.throwables.counts.get(name) > 0)) { this.msg('No throwables'); return; }
    if (it.kind === 'mine') { if (this.ext.placeMineItem(it)) this.throwables.take(); this.throwCd = 0.5; return; }
    const g = new WeaponSlot(it, this.data, 1);
    let tx = this.mouse.wx, ty = this.mouse.wy;
    const inp = this.input, pl = this.player;
    const target = this.legacy ? this.pickLegacyTarget(g) : null;
    if (target) { tx = target.x; ty = target.cy; }
    else if (inp && inp.lastDevice !== 'kbm') { tx = pl.x + Math.cos(pl.aim) * 150; ty = pl.y - 11 + Math.sin(pl.aim) * 150; }
    if (fireWeapon(this, g, tx, ty)) {
      this.throwables.take();
      this.throwCd = (g.stat('fire-rate') || 500) / 1000;
    }
  }

  updateMob(m, dt) {
    const map = this.map;
    const pl = this.mobTarget(m, dt);
    if (!m.alive) { m.deadT += dt; return; }
    m.animT += dt * 1000;
    m.flash -= dt;
    for (const c of m.cds) c.t -= dt * 1000;
    const dx = pl.x - m.x, dy = pl.y - m.y, d = Math.hypot(dx, dy);
    m.losT -= dt;
    if (m.losT <= 0) {
      m.los = pl.alive && d < 420 && map.los(m.x, m.cy, pl.x, pl.y - 10);
      if (m.los) m.seen = true;
      m.losT = 0.2 + Math.random() * 0.15;
    }
    m.groan -= dt;
    if (m.groan <= 0) { m.groan = 4 + Math.random() * 10; if (d < 420) play.mob('moan', m.def.name, m.x, m.y); }
    if (m.stun > 0) { m.stun -= dt; return; }

    if (m.state === 'attack') {
      m.stateT += dt;
      if (!m.hitDone && m.stateT >= 0.35) {
        m.hitDone = true;
        if (m.pending) { this.projectiles.list.push(m.pending); if (this.isHost) this.coop.sendProj(this, m.pending); m.pending = null; }
        else if (d < 26 + m.radius && pl.alive && !pl.airborne) { if (pl.npc) hurtNPC(this, pl, m.atkDmg); else if (pl.remote) this.coop.hurtRemote(pl, m.atkDmg, 'bite'); else this.hurtPlayer(m.atkDmg, 'bite'); }
      }
      if (m.stateT >= 0.7) m.state = 'walk';
      return;
    }
    if (m.state === 'rush') {
      m.stateT += dt;
      if (!m.move(map, m.rushV[0] * dt, m.rushV[1] * dt)) m.stateT = 1;
      if (!m.hitDone && d < 14 + m.radius && pl.alive) { m.hitDone = true; if (pl.remote) this.coop.hurtRemote(pl, m.atkDmg, 'rush'); else if (!pl.npc) this.hurtPlayer(m.atkDmg, 'rush'); }
      if (m.stateT > 0.55) m.state = 'walk';
      return;
    }

    // choose an attack
    if (pl.alive) for (const c of m.cds) {
      if (c.t > 0) continue;
      const a = c.a;
      if (a.kind === 'basic' && d < 18 + m.radius) {
        this.beginAttack(m, a, c, dx, dy);
        return;
      }
      // rush (lunge) attacks are disabled by design: too hard to counter
      if (false && a.kind === 'rush' && m.los && d < (a.range || 96) && d > 36) {
        const sp = Math.max(m.speed * 3.2, 150);
        m.state = 'rush'; m.stateT = 0; m.hitDone = false; m.atkDmg = Math.min(a.dmg, 40);
        play.mob('attack', m.def.name, m.x, m.y);
        m.rushV = [(dx / d) * sp, (dy / d) * sp];
        m.dir = dirOf(dx, dy);
        c.t = a.cd;
        return;
      }
      if (/^(acid-spit|acid-h-spray|tongue|tongue-ult)$/.test(a.kind) && m.los && d < (a.range || 320) && d > 48) {
        this.beginAttack(m, a, c, dx, dy);
        const sp = 210, web = a.kind.startsWith('tongue');
        m.pending = { kind: 'bullet', hostile: true, webbed: web, grab: web && (a.kind === 'tongue-ult' || m.boss || Math.random() < 0.5) ? m : null, x: m.x, y: m.cy, vx: (dx / d) * sp, vy: ((dy - 0) / d) * sp,
          range: a.range || 320, dmg: a.dmg, traveled: 0, hit: new Set(), sprite: web ? 'web-spit_default_x_0' : 'web-acid-spit_default_x_0' };
        return;
      }
    }

    // move: direct chase when visible and close, otherwise follow the flow field
    let tx, ty, bash = null;
    const [cx, cy] = cellOf(m);
    const nxt = this.flow.next(cx, cy);
    if (m.los && d < 180) { tx = pl.x; ty = pl.y; }
    else if (nxt) {
      tx = nxt[0] * T + 16; ty = nxt[1] * T + 22;
      const dyn = map.dyn[map.idx(nxt[0], nxt[1])];
      if (dyn && map.blocking(nxt[0], nxt[1], false, true) && Math.hypot(tx - m.x, ty - 6 - m.y) < 30) bash = dyn;
    } else {
      // no route: idle shamble
      m.wander = (m.wander || 0) - dt;
      if (m.wander <= 0) { m.wander = 2 + Math.random() * 3; m.wdir = Math.random() * Math.PI * 2; }
      tx = m.x + Math.cos(m.wdir) * 20; ty = m.y + Math.sin(m.wdir) * 20;
    }
    if (bash) {
      m.dir = dirOf(tx - m.x, ty - m.y);
      m.bashT = (m.bashT || 0) - dt;
      if (m.bashT <= 0) {
        m.bashT = 1.2;
        m.state = 'attack'; m.stateT = 0.36; m.hitDone = true;
        if (bash.kind === 'cade') { bash.hp -= 20 + (m.def.hp >= 800 ? 40 : 0); bash.hit = 0.2; play.wood(bash.x + 16, bash.y + 16); if (bash.hp <= 0) { play.woodBreak(bash.x + 16, bash.y + 16); this.flowT = 0; this.fx.spawn('dust', bash.x + 16, bash.y + 16); } }
        else { bash.bash = (bash.bash || 0) + 1; play.doorBash(bash.x + 16, bash.y + 16); if (bash.bash >= 5) { bash.open = true; this.flowT = 0; } }
      }
      return;
    }
    const vx = tx - m.x, vy = ty - m.y, vl = Math.hypot(vx, vy) || 1;
    const sp = m.speed * (m.seen ? 1 : 0.85) * dt;
    m.move(map, (vx / vl) * sp, (vy / vl) * sp);
    m.dir = dirOf(vx, vy);
  }

  // Mobs go for the nearest standing human; the player is slightly preferred. Re-evaluated twice a second.
  mobTarget(m, dt) {
    m.tgtT = (m.tgtT || 0) - dt;
    if (m.tgtT <= 0 || !m.tgt || !m.tgt.alive) {
      m.tgtT = 0.5;
      let best = this.player, bd = this.player.alive ? Math.hypot(this.player.x - m.x, this.player.y - m.y) * 0.85 : Infinity;
      for (const n of this.npcs) {
        if (!n.alive) continue;
        const d = Math.hypot(n.x - m.x, n.y - m.y);
        if (d < bd && d < 260) { bd = d; best = n; }
      }
      if (this.coop) for (const a of this.coop.targets(this)) {
        const d = Math.hypot(a.x - m.x, a.y - m.y) * 0.85;
        if (d < bd) { bd = d; best = a; }
      }
      m.tgt = best;
    }
    return m.tgt;
  }

  separateHumans() {
    const all = [this.player, ...this.npcs.filter((n) => n.alive)];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d > 0 && d < 12) { const k = (12 - d) / 2; if (j && b.npc) b.move(this.map, (dx / d) * k * 2, (dy / d) * k * 2); }
    }
    for (const n of this.npcs) for (const m of this.mobs) {
      if (!n.alive || !m.alive) continue;
      const dx = m.x - n.x, dy = m.y - n.y, d = Math.hypot(dx, dy), min = m.radius + 4;
      if (d > 0 && d < min) m.move(this.map, (dx / d) * (min - d), (dy / d) * (min - d));
    }
  }

  // push the player to the nearest free cell centre (after an aborted landing)
  unstick(pl) {
    const cx = Math.floor(pl.x / T), cy = Math.floor(pl.y / T);
    let best = null, bd = Infinity;
    for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
      const x = (cx + ox) * T + 16, y = (cy + oy) * T + 20;
      if (this.map.boxHits(x, y, pl.hw, pl.hh)) continue;
      const d = Math.hypot(x - pl.x, y - pl.y);
      if (d < bd) { bd = d; best = [x, y]; }
    }
    if (best) [pl.x, pl.y] = best;
    pl.landGrace = 0;
  }

  beginAttack(m, a, c, dx, dy) {
    m.state = 'attack'; m.stateT = 0; m.hitDone = false; m.atkDmg = a.dmg;
    play.mob('attack', m.def.name, m.x, m.y);
    m.dir = dirOf(dx, dy);
    c.t = a.cd;
  }

  separateMobs() {
    const live = this.mobs.filter((m) => m.alive);
    const grid = new Map();
    for (const m of live) {
      const k = ((m.x / 24) | 0) + ',' + ((m.y / 24) | 0);
      let b = grid.get(k); if (!b) grid.set(k, (b = [])); b.push(m);
    }
    const pl = this.player;
    const humans = [pl.alive ? pl : null, ...(this.coop ? this.coop.targets(this) : [])].filter(Boolean);
    for (const m of live) {
      const gx = (m.x / 24) | 0, gy = (m.y / 24) | 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const b = grid.get((gx + ox) + ',' + (gy + oy));
        if (!b) continue;
        for (const o of b) {
          if (o === m) continue;
          const dx = m.x - o.x, dy = m.y - o.y, d = Math.hypot(dx, dy), min = (m.radius + o.radius) * 0.8;
          if (d > 0 && d < min) { const push = (min - d) * 0.25; m.move(this.map, (dx / d) * push, (dy / d) * push); }
        }
      }
      for (const h of humans) {
        const dx = m.x - h.x, dy = m.y - h.y, d = Math.hypot(dx, dy), min = m.radius + 4;
        if (d > 0 && d < min) m.move(this.map, (dx / d) * (min - d), (dy / d) * (min - d));
      }
    }
  }

  // ---------- rendering ----------
  render() {
    const ctx = this.ctx, cv = this.canvas, pl = this.player, map = this.map;
    if (!cv.width || !cv.height) return; // minimized / zero-size window
    // Integer zoom on desktop; half steps on small (phone) screens so enough of the map is visible.
    const short = Math.min(cv.height, cv.width * 0.75);
    const zoom = this.zoom = short < 500 ? Math.max(1.5, Math.round((short / 230) * 2) / 2) : Math.max(2, Math.round(cv.height / 330));
    const vw = cv.width / zoom, vh = cv.height / zoom;
    const focus = this.ghost ? this.spec : pl;
    let camX = focus.x - vw / 2, camY = focus.y - 12 - vh / 2;
    camX = Math.max(0, Math.min(map.pw - vw, camX));
    camY = Math.max(0, Math.min(map.ph - vh, camY));
    if (map.pw < vw) camX = (map.pw - vw) / 2;
    if (map.ph < vh) camY = (map.ph - vh) / 2;
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    this.cam = { x: camX, y: camY, vw, vh };
    const inp = this.input;
    if (!inp || inp.aimSource === 'mouse') {
      const mx = inp ? inp.mouse.x : this.mouse.x, my = inp ? inp.mouse.y : this.mouse.y;
      this.mouse.wx = camX + mx / zoom;
      this.mouse.wy = camY + my / zoom;
    } else {
      // stick / touch aim: a point in front of the player along the aim angle
      this.mouse.wx = pl.x + Math.cos(inp.aimAngle) * 110;
      this.mouse.wy = pl.y - 11 + Math.sin(inp.aimAngle) * 110;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#050608';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(zoom, 0, 0, zoom, Math.round((-camX + sx) * zoom), Math.round((-camY + sy) * zoom));

    const x0 = Math.max(0, Math.floor(camX)), y0 = Math.max(0, Math.floor(camY));
    const w = Math.min(map.pw - x0, Math.ceil(vw) + 2), h = Math.min(map.ph - y0, Math.ceil(vh) + 2);
    if (w > 0 && h > 0) ctx.drawImage(map.bot, x0, y0, w, h, x0, y0, w, h);

    // y-sorted drawables
    const inView = (x, y, pad = 64) => x > camX - pad && x < camX + vw + pad && y > camY - pad && y < camY + vh + pad * 2;
    if (this.ext) this.ext.drawGround(ctx);
    const list = [];
    for (const d of map.doors) if (inView(d.x, d.y)) list.push([d.y + 30, () => map.drawDynamic(ctx, d)]);
    for (const c of map.cades) if (inView(c.x, c.y)) list.push([c.y + 30, () => map.drawDynamic(ctx, c)]);
    for (const p of this.pickups) if (inView(p.x, p.y)) list.push([p.y, () => this.drawPickup(ctx, p)]);
    for (const m of this.mobs) if (inView(m.x, m.y)) list.push([m.alive ? m.y : m.y - 40, () => { if (m.elite && m.alive) this.dir.drawElite(ctx, m); m.draw(ctx, this.atlas.infected); }]);
    if (!this.ghost) list.push([pl.y, () => pl.draw(ctx, this.atlas.core, () => this.drawHeldWeapon(ctx))]);
    if (this.ext && this.ext.drawables) this.ext.drawables(list, ctx);
    if (this.coop) this.coop.drawAvatars(this, list, ctx, inView);
    for (const n of this.npcs) if (inView(n.x, n.y)) list.push([n.alive ? n.y : n.y - 30, () => n.draw(ctx, this.atlas.core, n.weapon ? () => this.drawWeapon(ctx, n, n.weapon, n.recoilT > 0, n.flashT > 0) : null)]);
    list.sort((a, b) => a[0] - b[0]);
    for (const [, f] of list) f();

    if (w > 0 && h > 0) ctx.drawImage(map.top, x0, y0, w, h, x0, y0, w, h);
    if (this.ext) this.ext.drawAir(ctx);
    this.projectiles.draw(ctx, this.atlas.combat);
    this.fx.draw(ctx);
    if (this.dir) this.dir.drawGibs(ctx);
    for (const c of this.coinsList) {
      const found = this.atlas.combat.find('coin', ['default'], ['x']);
      if (found) this.atlas.combat.drawCentered(ctx, Atlas.frameAt(found.list, c.t * 1000), c.x, c.y, 0.4);
    }
    this.drawOverheads(ctx);
    if (this.coop) this.coop.drawOverheads(this, ctx);

    this.renderLighting(ctx, zoom, camX, camY);
    this.drawLockOn(ctx, zoom, camX, camY);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.ext) this.ext.drawScreen(ctx, cv.width, cv.height, Math.max(1, Math.round(cv.height / 400)));
    this.drawHud(ctx, cv.width, cv.height);
    if (this.dir) this.dir.drawScreen(ctx, cv.width, cv.height);
    this.drawMinimap(ctx, cv.width, cv.height);
    if (this.coop) this.coop.drawScreen(this, ctx, cv.width, cv.height);
  }

  // Legacy lock-on reticle (screen space, drawn above the darkness so it stays readable).
  drawLockOn(ctx, zoom, camX, camY) {
    const m = this.lockTarget;
    if (!m || !m.alive || !this.player.alive) return;
    const s = this.slots[this.cur];
    const x = (m.x - camX) * zoom, y = (m.cy - camY) * zoom, r = (m.radius + 6) * zoom;
    const chance = this.hitChance(s, m);
    const col = chance > 0.7 ? '#7dff8a' : chance > 0.45 ? '#ffd36b' : '#ff6b6b';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    const t = this.time * 3;
    for (let i = 0; i < 4; i++) {
      const a = t + (i * Math.PI) / 2;
      ctx.beginPath(); ctx.arc(x, y, r, a, a + 0.9); ctx.stroke();
    }
    if (this.input && this.input.settings.showHitChance && s && !s.isMelee) {
      ctx.font = `${Math.round(6 * zoom)}px Bebas, Impact, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = col;
      ctx.fillText(Math.round(chance * 100) + '%', x, y - r - 4);
      ctx.textAlign = 'left';
    }
  }

  drawHeldWeapon(ctx) {
    const s = this.slots[this.cur];
    if (!s || s.isThrowable) return;
    this.drawWeapon(ctx, this.player, s.item, this.recoilT > 0, this.muzzle > 0 && s.isGun);
  }

  // Draws a held weapon for any human (player or NPC) using the combat_anims sprites.
  drawWeapon(ctx, ent, item, recoil, flash) {
    const a = this.atlas.combat;
    const base = norm(item.name);
    const key = this.weaponAnimCache = this.weaponAnimCache || new Map();
    let found = key.get(item.name);
    if (found === undefined) {
      found = null;
      for (const k of a.anims.keys()) {
        const [b, anim, dir] = k.split('|');
        if (norm(b) === base && !/^sd/.test(anim) && dir === 'e') { found = a.anims.get(k); break; }
      }
      key.set(item.name, found);
    }
    const faceLeft = Math.cos(ent.aim) < 0;
    if (!found) {
      ctx.save();
      ctx.translate(ent.x, ent.y - 11);
      ctx.rotate(ent.aim);
      if (faceLeft) ctx.scale(1, -1);
      this.data.drawIcon(ctx, item.name, 2, -8, 16);
      ctx.restore();
      return;
    }
    a.draw(ctx, recoil && found.length > 1 ? found[1].f : found[0].f, ent.x, ent.y, faceLeft);
    if (flash) {
      const mx = ent.x + Math.cos(ent.aim) * 16, my = ent.y - 11 + Math.sin(ent.aim) * 16;
      ctx.fillStyle = 'rgba(255,230,140,0.9)';
      ctx.beginPath(); ctx.arc(mx, my, 2.5, 0, 7); ctx.fill();
    }
  }

  drawPickup(ctx, p) {
    const bob = Math.sin(this.time * 3 + p.bob) * 1.5;
    if (p.tile && !p.item) { this.map.drawTile(ctx, p.tile, p.x - 16, p.y - 16 + bob); return; }
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 7, 7, 2.5, 0, 0, 7); ctx.fill();
    if (p.tile) { this.map.drawTile(ctx, p.tile, p.x - 16, p.y - 16 + bob); return; }
    if (!this.data.drawIcon(ctx, p.name, p.x - 12, p.y - 12 + bob, 24)) {
      const f = this.atlas.combat.frames['item-box_default_x_0'];
      if (f) this.atlas.combat.drawCentered(ctx, f, p.x, p.y + bob);
      else { ctx.fillStyle = '#c9a227'; ctx.fillRect(p.x - 4, p.y - 4 + bob, 8, 8); }
    }
  }

  drawOverheads(ctx) {
    const pl = this.player;
    ctx.font = '7px Bebas, sans-serif';
    ctx.textAlign = 'center';
    const bubble = (e) => {
      if (!e.bark) return;
      ctx.font = '7px Bebas, sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const w = ctx.measureText(e.bark.text).width + 6;
      ctx.fillRect(e.x - w / 2, e.y - 52, w, 10);
      ctx.fillStyle = '#fff';
      ctx.fillText(e.bark.text, e.x, e.y - 44);
    };
    bubble(pl);
    for (const n of this.npcs) {
      if (n.dead) continue;
      bubble(n);
      ctx.font = '6px Bebas, sans-serif';
      ctx.fillStyle = !n.alive ? '#ff8b6b' : n.kind === 'soldier' ? (n.mode === 'follow' ? '#9cff9c' : '#cfe8cf') : n.mode === 'idle' ? '#ffd36b' : '#9cd4ff';
      ctx.fillText(!n.alive ? `${n.name} — DOWN ${Math.ceil(n.downT)}s` : n.name, n.x, n.y - 34);
      if (n.alive && n.hp < n.maxHp) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(n.x - 8, n.y - 32, 16, 2);
        ctx.fillStyle = '#5fd35f'; ctx.fillRect(n.x - 8, n.y - 32, 16 * n.hp / n.maxHp, 2);
      }
    }
    ctx.font = '7px Bebas, sans-serif';
    for (const m of this.mobs) {
      if (!m.alive || m.hp >= m.maxHp) continue;
      const bw = m.boss ? 40 : 14;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(m.x - bw / 2, m.y - (m.boss ? 52 : 30), bw, 2);
      ctx.fillStyle = m.boss ? '#ff3b3b' : '#d94a3a';
      ctx.fillRect(m.x - bw / 2, m.y - (m.boss ? 52 : 30), bw * Math.max(0, m.hp / m.maxHp), 2);
    }
    const it = this.nearestInteractable();
    if (it && pl.alive) {
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      const label = '[E] ' + it.label;
      const w = ctx.measureText(label).width + 8;
      ctx.fillRect(pl.x - w / 2, pl.y + 4, w, 10);
      ctx.fillStyle = '#ffd36b';
      ctx.fillText(label, pl.x, pl.y + 12);
    }
    ctx.textAlign = 'left';
  }

  renderLighting(ctx, zoom, camX, camY) {
    const cv = this.canvas, L = this.light;
    if (L.width !== cv.width || L.height !== cv.height) { L.width = cv.width; L.height = cv.height; }
    const lc = L.getContext('2d');
    lc.globalCompositeOperation = 'source-over';
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, L.width, L.height);
    lc.fillStyle = `rgba(4,6,14,${this.opts.lobby ? 0.3 : AMBIENT_DARK * (this.ambientScale ?? 1)})`;
    lc.fillRect(0, 0, L.width, L.height);
    lc.globalCompositeOperation = 'destination-out';
    lc.setTransform(zoom, 0, 0, zoom, -camX * zoom, -camY * zoom);
    const pats = this.assets.tables.lightpats;
    const hole = (x, y, r, a) => {
      const g = lc.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(0,0,0,${a})`);
      g.addColorStop(0.55, `rgba(0,0,0,${a * 0.55})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lc.fillStyle = g;
      lc.beginPath(); lc.arc(x, y, r, 0, 7); lc.fill();
    };
    const vw = this.cam.vw, vh = this.cam.vh;
    for (const l of this.map.lights) {
      if (l.x < camX - l.radius || l.x > camX + vw + l.radius || l.y < camY - l.radius || l.y > camY + vh + l.radius) continue;
      let k = 1;
      const pat = pats[l.pattern];
      if (pat && pat.length) { const v = pat[((Math.floor(this.time * 12 + l.phase * 7) % pat.length) + pat.length) % pat.length] / 255; k = Number.isFinite(v) ? v : 1; }
      hole(l.x, l.y, l.radius * (0.85 + 0.15 * k), 0.75 * (0.5 + 0.5 * k));
    }
    const pl = this.player;
    hole(pl.x, pl.y - 10, 70, 0.75);
    if (this.flashlight && pl.alive) {
      const len = 300, spread = 0.42, ox = pl.x, oy = pl.y - 11;
      const g = lc.createRadialGradient(ox, oy, 10, ox, oy, len);
      g.addColorStop(0, 'rgba(0,0,0,0.95)');
      g.addColorStop(0.6, 'rgba(0,0,0,0.7)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lc.fillStyle = g;
      lc.beginPath();
      lc.moveTo(ox, oy);
      lc.arc(ox, oy, len, pl.aim - spread, pl.aim + spread);
      lc.closePath();
      lc.fill();
    }
    if (this.muzzle > 0) hole(pl.x + Math.cos(pl.aim) * 16, pl.y - 11 + Math.sin(pl.aim) * 16, 110, 0.6);
    for (const t of this.tempLights) hole(t.x, t.y, t.r, Math.min(1, t.t / t.max));
    if (this.ext) this.ext.lights(hole);
    for (const p of this.projectiles.list) if (p.flame || p.explode) hole(p.x, p.y, 40, 0.5);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(L, 0, 0);
    if (pl.hurtT > 0 || pl.hp < pl.maxHp * 0.25) {
      const a = pl.hurtT > 0 ? 0.35 : 0.12 + 0.08 * Math.sin(this.time * 6);
      const g = ctx.createRadialGradient(cv.width / 2, cv.height / 2, cv.height * 0.3, cv.width / 2, cv.height / 2, cv.height * 0.8);
      g.addColorStop(0, 'rgba(120,0,0,0)');
      g.addColorStop(1, `rgba(140,0,0,${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
  }

  // Bank balance (what you can spend) and, on a map, what this run will pay out.
  moneyText() {
    const bank = this.profile ? this.profile.coins : 0;
    return this.opts.lobby || this.ghost ? `${bank}c` : `${bank}c  +${this.earnings.total}`;
  }

  // Where the minimap goes (null when hidden). The HUD lays itself out around it.
  miniLayout(W, H) {
    const inp = this.input, map = this.map;
    if (!map || (inp && inp.settings.minimap === false)) return null;
    const touch = !!(inp && inp.touchUI && inp.lastDevice === 'touch'), portrait = touch && H > W;
    if (touch && this.opts.lobby) return null; // phones: the base is small, the round card takes the top
    const u = hudScale(W, H, touch);
    const M = Math.round(10 * u);
    // box hugs the map's shape inside the max size, so no space is wasted
    const maxW = Math.min((touch ? 130 : 170) * u, W * 0.24), maxH = Math.min((touch ? 96 : 120) * u, H * 0.3);
    const k = Math.min((maxW - 6 * u) / map.pw, (maxH - 6 * u) / map.ph);
    const bw = Math.max(60 * u, map.pw * k + 6 * u), bh = map.ph * k + 6 * u;
    let bx, by;
    if (portrait) { bx = W - M - bw; by = M + 52 * u; }
    else if (touch) { bx = W / 2 - bw / 2; by = M; }
    else { bx = W - M - bw; by = M + 4; }
    return { x: bx, y: by, w: bw, h: bh, u };
  }

  // Minimap: the whole floor, you (white arrow), teammates (blue, red when down), nearby zeds (red).
  drawMinimap(ctx, W, H) {
    const map = this.map, box = this.miniLayout(W, H);
    this.miniBox = box;
    if (!box) return;
    const { x: bx, y: by, w: bw, h: bh, u } = box, k = Math.min((bw - 6 * u) / map.pw, (bh - 6 * u) / map.ph);
    if (!map._mini) {
      // small cached copy of the floor (drawn once per floor)
      const s = Math.min(1, 320 / Math.max(map.pw, map.ph)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(map.pw * s)); c.height = Math.max(1, Math.round(map.ph * s));
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = true;
      x.drawImage(map.bot, 0, 0, c.width, c.height);
      x.drawImage(map.top, 0, 0, c.width, c.height);
      map._mini = c;
    }
    const dw = map.pw * k, dh = map.ph * k, ox = bx + (bw - dw) / 2, oy = by + (bh - dh) / 2;
    const X = (x) => ox + x * k, Y = (y) => oy + y * k;
    ctx.fillStyle = 'rgba(8,10,14,0.78)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    ctx.globalAlpha = 0.75; ctx.drawImage(map._mini, ox, oy, dw, dh); ctx.globalAlpha = 1;
    ctx.save(); ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
    if (this.cam) { ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.strokeRect(X(this.cam.x), Y(this.cam.y), this.cam.vw * k, this.cam.vh * k); }
    const pl = this.player, me = this.ghost ? this.spec : pl, dot = (x, y, r, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(X(x), Y(y), r, 0, 7); ctx.fill(); };
    for (const m of this.mobs) if (m.alive && Math.hypot(m.x - me.x, m.y - me.y) < 520) dot(m.x, m.y, (m.boss ? 2.6 : 1.3) * u, m.elite ? '#ff9a3a' : '#ff3b3b');
    for (const n of [...(this.npcs || []), ...(this.npcMirror || [])]) if (n.alive && !n.dead) dot(n.x, n.y, 1.5 * u, '#9cff9c');
    if (this.ext && this.ext.heli) { const h = this.ext.heli; dot(h.tx ?? h.x, h.ty ?? h.y, 3 * u, '#ffd36b'); }
    if (this.ext && this.ext.siege && this.ext.siege.ready) { const sg = this.ext.siege; dot(sg.zones.anchor.x, sg.zones.anchor.y, 3 * u, '#ffd36b'); for (const p of sg.piles) dot(p.x, p.y, 1.4 * u, '#c8a45a'); }
    if (this.ext && this.ext.deployDoors) for (const d of this.ext.deployDoors) dot(d.x + 16, d.y + 16, 2 * u, '#7dff8a');
    // teammates: big blue dots with their initial, red when down
    if (this.avatars) {
      ctx.font = `${Math.round(8 * u)}px Bebas, sans-serif`; ctx.textAlign = 'center';
      for (const a of this.avatars.values()) {
        if (!a.visible || !a.alive) continue;
        const c = a.down ? (Math.floor(this.time * 4) % 2 ? '#ff3b3b' : '#ffffff') : '#4fc3ff';
        ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(X(a.x), Y(a.y), 3.2 * u, 0, 7); ctx.stroke();
        dot(a.x, a.y, 3.2 * u, c);
        ctx.fillStyle = '#fff'; ctx.fillText((a.name || '?')[0].toUpperCase(), X(a.x), Y(a.y) - 4.5 * u);
      }
      ctx.textAlign = 'left';
    }
    // you: an arrow pointing where you aim
    if (!this.ghost && pl.alive) {
      const a = pl.aim || 0, x = X(pl.x), y = Y(pl.y), r = 4.2 * u;
      ctx.fillStyle = pl.down ? '#ff3b3b' : '#ffffff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      ctx.lineTo(x + Math.cos(a + 2.5) * r * 0.8, y + Math.sin(a + 2.5) * r * 0.8);
      ctx.lineTo(x + Math.cos(a - 2.5) * r * 0.8, y + Math.sin(a - 2.5) * r * 0.8);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    if (this.floorCount > 1) { ctx.font = `${Math.round(10 * u)}px Bebas, sans-serif`; ctx.fillStyle = '#9cd4ff'; ctx.fillText(`FLOOR ${this.z + 1}/${this.floorCount}`, bx + 4 * u, by + bh - 4 * u); }
  }

  drawHud(ctx, W, H) {
    const pl = this.player, A = this.atlas.combat, inp = this.input;
    const touch = !!(inp && inp.touchUI && inp.lastDevice === 'touch');
    const u = hudScale(W, H, touch);
    ctx.imageSmoothingEnabled = false;
    ctx.textBaseline = 'alphabetic';
    const panel = (x, y, w, h) => { ctx.fillStyle = 'rgba(8,10,14,0.72)'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); };
    const text = (s, x, y, size, color = '#eee', align = 'left') => { ctx.font = `${size}px Bebas, Impact, sans-serif`; ctx.textAlign = align; ctx.fillStyle = color; ctx.fillText(s, x, y); };
    const hint = (id) => { const h = inp ? inp.hint(id) : ''; return h ? ` [${h}]` : ''; };
    const M = 10 * u + 4;

    // vitals: bottom-left on desktop, top-left on touch
    const vw = 230 * u, vh = 70 * u;
    const vx = M, vy = touch ? M : H - M - vh;
    panel(vx, vy, vw, vh);
    const state = !pl.alive ? 'down' : pl.infection ? 'poison' : pl.hp > pl.maxHp * 0.66 ? 'fine' : pl.hp > pl.maxHp * 0.33 ? 'caution' : 'danger';
    const vit = A.find('vitals', [state], ['x']);
    if (vit) {
      const f = Atlas.frameAt(vit.list, this.time * 1000);
      A.drawCentered(ctx, f, vx + 36 * u, vy + 35 * u, (58 * u) / Math.max(f[6], f[7]));
    }
    const bx = vx + 72 * u, bw = 148 * u;
    const bar = (y, frac, c1, label) => {
      ctx.fillStyle = '#1b1d22'; ctx.fillRect(bx, y, bw, 10 * u);
      ctx.fillStyle = c1; ctx.fillRect(bx, y, bw * Math.max(0, Math.min(1, frac)), 10 * u);
      text(label, bx + 4 * u, y + 9 * u, 10 * u, '#fff');
    };
    bar(vy + 8 * u, pl.hp / pl.maxHp, pl.infection ? '#6fae2e' : '#c0392b', `HP ${Math.ceil(pl.hp)} / ${pl.maxHp}`);
    bar(vy + 22 * u, pl.stamina / 100, pl.tired ? '#7a6a3a' : '#d4b44a', pl.tired ? 'TIRED' : 'STAMINA');
    ctx.fillStyle = '#1b1d22'; ctx.fillRect(bx, vy + 36 * u, bw, 6 * u);
    ctx.fillStyle = this.frenzyT > 0 ? '#ff4bd1' : '#b04bff';
    ctx.fillRect(bx, vy + 36 * u, bw * (this.frenzyT > 0 ? this.frenzyT / 15 : this.frenzy / 25), 6 * u);
    const st = [];
    if (pl.infection) st.push(`INFECTED x${pl.infection}`);
    if (this.bleed > 0) st.push('BLEEDING');
    if (this.webbed > 0) st.push('WEBBED');
    const frenzyLabel = this.frenzyT > 0 ? 'FRENZY!' : this.frenzy >= 25 ? 'FRENZY READY' + hint('frenzy') : '';
    text(st.join('  ') || frenzyLabel || `${this.opts.cls ? this.opts.cls.toUpperCase() + ' · ' : ''}${state.toUpperCase()}`, bx, vy + 58 * u, 13 * u, st.length ? '#ff9b6b' : frenzyLabel ? '#ff8bf0' : '#8fd18f');

    // weapon slots: bottom-right on desktop, top-right (tappable) on touch
    const NS = this.slots.length;
    const sw = (touch ? 44 : 54) * u * Math.min(1, 4 / NS), sh = (touch ? 36 : 44) * u, gap = 6 * u;
    const aw = Math.max(sw * NS + gap * (NS - 1), 230 * u);
    const portrait = touch && H > W;
    const sx0 = portrait ? M : W - M - aw - (touch ? 56 * u : 0), sy0 = portrait ? M + 70 * u + 30 * u : touch ? M : H - M - 100 * u;
    this.slotRects = [];
    for (let i = 0; i < NS; i++) {
      const s = this.slots[i], x = sx0 + i * (sw + gap);
      this.slotRects.push({ x: x + sw / 2, y: sy0 + sh / 2, r: sw / 2 });
      panel(x, sy0, sw, sh);
      if (i === this.cur) { ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, sy0 + 1, sw - 2, sh - 2); ctx.lineWidth = 1; }
      if (!touch) text(String(i + 1), x + 4 * u, sy0 + 11 * u, 10 * u, '#888');
      if (s) {
        const is = Math.min(sw, sh) - 8 * u;
        this.data.drawIcon(ctx, s.item.name, x + sw / 2 - is / 2, sy0 + (sh - is) / 2, is);
      }
    }
    const s = this.slots[this.cur];
    const ay = sy0 + sh + 4 * u;
    panel(sx0, ay, aw, 22 * u);
    if (s) {
      text(s.item.name, sx0 + 6 * u, ay + 16 * u, 14 * u, '#ffd36b');
      if (s.isGun) {
        const pool = this.ammo.get(s.ammoKind) || 0;
        text(this.reload ? 'RELOADING…' : `${s.mag} / ${pool}`, sx0 + aw - 6 * u, ay + 16 * u, 15 * u, s.mag ? '#fff' : '#ff6b6b', 'right');
        if (this.reload) { ctx.fillStyle = '#ffd36b'; ctx.fillRect(sx0, ay + 20 * u, aw * (this.reload.t / this.reload.dur), 2 * u); }
      } else if (s.isMelee) text('MELEE', sx0 + aw - 6 * u, ay + 16 * u, 14 * u, '#ccc', 'right');
    }
    // ammo slots + throwables pouch
    const by = ay + 26 * u, slotsN = this.ammo.n, abw = (aw - 70 * u - gap * (slotsN - 1)) / slotsN;
    for (let i = 0; i < slotsN; i++) {
      const a = this.ammo.slots[i], x = sx0 + i * (abw + gap);
      panel(x, by, abw, 24 * u);
      if (!a) { text('EMPTY', x + abw / 2, by + 16 * u, 10 * u, '#555', 'center'); continue; }
      const cap = this.ammo.cap(a.kind), inUse = s && s.isGun && s.ammoKind === a.kind;
      ctx.fillStyle = inUse ? 'rgba(255,211,107,0.35)' : 'rgba(255,255,255,0.12)';
      ctx.fillRect(x + 1, by + 20 * u, (abw - 2) * (a.count / cap), 3 * u);
      this.data.drawIcon(ctx, this.data.names.get(a.kind) || '', x + 2 * u, by + 2 * u, 18 * u);
      text(String(a.count), x + abw - 4 * u, by + 15 * u, 12 * u, inUse ? '#ffd36b' : '#ccc', 'right');
    }
    const tx = sx0 + aw - 64 * u;
    panel(tx, by, 64 * u, 24 * u);
    const tsel = this.throwables.sel, tn = tsel ? this.throwables.counts.get(tsel) || 0 : 0;
    if (tsel) this.data.drawIcon(ctx, tsel, tx + 2 * u, by + 2 * u, 20 * u);
    text(tsel ? '×' + tn : 'NONE', tx + 60 * u, by + 16 * u, 13 * u, tn ? '#fff' : '#777', 'right');
    if (!touch) text(hint('toggleThrowable'), tx + 32 * u, by - 2 * u, 9 * u, '#777', 'center');

    // survival stats: top-left on desktop, under vitals on touch
    const mm = Math.floor(this.time / 60), ss = Math.floor(this.time % 60);
    const clock = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    const alive = this.mobs.filter((m) => m.alive).length;
    let msgY;
    const lobby = !!this.opts.lobby;
    if (touch) {
      panel(vx, vy + vh + 4 * u, vw, 20 * u);
      text(lobby ? `THE BASE   ${this.moneyText()}` : `${clock}   KILLS ${this.kills}   ${this.moneyText()}   ZEDS ${alive}${this.floorCount > 1 ? `   FLOOR ${this.z + 1}/${this.floorCount}` : ''}`, vx + 6 * u, vy + vh + 19 * u, 13 * u, '#ddd');
      msgY = portrait ? sy0 + sh + 70 * u : vy + vh + 42 * u;
    } else {
      panel(M, M, 200 * u, 50 * u);
      const coin = A.find('coin', ['default'], ['x']);
      if (coin) A.drawCentered(ctx, coin.list[0].f, M + 16, M + 37 * u, 0.5 * u);
      text(this.moneyText(), M + 8 + 18 * u, M + 42 * u, 15 * u, '#ffd36b');
      if (lobby) text('THE BASE', M + 8, M + 22 * u, 20 * u, '#fff');
      else {
        text(clock, M + 8, M + 22 * u, 22 * u, '#fff');
        text(`KILLS ${this.kills}`, M + 8 + 70 * u, M + 22 * u, 15 * u, '#ff9b6b');
        text(`ZEDS NEAR ${alive}${this.floorCount > 1 ? `  ·  FLOOR ${this.z + 1}/${this.floorCount}` : ''}`, M + 8 + 96 * u, M + 42 * u, 12 * u, '#aaa');
      }
      msgY = M + 92 * u;
    }

    const mini = this.miniLayout(W, H);
    // lobby: the next-round card in the free band at the top (below the weapon panel on portrait)
    if (this.ext && this.ext.drawCard) {
      let x0, x1, y;
      if (portrait) { x0 = M; x1 = W - M; y = sy0 + sh + 60 * u; }
      else if (touch) { x0 = vx + vw + 8 * u; x1 = sx0 - 8 * u; y = M; }
      else { x0 = M + 210 * u; x1 = (mini ? mini.x : W - M) - 10 * u; y = M; }
      const ch = this.ext.drawCard(ctx, (x0 + x1) / 2, y, x1 - x0, u);
      this.cardBox = { y, h: ch, full: portrait };
      if (portrait) msgY = Math.max(msgY, y + ch + 18 * u + (this.coop ? (this.coop.players.size + 1) * 14 * u + 12 * u : 0)); // below the party list too
    }

    // messages
    for (const m of this.messages) {
      ctx.globalAlpha = Math.min(1, m.t);
      ctx.font = `${14 * u}px Bebas, Impact, sans-serif`;
      const room = (mini && mini.x > W / 2 && msgY < mini.y + mini.h + 50 * u ? mini.x - 8 * u : W - M) - M - 4;
      const fit = Math.min(1, room / Math.max(1, ctx.measureText(m.text).width)); // long lines shrink to fit beside the minimap
      text(m.text, M + 4, msgY, 14 * u * fit, m.color);
      msgY += 16 * u;
    }
    ctx.globalAlpha = 1;

    if (touch) { this.drawTouchControls(ctx, W, H); return; }

    // device-aware control hints
    const hints = inp && inp.lastDevice === 'pad'
      ? `${inp.padName || 'Controller'}: L-stick move · R-stick aim · ${inp.hint(this.legacy ? 'fire' : 'fire')} ${this.legacy ? 'auto-fire' : 'fire'} · ${inp.hint('grenade')} grenade · ${inp.hint('reload')} reload · ${inp.hint('interact')} use · ${inp.hint('heal')} heal · ${inp.hint('nextWeapon')} swap · ${inp.hint('pause')} pause`
      : `${['up', 'left', 'down', 'right'].map((a) => inp ? inp.hint(a) : '').join('')} move · ${inp ? inp.hint('fire') : 'LMB'} attack${this.legacy ? ` · ${inp.hint('autofire')} legacy auto-fire` : ''} · ${inp ? inp.hint('grenade') : 'G'} grenade · ${inp ? inp.hint('reload') : 'R'} reload · ${inp ? inp.hint('interact') : 'E'} use · ${inp ? inp.hint('heal') : 'H'} heal · ${inp ? inp.hint('inventory') : 'Tab'} items · ${inp ? inp.hint('shop') : 'B'} upgrades · ${inp ? inp.hint('pause') : 'Esc'} menu`;
    if (this.opts.lobby || this.time < 20) text(hints, W / 2, H - 6, 11 * u, 'rgba(255,255,255,0.4)', 'center');

    // cursor / stick reticle
    if (!inp || inp.aimSource === 'mouse') {
      const cur = A.frames['cursor-shoot_default_x_0'];
      const mx = inp ? inp.mouse.x : this.mouse.x, my = inp ? inp.mouse.y : this.mouse.y;
      if (cur) A.drawCentered(ctx, cur, mx, my, (u * 24) / Math.max(cur[6], cur[7]));
    } else if (inp.aimMag > 0 && this.cam) {
      const x = (this.mouse.wx - this.cam.x) * this.zoom, y = (this.mouse.wy - this.cam.y) * this.zoom;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 7 * u, 0, 7); ctx.stroke();
    }
  }

  drawTouchControls(ctx, W, H) {
    const inp = this.input;
    const s = this.slots[this.cur], pl = this.player;
    const target = this.ghost ? null : this.nearestInteractable();
    const healItems = ['Herb-G', 'Herb-GG', 'Herb-GGG', 'Herb-RG', 'Herb-RGB', 'Herb-BG', 'Herb-B', 'F.-Aid-Spray', 'Med-Kit', 'Bandage', 'Antibiotics'];
    const tsel = this.throwables.sel;
    const L = inp.layoutTouch(W, H, this.legacy, {
      frenzyReady: this.frenzy >= 25 && this.frenzyT <= 0,
      canReload: !!(s && s.isGun && !this.reload && s.mag < s.stat('max-mag') && this.ammo.get(s.ammoKind) > 0),
      useLabel: target ? (target.type === 'pickup' ? 'TAKE' : target.type === 'door' ? 'DOOR' : 'USE') : null,
      canHeal: pl.hp < pl.maxHp * 0.7 && healItems.some((n) => this.items.get(n) > 0),
      lowHp: pl.hp < pl.maxHp * 0.3,
      throwLabel: tsel ? (/mine/i.test(tsel) ? 'MINE' : /molotov/i.test(tsel) ? 'MOLO' : 'NADE') : 'NADE',
      throwCount: tsel ? this.throwables.counts.get(tsel) || 0 : 0,
      inLobby: !!this.opts.lobby,
    });
    // weapon slots are tappable too
    for (let i = 0; i < this.slotRects.length; i++) if (this.slotRects[i]) L.buttons.push({ id: 'slot' + (i + 1), label: '', ...this.slotRects[i], hidden: true });
    const op = inp.settings.touchOpacity;
    const circle = (x, y, r, fill, stroke) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7);
      ctx.fillStyle = fill; ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
    };
    ctx.save();
    ctx.globalAlpha = op;
    // sticks
    const drawStick = (st, home, label) => {
      const ox = st ? st.ox : home.x, oy = st ? st.oy : home.y;
      circle(ox, oy, L.stickR, 'rgba(20,24,30,0.55)', 'rgba(255,255,255,0.35)');
      const v = st ? inp.stickVec(st) : { x: 0, y: 0 };
      circle(ox + v.x * L.stickR, oy + v.y * L.stickR, L.stickR * 0.42, 'rgba(255,255,255,0.45)');
      if (!st) { ctx.font = `${Math.round(11 * L.u)}px Bebas, sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.fillText(label, ox, oy + L.stickR + 14 * L.u); }
    };
    drawStick(inp.touch.move, L.moveHome, 'MOVE');
    if (!L.legacy) drawStick(inp.touch.aim, L.aimHome, 'AIM + FIRE');
    for (const b of L.buttons) {
      if (b.hidden) continue;
      const on = inp.touch.vis.has(b.id) || inp.touch.buttons.has(b.id);
      const pulse = b.accent === 'pulse' ? 0.5 + 0.5 * Math.sin(this.time * 8) : 0;
      const accent = b.id === 'fire' ? (this.lockTarget ? 'rgba(200,40,30,0.85)' : 'rgba(110,40,30,0.7)')
        : b.accent === 'frenzy' ? 'rgba(170,60,200,0.8)' : b.accent === 'use' ? 'rgba(40,110,60,0.85)'
          : b.accent === 'pulse' ? `rgba(${150 + 80 * pulse},40,40,0.85)` : b.menuItem ? 'rgba(30,34,44,0.92)' : 'rgba(20,24,30,0.7)';
      if (b.menuItem) ctx.globalAlpha = 1;
      circle(b.x, b.y, b.r, on ? 'rgba(255,211,107,0.8)' : accent, 'rgba(255,255,255,0.4)');
      ctx.font = `${Math.round(b.r * (b.label.length > 4 ? 0.4 : 0.6))}px Bebas, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = on ? '#000' : '#fff';
      ctx.fillText(b.id === 'flashlight' ? (this.flashlight ? 'LIGHT' : 'DARK') : b.label, b.x, b.y + b.r * 0.2);
      if (b.sub !== undefined) { ctx.font = `${Math.round(b.r * 0.38)}px Bebas, sans-serif`; ctx.fillStyle = '#ffd36b'; ctx.fillText('×' + b.sub, b.x + b.r * 0.75, b.y - b.r * 0.6); }
      if (b.menuItem) ctx.globalAlpha = op;
    }
    ctx.restore();
    ctx.textAlign = 'left';
  }
}
