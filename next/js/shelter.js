// SHELTER: the home base layer on top of SIEGE, in the spirit of State of Decay 2.
// - A shared STOCKPILE of five resources (food, medicine, ammo, materials, fuel) with daily upkeep.
// - A RUCKSACK: loot packs are bulky, one per slot, and slow you down; carry them home and drop them
//   at the supply locker (the workbench) to add them to the stockpile.
// - FACILITIES built from materials on fixed plots inside the base, drawn with the game's own tiles:
//   storage, kitchen, garden, infirmary, workshop, generator, bunks and watchtowers.
// - MORALE, which rises with nights held and falls with hunger and losses.
// Everything lives in the siege campaign save, so the base carries on from session to session.
import { T } from './map.js';
import { hitscan } from './combat.js';
import { play } from './sfx.js';

export const RES = {
  food: { name: 'Food', short: 'FOOD', col: '#e0a060' },
  meds: { name: 'Medicine', short: 'MED', col: '#ff8b8b' },
  ammo: { name: 'Ammo', short: 'AMMO', col: '#ffd36b' },
  mats: { name: 'Materials', short: 'MAT', col: '#b9c3cf' },
  fuel: { name: 'Fuel', short: 'FUEL', col: '#9cd47a' },
};
const RES_KEYS = Object.keys(RES);
const LOOT_WEIGHTS = [['food', 0.3], ['mats', 0.3], ['ammo', 0.15], ['meds', 0.12], ['fuel', 0.13]];

// tile: [tileset name, local tile id] from assets/data/tilesets.json
export const FACILITIES = {
  storage: { name: 'Storage', tile: ['indoor_crates', 5], cost: { mats: 8 }, max: 3, desc: 'Stockpile holds +20 of each resource' },
  kitchen: { name: 'Kitchen', tile: ['indoor_dining_kitchen', 0], cost: { mats: 6 }, max: 2, desc: 'Daily food upkeep −25%; +5 morale each dawn' },
  garden: { name: 'Garden', tile: ['indoor_plants', 8], cost: { mats: 5, food: 2 }, max: 3, desc: '+2 food every dawn' },
  infirmary: { name: 'Infirmary', tile: ['indoor_medical', 8], cost: { mats: 8, meds: 2 }, max: 2, desc: 'Uses 1 medicine at dawn to heal everyone; faster healing in base' },
  workshop: { name: 'Workshop', tile: ['indoor_furniture_tables_metal', 0], cost: { mats: 10 }, max: 2, desc: 'Turns 2 materials into 3 ammo every dawn; repairs walls for materials' },
  generator: { name: 'Generator', tile: ['indoor_medical', 3], cost: { mats: 8, fuel: 2 }, max: 1, desc: 'Burns 1 fuel per night: floodlights and watchtowers get power' },
  bunks: { name: 'Bunks', tile: ['indoor_furniture_beds', 0], cost: { mats: 6 }, max: 3, desc: '+1 survivor slot' },
  tower: { name: 'Watchtower', tile: ['outdoor_city_objects_32x128', 0], upright: true, cost: { mats: 12, ammo: 4 }, max: 4, desc: 'Fires on the horde at night using base ammo; longer range with power' },
};

export const freshShelter = () => ({
  res: { food: 12, meds: 3, ammo: 8, mats: 12, fuel: 3 },
  fac: [],          // [{ kind, plot }]
  ruck: [],         // [{ kind, n }] packs carried home
  ruckSlots: 2,
  morale: 60,
});

const pickWeighted = (list) => { let r = Math.random(); for (const [k, w] of list) { if ((r -= w) <= 0) return k; } return list[0][0]; };

export class Shelter {
  constructor(siege) {
    this.s = siege;
    this.towerCd = new Map();
    this.power = false;
  }

  get g() { return this.s.g; }
  get c() { return this.s.c; }
  count(kind) { return this.c.fac.filter((f) => f.kind === kind).length; }
  cap() { return 40 + 20 * this.count('storage') + (this.s.community('Hoarder') ? 10 : 0); }
  ruckCap() { return this.c.ruckSlots + (this.s.heroHas('PackMule') ? 1 : 0) + (this.s.partnerWithYou() ? 1 : 0); }
  people() { return 1 + this.s.defenders.filter((d) => d.n.alive).length; }

