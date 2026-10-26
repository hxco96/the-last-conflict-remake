// Survival director: keeps long runs brutal instead of flat.
// * Endless THREAT: after minute 3 every minute adds +10% zed HP and +6% zed damage, spawns speed up
//   and the population cap keeps growing past the old 50 ceiling.
// * Elites: armored (takes 35% less damage), frenzied (fast) and bloated (bursts into acid on death)
//   become more common as threat rises and during hordes.
// * HORDE NIGHTS: first at 4:00, then every 5 minutes. A siren warns you 12 s ahead, then zeds pour in
//   from every edge, all of them hunting you. Survive it and a supply drop lands at your feet.
// * Brutal feedback (local only): gibs and blood sprays, kill streaks, a damage-pulse vignette.
// In co-op the host runs the clock and the elite rolls; clients get the phase through 'dir' messages.
import { play, sample, music, siren } from './sfx.js';

export const HORDE_FIRST = 240, HORDE_EVERY = 300, HORDE_WARN = 12, HORDE_LEN = 75;
const ELITES = {
  A: { name: 'Armored', color: '#9fb4c8', hp: 2.2 },
  F: { name: 'Frenzied', color: '#ff5a3a', hp: 1.1, speed: 1.45 },
  B: { name: 'Bloated', color: '#8fe04a', hp: 1.4 },
};
const STREAKS = [[30, 'UNSTOPPABLE'], [20, 'MASSACRE'], [12, 'SLAUGHTER'], [7, 'BRUTAL'], [4, 'CARNAGE']];
const SPLAT = ['tongue-wrap-universfield-blood-splatter-122253'];

export class Director {
  constructor(g) {
    this.g = g;
    this.on = !g.opts.lobby && g.opts.mode !== 'Peaceful';
    this.phase = 'calm';     // calm | warn | horde
    this.phaseT = 0;
    this.nextHorde = HORDE_FIRST;
    this.hordes = 0;
    this.gibs = [];
    this.streak = 0; this.streakT = 0; this.streakText = null; this.streakShow = 0;
    this.pulse = 0;
    this.sendT = 0;
  }

  get minutes() { return this.g.time / 60; }
  get threat() { return 1 + Math.floor(this.minutes) + this.hordes * 2; }
  get hpMul() { return this.on ? 1 + 0.1 * Math.max(0, this.minutes - 3) + 0.15 * this.hordes : 1; }
  get dmgMul() { return this.on ? 1 + 0.06 * Math.max(0, this.minutes - 3) + 0.08 * this.hordes : 1; }
  get horde() { return this.phase === 'horde'; }
  get gore() { const s = this.g.input && this.g.input.settings; return !s || s.gore !== false; }

  // ---------- clock ----------
  update(dt) {
    this.pulse = Math.max(0, this.pulse - dt * 1.4);
    this.streakT -= dt;
    if (this.streakT <= 0) this.streak = 0;
    this.streakShow -= dt;
    this.updateGibs(dt);
    if (!this.on || this.g.over) return;
    const g = this.g;
    if (g.isClient) { this.phaseT = Math.max(0, this.phaseT - dt); return; }
    if (this.phase === 'calm' && g.time >= this.nextHorde - HORDE_WARN) this.setPhase('warn', HORDE_WARN);
    else if (this.phase === 'warn') { this.phaseT -= dt; if (this.phaseT <= 0) this.setPhase('horde', HORDE_LEN + 15 * this.hordes); }
    else if (this.phase === 'horde') {
      this.phaseT -= dt;
      for (const m of g.mobs) m.seen = true; // every zed on the map is coming for you
      if (this.phaseT <= 0) { this.hordes++; this.nextHorde = g.time + HORDE_EVERY; this.setPhase('calm', 0); }
    }
    if (g.isHost) { this.sendT -= dt; if (this.sendT <= 0) { this.sendT = 1; this.broadcast(); } }
  }

  setPhase(p, t) {
    const was = this.phase;
    this.phase = p; this.phaseT = t;
    this.announce(p, was);
    if (this.g.isHost) this.broadcast();
  }

  broadcast() { this.g.coop.net.broadcast({ t: 'dir', p: this.phase, pt: Math.round(this.phaseT), h: this.hordes, tm: Math.round(this.g.time), nh: Math.round(this.nextHorde), r: this.g.session ? this.g.session.round : 0 }); }

  // co-op client: host's director state
  applyNet(m) {
    if (m.h !== this.hordes || m.p !== this.phase) {
      const was = this.phase;
      this.hordes = m.h; this.phase = m.p;
      if (was !== m.p) this.announce(m.p, was);
    }
    this.phaseT = m.pt;
    this.nextHorde = m.nh;
    if (Math.abs(this.g.time - m.tm) > 2) this.g.time = m.tm; // same clock as the host (threat, loot tiers)
  }

