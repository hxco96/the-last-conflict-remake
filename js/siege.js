// SIEGE: a persistent, stand-alone campaign mode.
// You hold a fortified building on the map. Each DAY you scavenge scrap, spend it at the workbench
// (barricades, barracks, armory, field hospital, floodlights) and greet the survivors who drift in and
// out of your camp. At DUSK a siren sounds and the horde's size and direction are announced; the NIGHT
// is a real stand-off, wave after wave pressing on the walls while your defenders hold their posts.
// Survive to DAWN and the next night is bigger. The campaign (night number, scrap, upgrades and the
// roster of recurring defenders) is saved per map in localStorage; dying costs scrap and you retry the
// same night. Infected never spawn inside buildings: they come from the outdoor edges only.
import { T } from './map.js';
import { cellOf } from './actors.js';
import { NPC, randomLook } from './npc.js';
import { play, sample, music, siren } from './sfx.js';

const STORE = 'tlcr-siege-v1';
export const DAY_LEN = 150, FIRST_DAY_BONUS = 60, DUSK_LEN = 20;
const FRONTS = [
  { name: 'NORTH', x: 0, y: -1 }, { name: 'EAST', x: 1, y: 0 }, { name: 'SOUTH', x: 0, y: 1 }, { name: 'WEST', x: -1, y: 0 },
];
export const UPGRADES = {
  walls: { name: 'Reinforced barricades', max: 5, cost: [40, 80, 140, 220, 320], desc: (l) => `Barricades and boarded windows +${50 * l}% HP; the crew rebuilds them every dawn` },
  barracks: { name: 'Barracks', max: 4, cost: [50, 100, 180, 280], desc: (l) => `${2 + l} defender slots; survivors return more often and leave less` },
  armory: { name: 'Armory', max: 4, cost: [60, 120, 200, 300], desc: (l) => `Better guns for new defenders; +${4 + 2 * l} boards and extra supplies each dawn` },
  medic: { name: 'Field hospital', max: 3, cost: [50, 110, 190], desc: (l) => `Heal ${(1.5 * l).toFixed(1)} HP/s inside the base; downed defenders last ${12 * l}s longer` },
  lights: { name: 'Floodlights', max: 3, cost: [40, 90, 160], desc: (l) => `Lights the walls at night (radius ${90 + 30 * l})` },
};
const GUNS = [['Beretta92', 'Police-Handgun', 'UMP45'], ['MP5', 'SA80', 'Spas-12'], ['AK-47', 'M16', 'M4A1-Carbine'], ['M4A1-Carbine', 'AK-47', 'Spas-12']];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---------- campaign save ----------
const fresh = () => ({ night: 1, scrap: 60, boards: 6, up: { walls: 0, barracks: 0, armory: 0, medic: 0, lights: 0 }, vets: [], best: 1, kills: 0, runs: 0, deaths: 0 });
function readAll() { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } }
export function loadCampaign(map) { const c = readAll()[map]; return c ? { ...fresh(), ...c, up: { ...fresh().up, ...c.up } } : fresh(); }
export function saveCampaign(map, c) { try { const all = readAll(); all[map] = c; localStorage.setItem(STORE, JSON.stringify(all)); } catch { /* storage unavailable */ } }
export function resetCampaign(map) { try { const all = readAll(); delete all[map]; localStorage.setItem(STORE, JSON.stringify(all)); } catch { /* storage unavailable */ } }
// one-liner for the mission board
export function campaignLine(map) {
  const c = readAll()[map];
  return c ? `Campaign: night ${c.night} · best ${c.best} · ${c.scrap} scrap — your base waits` : 'New campaign: hold a fortified base night after night; progress is saved';
}

