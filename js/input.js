// Unified input: keyboard/mouse, gamepads (DualSense-first labels, standard mapping) and touch.
// Everything the game reads goes through named actions so every device can be rebound.

export const ACTIONS = [
  ['up', 'Move up'], ['down', 'Move down'], ['left', 'Move left'], ['right', 'Move right'],
  ['run', 'Run'], ['jump', 'Jump'], ['fire', 'Attack / fire'], ['autofire', 'Legacy auto-fire'], ['grenade', 'Throw grenade'],
  ['reload', 'Reload'], ['interact', 'Use / pick up'], ['heal', 'Quick heal'], ['frenzy', 'Frenzy'],
  ['slot1', 'Melee slot'], ['slot2', 'Sidearm slot'], ['slot3', 'Primary slot'], ['slot4', 'Throwable slot'],
  ['nextWeapon', 'Next weapon'], ['prevWeapon', 'Previous weapon'], ['lastWeapon', 'Last weapon'],
  ['flashlight', 'Flashlight'], ['inventory', 'Inventory'], ['shop', 'Upgrades'], ['pause', 'Pause / back'], ['mute', 'Mute'],
].map(([id, label]) => ({ id, label }));

export const DEFAULT_KEYS = {
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'], jump: ['Space'], fire: ['Mouse0'], autofire: ['KeyF'], grenade: ['Mouse2', 'KeyG'],
  reload: ['KeyR'], interact: ['KeyE'], heal: ['KeyH'], frenzy: ['KeyV'],
  slot1: ['Digit1'], slot2: ['Digit2'], slot3: ['Digit3'], slot4: ['Digit4'],
  nextWeapon: ['WheelDown'], prevWeapon: ['WheelUp'], lastWeapon: ['KeyQ'],
  flashlight: ['KeyL'], inventory: ['Tab', 'KeyI'], shop: ['KeyB'], pause: ['Escape', 'KeyP'], mute: ['KeyM'],
};

// Standard gamepad button indices (DualSense in Chromium/Firefox/Safari use this layout).
export const DEFAULT_PAD = {
  up: [], down: [], left: [], right: [],
  run: [10, 6], fire: [7], autofire: [], grenade: [4],
  jump: [0], reload: [2], interact: [3], heal: [1], frenzy: [11],
  slot1: [], slot2: [], slot3: [], slot4: [],
  nextWeapon: [5, 15], prevWeapon: [14], lastWeapon: [13],
  flashlight: [12], inventory: [8], shop: [17], pause: [9], mute: [],
};

