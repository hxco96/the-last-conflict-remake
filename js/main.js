import { loadAssets } from './assets.js';
import { GameData } from './data.js';
import { CLASSES } from './game.js';
import { Atlas } from './assets.js';
import { Session } from './session.js';
import { Profile, SLOT_UPGRADES, DIFFICULTY, ZOMBIE_COUNT } from './profile.js';
import { tierOf, statLine, TIER_COLORS, TIER_NAMES } from './tiers.js';
import { MODES, THEMES } from './modes.js';
import { campaignLine } from './siege.js';
import { LOOKS } from './actors.js';
import { unlockAudio, sfx, initAudio, music, setMuted, applyVolumes, play, suspendAudio } from './sfx.js';
import { Net, listRooms, hasRegistry } from './net.js';
import { perfTick, perfReset } from './perf.js';
import { Coop } from './coop.js';
import { Input, ACTIONS, TOUCH_LABELS, DEFAULT_PAD, DEFAULT_PAD_HOLD, loadSettings, saveSettings, resetSettings, keyLabel, TOUCHPAD } from './input.js';

const canvas = document.getElementById('game');
const overlay = document.getElementById('overlay');
const loading = document.getElementById('loading');
const toast = document.getElementById('toast');
let assets, data, session = null, last = 0;
const profile = new Profile();
const choice = { map: 0, cls: CLASSES[profile.prefs.cls] ? profile.prefs.cls : 'Riot', look: profile.prefs.look >= 0 && profile.prefs.look < LOOKS.length ? profile.prefs.look : 0, mode: 'Survival', theme: 'Zeds', changing: false };
const savePrefs = () => { profile.prefs = { ...profile.prefs, cls: choice.cls, look: choice.look }; profile.save(); };
const settings = loadSettings();
sfx.master = settings.volMaster ?? 0.9;
sfx.sfxVol = settings.volSfx ?? 0.9;
sfx.musicVol = settings.volMusic ?? 0.45;
const input = new Input(canvas, settings);
let screen = null;      // { name, back } for the open overlay screen
let settingsTab = 'gameplay';
let padAdvanced = false;

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
const isIPhone = /iP(hone|od)/.test(navigator.userAgent);

// ---------- fullscreen, focus, screen sleep ----------
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
const canFs = () => !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
let fsRetryArmed = false;
// Must run inside a user gesture (click / tap / key). Gamepad presses don't count, so a failed
// attempt arms a retry on the next real tap or key press.
function goFullscreen(force = false) {
  if ((!force && settings.autoFullscreen === false) || fsEl() || standalone() || !canFs()) return;
  const d = document.documentElement;
  let p;
  try { p = d.requestFullscreen ? d.requestFullscreen({ navigationUI: 'hide' }) : d.webkitRequestFullscreen(); } catch { armFsRetry(); return; }
  Promise.resolve(p).then(() => {
    // landscape lock only if we're already sideways (portrait players keep their layout)
    if (input.touchUI && screen?.name !== 'menu' && window.screen.orientation && /landscape/.test(window.screen.orientation.type)) window.screen.orientation.lock?.('landscape').catch(() => {});
    try { navigator.keyboard?.lock?.(['Escape'])?.catch?.(() => {}); } catch { /* not supported */ }
  }).catch(() => armFsRetry());
}
function exitFullscreen() { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch { /* not fullscreen */ } }
function armFsRetry() {
  if (fsRetryArmed) return;
  fsRetryArmed = true;
  const f = (e) => {
    if (e.type === 'keydown' && e.code === 'Escape') return;
    fsRetryArmed = false;
    window.removeEventListener('pointerup', f, true); window.removeEventListener('keydown', f, true);
    if (session) goFullscreen();
  };
  window.addEventListener('pointerup', f, true); window.addEventListener('keydown', f, true);
}
const onFsChange = () => {
  setTimeout(resize, 50);
  if (!fsEl()) { try { window.screen.orientation?.unlock?.(); } catch { /* not supported */ } }
};
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);

let wakeLock = null;
async function keepAwake() { try { if (navigator.wakeLock && !wakeLock && !document.hidden) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* denied */ } }
document.addEventListener('visibilitychange', () => {
  suspendAudio(document.hidden);
  if (document.hidden) pauseForFocus(); else if (session) keepAwake();
});
window.addEventListener('blur', () => pauseForFocus());
function pauseForFocus() {
  if (!session || screen || settings.pauseOnHide === false) return;
  if (session.view === 'match') showPause();
}
// no long-press menus / pinch zoom anywhere
document.addEventListener('contextmenu', (e) => { if (!(e.target && e.target.tagName === 'INPUT')) e.preventDefault(); });
document.addEventListener('gesturestart', (e) => e.preventDefault());
['touchend', 'click'].forEach((ev) => window.addEventListener(ev, unlockAudio, { passive: true }));

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
  if (kind === 'connected') {
    showToast(what + ' connected'); if (session) session.active.msg(what + ' connected', '#9cd4ff');
    if (!session && !settings.padChecked && screen && screen.name === 'menu') showPadCheck(); // first controller ever: check which buttons the browser lets through
  }
  if (kind === 'disconnected') { showToast(what + ' disconnected'); pauseForFocus(); }
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
  // solo: menus pause the match; co-op: the world keeps going, you just let go of the controls
  if (session && session.view === 'match' && session.match) { if (session.coop) session.match.noInput = true; else session.match.paused = true; }
  if (session && session.coop && session.lobby) session.lobby.noInput = true;
  const keep = overlay.querySelector('[data-focus]');
  if (keep && input.lastDevice === 'pad') focusEl(keep);
}

