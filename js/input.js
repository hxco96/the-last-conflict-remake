// Unified input: keyboard/mouse, gamepads (DualSense-first labels, standard mapping) and touch.
// Everything the game reads goes through named actions so every device can be rebound.

export const ACTIONS = [
  ['up', 'Move up'], ['down', 'Move down'], ['left', 'Move left'], ['right', 'Move right'],
  ['run', 'Run'], ['jump', 'Jump'], ['context', 'Use or jump (contextual)'], ['mine', 'Place mine'], ['fire', 'Attack / fire'], ['autofire', 'Legacy auto-fire'], ['grenade', 'Throw grenade'],
  ['reload', 'Reload'], ['interact', 'Use / pick up'], ['heal', 'Quick heal'], ['frenzy', 'Frenzy'],
  ['slot1', 'Weapon slot 1'], ['slot2', 'Weapon slot 2'], ['slot3', 'Weapon slot 3'], ['slot4', 'Weapon slot 4'], ['slot5', 'Weapon slot 5'], ['toggleThrowable', 'Toggle throwable'],
  ['nextWeapon', 'Next weapon'], ['prevWeapon', 'Previous weapon'], ['lastWeapon', 'Last weapon'],
  ['flashlight', 'Flashlight'], ['inventory', 'Inventory'], ['shop', 'Upgrades'], ['pause', 'Pause / back'], ['mute', 'Mute'],
].map(([id, label]) => ({ id, label }));

export const DEFAULT_KEYS = {
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'], jump: ['Space'], mine: ['KeyN'], fire: ['Mouse0'], autofire: ['KeyF'], grenade: ['Mouse2', 'KeyG'],
  reload: ['KeyR'], interact: ['KeyE'], heal: ['KeyH'], frenzy: ['KeyV'],
  slot1: ['Digit1'], slot2: ['Digit2'], slot3: ['Digit3'], slot4: ['Digit4'], slot5: ['Digit5'], toggleThrowable: ['KeyT'],
  nextWeapon: ['WheelDown'], prevWeapon: ['WheelUp'], lastWeapon: ['KeyQ'],
  flashlight: ['KeyL'], inventory: ['Tab', 'KeyI'], shop: ['KeyB'], pause: ['Escape', 'KeyP'], mute: ['KeyM'],
};

// Standard gamepad button indices (DualSense in Chromium/Firefox/Safari use this layout).
// DualSense layout (playtest audit): one contextual face button, holds for rare actions,
// D-pad = weapon slots, shoulders = throw / swap. Standard mapping indices.
// Defaults only use the 16 core buttons: Create/Share (8), PS/Guide (16) and the touchpad (17)
// open system or browser menus on tablets (Fire OS Silk, Android), so nothing needs them.
export const PAD_VERSION = 3;
export const DEFAULT_PAD = {
  up: [], down: [], left: [], right: [],
  run: [10], fire: [7], autofire: [], grenade: [4],
  context: [0], jump: [1], interact: [], mine: [], reload: [2], heal: [], frenzy: [11],
  slot1: [12], slot2: [15], slot3: [13], slot4: [14], slot5: [], toggleThrowable: [3],
  nextWeapon: [5], prevWeapon: [], lastWeapon: [6],
  flashlight: [], inventory: [], shop: [], pause: [9], mute: [],
};
// Hold a button ~0.4 s for these (tap keeps the button's normal action).
export const DEFAULT_PAD_HOLD = { heal: [3], mine: [2], inventory: [9] };

