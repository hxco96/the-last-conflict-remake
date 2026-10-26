import { loadAssets } from './assets.js';
import { GameData } from './data.js';
import { CLASSES } from './game.js';
import { Atlas } from './assets.js';
import { Session } from './session.js';
import { Profile, SLOT_UPGRADES, DIFFICULTY } from './profile.js';
import { tierOf, statLine, TIER_COLORS, TIER_NAMES } from './tiers.js';
import { MODES, THEMES } from './modes.js';
import { LOOKS } from './actors.js';
import { unlockAudio, sfx, initAudio, music, setMuted, applyVolumes, play } from './sfx.js';
import { Input, ACTIONS, TOUCH_LABELS, loadSettings, saveSettings, resetSettings, keyLabel } from './input.js';

const canvas = document.getElementById('game');
const overlay = document.getElementById('overlay');
const loading = document.getElementById('loading');
const toast = document.getElementById('toast');
let assets, data, session = null, last = 0;
const profile = new Profile();
const choice = { map: 0, cls: CLASSES[profile.prefs.cls] ? profile.prefs.cls : 'Riot', look: profile.prefs.look >= 0 && profile.prefs.look < LOOKS.length ? profile.prefs.look : 0, mode: 'Survival', theme: 'Zeds', changing: false };
const savePrefs = () => { profile.prefs = { cls: choice.cls, look: choice.look }; profile.save(); };
const settings = loadSettings();
sfx.master = settings.volMaster ?? 0.9;
sfx.sfxVol = settings.volSfx ?? 0.9;
sfx.musicVol = settings.volMusic ?? 0.45;
const input = new Input(canvas, settings);
let screen = null;      // { name, back } for the open overlay screen
let settingsTab = 'gameplay';

// Backing size = the canvas's on-screen size, so drawing and touch coordinates stay 1:1
function resize() {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width || window.innerWidth));
  canvas.height = Math.max(1, Math.round(r.height || window.innerHeight));
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
resize();
window.addEventListener('pointerdown', unlockAudio);

// ---------- installable app (PWA) ----------
let installPrompt = null;
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'cache-progress') {
      showToast(e.data.done < e.data.total ? `Downloading for offline… ${e.data.done}/${e.data.total}` : 'Everything is available offline');
    }
  });
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (screen && screen.name === 'menu') showMenu(); });
window.addEventListener('appinstalled', () => { installPrompt = null; showToast('Installed — launch it from your home screen'); });
const standalone = () => matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone;

async function cacheEverything() {
  const reg = await navigator.serviceWorker?.ready;
  if (!reg || !reg.active) { showToast('Offline mode needs https (or localhost)'); return; }
  const urls = [...assets.mapIndex.map((m) => 'assets/maps/' + m.file)];
  try { const a = await (await fetch('assets/audio/index.json')).json(); for (const e of [...a.sfx, ...a.music]) urls.push('assets/audio/' + e.file); } catch { /* audio optional */ }
  reg.active.postMessage({ type: 'cache-all', urls });
  showToast(`Downloading ${urls.length} files for offline…`);
}
window.addEventListener('keydown', unlockAudio);
// UI feedback sounds for every menu button
overlay.addEventListener('click', (e) => { if (e.target.closest('button')) play.ui('menuClick'); });

function showToast(msg) {
  toast.textContent = msg;
  toast.className = 'show';
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => (toast.className = ''), 2600);
}
input.onDevice = (kind, what) => {
  if (kind === 'connected') { showToast(what + ' connected'); if (session) session.active.msg(what + ' connected', '#9cd4ff'); }
  if (kind === 'switch') { const h = overlay.querySelector('.help'); if (h) h.textContent = controlsHelp(); }
  document.body.classList.toggle('touch', input.touchUI && input.lastDevice === 'touch');
};
document.body.classList.toggle('touch', input.touchUI);

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onclick') e.addEventListener('click', v);
    else if (k === 'oninput') e.addEventListener('input', v);
    else if (k === 'onchange') e.addEventListener('change', v);
    else if (k === 'class') e.className = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
};

function iconCanvas(name, size = 32) {
  const c = el('canvas', { width: size, height: size, class: 'icon' });
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  data.drawIcon(x, name, 0, 0, size);
  return c;
}

function lookCanvas(look) {
  const c = el('canvas', { width: 64, height: 64, class: 'look' });
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  x.scale(2, 2);
  for (const base of look.layers) {
    const f = assets.atlas.core.find(base, ['blink', 'walk'], ['s']);
    if (f) assets.atlas.core.draw(x, f.list[0].f, 16, 30);
  }
  return c;
}

function open(name, back, ...content) {
  overlay.innerHTML = '';
  overlay.className = 'menu';
  overlay.append(...content);
  screen = { name, back };
  if (session && session.view === 'match' && session.match) session.match.paused = true;
  const keep = overlay.querySelector('[data-focus]');
  if (keep && input.lastDevice === 'pad') focusEl(keep);
}

function closePanel() {
  overlay.className = 'hidden';
  overlay.innerHTML = '';
  screen = null;
  if (session && session.match) session.match.paused = false;
}

