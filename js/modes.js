// Original game modes, spawn themes and world features that sit on top of the core loop:
// Evac helicopter (tlcr::app::vehicles::Heli, EvacZone/HeliSpawn markers, "<Radio>" lines),
// tongue grabs (tlcr::app::monster::Tongue / components::Grabbed), web laying and minion spawns
// from mob_db attacks, placeable mines (tlcr::app::inventory::ArmedTrap), lingering fire
// (tilemap::GlobalFlame / GlobalMolotov) and map weather (rain / snow sprites + FMOD ambience).
import { Atlas } from './assets.js';
import { T } from './map.js';
import { play, sample, loop, music } from './sfx.js';
import { Siege } from './siege.js';

// Mode names come from the exe string table; Battle Royale / Death Match are PvP-only.
export const MODES = {
  Survival: { desc: 'Last as long as you can against endless waves' },
  Extermination: { desc: 'Kill 120 infected to clear the area', quota: 120 },
  Evac: { desc: 'Hold out until the helicopter arrives (3:00), then get to it', heliAt: 180 },
  Rescue: { desc: 'Find and rescue every survivor, then evacuate by helicopter' },
  Peaceful: { desc: 'No infected: explore the map, loot and practice' },
  Siege: { desc: 'Persistent campaign: fortify a base by day, hold it against a growing horde by night, recruit survivors', solo: true },
};

// spawn_levels_<theme>.rktd
export const THEMES = {
  Zeds: { table: 'spawn_levels_zeds', desc: 'Infected, then crows, dogs, seekers, reptiles, plants, roachmen, bosses' },
  Spiders: { table: 'spawn_levels_spiders', desc: 'Arachnid infestation with web spinners and queens' },
  Chaos: { table: 'spawn_levels_chaos', desc: 'Zeds and spiders together' },
  Mechs: { table: 'spawn_levels_mechs', desc: 'DRAUGR, LOKI and SKJOLD robots' },
  BossRush: { table: 'spawn_levels_bossrush', desc: 'Back-to-back boss fights' },
};

const RADIO_COMING = "<Radio> We're on our way, head to the evac zone!";
const HELI_FLIGHT = 10;

export class Extras {
  constructor(g) {
    this.g = g;
    this.mode = g.opts.mode || 'Survival';
    this.cfg = MODES[this.mode] || MODES.Survival;
    this.siege = this.mode === 'Siege' && !g.coop ? new Siege(g) : null; // solo only
    this.noSpawn = this.mode === 'Peaceful' || !!this.siege; // the siege runs its own spawner
    this.fires = [];
    this.mines = [];
    this.webs = [];
    this.heli = null;
    this.evacT = 0;
    this.grab = null;
    this.mobTimers = new WeakMap();
    this.mapRef = null;
    this.weather = this.pickWeather();
    this.flash = 0;
    this.thunderT = 6 + Math.random() * 14;
    this.ambient = null;
    this.ambientTry = 0;
    if (this.mode === 'Peaceful') g.msg('Peaceful mode: no infected will spawn', '#9cd4ff');
    else g.msg(this.cfg.desc, '#ffd36b');
  }

  pickWeather() {
    if (this.g.input && this.g.input.settings.weather === false) return 'clear';
    const w = String(this.g.map.props.weather || '').toLowerCase();
    if (/rain|storm/.test(w)) return 'rain';
    if (/snow/.test(w)) return 'snow';
    const r = Math.random();
    return r < 0.3 ? 'rain' : r < 0.45 ? 'snow' : 'clear';
  }

