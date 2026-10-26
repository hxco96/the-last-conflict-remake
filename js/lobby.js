// Pregame lobby: the "Base" map, cleaned up. Every weapon and item is sold at the ARMORY: one compact
// row of tables next to the spawn (two categories per table); walk up to any table to open the
// armory screen on that category (tabs switch between all categories without walking). Walk up to a
// table to buy/equip, talk to the merchant for permanent upgrades, use the mission
// board to host-pick or vote the next round, and walk out through the DEPLOY doors to join a
// match that is already running.
import { T } from './map.js';
import { Player } from './actors.js';
import { randomLook } from './npc.js';
import { weaponPrice, stackPrice } from './profile.js';
import { tierOf, TIER_COLORS, TIER_NAMES } from './tiers.js';
import { play } from './sfx.js';

const CATS = [
  ['Melee', (i) => i.kind === 'melee'],
  ['Handguns', (i) => i.class === 'handgun'],
  ['Magnums', (i) => i.class === 'magnum'],
  ['SMGs', (i) => i.class === 'smg'],
  ['Shotguns', (i) => i.class === 'shotgun'],
  ['Assault rifles', (i) => i.class === 'ar'],
  ['Rifles', (i) => i.class === 'rifle'],
  ['LMGs', (i) => i.class === 'lmg'],
  ['Specials', (i) => ['launcher', 'rocket-launcher', 'special', 'bow', 'thrower'].includes(i.class)],
  ['Throwables & mines', (i) => i.kind === 'throwable' || i.kind === 'mine'],
  ['Ammo', (i) => i.kind === 'ammo'],
  ['Medical', (i) => i.kind === 'consumable' && !i['up-inv-cap']],
];
const SHORT = { 'Assault rifles': 'ARs', 'Throwables & mines': 'Throwables' };
const TABLE_TOP = 6, TABLE_FACE = 50; // indoor_furniture_tables long table tiles

export class LobbyExt {
  constructor(g) {
    this.g = g;
    this.noSpawn = true;
    this.mines = []; this.fires = []; this.webs = [];
    this.displays = [];
    this.labels = [];
    const map = g.map;
    const sp = (map.markers.PlayerSpawn || [])[0] || { x: g.player.x, y: g.player.y };
    this.spawn = { x: sp.x + 16, y: sp.y + 24 };
    this.placeFixtures();
    this.stock();
  }

  // ---------- layout ----------
  tableSet() {
    const s = this.g.map.sets.find((x) => x.name === 'indoor_furniture_tables');
    return s ? { first: s.first } : null;
  }

  existingTableCells() {
    const map = this.g.map, out = [];
    for (const layer of map.floor().layers || []) {
      if (!layer.data || layer.name.startsWith('top_')) continue;
      layer.data.forEach((raw, i) => {
        const r = map.resolve(raw);
        if (r && /tables/.test(r.set) && r.meta.type === 'Obstruction') out.push([i % map.w, Math.floor(i / map.w)]);
      });
    }
    const key = (c) => c[1] * 1000 + c[0];
    return [...new Map(out.map((c) => [key(c), c])).values()].sort((a, b) => key(a) - key(b));
  }

  placeFixtures() {
    const g = this.g, map = g.map;
    const near = (dx, dy) => {
      for (let r = 0; r < 6; r++) for (let k = 0; k < 16; k++) {
        const x = this.spawn.x + dx * T + (Math.random() - 0.5) * r * T, y = this.spawn.y + dy * T + (Math.random() - 0.5) * r * T;
        if (!map.boxHits(x, y, 6, 5)) return { x, y };
      }
      return { x: this.spawn.x, y: this.spawn.y };
    };
    const taken = [];
    const apart = (dx, dy) => { for (let k = 0; k < 20; k++) { const p = near(dx, dy); if (taken.every((t) => Math.hypot(t.x - p.x, t.y - p.y) > 48)) { taken.push(p); return p; } } const p = near(dx, dy); taken.push(p); return p; };
    this.merchantPos = apart(-3, -1);
    this.boardPos = apart(3, -1);
    this.storagePos = apart(0, -3);
    const look = randomLook('survivor', g.atlas.core);
    this.merchant = new Player(this.merchantPos.x, this.merchantPos.y, look, 'merchant');
    this.merchant.dir = 's';
    // DEPLOY doors: the two doors farthest from the spawn (the way out of the base)
    this.deployDoors = [...map.doors].sort((a, b) => Math.hypot(b.x - this.spawn.x, b.y - this.spawn.y) - Math.hypot(a.x - this.spawn.x, a.y - this.spawn.y)).slice(0, 2);
    for (const d of this.deployDoors) { d.open = false; d.deploy = true; }
  }

