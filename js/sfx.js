// Audio: the original FMOD samples (sfx.bank / music.bank, converted to .ogg by tools/fsb5.js),
// played through Web Audio with distance attenuation and stereo pan. A tiny synth fills in only
// while a sample is still loading or if a browser cannot decode Ogg Vorbis.

export const sfx = { muted: false, master: 0.9, sfxVol: 0.9, musicVol: 0.45, listener: { x: 0, y: 0 } };

let ac = null, master = null, sfxBus = null, noise = null;
let index = null;
const byName = new Map();    // sample name -> manifest entry
const buffers = new Map();   // name -> AudioBuffer | Promise | 'fail'
const recent = new Map();    // name -> last start time (anti-spam)
let musicEl = null, musicWant = null, musicList = [], musicName = '';

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

export async function initAudio(url = 'assets/audio/index.json') {
  try {
    index = await (await fetch(url)).json();
    for (const e of [...index.sfx, ...index.music]) byName.set(e.name, e);
  } catch { index = { sfx: [], music: [] }; }
}

function ensure() {
  if (ac) return ac;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ac = new AC();
  master = ac.createGain();
  master.connect(ac.destination);
  sfxBus = ac.createGain();
  sfxBus.connect(master);
  applyVolumes();
  noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ac;
}

export function applyVolumes() {
  if (master) master.gain.value = sfx.muted ? 0 : sfx.master;
  if (sfxBus) sfxBus.gain.value = sfx.sfxVol;
  if (musicEl) musicEl.volume = sfx.muted ? 0 : Math.min(1, sfx.master * sfx.musicVol);
}

export function setMuted(m) { sfx.muted = m; applyVolumes(); }

export function unlockAudio() {
  const a = ensure();
  if (a && a.state === 'suspended') a.resume();
  if (!unlockAudio.preloaded && index) {
    unlockAudio.preloaded = true;
    // warm the cache with every effect in the background (≈6 MB)
    let i = 0;
    const next = () => { if (i < index.sfx.length) load(index.sfx[i++].name).finally(next); };
    for (let k = 0; k < 4; k++) next();
  }
  if (musicWant && (!musicEl || musicEl.paused)) music(musicWant, true);
}

function load(name) {
  const have = buffers.get(name);
  if (have) return have instanceof Promise ? have : Promise.resolve(have);
  const e = byName.get(name);
  if (!e || !ensure()) return Promise.resolve(null);
  const p = fetch('assets/audio/' + e.file).then((r) => r.arrayBuffer()).then((b) => new Promise((res, rej) => ac.decodeAudioData(b, res, rej)))
    .then((buf) => { buffers.set(name, buf); return buf; })
    .catch(() => { buffers.set(name, 'fail'); return null; });
  buffers.set(name, p);
  return p;
}

// Names matching a pattern (cached).
const groupCache = new Map();
export function group(re) {
  const key = String(re);
  if (!groupCache.has(key)) groupCache.set(key, index ? index.sfx.map((e) => e.name).filter((n) => re.test(n)) : []);
  return groupCache.get(key);
}

// Play one sample (or a random one from a list). opts: vol, x/y (world position), rate, spread, gap.
export function sample(names, opts = {}) {
  if (sfx.muted || !ensure() || !index) return false;
  const list = Array.isArray(names) ? names : [names];
  if (!list.length) return false;
  const name = list[Math.floor(Math.random() * list.length)];
  const now = ac.currentTime;
  if (opts.gap && now - (recent.get(name) || -9) < opts.gap) return true;
  let vol = opts.vol ?? 1, pan = 0;
  if (opts.x !== undefined) {
    const dx = opts.x - sfx.listener.x, dy = opts.y - sfx.listener.y, d = Math.hypot(dx, dy);
    const range = opts.range || 520;
    if (d > range) return true;
    vol *= Math.pow(1 - d / range, 1.6);
    pan = Math.max(-0.8, Math.min(0.8, dx / 320));
  }
  if (vol < 0.01) return true;
  const buf = buffers.get(name);
  if (!(buf instanceof AudioBuffer)) { load(name); return false; }
  recent.set(name, now);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = (opts.rate || 1) * (1 + (Math.random() - 0.5) * (opts.spread ?? 0.08));
  const g = ac.createGain();
  g.gain.value = vol;
  let node = src.connect(g);
  if (pan && ac.createStereoPanner) { const p = ac.createStereoPanner(); p.pan.value = pan; node = node.connect(p); }
  node.connect(sfxBus);
  src.start(now + (opts.delay || 0));
  return true;
}