// ---------- map analysis ----------
// Walls for this purpose are everything that can seal a room: solid tiles plus every door/barricade.
// "Outdoors" is whatever the map border can reach; sealed interiors are buildings, and the biggest
// one next to the player spawn becomes the base.
function analyze(g) {
  const map = g.map, W = map.w, H = map.h, n = W * H;
  const wall = (x, y) => { if (!map.inBounds(x, y)) return true; const i = y * W + x; return !!(map.solid[i] || map.dyn[i]); };
  const outdoor = new Uint8Array(n), q = [];
  const push = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = y * W + x; if (outdoor[i] || wall(x, y)) return; outdoor[i] = 1; q.push(i); };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  for (const r of map.markers.MobSpawn || []) for (const [cx, cy] of map.walkableCellsIn(r)) push(cx, cy);
  while (q.length) { const i = q.pop(), x = i % W, y = (i / W) | 0; push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1); }
  // interior components
  const comp = new Int32Array(n).fill(-1), comps = [];
  for (let s = 0; s < n; s++) {
    const sx = s % W, sy = (s / W) | 0;
    if (comp[s] !== -1 || outdoor[s] || wall(sx, sy)) continue;
    const cells = [], st = [s]; comp[s] = comps.length;
    while (st.length) {
      const i = st.pop(); cells.push(i);
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (!map.inBounds(nx, ny)) continue;
        const j = ny * W + nx;
        if (comp[j] !== -1 || outdoor[j] || wall(nx, ny)) continue;
        comp[j] = comps.length; st.push(j);
      }
    }
    comps.push(cells);
  }
  // spawn point of the player picks the base
  const ps = (map.markers.PlayerSpawn || [])[0];
  const sp = ps ? { x: ps.x + ps.w / 2, y: ps.y + ps.h / 2 } : { x: map.pw / 2, y: map.ph / 2 };
  const scx = Math.floor(sp.x / T), scy = Math.floor(sp.y / T);
  let best = null, bd = 1e9;
  for (const cells of comps) {
    if (cells.length < 24) continue;
    let d = 1e9;
    for (let k = 0; k < cells.length; k += 3) { const i = cells[k]; d = Math.min(d, Math.hypot((i % W) - scx, ((i / W) | 0) - scy)); }
    d -= Math.min(20, cells.length / 40); // bigger buildings win ties
    if (d < bd) { bd = d; best = cells; }
  }
  let baseCells;
  if (best && bd < 60) baseCells = best.map((i) => [i % W, (i / W) | 0]);
  else {
    // open map: an improvised camp around the spawn
    baseCells = [];
    for (let y = scy - 6; y <= scy + 6; y++) for (let x = scx - 6; x <= scx + 6; x++) if (map.inBounds(x, y) && !map.blocking(x, y) && Math.hypot(x - scx, y - scy) <= 6.5) baseCells.push([x, y]);
  }
  const inBase = new Set(baseCells.map(([x, y]) => y * W + x));
  // anchor: base cell nearest the centroid
  let ax = 0, ay = 0;
  for (const [x, y] of baseCells) { ax += x; ay += y; }
  ax /= baseCells.length || 1; ay /= baseCells.length || 1;
  let anchor = baseCells[0] || [scx, scy], ad = 1e9;
  for (const c of baseCells) { const d = Math.hypot(c[0] - ax, c[1] - ay); if (d < ad) { ad = d; anchor = c; } }
  // openings: door/window/barricade cells touching both the base and the outdoors
  const openings = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (inBase.has(i) || !wall(x, y) && !map.breach[i]) continue;
    let inside = null, out = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!map.inBounds(nx, ny)) continue;
      const j = ny * W + nx;
      if (inBase.has(j)) inside = [nx, ny, dx, dy];
      else if (outdoor[j]) out = true;
    }
    if (inside && out && (map.dyn[i] || map.breach[i])) openings.push({ cx: x, cy: y, in: inside });
  }
  return { outdoor, inBase, baseCells, anchor: { x: anchor[0] * T + 16, y: anchor[1] * T + 24 }, openings, openBase: !(best && bd < 60), W };
}

export class Siege {
  constructor(g) {
    this.g = g;
    this.ready = false;
    this.phase = 'day';
    this.t = 0;
    this.piles = [];
    this.defenders = [];
    this.banner = null;
    this.wave = null;
    this.deadHandled = false;
    this.shop = null;
    this.stragT = 12;
    this.regenAcc = 0;
  }

  get mapName() { return this.g.opts.map.name; }
  get c() { return this.campaign; }

  // ---------- setup (needs the finished Game: dir, player, map) ----------
  init() {
    const g = this.g;
    this.ready = true;
    this.campaign = loadCampaign(this.mapName);
    this.campaign.runs++;
    this.zones = analyze(g);
    this.baseZ = g.z;
    g.dir.on = false; // the siege runs its own clock; keep Director for gore, streaks, elites and drops
    this.syncDirector();
    this.bolster();
    this.applyWalls(true);
    // put the player at the camp
    const pl = g.player;
    if (!g.coop && this.zones.baseCells.length) { pl.x = this.zones.anchor.x + 22; pl.y = this.zones.anchor.y; }
    const cur = g.items.get('Boards') || 0;
    g.items.set('Boards', Math.max(cur, this.c.boards));
    g.msg(`SIEGE — night ${this.c.night}. Prepare by day, hold the line by night.`, '#ffd36b');
    this.startDay(true);
  }

  syncDirector() {
    const d = this.g.dir, n = this.c.night;
    d.hordes = n - 1;
    d.fixedDmg = 1 + 0.07 * (n - 1);
  }

  // Add a barricade to every bare window of the base so night one is already holdable.
  bolster() {
    const map = this.g.map, tpl = map.cades.find((c) => c.type === 'Boarded');
    if (!tpl) return;
    for (const o of this.zones.openings) {
      const i = o.cy * map.w + o.cx;
      if (map.dyn[i] || !map.breach[i]) continue;
      map.addCade(tpl.r, 'Boarded', 0, o.cx * T, (o.cy + 1) * T - tpl.r.ts.th, o.cx, o.cy);
    }
    this.g.flowT = 0;
  }

  applyWalls(repair) {
    const k = 1 + 0.5 * this.c.up.walls;
    for (const c of this.g.map.cades) {
      c.baseMax = c.baseMax || c.maxHp;
      const was = c.maxHp;
      c.maxHp = Math.round(c.baseMax * k);
      if (repair) c.hp = c.maxHp; else if (c.hp > 0) c.hp = Math.min(c.maxHp, c.hp * (c.maxHp / was));
    }
    this.g.flowT = 0;
  }

  save() { saveCampaign(this.mapName, this.c); }
  inBase(x, y) { const [cx, cy] = cellOf({ x, y }); return this.zones.inBase.has(cy * this.zones.W + cx); }
  get slots() { return 2 + this.c.up.barracks; }

