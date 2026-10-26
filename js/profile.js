// Persistent player profile (survives between rounds and reloads): banked coins, owned weapons,
// permanent weapon upgrades and inventory-size upgrades. Also the slot-based ammo bag and the
// separate throwables pouch used in matches and the lobby.

import { tierOf, weaponStats } from './tiers.js';

const STORE = 'tlcr-profile-v1';

// Difficulty scales mobs and the coin payout.
export const DIFFICULTY = {
  Easy: { hp: 0.7, dmg: 0.65, spawn: 0.8, coins: 0.6, desc: 'Weaker, fewer infected' },
  Normal: { hp: 1, dmg: 1, spawn: 1, coins: 1, desc: 'The intended experience' },
  Hard: { hp: 1.35, dmg: 1.3, spawn: 1.25, coins: 1.6, desc: 'Tougher hordes, better pay' },
  Nightmare: { hp: 1.8, dmg: 1.7, spawn: 1.5, coins: 2.4, desc: 'For the stocked and upgraded' },
};

// Inventory-size upgrades bought from the merchant.
export const SLOT_UPGRADES = {
  weaponSlots: { base: 3, max: 5, costs: [700, 1400], label: 'Weapon slot' },
  ammoSlots: { base: 2, max: 6, costs: [250, 500, 900, 1400], label: 'Ammo slot' },
  throwCap: { base: 1, max: 4, costs: [300, 650, 1100], label: 'Throwables pouch (+50% carry)' },
  storageSlots: { base: 4, max: 12, costs: [250, 400, 600, 900, 1300, 1900, 2700, 3800], label: 'Lobby storage slot' },
};

// Weapon prices by class tier (unlock is permanent; picking an owned weapon off a table is free).
// Weapon price: tier base, scaled 0.85-1.15x by where its score sits inside the tier.
const TIER_PRICE = [0, 150, 380, 800, 1500, 2800];
const TIER_LO = [0, 0, 85, 125, 180, 270], TIER_HI = [0, 85, 125, 180, 270, 500];
export function weaponPrice(item) {
  const t = tierOf(item) || 1, s = weaponStats(item).score;
  const k = Math.max(0, Math.min(1, (s - TIER_LO[t]) / Math.max(1, TIER_HI[t] - TIER_LO[t])));
  return Math.round((TIER_PRICE[t] * (0.85 + 0.3 * k)) / 10) * 10;
}
// Per-purchase prices for stackables.
export function stackPrice(item) {
  if (item.kind === 'ammo') return 40;
  if (item.kind === 'throwable') return /molotov/i.test(item.name) ? 35 : 60;
  if (item.kind === 'mine') return 80;
  if (item.kind === 'consumable') return Math.round(30 + 90 * (item['hp-heal'] || 0) + 25 * ((item.cure || 0) & 2 ? 1 : 0));
  return 50;
}

// Match payout: kills, time alive, objective, difficulty.
export function payout({ kills, alive, won, difficulty }) {
  const d = DIFFICULTY[difficulty] || DIFFICULTY.Normal;
  const k = kills * 3;
  const t = Math.floor(alive / 10) * 2;
  const w = won ? 150 : 0;
  return { kills: k, time: t, win: w, mult: d.coins, total: Math.round((k + t + w) * d.coins) };
}