function controlsHelp() {
  if (input.lastDevice === 'touch' || (input.touchUI && input.lastDevice !== 'pad' && input.lastDevice !== 'kbm')) {
    return 'Left thumb: move (push fully to run) · Right thumb: aim & fire' + (settings.legacy ? ' — legacy: hold FIRE to auto-shoot the closest zed' : '') + ' · tap weapon icons to switch · USE / RELOAD / HEAL appear when needed · hold NADE to switch throwable · ≡ for menu';
  }
  if (input.lastDevice === 'pad') {
    const h = (a) => input.hint(a);
    return `${input.padName || 'Controller'}: L-stick move (L3 run) · R-stick aim · R2 ${settings.legacy ? 'auto-fire' : 'fire'} · ✕ use/jump (contextual) · ○ jump · □ reload (hold: mine) · △ next throwable (hold: heal) · L1 throw · R1 next weapon · L2 last weapon · D-pad weapon slots · R3 frenzy · Create inventory · Options pause · in menus ✕ select / ○ back`;
  }
  const h = (a) => input.hint(a);
  return `${['up', 'left', 'down', 'right'].map(h).join('')} move · ${h('run')} run · mouse aim · ${h('fire')} attack · ${settings.legacy ? h('autofire') + ' legacy auto-fire · ' : ''}${h('grenade')} grenade · ${h('reload')} reload · ${h('interact')} use · ${h('heal')} heal · ${h('inventory')} inventory · ${h('shop')} upgrades · ${h('frenzy')} frenzy · ${h('pause')} pause — all rebindable in Settings`;
}
// ---------- class & survivor select ----------
const CLASS_INFO = {
  Riot: { tag: 'Frontline brawler', stats: { Durability: 5, Firepower: 4, Mobility: 3, Support: 1 } },
  Sniper: { tag: 'Long-range precision', stats: { Durability: 2, Firepower: 5, Mobility: 3, Support: 1 } },
  Demo: { tag: 'Explosives expert', stats: { Durability: 3, Firepower: 5, Mobility: 2, Support: 2 } },
  Medic: { tag: 'Keeps the squad alive', stats: { Durability: 3, Firepower: 3, Mobility: 4, Support: 5 } },
};
const previews = []; // animated canvases on the select screen

function previewCanvas(look, size = 128, dirs = ['s', 'e', 'n', 'w']) {
  const c = el('canvas', { width: size, height: size, class: 'look big' });
  previews.push({ c, look, dirs, size });
  return c;
}
function drawPreviews(t) {
  for (const p of previews) {
    if (!p.c.isConnected) continue;
    const x = p.c.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, p.size, p.size);
    x.imageSmoothingEnabled = false;
    const s = p.size / 32;
    x.scale(s, s);
    const dir = p.dirs[Math.floor(t / 1600) % p.dirs.length];
    for (const base of p.look.layers) {
      const f = assets.atlas.core.find(base, ['walk', 'blink'], [dir, 's']);
      if (f) assets.atlas.core.draw(x, Atlas.frameAt(f.list, t), 16, 31, false);
    }
  }
}
function atlasIcon(frameName, size = 40) {
  const c = el('canvas', { width: size, height: size, class: 'icon' });
  const f = assets.atlas.combat.frames[frameName];
  if (f) { const x = c.getContext('2d'); x.imageSmoothingEnabled = false; assets.atlas.combat.drawCentered(x, f, size / 2, size / 2, size / Math.max(f[6], f[7])); }
  return c;
}

function showMenu() {
  previews.length = 0;
  if (profile.prefs.cls && !choice.changing) return showReturning();
  const cards = el('div', { class: 'cards' });
  for (const [name, c] of Object.entries(CLASSES)) {
    const info = CLASS_INFO[name] || { tag: '', stats: {} };
    const perks = data.perks.filter((p) => c.perks.includes(p.value));
    const kit = c.loadout.map((x) => (Array.isArray(x) ? x[0] : x));
    cards.append(el('button', { class: 'card' + (name === choice.cls ? ' on' : ''), 'data-focus': name === choice.cls || null, onclick: () => { choice.cls = name; savePrefs(); showMenu(); } },
      el('div', { class: 'card-head' }, atlasIcon(c.icon, 44), el('div', {}, el('b', {}, name), el('small', {}, info.tag))),
      el('div', { class: 'stats' }, ...Object.entries(info.stats).map(([k, v]) => el('div', { class: 'stat' }, el('span', {}, k), el('i', { style: `--v:${v * 20}%` })))),
      el('div', { class: 'kit' }, ...kit.map((n) => { const w = el('span', { title: n }); w.append(iconCanvas(n, 28)); return w; })),
      el('ul', { class: 'perks mini' }, ...perks.map((p) => el('li', {}, el('b', {}, (/^(BluntForce|Savagery|Headshot|Dazzle|BigBang|HealingPulse|VitalSigns|AfterShock|Heatwave|MoltenRage)$/.test(p.value) ? '⚡ ' : '') + p.name), ' ', el('small', {}, p.desc))))));
  }
  const look = LOOKS[choice.look];
  const survivor = el('div', { class: 'survivor' },
    previewCanvas(look, 144),
    el('div', { class: 'row' },
      el('button', { class: 'pick small', onclick: () => { choice.look = (choice.look + LOOKS.length - 1) % LOOKS.length; savePrefs(); showMenu(); } }, '◀'),
      el('b', { class: 'name' }, look.name),
      el('button', { class: 'pick small', onclick: () => { choice.look = (choice.look + 1) % LOOKS.length; savePrefs(); showMenu(); } }, '▶')));
  const mode = el('div', { class: 'choices mode' },
    el('button', { class: 'pick' + (!settings.legacy ? ' on' : ''), onclick: () => { settings.legacy = false; saveSettings(settings); showMenu(); } }, el('b', {}, 'Modern aim'), el('small', {}, 'aim with mouse / stick / thumb')),
    el('button', { class: 'pick' + (settings.legacy ? ' on' : ''), onclick: () => { settings.legacy = true; saveSettings(settings); showMenu(); } }, el('b', {}, 'Legacy auto-aim'), el('small', {}, 'auto-shoot the closest visible zed')));
  open('menu', null,
    el('div', { class: 'panel wide select' },
      el('h1', {}, 'THE LAST CONFLICT'),
      el('p', { class: 'sub' }, `Choose your survivor and class · ${profile.coins} coins banked · ${profile.inventory.length} weapon${profile.inventory.length === 1 ? '' : 's'} carried · ${profile.storage.length} stored · best run ${Math.floor(profile.stats.best / 60)}m`),
      el('div', { class: 'select-grid' }, survivor, cards),
      el('h3', {}, 'Shooting mode'), mode,
      el('div', { class: 'row' },
        el('button', { class: 'go', 'data-focus': true, onclick: () => { choice.changing = false; savePrefs(); enterLobby(); } }, 'ENTER LOBBY'),
        el('button', { class: 'pick small', onclick: () => showSettings(showMenu) }, el('b', {}, '⚙ Settings')),
        installPrompt && !standalone() ? el('button', { class: 'pick small', onclick: async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; showMenu(); } }, el('b', {}, '⬇ Install app')) : null),
      el('p', { class: 'help' }, controlsHelp())));
  music('Save Room(RE0)');
}