  // ---------- day ----------
  startDay(first = false) {
    const g = this.g;
    this.phase = 'day';
    this.t = DAY_LEN + (first && this.c.night === 1 ? FIRST_DAY_BONUS : 0);
    this.wave = null;
    g.ambientScale = 0.3;
    music('playlist', true);
    this.scatterPiles();
    this.arrivals();
    this.save();
    this.say(`DAY ${this.c.night}`, '#ffd36b', 'Scavenge scrap, visit the workbench, board the windows.');
  }

  scatterPiles() {
    const g = this.g, map = g.map, N = 12 + Math.min(14, this.c.night * 2);
    this.piles = [];
    const bc = this.zones.baseCells;
    for (let i = 0; i < N; i++) {
      // a third inside the base so the first steps of a day are free, the rest out in the open
      let p;
      if (i < N / 3 && bc.length) { const [cx, cy] = pick(bc); p = { x: cx * T + 16, y: cy * T + 20 }; }
      else p = map.randomWalkable();
      if (!p) continue;
      this.piles.push({ x: p.x, y: p.y, v: 3 + ((Math.random() * 6) | 0) + Math.floor(this.c.night / 2), boards: Math.random() < 0.2 });
    }
  }

  say(text, color, sub = '') { this.banner = { text, sub, color, t: 4.5 }; }

  // ---------- recurring survivors ----------
  arrivals() {
    const g = this.g, c = this.c, up = c.up;
    if (g.z !== this.baseZ) return;
    const back = Math.min(0.92, 0.55 + 0.04 * c.night + 0.05 * up.barracks);
    const here = () => this.defenders.length;
    for (const v of c.vets) {
      if (v.fallen || v.here || here() >= this.slots) continue;
      if (Math.random() < back) this.place(v, true);
    }
    // strangers asking for shelter
    let tries = Math.random() < 0.6 ? 2 : 1;
    while (tries-- > 0 && here() < this.slots && Math.random() < 0.8) {
      const kind = Math.random() < 0.28 ? 'survivor' : 'soldier';
      const look = randomLook(kind, g.atlas.core);
      const names = look.female ? g.assets.barks.names_f : g.assets.barks.names_m;
      const name = names && names.length ? names[Math.floor(Math.random() * Math.min(names.length, 200))] : kind;
      const lvl = Math.min(3, Math.floor((up.armory + c.night / 3) / 1.5));
      const v = { id: Date.now() + Math.random(), name, kind, look: { name, ...look }, nights: 0, gun: kind === 'soldier' ? pick(GUNS[lvl]) : null, fallen: false, here: false };
      c.vets.push(v);
      this.place(v, false);
    }
    if (c.vets.length > 40) c.vets = c.vets.filter((v) => !v.fallen).slice(-30);
  }

  postCells() {
    if (this._posts) return this._posts;
    const posts = [], z = this.zones;
    for (const o of z.openings) {
      const [ix, iy, dx, dy] = o.in;
      const c2 = [ix + dx, iy + dy]; // one step further in
      const use = this.g.map.blocking(c2[0], c2[1]) ? [ix, iy] : c2;
      if (posts.every((p) => Math.hypot(p[0] - use[0], p[1] - use[1]) >= 3)) posts.push(use);
    }
    if (posts.length < 3) for (let i = 0; i < 6; i++) { const c = pick(z.baseCells); posts.push(c); }
    return (this._posts = posts);
  }

  place(v, returning) {
    const g = this.g, posts = this.postCells();
    const used = new Set(this.defenders.map((d) => d.post));
    const free = posts.filter((_, i) => !used.has(i));
    const idx = free.length ? posts.indexOf(pick(free)) : (Math.random() * posts.length) | 0;
    const [px, py] = posts[idx];
    const x = px * T + 16, y = py * T + 22;
    const weapon = v.kind === 'soldier' ? g.data.item(v.gun) : null;
    const n = new NPC(x, y, v.kind, v.look, v.name, weapon);
    n.homeX = x; n.homeY = y;
    n.mode = 'post';
    n.vet = v;
    const hpK = 1 + 0.06 * Math.min(10, v.nights);
    n.maxHp = n.hp = Math.round(n.maxHp * hpK);
    g.npcs.push(n);
    this.defenders.push({ n, v, post: idx });
    v.here = true;
    g.fx.spawn('dust', x, y - 6, { scale: 1.4 });
    n.say(returning ? ["I'm back.", 'Miss me?', 'Still alive. Where do you want me?'] : ['Please, can I stay?', "I can shoot. Let me help.", 'We saw your lights.']);
    g.msg(returning ? `${v.name} returns to camp${v.nights ? ` (${v.nights} night${v.nights > 1 ? 's' : ''} survived)` : ''}` : `${v.name} asks to join the camp`, '#9cff9c');
  }

  updateDefenders(dt) {
    const g = this.g, med = this.c.up.medic;
    for (const d of [...this.defenders]) {
      const n = d.n;
      if (!n.alive && !n.medicApplied) { n.medicApplied = true; n.downT += 12 * med; }
      if (n.alive) n.medicApplied = false;
      if (n.dead) {
        d.v.fallen = true; d.v.here = false;
        this.defenders = this.defenders.filter((x) => x !== d);
        g.npcs = g.npcs.filter((x) => x !== n);
        g.msg(`${d.v.name} has fallen. They will not return.`, '#ff8b8b');
      } else if (n.alive && med && this.inBase(n.x, n.y)) n.hp = Math.min(n.maxHp, n.hp + 1.2 * med * dt);
    }
  }