const PS_NAMES = ['✕ Cross', '○ Circle', '□ Square', '△ Triangle', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3',
  'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'PS', 'Touchpad'];
const XBOX_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Guide', 'Share'];

// Browsers that don't recognise a controller report its raw HID layout (mapping ''): Firefox does
// this for DualShock 4 / DualSense, some Android / Fire OS browsers for generic pads. Translate
// the known layouts to the standard one so bindings, menus and labels work the same everywhere.
const SONY_RAW = [2, 0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16, 17]; // raw index -> standard index
const hatDirs = (v) => {
  // 8-way hat on one axis: -1 = up, then clockwise in steps of 2/7; anything > 1 is centred
  if (v === undefined || v > 1.05 || v < -1.05) return 0;
  const i = Math.round((v + 1) * 3.5) % 8;
  return [1, 1 | 8, 8, 8 | 2, 2, 2 | 4, 4, 4 | 1][i]; // bits: up 1, down 2, left 4, right 8
};
export function normalizePad(g) {
  const btn = (b) => ({ pressed: !!(b && (b.pressed || b.value > 0.5)), value: b ? b.value : 0 });
  if (g.mapping === 'standard') return g;
  const id = g.id.toLowerCase(), raw = g.buttons, ax = g.axes;
  const out = Array.from({ length: 18 }, () => ({ pressed: false, value: 0 }));
  let axes = [ax[0] || 0, ax[1] || 0, ax[2] || 0, ax[3] || 0], hat = 0;
  if (/054c|dualsense|dualshock|wireless controller|playstation/.test(id) && raw.length >= 13) {
    raw.forEach((b, i) => { if (SONY_RAW[i] !== undefined) out[SONY_RAW[i]] = btn(b); });
    axes = [ax[0] || 0, ax[1] || 0, ax[2] || 0, ax[5] || 0];
    if (raw.length >= 18) for (let i = 14; i < 18; i++) out[i - 2] = btn(raw[i]); // some builds put the D-pad on 14-17
    hat = hatDirs(ax[9]);
  } else {
    raw.forEach((b, i) => { if (i < 18) out[i] = btn(b); });
    // D-pad reported as a hat axis (9) or as an x/y axis pair (6, 7)
    if (ax.length >= 10) hat = hatDirs(ax[9]);
    else if (ax.length >= 8 && raw.length < 16) hat = (ax[7] < -0.5 ? 1 : 0) | (ax[7] > 0.5 ? 2 : 0) | (ax[6] < -0.5 ? 4 : 0) | (ax[6] > 0.5 ? 8 : 0);
  }
  if (hat) [[1, 12], [2, 13], [4, 14], [8, 15]].forEach(([bit, i]) => { if (hat & bit) out[i] = { pressed: true, value: 1 }; });
  return { id: g.id, index: g.index, connected: g.connected, mapping: 'remapped', buttons: out, axes,
    vibrationActuator: g.vibrationActuator, hapticActuators: g.hapticActuators };
}

export const DEFAULT_SETTINGS = {
  legacy: false,          // legacy shooting: auto-target the closest visible zed
  autoFullscreen: true,   // go fullscreen when you enter the base (and on the next tap if blocked)
  pauseOnHide: true,      // pause (solo) when the tab/app is hidden or loses focus
  gore: true,             // dismemberment, gibs and blood sprays
  minimap: true,          // map overlay with teammates highlighted
  lobbyMusic: 'tethered', // base music: 'tethered' (suspense mix of Sake) or 'original'
  padStyle: 'auto',       // button names: auto-detect, 'ps' or 'xbox'
  showHitChance: true,
  weather: true,
  vibration: true,
  deadzone: 0.2,
  stickRun: true,         // full stick tilt runs (pad + touch)
  touchScale: 1,
  touchOpacity: 0.55,
  leftHanded: false,
  touchButtons: ['reload', 'grenade', 'interact', 'heal', 'nextWeapon', 'jump'],
  keys: DEFAULT_KEYS,
  padHold: DEFAULT_PAD_HOLD,
  pad: DEFAULT_PAD,
};

export const TOUCH_LABELS = { reload: 'R', grenade: 'NADE', interact: 'USE', heal: 'HEAL', nextWeapon: 'SWAP', prevWeapon: 'PREV',
  lastWeapon: 'LAST', flashlight: 'LIGHT', frenzy: 'FRENZY', run: 'RUN', inventory: 'BAG', shop: 'SHOP', autofire: 'AUTO', jump: 'JUMP', mine: 'MINE' };

const STORE = 'tlcr-settings-v1';
const clone = (o) => JSON.parse(JSON.stringify(o));

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* storage unavailable */ }
  const s = { ...clone(DEFAULT_SETTINGS), ...saved };
  s.keys = { ...clone(DEFAULT_KEYS), ...(saved.keys || {}) };
  // older saves predate the contextual DualSense layout: take the new pad defaults
  s.pad = saved.padVersion === PAD_VERSION ? { ...clone(DEFAULT_PAD), ...(saved.pad || {}) } : clone(DEFAULT_PAD);
  s.padHold = saved.padVersion === PAD_VERSION && saved.padHold ? saved.padHold : clone(DEFAULT_PAD_HOLD);
  s.padVersion = PAD_VERSION;
  if (!s.touchButtons.includes('jump')) s.touchButtons = [...s.touchButtons.slice(0, 5), 'jump'];
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export function resetSettings(s) {
  Object.assign(s, clone(DEFAULT_SETTINGS));
  saveSettings(s);
}