  announce(p, was) {
    const g = this.g;
    if (p === 'warn') { g.msg('⚠ HORDE INCOMING — find cover, barricade, reload!', '#ff4b4b'); siren(HORDE_WARN); }
    if (p === 'horde') { g.msg(`HORDE NIGHT ${this.hordes + 1} — SURVIVE!`, '#ff2b2b'); music('Seizure of Power', true); g.shake = Math.max(g.shake, 6); sample(['universfield-shock-scream-02-277551'], { vol: 0.5 }); }
    if (p === 'calm' && was === 'horde') {
      g.msg(`Horde ${this.hordes} survived! Supplies dropped at your feet. Threat rises…`, '#7dff8a');
      music('playlist', true);
      this.supplyDrop();
    }
  }

  // ammo, meds and a weapon roll near your survivor (each player gets their own)
  supplyDrop() {
    const g = this.g, pl = g.player;
    if (g.ghost || !pl.alive) return;
    const near = () => g.map.randomWalkable({ x: pl.x - 48, y: pl.y - 48, w: 96, h: 96 }) || { x: pl.x, y: pl.y };
    const put = (name, amount = null, force = false) => { const p = near(); g.pickups.push(g.makePickup(name, p.x, p.y - 6, amount, null, force)); };
    for (let i = 0; i < 3 + this.hordes; i++) { const d = g.data.rollDrop(0); if (d) put(d.name); }
    put('Herb-G', 1); put(Math.random() < 0.5 ? 'Herb-R' : 'Herb-B', 1);
    const w = g.rollLoot(2, true); if (w) put(w.name, null, true);
    g.fx.spawn('dust', pl.x, pl.y - 6, { scale: 2 });
    play.radio();
  }

  // ---------- spawns ----------
  spawnTuning(cap, interval) {
    if (!this.on) return [cap, interval];
    const over = Math.max(0, this.minutes - 5);
    cap += Math.min(30, over * 3) + this.hordes * 4;
    interval /= 1 + 0.06 * over;
    if (this.phase === 'horde') { cap = cap * 1.8 + 10; interval = Math.min(interval, 0.3); }
    if (this.phase === 'warn') interval *= 2.5; // the calm before the storm
    return [cap, Math.max(0.2, interval)];
  }

  onSpawn(m) {
    if (!this.on) return;
    m.maxHp = m.hp = Math.round(m.maxHp * this.hpMul);
    if (m.boss) return;
    const chance = Math.min(0.3, 0.03 * Math.max(0, this.minutes - 2) + this.hordes * 0.03) + (this.horde ? 0.12 : 0);
    if (Math.random() < chance) this.makeElite(m, 'AFB'[(Math.random() * 3) | 0]);
  }

  makeElite(m, e) {
    const E = ELITES[e];
    if (!E) return;
    m.elite = e;
    if (!m.eliteApplied) {
      m.eliteApplied = true;
      if (!this.g.isClient) { m.maxHp = m.hp = Math.round(m.maxHp * E.hp); if (E.speed) m.speed *= E.speed; }
      if (e === 'A') m.eliteArmor = 0.35;
    }
  }

  // host/solo: a zed died
  onKill(m) {
    if (m.elite === 'B') {
      const g = this.g;
      g.explosion(m.x, m.cy, 56, 60, 'acid');
      const pl = g.player;
      if (!g.ghost && pl.alive && Math.hypot(pl.x - m.x, pl.y - m.y) < 52) g.hurtPlayer(22, 'acid');
      if (g.coop) for (const a of g.coop.targets(g)) if (Math.hypot(a.x - m.x, a.y - m.y) < 52) g.coop.hurtRemote(a, 22, 'acid');
    }
  }

  // your kill: streak counter
  onMyKill() {
    this.streak = this.streakT > 0 ? this.streak + 1 : 1;
    this.streakT = 2.6;
    const s = STREAKS.find(([n]) => this.streak >= n);
    if (s && this.streak > 1) { this.streakText = `${s[1]}  ×${this.streak}`; this.streakShow = 1.6; }
  }

  // Ammo gets scarcer the longer you last; crafting and melee start to matter.
  dropChance() { return this.on ? Math.max(0.4, 1 - 0.05 * Math.max(0, this.minutes - 4)) : 1; }

  hurt(dmg) { this.pulse = Math.min(1, this.pulse + dmg / 35); }