  // ---------- phases ----------
  update(dt) {
    const g = this.g;
    if (g.ghost || !g.dir || !g.player) return; // spectating until you deploy
    if (!this.ready) this.init();
    if (g.isClient) return;
    const pl = g.player;
    if (this.banner) { this.banner.t -= dt; if (this.banner.t <= 0) this.banner = null; }
    if (!pl.alive) { if (!this.deadHandled) this.onDeath(); return; }
    this.updateDefenders(dt);
    this.collectPiles();
    // field hospital
    const med = this.c.up.medic;
    if (med && pl.hp < pl.maxHp && this.inBase(pl.x, pl.y)) { this.regenAcc += 1.5 * med * dt; if (this.regenAcc >= 1) { pl.hp = Math.min(pl.maxHp, pl.hp + 1); this.regenAcc -= 1; } }

    if (this.phase === 'day') {
      this.t -= dt;
      this.stragglers(dt);
      if (this.t <= 0) this.startDusk();
    } else if (this.phase === 'dusk') {
      this.t -= dt;
      g.ambientScale = 0.3 + 0.7 * (1 - Math.max(0, this.t) / DUSK_LEN);
      if (this.t <= 0) this.startNight();
    } else if (this.phase === 'night') this.updateNight(dt);
    else if (this.phase === 'dawn') {
      this.t -= dt;
      g.ambientScale = 1 - 0.7 * Math.min(1, (6 - this.t) / 6);
      if (this.t <= 0) this.startDay();
    }
  }

  collectPiles() {
    const g = this.g, pl = g.player;
    for (const p of this.piles) {
      if (Math.hypot(p.x - pl.x, p.y - (pl.y - 6)) > 15) continue;
      p.dead = true;
      if (p.boards) { g.items.set('Boards', Math.min(20, (g.items.get('Boards') || 0) + 1)); g.msg('+1 boards', '#d7b98a'); }
      else { this.c.scrap += p.v; g.msg(`+${p.v} scrap`, '#c8a45a'); }
      play.pickup();
    }
    this.piles = this.piles.filter((p) => !p.dead);
  }

  // a couple of slow wanderers by day so the open ground still has teeth
  stragglers(dt) {
    const g = this.g;
    this.stragT -= dt;
    if (this.stragT > 0) return;
    this.stragT = 18 + Math.random() * 14;
    const cap = Math.min(6, 2 + Math.floor(this.c.night / 2));
    if (g.mobs.filter((m) => m.alive).length >= cap) return;
    this.spawnMob(null);
  }

  startDusk() {
    const g = this.g;
    if (this.shop) this.closeShop();
    this.phase = 'dusk';
    this.t = DUSK_LEN;
    this.piles = [];
    this.plan = this.planNight();
    this.applyWalls(true);
    this.save();
    siren(DUSK_LEN);
    const p = this.plan;
    this.say(`NIGHT ${this.c.night} APPROACHES`, '#ff6b4b', `~${p.total} infected · ${p.waves.length} waves · first from the ${p.waves[0].fronts.map((f) => f.name).join(' & ')}`);
    g.msg(`⚠ Dusk. About ${p.total} infected are coming. To your posts!`, '#ff4b4b');
    for (const d of this.defenders) d.n.say(['Here they come.', 'Eyes up.', 'Hold the line.', 'Sun is going down…']);
  }

  planNight() {
    const g = this.g, n = this.c.night;
    const squad = 1;
    const total = Math.min(420, Math.round((12 + 8 * n) * g.density * (g.diff ? g.diff.spawn : 1) * squad));
    const count = Math.min(7, 3 + Math.floor(n / 3));
    const weights = Array.from({ length: count }, (_, i) => 1 + i * 0.6);
    const wsum = weights.reduce((a, b) => a + b, 0);
    const waves = weights.map((w, i) => {
      const sides = 1 + (n >= 3 ? 1 : 0) + (n >= 7 && i === count - 1 ? 1 : 0);
      const fronts = [...FRONTS].sort(() => Math.random() - 0.5).slice(0, sides);
      return { size: Math.max(4, Math.round((total * w) / wsum)), fronts };
    });
    return { total: waves.reduce((a, w) => a + w.size, 0), waves, boss: n % 5 === 0 };
  }

  startNight() {
    const g = this.g;
    this.phase = 'night';
    g.ambientScale = 1;
    this.c.boards = g.items.get('Boards') || 0;
    this.save();
    music('Seizure of Power', true);
    g.shake = Math.max(g.shake, 6);
    sample(['universfield-shock-scream-02-277551'], { vol: 0.5 });
    this.waveIdx = -1;
    this.nightT = 0;
    this.nightKills0 = g.kills;
    this.startWave();
  }

  startWave() {
    const g = this.g;
    this.waveIdx++;
    const w = this.plan.waves[this.waveIdx];
    this.wave = { ...w, left: w.size, t: 0, spawnT: 0.5, lull: 0, idx: this.waveIdx, done: false, front: 0 };
    const where = w.fronts.map((f) => f.name).join(' & ');
    const last = this.waveIdx === this.plan.waves.length - 1;
    this.say(`WAVE ${this.waveIdx + 1} / ${this.plan.waves.length}${last ? ' — FINAL' : ''}`, '#ff3b3b', `${w.size} infected from the ${where}`);
    g.msg(`Wave ${this.waveIdx + 1}: ${w.size} infected from the ${where}!`, '#ff4b4b');
  }