  // ---------- objectives ----------
  objective() {
    const g = this.g;
    if (this.siege) return this.siege.objective();
    if (this.mode === 'Extermination') return `EXTERMINATE  ${Math.min(g.teamKills || 0, this.cfg.quota)} / ${this.cfg.quota}`;
    if (this.mode === 'Evac' && !this.heli) {
      const left = Math.max(0, this.cfg.heliAt - g.time);
      return `HELICOPTER ETA  ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    }
    if (this.mode === 'Rescue' && !this.heli) {
      const s = this.survivors();
      return `RESCUE SURVIVORS  ${s.saved} / ${s.total}`;
    }
    if (this.heli) return this.heli.state === 'landed' ? 'GET TO THE HELICOPTER!' : 'HELICOPTER INBOUND…';
    return '';
  }

  survivors() {
    const all = [];
    for (const f of this.g.floors) if (f) all.push(...(f === this.g.floors[this.g.z] ? this.g.npcs : f.npcs));
    const sv = all.filter((n) => n.kind === 'survivor');
    return { total: sv.length, saved: sv.filter((n) => n.alive && n.mode !== 'idle').length, alive: sv.filter((n) => n.alive).length };
  }

  win(text) {
    const g = this.g;
    if (g.over) return;
    if (g.isClient) { if (!this.winSent) { this.winSent = true; g.coop.net.toHost({ t: 'win', text }); } return; } // the host ends it for everyone
    g.won = text;
    g.over = true;
    g.bark('relief');
    music('Secure Place');
    if (this.heliLoop) this.heliLoop.stop();
    g.onWin && g.onWin(text);
  }

  // ---------- helicopter ----------
  callHeli() {
    if (this.heli) return;
    const g = this.g, map = g.map, pl = g.player;
    const zone = (map.markers.EvacZone || [])[0] || (map.markers.HeliSpawn || [])[0];
    let p = zone ? map.randomWalkable(zone) : null;
    if (!p) {
      // farthest reachable open spot within a sensible range
      let best = null, bd = 0;
      for (let i = 0; i < 40; i++) {
        const q = map.randomWalkable();
        if (!q) continue;
        const d = Math.hypot(q.x - pl.x, q.y - pl.y);
        const reach = g.flow.dist[Math.floor(q.y / T) * map.w + Math.floor(q.x / T)] !== -1;
        if (reach && d > bd && d < 900) { best = q; bd = d; }
      }
      p = best || { x: pl.x, y: pl.y };
    }
    const fromLeft = p.x > map.pw / 2;
    this.heli = { x: fromLeft ? p.x - 900 : p.x + 900, y: p.y - 300, tx: p.x, ty: p.y, t: 0, state: 'incoming', face: fromLeft ? 'e' : 'w' };
    g.msg(RADIO_COMING, '#9cd4ff');
    play.radio();
  }

  updateHeli(dt) {
    const h = this.heli, g = this.g, pl = g.player;
    h.t += dt;
    if (h.state === 'incoming') {
      const k = Math.min(1, h.t / HELI_FLIGHT), e = 1 - Math.pow(1 - k, 3);
      h.x = h.x0 ?? (h.x0 = h.x); h.y0 = h.y0 ?? h.y;
      h.x = h.x0 + (h.tx - h.x0) * e;
      h.y = h.y0 + (h.ty - h.y0) * e;
      h.alt = (1 - e) * 80 + 6;
      if (k >= 1) { h.state = 'landed'; h.alt = 6; g.msg('The helicopter has landed — get in!', '#7dff8a'); }
    }
    if (!this.heliLoop && this.ambientTry <= 0) this.heliLoop = loop('underlineddesigns__heli-rotor-loop', 0.25);
    if (this.heliLoop) {
      const d = Math.hypot(h.x - pl.x, h.y - pl.y);
      this.heliLoop.gain.gain.value = Math.max(0.03, 0.45 * (1 - d / 900));
    }
    if (h.state === 'landed' && pl.alive) {
      const inZone = Math.hypot(h.x - pl.x, h.y - pl.y) < 46;
      this.evacT = inZone ? this.evacT + dt : Math.max(0, this.evacT - dt * 2);
      if (this.evacT >= 2.5) this.win(this.mode === 'Rescue' ? 'Survivors evacuated!' : 'Evacuated!');
    }
  }

  // ---------- mobs: grabs, webs, minions ----------
  grabbed(m) {
    const pl = this.g.player;
    if (!pl.alive || this.grab) return;
    pl.jumpT = 0;
    this.grab = { m, t: 1.3 };
    this.g.msg('Grabbed! Attack or jump to break free', '#ff8b6b');
  }

  updateGrab(dt) {
    const gr = this.grab, g = this.g, pl = g.player;
    const m = gr.m;
    gr.t -= dt;
    if (!m.alive || m.stun > 0 || gr.t <= 0 || !pl.alive) { this.grab = null; return; }
    if (g.input && (g.input.pressed('jump') || g.input.pressed('fire'))) gr.t -= 0.25; // struggle
    const dx = m.x - pl.x, dy = m.y - pl.y, d = Math.hypot(dx, dy);
    if (d > 18) pl.move(g.map, (dx / d) * 110 * dt, (dy / d) * 110 * dt);
    pl.hp -= 5 * dt;
    if (pl.hp <= 0) g.hurtPlayer(1, 'bite');
  }

  updateMobSpecials(dt) {
    const g = this.g;
    for (const m of g.mobs) {
      if (!m.alive) continue;
      let tm = this.mobTimers.get(m);
      if (!tm) {
        tm = (m.def.attacks || []).filter((a) => a.kind === 'lay-web' || a.kind === 'spawn').map((a) => ({ a, t: 3 + Math.random() * (a.cd / 2500) }));
        this.mobTimers.set(m, tm);
      }
      for (const s of tm) {
        s.t -= dt;
        if (s.t > 0) continue;
        s.t = s.a.cd / 1000 * (s.a.kind === 'lay-web' ? 0.35 : 1);
        if (s.a.kind === 'lay-web' && this.webs.length < 40) this.webs.push({ x: m.x, y: m.y - 4, t: 40, r: 14 });
        if (s.a.kind === 'spawn' && s.a['spawn-mob']) {
          for (let i = 0; i < (s.a['spawn-amount'] || 1); i++) {
            const a = Math.random() * Math.PI * 2;
            const c = g.spawnMob(s.a['spawn-mob'], m.x + Math.cos(a) * 20, m.y + Math.sin(a) * 20);
            if (c && g.map.boxHits(c.x, c.y, c.hw, c.hh)) { c.x = m.x; c.y = m.y; }
          }
          g.fx.spawn('dust', m.x, m.y - 6);
        }
      }
    }
  }

  // ---------- mines & fire ----------
  placeMine(name) {
    const g = this.g, pl = g.player, it = g.data.item(name);
    const n = g.items.get(name) || 0;
    if (!n || !it) return false;
    if (this.mines.some((mn) => Math.hypot(mn.x - pl.x, mn.y - pl.y) < 20)) { g.msg('Too close to another mine'); return false; }
    g.items.set(name, n - 1);
    const element = /incendiary/i.test(name) ? 'fire' : /acid/i.test(name) ? 'acid' : /nitro/i.test(name) ? 'freeze' : 'reg';
    this.mines.push({ x: pl.x, y: pl.y - 2, name, element, dmg: it.damage || 675, arm: 1, blink: 0 });
    sample(['mine-place'], { vol: 0.6 });
    g.msg(`${name} placed — arms in 1s`, '#ffd36b');
    return true;
  }

  placeMineItem(it) {
    const g = this.g, pl = g.player;
    if (this.mines.some((mn) => Math.hypot(mn.x - pl.x, mn.y - pl.y) < 20)) { g.msg('Too close to another mine'); return false; }
    const element = /incendiary/i.test(it.name) ? 'fire' : /acid/i.test(it.name) ? 'acid' : /nitro/i.test(it.name) ? 'freeze' : 'reg';
    this.mines.push({ x: pl.x, y: pl.y - 2, name: it.name, element, dmg: it.damage || 675, arm: 1, blink: 0 });
    sample(['mine-place'], { vol: 0.6 });
    g.msg(`${it.name} placed — arms in 1s`, '#ffd36b');
    return true;
  }

  addFire(x, y, r, dur = 6) {
    if (this.fires.length > 24) this.fires.shift();
    const flames = [];
    const n = Math.round(r / 6);
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r; flames.push([Math.cos(a) * d, Math.sin(a) * d * 0.7, Math.random() * 1000]); }
    this.fires.push({ x, y, r, t: dur, flames, tick: 0 });
    sample(['burn'], { vol: 0.5, x, y });
  }

  updateHazards(dt) {
    const g = this.g, pl = g.player;
    // static WebTrap tiles on the current floor
    if (this.mapRef !== g.map) {
      const floorChange = !!this.mapRef;
      this.mapRef = g.map;
      if (floorChange) { this.fires = []; this.mines = []; this.webs = []; }
      this.webs = this.webs.filter((w) => !w.tile);
      for (const layer of g.map.floor().layers || []) {
        if (!layer.data || layer.name.startsWith('top_')) continue;
        layer.data.forEach((raw, i) => {
          const r = g.map.resolve(raw);
          if (r && r.meta.type === 'WebTrap') this.webs.push({ x: (i % g.map.w) * T + 16, y: Math.floor(i / g.map.w) * T + 16, t: Infinity, r: 15, tile: true });
        });
      }
    }
    for (const w of this.webs) {
      w.t -= dt;
      if (pl.alive && !pl.airborne && Math.hypot(w.x - pl.x, w.y - pl.y) < w.r) g.webbed = Math.max(g.webbed, 0.35);
    }
    this.webs = this.webs.filter((w) => w.t > 0);

    for (const mn of this.mines) {
      mn.arm -= dt; mn.blink += dt;
      if (mn.arm > 0) continue;
      if (mn.blink > 1.2) { mn.blink = 0; sample(['beep'], { vol: 0.15, x: mn.x, y: mn.y, range: 250 }); }
      if (g.mobs.some((m) => m.alive && Math.hypot(m.x - mn.x, m.y - mn.y) < 20)) {
        mn.dead = true;
        sample(['mine-explode'], { vol: 0.9, x: mn.x, y: mn.y });
        g.explosion(mn.x, mn.y - 6, 72 * (g.hasPerk('BigBang') ? 1.5 : 1), mn.dmg * (g.hasPerk('BombsAway') ? 1.25 : 1), mn.element);
      }
    }
    this.mines = this.mines.filter((m) => !m.dead);

    for (const f of this.fires) {
      f.t -= dt; f.tick -= dt;
      if (f.tick > 0) continue;
      f.tick = 0.25;
      for (const m of g.mobs) if (m.alive && Math.hypot(m.x - f.x, m.y - f.y) < f.r) g.damageMob(m, 9 * (g.hasPerk('Inferno') ? 1.25 : 1), { ang: 0 });
      if (pl.alive && !pl.airborne && Math.hypot(pl.x - f.x, pl.y - f.y) < f.r * 0.8) g.hurtPlayer(2, 'fire');
    }
    this.fires = this.fires.filter((f) => f.t > 0);
  }

  // ---------- weather ----------
  updateWeather(dt) {
    this.ambientTry -= dt;
    if (this.weather !== 'clear' && !this.ambient && this.ambientTry <= 0) {
      this.ambientTry = 1;
      this.ambient = loop(this.weather === 'rain' ? 'rain' : 'snow-storm', this.weather === 'rain' ? 0.22 : 0.12);
    }
    if (this.weather === 'rain') {
      this.thunderT -= dt;
      if (this.thunderT <= 0) {
        this.thunderT = 12 + Math.random() * 25;
        this.flash = 0.35;
        sample(['thunder-1', 'thunder-2'], { vol: 0.6, delay: 0.3 + Math.random() * 0.8 });
      }
    }
    this.flash = Math.max(0, this.flash - dt);
  }

  update(dt) {
    const g = this.g;
    if (g.over) return;
    this.updateWeather(dt);
    if (this.siege) this.siege.update(dt);
    if (this.noSpawn) {} // Peaceful
    if (this.mode === 'Extermination' && (g.teamKills || 0) >= this.cfg.quota) this.win('Area exterminated!');
    if (this.mode === 'Evac' && !this.heli && g.time >= this.cfg.heliAt) this.callHeli();
    if (this.mode === 'Rescue' && !this.heli) {
      const s = this.survivors();
      if (s.total && s.saved >= s.alive && s.alive > 0) { g.msg('All survivors found — calling evac!', '#7dff8a'); this.callHeli(); }
      if (s.total && s.alive === 0) g.msg('All survivors are dead…', '#ff6b6b');
    }
    if (this.heli) this.updateHeli(dt);
    if (this.grab) this.updateGrab(dt);
    this.updateMobSpecials(dt);
    this.updateHazards(dt);
  }

  // ---------- drawing ----------
  drawGround(ctx) {
    const g = this.g, A = g.atlas.combat;
    if (this.siege) this.siege.drawGround(ctx);
    for (const w of this.webs) {
      if (w.tile) continue;
      ctx.strokeStyle = `rgba(230,230,230,${Math.min(0.55, w.t / 6)})`;
      ctx.lineWidth = 0.6;
      for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 3; ctx.beginPath(); ctx.moveTo(w.x, w.y); ctx.lineTo(w.x + Math.cos(a) * w.r, w.y + Math.sin(a) * w.r * 0.7); ctx.stroke(); }
      for (const k of [0.4, 0.75]) { ctx.beginPath(); ctx.ellipse(w.x, w.y, w.r * k, w.r * k * 0.7, 0, 0, 7); ctx.stroke(); }
    }
    for (const mn of this.mines) {
      if (!g.data.drawIcon(ctx, mn.name, mn.x - 8, mn.y - 8, 16)) { ctx.fillStyle = '#555'; ctx.fillRect(mn.x - 4, mn.y - 3, 8, 6); }
      if (mn.arm <= 0 && mn.blink < 0.2) { ctx.fillStyle = '#ff2b2b'; ctx.beginPath(); ctx.arc(mn.x, mn.y - 2, 1.5, 0, 7); ctx.fill(); }
    }
    const fl = A.find('thrower-flames', ['default'], ['x']);
    for (const f of this.fires) {
      ctx.globalAlpha = Math.min(1, f.t);
      for (const [dx, dy, ph] of f.flames) {
        if (fl) A.drawCentered(ctx, Atlas.frameAt(fl.list, g.time * 1000 + ph), f.x + dx, f.y + dy - 4, 0.7);
      }
      ctx.globalAlpha = 1;
    }
    if (this.heli && this.heli.state === 'landed') {
      const h = this.heli;
      ctx.strokeStyle = `rgba(125,255,138,${0.5 + 0.3 * Math.sin(g.time * 5)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(h.x, h.y, 46, 32, 0, 0, 7); ctx.stroke();
      if (this.evacT > 0) { ctx.strokeStyle = '#7dff8a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(h.x, h.y, 50, 36, 0, -Math.PI / 2, -Math.PI / 2 + (this.evacT / 2.5) * Math.PI * 2); ctx.stroke(); }
    }
  }

  drawAir(ctx) {
    const g = this.g, A = g.atlas.combat;
    if (this.grab) {
      const m = this.grab.m, pl = g.player;
      ctx.strokeStyle = '#a2303f'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(m.x, m.cy); ctx.quadraticCurveTo((m.x + pl.x) / 2, (m.cy + pl.y) / 2 - 8, pl.x, pl.y - 12); ctx.stroke();
    }
    const h = this.heli;
    if (h) {
      const body = A.find('heli', ['default'], [h.face, 'e']);
      const rotor = A.frames['heli-rotor_default_e_0'];
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(h.x, h.y, 34, 10, 0, 0, 7); ctx.fill();
      const flip = h.face === 'w' && body && body.dir !== 'w';
      if (body) A.draw(ctx, Atlas.frameAt(body.list, g.time * 1000), h.x, h.y - h.alt, flip, 1);
      if (rotor) {
        ctx.save(); ctx.translate(h.x, h.y - h.alt - 30); ctx.rotate(g.time * 25);
        A.drawCentered(ctx, rotor, 0, 0, 1); ctx.restore();
      }
      if (h.state === 'landed') {
        const wind = A.find('heli-wind', ['default'], ['x']);
        if (wind) A.drawCentered(ctx, Atlas.frameAt(wind.list, g.time * 1000), h.x, h.y, 2);
      }
    }
  }

  interactable() { return this.siege ? this.siege.interactable() : null; }

  lights(hole) {
    if (this.siege) this.siege.lights(hole);
    for (const f of this.fires) hole(f.x, f.y - 4, f.r * 2.2, Math.min(0.8, f.t * 0.4));
    if (this.heli) hole(this.heli.x, this.heli.y, 130, 0.7);
  }

  drawScreen(ctx, W, H, u) {
    const g = this.g, A = g.atlas.combat;
    if (this.siege) this.siege.drawScreen(ctx, W, H, u);
    // weather overlay
    if (this.weather !== 'clear' && g.cam) {
      const fr = A.find(this.weather === 'rain' ? 'weather-rain-heavy' : 'weather-snow-heavy', ['default'], ['x']) || A.find('weather-' + this.weather, ['default'], ['x']);
      if (fr) {
        const f = Atlas.frameAt(fr.list, g.time * 1000);
        const z = g.zoom, sw = f[6] * z, sh = f[7] * z;
        const ox = -((g.cam.x * z) % sw), oy = -((g.cam.y * z) % sh);
        ctx.globalAlpha = this.weather === 'rain' ? 0.55 : 0.7;
        for (let y = oy - sh; y < H; y += sh) for (let x = ox - sw; x < W; x += sw) ctx.drawImage(A.image, f[0], f[1], f[2], f[3], x + f[4] * z, y + f[5] * z, f[2] * z, f[3] * z);
        ctx.globalAlpha = 1;
      }
      if (this.weather === 'rain') { ctx.fillStyle = 'rgba(20,30,50,0.12)'; ctx.fillRect(0, 0, W, H); }
    }
    if (this.flash > 0) { ctx.fillStyle = `rgba(220,230,255,${this.flash * 1.4})`; ctx.fillRect(0, 0, W, H); }
    // objective banner
    const obj = this.objective();
    if (obj) {
      ctx.font = `${16 * u}px Bebas, Impact, sans-serif`;
      ctx.textAlign = 'center';
      const mb = g.miniBox, w = ctx.measureText(obj).width + 24 * u;
      let y = (g.input && g.input.touchUI && g.input.lastDevice === 'touch') ? 54 * u : 10 * u + 4;
      if (mb && mb.x < W / 2 + w / 2 && mb.x + mb.w > W / 2 - w / 2 && mb.y < y + 24 * u) y = mb.y + mb.h + 6 * u; // under a top-centre minimap
      ctx.fillStyle = 'rgba(8,10,14,0.75)'; ctx.fillRect(W / 2 - w / 2, y, w, 24 * u);
      ctx.fillStyle = this.heli ? '#7dff8a' : '#ffd36b';
      ctx.fillText(obj, W / 2, y + 18 * u);
      ctx.textAlign = 'left';
    }
    // off-screen arrow to the helicopter
    const h = this.heli;
    if (h && g.cam) {
      const sx = (h.x - g.cam.x) * g.zoom, sy = (h.y - g.cam.y) * g.zoom;
      if (sx < 0 || sy < 0 || sx > W || sy > H) {
        const cx = W / 2, cy = H / 2, a = Math.atan2(sy - cy, sx - cx);
        const r = Math.min(W, H) / 2 - 40;
        const ax = cx + Math.cos(a) * r, ay = cy + Math.sin(a) * r;
        ctx.save(); ctx.translate(ax, ay); ctx.rotate(a);
        ctx.fillStyle = '#7dff8a';
        ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -9); ctx.lineTo(-8, 9); ctx.closePath(); ctx.fill();
        ctx.restore();
        const icon = A.frames['evac_default_x_0'];
        if (icon) A.drawCentered(ctx, icon, ax - Math.cos(a) * 26, ay - Math.sin(a) * 26, (22 * u) / Math.max(icon[6], icon[7]));
      }
    }
  }

  stop() {
    if (this.siege) this.siege.stop();
    if (this.ambient) this.ambient.stop();
    if (this.heliLoop) this.heliLoop.stop();
  }
}
