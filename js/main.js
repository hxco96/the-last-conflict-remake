import { loadAssets } from './assets.js';
import { GameData } from './data.js';
import { Game, CLASSES } from './game.js';
import { LOOKS } from './actors.js';
import { unlockAudio, sfx, initAudio, music, setMuted, applyVolumes, play } from './sfx.js';
import { Input, ACTIONS, TOUCH_LABELS, loadSettings, saveSettings, resetSettings, keyLabel } from './input.js';

const canvas = document.getElementById('game');
const overlay = document.getElementById('overlay');
const loading = document.getElementById('loading');
const toast = document.getElementById('toast');
let assets, data, game = null, last = 0;
const choice = { map: 0, cls: 'Riot', look: 0 };
const settings = loadSettings();
sfx.master = settings.volMaster ?? 0.9;
sfx.sfxVol = settings.volSfx ?? 0.9;
sfx.musicVol = settings.volMusic ?? 0.45;
const input = new Input(canvas, settings);
let screen = null;      // { name, back } for the open overlay screen
let settingsTab = 'gameplay';

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();
window.addEventListener('pointerdown', unlockAudio);
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
  if (kind === 'connected') { showToast(what + ' connected'); if (game) game.msg(what + ' connected', '#9cd4ff'); }
  if (kind === 'switch' && screen && screen.name === 'menu') showMenu();
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
  if (game) game.paused = true;
  const keep = overlay.querySelector('[data-focus]');
  if (keep && input.lastDevice === 'pad') focusEl(keep);
}

function closePanel() {
  overlay.className = 'hidden';
  overlay.innerHTML = '';
  screen = null;
  if (game) game.paused = false;
}

function controlsHelp() {
  if (input.lastDevice === 'touch' || (input.touchUI && input.lastDevice !== 'pad' && input.lastDevice !== 'kbm')) {
    return 'Left thumb: move (push fully to run) · Right thumb: aim & fire' + (settings.legacy ? ' — legacy: hold FIRE to auto-shoot the closest zed' : '') + ' · tap weapon icons to switch · BAG / SHOP / II at the top';
  }
  if (input.lastDevice === 'pad') {
    const h = (a) => input.hint(a);
    return `${input.padName || 'Controller'}: left stick move (click/L2 to run) · right stick aim · ${h('fire')} ${settings.legacy ? 'auto-fire at closest zed' : 'fire'} · ${h('grenade')} grenade · ${h('reload')} reload · ${h('interact')} use · ${h('heal')} heal · ${h('nextWeapon')} next weapon · ${h('inventory')} inventory · ${h('pause')} pause · ✕ select / ○ back in menus`;
  }
  const h = (a) => input.hint(a);
  return `${['up', 'left', 'down', 'right'].map(h).join('')} move · ${h('run')} run · mouse aim · ${h('fire')} attack · ${settings.legacy ? h('autofire') + ' legacy auto-fire · ' : ''}${h('grenade')} grenade · ${h('reload')} reload · ${h('interact')} use · ${h('heal')} heal · ${h('inventory')} inventory · ${h('shop')} upgrades · ${h('frenzy')} frenzy · ${h('pause')} pause — all rebindable in Settings`;
}