  stock() {
    const g = this.g, D = g.data;
    const items = [];
    const seen = new Set();
    for (const it of D.items.values()) if (!seen.has(it.name)) { seen.add(it.name); items.push(it); }
    // ammo types any gun actually uses
    const kinds = new Set([...D.items.values()].filter((i) => i.kind === 'gun').map((i) => i['ammo-kind']));
    for (const k of kinds) { const it = D.item(D.names.get(k) || ''); if (it) items.push(it); }
    const groups = CATS.map(([label, f]) => [label, items.filter((i) => f(i) && D.icon(i.name))]).filter(([, l]) => l.length);
    // catalogue: weapons sorted by tier then price inside each category
    this.catalog = groups.map(([label, list]) => ({
      label,
      items: list.map((it) => { const weapon = it.kind === 'gun' || it.kind === 'melee'; return { it, weapon, cat: label, price: weapon ? weaponPrice(it) : stackPrice(it) }; })
        .sort((a, b) => (a.weapon && b.weapon ? tierOf(a.it) - tierOf(b.it) : 0) || a.price - b.price),
    }));
    this.displays = this.catalog.flatMap((c) => c.items);
    // one short row of armory tables right next to the spawn, two categories per table
    const per = Math.ceil(this.catalog.length / 6);
    const groupsOf = [];
    for (let i = 0; i < this.catalog.length; i += per) groupsOf.push(this.catalog.slice(i, i + per));
    const cells = this.armoryCells(groupsOf.length);
    this.stations = groupsOf.map((cats, i) => {
      const cell = cells[i];
      if (!cell) return null;
      const pick = (c) => c.items.filter((d) => d.weapon).slice(-1).concat(c.items).slice(0, 1)[0]; // best weapon of each
      return { x: cell[0] * T + 16, y: cell[1] * T + 12, cats, label: cats[0].label, names: cats.map((c) => SHORT[c.label] || c.label), show: cats.map(pick).filter(Boolean) };
    }).filter(Boolean);
    this.stockedCount = this.displays.length;
    this.wanted = this.displays.length;
  }

  // Rows of up to 6 tables with one aisle row between them, in the closest free block to the spawn.
  armoryCells(n) {
    const g = this.g, map = g.map, ts = this.tableSet();
    const rowLen = Math.min(6, n), rows = Math.ceil(n / rowLen), H = rows * 3; // table, face, aisle per row
    const keepClear = [this.merchantPos, this.boardPos, this.storagePos, ...this.deployDoors.map((d) => ({ x: d.x + 16, y: d.y + 16 }))].filter(Boolean);
    const free = (cx, cy) => map.inBounds(cx, cy) && !map.blocking(cx, cy) && !map.dyn[map.idx(cx, cy)]
      && keepClear.every((k) => Math.hypot(cx * T + 16 - k.x, cy * T + 16 - k.y) > 40);
    const blockFree = (x0, y0) => {
      for (let y = y0; y < y0 + H; y++) for (let x = x0; x < x0 + rowLen; x++) if (!free(x, y)) return false;
      return true;
    };
    const sx = Math.floor(this.spawn.x / T), sy = Math.floor(this.spawn.y / T);
    let best = null, bd = Infinity;
    for (let y0 = 2; y0 < map.h - H - 1; y0++) for (let x0 = 2; x0 < map.w - rowLen - 2; x0++) {
      const d = Math.hypot(x0 + rowLen / 2 - sx, y0 + H / 2 - sy);
      if (d < bd && d > 2 && blockFree(x0, y0)) { bd = d; best = [x0, y0]; }
    }
    // the base's own tables, if there are enough of them close to the spawn (reachable from below)
    const own = this.existingTableCells().filter(([x, y]) => free(x, y + 1) || free(x, y + 2))
      .sort((a, b) => Math.hypot(a[0] - sx, a[1] - sy) - Math.hypot(b[0] - sx, b[1] - sy)).slice(0, n)
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    if ((!best || !ts || bd > 10) && own.length === n && own.every(([x, y]) => Math.hypot(x - sx, y - sy) < 14)) {
      const xs = own.map((c) => c[0]), ys = own.map((c) => c[1]);
      this.armoryArea = { x: Math.min(...xs) * T, y: Math.min(...ys) * T, w: (Math.max(...xs) - Math.min(...xs) + 1) * T, h: (Math.max(...ys) - Math.min(...ys) + 2) * T };
      return own;
    }
    if (!best || !ts) return this.existingTableCells().slice(0, n); // last resort
    const ctx = map.bot.getContext('2d');
    const top = map.resolve(ts.first + TABLE_TOP), face = map.resolve(ts.first + TABLE_FACE);
    const cells = [];
    for (let i = 0; i < n; i++) {
      const cx = best[0] + (i % rowLen), cy = best[1] + Math.floor(i / rowLen) * 3;
      map.drawTile(ctx, top, cx * T, cy * T);
      map.drawTile(ctx, face, cx * T, (cy + 1) * T);
      map.solid[map.idx(cx, cy)] = 1;
      cells.push([cx, cy]);
    }
    this.armoryArea = { x: best[0] * T, y: best[1] * T, w: rowLen * T, h: H * T };
    return cells;
  }