  updateNight(dt) {
    const g = this.g, w = this.wave;
    this.nightT += dt;
    for (const m of g.mobs) m.seen = true; // they all know where the light is
    const alive = g.mobs.filter((m) => m.alive).length;
    if (w && w.lull > 0) {
      w.lull -= dt;
      if (w.lull <= 0) this.startWave();
      return;
    }
    if (w.left > 0) {
      w.spawnT -= dt;
      const cap = Math.min(80, 14 + this.c.night * 3) * g.density;
      if (w.spawnT <= 0 && alive < cap) {
        w.spawnT = Math.max(0.25, 0.9 - this.c.night * 0.04) / Math.sqrt(g.density);
        const f = w.fronts[w.front++ % w.fronts.length];
        const boss = this.plan.boss && w.idx === this.plan.waves.length - 1 && w.left === 1;
        if (this.spawnMob(f, boss)) w.left--;
        else w.spawnT = 1;
      }
      w.t += dt;
      return;
    }
    // all spawned: wait for the pressure to ease, then the next wave
    w.t += dt;
    const last = this.waveIdx === this.plan.waves.length - 1;
    if (last) {
      if (alive === 0) this.dawn();
      else if (w.t > 150 && alive <= 3) for (const m of g.mobs) if (m.alive) g.damageMob(m, 99999, { ang: 0 });
    } else if (alive <= Math.max(2, w.size * 0.2) || w.t > 80) {
      w.lull = 10;
      this.say(`WAVE ${this.waveIdx + 1} BROKEN`, '#7dff8a', 'Reload, repair, steady up — next wave in 10s');
      const nx = this.plan.waves[this.waveIdx + 1];
      g.msg(`Next wave from the ${nx.fronts.map((f) => f.name).join(' & ')} in 10s`, '#ffb36b');
    }
  }

  // ---------- spawning ----------
  edgePoint(front) {
    const g = this.g, map = g.map, z = this.zones, pl = g.player, cam = g.cam;
    const cells = g.spawnCells(map);
    if (!cells.length) return null;
    const bx = z.anchor.x, by = z.anchor.y;
    for (let i = 0; i < 40; i++) {
      const [cx, cy] = cells[(Math.random() * cells.length) | 0];
      const x = cx * T + 16, y = cy * T + 24;
      if (!z.outdoor[cy * map.w + cx]) continue; // never inside a building
      if (map.blocking(cx, cy)) continue;
      if (Math.hypot(x - pl.x, y - pl.y) < 380) continue;
      if (Math.hypot(x - bx, y - by) < 300) continue;
      if (cam && x > cam.x - 48 && x < cam.x + cam.vw + 48 && y > cam.y - 48 && y < cam.y + cam.vh + 64) continue;
      if (g.flow.dist[cy * map.w + cx] === -1) continue;
      if (front && i < 30) { const dx = x - bx, dy = y - by, d = Math.hypot(dx, dy) || 1; if ((dx * front.x + dy * front.y) / d < 0.45) continue; }
      return { x, y };
    }
    return null;
  }

  spawnMob(front, boss = false) {
    const g = this.g;
    const p = this.edgePoint(front) || (front ? null : g.spawnPoint());
    if (!p) return false;
    if (!this.zones.outdoor[Math.floor(p.y / T) * g.map.w + Math.floor(p.x / T)] && !this.zones.openBase) return false;
    const n = this.c.night, eq = (n - 1) * 55 + (this.waveIdx || 0) * 8;
    const open = g.groups.filter((gr) => eq >= gr.unlock);
    let id = null;
    if (boss) {
      const bg = g.groups.find((gr) => gr.ids.some(([i]) => (g.data.mobs.get(i) || {}).hp >= 15000));
      if (bg) id = bg.ids.find(([i]) => (g.data.mobs.get(i) || {}).hp >= 15000)[0];
    }
    for (let k = 0; id === null && k < 8; k++) {
      const gr = Math.random() < 0.8 || open.length < 2 ? open[0] : pick(open.slice(1));
      const cand = g.pickId(gr.ids), def = g.data.mobs.get(cand);
      if (def && def.hp < 15000) id = cand;
    }
    if (id === null) return false;
    const m = g.spawnMob(id, p.x, p.y);
    if (!m) return false;
    const k = 1 + 0.12 * (n - 1);
    m.maxHp = m.hp = Math.round(m.maxHp * k);
    m.seen = this.phase === 'night';
    if (!m.boss && this.phase === 'night' && Math.random() < Math.min(0.35, 0.04 * n)) g.dir.makeElite(m, 'AFB'[(Math.random() * 3) | 0]);
    if (m.boss) { g.msg('A ' + m.def.name + ' leads the final push!', '#ff4b4b'); music('Plant 42 - Boss Theme RE'); play.radio(); }
    return true;
  }