function closePanel() {
  overlay.className = 'hidden';
  overlay.innerHTML = '';
  screen = null;
  if (session && session.match) { session.match.paused = false; session.match.noInput = false; }
  if (session && session.lobby) session.lobby.noInput = false;
}

function controlsHelp() {
  if (input.lastDevice === 'touch' || (input.touchUI && input.lastDevice !== 'pad' && input.lastDevice !== 'kbm')) {
    return 'Left thumb: move (push fully to run) · Right thumb: aim & fire' + (settings.legacy ? ' — legacy: hold FIRE to auto-shoot the closest zed' : '') + ' · tap weapon icons to switch · USE / RELOAD / HEAL appear when needed · hold NADE to switch throwable · ≡ for menu';
  }
  if (input.lastDevice === 'pad') {
    const h = (a) => input.hint(a);
    const b = (id) => input.padButtonLabel((settings.pad[id] || [])[0]);
    return `${input.padName || 'Controller'}: L-stick move (${b('run')} run) · R-stick aim · ${b('fire')} ${settings.legacy ? 'auto-fire' : 'fire'} · ${b('context')} use/jump · ${b('jump')} jump · ${b('reload')} reload (hold: mine) · ${b('toggleThrowable')} next throwable (hold: heal) · ${b('grenade')} throw · ${b('nextWeapon')} next weapon · ${b('lastWeapon')} last weapon · D-pad weapon slots · ${b('frenzy')} frenzy · ${b('pause')} pause · ${b('inventory')} bag · in menus ${input.padButtonLabel(0)} select / ${input.padButtonLabel(1)} back`;
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
      el('button', { class: 'pick small', onclick: () => { choice.look = (choice.look + 1) % LOOKS.length; savePrefs(); showMenu(); } }, '▶')),
    el('div', { class: 'looks' }, ...LOOKS.map((l, i) => el('button', { class: i === choice.look ? 'on' : '', title: l.name, onclick: () => { choice.look = i; savePrefs(); showMenu(); } }, lookCanvas(l)))));
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
        el('button', { class: 'pick small', onclick: () => { choice.changing = false; savePrefs(); showCoop(); } }, el('b', {}, '🌐 Co-op online')),
        el('button', { class: 'pick small', onclick: () => showSettings(showMenu) }, el('b', {}, '⚙ Settings')),
        installPrompt && !standalone() ? el('button', { class: 'pick small', onclick: async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; showMenu(); } }, el('b', {}, '⬇ Install app')) : null),
      iosHint(),
      el('p', { class: 'help' }, controlsHelp())));
  music('Save Room(RE0)');
}

const iosHint = () => (isIPhone && !standalone() ? el('p', { class: 'sub' }, '📱 iPhone: tap Share → Add to Home Screen to play fullscreen.') : null);

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
      el('button', { class: 'go', 'data-focus': true, onclick: () => enterLobby() }, 'ENTER LOBBY'),
      el('button', { class: 'pick small', onclick: showCoop }, el('b', {}, '🌐 Co-op online')),
      el('button', { class: 'pick small', onclick: () => { choice.changing = true; showMenu(); } }, el('b', {}, 'Change class / survivor')),
      el('button', { class: 'pick small', onclick: () => showSettings(showMenu) }, el('b', {}, '⚙ Settings'))),
    iosHint(),
    el('p', { class: 'help' }, controlsHelp())));
  music('Save Room(RE0)');
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

