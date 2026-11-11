// GUN MODS: four attachment slots per gun (muzzle, sight, magazine, stock), in the spirit of
// State of Decay 2. Mods are loot: they drop from the infected and from supply piles in three
// qualities. Your mod bag and what is fitted to each gun are part of the profile, so they carry
// over between runs (and will be tradeable on the market later).
// Effects are multipliers on the gun's stats (fire-rate and reload-time are times: lower is faster),
// plus a few extras the firing code reads: bloom (recoil climb), wobble (moving inaccuracy),
// range, longshot (extra damage at range) and noise (how far the shot alerts the infected).

export const SLOTS = ['muzzle', 'sight', 'mag', 'stock'];
export const SLOT_NAMES = { muzzle: 'Muzzle', sight: 'Sight', mag: 'Magazine', stock: 'Stock' };
export const QUALITY = [
  { name: 'Worn', k: 0.6, col: '#b9b9b9' },
  { name: 'Standard', k: 1, col: '#7dd3ff' },
  { name: 'Mil-spec', k: 1.5, col: '#ffd36b' },
];

const GUNS = ['handgun', 'magnum', 'smg', 'ar', 'lmg', 'shotgun', 'rifle', 'special'];
// fx: stat -> relative change at Standard quality (scaled by quality); add: additive extras
export const MODS = {
  compensator: { slot: 'muzzle', name: 'Compensator', fits: GUNS, fx: { bloom: -0.4 } },
  suppressor: { slot: 'muzzle', name: 'Suppressor', fits: ['handgun', 'smg', 'ar', 'rifle'], fx: { noise: -0.6, damage: -0.05 } },
  brake: { slot: 'muzzle', name: 'Muzzle brake', fits: ['ar', 'lmg', 'rifle', 'magnum'], fx: { damage: 0.08, bloom: -0.15 } },
  choke: { slot: 'muzzle', name: 'Choke', fits: ['shotgun'], fx: { 'spread-angle': -0.35, range: 0.15 } },
  reddot: { slot: 'sight', name: 'Red dot', fits: GUNS, fx: { bloom: -0.2, wobble: -0.25 } },
  scope: { slot: 'sight', name: 'Scope', fits: ['ar', 'rifle', 'lmg'], fx: { range: 0.25 }, add: { longshot: 0.25 } },
  laser: { slot: 'sight', name: 'Laser', fits: GUNS, fx: { wobble: -0.5 } },
  extmag: { slot: 'mag', name: 'Extended mag', fits: GUNS, fx: { 'max-mag': 0.4, 'reload-time': 0.1 } },
  drum: { slot: 'mag', name: 'Drum mag', fits: ['smg', 'ar', 'lmg', 'shotgun'], fx: { 'max-mag': 1, 'reload-time': 0.35 } },
  fastmag: { slot: 'mag', name: 'Speed loader', fits: GUNS, fx: { 'reload-time': -0.3 } },
  stock: { slot: 'stock', name: 'Padded stock', fits: GUNS, fx: { bloom: -0.25 } },
  grip: { slot: 'stock', name: 'Foregrip', fits: GUNS, fx: { wobble: -0.4, bloom: -0.1 } },
  trigger: { slot: 'stock', name: 'Light trigger', fits: ['handgun', 'smg', 'ar', 'rifle', 'magnum'], fx: { 'fire-rate': -0.12, bloom: 0.1 } },
};

export const modId = (key, q) => `${key}:${q}`;
export function parseMod(id) {
  const [key, q] = String(id).split(':');
  const def = MODS[key];
  return def ? { key, q: Math.max(0, Math.min(2, +q || 0)), def } : null;
}
export function modName(id) { const m = parseMod(id); return m ? `${QUALITY[m.q].name} ${m.def.name}` : id; }
export function modColor(id) { const m = parseMod(id); return m ? QUALITY[m.q].col : '#ccc'; }
export function fits(id, item) { const m = parseMod(id); return !!(m && item && item.kind === 'gun' && m.def.fits.includes(item.class)); }
export function modDesc(id) {
  const m = parseMod(id);
  if (!m) return '';
  const label = { damage: 'damage', 'fire-rate': 'time between shots', 'reload-time': 'reload time', 'max-mag': 'magazine', 'spread-angle': 'spread', bloom: 'recoil', wobble: 'moving sway', range: 'range', noise: 'noise' };
  const parts = Object.entries(m.def.fx).map(([k, v]) => `${v > 0 ? '+' : ''}${Math.round(v * QUALITY[m.q].k * 100)}% ${label[k] || k}`);
  for (const [k, v] of Object.entries(m.def.add || {})) parts.push(`+${Math.round(v * QUALITY[m.q].k * 100)}% damage at long range`);
  return parts.join(', ');
}

// Relative multiplier for one stat from everything fitted (1 = unchanged).
export function modMul(fitted, key) {
  let k = 1;
  if (!fitted) return k;
  for (const s of SLOTS) {
    const m = fitted[s] && parseMod(fitted[s]);
    if (m && m.def.fx[key] !== undefined) k *= 1 + m.def.fx[key] * QUALITY[m.q].k;
  }
  return Math.max(0.05, k);
}
export function modAdd(fitted, key) {
  let a = 0;
  if (!fitted) return a;
  for (const s of SLOTS) { const m = fitted[s] && parseMod(fitted[s]); if (m && m.def.add && m.def.add[key]) a += m.def.add[key] * QUALITY[m.q].k; }
  return a;
}