  // ---------- interaction ----------
  carried(it) { return this.g.slots.some((s) => s && s.item.name === it.name); }
  stored(it) { const P = this.g.profile; return !!P && P.storage.includes(it.name); }
  owned(it) { return this.carried(it) || this.stored(it); }
  syncInv() { const g = this.g, P = g.profile; P.inventory = g.slots.filter(Boolean).map((s) => s.item.name); P.save(); }

  describe(d) {
    const it = d.it;
    if (d.weapon) return this.carried(it) ? `${it.name} — in your inventory` : this.stored(it) ? `${it.name} — in your storage locker` : `Buy ${it.name} · T${tierOf(it)} — ${d.price}c`;
    if (it.kind === 'ammo') return `Buy ${it.name} ×${Math.round((this.g.data.ammoCap.get(it['sprite-id']) || 60) / 2)} — ${d.price}c`;
    return `Buy ${it.name} — ${d.price}c`;
  }

  interactable() {
    const pl = this.g.player;
    const close = (x, y, r = 30) => Math.hypot(x - pl.x, y - (pl.y - 10)) < r;
    if (close(this.merchant.x, this.merchant.y - 10, 34)) return { type: 'ext', label: 'Talk to the merchant (upgrades)', run: () => this.g.onMerchant && this.g.onMerchant() };
    if (close(this.storagePos.x, this.storagePos.y - 8, 34)) return { type: 'ext', label: 'Storage locker (stash weapons between runs)', run: () => this.g.onStorage && this.g.onStorage() };
    if (close(this.boardPos.x, this.boardPos.y - 8, 34)) return { type: 'ext', label: 'Mission board (next round, vote, ready)', run: () => this.g.onBoard && this.g.onBoard() };
    for (const d of this.deployDoors) {
      if (close(d.x + 16, d.y + 16, 40)) {
        const live = this.g.session && this.g.session.matchRunning();
        return { type: 'ext', label: live ? 'DEPLOY into the running match' : 'Deploy door (no match running)', run: () => live && this.g.onDeploy && this.g.onDeploy() };
      }
    }
    let best = null, bd = 30;
    for (const c of this.stations || []) {
      const dist = Math.hypot(c.x - pl.x, c.y - (pl.y - 14));
      if (dist < bd) { bd = dist; best = c; }
    }
    this.tip = null;
    if (best) return { type: 'ext', label: `ARMORY · ${best.names.join(' & ')} — browse & buy`, run: () => this.g.onArmory && this.g.onArmory(best.label) };
    return null;
  }