  // ---------- dawn / death ----------
  dawn() {
    const g = this.g, c = this.c;
    this.phase = 'dawn';
    this.t = 6;
    this.wave = null;
    music('playlist', true);
    const survivors = this.defenders.filter((d) => d.n.alive);
    let scraps = 40 + 12 * c.night + 5 * survivors.length;
    for (const d of survivors) if (d.v.kind === 'survivor') scraps += 6;
    c.scrap += scraps;
    c.kills += g.kills - this.nightKills0;
    for (const d of this.defenders) if (d.n.alive) d.v.nights++;
    // some drift on, the rest stay
    const leave = Math.max(0.1, 0.35 - 0.05 * c.up.barracks);
    for (const d of [...this.defenders]) {
      if (!d.n.alive) { d.n.hp = d.n.maxHp * 0.3; d.n.alive = true; d.n.say(g.assets.barks.quick_thanks); } // the crew drags the wounded in
      if (Math.random() < leave) {
        g.msg(`${d.v.name} moves on at first light`, '#9cd4ff');
        d.v.here = false;
        this.defenders = this.defenders.filter((x) => x !== d);
        g.npcs = g.npcs.filter((x) => x !== d.n);
      }
    }
    const pl = g.player;
    pl.hp = Math.min(pl.maxHp, pl.hp + pl.maxHp * 0.6);
    this.applyWalls(true);
    g.dir.supplyDrop();
    g.items.set('Boards', Math.min(20, (g.items.get('Boards') || 0) + 4 + 2 * c.up.armory));
    c.night++;
    c.best = Math.max(c.best, c.night);
    this.syncDirector();
    c.boards = g.items.get('Boards') || 0;
    this.save();
    this.say(`NIGHT ${c.night - 1} SURVIVED`, '#7dff8a', `+${scraps} scrap · supplies dropped · night ${c.night} will be worse`);
    g.msg(`Dawn. +${scraps} scrap. The horde will return stronger.`, '#7dff8a');
    play.radio();
  }

  onDeath() {
    this.deadHandled = true;
    const c = this.c;
    c.deaths++;
    c.scrap = Math.floor(c.scrap * 0.75);
    c.boards = Math.max(c.boards, 4);
    this.save();
    this.g.msg(`The base fell on night ${c.night}. You will start this night again.`, '#ff6b6b');
  }

  // called when the match is torn down
  stop() { if (this.ready && !this.deadHandled) { this.c.boards = Math.max(this.c.boards, this.g.items.get('Boards') || 0); this.save(); } this.closeShop(); }

  // ---------- HUD text ----------
  objective() {
    if (!this.ready) return '';
    const g = this.g, c = this.c, clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const stock = `   ⚙ ${c.scrap}   ▤ ${g.items.get('Boards') || 0}   ☺ ${this.defenders.filter((d) => d.n.alive).length}/${this.slots}`;
    if (this.phase === 'day') return `DAY ${c.night} · DUSK IN ${clock(this.t)}${stock}`;
    if (this.phase === 'dusk') return `NIGHT ${c.night} IN ${Math.ceil(this.t)}${stock}`;
    if (this.phase === 'dawn') return `DAWN${stock}`;
    const left = g.mobs.filter((m) => m.alive).length + (this.wave ? this.wave.left : 0);
    return `NIGHT ${c.night} · WAVE ${Math.min(this.waveIdx + 1, this.plan.waves.length)}/${this.plan.waves.length} · ${left} LEFT${stock}`;
  }

  // ---------- workbench ----------
  interactable() {
    if (!this.ready || this.g.over) return null;
    const pl = this.g.player, a = this.zones.anchor;
    if (Math.hypot(pl.x - a.x, pl.y - a.y) > 40) return null;
    if (this.phase === 'night') return { type: 'ext', label: 'Workbench (locked until dawn)', run: () => this.g.msg('The crew has locked the workbench. Hold the line until dawn.', '#ffb36b') };
    return { type: 'ext', label: 'Workbench — upgrades & supplies', run: () => this.openShop() };
  }

  buy(kind, key) {
    const g = this.g, c = this.c, pl = g.player;
    const put = (name, amount = null) => { const p = g.map.randomWalkable({ x: pl.x - 40, y: pl.y - 40, w: 80, h: 80 }) || { x: pl.x, y: pl.y }; g.pickups.push(g.makePickup(name, p.x, p.y - 6, amount)); };
    const pay = (cost) => { if (c.scrap < cost) { g.msg('Not enough scrap', '#ff8b8b'); return false; } c.scrap -= cost; return true; };
    if (kind === 'up') {
      const U = UPGRADES[key], l = c.up[key];
      if (l >= U.max || !pay(U.cost[l])) return;
      c.up[key]++;
      if (key === 'walls') this.applyWalls(false);
      g.msg(`${U.name} → level ${c.up[key]}`, '#7dff8a');
      play.pickup();
    } else if (key === 'boards') {
      const have = g.items.get('Boards') || 0;
      if (have >= 20) { g.msg('You cannot carry more boards', '#ff8b8b'); return; }
      if (pay(4)) { g.items.set('Boards', have + 1); play.hammer(); }
    } else if (key === 'ammo') {
      if (pay(30)) { for (let i = 0; i < 2; i++) { const d = g.data.rollDrop(0); if (d) put(d.name); } play.pickup(); g.msg('Ammo crate dropped at your feet', '#ffd36b'); }
    } else if (key === 'medkit') {
      if (pay(25)) { put('Herb-G', 1); put('Herb-R', 1); play.pickup(); g.msg('Herbs dropped at your feet', '#9cff9c'); }
    } else if (key === 'early') {
      this.closeShop(); this.t = 0; g.msg('You call the dusk early.', '#ffb36b'); return;
    }
    this.c.boards = g.items.get('Boards') || 0;
    this.save();
    this.renderShop();
  }