// Looping ambience (weather, helicopter rotor). Returns null until the sample has loaded.
export function loop(name, vol = 0.3) {
  if (!ensure() || !index) return null;
  const buf = buffers.get(name);
  if (!(buf instanceof AudioBuffer)) { load(name); return null; }
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const g = ac.createGain();
  g.gain.value = vol;
  src.connect(g).connect(sfxBus);
  src.start();
  return { gain: g, stop() { try { src.stop(); } catch { /* already stopped */ } } };
}

// ---------- synth fallback ----------
function burst({ dur = 0.1, freq = 1200, q = 0.8, vol = 0.4, type = 'lowpass' }) {
  if (sfx.muted || !ensure()) return;
  const t = ac.currentTime, src = ac.createBufferSource();
  src.buffer = noise;
  const f = ac.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(sfxBus);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}

// ---------- music ----------
export function music(name, force = false) {
  musicWant = name;
  if (!index || !index.music.length) return;
  if (!force && musicName === name && musicEl && !musicEl.paused) return;
  const pickNext = () => {
    if (name !== 'playlist') return byName.get(name);
    if (!musicList.length) musicList = index.music.filter((m) => !/save room|secure place|room\(re3\)|boss/i.test(m.name)).sort(() => Math.random() - 0.5);
    return musicList.shift();
  };
  const e = pickNext();
  if (!e) return;
  if (!musicEl) {
    musicEl = new Audio();
    musicEl.preload = 'auto';
    musicEl.addEventListener('ended', () => { if (musicWant === 'playlist') music('playlist', true); else { musicEl.currentTime = 0; musicEl.play().catch(() => {}); } });
  }
  musicName = name;
  musicEl.src = 'assets/audio/' + e.file;
  applyVolumes();
  musicEl.play().catch(() => { /* waits for a user gesture; unlockAudio retries */ });
}

export function nowPlaying() { return musicEl && !musicEl.paused ? musicEl.src.split('/').pop() : null; }

// ---------- game-facing helpers ----------
const G = {
  dry: () => ['empty-clip-fire'],
  swing: () => ['melee-swing'],
  knife: () => ['slash-knife'],
  chainsaw: () => ['chainsaw_1'],
  flesh: () => group(/^zombie-hit-|^creature_hurt_/),
  explode: () => ['grenade-explode', 'mine-explode'],
  throwNade: () => group(/grenade-throw/),
  heal: () => ['heal_sound'],
  pickup: () => ['pickup'],
  coin: () => ['collect_coins_small'],
  doorOpen: () => ['door-open-1', 'door_open'],
  doorClose: () => ['door-close-1', 'door_close'],
  doorBash: () => group(/^406494__anthousai|^cage_hit/),
  woodHit: () => ['wood-hit', 'wood1', 'wood2'].concat(group(/hit-tree/)),
  woodBreak: () => group(/wood-break/),
  hammer: () => ['hammer-fix'],
  flashlight: () => group(/flashlight-click/),
  ricochet: () => group(/^bullet_ricochet/),
  casing: () => group(/^casingfall/),
  step: () => ['step-1', 'step-2'],
  crit: () => ['crit'],
  radio: () => ['radiostatic', 'walkietalkie'],
  frenzy: () => ['charge-up'],
  hurtM: () => group(/mattgarkusha__grunts/),
  hurtF: () => group(/ameangelofsin__dying-female/),
  dieM: () => group(/^universfield-male-death-scream/),
  dieF: () => group(/^girl_death_/),
  menuMove: () => ['menu-move'],
  menuClick: () => ['click-button', 'click-button-2'],
  menuOpen: () => ['menu-open'],
  menuBack: () => ['menu-cancel'],
};

