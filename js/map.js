// Tiled map loading, prerendering and collision, following the original layer conventions:
// floor_N group -> bot_0..bot_3 (under actors), top_0..top_2 (over actors), inst (objects).

export const T = 32;
const FLIP_H = 0x80000000, FLIP_V = 0x40000000, FLIP_D = 0x20000000;

const SOLID_TYPES = new Set(['Obstruction', 'Wall', 'WallTop', 'VoidAll', 'Tree', 'Car', 'Window', 'StreetLight']);
const SOLID_SETS = new Set(['walls', 'walls_wframe', 'wall_tops']);
const SHOT_PASS_TYPES = new Set(['Obstruction', 'Car', 'Window']);
const CADE_RE = /^(Cade|HeavyCade|Fence|Shutter)_(\d+)%$/;
const CADE_HP = { Cade: 400, HeavyCade: 1200, Fence: 600, Shutter: 1500, Boarded: 240 };
const STAGES = [100, 75, 50, 25, 0];
export const MARKERS = new Set(['PlayerSpawn', 'MobSpawn', 'Soilder', 'RanAmmo', 'RanHerb', 'RanMelee', 'BlockP', 'BlockC',
  'SpawnRed', 'SpawnGreen', 'SpawnPink', 'SpawnBlue', 'Survivor', 'EvacZone', 'HeliSpawn', 'HeliWayPoint', 'RanPoster',
  'ScenarioSettings', 'SpawnLocator', 'SpawnTrigger']);

export class GameMap {
  // Number of floor_N groups in a map (1 for single-floor maps).
  static floorCount(json) {
    return Math.max(1, json.layers.filter((l) => /^floor_\d+$/.test(l.name)).length);
  }

  constructor(json, assets, z = 0, opts = {}) {
    this.clean = !!opts.clean; // lobby: skip gore / trash / damage decorations
    this.json = json;
    this.z = z;
    this.floors = GameMap.floorCount(json);
    this.assets = assets;
    this.w = json.width;
    this.h = json.height;
    this.pw = this.w * T;
    this.ph = this.h * T;
    this.sets = json.tilesets
      .map((t) => ({ first: t.firstgid, name: t.name, def: assets.tilesets[t.name] }))
      .sort((a, b) => a.first - b.first);
    const n = this.w * this.h;
    this.solid = new Uint8Array(n);     // static: blocks movement
    this.breach = new Uint8Array(n);    // windows: infected climb through, players can't
    this.low = new Uint8Array(n);       // static but low enough to jump over (fences)
    this.shotBlock = new Uint8Array(n); // static: blocks bullets
    this.dyn = new Array(n).fill(null); // door / barricade occupying a cell
    this.doors = [];
    this.cades = [];
    this.pickups = [];
    this.lights = [];
    this.markers = {};
    this.props = Object.fromEntries((json.properties || []).map((p) => [p.name, p.value]));
    this.itemNames = new Map(); // tileset name -> Map(lid -> item name)
    this.build();
    this.stairs = this.findStairs();
  }

  // Stairs are smart stamps in the root STAMPS layer: tp_x/tp_y = arrival point, tp_z/32 = target
  // floor. Their zlayerslice is unreliable, so a stair is usable from every floor except its target;
  // when a cell has several, the nearest target floor wins.
  findStairs() {
    const out = new Map();
    const stamps = this.json.layers.find((l) => l.name === 'STAMPS');
    if (!stamps || this.floors < 2) return out;
    for (const o of stamps.objects || []) {
      const p = Object.fromEntries((o.properties || []).map((q) => [q.name, q.value]));
      if (p.tp_z === undefined || p.tp_x === undefined) continue;
      const to = Math.round(p.tp_z / T);
      if (to === this.z || to < 0 || to >= this.floors) continue;
      // tile objects (with a gid) are anchored at their bottom edge in Tiled
      const top = o.gid ? o.y - (o.height || T) : o.y;
      const cx = Math.floor((o.x + 1) / T), cy = Math.floor((top + 1) / T);
      if (!this.inBounds(cx, cy)) continue;
      const i = this.idx(cx, cy), cur = out.get(i);
      if (cur && Math.abs(cur.to - this.z) <= Math.abs(to - this.z)) continue;
      out.set(i, { to, cx, cy, x: p.tp_x + 16, y: p.tp_y + 24 });
    }
    return out;
  }