function showMenu() {
  const maps = el('div', { class: 'choices' });
  assets.mapIndex.forEach((m, i) => maps.append(el('button', { class: 'pick' + (i === choice.map ? ' on' : ''), onclick: () => { choice.map = i; showMenu(); } },
    el('b', {}, m.name), el('small', {}, `${m.w}×${m.h}${m.floors > 1 ? ` · ${m.floors} floors` : ''}`))));
  const classes = el('div', { class: 'choices' });
  for (const [name, c] of Object.entries(CLASSES)) {
    classes.append(el('button', { class: 'pick' + (name === choice.cls ? ' on' : ''), onclick: () => { choice.cls = name; showMenu(); } },
      el('b', {}, name), el('small', {}, c.loadout.map((x) => (Array.isArray(x) ? x[0] : x)).slice(1, 3).join(' + '))));
  }
  const looks = el('div', { class: 'choices' });
  LOOKS.forEach((l, i) => looks.append(el('button', { class: 'pick look-pick' + (i === choice.look ? ' on' : ''), onclick: () => { choice.look = i; showMenu(); } }, lookCanvas(l), el('small', {}, l.name))));
  const cls = CLASSES[choice.cls];
  const perkList = el('ul', { class: 'perks' }, ...data.perks.filter((p) => cls.perks.includes(p.value)).map((p) => el('li', {}, el('b', {}, p.name + ' '), p.desc)));
  const mode = el('div', { class: 'choices mode' },
    el('button', { class: 'pick' + (!settings.legacy ? ' on' : ''), onclick: () => { settings.legacy = false; saveSettings(settings); showMenu(); } }, el('b', {}, 'Modern aim'), el('small', {}, 'aim with mouse / stick / thumb')),
    el('button', { class: 'pick' + (settings.legacy ? ' on' : ''), onclick: () => { settings.legacy = true; saveSettings(settings); showMenu(); } }, el('b', {}, 'Legacy auto-aim'), el('small', {}, 'auto-shoot the closest visible zed')));
  open('menu', null,
    el('div', { class: 'panel wide' },
      el('h1', {}, 'THE LAST CONFLICT'),
      el('p', { class: 'sub' }, 'Survival — a browser rebuild from reverse-engineered tlcr 0.9.18 data'),
      el('h3', {}, 'Map'), maps,
      el('h3', {}, 'Class'), classes, perkList,
      el('h3', {}, 'Survivor'), looks,
      el('h3', {}, 'Shooting mode'), mode,
      el('div', { class: 'row' },
        el('button', { class: 'go', 'data-focus': true, onclick: startGame }, 'START SURVIVAL'),
        el('button', { class: 'pick small', onclick: () => showSettings(showMenu) }, el('b', {}, '⚙ Settings'))),
      el('p', { class: 'help' }, controlsHelp())));
  music('Save Room(RE0)');
}