export function keyLabel(code) {
  if (!code) return '—';
  const named = { Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5', WheelUp: 'Wheel ↑', WheelDown: 'Wheel ↓',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift',
    ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt', Backquote: '`', Enter: 'Enter', Tab: 'Tab' };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

export class Input {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.keys = new Set();       // held key / mouse codes
    this.tapped = new Set();     // codes pressed since last frame (catches sub-frame taps)
    this.down = new Map();       // action -> bool (this frame)
    this.prev = new Map();
    this.padPrev = [];
    this.padTapped = new Set();
    this.pad = null;
    this.padLabels = PS_NAMES;
    this.padName = '';
    this.mouse = { x: 0, y: 0 };
    // phones/tablets start in touch mode (menus cover the canvas, so the first tap can't tell us)
    this.lastDevice = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches ? 'touch' : 'kbm';
    this.aimAngle = 0;
    this.aimMag = 0;             // stick/touch aim strength (0..1)
    this.move = { x: 0, y: 0, mag: 0 };
    this.touchUI = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.touch = { pointers: new Map(), move: null, aim: null, buttons: new Set(), vis: new Set(), layout: null, menuOpen: false };
    this.padDownAt = []; this.padHoldDone = []; this.padRelease = new Set(); this.padHoldTapped = new Set();
    this.capture = null;         // rebinding callback
    this.padActiveAt = -1e9;     // last controller input (ms)
    this.onDevice = () => {};
    this.bind();
  }

  bind() {
    const c = this.canvas;
    // Tablet / TV browsers turn some controller buttons into browser keys (Back, Menu, media):
    // swallow them so they can't open browser menus or leave the page mid-game.
    const BROWSER_KEYS = /^(GoBack|BrowserBack|BrowserForward|BrowserHome|BrowserSearch|BrowserFavorites|BrowserRefresh|ContextMenu|Props|Select|AppSwitch|Media\w*|Gamepad\w*|Button\w*)$/;
    window.addEventListener('keydown', (e) => {
      if (BROWSER_KEYS.test(e.key) || BROWSER_KEYS.test(e.code)) { e.preventDefault(); e.stopPropagation(); return; }
      if (this.capture && this.capture.kind === 'key') {
        e.preventDefault();
        this.capture.done(e.code === 'Escape' ? null : e.code === 'Backspace' || e.code === 'Delete' ? '' : e.code);
        return;
      }
      if (this.capture && this.capture.kind === 'pad') {
        if (e.code === 'Escape') this.capture.done(null);
        else if (e.code === 'Backspace' || e.code === 'Delete') this.capture.done('');
        e.preventDefault();
        return;
      }
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown'].includes(e.code) || e.code === 'Escape') {
        if (!(document.activeElement && document.activeElement.tagName === 'INPUT')) e.preventDefault();
      }
      if (!e.repeat) this.tapped.add(e.code);
      this.keys.add(e.code);
      this.setDevice('kbm');
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.touch.pointers.clear(); this.touch.move = this.touch.aim = null; this.touch.buttons.clear(); });
    // a DualShock / DualSense touchpad drives the mouse pointer on Android: don't let it flip the HUD
    const padBusy = () => performance.now() - this.padActiveAt < 1500;
    c.addEventListener('mousemove', (e) => { this.mouse.x = this.px(e); this.mouse.y = this.py(e); if (!padBusy()) this.setDevice('kbm'); });
    c.addEventListener('mousedown', (e) => {
      const code = 'Mouse' + e.button;
      if (this.capture && this.capture.kind === 'key') { this.capture.done(code); e.preventDefault(); return; }
      this.keys.add(code); this.tapped.add(code); this.setDevice('kbm');
    });
    window.addEventListener('mouseup', (e) => this.keys.delete('Mouse' + e.button));
    c.addEventListener('wheel', (e) => { this.tapped.add(e.deltaY > 0 ? 'WheelDown' : 'WheelUp'); e.preventDefault(); }, { passive: false });
    window.addEventListener('contextmenu', (e) => { if (!(e.target && e.target.tagName === 'INPUT')) e.preventDefault(); });
    window.addEventListener('auxclick', (e) => e.preventDefault());

    // touch (pointer events so multi-touch works everywhere)
    c.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { e.preventDefault(); this.touchDown(e); } });
    // move/up on window so releases still register when an overlay opens under the finger
    window.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch' && this.touch.pointers.has(e.pointerId)) this.touchMove(e); });
    const up = (e) => { if (e.pointerType === 'touch') this.touchUp(e); };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    window.addEventListener('gamepadconnected', (e) => this.padConnected(e.gamepad));
    window.addEventListener('gamepaddisconnected', () => { if (this.lastDevice === 'pad') this.setDevice(this.touchUI ? 'touch' : 'kbm'); this.onDevice('disconnected', this.padName || 'Controller'); });
    // any tap/click (menus included) tells us which device is in use — hybrid laptops, Chromebooks
    window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') this.setDevice('touch'); else if (e.pointerType === 'mouse' && e.target !== c) this.setDevice('kbm'); }, true);
  }

  padConnected(gp) {
    const id = gp.id.toLowerCase();
    const sony = /dualsense|dualshock|054c|playstation|wireless controller/.test(id);
    const style = this.settings.padStyle;
    this.padLabels = style === 'ps' ? PS_NAMES : style === 'xbox' ? XBOX_NAMES : sony || !/xbox|xinput|045e|microsoft/.test(id) ? PS_NAMES : XBOX_NAMES;
    this.padName = /dualsense|0ce6|0df2/.test(id) ? 'DualSense' : /dualshock|05c4|09cc/.test(id) ? 'DualShock 4' : sony ? 'PlayStation controller' : /xbox|xinput|045e|microsoft/.test(id) ? 'Xbox controller' : 'Controller';
    this.onDevice('connected', this.padName);
  }

  padButtonLabel(i) { return i === undefined || i === null ? '—' : this.padLabels[i] || 'Button ' + i; }

  setDevice(d) {
    if (this.lastDevice !== d) { this.lastDevice = d; this.onDevice('switch', d); }
  }

  // pointer position relative to the canvas (it may sit inside the safe area)
  px(e) { return e.clientX - this.canvas.getBoundingClientRect().left; }
  py(e) { return e.clientY - this.canvas.getBoundingClientRect().top; }

  // ---- touch ----
  // Buttons with a `hold` action fire their tap action on release (<450 ms) and the hold action
  // once the finger stays down; "menu" toggles the secondary-action fan.
  touchDown(e) {
    this.setDevice('touch');
    this.touchUI = true;
    const L = this.touch.layout;
    if (!L) return;
    const p = { id: e.pointerId, x: this.px(e), y: this.py(e), role: null, t: performance.now() };
    for (const b of L.buttons) {
      if (Math.hypot(p.x - b.x, p.y - b.y) > b.r + 6 * L.u) continue;
      p.role = 'btn:' + b.id;
      p.btn = b;
      if (b.id === 'menu') { this.touch.menuOpen = !this.touch.menuOpen; break; }
      this.touch.vis.add(b.id);
      if (!b.hold) { this.touch.buttons.add(b.id); this.tapped.add('touch:' + b.id); }
      if (b.menuItem) this.touch.menuOpen = false;
      break;
    }
    if (!p.role) {
      this.touch.menuOpen = false;
      const inMove = L.leftHanded ? p.x > L.w * 0.5 : p.x < L.w * 0.5;
      if (inMove && !this.touch.move && p.y > L.h * 0.25) { p.role = 'move'; this.touch.move = { ox: p.x, oy: p.y, x: p.x, y: p.y, id: p.id }; }
      else if (!inMove && !this.touch.aim && !L.legacy && p.y > L.h * 0.25) { p.role = 'aim'; this.touch.aim = { ox: p.x, oy: p.y, x: p.x, y: p.y, id: p.id }; }
    }
    this.touch.pointers.set(p.id, p);
  }

  touchMove(e) {
    const p = this.touch.pointers.get(e.pointerId);
    if (!p) return;
    p.x = this.px(e); p.y = this.py(e);
    const st = p.role === 'move' ? this.touch.move : p.role === 'aim' ? this.touch.aim : null;
    if (st) {
      st.x = p.x; st.y = p.y;
      // drag the stick base along when the thumb overshoots
      const R = this.touch.layout.stickR, dx = st.x - st.ox, dy = st.y - st.oy, d = Math.hypot(dx, dy);
      if (d > R * 1.4) { st.ox = st.x - (dx / d) * R * 1.4; st.oy = st.y - (dy / d) * R * 1.4; }
    }
  }

  touchUp(e) {
    const p = this.touch.pointers.get(e.pointerId);
    if (!p) return;
    if (p.role && p.role.startsWith('btn:')) {
      const id = p.role.slice(4);
      this.touch.buttons.delete(id);
      this.touch.vis.delete(id);
      if (p.btn && p.btn.hold && !p.holdFired) this.tapped.add('touch:' + id);
    }
    if (p.role === 'move') this.touch.move = null;
    if (p.role === 'aim') this.touch.aim = null;
    this.touch.pointers.delete(e.pointerId);
  }

  // Touch layout in screen pixels (also used to draw). Few, large primary controls on the right;
  // contextual buttons only when they apply; everything else behind the "≡" menu.
  layoutTouch(W, H, legacy, extra = {}) {
    const s = this.settings.touchScale || 1, lh = !!this.settings.leftHanded;
    const u = Math.max(0.9, Math.min(1.4, Math.min(W, H) / 400)) * s;
    const m = Math.max(12 * u, 12);
    const portrait = H > W;
    const R = (portrait ? 50 : 60) * u;
    const mx = (x) => (lh ? W - x : x);
    const buttons = [];
    const add = (id, label, x, y, r, more = {}) => buttons.push({ id, label, x: mx(x), y, r, ...more });
    const move = { x: m + R + 18 * u, y: H - m - R - 30 * u };
    const A = { x: Math.max(W - m - 150 * u, move.x + 2 * R + 40 * u), y: H - m - (portrait ? 95 : 95) * u };
    if (legacy) add('fire', 'FIRE', A.x, A.y, 46 * u);
    add('jump', 'JUMP', W - m - 40 * u, H - m - 40 * u, 34 * u);
    if (extra.canReload) add('reload', 'R', W - m - 40 * u, H - m - 130 * u, 30 * u);
    add('grenade', extra.throwLabel || 'NADE', A.x - 30 * u, A.y - 112 * u, 30 * u, { hold: 'toggleThrowable', sub: extra.throwCount });
    if (extra.useLabel) add('interact', extra.useLabel, A.x + 72 * u, A.y - 112 * u, 30 * u, { accent: 'use' });
    if (extra.canHeal) add('heal', 'HEAL', m + 40 * u, move.y - R - 70 * u, 28 * u, { accent: extra.lowHp ? 'pulse' : null });
    if (extra.frenzyReady) add('frenzy', 'FRENZY', W - m - 40 * u, H - m - 222 * u, 26 * u, { accent: 'frenzy' });
    // secondary actions behind the menu button (top-right)
    const mb = { x: W - m - 22 * u, y: m + 22 * u + (extra.topOffset || 0) };
    add('menu', this.touch.menuOpen ? '×' : '≡', mb.x, mb.y, 22 * u);
    if (this.touch.menuOpen) {
      const items = [['pause', 'PAUSE'], ['inventory', 'BAG'], ['toggleThrowable', 'NEXT NADE'], ['mine', 'MINE'], ['flashlight', 'LIGHT']];
      if (extra.inLobby) items.splice(2, 2);
      items.forEach(([id, label], i) => add(id, label, mb.x, mb.y + (i + 1) * 54 * u, 24 * u, { menuItem: true }));
    }
    this.touch.layout = { w: W, h: H, u, m, stickR: R, buttons, legacy, leftHanded: lh, portrait,
      moveHome: { x: mx(move.x), y: move.y }, aimHome: { x: mx(A.x), y: A.y } };
    return this.touch.layout;
  }

  stickVec(st) {
    if (!st) return { x: 0, y: 0, mag: 0 };
    const R = this.touch.layout.stickR;
    const dx = (st.x - st.ox) / R, dy = (st.y - st.oy) / R;
    const m = Math.min(1, Math.hypot(dx, dy));
    if (m < 0.12) return { x: 0, y: 0, mag: 0 };
    const a = Math.atan2(dy, dx);
    return { x: Math.cos(a) * m, y: Math.sin(a) * m, mag: m };
  }

  // ---- per-frame ----
  poll() {
    const S = this.settings, dz = S.deadzone;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    this.pad = null;
    for (const gp of pads) if (gp && gp.connected) { this.pad = normalizePad(gp); break; }
    const pb = [];
    let padMove = { x: 0, y: 0, mag: 0 }, padAim = null;
    if (this.pad) {
      if (!this.padName) this.padConnected(this.pad);
      const g = this.pad;
      const now = performance.now(), holdBtns = this.holdButtons();
      for (let i = 0; i < g.buttons.length; i++) {
        const b = g.buttons[i];
        pb[i] = b.pressed || b.value > 0.35;
        if (pb[i]) this.padActiveAt = now;
        if (pb[i] && !this.padPrev[i]) { this.padTapped.add(i); this.setDevice('pad'); this.padDownAt[i] = now; this.padHoldDone[i] = false; }
        if (pb[i] && holdBtns.has(i) && !this.padHoldDone[i] && now - this.padDownAt[i] >= 400) { this.padHoldDone[i] = true; this.padHoldTapped.add(i); }
        if (!pb[i] && this.padPrev[i] && holdBtns.has(i) && !this.padHoldDone[i]) this.padRelease.add(i);
      }
      const ax = g.axes[0] || 0, ay = g.axes[1] || 0, m = Math.hypot(ax, ay);
      if (m > dz || Math.hypot(g.axes[2] || 0, g.axes[3] || 0) > dz) this.padActiveAt = now;
      if (m > dz) { const k = Math.min(1, (m - dz) / (1 - dz)); padMove = { x: (ax / m) * k, y: (ay / m) * k, mag: k }; this.setDevice('pad'); }
      const rx = g.axes[2] || 0, ry = g.axes[3] || 0, rm = Math.hypot(rx, ry);
      if (rm > dz + 0.05) { padAim = { a: Math.atan2(ry, rx), mag: Math.min(1, rm) }; this.setDevice('pad'); }
    }
    this.padButtons = pb;

    // actions
    this.prev = this.down;
    this.down = new Map();
    for (const { id } of ACTIONS) {
      let on = (S.keys[id] || []).some((c) => this.keys.has(c));
      if (!on) { const hb = this.holdButtons(); on = (S.pad[id] || []).some((i) => pb[i] && !hb.has(i)); }
      if (!on) on = this.touch.buttons.has(id);
      this.down.set(id, on);
    }

    // movement vector
    let kx = (this.down.get('right') ? 1 : 0) - (this.down.get('left') ? 1 : 0);
    let ky = (this.down.get('down') ? 1 : 0) - (this.down.get('up') ? 1 : 0);
    let mv = { x: 0, y: 0, mag: 0 };
    if (kx || ky) { const l = Math.hypot(kx, ky); mv = { x: kx / l, y: ky / l, mag: 1 }; }
    else if (padMove.mag) mv = padMove;
    else if (this.touch.move) mv = this.stickVec(this.touch.move);
    this.move = mv;
    this.stickRun = S.stickRun && !(kx || ky) && mv.mag > 0.92;

    // aim
    this.aimFire = false;
    if (padAim) { this.aimAngle = padAim.a; this.aimMag = padAim.mag; this.aimSource = 'pad'; }
    else if (this.touch.aim) {
      const v = this.stickVec(this.touch.aim);
      if (v.mag) { this.aimAngle = Math.atan2(v.y, v.x); this.aimMag = v.mag; this.aimFire = v.mag > 0.45; }
      this.aimSource = 'touch';
    } else if (this.lastDevice === 'kbm') this.aimSource = 'mouse';
    else if (this.lastDevice === 'pad' || this.lastDevice === 'touch') {
      // no stick aim: face the movement direction
      if (mv.mag) this.aimAngle = Math.atan2(mv.y, mv.x);
      this.aimMag = 0;
      this.aimSource = this.lastDevice;
    }
    // touch buttons with a hold action
    const tnow = performance.now();
    for (const p of this.touch.pointers.values()) {
      if (p.btn && p.btn.hold && !p.holdFired && tnow - p.t >= 450) { p.holdFired = true; this.tapped.add('touch:' + p.btn.hold); }
    }
    this.padPrev = pb;
  }

  holdButtons() { return new Set(Object.values(this.settings.padHold || {}).flat()); }
  holdProgress(id) {
    const now = performance.now();
    for (const i of (this.settings.padHold || {})[id] || []) if (this.padButtons && this.padButtons[i] && !this.padHoldDone[i]) return Math.min(1, (now - this.padDownAt[i]) / 400);
    return 0;
  }

  isDown(id) { return !!this.down.get(id); }

  pressed(id) {
    if (this.down.get(id) && !this.prev.get(id)) return true;
    const S = this.settings;
    if ((S.keys[id] || []).some((c) => this.tapped.has(c))) return true;
    const hb = this.holdButtons();
    if ((S.pad[id] || []).some((i) => (hb.has(i) ? this.padRelease.has(i) : this.padTapped.has(i)))) return true;
    if (((S.padHold || {})[id] || []).some((i) => this.padHoldTapped.has(i))) return true;
    return this.tapped.has('touch:' + id);
  }

  endFrame() { this.tapped.clear(); this.padTapped.clear(); this.padRelease.clear(); this.padHoldTapped.clear(); }

  rumble(kind) {
    const g = this.pad;
    if (!this.settings.vibration) return;
    const fx = { shot: [60, 0.15, 0.35], heavy: [120, 0.5, 0.6], hurt: [180, 0.8, 0.4], boom: [350, 1, 0.8] }[kind];
    if (!fx) return;
    // phones: short buzzes for hits and blasts (Android; iOS has no vibration API)
    if (this.lastDevice === 'touch') { if (kind !== 'shot' && navigator.vibrate) { try { navigator.vibrate(Math.round(fx[0] / 3)); } catch { /* blocked */ } } return; }
    if (!g || this.lastDevice !== 'pad') return;
    const act = g.vibrationActuator || (g.hapticActuators && g.hapticActuators[0]);
    try {
      if (act && act.playEffect) act.playEffect('dual-rumble', { duration: fx[0], strongMagnitude: fx[1], weakMagnitude: fx[2] });
      else if (act && act.pulse) act.pulse(fx[1], fx[0]);
    } catch { /* haptics unsupported */ }
  }

  // Short binding hint for the current device, e.g. "R" / "□ Square" / "R".
  hint(id) {
    if (this.lastDevice === 'pad') { const b = (this.settings.pad[id] || [])[0]; return b === undefined ? '' : this.padButtonLabel(b); }
    if (this.lastDevice === 'touch') return '';
    return keyLabel((this.settings.keys[id] || [])[0]);
  }
}