// Returning players: one big button, class and survivor remembered.
function showReturning() {
  const info = CLASS_INFO[choice.cls] || { tag: '' }, c = CLASSES[choice.cls], look = LOOKS[choice.look];
  const perks = data.perks.filter((p) => c.perks.includes(p.value));
  open('menu', null, el('div', { class: 'panel wide select' },
    el('h1', {}, 'THE LAST CONFLICT'),
    el('p', { class: 'sub' }, `${profile.coins} coins banked · ${profile.inventory.length} weapon${profile.inventory.length === 1 ? '' : 's'} carried · ${profile.storage.length} stored · best run ${Math.floor(profile.stats.best / 60)}m`),
    el('div', { class: 'returning' },
      previewCanvas(look, 144),
      el('div', {}, el('h2', {}, `${look.name} · ${choice.cls}`), el('p', { class: 'sub left' }, info.tag),
        el('ul', { class: 'perks mini' }, ...perks.map((p) => el('li', {}, el('b', {}, p.name), ' ', el('small', {}, p.desc)))))),
    el('div', { class: 'row' },
      el('button', { class: 'go', 'data-focus': true, onclick: enterLobby }, 'ENTER LOBBY'),
      el('button', { class: 'pick small', onclick: () => { choice.changing = true; showMenu(); } }, el('b', {}, 'Change class / survivor')),
      el('button', { class: 'pick small', onclick: () => showSettings(showMenu) }, el('b', {}, '⚙ Settings'))),
    el('p', { class: 'help' }, controlsHelp())));
  music('Save Room(RE0)');
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

async function enterLobby() {
  unlockAudio();
  try {
    if (input.touchUI && input.lastDevice !== 'kbm') {
      // never wait on these: some browsers leave the promise pending
      try { await withTimeout(document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }), 1200); } catch { /* not allowed */ }
      try { await withTimeout(window.screen.orientation?.lock?.('landscape'), 600); } catch { /* not supported */ }
    }
    savePrefs();
    closePanel();
    loading.textContent = 'Loading the base…';
    loading.style.display = 'grid';
    session = new Session({ canvas, assets, data, input, profile, cls: choice.cls, look: LOOKS[choice.look], ui: { merchant: showMerchant, board: showBoard, results: showResults, storage: showStorage } });
    await withTimeout(session.init(), 20000);
    if (!session.lobby || !session.lobby.map) throw new Error('the base did not finish loading');
    loading.style.display = 'none';
    canvas.focus();
  } catch (err) {
    console.error(err);
    session = null;
    loading.style.display = 'none';
    showToast('Could not enter the lobby: ' + err.message);
    showMenu();
  }
}

// ---------- storage locker ----------
function showStorage() {
  const L = session.lobby, P = profile, cap = P.level('storageSlots');
  const sync = () => { L.ext.syncInv(); showStorage(); };
  const card = (name, actionLabel, action, enabled) => {
    const it = data.item(name), t = tierOf(it);
    return el('div', { class: 'cell tall', style: `border-color:${TIER_COLORS[t]}` },
      iconCanvas(name), el('b', { style: `color:${TIER_COLORS[t]}` }, name), el('small', {}, statLine(it, (k) => it[k])),
      el('button', { class: 'up' + (enabled ? '' : ' off'), onclick: () => enabled && action() }, actionLabel));
  };
  const empty = (label) => el('div', { class: 'cell tall empty' }, el('small', {}, label));
  const carried = el('div', { class: 'grid' });
  L.slots.forEach((s, i) => carried.append(s
    ? card(s.item.name, P.storage.length < cap ? '→ Storage' : 'Storage full', () => { L.slots[i] = null; P.storage.push(s.item.name); if (L.cur === i) L.cur = Math.max(0, L.slots.findIndex(Boolean)); sync(); }, P.storage.length < cap)
    : empty('empty slot')));
  const stored = el('div', { class: 'grid' });
  P.storage.forEach((name, i) => stored.append(card(name, L.slots.some((s) => !s) ? '→ Carry' : 'Inventory full', () => {
    const free = L.slots.findIndex((s) => !s); if (free < 0) return;
    L.slots[free] = L.newSlot(data.item(name)); P.storage.splice(i, 1); sync();
  }, L.slots.some((s) => !s))));
  for (let i = P.storage.length; i < cap; i++) stored.append(empty('empty'));
  open('storage', closePanel, el('div', { class: 'panel wide' },
    el('h2', {}, 'Storage locker'),
    el('p', { class: 'sub' }, `Carried weapons come with you into every round and stay with you after it. Stash spares here (${P.storage.length}/${cap} slots — buy more at the merchant).`),
    el('h3', {}, `Carried (${L.slots.filter(Boolean).length}/${L.slots.length})`), carried,
    el('h3', {}, `Storage (${P.storage.length}/${cap})`), stored,
    el('button', { class: 'go', 'data-focus': true, onclick: closePanel }, 'Close')));
}