  take(d) {
    const g = this.g, P = g.profile, it = d.it;
    if (d.weapon) {
      if (this.owned(it)) { g.msg(this.describe(d)); return; }
      const free = g.slots.findIndex((s) => !s), room = P.storage.length < P.level('storageSlots');
      if (free < 0 && !room) { g.msg('Inventory and storage are full — free a slot at the locker first', '#ffb0b0'); return; }
      if (!P.spend(d.price)) { g.msg(`Not enough coins (${P.coins}/${d.price})`, '#ffb0b0'); return; }
      play.coin();
      if (free >= 0) {
        g.giveWeapon(it);
        if (it.kind === 'gun') g.ammo.claim(it['ammo-kind'], it['max-mag']);
        this.syncInv();
        g.msg(`Bought ${it.name} — it stays with you between runs`, '#7dff8a');
      } else {
        P.storage.push(it.name); P.save();
        g.msg(`Bought ${it.name} — inventory full, sent to your storage locker`, '#7dff8a');
      }
      return;
    }
    if (!P.spend(d.price)) { g.msg(`Not enough coins (${P.coins}/${d.price})`, '#ffb0b0'); return; }
    let ok = 0;
    if (it.kind === 'ammo') {
      const cap = g.data.ammoCap.get(it['sprite-id']) || 60;
      const used = new Set(g.slots.filter((s) => s && s.isGun).map((s) => s.ammoKind));
      ok = g.ammo.claim(it['sprite-id'], Math.round(cap / 2), g.ammo.slots.findIndex((s) => !used.has(s.kind)));
    } else if (it.kind === 'throwable' || it.kind === 'mine') ok = g.throwables.add(it, 1);
    else { g.items.set(it.name, (g.items.get(it.name) || 0) + 1); ok = 1; }
    if (!ok) { P.coins += d.price; P.save(); g.msg(it.kind === 'ammo' ? 'No free ammo slot (upgrade at the merchant)' : `${it.name}: carrying the maximum`, '#ffb0b0'); return; }
    g.msg(`Bought ${it.name}`, '#ffd36b');
    play.pickup();
  }

  // ---------- frame ----------
  update() {}
  objective() { return this.g.session ? this.g.session.lobbyBanner() : 'LOBBY'; }

  drawables(list, ctx) {
    const g = this.g;
    list.push([this.merchant.y, () => {
      this.merchant.animT = g.time * 1000;
      this.merchant.dir = Math.abs(g.player.x - this.merchant.x) > Math.abs(g.player.y - this.merchant.y) ? (g.player.x > this.merchant.x ? 'e' : 'w') : 's';
      this.merchant.draw(ctx, g.atlas.core, null);
      ctx.font = '7px Bebas, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd36b';
      ctx.fillText('MERCHANT', this.merchant.x, this.merchant.y - 30); ctx.textAlign = 'left';
    }]);
    list.push([this.storagePos.y, () => {
      const p = this.storagePos;
      ctx.fillStyle = '#2b3138'; ctx.fillRect(p.x - 11, p.y - 28, 22, 28);
      ctx.fillStyle = '#3a424c'; ctx.fillRect(p.x - 10, p.y - 27, 9, 26); ctx.fillRect(p.x + 1, p.y - 27, 9, 26);
      ctx.fillStyle = '#9aa'; ctx.fillRect(p.x - 3, p.y - 15, 2, 4); ctx.fillRect(p.x + 1, p.y - 15, 2, 4);
      ctx.font = '7px Bebas, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#9cd4ff';
      ctx.fillText('STORAGE', p.x, p.y - 32); ctx.textAlign = 'left';
    }]);
    list.push([this.boardPos.y, () => {
      const A = g.atlas.combat, f = A.frames['lobby_default_x_0'] || A.frames['home_default_x_0'];
      ctx.fillStyle = '#3a2a1a'; ctx.fillRect(this.boardPos.x - 12, this.boardPos.y - 26, 24, 18);
      ctx.fillStyle = '#5a4128'; ctx.fillRect(this.boardPos.x - 1, this.boardPos.y - 8, 2, 8);
      if (f) A.drawCentered(ctx, f, this.boardPos.x, this.boardPos.y - 17, 14 / Math.max(f[6], f[7]));
      ctx.font = '7px Bebas, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#9cd4ff';
      ctx.fillText('MISSION BOARD', this.boardPos.x, this.boardPos.y - 30); ctx.textAlign = 'left';
    }]);
  }