async function startGame() {
  unlockAudio();
  if (input.touchUI && input.lastDevice !== 'kbm') {
    try { await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch { /* not allowed */ }
    try { await window.screen.orientation?.lock?.('landscape'); } catch { /* not supported */ }
  }
  closePanel();
  loading.textContent = 'Loading map…';
  loading.style.display = 'grid';
  game = new Game(canvas, assets, data, { map: assets.mapIndex[choice.map], cls: choice.cls, look: LOOKS[choice.look], input });
  await game.start();
  game.onEnd = showGameOver;
  music('playlist');
  loading.style.display = 'none';
  canvas.focus();
}

function showGameOver() {
  const t = game.time;
  music('Secure Place');
  open('gameover', null, el('div', { class: 'panel' },
    el('h1', {}, 'YOU DIED'),
    el('p', {}, `Survived ${Math.floor(t / 60)}m ${Math.floor(t % 60)}s on ${game.opts.map.name}`),
    el('p', {}, `Kills: ${game.kills} · Coins: ${game.coins}`),
    el('button', { class: 'go', 'data-focus': true, onclick: startGame }, 'TRY AGAIN'),
    el('button', { class: 'pick', onclick: () => { game = null; showMenu(); } }, 'Main menu')));
}

function showInventory() {
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
  for (const [id, n] of game.ammo) if (n > 0) ammo.append(el('div', { class: 'cell' }, iconCanvas(data.names.get(id) || ''), el('span', {}, `${data.names.get(id)} ×${n}`)));
  const crafts = el('div', { class: 'grid' });
  for (const r of game.craftable()) {
    crafts.append(el('button', { class: 'cell craft', onclick: () => { game.craft(r); showInventory(); } },
      iconCanvas(game.canonical(r.out)), el('span', {}, `${game.canonical(r.out)}${r.n > 1 ? ' ×' + r.n : ''}`),
      el('small', {}, r.parts.map(([p, k]) => `${game.canonical(p)}${k > 1 ? '×' + k : ''}`).join(' + '))));
  }
  if (!crafts.children.length) crafts.append(el('p', {}, 'Nothing to combine yet. Try Herb-G + Herb-R, or two gunpowders.'));
  open('inventory', closePanel, el('div', { class: 'panel wide' },
    el('h2', {}, 'Inventory'), items, el('h3', {}, 'Ammunition'), ammo, el('h3', {}, 'Combine'), crafts,
    el('button', { class: 'go', 'data-focus': true, onclick: closePanel }, 'Close')));
}

function showShop() {
  const box = el('div', { class: 'grid' });
  game.slots.forEach((s) => {
    if (!s) return;
    const ups = s.upgrades();
    const rows = el('div', { class: 'ups' });
    if (!ups.length) rows.append(el('small', {}, 'No upgrades for this weapon'));
    for (const u of ups) {
      const lvl = s.ups[u.kind] || 0;
      const next = u.levels[lvl];
      const label = `${u.kind}: ${s.stat(u.kind)}` + (next ? ` → ${next[0]}  (${next[1]} coins)` : ' (max)');
      rows.append(el('button', { class: 'up' + (next && game.coins >= next[1] ? '' : ' off'), onclick: () => {
        if (!next || game.coins < next[1]) return;
        game.coins -= next[1];
        s.ups[u.kind] = lvl + 1;
        showShop();
      } }, label));
    }
    box.append(el('div', { class: 'cell tall' }, iconCanvas(s.item.name), el('span', {}, s.item.name), rows));
  });
  open('shop', closePanel, el('div', { class: 'panel wide' },
    el('h2', {}, `Weapon upgrades — ${game.coins} coins`),
    el('p', { class: 'sub' }, 'Levels and prices come straight from wep_upgrades.rktd'),
    box, el('button', { class: 'go', 'data-focus': true, onclick: closePanel }, 'Close')));
}

function showPause() {
  open('pause', closePanel, el('div', { class: 'panel' }, el('h1', {}, 'PAUSED'),
    el('button', { class: 'go', 'data-focus': true, onclick: closePanel }, 'Resume'),
    el('div', { class: 'row' },
      el('button', { class: 'pick', onclick: () => showSettings(showPause) }, el('b', {}, '⚙ Settings')),
      el('button', { class: 'pick', onclick: () => { game = null; showMenu(); } }, el('b', {}, 'Quit to menu'))),
    el('p', { class: 'help' }, controlsHelp())));
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
      el('h3', {}, 'Button assignments'),
      el('table', { class: 'binds' }, ...settings.touchButtons.map((cur, i) => el('tr', {}, el('td', {}, `Button ${i + 1}`),
        el('td', {}, el('select', { onchange: (e) => { settings.touchButtons[i] = e.target.value; saveSettings(settings); } },
          ...choices.map((c) => el('option', { value: c, selected: c === cur }, `${TOUCH_LABELS[c]} — ${actionName(c)}`))))))));
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
function frame(t) {
  const dt = Math.min(0.05, (t - last) / 1000 || 0);
  last = t;
  input.poll();
  const hadScreen = !!screen;
  if (input.capture && input.capture.kind === 'pad' && input.padTapped.size) {
    input.capture.done([...input.padTapped][0]);
  } else if (screen) {
    menuNav(dt);
    // the same action that opened a panel closes it
    if (screen && !input.capture && game && ((screen.name === 'inventory' && input.pressed('inventory')) || (screen.name === 'shop' && input.pressed('shop'))
      || (['inventory', 'shop', 'pause'].includes(screen.name) && input.pressed('pause') && !input.padTapped.has(1)))) closePanel();
  } else if (game && game.map && !game.over) {
    if (input.pressed('pause')) showPause();
    else if (input.pressed('inventory')) showInventory();
    else if (input.pressed('shop')) showShop();
    if (input.pressed('mute')) { setMuted(!sfx.muted); game.msg(sfx.muted ? 'Sound off' : 'Sound on'); }
  }
  if (hadScreen && !screen) {
    // the press that closed a menu must not also act in-game
    input.prev = new Map(input.down);
    input.tapped.clear();
    input.padTapped.clear();
  }
  if (game && game.map) {
    game.update(dt);
    game.render();
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
  }
  input.endFrame();
  requestAnimationFrame(frame);
}

(async () => {
  try {
    [assets] = await Promise.all([loadAssets((p) => { loading.textContent = `Loading ${Math.round(p * 100)}%`; }), initAudio()]);
    data = new GameData(assets);
    window.__tlcr = { assets, data, input, settings, get game() { return game; } };
    loading.style.display = 'none';
    showMenu();
    requestAnimationFrame(frame);
  } catch (err) {
    loading.textContent = 'Failed to load: ' + err.message + ' (serve this folder over http, see README)';
    console.error(err);
  }
})();