// ---------- results ----------
function showResults(s) {
  const title = s.result === 'won' ? (s.wonText || 'Victory').toUpperCase() : s.result === 'retreated' ? 'RETREATED' : 'YOU DIED';
  const p = s.pay;
  open('results', closePanel, el('div', { class: 'panel' },
    el('h1', { class: s.result === 'won' ? 'win' : '' }, title),
    el('p', {}, `${s.map} · ${s.mode} · ${s.difficulty}`),
    el('table', { class: 'binds pay' },
      el('tr', {}, el('td', {}, `Kills (${s.kills} × 3)`), el('td', {}, String(p.kills))),
      el('tr', {}, el('td', {}, `Time alive (${Math.floor(s.alive / 60)}m ${Math.floor(s.alive % 60)}s)`), el('td', {}, String(p.time))),
      p.win ? el('tr', {}, el('td', {}, 'Objective bonus'), el('td', {}, String(p.win))) : null,
      el('tr', {}, el('td', {}, `Difficulty ×${p.mult}`), el('td', {}, '')),
      el('tr', { class: 'total' }, el('td', {}, 'Coins earned'), el('td', {}, '+' + p.total))),
    el('p', {}, `Bank: ${profile.coins} coins — spend them at the merchant and the tables.`),
    el('button', { class: 'go', 'data-focus': true, onclick: closePanel }, 'BACK TO THE BASE')));
}

// ---------- merchant (permanent upgrades) ----------
let merchantTab = 'weapons';
function showMerchant() {
  const g = session.lobby;
  const tabs = el('div', { class: 'tabs' }, ...[['weapons', 'Weapon upgrades'], ['inventory', 'Inventory upgrades']]
    .map(([id, name]) => el('button', { class: 'tab' + (merchantTab === id ? ' on' : ''), onclick: () => { merchantTab = id; showMerchant(); } }, name)));
  let body;
  if (merchantTab === 'weapons') {
    body = el('div', { class: 'grid' });
    const names = [...new Set([...g.slots.filter(Boolean).map((s) => s.item.name), ...profile.storage])];
    for (const n of names) {
      const it = data.item(n);
      if (!it || it.kind !== 'gun' && it.kind !== 'melee') continue;
      const s = g.newSlot(it), ups = s.upgrades();
      const rows = el('div', { class: 'ups' });
      if (!ups.length) rows.append(el('small', {}, 'No upgrades for this weapon'));
      for (const u of ups) {
        const lvl = s.ups[u.kind] || 0, next = u.levels[lvl];
        rows.append(el('button', { class: 'up' + (next && profile.coins >= next[1] ? '' : ' off'), onclick: () => {
          if (!next || !profile.spend(next[1])) return;
          s.ups[u.kind] = lvl + 1; profile.save(); play.coin(); showMerchant();
        } }, `${u.kind}: ${s.stat(u.kind)}` + (next ? ` → ${next[0]}  (${next[1]}c)` : ' (max)')));
      }
      body.append(el('div', { class: 'cell tall' }, iconCanvas(it.name), el('span', {}, it.name), rows));
    }
    if (!body.children.length) body.append(el('p', {}, 'Buy weapons at the tables first.'));
  } else {
    body = el('div', { class: 'grid' });
    for (const [k, u] of Object.entries(SLOT_UPGRADES)) {
      const cost = profile.nextCost(k), lvl = profile.level(k);
      body.append(el('div', { class: 'cell tall' }, el('b', {}, u.label), el('span', {}, k === 'throwCap' ? `Level ${profile.inv[k]} / ${u.costs.length}` : `${lvl} / ${u.max}`),
        el('button', { class: 'up' + (cost != null && profile.coins >= cost ? '' : ' off'), onclick: () => { if (profile.buyLevel(k)) { play.coin(); showToast('Upgrade applies from the next round'); showMerchant(); } } },
          cost == null ? 'Maxed' : `Upgrade — ${cost}c`)));
    }
  }
  open('merchant', closePanel, el('div', { class: 'panel wide' },
    el('h2', {}, `Merchant — ${profile.coins} coins`),
    el('p', { class: 'sub' }, 'Upgrades are permanent and carry across every round.'),
    tabs, body, el('button', { class: 'go', 'data-focus': true, onclick: closePanel }, 'Close')));
}