const PS_NAMES = ['✕ Cross', '○ Circle', '□ Square', '△ Triangle', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3',
  'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'PS', 'Touchpad'];
const XBOX_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Guide', 'Share'];

export const DEFAULT_SETTINGS = {
  legacy: false,          // legacy shooting: auto-target the closest visible zed
  showHitChance: true,
  vibration: true,
  deadzone: 0.2,
  stickRun: true,         // full stick tilt runs (pad + touch)
  touchScale: 1,
  touchOpacity: 0.55,
  leftHanded: false,
  touchButtons: ['reload', 'grenade', 'interact', 'heal', 'nextWeapon', 'jump'],
  keys: DEFAULT_KEYS,
  pad: DEFAULT_PAD,
};

export const TOUCH_LABELS = { reload: 'R', grenade: 'NADE', interact: 'USE', heal: 'HEAL', nextWeapon: 'SWAP', prevWeapon: 'PREV',
  lastWeapon: 'LAST', flashlight: 'LIGHT', frenzy: 'FRENZY', run: 'RUN', inventory: 'BAG', shop: 'SHOP', autofire: 'AUTO', jump: 'JUMP' };

const STORE = 'tlcr-settings-v1';
const clone = (o) => JSON.parse(JSON.stringify(o));

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* storage unavailable */ }
  const s = { ...clone(DEFAULT_SETTINGS), ...saved };
  s.keys = { ...clone(DEFAULT_KEYS), ...(saved.keys || {}) };
  s.pad = { ...clone(DEFAULT_PAD), ...(saved.pad || {}) };
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
    this.lastDevice = 'kbm';
    this.aimAngle = 0;
    this.aimMag = 0;             // stick/touch aim strength (0..1)
    this.move = { x: 0, y: 0, mag: 0 };
    this.touchUI = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.touch = { pointers: new Map(), move: null, aim: null, buttons: new Set(), layout: null };
    this.capture = null;         // rebinding callback
    this.onDevice = () => {};
    this.bind();
  }

  bind() {
    const c = this.canvas;
    window.addEventListener('keydown', (e) => {
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
    c.addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.setDevice('kbm'); });
    c.addEventListener('mousedown', (e) => {
      const code = 'Mouse' + e.button;
      if (this.capture && this.capture.kind === 'key') { this.capture.done(code); e.preventDefault(); return; }
      this.keys.add(code); this.tapped.add(code); this.setDevice('kbm');
    });
    window.addEventListener('mouseup', (e) => this.keys.delete('Mouse' + e.button));
    c.addEventListener('wheel', (e) => { this.tapped.add(e.deltaY > 0 ? 'WheelDown' : 'WheelUp'); e.preventDefault(); }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    // touch (pointer events so multi-touch works everywhere)
    c.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { e.preventDefault(); this.touchDown(e); } });
    // move/up on window so releases still register when an overlay opens under the finger
    window.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch' && this.touch.pointers.has(e.pointerId)) this.touchMove(e); });
    const up = (e) => { if (e.pointerType === 'touch') this.touchUp(e); };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    window.addEventListener('gamepadconnected', (e) => this.padConnected(e.gamepad));
  }

  padConnected(gp) {
    const id = gp.id.toLowerCase();
    const sony = /dualsense|dualshock|054c|playstation|wireless controller/.test(id);
    this.padLabels = sony || !/xbox|xinput|045e/.test(id) ? PS_NAMES : XBOX_NAMES;
    this.padName = /dualsense|0ce6|0df2/.test(id) ? 'DualSense' : sony ? 'PlayStation controller' : 'Controller';
    this.onDevice('connected', this.padName);
  }

  padButtonLabel(i) { return i === undefined || i === null ? '—' : this.padLabels[i] || 'Button ' + i; }

  setDevice(d) {
    if (this.lastDevice !== d) { this.lastDevice = d; this.onDevice('switch', d); }
  }

  // ---- touch ----
  touchDown(e) {
    this.setDevice('touch');
    this.touchUI = true;
    const L = this.touch.layout;
    if (!L) return;
    const p = { id: e.pointerId, x: e.clientX, y: e.clientY, role: null };
    for (const b of L.buttons) {
      if (Math.hypot(p.x - b.x, p.y - b.y) <= b.r * 1.15) { p.role = 'btn:' + b.id; this.touch.buttons.add(b.id); this.tapped.add('touch:' + b.id); break; }
    }
    if (!p.role) {
      const inMove = L.leftHanded ? p.x > L.w * 0.5 : p.x < L.w * 0.5;
      if (inMove && !this.touch.move && p.y > L.h * 0.3) { p.role = 'move'; this.touch.move = { ox: p.x, oy: p.y, x: p.x, y: p.y, id: p.id }; }
      else if (!inMove && !this.touch.aim && !L.legacy && p.y > L.h * 0.3) { p.role = 'aim'; this.touch.aim = { ox: p.x, oy: p.y, x: p.x, y: p.y, id: p.id }; }
    }
    this.touch.pointers.set(p.id, p);
  }

  touchMove(e) {
    const p = this.touch.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
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
    if (p.role && p.role.startsWith('btn:')) this.touch.buttons.delete(p.role.slice(4));
    if (p.role === 'move') this.touch.move = null;
    if (p.role === 'aim') this.touch.aim = null;
    this.touch.pointers.delete(e.pointerId);
  }

  // Touch layout in screen pixels; also used to draw the controls.
  layoutTouch(W, H, legacy, extra = {}) {
    const s = this.settings.touchScale || 1, lh = !!this.settings.leftHanded;
    const u = Math.min(W, H) / 400 * s;
    const R = 56 * u, br = 26 * u;
    const mx = (x) => (lh ? W - x : x);
    const buttons = [];
    const add = (id, label, x, y, r = br) => buttons.push({ id, label, x: mx(x), y, r });
    // right cluster
    // right side: aim stick / FIRE at (W-150, H-85); buttons in an edge column and a row above it
    const ax = W - 150 * u, ay = H - 85 * u;
    if (legacy) add('fire', 'FIRE', ax, ay, 46 * u);
    const tb = this.settings.touchButtons || DEFAULT_SETTINGS.touchButtons;
    const spots = [[W - 34 * u, H - 118 * u, br], [W - 92 * u, H - 205 * u, br], [W - 150 * u, H - 205 * u, br],
      [W - 34 * u, H - 176 * u, br * 0.9], [W - 34 * u, H - 60 * u, br * 0.9], [W - 92 * u, H - 30 * u, br * 0.9]];
    tb.forEach((id, i) => { if (id && spots[i]) add(id, TOUCH_LABELS[id] || id.toUpperCase(), ...spots[i]); });
    if (extra.frenzyReady && !tb.includes('frenzy')) add('frenzy', 'FRENZY', W - 208 * u, H - 205 * u, br * 0.9);
    // top bar
    const ty = 26 * u, tr = 17 * u;
    add('pause', 'II', W / 2 - 46 * u, ty, tr);
    add('inventory', 'BAG', W / 2, ty, tr);
    add('shop', 'SHOP', W / 2 + 46 * u, ty, tr);
    add('flashlight', 'LIGHT', W / 2 + 92 * u, ty, tr);
    this.touch.layout = { w: W, h: H, u, stickR: R, buttons, legacy, leftHanded: lh,
      moveHome: { x: mx(100 * u), y: H - 100 * u }, aimHome: { x: mx(W - 150 * u), y: H - 85 * u } };
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
    for (const gp of pads) if (gp && gp.connected) { this.pad = gp; break; }
    const pb = [];
    let padMove = { x: 0, y: 0, mag: 0 }, padAim = null;
    if (this.pad) {
      if (!this.padName) this.padConnected(this.pad);
      const g = this.pad;
      for (let i = 0; i < g.buttons.length; i++) {
        const b = g.buttons[i];
        pb[i] = b.pressed || b.value > 0.35;
        if (pb[i] && !this.padPrev[i]) { this.padTapped.add(i); this.setDevice('pad'); }
      }
      const ax = g.axes[0] || 0, ay = g.axes[1] || 0, m = Math.hypot(ax, ay);
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
      if (!on) on = (S.pad[id] || []).some((i) => pb[i]);
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
    this.padPrev = pb;
  }

  isDown(id) { return !!this.down.get(id); }

  pressed(id) {
    if (this.down.get(id) && !this.prev.get(id)) return true;
    const S = this.settings;
    if ((S.keys[id] || []).some((c) => this.tapped.has(c))) return true;
    if ((S.pad[id] || []).some((i) => this.padTapped.has(i))) return true;
    return this.tapped.has('touch:' + id);
  }

  endFrame() { this.tapped.clear(); this.padTapped.clear(); }

  rumble(kind) {
    const g = this.pad;
    if (!g || !this.settings.vibration || this.lastDevice !== 'pad') return;
    const fx = { shot: [60, 0.15, 0.35], heavy: [120, 0.5, 0.6], hurt: [180, 0.8, 0.4], boom: [350, 1, 0.8] }[kind];
    if (!fx) return;
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