// ---------- online co-op ----------
let coopBusy = false;
function showCoop(status = '') {
  if (typeof status !== 'string') status = ''; // used directly as an onclick handler
  const name = el('input', { type: 'text', maxlength: 14, value: profile.prefs.name || LOOKS[choice.look].name, placeholder: 'Your name' });
  const code = el('input', { type: 'text', maxlength: 5, placeholder: 'CODE', class: 'code', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' });
  const online = hasRegistry();
  // role 'host' (pub: listed in Browse games) or 'join' (a typed code)
  const go = (role, pub = false) => connectCoop(role, { name, pub, code: code.value }, (m) => showCoop(m));
  open('coop', showMenu, el('div', { class: 'panel' },
    el('h2', {}, 'CO-OP ONLINE'),
    el('p', { class: 'sub' }, 'Up to 4 survivors. The host runs the zeds and the rounds; everyone keeps their own coins, weapons and loot. Fall in a fight and you go DOWN — a teammate can pick you up.'),
    el('div', { class: 'row' }, el('label', { class: 'sub' }, 'Name '), name),
    online ? el('div', { class: 'row' },
      el('button', { class: 'go', 'data-focus': true, onclick: () => { remember(name); showBrowse(); } }, 'BROWSE GAMES'),
      el('button', { class: 'pick small', onclick: () => quickPlay(name, (m) => showCoop(m)) }, el('b', {}, 'QUICK PLAY'))) : null,
    el('div', { class: 'row' },
      el('button', online ? { class: 'pick small', onclick: () => go('host', true) } : { class: 'go', 'data-focus': true, onclick: () => go('host') }, online ? el('b', {}, 'HOST PUBLIC') : 'HOST A GAME'),
      online ? el('button', { class: 'pick small', onclick: () => go('host', false) }, el('b', {}, 'HOST PRIVATE')) : null),
    online ? el('p', { class: 'help' }, 'Public games appear in Browse games for anyone to join. Private games are code-only.') : null,
    el('h3', {}, 'Join with a code'),
    el('div', { class: 'row' }, code, el('button', { class: 'pick small', onclick: () => go('join') }, el('b', {}, 'JOIN'))),
    status ? el('p', { class: 'sub status' }, status) : null,
    el('p', { class: 'help' }, 'Peer-to-peer over the internet (WebRTC) — no account needed. Some strict school or work networks block it.'),
    el('button', { class: 'pick small', onclick: showMenu }, el('b', {}, 'Back'))));
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') go('join'); });
}

function remember(nameEl) {
  profile.prefs = { ...profile.prefs, cls: choice.cls, look: choice.look, name: nameEl.value.trim().slice(0, 14) || LOOKS[choice.look].name };
  profile.save();
}

async function connectCoop(role, { name, pub = false, code = '' }, back) {
  if (coopBusy) return;
  if (role === 'join' && !/^[A-Za-z]{5}$/.test(code.trim())) { back('Type the 5-letter room code your friend sees.'); return; }
  remember(name);
  goFullscreen(); // still inside the click
  coopBusy = true;
  back(role === 'host' ? 'Opening a room… (the first connection can take up to a minute while the free server wakes up)' : 'Connecting…');
  const net = new Net();
  try {
    if (role === 'host') await net.host(); else await net.join(code);
    coopBusy = false;
    await enterLobby(new Coop(net, { name: profile.prefs.name, look: choice.look, cls: choice.cls }));
    if (role === 'host' && pub && session && session.coop && session.coop.net === net) net.publish(() => {
      const S = session; if (!S) return null;
      return { name: profile.prefs.name, players: net.count, max: 4, mode: S.next.mode, map: S.assets.mapIndex[S.next.map].name, state: S.state === 'running' ? 'running' : 'lobby' };
    });
  } catch (err) {
    coopBusy = false;
    net.close();
    back('Could not connect: ' + (err && err.message || err));
  }
}

// Join the fullest open public game; if there is none, open one so others can drop in.
async function quickPlay(name, back) {
  if (coopBusy) return;
  back('Looking for a game…');
  let rooms = [];
  try { rooms = await listRooms(); } catch (e) { back(e.message); return; }
  const target = rooms.find((r) => r.players < r.max);
  if (target) connectCoop('join', { name, code: target.code }, back);
  else connectCoop('host', { name, pub: true }, back);
}

let browseTimer = null;
function showBrowse(status = '') {
  clearInterval(browseTimer);
  const name = el('input', { type: 'text', maxlength: 14, value: profile.prefs.name || LOOKS[choice.look].name, placeholder: 'Your name' });
  const list = el('div', { class: 'servers' }, el('p', { class: 'sub' }, 'Looking for games…'));
  const note = el('p', { class: 'sub status' }, status);
  let live = true;
  const stop = () => { live = false; clearInterval(browseTimer); };
  const refresh = async () => {
    try {
      const rooms = await listRooms();
      if (!live) return;
      note.textContent = '';
      list.replaceChildren(...(rooms.length ? rooms.map((r) => {
        const full = r.players >= r.max;
        return el('button', { class: 'pick server', disabled: full || null, onclick: () => { stop(); connectCoop('join', { name, code: r.code }, (m) => showBrowse(m)); } },
          el('b', {}, r.name + "'s game"),
          el('span', {}, (r.mode || 'Survival') + ' · ' + (r.map || '')),
          el('span', {}, r.players + '/' + r.max + (full ? ' FULL' : r.state === 'running' ? ' · in round' : '')));
      }) : [el('p', { class: 'sub' }, 'No public games right now. Host one and others can join you, or use Quick Play.')]));
    } catch (e) { if (live) note.textContent = e.message; }
  };
  open('browse', () => { stop(); showCoop(); }, el('div', { class: 'panel' },
    el('h2', {}, 'GAMES'),
    el('div', { class: 'row' }, el('label', { class: 'sub' }, 'Name '), name),
    list, note,
    el('div', { class: 'row' },
      el('button', { class: 'pick small', 'data-focus': true, onclick: refresh }, el('b', {}, 'Refresh')),
      el('button', { class: 'pick small', onclick: () => { stop(); connectCoop('host', { name, pub: true }, (m) => showBrowse(m)); } }, el('b', {}, 'Host public')),
      el('button', { class: 'pick small', onclick: () => { stop(); showCoop(); } }, el('b', {}, 'Back')))));
  refresh();
  browseTimer = setInterval(refresh, 5000);
}

// The host's connection dropped mid-run: offer to carry the run on from here under a new room code.
function showHostLost(run) {
  const at = `${Math.floor(run.tm / 60)}:${String(run.tm % 60).padStart(2, '0')}`;
  open('hostlost', () => leaveSession(), el('div', { class: 'panel' },
    el('h2', {}, 'THE HOST DROPPED'),
    el('p', { class: 'sub' }, `Your run was at ${at} with ${run.h} horde${run.h === 1 ? '' : 's'} survived. Host from here and the next round picks up that clock and threat. You get a new room code to share with the others.`),
    el('button', { class: 'go', 'data-focus': true, onclick: () => resumeAsHost(run) }, 'RESUME AS HOST'),
    el('button', { class: 'pick small', onclick: () => leaveSession() }, el('b', {}, 'Leave'))));
}
async function resumeAsHost(run) {
  leaveSession(false);
  closePanel();
  const net = new Net();
  try {
    await net.host();
    await enterLobby(new Coop(net, { name: profile.prefs.name, look: choice.look, cls: choice.cls }));
    if (!session) throw new Error('could not open the base');
    session.resume(run);
    showToast(`New room ${net.code} — share it so the others can rejoin`);
  } catch (err) {
    net.close();
    showToast('Could not take over: ' + (err && err.message || err));
    showMenu();
  }
}

function leaveSession(toMenu = true) {
  if (session && session.match && session.match.ext) session.match.ext.stop();
  if (session && session.coop) session.coop.close();
  session = null;
  if (toMenu) showMenu();
}

async function enterLobby(coop = null) {
  unlockAudio();
  goFullscreen(); // before the first await so the click still counts as a user gesture
  keepAwake();
  try {
    savePrefs();
    closePanel();
    loading.textContent = 'Loading the base…';
    loading.style.display = 'grid';
    session = new Session({ canvas, assets, data, input, profile, cls: choice.cls, look: LOOKS[choice.look], coop, ui: { merchant: showMerchant, board: showBoard, results: showResults, storage: showStorage, armory: showArmory } });
    if (coop) coop.net.onLost = () => {
      const run = coop.lastRun;
      if (run && session && session.match && run.r === session.round) showHostLost(run);
      else { showToast('Lost the connection to the host'); leaveSession(); }
    };
    await withTimeout(session.init(), 20000);
    if (!session.lobby || !session.lobby.map) throw new Error('the base did not finish loading');
    loading.style.display = 'none';
    canvas.focus();
    trapBack();
  } catch (err) {
    console.error(err);
    if (coop) coop.close();
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

// ---------- armory: every weapon type in one screen, tabbed by category ----------
let armoryTab = null;
function showArmory(cat) {
  const L = session.lobby.ext, cats = L.catalog || [];
  if (cat) armoryTab = cat;
  const cur = cats.find((c) => c.label === armoryTab) || cats[0];
  if (!cur) return;
  armoryTab = cur.label;
  const tabs = el('div', { class: 'tabs' }, ...cats.map((c) => el('button', { class: 'tab' + (c === cur ? ' on' : ''), onclick: () => showArmory(c.label) }, c.label)));
  const body = el('div', { class: 'grid' });
  for (const d of cur.items) {
    const it = d.it, t = tierOf(it), owned = d.weapon && L.owned(it);
    const state = owned ? (L.carried(it) ? 'Carried ✓' : 'In storage ✓') : `Buy — ${d.price}c`;
    body.append(el('div', { class: 'cell tall', style: d.weapon ? `border-color:${TIER_COLORS[t]}` : '' },
      iconCanvas(it.name), el('b', { style: d.weapon ? `color:${TIER_COLORS[t]}` : '' }, it.name),
      d.weapon ? el('small', {}, statLine(it, (k) => it[k])) : el('small', {}, L.describe(d).replace(/^Buy /, '').replace(/ — \d+c$/, '')),
      el('button', { class: 'up' + (owned || profile.coins < d.price ? ' off' : ''), onclick: () => {
        if (owned) return;
        L.take(d);
        const m = session.lobby.messages[session.lobby.messages.length - 1];
        if (m) showToast(m.text);
        showArmory();
      } }, state)));
  }
  open('armory', closePanel, el('div', { class: 'panel wide' },
    el('h2', {}, `Armory — ${profile.coins} coins`),
    el('p', { class: 'sub' }, 'Every table sells the full catalogue — switch weapon types with the tabs. Weapons stay with you between runs.'),
    tabs, body, el('button', { class: 'go', 'data-focus': true, onclick: closePanel }, 'Close')));
}

// ---------- results ----------
const mmss = (t) => `${Math.floor(t / 60)}m ${String(Math.floor(t % 60)).padStart(2, '0')}s`;
function recordLine(r) {
  if (!r) return null;
  const parts = [];
  if (r.cause) parts.push(el('p', { class: 'cause' }, `Cause of death: ${r.cause}`));
  parts.push(el('p', { class: r.newRecord ? 'record new' : 'record' }, r.newRecord
    ? `★ NEW RECORD — ${mmss(r.time)} on ${r.key}${r.prev ? ` (old best ${mmss(r.prev.time)})` : ''}`
    : r.prev ? `Best on ${r.key}: ${mmss(r.prev.time)} — you were ${mmss(Math.max(0, r.prev.time - r.time))} short` : `Survived ${mmss(r.time)}`));
  parts.push(el('p', { class: 'sub' }, `Threat reached ${r.threat} · hordes survived ${r.hordes}`));
  return el('div', {}, ...parts);
}

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
    p.siegeScrap ? el('p', { class: 'sub' }, `+${p.siegeScrap} scrap sent to your Siege bases.`) : null,
    recordLine(s.record),
    s.coop ? el('p', { class: 'sub' }, 'Your teammates are still fighting — spectate them from the mission board.') : null,
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
    if (!body.children.length) body.append(el('p', {}, 'Buy weapons at the armory first.'));
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
  if (S.coop && S.coop.client) boardTab = 'vote'; // only the host can pick
  const chip = (cat, value, label, small) => el('button', { class: 'pick' + (n[cat] === value ? ' on' : ''), onclick: () => { if (boardTab === 'host') { n[cat] = value; S.broadcastState(); } else S.vote(cat, value); showBoard(); } },
    el('b', {}, label), small ? el('small', {}, small) : null, boardTab === 'vote' ? el('small', {}, `${S.tally(cat, value)} vote${S.tally(cat, value) === 1 ? '' : 's'}`) : null);
  const mapsList = assets.mapIndex.map((m, i) => i).filter((i) => assets.mapIndex[i].name !== 'Base'); // same choices for host pick and vote
  const status = S.state === 'running'
    ? `Round ${S.round} is running on ${S.match.opts.map.name}.`
    : !S.autoStart ? 'Auto-start is OFF — the host starts the next round.'
    : `Next round in ${Math.ceil(S.timer)}s — everyone in the room drops in automatically. ${S.joined ? 'you are in' + (S.autoDeploy ? ' (auto-deploy)' : ' (you will walk in)') : 'you have not joined'}.`;
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
      S.state === 'intermission' && S.autoStart && (S.joined || S.coop) ? el('button', { class: 'pick small', onclick: () => { S.startSoon(); closePanel(); } }, el('b', {}, '⏩ Start now')) : null),
    S.coop && S.coop.client ? null : el('div', { class: 'row' },
      el('button', { class: 'pick small' + (S.autoStart ? ' on' : ''), onclick: () => { S.setAutoStart(!S.autoStart); showBoard(); } }, el('b', {}, S.autoStart ? 'Auto-start rounds: ON' : 'Auto-start rounds: OFF (host-run)')),
      !S.autoStart && S.state === 'intermission' ? el('button', { class: 'go', onclick: () => { S.hostGo(); closePanel(); } }, 'START MATCH NOW') : null),
    S.coop && S.coop.client ? null : el('div', { class: 'tabs' }, ...[['host', 'Host pick'], ['vote', 'Vote']].map(([id, name]) => el('button', { class: 'tab' + (boardTab === id ? ' on' : ''), onclick: () => { boardTab = id; S.hostMode = id === 'host'; S.broadcastState(); showBoard(); } }, name))),
    boardTab === 'vote' ? el('p', { class: 'sub left' }, S.coop ? (S.coop.client && S.hostMode ? 'The host is picking this round — your vote is shown to them.' : 'Each player gets one vote per category; the most-voted option wins (ties: host).') : 'Each player gets one vote per category; the most-voted option wins (ties: host). Solo: your vote decides.') : null,
    S.coop ? el('p', { class: 'sub' }, `Room ${S.coop.code} · ${S.coop.count}/4 players — share the code to invite friends.`) : null,
    el('h3', {}, 'Map'), el('div', { class: 'choices' }, ...mapsList.map((i) => chip('map', i, assets.mapIndex[i].name, `${assets.mapIndex[i].w}×${assets.mapIndex[i].h}${assets.mapIndex[i].floors > 1 ? ` · ${assets.mapIndex[i].floors}F` : ''}`))),
    el('h3', {}, 'Mode'), el('div', { class: 'choices' }, ...Object.keys(MODES).filter((k) => !(MODES[k].solo && S.coop)).map((k) => chip('mode', k, k, k === 'Siege' ? campaignLine(assets.mapIndex[n.map].name) : MODES[k].desc))),
    n.mode === 'Peaceful' ? null : el('h3', {}, 'Spawn theme'),
    n.mode === 'Peaceful' ? null : el('div', { class: 'choices' }, ...Object.keys(THEMES).map((k) => chip('theme', k, k === 'BossRush' ? 'Boss Rush' : k))),
    n.mode === 'Peaceful' ? null : el('h3', {}, 'Zombie count'),
    n.mode === 'Peaceful' ? null : el('div', { class: 'choices' }, ...Object.entries(ZOMBIE_COUNT).map(([k, z]) => chip('density', k, k, `${z.desc} · up to ~${Math.round(50 * z.mul)} at once`))),
    el('h3', {}, 'Difficulty'), el('div', { class: 'choices' }, ...Object.entries(DIFFICULTY).map(([k, d]) => chip('difficulty', k, k, `${d.desc} · coins ×${d.coins}`))),
    el('button', { class: 'go', onclick: closePanel }, 'Close')));
}