  idx(cx, cy) { return cy * this.w + cx; }
  inBounds(cx, cy) { return cx >= 0 && cy >= 0 && cx < this.w && cy < this.h; }

  resolve(raw) {
    const g = raw >>> 0;
    const gid = g & 0x1fffffff;
    if (!gid) return null;
    let s = null;
    for (const x of this.sets) { if (x.first <= gid) s = x; else break; }
    if (!s || !s.def || !s.def.atlas) return null;
    const lid = gid - s.first;
    return { set: s.name, ts: s.def, lid, meta: s.def.tiles[lid] || {}, h: !!(g & FLIP_H), v: !!(g & FLIP_V), d: !!(g & FLIP_D) };
  }

  tileSrc(ts, lid) {
    return [ts.atlas.x + (lid % ts.cols) * ts.tw, ts.atlas.y + Math.floor(lid / ts.cols) * ts.th, ts.tw, ts.th];
  }

  drawTile(ctx, r, dx, dy, dw, dh, lid = r.lid) {
    const [sx, sy, sw, sh] = this.tileSrc(r.ts, lid);
    const page = this.assets.tilePages[r.ts.atlas.page];
    dw = dw || sw; dh = dh || sh;
    if (!r.h && !r.v && !r.d) { ctx.drawImage(page, sx, sy, sw, sh, dx, dy, dw, dh); return; }
    ctx.save();
    ctx.translate(dx + dw / 2, dy + dh / 2);
    if (r.h) ctx.scale(-1, 1);
    if (r.v) ctx.scale(1, -1);
    if (r.d) ctx.transform(0, 1, 1, 0, 0, 0);
    ctx.drawImage(page, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  itemNameFor(r) {
    let m = this.itemNames.get(r.set);
    if (!m) {
      m = new Map();
      for (const fr of r.ts.names || []) {
        const lid = Math.floor(fr.y / r.ts.th) * r.ts.cols + Math.floor(fr.x / r.ts.tw);
        if (!m.has(lid)) m.set(lid, fr.name.split('_')[0]);
      }
      this.itemNames.set(r.set, m);
    }
    return m.get(r.lid) || null;
  }

  floor() {
    return this.json.layers.find((l) => l.name === 'floor_' + this.z) || { layers: this.json.layers };
  }

  build() {
    const floor = this.floor();
    this.bot = document.createElement('canvas');
    this.top = document.createElement('canvas');
    this.bot.width = this.top.width = this.pw;
    this.bot.height = this.top.height = this.ph;
    const bctx = this.bot.getContext('2d');
    const tctx = this.top.getContext('2d');
    bctx.fillStyle = '#050608';
    bctx.fillRect(0, 0, this.pw, this.ph);

    for (const layer of floor.layers || []) {
      if (layer.type !== 'tilelayer' || !layer.data) continue;
      const isTop = layer.name.startsWith('top_');
      if (layer.name === 'markers') continue;
      const ctx = isTop ? tctx : bctx;
      for (let i = 0; i < layer.data.length; i++) {
        const r = this.resolve(layer.data[i]);
        if (!r) continue;
        const cx = i % this.w, cy = Math.floor(i / this.w);
        const dx = cx * T + (+r.meta.pixel_offset_x || 0);
        const dy = (cy + 1) * T - r.ts.th;
        if (this.clean && /^(deco_gore|deco_trash|deco_cracks|police_tape|hazards_|1destroyed)/.test(r.set)) continue;
        if (!isTop && this.dynamicTile(r, cx, cy)) continue;
        this.drawTile(ctx, r, dx, dy);
        if (!isTop) this.applyStatic(r, cx, cy);
      }
    }

    const objs = [];
    for (const layer of floor.layers || []) if (layer.objects) objs.push(...layer.objects);
    objs.sort((a, b) => a.y - b.y);
    for (const o of objs) this.addObject(o, bctx);
  }

  applyStatic(r, cx, cy) {
    const type = r.meta.type || '';
    const i = this.idx(cx, cy);
    if (/^Fence_/.test(type)) this.low[i] = 1;
    if (type === 'Window') this.breach[i] = 1;
    if (SOLID_TYPES.has(type) || SOLID_SETS.has(r.set) || /^Fence_/.test(type)) {
      this.solid[i] = 1;
      if (!SHOT_PASS_TYPES.has(type) && !/^Fence_/.test(type)) this.shotBlock[i] = 1;
    }
    if (type === 'Candle' || type === 'LightBulb' || type === 'StreetLight') this.addLight(type, cx * T + 16, cy * T + 16);
  }

  addLight(type, x, y) {
    const cfg = { Candle: [90, 4], LightBulb: [150, 5], StreetLight: [200, 0] }[type] || [120, 0];
    this.lights.push({ x, y, radius: cfg[0], pattern: cfg[1], phase: Math.random() * 10 });
  }

  // Tiles that become runtime entities (not baked into the prerender).
  dynamicTile(r, cx, cy) {
    const type = r.meta.type || '';
    const x = cx * T, y = (cy + 1) * T - r.ts.th;
    if (type === 'Door' || type === 'DoorOpen') { this.addDoor(r, x, y, cx, cy, type === 'DoorOpen'); return true; }
    const m = CADE_RE.exec(type);
    if (m) { this.addCade(r, m[1], STAGES.indexOf(+m[2]), x, y, cx, cy); return true; }
    if (type === 'Boarded') { this.addCade(r, 'Boarded', 0, x, y, cx, cy); return true; }
    if (type === 'PickupItem') {
      const name = this.itemNameFor(r);
      this.pickups.push({ x: x + 16, y: y + 16, name: name || 'Boards', tile: r, amount: null });
      return true;
    }
    return false;
  }

  addDoor(r, x, y, cx, cy, open) {
    const inRow = r.lid % r.ts.cols;
    const base = r.lid - (inRow % 5);
    const door = { kind: 'door', r, x, y, cx, cy, openLid: base, closedLid: base + 4, open, anim: 1 };
    this.doors.push(door);
    if (this.inBounds(cx, cy)) this.dyn[this.idx(cx, cy)] = door;
  }

  addCade(r, kind, stage, x, y, cx, cy) {
    const maxHp = CADE_HP[kind];
    const cade = {
      kind: 'cade', type: kind, r, x, y, cx, cy, baseLid: r.lid - Math.max(stage, 0),
      maxHp, hp: stage >= 4 ? 0 : maxHp * (1 - stage / 4), hit: 0,
    };
    this.cades.push(cade);
    if (this.inBounds(cx, cy)) this.dyn[this.idx(cx, cy)] = cade;
  }

  addObject(o, ctx) {
    const type = o.type || '';
    if (MARKERS.has(type)) {
      (this.markers[type] = this.markers[type] || []).push({ x: o.x, y: o.y, w: o.width || T, h: o.height || T, name: o.name });
      return;
    }
    if (!o.gid) return;
    const r = this.resolve(o.gid);
    if (!r) return;
    if (this.clean && /^(deco_gore|deco_trash|deco_cracks|police_tape|hazards_|1destroyed)/.test(r.set)) return;
    const w = o.width || r.ts.tw, h = o.height || r.ts.th;
    const topLeft = r.ts.align === 'topleft';
    const x = o.x, y = topLeft ? o.y : o.y - h;
    const cx = Math.floor((x + 1) / T), cy = Math.floor((y + h - 1) / T);
    const tType = r.meta.type || type;
    if (type === 'Boards') { this.pickups.push({ x: x + w / 2, y: y + h / 2, name: 'Boards', tile: r, amount: 1 }); return; }
    if (type === 'Boarded' || tType === 'Boarded') { this.addCade(r, 'Boarded', 0, x, y, cx, cy); return; }
    if (tType === 'Door' || tType === 'DoorOpen') { this.addDoor(r, x, y, cx, cy, tType === 'DoorOpen'); return; }
    const m = CADE_RE.exec(tType);
    if (m) { this.addCade(r, m[1], STAGES.indexOf(+m[2]), x, y, cx, cy); return; }
    if (tType === 'PickupItem') {
      this.pickups.push({ x: x + w / 2, y: y + h / 2, name: this.itemNameFor(r) || 'Boards', tile: r, amount: null });
      return;
    }
    this.drawTile(ctx, r, x, y, w, h);
    if (tType === 'Candle' || tType === 'LightBulb' || tType === 'StreetLight') this.addLight(tType, x + w / 2, y + h / 2);
    if (tType === 'Window' && this.inBounds(cx, cy)) this.breach[this.idx(cx, cy)] = 1;
    if (SOLID_TYPES.has(tType) && this.inBounds(cx, cy)) {
      this.solid[this.idx(cx, cy)] = 1;
      if (!SHOT_PASS_TYPES.has(tType)) this.shotBlock[this.idx(cx, cy)] = 1;
    }
  }

  // ---- runtime queries ----
  // airborne: fences and barricades (incl. boarded windows) can be jumped over
  blocking(cx, cy, airborne = false, mob = false) {
    if (!this.inBounds(cx, cy)) return true;
    const i = this.idx(cx, cy);
    const d = this.dyn[i];
    if (mob && this.breach[i] && !d) return false;
    if (airborne && (this.low[i] || (d && d.kind === 'cade'))) return false;
    if (this.solid[i]) return true;
    if (!d) return false;
    return d.kind === 'door' ? !d.open : d.hp > 0;
  }

  blocksShot(cx, cy) {
    if (!this.inBounds(cx, cy)) return true;
    const i = this.idx(cx, cy);
    if (this.shotBlock[i]) return true;
    const d = this.dyn[i];
    return !!(d && d.kind === 'door' && !d.open);
  }

  boxHits(x, y, hw, hh, airborne = false, mob = false) {
    const x0 = Math.floor((x - hw) / T), x1 = Math.floor((x + hw) / T);
    const y0 = Math.floor((y - hh) / T), y1 = Math.floor((y + hh) / T);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (this.blocking(cx, cy, airborne, mob)) return true;
    return false;
  }

  // Line of sight across cells (for AI and lights).
  los(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.ceil(Math.hypot(dx, dy) / 12);
    for (let s = 1; s < steps; s++) {
      const x = x0 + (dx * s) / steps, y = y0 + (dy * s) / steps;
      if (this.blocksShot(Math.floor(x / T), Math.floor(y / T))) return false;
    }
    return true;
  }

  walkableCellsIn(rect) {
    const out = [];
    const x0 = Math.max(0, Math.floor(rect.x / T)), x1 = Math.min(this.w - 1, Math.floor((rect.x + rect.w - 1) / T));
    const y0 = Math.max(0, Math.floor(rect.y / T)), y1 = Math.min(this.h - 1, Math.floor((rect.y + rect.h - 1) / T));
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (!this.blocking(cx, cy)) out.push([cx, cy]);
    return out;
  }

  randomWalkable(rect) {
    const cells = this.walkableCellsIn(rect || { x: 0, y: 0, w: this.pw, h: this.ph });
    if (!cells.length) return null;
    const [cx, cy] = cells[Math.floor(Math.random() * cells.length)];
    return { x: cx * T + 16, y: cy * T + 24 };
  }

  drawDynamic(ctx, e) {
    if (e.kind === 'door') {
      const lid = e.open ? e.openLid : e.closedLid;
      this.drawTile(ctx, e.r, e.x, e.y, 0, 0, lid);
    } else if (e.kind === 'cade') {
      if (e.type === 'Boarded') { if (e.hp > 0) this.drawTile(ctx, e.r, e.x, e.y); return; }
      const stage = e.hp <= 0 ? 4 : Math.min(3, Math.floor((1 - e.hp / e.maxHp) * 4));
      const jitter = e.hit > 0 ? (Math.random() - 0.5) * 2 : 0;
      this.drawTile(ctx, e.r, e.x + jitter, e.y, 0, 0, e.baseLid + stage);
    }
  }
}