// ---------- mission board: host pick / vote, join, spectate ----------
let boardTab = 'host';
function showBoard() {
  const S = session, n = S.next;
  const chip = (cat, value, label, small) => el('button', { class: 'pick' + (n[cat] === value ? ' on' : ''), onclick: () => { if (boardTab === 'host') n[cat] = value; else S.vote(cat, value); showBoard(); } },
    el('b', {}, label), small ? el('small', {}, small) : null, boardTab === 'vote' ? el('small', {}, `${S.tally(cat, value)} vote${S.tally(cat, value) === 1 ? '' : 's'}`) : null);
  const mapsList = boardTab === 'host' ? assets.mapIndex.map((m, i) => i).filter((i) => assets.mapIndex[i].name !== 'Base') : S.ballot.map;
  const status = S.state === 'running'
    ? `Round ${S.round} is running on ${S.match.opts.map.name}.`
    : `Next round in ${Math.ceil(S.timer)}s — ${S.joined ? 'you are in' + (S.autoDeploy ? ' (auto-deploy)' : ' (you will walk in)') : 'you have not joined'}.`;
  open('board', closePanel, el('div', { class: 'panel wide' },
    el('h2', {}, 'Mission board'),
    el('p', { class: 'sub' }, status),
    el('div', { class: 'row' },
      S.state === 'running'
        ? el('button', { class: 'go', 'data-focus': true, onclick: () => { closePanel(); S.deploy(); } }, 'DEPLOY NOW')
        : el('button', { class: 'go', 'data-focus': true, onclick: () => { S.join(true); showBoard(); } }, S.joined && S.autoDeploy ? 'JOINED ✓' : 'JOIN & DEPLOY AT START'),
      S.state !== 'running' ? el('button', { class: 'pick small', onclick: () => { S.join(false); showBoard(); } }, el('b', {}, 'Join — I\'ll walk in')) : null,
      S.joined && S.state !== 'running' ? el('button', { class: 'pick small', onclick: () => { S.leaveQueue(); showBoard(); } }, el('b', {}, 'Leave')) : null,
      S.state === 'running' && S.match.ghost ? el('button', { class: 'pick small', onclick: () => { closePanel(); S.spectate(true); } }, el('b', {}, '👁 Spectate')) : null,
      S.state === 'intermission' && S.joined ? el('button', { class: 'pick small', onclick: () => { S.startSoon(); closePanel(); } }, el('b', {}, '⏩ Start now')) : null),
    el('div', { class: 'tabs' }, ...[['host', 'Host pick'], ['vote', 'Vote']].map(([id, name]) => el('button', { class: 'tab' + (boardTab === id ? ' on' : ''), onclick: () => { boardTab = id; S.hostMode = id === 'host'; showBoard(); } }, name))),
    boardTab === 'vote' ? el('p', { class: 'sub left' }, 'Each player gets one vote per category; the most-voted option wins (ties: host). Only local players are connected in this build.') : null,
    el('h3', {}, 'Map'), el('div', { class: 'choices' }, ...mapsList.map((i) => chip('map', i, assets.mapIndex[i].name, `${assets.mapIndex[i].w}×${assets.mapIndex[i].h}${assets.mapIndex[i].floors > 1 ? ` · ${assets.mapIndex[i].floors}F` : ''}`))),
    el('h3', {}, 'Mode'), el('div', { class: 'choices' }, ...(boardTab === 'host' ? Object.keys(MODES) : S.ballot.mode).map((k) => chip('mode', k, k, MODES[k].desc))),
    n.mode === 'Peaceful' ? null : el('h3', {}, 'Spawn theme'),
    n.mode === 'Peaceful' ? null : el('div', { class: 'choices' }, ...(boardTab === 'host' ? Object.keys(THEMES) : S.ballot.theme).map((k) => chip('theme', k, k === 'BossRush' ? 'Boss Rush' : k))),
    el('h3', {}, 'Difficulty'), el('div', { class: 'choices' }, ...Object.entries(DIFFICULTY).map(([k, d]) => chip('difficulty', k, k, `${d.desc} · coins ×${d.coins}`))),
    el('button', { class: 'go', onclick: closePanel }, 'Close')));
}

function showPause() {
  const inMatch = session && session.view === 'match';
  open('pause', closePanel, el('div', { class: 'panel' }, el('h1', {}, 'PAUSED'),
    el('button', { class: 'go', 'data-focus': true, onclick: closePanel }, 'Resume'),
    el('div', { class: 'row' },
      el('button', { class: 'pick', onclick: () => showSettings(showPause) }, el('b', {}, '⚙ Settings')),
      inMatch ? el('button', { class: 'pick', onclick: () => { closePanel(); session.retreat(); } }, el('b', {}, '🏳 Retreat to base')) : null,
      el('button', { class: 'pick', onclick: () => { if (session && session.match) session.match.ext.stop(); session = null; choice.changing = true; showMenu(); } }, el('b', {}, 'Change class / survivor')),
      el('button', { class: 'pick', onclick: () => { if (session && session.match) session.match.ext.stop(); session = null; choice.changing = false; showMenu(); } }, el('b', {}, 'Quit to title'))),
    el('p', { class: 'help' }, controlsHelp())));
}

function showInventory() {
  const game = session.active;
  const items = el('div', { class: 'grid' });
  for (const [name, n] of game.items) {
    if (n <= 0) continue;
    const it = data.item(name);
    const usable = it && it.kind === 'consumable';
    items.append(el('button', { class: 'cell', onclick: () => { if (usable) { game.useItem(name); showInventory(); } } },
      iconCanvas(name), el('span', {}, `${name} ×${n}`), el('small', {}, usable ? 'use' : 'material')));
  }
  if (!items.children.length) items.append(el('p', {}, 'No items. Herbs, sprays and gunpowder show up here.'));
  const ammo = el('div', { class: 'grid' });
  game.ammo.slots.forEach((a, i) => ammo.append(el('div', { class: 'cell' }, iconCanvas(data.names.get(a.kind) || ''), el('span', {}, `${data.names.get(a.kind)} ${a.count}/${game.ammo.cap(a.kind)}`), el('small', {}, `slot ${i + 1}`))));
  for (let i = game.ammo.slots.length; i < game.ammo.n; i++) ammo.append(el('div', { class: 'cell' }, el('span', {}, 'Empty ammo slot'), el('small', {}, 'pick up ammo with Use')));
  const throws = el('div', { class: 'grid' });
  for (const [name, n] of game.throwables.counts) if (n > 0) throws.append(el('button', { class: 'cell' + (game.throwables.sel === name ? ' sel' : ''), onclick: () => { game.throwables.sel = name; showInventory(); } }, iconCanvas(name), el('span', {}, `${name} ×${n}`), el('small', {}, game.throwables.sel === name ? 'selected' : 'select')));
  if (!throws.children.length) throws.append(el('p', {}, 'No grenades, mines or molotovs.'));
  const crafts = el('div', { class: 'grid' });
  for (const r of game.craftable()) {
    crafts.append(el('button', { class: 'cell craft', onclick: () => { game.craft(r); showInventory(); } },
      iconCanvas(game.canonical(r.out)), el('span', {}, `${game.canonical(r.out)}${r.n > 1 ? ' ×' + r.n : ''}`),
      el('small', {}, r.parts.map(([p, k]) => `${game.canonical(p)}${k > 1 ? '×' + k : ''}`).join(' + '))));
  }
  if (!crafts.children.length) crafts.append(el('p', {}, 'Nothing to combine yet. Try Herb-G + Herb-R, or two gunpowders.'));
  open('inventory', closePanel, el('div', { class: 'panel wide' },
    el('h2', {}, 'Inventory'), items, el('h3', {}, `Ammo slots (${game.ammo.slots.length}/${game.ammo.n})`), ammo,
    el('h3', {}, 'Throwables'), throws, el('h3', {}, 'Combine'), crafts,
    el('button', { class: 'go', 'data-focus': true, onclick: closePanel }, 'Close')));
}