function showPause() {
  const inMatch = session && session.view === 'match';
  open('pause', closePanel, el('div', { class: 'panel' }, el('h1', {}, session && session.coop ? 'MENU' : 'PAUSED'),
    session && session.coop ? el('p', { class: 'sub' }, `Co-op room ${session.coop.code} · ${session.coop.count}/4 — the game keeps running while this menu is open.`) : null,
    el('button', { class: 'go', 'data-focus': true, onclick: closePanel }, 'Resume'),
    el('div', { class: 'row' },
      el('button', { class: 'pick', onclick: () => showSettings(showPause) }, el('b', {}, '⚙ Settings')),
      canFs() && !standalone() ? el('button', { class: 'pick', onclick: () => { if (fsEl()) exitFullscreen(); else goFullscreen(true); closePanel(); } }, el('b', {}, fsEl() ? '⛶ Exit fullscreen' : '⛶ Fullscreen')) : null,
      inMatch ? el('button', { class: 'pick', onclick: () => { closePanel(); session.retreat(); } }, el('b', {}, '🏳 Retreat to base')) : null,
      el('button', { class: 'pick', onclick: () => (session ? showChange() : (choice.changing = true, leaveSession())) }, el('b', {}, 'Change class / survivor')),
      el('button', { class: 'pick', onclick: () => { choice.changing = false; leaveSession(); } }, el('b', {}, session && session.coop ? 'Leave co-op' : 'Quit to title'))),
    el('p', { class: 'help' }, controlsHelp())));
}

