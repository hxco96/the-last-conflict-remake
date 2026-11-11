// Indexes over the original game tables (item_db, mob_db, outfits, drop tables, upgrades, perks).

export const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Balance pass (design, from playtest audit): target time-to-kill tiers on a 200 HP zed —
// pistols/SMGs 1.2-1.8 s, ARs/shotguns/rifles 0.6-1.0 s, LMG/magnum/bow 0.4-0.7 s, explosives scarce.
const MELEE_TIERS = {
  light: { names: /^(knife|machete|chain)$/i, damage: 40, 'fire-rate': 300, pierce: 1 },
  medium: { names: /^(2b4|baseball-bat|crowbar|wrench|steel-pipe|iron-bar|hoe|shovel|axe|barbed-wire-bat|cello)$/i, damage: 70, 'fire-rate': 550, pierce: 1 },
  heavy: { names: /^(fire-axe|sledgehammer|scythe|glave|katana|sword)$/i, damage: 120, 'fire-rate': 900, pierce: 2 },
  saw: { names: /^chainsaw$/i, damage: 25, 'fire-rate': 100, pierce: 2 },
  shield: { names: /^riot-shield/i, damage: 40, 'fire-rate': 500, pierce: 3 },
};
const OVERRIDES = {
  Beretta92: { 'reload-time': 1600 }, peacemaker: { damage: 25 }, 'custom-army': { damage: 25 },
  MG4: { damage: 22 }, Bow: { pierce: 1 }, Bowgun: { spread: 1, 'spread-angle': 0 },
  'Rocket-Launcher': { 'max-mag': 1, mag: 1 }, Railgun: { damage: 2000, 'reload-time': 6000 },
};
function setStat(it, k, v, ups) {
  const old = it[k];
  it[k] = v;
  const u = ups && ups.find((x) => x.kind === k);
  if (u && old) u.levels = u.levels.map(([val, cost]) => [Math.max(1, Math.round((val * v) / old)), cost]);
}
function balance(items, upgrades) {
  for (const it of new Set(items.values())) {
    const ups = upgrades.get(it['sprite-id']);
    if (it.kind === 'melee') {
      for (const t of Object.values(MELEE_TIERS)) if (t.names.test(it.name)) { for (const k of ['damage', 'fire-rate', 'pierce']) setStat(it, k, t[k], ups); break; }
    }
    for (const [k, v] of Object.entries(OVERRIDES[it.name] || {})) setStat(it, k, v, ups);
  }
}

export class GameData {
  constructor(assets) {
    const t = assets.tables;
    this.assets = assets;
    this.items = new Map();      // id -> item record
    this.itemsByName = new Map(); // normalized name -> item record
    for (const it of t.item_db) {
      if (it._tag === 'weapon') {
        this.items.set(it['sprite-id'], it);
        this.itemsByName.set(norm(it.name), it);
      }
    }
    this.ammoCap = new Map(); // ammo kind id -> max carried
    for (const it of t.item_db) if (it._tag === 'ammo') this.ammoCap.set(it['sprite-id'], it['max-mag']);
    this.names = new Map(t.id_lookup.map(([id, name]) => [id, name]));
    for (const [id, name] of this.names) if (id >= 30000 && id < 30100) this.itemsByName.set(norm(name), { name, kind: 'ammo', 'sprite-id': id });

    this.upgrades = new Map(t.wep_upgrades.map((u) => [u.id, u.ups]));
    balance(this.items, this.upgrades);
    this.mobs = new Map(t.mob_db.map((m) => [m.id, m]));
    this.outfits = new Map(t.outfits.map(([id, list]) => [id, list]));
    this.perks = t.perkinfo_en.map((p) => (p.value === 'HeavyHits' ? { ...p, desc: 'Heal 4 hp per melee kill' } : p)).concat(CUSTOM_PERKS);
    this.recipes = t.crafting_recipes.map(([[out, n], parts]) => ({ out, n, parts }));
    // Drop tables (order as shipped): 0 ammo boxes, 1 on-kill, 2 guns, 3 melee.
    this.drops = t.drop_chances;

    // Item icons: map-editor tilesets list one frame per item, named after the item.
    this.icons = new Map();
    for (const [tsName, ts] of Object.entries(assets.tilesets)) {
      if (!ts.names || !ts.atlas || !tsName.startsWith('items_')) continue;
      for (const fr of ts.names) {
        const base = fr.name.split('_')[0];
        const key = norm(base);
        if (!this.icons.has(key) || /_default_/.test(fr.name)) this.icons.set(key, { ts, fr });
      }
    }
  }

  item(nameOrId) {
    if (typeof nameOrId === 'number') return this.items.get(nameOrId) || null;
    return this.itemsByName.get(norm(nameOrId)) || null;
  }

  icon(name) {
    return this.icons.get(norm(name)) || null;
  }

  drawIcon(ctx, name, x, y, size = 32) {
    const ic = this.icon(name);
    if (!ic) return false;
    const page = this.assets.tilePages[ic.ts.atlas.page];
    ctx.drawImage(page, ic.ts.atlas.x + ic.fr.x, ic.ts.atlas.y + ic.fr.y, ic.fr.w, ic.fr.h, x, y, size, size);
    return true;
  }

  rollDrop(table, rng = Math.random) {
    const list = this.drops[table];
    let total = 0;
    for (const e of list) total += e.chance;
    let r = rng() * total;
    for (const e of list) { r -= e.chance; if (r <= 0) return e.name === 'None' ? null : e; }
    return null;
  }
}

// Perks added by this remake (the original table has no entry for them).
const CUSTOM_PERKS = [
  ['Deadeye', 'Sniper', 'Rifle rounds pierce one extra zed'],
  ['LongShot', 'Sniper', 'Rifle damage rises up to 50% with distance'],
  ['Focus', 'Sniper', 'Standing still builds up to +30% rifle crit chance'],
  ['QuickBolt', 'Sniper', 'Rifles reload 30% faster'],
  ['ColdBlood', 'Sniper', 'Gun kills with a rifle refund a round'],
  ['Sprinter', 'Scout', 'Move 12% faster'],
  ['Lungs', 'Scout', 'Running drains stamina 40% slower'],
  ['Evasive', 'Scout', '15% chance to dodge a bite'],
  ['Vaulter', 'Scout', 'Jumping costs no stamina'],
  ['Adrenaline', 'Scout', 'Move 20% faster below 40% health'],
  ['Overwatch', 'Gunner', 'SMG, AR and LMG damage +20%'],
  ['AmmoSaver', 'Gunner', '30% chance a shot costs no ammo'],
  ['Plated', 'Gunner', 'Take 15% less damage'],
  ['FastMags', 'Gunner', 'Reload 30% faster'],
  ['Overdrive', 'Gunner', 'Guns fire 25% faster in frenzy'],
  ['Forager', 'Scavenger', 'Zeds drop loot 50% more often'],
  ['Pockets', 'Scavenger', 'Ammo pickups give 25% more'],
  ['Resourceful', 'Scavenger', '35% chance a healing item is not used up'],
  ['Lucky', 'Scavenger', '+10% crit chance with guns'],
].map(([value, cls, desc]) => ({ class: cls, value, name: value.replace(/([a-z])([A-Z])/g, '$1 $2'), 'sprite-id': 10151, desc, active: false }));