// ---------- settings ----------
function conflicts(map, code, self) {
  return ACTIONS.filter((a) => a.id !== self && (map[a.id] || []).includes(code)).map((a) => a.label);
}

function bindButton(kind, id, slot) {
  const map = kind === 'key' ? settings.keys : settings.pad;
  const v = (map[id] || [])[slot];
  const label = kind === 'key' ? keyLabel(v) : input.padButtonLabel(v);
  const clash = v !== undefined && v !== '' && conflicts(map, v, id).length;
  const b = el('button', { class: 'bind' + (clash ? ' clash' : ''), title: clash ? 'Also used by: ' + conflicts(map, v, id).join(', ') : '' }, v === undefined || v === '' ? '—' : label);
  b.addEventListener('click', () => {
    b.textContent = kind === 'key' ? 'Press a key or mouse button… (Esc cancels, Backspace clears)' : 'Press a controller button… (Esc / Cancel)';
    b.classList.add('wait');
    input.capture = {
      kind,
      done: (code) => {
        input.capture = null;
        if (code !== null) {
          const list = [...(map[id] || [])];
          if (code === '') list.splice(slot, 1); else list[slot] = code;
          map[id] = list.filter((x) => x !== undefined && x !== '');
          saveSettings(settings);
        }
        showSettings(screen.back);
      },
    };
  });
  return b;
}

function toggle(label, key, desc) {
  return el('label', { class: 'opt' }, el('input', { type: 'checkbox', checked: !!settings[key], onchange: (e) => { settings[key] = e.target.checked; saveSettings(settings); } }),
    el('span', {}, el('b', {}, label), desc ? el('small', {}, desc) : null));
}

function slider(label, key, min, max, step, fmt = (v) => v) {
  const out = el('small', {}, String(fmt(settings[key])));
  return el('label', { class: 'opt' }, el('span', {}, el('b', {}, label), out),
    el('input', { type: 'range', min, max, step, value: settings[key], oninput: (e) => { settings[key] = +e.target.value; out.textContent = fmt(settings[key]); saveSettings(settings); } }));
}

function volume(label, key, field, def) {
  if (settings[key] === undefined) settings[key] = def;
  const out = el('small', {}, Math.round(settings[key] * 100) + '%');
  return el('label', { class: 'opt' }, el('span', {}, el('b', {}, label), out),
    el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: settings[key], oninput: (e) => {
      settings[key] = +e.target.value; sfx[field] = settings[key]; out.textContent = Math.round(settings[key] * 100) + '%';
      applyVolumes(); saveSettings(settings);
    }, onchange: () => play.ui('menuClick') }));
}

