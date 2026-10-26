// Builds the remake's asset folder from an extracted copy of the original game.
// Usage: node tools/extract.js <path-to-extracted-tlcr-folder>
// Requires Node 24+ (node:sqlite, zlib.zstdDecompressSync).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const { parse, plain } = require('./rktd');

const SRC = path.resolve(process.argv[2] || '../tlcr');
const A = path.join(SRC, 'assets');
const OUT = path.join(__dirname, '..', 'assets');
// Single-floor classics, then multi-floor maps (stairs between floor_N groups). City (315x345) is left out: too big to prerender.
const MAP_IDS = [4, 20, 13, 60, 7, 2, 3, 5, 11, 62, 65, 1, 9, 17, 102, 89, 95, 103, 87, 93, 112];

const write = (rel, data) => {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
  console.log('wrote', rel, fs.statSync(p).size);
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const rktd = (name) => {
  const d = parse(fs.readFileSync(path.join(A, name + '.rktd'), 'utf8')).map(plain);
  return d.length === 1 ? d[0] : d;
};

// 1. Game data tables
const tables = {};
for (const n of ['mob_db', 'item_db', 'outfits', 'perkinfo_en', 'crafting_recipes', 'drop_chances', 'wep_upgrades', 'id_lookup', 'lightpats',
  'spawn_levels_zeds', 'spawn_levels_spiders', 'spawn_levels_chaos', 'spawn_levels_mechs', 'spawn_levels_bossrush']) tables[n] = rktd(n);
write('data/tables.json', tables);

// 2. Sprite atlases -> compact {name: [x, y, w, h, offX, offY, srcW, srcH]}
const compact = (file) => {
  const a = readJson(file);
  const o = {};
  for (const f of a.frames) {
    const r = f.frame, s = f.spriteSourceSize, z = f.sourceSize;
    o[f.filename] = [r.x, r.y, r.w, r.h, s.x, s.y, z.w, z.h];
  }
  return { image: a.meta.image, frames: o };
};
for (const n of ['all_infecteds', 'core_custom', 'combat_anims', 'all_lights']) {
  write('img/' + n + '.json', compact(path.join(A, n + '.json')));
  fs.copyFileSync(path.join(A, n + '.png'), path.join(OUT, 'img', n + '.png'));
}
// Mech robots ship as separate Aseprite exports (assets/robots/*.json + png)
const robots = [];
for (const f of fs.readdirSync(path.join(A, 'robots')).filter((f) => f.endsWith('.json'))) {
  const n = f.replace(/.json$/, '');
  write('img/robots/' + n + '.json', compact(path.join(A, 'robots', f)));
  fs.copyFileSync(path.join(A, 'robots', n + '.png'), path.join(OUT, 'img', 'robots', n + '.png'));
  robots.push(n);
}
write('img/robots/index.json', robots);
for (const n of ['all_tilesets-0', 'all_tilesets-1']) fs.copyFileSync(path.join(A, 'map_editor', n + '.png'), path.join(OUT, 'img', n + '.png'));
fs.copyFileSync(path.join(A, 'titlescreen.png'), path.join(OUT, 'img', 'titlescreen.png'));
fs.copyFileSync(path.join(A, 'BebasNeue-Regular.ttf'), path.join(OUT, 'img', 'BebasNeue-Regular.ttf'));

// 3. Tilesets: definitions (from data.db) + where each tileset image sits in the packed atlas pages
const db = new DatabaseSync(path.join(A, 'data.db'), { readOnly: true });
const tsDefs = {};
for (const r of db.prepare('select name, data from tilesets').all()) tsDefs[r.name.replace(/\.tsj$/, '')] = JSON.parse(r.data);
const pages = {};
['all_tilesets-0', 'all_tilesets-1'].forEach((p, page) => {
  for (const f of readJson(path.join(A, 'map_editor', p + '.json')).frames) pages[f.filename] = { page, x: f.frame.x, y: f.frame.y };
});
// Item tilesets carry per-tile frame names (= item names) in map_editor/tilesets/*.json
const tileNames = {};
for (const f of fs.readdirSync(path.join(A, 'map_editor', 'tilesets'))) {
  const j = readJson(path.join(A, 'map_editor', 'tilesets', f));
  tileNames[f.replace(/\.json$/, '')] = j.frames.map((fr) => ({ name: fr.filename, x: fr.frame.x, y: fr.frame.y, w: fr.frame.w, h: fr.frame.h }));
}
const tilesets = {};
for (const [name, d] of Object.entries(tsDefs)) {
  const tiles = {};
  for (const t of d.tiles || []) {
    const e = {};
    if (t.type) e.type = t.type;
    for (const p of t.properties || []) if (p.name !== 'bypath') e[p.name] = p.value;
    if (Object.keys(e).length) tiles[t.id] = e;
  }
  tilesets[name] = {
    tw: d.tilewidth, th: d.tileheight, cols: d.columns, count: d.tilecount, iw: d.imagewidth, ih: d.imageheight,
    align: d.objectalignment || 'unspecified', atlas: pages[name] || null, tiles, names: tileNames[name] || null,
  };
}
write('data/tilesets.json', tilesets);

// NPC/player barks (English column only)
const barks = {};
for (const t of ['say_swarmed', 'say_dist', 'say_relief', 'say_leader_down', 'say_help_downed', 'say_quick_thanks', 'say_caged_help', 'say_caged_free']) {
  barks[t.slice(4)] = db.prepare('select eng from ' + t).all().map((r) => r.eng).filter(Boolean);
}
// NPC names (most common 400 of each)
barks.names_m = db.prepare('select name from boy_names order by id limit 400').all().map((r) => r.name);
barks.names_f = db.prepare('select name from girl_names order by id limit 400').all().map((r) => r.name);
write('data/barks.json', barks);

// 4. Maps (Tiled JSON, zstd-compressed in data.db)
const index = [];
for (const mid of MAP_IDS) {
  const r = db.prepare('select mid, name, width, height, data from maps where mid = ?').get(mid);
  const m = JSON.parse(zlib.zstdDecompressSync(r.data).toString('utf8'));
  m.tilesets = m.tilesets.map((t) => ({ firstgid: t.firstgid, name: t.source.split('/').pop().replace(/\.tsj$/, '') }));
  const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  write('maps/' + slug + '.json', m);
  const floors = Math.max(1, m.layers.filter((l) => /^floor_\d+$/.test(l.name)).length);
  index.push({ id: mid, name: r.name, file: slug + '.json', w: r.width, h: r.height, floors });
}
write('maps/index.json', index);

// 5. Audio: FMOD banks (FSB5 Vorbis) -> .ogg files + manifest
const { loadSetupTable, parseFsb5, sampleToOgg } = require('./fsb5');
const setups = loadSetupTable(path.join(__dirname, 'vendor', 'vorbis_codebooks_fsb.h'));
const audio = { sfx: [], music: [] };
for (const [bank, kind] of [['sfx.bank', 'sfx'], ['music.bank', 'music']]) {
  const buf = fs.readFileSync(path.join(A, bank));
  const { samples } = parseFsb5(buf, buf.indexOf('FSB5'));
  const dir = path.join(OUT, 'audio', kind);
  fs.mkdirSync(dir, { recursive: true });
  const used = new Set();
  for (const s of samples) {
    let slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sample';
    while (used.has(slug)) slug += '-x';
    used.add(slug);
    try {
      const { ogg, duration } = sampleToOgg(s, setups);
      fs.writeFileSync(path.join(dir, slug + '.ogg'), ogg);
      audio[kind].push({ name: s.name, file: `${kind}/${slug}.ogg`, dur: +duration.toFixed(3), ch: s.channels, rate: s.freq, loop: s.loop });
    } catch (e) {
      console.warn('skip', bank, s.name, e.message);
    }
  }
  console.log('audio', kind, audio[kind].length, 'files');
}
// custom tracks added by hand (not in the original banks) live next to the exported ones
for (const t of [{ name: 'Sake', file: 'music/sake.m4a' }]) if (fs.existsSync(path.join(OUT, 'audio', t.file))) audio.music.push({ ...t, dur: 0, ch: 2, rate: 44100, loop: null, custom: true });
write('audio/index.json', audio);