// A random mod: mostly worn, sometimes standard, rarely mil-spec (better odds from bosses).
export function rollMod(boss = false) {
  const keys = Object.keys(MODS), key = keys[Math.floor(Math.random() * keys.length)];
  const r = Math.random(), q = boss ? (r < 0.5 ? 2 : 1) : r < 0.6 ? 0 : r < 0.92 ? 1 : 2;
  return modId(key, q);
}

// ---------- the mod bench (a modal over the game) ----------
export function openModBench(game, onClose) {
  const prof = game.profile;
  if (!prof) return;
  prof.mods = prof.mods || {};
  prof.modBag = prof.modBag || {};
  const root = document.createElement('div');
  root.dataset.modbench = '1';
  root.setAttribute('style', 'position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;font-family:Bebas,Impact,sans-serif;color:#e8e8e8;padding:12px;box-sizing:border-box');
  document.body.append(root);
  const wasPaused = game.paused;
  if (!game.coop) game.paused = true;
  const guns = () => game.slots.filter((s) => s && s.isGun);
  let gi = Math.max(0, guns().indexOf(game.slots[game.cur]));
  const close = () => { root.remove(); window.removeEventListener('keydown', key, true); game.paused = wasPaused; prof.save(); onClose && onClose(); };
  const key = (e) => { if (e.key === 'Escape' || e.key === 'c' || e.key === 'C') { e.stopPropagation(); e.preventDefault(); close(); } };
  window.addEventListener('keydown', key, true);
  const mk = (tag, st, txt) => { const e = document.createElement(tag); if (st) e.setAttribute('style', st); if (txt != null) e.textContent = txt; return e; };
  const btn = (label, fn, ok = true, col = '#ffd36b') => { const b = mk('button', `font:inherit;font-size:16px;letter-spacing:1px;padding:5px 12px;border:1px solid ${ok ? col : '#444'};background:${ok ? '#1e1c12' : '#16181c'};color:${ok ? col : '#777'};cursor:pointer;min-height:34px`, label); b.onclick = ok ? fn : null; return b; };
  const sm = 'font-family:system-ui,sans-serif;font-size:12px;';

  function render() {
    const list = guns(), s = list[gi];
    const panel = mk('div', 'background:#0c0e12;border:1px solid #ffd36b;max-width:640px;width:100%;max-height:92vh;overflow:auto;padding:16px 18px;box-sizing:border-box');
    panel.append(mk('div', 'font-size:30px;color:#ffd36b;letter-spacing:2px', 'GUN MODS'));
    if (!s) { panel.append(mk('div', sm + 'color:#9aa;margin:8px 0', 'Carry a gun to fit mods to it.')); }
    else {
      const tabs = mk('div', 'display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px');
      list.forEach((g2, i) => tabs.append(btn(g2.item.name, () => { gi = i; render(); }, true, i === gi ? '#ffd36b' : '#8892a0')));
      panel.append(tabs);
      const fitted = (prof.mods[s.item.name] = prof.mods[s.item.name] || {});
      s.mods = fitted;
      const st = (k) => s.stat(k);
      panel.append(mk('div', sm + 'color:#cfd;margin-bottom:6px', `${s.item.class.toUpperCase()} · damage ${Math.round(st('damage'))} · magazine ${st('max-mag')} · reload ${(st('reload-time') / 1000).toFixed(2)}s · ${Math.round(60000 / Math.max(1, st('fire-rate')))} rpm`));
      for (const slot of SLOTS) {
        const row = mk('div', 'display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid #1d2026;flex-wrap:wrap');
        const cur = fitted[slot];
        const info = mk('div', 'flex:1;min-width:180px');
        info.append(mk('div', 'font-size:18px;color:#9cd4ff', SLOT_NAMES[slot]));
        info.append(mk('div', `font-size:17px;color:${cur ? modColor(cur) : '#666'}`, cur ? modName(cur) : 'empty'));
        if (cur) info.append(mk('div', sm + 'color:#9aa', modDesc(cur)));
        row.append(info);
        if (cur) row.append(btn('Remove', () => { prof.modBag[cur] = (prof.modBag[cur] || 0) + 1; delete fitted[slot]; render(); }, true, '#ff9b8b'));
        const opts = Object.keys(prof.modBag).filter((id) => prof.modBag[id] > 0 && parseMod(id) && parseMod(id).def.slot === slot && fits(id, s.item));
        for (const id of opts.sort((a, b) => parseMod(b).q - parseMod(a).q)) {
          const b = btn(`${modName(id)} ×${prof.modBag[id]}`, () => {
            if (fitted[slot]) prof.modBag[fitted[slot]] = (prof.modBag[fitted[slot]] || 0) + 1;
            fitted[slot] = id; prof.modBag[id]--; if (!prof.modBag[id]) delete prof.modBag[id];
            s.mag = Math.min(s.mag, s.stat('max-mag'));
            render();
          }, true, modColor(id));
          b.title = modDesc(id);
          row.append(b);
        }
        panel.append(row);
      }
    }
    const bag = Object.entries(prof.modBag).filter(([, n]) => n > 0);
    panel.append(mk('div', 'font-size:20px;margin:12px 0 4px;color:#9cd4ff', `MOD BAG (${bag.reduce((a, [, n]) => a + n, 0)})`));
    panel.append(mk('div', sm + 'color:#cfd;line-height:1.6', bag.length ? bag.map(([id, n]) => `${modName(id)} ×${n}`).join(' · ') : 'Empty. Mods drop from the infected and from supply piles.'));
    const foot = mk('div', 'margin-top:14px');
    foot.append(btn('Close (C)', close));
    panel.append(foot);
    root.replaceChildren(panel);
  }
  render();
}