function showSettings(back) {
  const tabs = el('div', { class: 'tabs' }, ...[['gameplay', 'Gameplay'], ['kbm', 'Keyboard & Mouse'], ['pad', 'Controller'], ['touch', 'Touch']]
    .map(([id, name]) => el('button', { class: 'tab' + (settingsTab === id ? ' on' : ''), onclick: () => { settingsTab = id; showSettings(back); } }, name)));
  let body;
  if (settingsTab === 'gameplay') {
    body = el('div', { class: 'opts' },
      el('h3', {}, 'Shooting mode'),
      el('div', { class: 'choices mode' },
        el('button', { class: 'pick' + (!settings.legacy ? ' on' : ''), onclick: () => { settings.legacy = false; saveSettings(settings); showSettings(back); } }, el('b', {}, 'Modern aim'), el('small', {}, 'mouse / right stick / aim thumb')),
        el('button', { class: 'pick' + (settings.legacy ? ' on' : ''), onclick: () => { settings.legacy = true; saveSettings(settings); showSettings(back); } }, el('b', {}, 'Legacy auto-aim'), el('small', {}, `PC: hold ${keyLabel(settings.keys.autofire[0])} · pad: ${input.padButtonLabel(settings.pad.fire[0])} · touch: FIRE`))),
      el('p', { class: 'sub left' }, 'Legacy mode locks onto the closest visible zed in your weapon\'s range and keeps firing while the button is held. Each shot rolls a weighted hit chance: weapon class accuracy, distance versus weapon range, whether you are standing / walking / running, target size and whether it is rushing, a Frenzy bonus, and a pity bonus that grows after every miss. Misses fly just past the target.'),
      toggle('Show hit chance on the lock-on reticle', 'showHitChance'),
      toggle('Weather effects', 'weather', 'rain with thunder and snow (applies next game)'),
      el('h3', {}, 'Offline'),
      el('p', { class: 'sub left' }, 'The game core works offline once loaded. Maps and music are saved as you play them — or grab everything now (~30 MB).'),
      el('button', { class: 'pick small', onclick: cacheEverything }, el('b', {}, '⬇ Download everything for offline')),
      el('h3', {}, 'Audio'),
      el('div', { class: 'opts' },
        volume('Master volume', 'volMaster', 'master', 0.9),
        volume('Sound effects', 'volSfx', 'sfxVol', 0.9),
        volume('Music', 'volMusic', 'musicVol', 0.45)),
      el('button', { class: 'pick small danger', onclick: () => { if (confirm('Reset all controls and settings to defaults?')) { resetSettings(settings); showSettings(back); } } }, el('b', {}, 'Reset everything to defaults')));
  } else if (settingsTab === 'kbm') {
    body = el('table', { class: 'binds' }, el('tr', {}, el('th', {}, 'Action'), el('th', {}, 'Primary'), el('th', {}, 'Secondary')),
      ...ACTIONS.map((a) => el('tr', {}, el('td', {}, a.label), el('td', {}, bindButton('key', a.id, 0)), el('td', {}, bindButton('key', a.id, 1)))));
    body = el('div', {}, el('p', { class: 'sub left' }, 'Click a binding, then press a key, mouse button or scroll the wheel. Red bindings are shared with another action. Mouse always aims.'), body);
  } else if (settingsTab === 'pad') {
    const status = input.pad ? `${input.padName || 'Controller'} connected (${input.pad.id.slice(0, 48)})` : 'No controller detected — connect a PS5 DualSense (USB or Bluetooth) and press any button.';
    body = el('div', {},
      el('p', { class: 'sub left' }, status),
      el('p', { class: 'sub left' }, 'Left stick moves, right stick aims (sticks are fixed). In legacy mode the fire button auto-targets the closest zed. In menus: D-pad / left stick to move, ✕ to select, ○ to go back.'),
      el('div', { class: 'opts' },
        slider('Stick deadzone', 'deadzone', 0.05, 0.45, 0.01, (v) => Math.round(v * 100) + '%'),
        toggle('Vibration', 'vibration', 'DualSense / gamepad rumble on shots, hits and explosions'),
        toggle('Run at full stick tilt', 'stickRun')),
      el('p', { class: 'sub left' }, `Hold bindings (press ~0.4 s): ${Object.entries(settings.padHold || {}).map(([a, b]) => `${(ACTIONS.find((x) => x.id === a) || { label: a }).label} = hold ${b.map((i) => input.padButtonLabel(i)).join('/')}`).join(' · ')}`),
      el('table', { class: 'binds' }, el('tr', {}, el('th', {}, 'Action'), el('th', {}, 'Button'), el('th', {}, 'Alternate')),
        ...ACTIONS.filter((a) => !['up', 'down', 'left', 'right'].includes(a.id)).map((a) => el('tr', {}, el('td', {}, a.label), el('td', {}, bindButton('pad', a.id, 0)), el('td', {}, bindButton('pad', a.id, 1))))));
  } else {
    const choices = Object.keys(TOUCH_LABELS);
    const actionName = (id) => (ACTIONS.find((a) => a.id === id) || { label: id }).label;
    body = el('div', {},
      el('p', { class: 'sub left' }, 'Left thumb is a floating move stick, the right thumb a floating aim stick that fires when pushed past halfway. In legacy mode the aim stick becomes a big FIRE button that auto-targets.'),
      el('div', { class: 'opts' },
        slider('Control size', 'touchScale', 0.7, 1.5, 0.05, (v) => Math.round(v * 100) + '%'),
        slider('Control opacity', 'touchOpacity', 0.2, 1, 0.05, (v) => Math.round(v * 100) + '%'),
        toggle('Left-handed layout', 'leftHanded', 'mirror sticks and buttons'),
        toggle('Run at full stick tilt', 'stickRun')),
      el('p', { class: 'sub left' }, 'The layout is context-aware: USE appears next to something you can use, RELOAD when your mag is not full, HEAL when you are hurt and carry healing; hold NADE to switch throwables; ≡ opens pause, bag, next throwable, mine and flashlight.'));
  }
  open('settings', back, el('div', { class: 'panel wide' }, el('h2', {}, 'Settings'), tabs, body,
    el('button', { class: 'go', 'data-focus': true, onclick: () => { input.capture = null; back(); } }, 'Back')));
}

// ---------- controller menu navigation ----------
let navCool = 0;
function focusEl(e) {
  overlay.querySelectorAll('.navfocus').forEach((x) => x.classList.remove('navfocus'));
  e.focus({ preventScroll: false });
  e.classList.add('navfocus');
  e.scrollIntoView({ block: 'nearest' });
}