  // ---------- gore ----------
  goreBurst(m) {
    if (!this.gore || this.g.hasPerk('Sanitation')) return;
    const n = m.boss ? 14 : 3 + ((Math.random() * 5) | 0);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * (m.boss ? 160 : 110);
      this.gibs.push({ x: m.x, y: m.y - 4, z: 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6, vz: 60 + Math.random() * 90, r: 1 + Math.random() * 1.8, t: 0, chunk: Math.random() < 0.35 });
    }
    if (this.gibs.length > 300) this.gibs.splice(0, this.gibs.length - 300);
    sample(SPLAT, { x: m.x, y: m.y, vol: 0.35, gap: 0.08 });
  }

  updateGibs(dt) {
    for (const p of this.gibs) {
      p.t += dt;
      p.vz -= 320 * dt;
      p.z += p.vz * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.z <= 0) { p.dead = true; this.g.bloodDecal(p.x, p.y, p.chunk ? 0.4 : 0.22); }
    }
    this.gibs = this.gibs.filter((p) => !p.dead);
  }

  drawGibs(ctx) {
    for (const p of this.gibs) {
      ctx.fillStyle = p.chunk ? '#5a0a0a' : '#a3120f';
      ctx.fillRect(p.x - p.r, p.y - p.z - p.r, p.r * 2, p.r * 2);
    }
  }

  drawElite(ctx, m) {
    const E = ELITES[m.elite];
    if (!E) return;
    ctx.strokeStyle = E.color;
    ctx.globalAlpha = 0.55 + 0.25 * Math.sin(this.g.time * 6);
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(m.x, m.y - 1, m.radius + 3, (m.radius + 3) * 0.45, 0, 0, 7); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ---------- screen ----------
  drawScreen(ctx, W, H) {
    const g = this.g, inp = g.input;
    const touch = !!(inp && inp.touchUI && inp.lastDevice === 'touch');
    const u = touch ? Math.max(0.75, Math.min(W, H) / 430) : Math.max(1, Math.round(H / 400));
    // damage pulse: the harder you get hit, the redder the edges
    if (this.pulse > 0.02 && !g.ghost) {
      const gr = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.65);
      gr.addColorStop(0, 'rgba(150,0,0,0)'); gr.addColorStop(1, `rgba(170,0,0,${0.55 * this.pulse})`);
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    }
    if (!this.on) return;
    if (this.horde) { ctx.fillStyle = `rgba(110,0,0,${0.13 + 0.05 * Math.sin(g.time * 2)})`; ctx.fillRect(0, 0, W, H); }
    ctx.textAlign = 'center';
    if (this.phase === 'warn' || this.horde) {
      // below the top HUD panels, above the player
      const text = this.horde ? `HORDE NIGHT ${this.hordes + 1} — SURVIVE ${Math.ceil(this.phaseT)}s` : `⚠ HORDE INCOMING ${Math.ceil(this.phaseT)}`;
      ctx.font = `${Math.round(20 * u)}px Bebas, Impact, sans-serif`;
      const w = ctx.measureText(text).width + 24 * u, y = Math.max(H * 0.3, 140 * u);
      ctx.fillStyle = 'rgba(8,0,0,0.6)'; ctx.fillRect(W / 2 - w / 2, y - 20 * u, w, 27 * u);
      ctx.fillStyle = this.horde ? '#ff3b3b' : (Math.floor(g.time * 3) % 2 ? '#ffd36b' : '#ff6b6b');
      ctx.fillText(text, W / 2, y);
    }
    // threat badge under the top-left HUD
    ctx.textAlign = 'left';
    ctx.font = `${Math.round(13 * u)}px Bebas, sans-serif`;
    const t = this.threat;
    ctx.fillStyle = t >= 12 ? '#ff3b3b' : t >= 7 ? '#ff8a3a' : '#ffd36b';
    const nextIn = Math.max(0, Math.ceil(this.nextHorde - g.time));
    const label = `THREAT ${t}${this.hordes ? ` · HORDES ${this.hordes}` : ''}${this.phase === 'calm' && nextIn < 60 ? ` · horde in ${nextIn}s` : ''}`;
    // touch HUD: the top-left panel is taller, so the badge sits under the weapon panel on the right
    if (touch) { ctx.textAlign = 'right'; ctx.fillText(label, W - 16 * u, 112 * u); ctx.textAlign = 'left'; }
    else ctx.fillText(label, 16 * u, 96 * u);
    if (this.streakShow > 0 && this.streakText) {
      ctx.textAlign = 'center';
      ctx.font = `${Math.round((26 + Math.min(10, this.streak)) * u)}px Bebas, Impact, sans-serif`;
      ctx.globalAlpha = Math.min(1, this.streakShow * 2);
      const sy = Math.max(H * 0.3, 140 * u) + 36 * u;
      ctx.fillStyle = '#000'; ctx.fillText(this.streakText, W / 2 + 2 * u, sy + 2 * u);
      ctx.fillStyle = '#ff4b4b'; ctx.fillText(this.streakText, W / 2, sy);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
  }
}

// How you died, for the results screen.
export const CAUSES = { bite: 'eaten alive', rush: 'run down', acid: 'melted by acid', web: 'caught in a web', fire: 'burned', blast: 'blown up', infection: 'the infection took you', bleed: 'bled out' };
