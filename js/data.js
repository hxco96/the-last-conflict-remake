// Indexes over the original game tables (item_db, mob_db, outfits, drop tables, upgrades, perks).

export const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

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

    this.mobs = new Map(t.mob_db.map((m) => [m.id, m]));
    this.outfits = new Map(t.outfits.map(([id, list]) => [id, list]));
    this.upgrades = new Map(t.wep_upgrades.map((u) => [u.id, u.ups]));
    this.perks = t.perkinfo_en;
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