function menuNav(dt) {
  if (!input.pad) return;
  const tap = (i) => input.padTapped.has(i);
  const items = [...overlay.querySelectorAll('button, input, select')].filter((e) => e.offsetParent !== null);
  if (!items.length) return;
  let cur = items.includes(document.activeElement) ? document.activeElement : null;
  const g = input.pad, ax = g.axes[0] || 0, ay = g.axes[1] || 0;
  navCool -= dt;
  let dir = null;
  if (tap(12)) dir = [0, -1]; else if (tap(13)) dir = [0, 1]; else if (tap(14)) dir = [-1, 0]; else if (tap(15)) dir = [1, 0];
  else if (navCool <= 0 && Math.hypot(ax, ay) > 0.6) { dir = Math.abs(ax) > Math.abs(ay) ? [Math.sign(ax), 0] : [0, Math.sign(ay)]; navCool = 0.22; }
  if (Math.hypot(ax, ay) < 0.3) navCool = 0;
  if (dir && !cur) { focusEl(overlay.querySelector('[data-focus]') || items[0]); return; }
  if (dir && cur) {
    if (cur.type === 'range' && dir[0]) { dir[0] > 0 ? cur.stepUp() : cur.stepDown(); cur.dispatchEvent(new Event('input')); return; }
    if (cur.tagName === 'SELECT' && dir[1] && cur === document.activeElement && cur.dataset.open) {
      cur.selectedIndex = Math.max(0, Math.min(cur.options.length - 1, cur.selectedIndex + dir[1])); cur.dispatchEvent(new Event('change')); return;
    }
    const r = cur.getBoundingClientRect(), cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    let best = null, bs = Infinity;
    for (const e of items) {
      if (e === cur) continue;
      const q = e.getBoundingClientRect(), dx = q.x + q.width / 2 - cx, dy = q.y + q.height / 2 - cy;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 2) continue;
      const across = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
      const score = along + across * 2.5;
      if (score < bs) { bs = score; best = e; }
    }
    if (best) { focusEl(best); play.ui('menuMove'); }
  }
  if (tap(0) && cur) {
    if (cur.tagName === 'SELECT') { cur.dataset.open = cur.dataset.open ? '' : '1'; cur.classList.toggle('editing', !!cur.dataset.open); }
    else cur.click();
  }
  if (tap(1) && screen && screen.back) { input.capture = null; play.ui('menuBack'); screen.back(); }
}

// ---------- main loop ----------
let frameErrors = 0;
function frame(t) {
  try { frameBody(t); frameErrors = 0; } catch (err) {
    console.error(err);
    if (++frameErrors === 3) showToast('Game error: ' + err.message);
    if (frameErrors > 120 && session) { session = null; frameErrors = 0; showMenu(); } // unrecoverable: back to the title
    input.endFrame();
  }
  requestAnimationFrame(frame);
}

function frameBody(t) {
  const dt = Math.max(0, Math.min(0.05, (t - last) / 1000 || 0));
  last = t;
  input.poll();
  const hadScreen = !!screen;
  const g = session ? session.active : null;
  if (input.capture && input.capture.kind === 'pad' && input.padTapped.size) {
    input.capture.done([...input.padTapped][0]);
  } else if (screen) {
    menuNav(dt);
    if (screen && !input.capture && session && ((screen.name === 'inventory' && input.pressed('inventory'))
      || (['inventory', 'merchant', 'board', 'pause', 'results'].includes(screen.name) && input.pressed('pause') && !input.padTapped.has(1)))) closePanel();
  } else if (session && session.view === 'spectate') {
    if (input.pressed('pause') || input.padTapped.has(1)) session.spectate(false);
    else if (input.pressed('interact') || input.pressed('context')) session.deploy();
  } else if (g && g.map) {
    if (input.pressed('pause')) showPause();
    else if (input.pressed('inventory')) showInventory();
    else if (input.pressed('shop')) g.msg(g.opts.lobby ? 'Talk to the merchant for upgrades' : 'Upgrades are sold by the merchant in the base', '#9cd4ff');
    if (input.pressed('mute')) { setMuted(!sfx.muted); g.msg(sfx.muted ? 'Sound off' : 'Sound on'); }
  }
  if (hadScreen && !screen) {
    // the press that closed a menu must not also act in-game
    input.prev = new Map(input.down);
    input.tapped.clear();
    input.padTapped.clear();
  }
  if (session && session.lobby) {
    if (!screen || session.view !== 'match') session.update(dt);
    else if (session.match) session.match.update(0); // paused in-match menu
    session.render();
    if (session.view === 'spectate') drawSpectateBar();
  } else if (assets) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const img = assets.title;
    const s = Math.max(canvas.width / img.width, canvas.height / img.height);
    ctx.globalAlpha = 0.55;
    ctx.drawImage(img, (canvas.width - img.width * s) / 2, (canvas.height - img.height * s) / 2, img.width * s, img.height * s);
    ctx.globalAlpha = 1;
    if (screen && screen.name === 'menu') drawPreviews(t);
  }
  input.endFrame();
}

function drawSpectateBar() {
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const txt = `SPECTATING ${session.match.opts.map.name} — move to pan · ${input.hint('interact') || 'USE'} deploy now · ${input.hint('pause') || 'BACK'} return to base`;
  ctx.font = '18px Bebas, Impact, sans-serif';
  const w = ctx.measureText(txt).width + 30;
  ctx.fillStyle = 'rgba(8,10,14,0.85)'; ctx.fillRect(W / 2 - w / 2, H - 46, w, 30);
  ctx.fillStyle = '#7dff8a'; ctx.textAlign = 'center'; ctx.fillText(txt, W / 2, H - 25); ctx.textAlign = 'left';
}

(async () => {
  try {
    [assets] = await Promise.all([loadAssets((p) => { loading.textContent = `Loading ${Math.round(p * 100)}%`; }), initAudio()]);
    data = new GameData(assets);
    window.__tlcr = { frame: (t) => frameBody(t), assets, data, input, settings, profile, get session() { return session; }, get game() { return session ? session.active : null; } };
    loading.style.display = 'none';
    showMenu();
    requestAnimationFrame(frame);
  } catch (err) {
    loading.textContent = 'Failed to load: ' + err.message + ' (serve this folder over http, see README)';
    console.error(err);
  }
})();
