// Pregame lobby: the "Base" map, cleaned up, with every weapon and item on display tables.
// Walk up to a table to buy/equip, talk to the merchant for permanent upgrades, use the mission
// board to host-pick or vote the next round, and walk out through the DEPLOY doors to join a
// match that is already running.
import { T } from './map.js';
import { Player } from './actors.js';
import { randomLook } from './npc.js';
import { weaponPrice, stackPrice } from './profile.js';
import { tierOf, statLine, TIER_COLORS, TIER_NAMES } from './tiers.js';
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

  // Extra display tables in open floor: rows of up to 6 tables, aisle rows in between.
  addTables(needCells) {
    const g = this.g, map = g.map, ts = this.tableSet();
    if (!ts) return [];
    const ctx = map.bot.getContext('2d');
    const top = map.resolve(ts.first + TABLE_TOP), face = map.resolve(ts.first + TABLE_FACE);
    const keepClear = [this.spawn, this.merchantPos, this.boardPos, ...this.deployDoors.map((d) => ({ x: d.x + 16, y: d.y + 16 }))].filter(Boolean);
    const free = (cx, cy) => map.inBounds(cx, cy) && !map.blocking(cx, cy) && !map.dyn[map.idx(cx, cy)]
      && keepClear.every((k) => Math.hypot(cx * T + 16 - k.x, cy * T + 16 - k.y) > 72);
    const cells = [];
    for (let cy = 2; cy < map.h - 3 && cells.length < needCells; cy++) {
      let run = 0;
      for (let cx = 1; cx < map.w - 1 && cells.length < needCells; cx++) {
        const ok = free(cx, cy) && free(cx, cy - 1) && free(cx, cy + 1) && free(cx, cy + 2) && run < 6;
        if (ok) {
          run++;
          cells.push([cx, cy]);
          map.drawTile(ctx, top, cx * T, cy * T);
          map.drawTile(ctx, face, cx * T, (cy + 1) * T);
          map.solid[map.idx(cx, cy)] = 1;
        } else if (run) { run = 0; cx += 1; } // aisle between segments
      }
      if (cells.length && cells[cells.length - 1][1] === cy) cy += 2; // aisle rows below a table row
    }
    return cells;
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
    const needSpots = groups.reduce((n, [, l]) => n + l.length, 0);
    // two items per table cell; every group starts on a fresh cell
    let cells = this.existingTableCells();
    const needCells = groups.reduce((n, [, l]) => n + Math.ceil(l.length / 2), 0);
    if (cells.length < needCells) cells = cells.concat(this.addTables(needCells - cells.length + 4));
    let ci = 0;
    for (const [label, list] of groups) {
      if (ci >= cells.length) break;
      this.labels.push({ text: label, x: cells[ci][0] * T + 16, y: cells[ci][1] * T - 4 });
      for (let k = 0; k < list.length; k += 2) {
        if (ci >= cells.length) break;
        const [cx, cy] = cells[ci++];
        list.slice(k, k + 2).forEach((it, j) => {
          const weapon = it.kind === 'gun' || it.kind === 'melee';
          this.displays.push({ it, x: cx * T + 8 + j * 16, y: cy * T + 12, weapon, price: weapon ? weaponPrice(it) : stackPrice(it) });
        });
      }
    }
    this.stockedCount = this.displays.length;
    this.wanted = needSpots;
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
    let best = null, bd = 26;
    for (const d of this.displays) {
      const dist = Math.hypot(d.x - pl.x, d.y - (pl.y - 14));
      if (dist < bd) { bd = dist; best = d; }
    }
    this.tip = best && best.weapon ? { name: best.it.name, tier: tierOf(best.it), line: statLine(best.it), owned: this.owned(best.it) } : null;
    if (best) return { type: 'ext', label: this.describe(best), run: () => this.take(best) };
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
    for (const d of this.displays) {
      g.data.drawIcon(ctx, d.it.name, d.x - 8, d.y - 8, 16);
      if (Math.hypot(d.x - pl.x, d.y - pl.y) < 90) {
        const owned = d.weapon && this.owned(d.it);
        ctx.font = '5px sans-serif'; ctx.textAlign = 'center';
        ctx.fillStyle = owned ? '#7dff8a' : d.weapon ? TIER_COLORS[tierOf(d.it)] : '#ffd36b';
        ctx.fillText(owned ? '✓' : (d.weapon ? 'T' + tierOf(d.it) + ' ' : '') + d.price + 'c', d.x, d.y + 12);
        ctx.textAlign = 'left';
      }
    }
    ctx.font = '7px Bebas, sans-serif';
    for (const l of this.labels) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; const w = ctx.measureText(l.text).width + 6; ctx.fillRect(l.x - 3, l.y - 8, w, 9); ctx.fillStyle = '#9cd4ff'; ctx.fillText(l.text, l.x, l.y); }
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
    const w = ctx.measureText(obj).width + 24 * u, y = 24 + 50 * u;
    ctx.fillStyle = 'rgba(8,10,14,0.8)'; ctx.fillRect(W / 2 - w / 2, y, w, 24 * u);
    ctx.fillStyle = '#9cd4ff'; ctx.fillText(obj, W / 2, y + 17 * u);
    ctx.textAlign = 'left';
  }
  placeMineItem() { return false; }
  addFire() {}
  grabbed() {}
  stop() {}
}