// Monster families by mob_db name.
function family(name) {
  if (/^dog/.test(name)) return 'dog';
  if (/^crow/.test(name)) return 'crow';
  if (/^spider/.test(name)) return 'spider';
  if (/^seeker/.test(name)) return 'seeker';
  if (/^(rep-|t0|gaia|abyss|chimera|corvus|plant)/.test(name)) return 'stalker';
  if (/(-f-|^fat-f|zed-f)/.test(name)) return 'zedF';
  return 'zedM';
}
const MOB = {
  zedM: { moan: /^zed-m-moan-|^zombie-moan-/, attack: /^z-bite-|^zombie-attack$/, death: /^zombie-death-/, pain: /^zombie-pain-/ },
  zedF: { moan: /^zed-f-growl-/, attack: /^zombie_attack_female$|^z-bite-/, death: /^zombie_death_female_/, pain: /^zombie-pain-/ },
  dog: { moan: /^dog_moan$/, attack: /^dog_attack/, death: /^dog_death$/, pain: /^dog_hurt_/ },
  crow: { moan: /^crow-moan/, attack: /^crow-moan/, death: /^crow-moan/, pain: /^crow-moan/ },
  spider: { moan: /^spider-moan-/, attack: /^spider-attack$/, death: /^spider-death/, pain: /^spider-moan-/ },
  seeker: { moan: /^seeker_moan_/, attack: /^seeker_attack$/, death: /^seeker_death/, pain: /^seeker_moan_/ },
  stalker: { moan: /^stalker-moan-/, attack: /^stalker-attack/, death: /^stalker-death-/, pain: /^stalker-moan-/ },
};

// Weapon -> original fire sample, by name similarity with a per-class fallback.
const fireCache = new Map();
const CLASS_FIRE = { handgun: 'handgun-fire-1', smg: 'smg-fire-1', ar: 'm4-fire', lmg: 'm249-fire', shotgun: 'pump-shotgun-fire-1', rifle: 'm40-fire',
  magnum: 'python-fire', launcher: 'grenade-launcher-fire', 'rocket-launcher': 'rocket-fire', bow: 'bowgun-fire', special: 'railgun-fire', thrower: 'burn' };
const SPECIAL_FIRE = { minigun: /^chaingun/, flamethrower: /^burn$/, acidthrower: /steam-hissing/, freezethrower: /^freezethrower$/, sparkshot: /^electro-fire/,
  minethrower: /^grenade-launcher-fire$/, railgun: /^railgun-fire$/, bow: /^bowgun-fire$/, m4a1carbine: /^m4-fire$/, '50caliber': /^50-calibur-fire$/, rugermini14: /^rugar-mini-14-fire$/, sw: /^m629-fire$/, missbetty: /^colt-anaconda-fire$/ };
export function fireSamples(item) {
  if (fireCache.has(item.name)) return fireCache.get(item.name);
  const w = norm(item.name).replace(/^sw/, 'sw');
  let out = null;
  for (const [k, re] of Object.entries(SPECIAL_FIRE)) if (w.startsWith(k) || w === k) { out = group(re); break; }
  if (!out || !out.length) {
    let best = null, bl = 0;
    for (const e of index ? index.sfx : []) {
      if (!/fire/.test(e.name) || /freeze|electro|empty/.test(e.name)) continue;
      const key = norm(e.name.replace(/fire/g, '').replace(/-\d+$/, ''));
      if (key.length < 2) continue;
      if (key === w) { best = e.name; break; }
      if ((w.includes(key) || key.includes(w)) && key.length > bl && key.length >= 3) { best = e.name; bl = key.length; }
    }
    out = best ? [best] : [CLASS_FIRE[item.class] || 'handgun-fire-1'];
  }
  fireCache.set(item.name, out);
  return out;
}

const RELOAD = { handgun: ['handgun-reload-1'], smg: ['reloading-1', 'realoding-2'], ar: ['reloading-1', 'realoding-2'], lmg: ['reloading-1'],
  shotgun: ['pump-shotgun-reload-1', 'pump-shotgun-reload-2', 'spas-12-reload'], rifle: ['bolt-reload-1', 'bolt-reload-2', 'bolt-reload-3'], magnum: ['magnum-reload'] };