  // ---------- plots: open cells in the base with room around them, nearest the workbench first ----------
  plots() {
    if (this._plots) return this._plots;
    const g = this.g, map = g.map, z = this.s.zones, a = z.anchor;
    const acx = Math.floor(a.x / T), acy = Math.floor(a.y / T);
    const near = new Set();
    for (const o of z.openings) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) near.add((o.cy + dy) * map.w + o.cx + dx);
    const free = (x, y) => map.inBounds(x, y) && !map.blocking(x, y) && !map.dyn[y * map.w + x] && z.inBase.has(y * map.w + x);
    const out = [];
    const cells = [...z.baseCells].sort((p, q) => Math.hypot(p[0] - acx, p[1] - acy) - Math.hypot(q[0] - acx, q[1] - acy) || p[1] - q[1] || p[0] - q[0]);
    for (const [x, y] of cells) {
      if (Math.hypot(x - acx, y - acy) < 2.5 || near.has(y * map.w + x)) continue;
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (!free(x + dx, y + dy)) { ok = false; break; }
      if (!ok || out.some(([px, py]) => Math.hypot(px - x, py - y) < 3)) continue;
      out.push([x, y]);
      if (out.length >= 12) break;
    }
    return (this._plots = out);
  }

  tileRef(kind) {
    const [set, lid] = FACILITIES[kind].tile, ts = this.g.assets.tilesets[set];
    return ts ? { set, ts, lid, meta: ts.tiles[lid] || {}, h: false, v: false, d: false } : null;
  }

  // put a facility's art and collision into the map (2D floor canvas + the 3D view's object lists)
  raise(f) {
    const g = this.g, map = g.map, [cx, cy] = this.plots()[f.plot] || [];
    if (cx === undefined) return false;
    const r = this.tileRef(f.kind);
    if (!r) return false;
    const i = cy * map.w + cx, x = cx * T, y = (cy + 1) * T - r.ts.th;
    if (FACILITIES[f.kind].upright) map.uprights.push({ r, x, y, w: r.ts.tw, h: r.ts.th });
    else { map.drawTile(map.bot.getContext('2d'), r, x, y); map.solids.push({ r, x, y, w: r.ts.tw, h: r.ts.th, type: 'Obstruction', cell: i }); }
    map.solid[i] = 1;
    map.ver = (map.ver || 0) + 1;
    map.botDirty = true;
    f.x = cx * T + 16; f.y = cy * T + 16;
    g.flowT = 0;
    return true;
  }

  init() {
    this.c.fac = this.c.fac.filter((f) => FACILITIES[f.kind] && this.raise(f));
    this.applySlots();
  }

  applySlots() { this.s.bunks = this.count('bunks'); }

  // ---------- building ----------
  canAfford(cost) { return Object.entries(cost).every(([k, v]) => (this.c.res[k] || 0) >= v); }
  costText(cost) { return Object.entries(cost).map(([k, v]) => `${v} ${RES[k].short}`).join(' + '); }

  build(kind) {
    const F = FACILITIES[kind], c = this.c, g = this.g;
    if (this.count(kind) >= F.max) return g.msg(`${F.name}: already at the limit`, '#ff8b8b');
    if (!this.canAfford(F.cost)) return g.msg(`Not enough supplies for ${F.name}`, '#ff8b8b');
    const used = new Set(c.fac.map((f) => f.plot));
    const plot = this.plots().findIndex((_, i) => !used.has(i));
    if (plot < 0) return g.msg('No free building plot left in the base', '#ff8b8b');
    for (const [k, v] of Object.entries(F.cost)) c.res[k] -= v;
    const f = { kind, plot };
    if (!this.raise(f)) return;
    c.fac.push(f);
    this.applySlots();
    g.fx.spawn('dust', f.x, f.y, { scale: 1.6 });
    play.hammer();
    g.msg(`${F.name} built`, '#7dff8a');
    this.s.save();
  }

  // ---------- loot and the rucksack ----------
  rollPile(p) {
    if (Math.random() < 0.45) return p; // scrap or boards, as before
    p.kind = pickWeighted(LOOT_WEIGHTS);
    p.n = 2 + ((Math.random() * 3) | 0);
    return p;
  }

  // returns false if the pack stays on the ground
  pickPack(p) {
    const c = this.c, g = this.g;
    if (c.ruck.length >= this.ruckCap()) {
      if (!p.warned || g.time - p.warned > 3) { p.warned = g.time; g.msg(`Rucksack full (${this.ruckCap()} slots) — drop it at the supply locker`, '#ffb36b'); }
      return false;
    }
    const n = p.n + (this.s.heroHas('Scavenger') ? 1 : 0);
    c.ruck.push({ kind: p.kind, n });
    g.msg(`+ ${RES[p.kind].name} pack (${n}) in your rucksack`, RES[p.kind].col);
    play.pickup();
    return true;
  }

  speedMul() { return (1 - 0.06 * this.c.ruck.length) * (this.s.heroHas('Cardio') ? 1.06 : 1); }

  deposit() {
    const c = this.c, g = this.g;
    if (!c.ruck.length) return;
    const cap = this.cap(), got = {};
    for (const p of c.ruck) { const add = Math.max(0, Math.min(p.n, cap - c.res[p.kind])); c.res[p.kind] += add; got[p.kind] = (got[p.kind] || 0) + add; }
    c.ruck = [];
    g.msg(`Stockpiled: ${Object.entries(got).map(([k, v]) => `+${v} ${RES[k].short}`).join('  ')}`, '#7dff8a');
    play.pickup();
    this.s.save();
  }

  // ---------- daily cycle ----------
  dusk() {
    const c = this.c;
    this.power = this.count('generator') > 0 && c.res.fuel > 0;
    if (this.power) c.res.fuel--;
    // soldiers draw ammo for the night; short of it they fight at half strength
    const shooters = this.s.defenders.filter((d) => d.n.weapon);
    const need = shooters.length;
    const have = Math.min(c.res.ammo, need);
    c.res.ammo -= have;
    shooters.forEach((d, i) => { d.n.dmgK = i < have ? 1 : 0.5; });
    if (have < need) this.g.msg(`Short on ammo: ${need - have} defender${need - have > 1 ? 's' : ''} fight at half strength`, '#ffb36b');
    if (this.count('generator') && !this.power) this.g.msg('The generator is out of fuel tonight', '#ffb36b');
  }

  dawnReport() {
    const c = this.c, g = this.g, notes = [];
    const cap = this.cap(), add = (k, n) => { c.res[k] = Math.max(0, Math.min(cap, c.res[k] + n)); };
    // production
    const grow = (2 + (this.s.community('Gardener') ? 1 : 0)) * this.count('garden');
    if (grow) { add('food', grow); notes.push(`+${grow} FOOD`); }
    const mk = 3 + (this.s.community('Mechanic') ? 2 : 0);
    for (let i = 0; i < this.count('workshop'); i++) if (c.res.mats >= 2) { add('mats', -2); add('ammo', mk); notes.push(`+${mk} AMMO`); }
    if (this.count('infirmary') && c.res.meds > 0) {
      add('meds', -1);
      for (const d of this.s.defenders) d.n.hp = d.n.maxHp;
      g.player.hp = g.player.maxHp; g.player.infection = 0;
      notes.push('infirmary healed everyone');
    }
    // upkeep
    const need = Math.max(0, Math.ceil(this.people() * (1 - 0.25 * this.count('kitchen'))) - (this.s.community('Cook') ? 1 : 0));
    if (this.s.community('Leader')) c.morale = Math.min(100, c.morale + 4);
    if (c.res.food >= need) { add('food', -need); c.morale = Math.min(100, c.morale + 5 + 5 * Math.min(1, this.count('kitchen'))); }
    else {
      c.res.food = 0; c.morale = Math.max(0, c.morale - 15);
      notes.push('not enough food: morale falls');
      const d = this.s.defenders.find((x) => x.n.alive);
      if (d && c.morale < 40) { this.s.dismiss(d, `${d.v.name} leaves: there is nothing to eat`); }
    }
    this.s.save();
    return notes.join(' · ');
  }

  onFallen() { this.c.morale = Math.max(0, this.c.morale - 12); }

  // ---------- watchtowers ----------
  update(dt) {
    const g = this.g, s = this.s, c = this.c;
    if (s.phase !== 'night' || c.res.ammo <= 0) return;
    const range = this.power ? 300 : 220;
    for (const f of c.fac) {
      if (f.kind !== 'tower') continue;
      const cd = (this.towerCd.get(f) || 0) - dt;
      if (cd > 0) { this.towerCd.set(f, cd); continue; }
      let best = null, bd = range;
      for (const m of g.mobs) {
        if (!m.alive) continue;
        const d = Math.hypot(m.x - f.x, m.cy - f.y);
        if (d < bd && g.map.los(f.x, f.y - 20, m.x, m.cy)) { bd = d; best = m; }
      }
      if (!best) { this.towerCd.set(f, 0.3); continue; }
      const a = Math.atan2(best.cy - (f.y - 20), best.x - f.x);
      hitscan(g, { x: f.x, y: f.y - 20, a, range, dmg: 38, pierce: 0, crit: 0.05, critMul: 2 });
      g.fx.spawn('sparkshot', f.x + Math.cos(a) * 10, f.y - 24 + Math.sin(a) * 10, { scale: 0.6, rot: a });
      g.tempLights && g.tempLights.push({ x: f.x, y: f.y - 20, r: 60, t: 0.06, max: 0.06 });
      f.shots = (f.shots || 0) + 1;
      if (f.shots % 4 === 0) c.res.ammo = Math.max(0, c.res.ammo - 1);
      this.towerCd.set(f, 0.55);
    }
  }

  lights(hole) {
    if (this.s.phase === 'day') return;
    for (const f of this.c.fac) if (f.kind === 'tower' && this.power) hole(f.x, f.y, 150, 0.6);
  }

  // ---------- HUD / shop ----------
  stockLine() {
    const r = this.c.res;
    return RES_KEYS.map((k) => `${RES[k].short} ${r[k]}`).join('  ') + `   PACK ${this.c.ruck.length}/${this.ruckCap()}   MORALE ${this.c.morale}`;
  }

  drawPile(ctx, p, b) {
    const col = RES[p.kind].col;
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(p.x - 7, p.y - 1, 14, 3);
    ctx.fillStyle = '#4a3a22'; ctx.fillRect(p.x - 7, p.y - 10 + b, 14, 10);
    ctx.fillStyle = col; ctx.fillRect(p.x - 7, p.y - 10 + b, 14, 3);
    ctx.fillStyle = '#000'; ctx.font = '5px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(RES[p.kind].short[0], p.x, p.y - 2 + b);
    ctx.textAlign = 'left';
  }

  shopPanel(mk, btn) {
    const c = this.c, wrap = mk('div', '');
    wrap.append(mk('div', 'font-size:22px;margin:8px 0 4px;color:#9cd4ff', `STOCKPILE (cap ${this.cap()} each) · MORALE ${c.morale}`));
    const row = mk('div', 'display:flex;flex-wrap:wrap;gap:12px;font-size:20px');
    for (const k of RES_KEYS) row.append(mk('div', `color:${RES[k].col}`, `${RES[k].name} ${c.res[k]}`));
    wrap.append(row);
    const rs = mk('div', 'display:flex;gap:10px;align-items:center;margin-top:6px;font-family:system-ui,sans-serif;font-size:13px;color:#cfd');
    rs.append(mk('div', 'flex:1', `Rucksack: ${c.ruck.length}/${this.ruckCap()} slots${c.ruck.length ? ' — ' + c.ruck.map((p) => `${RES[p.kind].short} ${p.n}`).join(', ') : ''}. Each pack slows you 6%.`));
    if (c.ruck.length) rs.append(btn('Drop at locker', () => { this.deposit(); this.s.renderShop(); }));
    const rc = 30 * c.ruckSlots;
    if (c.ruckSlots < 6) rs.append(btn(`Bigger rucksack · ${rc} ⚙`, () => { if (c.scrap < rc) return this.g.msg('Not enough scrap', '#ff8b8b'); c.scrap -= rc; c.ruckSlots++; this.s.save(); this.s.renderShop(); }, c.scrap >= rc));
    wrap.append(rs);
    const used = c.fac.length, plots = this.plots().length;
    wrap.append(mk('div', 'font-size:22px;margin:12px 0 4px;color:#9cd4ff', `BUILD (${used}/${plots} plots used)`));
    for (const [kind, F] of Object.entries(FACILITIES)) {
      const n = this.count(kind), r = mk('div', 'display:flex;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid #1d2026');
      const info = mk('div', 'flex:1;min-width:0');
      info.append(mk('div', 'font-size:19px', `${F.name}  ${'●'.repeat(n)}${'○'.repeat(F.max - n)}`));
      info.append(mk('div', 'font-family:system-ui,sans-serif;font-size:12px;color:#9aa', F.desc));
      r.append(info);
      const ok = n < F.max && this.canAfford(F.cost) && used < plots;
      r.append(n >= F.max ? mk('div', 'color:#7dff8a;font-size:18px', 'MAX') : btn(this.costText(F.cost), () => { this.build(kind); this.s.renderShop(); }, ok));
      wrap.append(r);
    }
    return wrap;
  }
}