export class Profile {
  constructor() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* no storage */ }
    this.coins = s.coins ?? 300;
    this.owned = new Set(s.owned || []);                // legacy (pre-inventory saves)
    this.inventory = s.inventory || ['Beretta92'];     // weapons carried between runs
    this.storage = s.storage || [...this.owned].filter((n) => n !== 'Beretta92').slice(0, 4); // lobby locker
    this.prefs = s.prefs || {};                        // saved class / survivor
    this.upgrades = s.upgrades || {};       // itemId -> { kind: level }
    this.inv = { weaponSlots: 0, ammoSlots: 0, throwCap: 0, storageSlots: 0, ...(s.inv || {}) }; // purchased levels
    this.stats = s.stats || { matches: 0, kills: 0, best: 0 };
  }
  save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ coins: this.coins, owned: [...this.owned], inventory: this.inventory, storage: this.storage, prefs: this.prefs, upgrades: this.upgrades, inv: this.inv, stats: this.stats }));
    } catch { /* no storage */ }
  }
  level(kind) { const u = SLOT_UPGRADES[kind]; return u.base + this.inv[kind]; }
  nextCost(kind) { return SLOT_UPGRADES[kind].costs[this.inv[kind]] ?? null; }
  buyLevel(kind) {
    const c = this.nextCost(kind);
    if (c == null || this.coins < c) return false;
    this.coins -= c; this.inv[kind]++; this.save();
    return true;
  }
  ups(itemId) { return this.upgrades[itemId] || (this.upgrades[itemId] = {}); }
  spend(n) { if (this.coins < n) return false; this.coins -= n; this.save(); return true; }
}

// Ammo lives in typed slots. A slot keeps its type (even when empty) until swapped out by hand.
export class AmmoBag {
  constructor(n, capOf) { this.n = n; this.capOf = capOf; this.slots = []; }
  slotOf(kind) { return this.slots.find((s) => s.kind === kind); }
  get(kind) { const s = this.slotOf(kind); return s ? s.count : 0; }
  has(kind) { return !!this.slotOf(kind); }
  cap(kind) { return this.capOf(kind); }
  free() { return this.slots.length < this.n; }
  set(kind, v) {
    const s = this.slotOf(kind);
    if (s) s.count = Math.max(0, Math.min(this.cap(kind), v));
    else if (v > 0 && this.free()) this.slots.push({ kind, count: Math.min(this.cap(kind), v) });
  }
  // Auto top-up only fills a slot that already holds this type.
  topUp(kind, v) {
    const s = this.slotOf(kind);
    if (!s) return 0;
    const add = Math.max(0, Math.min(this.cap(kind) - s.count, v));
    s.count += add;
    return add;
  }
  // Manual pickup: claim a free slot (or the given slot to replace). Returns amount taken.
  claim(kind, v, replaceIdx = -1) {
    if (this.has(kind)) return this.topUp(kind, v);
    if (this.free()) { this.slots.push({ kind, count: 0 }); return this.topUp(kind, v); }
    if (replaceIdx >= 0 && this.slots[replaceIdx]) { this.slots[replaceIdx] = { kind, count: 0 }; return this.topUp(kind, v); }
    return 0;
  }
  *[Symbol.iterator]() { for (const s of this.slots) yield [s.kind, s.count]; }
}

// Grenades, mines, molotovs… counted separately; the selected one is thrown/placed.
export class Throwables {
  constructor(capMult = 1) { this.counts = new Map(); this.sel = null; this.capMult = capMult; }
  cap(item) { return Math.max(1, Math.round((item['max-mag'] || 3) * this.capMult)); }
  add(item, n) {
    const have = this.counts.get(item.name) || 0;
    const add = Math.max(0, Math.min(this.cap(item) - have, n));
    if (add) this.counts.set(item.name, have + add);
    if (!this.sel || !this.counts.get(this.sel)) this.sel = item.name;
    return add;
  }
  take() {
    const n = this.counts.get(this.sel) || 0;
    if (!n) return null;
    this.counts.set(this.sel, n - 1);
    const name = this.sel;
    if (n - 1 <= 0) this.cycle();
    return name;
  }
  cycle() {
    const names = [...this.counts].filter(([, n]) => n > 0).map(([k]) => k);
    if (!names.length) { this.sel = null; return null; }
    const i = names.indexOf(this.sel);
    this.sel = names[(i + 1) % names.length];
    return this.sel;
  }
  total() { let t = 0; for (const n of this.counts.values()) t += n; return t; }
}