  openShop() {
    if (this.shop) return;
    const g = this.g;
    this.shop = document.createElement('div');
    this.shop.setAttribute('style', 'position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;font-family:Bebas,Impact,sans-serif;color:#e8e8e8;padding:12px;box-sizing:border-box');
    document.body.append(this.shop);
    g.paused = true;
    this._key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.closeShop(); } };
    window.addEventListener('keydown', this._key, true);
    this.renderShop();
  }

  closeShop() {
    if (!this.shop) return;
    this.shop.remove(); this.shop = null;
    window.removeEventListener('keydown', this._key, true);
    this.g.paused = false;
    this.save();
  }

  renderShop() {
    const g = this.g, c = this.c, root = this.shop;
    if (!root) return;
    const mk = (tag, st, txt, extra = {}) => { const e = document.createElement(tag); if (st) e.setAttribute('style', st); if (txt != null) e.textContent = txt; Object.assign(e, extra); return e; };
    const btn = (label, fn, ok = true) => { const b = mk('button', `font:inherit;font-size:18px;letter-spacing:1px;padding:6px 14px;border:1px solid ${ok ? '#ffd36b' : '#444'};background:${ok ? '#2a2412' : '#16181c'};color:${ok ? '#ffd36b' : '#777'};cursor:pointer;min-height:36px`, label); b.onclick = fn; return b; };
    const panel = mk('div', 'background:#0c0e12;border:1px solid #ffd36b;max-width:620px;width:100%;max-height:92vh;overflow:auto;padding:16px 18px;box-sizing:border-box');
    panel.append(mk('div', 'font-size:30px;color:#ffd36b;letter-spacing:2px', `WORKBENCH — NIGHT ${c.night}`));
    panel.append(mk('div', 'font-size:20px;color:#c8a45a;margin:2px 0 10px', `⚙ ${c.scrap} scrap   ▤ ${g.items.get('Boards') || 0} boards   ${this.phase === 'day' ? `dusk in ${Math.ceil(this.t)}s` : 'dusk has fallen'}`));
    panel.append(mk('div', 'font-size:22px;margin:8px 0 4px;color:#9cd4ff', 'BASE UPGRADES'));
    for (const [key, U] of Object.entries(UPGRADES)) {
      const l = c.up[key], row = mk('div', 'display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid #1d2026');
      const info = mk('div', 'flex:1;min-width:0');
      info.append(mk('div', 'font-size:20px', `${U.name}  ${'●'.repeat(l)}${'○'.repeat(U.max - l)}`));
      info.append(mk('div', 'font-family:system-ui,sans-serif;font-size:12px;color:#9aa', U.desc(Math.max(1, l + (l < U.max ? 1 : 0)))));
      row.append(info);
      row.append(l >= U.max ? mk('div', 'color:#7dff8a;font-size:18px', 'MAX') : btn(`${U.cost[l]} ⚙`, () => this.buy('up', key), c.scrap >= U.cost[l]));
      panel.append(row);
    }
    panel.append(mk('div', 'font-size:22px;margin:12px 0 4px;color:#9cd4ff', 'SUPPLIES'));
    const sup = mk('div', 'display:flex;flex-wrap:wrap;gap:8px');
    sup.append(btn('Boards ×1 · 4 ⚙', () => this.buy('s', 'boards'), c.scrap >= 4), btn('Ammo crate · 30 ⚙', () => this.buy('s', 'ammo'), c.scrap >= 30), btn('Herbs · 25 ⚙', () => this.buy('s', 'medkit'), c.scrap >= 25));
    panel.append(sup);
    panel.append(mk('div', 'font-size:22px;margin:12px 0 4px;color:#9cd4ff', `CAMP ROSTER (${this.defenders.length}/${this.slots} slots)`));
    const live = c.vets.filter((v) => !v.fallen);
    const lines = live.length ? live.map((v) => `${v.here ? '●' : '○'} ${v.name} · ${v.kind === 'soldier' ? v.gun || 'soldier' : 'scavenger'} · ${v.nights} night${v.nights === 1 ? '' : 's'}${v.here ? '' : ' · away'}`) : ['Nobody yet — survivors find lit camps.'];
    panel.append(mk('div', 'font-family:system-ui,sans-serif;font-size:13px;color:#cfd;line-height:1.5', lines.join('\n'), { style: 'white-space:pre-line' }));
    const fallen = c.vets.filter((v) => v.fallen);
    if (fallen.length) panel.append(mk('div', 'font-family:system-ui,sans-serif;font-size:12px;color:#a66;margin-top:4px', `Fallen: ${fallen.map((v) => v.name).join(', ')}`));
    panel.append(mk('div', 'font-family:system-ui,sans-serif;font-size:12px;color:#889;margin-top:8px', `Best night ${c.best} · ${c.kills} kills · base fell ${c.deaths}×. Progress saves automatically; dying costs 25% scrap and repeats the night.`));
    const foot = mk('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:14px');
    foot.append(btn('Close', () => this.closeShop()));
    if (this.phase === 'day') foot.append(btn('Call dusk early', () => this.buy('s', 'early')));
    const wipe = btn('Abandon campaign', () => { if (window.confirm('Delete this map\'s Siege campaign and start over?')) { resetCampaign(this.mapName); this.deadHandled = true; this.closeShop(); g.msg('Campaign deleted. Leave and redeploy to start fresh.', '#ff8b8b'); } }, true);
    wipe.style.marginLeft = 'auto'; wipe.style.color = '#a66'; wipe.style.borderColor = '#533';
    foot.append(wipe);
    panel.append(foot);
    root.replaceChildren(panel);
  }

  // ---------- drawing ----------
  drawGround(ctx) {
    if (!this.ready) return;
    const g = this.g, a = this.zones.anchor, t = g.time;
    // workbench
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(a.x - 14, a.y - 2, 28, 5);
    ctx.fillStyle = '#6b4a26'; ctx.fillRect(a.x - 13, a.y - 12, 26, 9);
    ctx.fillStyle = '#8a6434'; ctx.fillRect(a.x - 13, a.y - 12, 26, 3);
    ctx.fillStyle = '#9aa0a8'; ctx.fillRect(a.x - 8, a.y - 16, 3, 5); ctx.fillRect(a.x - 10, a.y - 17, 7, 2);
    ctx.fillStyle = '#c8a45a'; ctx.fillRect(a.x + 4, a.y - 15, 6, 3);
    if (this.phase !== 'night') { ctx.strokeStyle = `rgba(255,211,107,${0.35 + 0.25 * Math.sin(t * 4)})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(a.x, a.y - 6, 22, 11, 0, 0, 7); ctx.stroke(); }
    // scrap piles
    for (const p of this.piles) {
      const b = Math.sin(t * 3 + p.x) * 1.2;
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(p.x - 5, p.y - 1, 10, 3);
      if (p.boards) { ctx.fillStyle = '#8a6434'; ctx.fillRect(p.x - 6, p.y - 6 + b, 12, 3); ctx.fillRect(p.x - 5, p.y - 9 + b, 10, 3); }
      else { ctx.fillStyle = '#8c8f94'; ctx.fillRect(p.x - 5, p.y - 5 + b, 6, 4); ctx.fillStyle = '#c8a45a'; ctx.fillRect(p.x - 1, p.y - 8 + b, 6, 5); ctx.fillStyle = '#b5532a'; ctx.fillRect(p.x - 3, p.y - 3 + b, 4, 3); }
      ctx.fillStyle = `rgba(255,230,140,${0.5 + 0.4 * Math.sin(t * 6 + p.y)})`; ctx.fillRect(p.x + 3, p.y - 9 + b, 1.5, 1.5);
    }
  }

  lights(hole) {
    if (!this.ready) return;
    const a = this.zones.anchor, up = this.c.up.lights;
    hole(a.x, a.y - 8, 120, 0.7);
    if (this.phase === 'day' || !up) return;
    for (const o of this.zones.openings) hole(o.cx * T + 16, o.cy * T + 16, 90 + 30 * up, 0.55);
  }

  drawScreen(ctx, W, H, u) {
    if (!this.ready) return;
    const g = this.g;
    if (this.phase === 'night') { ctx.fillStyle = `rgba(90,0,0,${0.08 + 0.04 * Math.sin(g.time * 2)})`; ctx.fillRect(0, 0, W, H); }
    ctx.textAlign = 'center';
    const b = this.banner;
    if (b) {
      const y = Math.max(H * 0.3, 150 * u), a = Math.min(1, b.t * 1.5);
      ctx.globalAlpha = a;
      ctx.font = `${Math.round(32 * u)}px Bebas, Impact, sans-serif`;
      ctx.fillStyle = '#000'; ctx.fillText(b.text, W / 2 + 2, y + 2);
      ctx.fillStyle = b.color; ctx.fillText(b.text, W / 2, y);
      if (b.sub) { ctx.font = `${Math.round(16 * u)}px Bebas, Impact, sans-serif`; ctx.fillStyle = '#000'; ctx.fillText(b.sub, W / 2 + 1, y + 26 * u + 1); ctx.fillStyle = '#e8e8e8'; ctx.fillText(b.sub, W / 2, y + 26 * u); }
      ctx.globalAlpha = 1;
    }
    // where the next wave will come from
    const w = this.phase === 'dusk' ? this.plan.waves[0] : this.phase === 'night' && this.wave && (this.wave.lull > 0 ? this.plan.waves[this.waveIdx + 1] : this.wave.t < 10 ? this.wave : null);
    if (w && g.cam && w.fronts) {
      const pulse = 0.6 + 0.4 * Math.sin(g.time * 7);
      for (const f of w.fronts) {
        const cx = W / 2 + f.x * (W / 2 - 34 * u), cy = H / 2 + f.y * (H / 2 - 34 * u), a = Math.atan2(f.y, f.x);
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(a); ctx.globalAlpha = pulse;
        ctx.fillStyle = '#ff3b3b'; ctx.beginPath(); ctx.moveTo(18 * u, 0); ctx.lineTo(-8 * u, -13 * u); ctx.lineTo(-8 * u, 13 * u); ctx.closePath(); ctx.fill();
        ctx.restore();
        ctx.globalAlpha = pulse; ctx.font = `${Math.round(15 * u)}px Bebas, sans-serif`; ctx.fillStyle = '#ffb3a0';
        ctx.fillText(f.name, cx - f.x * 38 * u, cy - f.y * 26 * u + 5 * u); ctx.globalAlpha = 1;
      }
    }
    ctx.textAlign = 'left';
  }
}