export const play = {
  shot(item, x, y) {
    if (!sample(fireSamples(item), { vol: 0.75, x, y, gap: 0.03, range: 900 })) {
      const heavy = item.class === 'shotgun' || item.class === 'rifle' || item.class === 'magnum';
      burst({ dur: heavy ? 0.25 : 0.12, freq: heavy ? 900 : 1800, vol: 0.4 });
    }
    if (Math.random() < 0.5 && item.class !== 'thrower') sample(G.casing(), { vol: 0.25, x, y, delay: 0.25 });
  },
  dry: () => sample(G.dry(), { vol: 0.6 }),
  reload(item) {
    if (item.name === 'Sawnoff') return sample(['sawnoff-reload'], { vol: 0.6 });
    if (item.name === 'Hydra') return sample(['hydra-reload'], { vol: 0.6 });
    if (!sample(RELOAD[item.class] || ['clipout-1'], { vol: 0.6 })) burst({ dur: 0.06, freq: 700, type: 'bandpass', q: 3, vol: 0.2 });
  },
  reloaded(item) { if (!['shotgun', 'rifle', 'magnum'].includes(item.class)) sample(group(/^clipin-/), { vol: 0.5 }); else if (item.class === 'magnum') sample(['magnum-reloaded'], { vol: 0.5 }); },
  swing(item) {
    const n = norm(item ? item.name : '');
    if (n === 'chainsaw') return sample(G.chainsaw(), { vol: 0.6, gap: 0.5 });
    if (/knife|machete|katana|sword|scythe|glave/.test(n)) return sample(G.knife(), { vol: 0.6 });
    if (!sample(G.swing(), { vol: 0.6 })) burst({ dur: 0.15, freq: 2500, type: 'bandpass', q: 2, vol: 0.2 });
  },
  hit: (x, y) => sample(G.flesh(), { vol: 0.55, x, y, gap: 0.04 }),
  crit: (x, y) => sample(G.crit(), { vol: 0.5, x, y, gap: 0.1 }),
  ricochet: (x, y) => sample(G.ricochet(), { vol: 0.35, x, y, gap: 0.08 }),
  throwNade: () => sample(G.throwNade(), { vol: 0.6 }),
  explode(x, y) { if (!sample(G.explode(), { vol: 1, x, y, range: 1100, spread: 0.15 })) burst({ dur: 0.9, freq: 400, vol: 0.9 }); },
  hurt(female) { sample(female ? G.hurtF() : G.hurtM(), { vol: 0.7, gap: 0.35 }); },
  die(female) { sample(female ? G.dieF() : G.dieM(), { vol: 0.9 }); },
  heal: () => sample(G.heal(), { vol: 0.6 }),
  pickup: () => sample(G.pickup(), { vol: 0.5, gap: 0.05 }),
  coin: () => sample(G.coin(), { vol: 0.35, gap: 0.05 }),
  door: (open, x, y) => sample(open ? G.doorOpen() : G.doorClose(), { vol: 0.7, x, y }),
  doorBash: (x, y) => sample(G.doorBash().length ? G.doorBash() : G.woodHit(), { vol: 0.6, x, y, gap: 0.2 }),
  wood: (x, y) => sample(G.woodHit(), { vol: 0.55, x, y, gap: 0.15 }),
  woodBreak: (x, y) => sample(G.woodBreak(), { vol: 0.8, x, y }),
  hammer: () => sample(G.hammer(), { vol: 0.7 }),
  flashlight: () => sample(G.flashlight(), { vol: 0.6 }),
  step: (x, y) => sample(G.step(), { vol: 0.18, x, y, spread: 0.15 }),
  frenzy: () => sample(G.frenzy(), { vol: 0.7 }),
  jump: () => sample(group(/jump/i), { vol: 0.5 }),
  radio: () => sample(G.radio(), { vol: 0.35 }),
  mob(kind, mobName, x, y) {
    const re = MOB[family(mobName)][kind];
    sample(group(re), { vol: kind === 'moan' ? 0.45 : 0.6, x, y, gap: kind === 'moan' ? 0.6 : 0.12, range: kind === 'moan' ? 420 : 600 });
  },
  ui: (kind) => sample(G[kind] ? G[kind]() : [], { vol: 0.4, spread: 0 }),
};