  drawGround(ctx) {
    const g = this.g, pl = g.player;
    if (this.armoryArea) {
      const a = this.armoryArea;
      ctx.font = '8px Bebas, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(a.x + a.w / 2 - 22, a.y - 24, 44, 10); ctx.fillStyle = '#ffd36b'; ctx.fillText('ARMORY', a.x + a.w / 2, a.y - 16); ctx.textAlign = 'left';
    }
    for (const c of this.stations || []) {
      (c.show || []).forEach((d, j) => g.data.drawIcon(ctx, d.it.name, c.x - 14 + j * 12, c.y - 10, 14));
      const near = Math.hypot(c.x - pl.x, c.y - pl.y) < 40;
      ctx.font = '5px sans-serif'; ctx.textAlign = 'center';
      c.names.forEach((name, j) => {
        const y = c.y + 12 + j * 7, w = ctx.measureText(name).width + 4;
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(c.x - w / 2, y, w, 7);
        ctx.fillStyle = near ? '#ffd36b' : '#9cd4ff'; ctx.fillText(name, c.x, y + 5.5);
      });
      ctx.textAlign = 'left';
    }
    const live = g.session && g.session.matchRunning();
    for (const d of this.deployDoors) {
      ctx.strokeStyle = live ? `rgba(125,255,138,${0.5 + 0.4 * Math.sin(g.time * 4)})` : 'rgba(150,150,150,0.4)';
      ctx.lineWidth = 2; ctx.strokeRect(d.x - 2, d.y - 2, 36, 36);
      ctx.font = '7px Bebas, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = live ? '#7dff8a' : '#999';
      ctx.fillText(live ? 'DEPLOY' : 'EXIT', d.x + 16, d.y - 5); ctx.textAlign = 'left';
    }
  }

  drawAir() {}
  lights(hole) {
    hole(this.merchant.x, this.merchant.y - 10, 90, 0.6);
    hole(this.boardPos.x, this.boardPos.y - 10, 90, 0.6);
    hole(this.storagePos.x, this.storagePos.y - 10, 90, 0.6);
  }
  drawScreen(ctx, W, H, u) {
    if (this.tip) {
      const t = this.tip;
      ctx.font = `${14 * u}px Bebas, Impact, sans-serif`;
      const head = `${t.name} · TIER ${t.tier} ${TIER_NAMES[t.tier] || ''}`.toUpperCase();
      ctx.font = `${11 * u}px system-ui, sans-serif`;
      const w = Math.max(ctx.measureText(t.line).width, 200 * u) + 24 * u, x = W / 2 - w / 2, y = H - 118 * u;
      ctx.fillStyle = 'rgba(8,10,14,0.88)'; ctx.fillRect(x, y, w, 42 * u);
      ctx.strokeStyle = TIER_COLORS[t.tier]; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, 42 * u - 2);
      ctx.textAlign = 'center';
      ctx.font = `${15 * u}px Bebas, Impact, sans-serif`; ctx.fillStyle = TIER_COLORS[t.tier]; ctx.fillText(head, W / 2, y + 17 * u);
      ctx.font = `${11 * u}px system-ui, sans-serif`; ctx.fillStyle = '#ccd'; ctx.fillText(t.line, W / 2, y + 34 * u);
      ctx.textAlign = 'left';
    }
    const obj = this.objective();
    if (!obj) return;
    ctx.font = `${15 * u}px Bebas, Impact, sans-serif`;
    ctx.textAlign = 'center';
    const mb = this.g.miniBox;
    let w = ctx.measureText(obj).width + 24 * u;
    // keep clear of a top-centre minimap (touch landscape)
    let y = mb && mb.x < W / 2 && mb.x + mb.w > W / 2 ? mb.y + mb.h + 6 : 24 + 50 * u, cx = W / 2;
    // and of a top-right minimap: slide left, or drop below it if there is no room
    if (mb && mb.x > W / 2 && cx + w / 2 > mb.x - 8 && y + 24 * u > mb.y) {
      const room = mb.x - 16;
      if (w > room) { ctx.font = `${Math.max(10, 15 * u * (room - 24 * u) / (w - 24 * u))}px Bebas, Impact, sans-serif`; w = Math.min(room, ctx.measureText(obj).width + 24 * u); }
      cx = Math.max(w / 2 + 8, mb.x - 8 - w / 2);
    }
    ctx.fillStyle = 'rgba(8,10,14,0.8)'; ctx.fillRect(cx - w / 2, y, w, 24 * u);
    ctx.fillStyle = '#9cd4ff'; ctx.fillText(obj, cx, y + 17 * u);
    ctx.textAlign = 'left';
  }
  placeMineItem() { return false; }
  addFire() {}
  grabbed() {}
  stop() {}
}