// Swap class / survivor without leaving the room (co-op included). Takes effect in the lobby at once, in a round from the next deploy.
function showChange() {
  previews.length = 0;
  const S = session;
  if (!S) return showMenu();
  const look = LOOKS[choice.look];
  const apply = () => {
    savePrefs();
    S.cls = choice.cls; S.look = LOOKS[choice.look];
    const g = S.lobby;
    if (g && g.player) {
      g.opts.cls = choice.cls; g.opts.look = S.look; g.cls = CLASSES[choice.cls]; g.perks = new Set(g.cls.perks);
      g.female = /jill|claire/i.test(S.look.name); g.player.look = S.look; g.player.cls = choice.cls;
    }
    if (S.coop) { S.coop.me.cls = choice.cls; S.coop.me.look = choice.look; }
    showChange();
  };
  const live = S.view === 'match';
  open('change', showPause, el('div', { class: 'panel wide' },
    el('h2', {}, 'Change class / survivor'),
    el('p', { class: 'sub' }, live ? 'You are in a round — the change applies the next time you deploy.' : 'Applies right away. You stay in the room.'),
    el('div', { class: 'row' }, ...Object.keys(CLASSES).map((name) => el('button', { class: 'pick' + (name === choice.cls ? ' on' : ''), 'data-focus': name === choice.cls || null, onclick: () => { choice.cls = name; apply(); } }, el('b', {}, name), el('small', {}, (CLASS_INFO[name] || {}).tag || '')))),
    previewCanvas(look, 128),
    el('div', { class: 'row' },
      el('button', { class: 'pick small', onclick: () => { choice.look = (choice.look + LOOKS.length - 1) % LOOKS.length; apply(); } }, '◀'),
      el('b', { class: 'name' }, look.name),
      el('button', { class: 'pick small', onclick: () => { choice.look = (choice.look + 1) % LOOKS.length; apply(); } }, '▶')),
    el('div', { class: 'looks' }, ...LOOKS.map((l, i) => el('button', { class: i === choice.look ? 'on' : '', title: l.name, onclick: () => { choice.look = i; apply(); } }, lookCanvas(l)))),
    el('button', { class: 'go', onclick: showPause }, 'Back')));
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

function section(title, ...kids) { return el('div', { class: 'sect' }, el('h3', {}, title), ...kids); }

function showSettings(back) {
  const tabList = [['gameplay', 'Game'], ['audio', 'Audio'], ['kbm', 'Keyboard'], ['pad', 'Controller'], ['touch', 'Touch']];
  if (!tabList.some(([id]) => id === settingsTab)) settingsTab = 'gameplay';
  const tabs = el('div', { class: 'tabs' }, ...tabList.map(([id, name]) => el('button', { class: 'tab' + (settingsTab === id ? ' on' : ''), onclick: () => { settingsTab = id; showSettings(back); } }, name)));
  const mode = (legacy, title, desc) => el('button', { class: 'pick' + (!!settings.legacy === legacy ? ' on' : ''), onclick: () => { settings.legacy = legacy; saveSettings(settings); showSettings(back); } }, el('b', {}, title), el('small', {}, desc));
  let body;
  if (settingsTab === 'gameplay') {
    body = el('div', { class: 'opts' },
      section('Shooting',
        el('div', { class: 'choices mode' },
          mode(false, 'Modern aim', 'mouse / right stick / aim thumb'),
          mode(true, 'Legacy auto-aim', 'hold ' + keyLabel(settings.keys.autofire[0]) + ' / ' + input.padButtonLabel(settings.pad.fire[0]) + ' / FIRE to auto-shoot the closest zed')),
        toggle('Show hit chance on the lock-on reticle', 'showHitChance')),
      section('Display',
        toggle('Minimap', 'minimap'),
        toggle('Weather effects', 'weather', 'applies next game'),
        toggle('Gore', 'gore'),
        toggle('Auto fullscreen', 'autoFullscreen', 'iPhone: use Add to Home Screen instead'),
        toggle('Pause when the game loses focus', 'pauseOnHide', 'solo games only; co-op keeps running')),
      section('Data',
        el('div', { class: 'row' },
          el('button', { class: 'pick small', onclick: cacheEverything }, el('b', {}, '⬇ Save for offline (~30 MB)')),
          el('button', { class: 'pick small danger', onclick: () => { if (confirm('Reset all controls and settings to defaults?')) { resetSettings(settings); showSettings(back); } } }, el('b', {}, 'Reset settings')))));
  } else if (settingsTab === 'audio') {
    body = el('div', { class: 'opts' },
      section('Volume', volume('Master', 'volMaster', 'master', 0.9), volume('Sound effects', 'volSfx', 'sfxVol', 0.9), volume('Music', 'volMusic', 'musicVol', 0.45)),
      section('Base music', el('div', { class: 'choices mode' }, ...[['tethered', 'Sake — Tethered mix', 'slowed, dark strings'], ['original', 'Sake — original', 'the track as it was']].map(([id, name, desc]) =>
        el('button', { class: 'pick' + ((settings.lobbyMusic || 'tethered') === id ? ' on' : ''), onclick: () => { settings.lobbyMusic = id; saveSettings(settings); if (session && session.view === 'lobby') music(session.lobbyTrack(), true); showSettings(back); } }, el('b', {}, name), el('small', {}, desc))))));
  } else if (settingsTab === 'kbm') {
    body = el('div', {}, el('p', { class: 'sub left' }, 'Click a binding, then press a key or mouse button. Red = shared with another action. Mouse always aims.'),
      el('table', { class: 'binds' }, el('tr', {}, el('th', {}, 'Action'), el('th', {}, 'Primary'), el('th', {}, 'Secondary')),
        ...ACTIONS.map((a) => el('tr', {}, el('td', {}, a.label), el('td', {}, bindButton('key', a.id, 0)), el('td', {}, bindButton('key', a.id, 1))))));
  } else if (settingsTab === 'pad') {
    const status = input.pad ? (input.padName || 'Controller') + ' connected' : 'No controller detected — connect a PS5, PS4 or Xbox controller and press any button.';
    const style = (id, label) => el('button', { class: 'pick small' + ((settings.padStyle || 'auto') === id ? ' on' : ''), onclick: () => { settings.padStyle = id; saveSettings(settings); input.padName = ''; showSettings(back); } }, el('b', {}, label));
    const fixed = el('tr', {}, el('td', {}, 'Inventory'), el('td', { colspan: 2 }, el('span', { class: 'fixed' }, input.padButtonLabel(TOUCHPAD) + ' — fixed')));
    const holds = Object.entries(settings.padHold || {}).map(([a, b]) => (ACTIONS.find((x) => x.id === a) || { label: a }).label + ' = ' + b.map((i) => input.padButtonLabel(i)).join('/')).join(' · ');
    body = el('div', {},
      el('p', { class: 'sub left padtest' }, status),
      section('Controller',
        el('div', { class: 'opts' },
          slider('Stick deadzone', 'deadzone', 0.05, 0.45, 0.01, (v) => Math.round(v * 100) + '%'),
          toggle('Vibration', 'vibration'),
          toggle('Run at full stick tilt', 'stickRun')),
        el('div', { class: 'row' }, el('small', {}, 'Button names: '), style('auto', 'Auto'), style('ps', 'PlayStation'), style('xbox', 'Xbox'))),
      section('Fixed buttons',
        el('p', { class: 'sub left' }, 'Inventory is always the PS4 / PS5 touchpad click. Options pauses, sticks move and aim, D-pad picks weapons.')),
      el('div', { class: 'row' },
        el('button', { class: 'pick small', onclick: () => { padAdvanced = !padAdvanced; showSettings(back); } }, el('b', {}, padAdvanced ? '▾ Hide button mapping' : '▸ Customize buttons')),
        el('button', { class: 'pick small', onclick: showPadCheck }, el('b', {}, 'Controller check'))),
      padAdvanced ? el('div', {},
        el('p', { class: 'sub left' }, 'Hold ~0.4 s: ' + holds),
        el('table', { class: 'binds' }, el('tr', {}, el('th', {}, 'Action'), el('th', {}, 'Button'), el('th', {}, 'Alternate')),
          ...ACTIONS.filter((a) => !['up', 'down', 'left', 'right'].includes(a.id)).map((a) => a.id === 'inventory' ? fixed : el('tr', {}, el('td', {}, a.label), el('td', {}, bindButton('pad', a.id, 0)), el('td', {}, bindButton('pad', a.id, 1))))),
        el('button', { class: 'pick small', onclick: () => { settings.pad = JSON.parse(JSON.stringify(DEFAULT_PAD)); settings.padHold = JSON.parse(JSON.stringify(DEFAULT_PAD_HOLD)); saveSettings(settings); showToast('Controller buttons reset'); showSettings(back); } }, el('b', {}, 'Reset buttons'))) : null);
  } else {
    body = el('div', {},
      section('Layout',
        el('div', { class: 'opts' },
          slider('Control size', 'touchScale', 0.7, 1.5, 0.05, (v) => Math.round(v * 100) + '%'),
          slider('Control opacity', 'touchOpacity', 0.2, 1, 0.05, (v) => Math.round(v * 100) + '%'),
          toggle('Left-handed layout', 'leftHanded', 'mirror sticks and buttons'),
          toggle('Run at full stick tilt', 'stickRun'))),
      el('p', { class: 'sub left' }, 'Left thumb moves, right thumb aims and fires (legacy mode: a big FIRE button). USE, RELOAD and HEAL show up when they apply; hold NADE to switch throwables; ≡ has pause, bag, mine and flashlight.'));
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

// ---------- controller check ----------
// Browsers like Amazon Silk swallow some buttons (Create, PS, touchpad, sometimes ○ as Back). This walks
// through every button the default layout uses, so the player sees at once which ones never arrive.
const CHECK_BTNS = [[0, 'select / use'], [1, 'back / jump'], [2, 'reload'], [3, 'throwable / heal'], [4, 'throw'], [5, 'next weapon'], [6, 'last weapon'], [7, 'fire'],
  [9, 'pause'], [11, 'frenzy'], [17, 'inventory (touchpad)'], [12, 'D-pad up'], [13, 'D-pad down'], [14, 'D-pad left'], [15, 'D-pad right']];
function showPadCheck() {
  const seen = new Set();
  const list = el('div', { class: 'padchk' });
  const done = el('button', { class: 'pick small', onclick: () => finishPadCheck(seen) }, el('b', {}, 'Finish'));
  const render = () => {
    list.innerHTML = '';
    for (const [i, what] of CHECK_BTNS) list.append(el('span', { class: 'sub', style: `display:inline-block;min-width:200px;margin:2px 8px;color:${seen.has(i) ? '#7dff8a' : '#aaa'}` }, `${seen.has(i) ? '✓' : '○'} ${input.padButtonLabel(i)} — ${what}`));
  };
  render();
  open('padcheck', () => finishPadCheck(seen), el('div', { class: 'panel' },
    el('h2', {}, 'CONTROLLER CHECK'),
    el('p', { class: 'sub' }, input.pad ? `${input.padName || 'Controller'} detected. Press each button once; any that never turn green are being eaten by the browser, so rebind them in Settings → Controller.` : 'No controller detected yet — press any button on it.'),
    list, el('div', { class: 'row' }, done)));
  screen.noNav = true; screen.seen = seen; screen.render = render;
}
function padCheckTick() {
  if (!screen || screen.name !== 'padcheck') return;
  let changed = false;
  for (const i of input.padTapped) if (CHECK_BTNS.some(([b]) => b === i) && !screen.seen.has(i)) { screen.seen.add(i); changed = true; }
  if (changed) screen.render();
  if (screen.seen.size === CHECK_BTNS.length) finishPadCheck(screen.seen);
}
function finishPadCheck(seen) {
  const missing = CHECK_BTNS.filter(([i]) => !seen.has(i)).map(([i, w]) => `${input.padButtonLabel(i)} (${w})`);
  settings.padChecked = true; settings.padMissing = missing;
  saveSettings(settings);
  closePanel();
  showToast(missing.length ? `Never arrived: ${missing.join(', ')} — rebind in Settings → Controller` : 'Controller check passed: every button works');
}

// Live readout for the controller settings tab.
function padTester() {
  const p = overlay.querySelector('.padtest');
  if (!p || !input.pad) return;
  const down = (input.padButtons || []).map((b, i) => (b ? input.padButtonLabel(i) : null)).filter(Boolean);
  const ax = input.pad.axes, st = (x, y) => `${Math.round((x || 0) * 100)}, ${Math.round((y || 0) * 100)}`;
  const t = `Button test: ${down.length ? down.join(' + ') : 'press any button…'}   ·   L-stick ${st(ax[0], ax[1])}   ·   R-stick ${st(ax[2], ax[3])}`;
  if (p.textContent !== t) p.textContent = t;
}

// Android / Fire OS (Silk) browsers can turn ○ / B into the browser's Back. Keep a spare history
// entry while playing, and turn Back into "pause" (or "close this menu") instead of leaving.
function trapBack() { try { if (!(history.state && history.state.tlcr)) history.pushState({ tlcr: 1 }, ''); } catch { /* sandboxed */ } }
window.addEventListener('popstate', () => {
  if (!session) return;
  trapBack();
  if (performance.now() - (input.padDownAt[1] || -1e9) < 400) return; // the game already handled ○ / B
  if (screen && screen.back) { input.capture = null; screen.back(); } else if (!screen && session.active && session.active.map) showPause();
});

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
  const w0 = performance.now();
  const timed = !!(session && session.view === 'match' && !screen && !document.hidden);
  const gap = Math.max(0, (t - last) / 1000 || 0);
  try { frameInner(t); } finally { if (timed) perfTick(gap, performance.now() - w0); else perfReset(); }
}

function frameInner(t) {
  const dt = Math.max(0, Math.min(0.05, (t - last) / 1000 || 0));
  last = t;
  input.poll();
  const hadScreen = !!screen;
  const g = session ? session.active : null;
  if (input.capture && input.capture.kind === 'pad' && input.padTapped.size) {
    input.capture.done([...input.padTapped][0]);
  } else if (screen) {
    if (!screen.noNav) menuNav(dt);
    if (screen && screen.name === 'settings') padTester();
    if (screen && screen.name === 'padcheck') padCheckTick();
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
    if (!screen || session.view !== 'match' || session.coop) session.update(dt);
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
    // Fire tablets: Silk runs the game with browser chrome and swallows more buttons until it's installed
    if (/Silk/.test(navigator.userAgent) && !standalone() && !profile.prefs.tipSilk) {
      profile.prefs = { ...profile.prefs, tipSilk: 1 }; profile.save();
      setTimeout(() => showToast('Tip: Silk menu → Add to Home screen, then launch from there for fullscreen'), 1500);
    }
    requestAnimationFrame(frame);
  } catch (err) {
    loading.textContent = 'Failed to load: ' + err.message + ' (serve this folder over http, see README)';
    console.error(err);
  }
})();
