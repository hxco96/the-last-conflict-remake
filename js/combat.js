import { Atlas } from './assets.js';
import { T } from './map.js';
import { play } from './sfx.js';

const EXPLOSIVE_CLASSES = new Set(['launcher', 'rocket-launcher']);

export function slotFor(item) {
  if (item.kind === 'melee') return 0;
  if (item.kind === 'throwable') return 3;
  if (item.class === 'handgun' || item.class === 'magnum') return 1;
  return 2;
}

export class WeaponSlot {
  constructor(item, data, mag, ups) {
    this.item = item;
    this.data = data;
    this.ups = ups || {}; // shared with the profile => upgrades are permanent
    this.mag = mag ?? item['max-mag'];
    this.cd = 0;
  }
  get name() { return this.item.name; }
  get isGun() { return this.item.kind === 'gun'; }
  get isMelee() { return this.item.kind === 'melee'; }
  get isThrowable() { return this.item.kind === 'throwable'; }
  get ammoKind() { return this.item['ammo-kind']; }
  upgrades() { return this.data.upgrades.get(this.item['sprite-id']) || []; }
  stat(k) {
    const lvl = this.ups[k];
    if (lvl) {
      const u = this.upgrades().find((x) => x.kind === k);
      if (u && u.levels[lvl - 1]) return u.levels[lvl - 1][0];
    }
    return this.item[k];
  }
}

// ---------- Effects ----------
export class Effects {
  constructor(atlas) {
    this.atlas = atlas;
    this.list = [];
  }
  spawn(base, x, y, { rot = 0, scale = 1, dir = 'x', anim = 'default', above = true } = {}) {
    const found = this.atlas.find(base, [anim], [dir, 'x', 's', 'e']);
    if (!found) return;
    this.list.push({ list: found.list, x, y, rot, scale, t: 0, dur: Atlas.duration(found.list), above });
  }
  update(dt) {
    for (const e of this.list) e.t += dt * 1000;
    this.list = this.list.filter((e) => e.t < e.dur);
  }
  draw(ctx) {
    for (const e of this.list) this.atlas.drawCentered(ctx, Atlas.frameAt(e.list, e.t, false), e.x, e.y, e.scale, e.rot);
  }
}

// ---------- Projectiles ----------
export class Projectiles {
  constructor(game) {
    this.game = game;
    this.list = [];
  }

  bullet(o) { this.list.push({ kind: 'bullet', traveled: 0, hit: new Set(), ...o }); }

  update(dt) {
    const g = this.game, map = g.map;
    for (const p of this.list) {
      if (p.kind === 'grenade') { this.updateGrenade(p, dt); continue; }
      const speed = Math.hypot(p.vx, p.vy);
      const total = speed * dt;
      const steps = Math.max(1, Math.ceil(total / 6));
      for (let s = 0; s < steps && !p.dead; s++) {
        p.x += (p.vx * dt) / steps;
        p.y += (p.vy * dt) / steps;
        p.traveled += total / steps;
        if (p.traveled > p.range) { p.dead = true; if (p.explode) this.detonate(p); break; }
        const cx = Math.floor(p.x / T), cy = Math.floor(p.y / T);
        if (map.blocksShot(cx, cy)) {
          p.dead = true;
          if (p.explode) this.detonate(p);
          else if (!p.flame) { g.fx.spawn('bwallhit', p.x - p.vx * 0.01, p.y - p.vy * 0.01, { scale: 0.7 }); if (Math.random() < 0.25) play.ricochet(p.x, p.y); }
          break;
        }
        if (p.hostile) {
          const pl = g.player;
          if (pl.alive && Math.hypot(pl.x - p.x, pl.y - 10 - p.y) < 9) {
            p.dead = true;
            g.hurtPlayer(p.dmg, p.webbed ? 'web' : 'acid');
            if (p.grab && g.ext) g.ext.grabbed(p.grab);
            else if (p.webbed) g.webbed = 1.5;
            g.fx.spawn('acid-half-explode', p.x, p.y, { dir: 'e' });
          }
          continue;
        }
        for (const m of g.mobs) {
          if (!m.alive || p.hit.has(m)) continue;
          if (Math.abs(m.x - p.x) > m.radius + 4 || Math.abs(m.cy - p.y) > m.radius + 8) continue;
          if (p.explode) { p.dead = true; this.detonate(p); break; }
          p.hit.add(m);
          g.damageMob(m, p.dmg, p);
          if (!p.flame) g.fx.spawn('hitpoof', p.x, p.y, { scale: 0.6 });
          if (p.pierce >= 0 && p.hit.size > p.pierce) { p.dead = true; break; }
        }
      }
    }
    this.list = this.list.filter((p) => !p.dead);
  }

  updateGrenade(p, dt) {
    const map = this.game.map;
    p.fuse -= dt;
    const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;
    if (map.blocksShot(Math.floor(nx / T), Math.floor(p.y / T))) p.vx *= -0.5; else p.x = nx;
    if (map.blocksShot(Math.floor(p.x / T), Math.floor(ny / T))) p.vy *= -0.5; else p.y = ny;
    const fr = Math.pow(0.12, dt);
    p.vx *= fr; p.vy *= fr;
    p.spin += dt * 10;
    if (p.fuse <= 0) { p.dead = true; this.detonate(p); }
  }

  detonate(p) {
    this.game.explosion(p.x, p.y, p.radius || 64, p.dmg, p.element || 'fire');
  }

  draw(ctx, atlas) {
    for (const p of this.list) {
      if (p.kind === 'grenade') {
        const f = atlas.frames['item-box_default_x_0'];
        ctx.fillStyle = '#2d3a1f';
        ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#9fb36a'; ctx.lineWidth = 1; ctx.stroke();
        if (!f) continue;
        continue;
      }
      if (p.flame) {
        const found = atlas.find(p.flame, ['default'], ['x']);
        if (found) atlas.drawCentered(ctx, Atlas.frameAt(found.list, p.traveled * 8, true), p.x, p.y, 0.5 + p.traveled / p.range, Math.atan2(p.vy, p.vx));
        continue;
      }
      if (p.sprite && atlas.frames[p.sprite]) {
        atlas.drawCentered(ctx, atlas.frames[p.sprite], p.x, p.y, 1, Math.atan2(p.vy, p.vx));
        continue;
      }
      const len = 7, a = Math.atan2(p.vy, p.vx);
      ctx.strokeStyle = p.hostile ? '#8fe04a' : '#ffe9a0';
      ctx.lineWidth = p.hostile ? 3 : 1.2;
      ctx.beginPath();
      ctx.moveTo(p.x - Math.cos(a) * len, p.y - Math.sin(a) * len);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }
}

// Per-class recoil bloom added per shot (radians) and damage multipliers (balance pass).
export const BLOOM = { handgun: 0.012, magnum: 0.03, smg: 0.009, ar: 0.008, lmg: 0.007, shotgun: 0.02, rifle: 0.04, special: 0.005, bow: 0.02 };
export const CLASS_DMG = {};

// Instant ray: walks the line, stops at walls, damages up to pierce+1 mobs, with range falloff.
export function hitscan(g, o) {
  const map = g.map, cos = Math.cos(o.a), sin = Math.sin(o.a);
  const hit = new Set();
  for (let d = 6; d <= o.range; d += 4) {
    const x = o.x + cos * d, y = o.y + sin * d;
    if (map.blocksShot(Math.floor(x / T), Math.floor(y / T))) {
      g.fx.spawn('bwallhit', x - cos * 3, y - sin * 3, { scale: 0.6 });
      if (Math.random() < 0.2) play.ricochet(x, y);
      return;
    }
    for (const m of g.mobs) {
      if (!m.alive || hit.has(m)) continue;
      if (Math.abs(m.x - x) > m.radius + 2 || Math.abs(m.cy - y) > m.radius + 6) continue;
      hit.add(m);
      const fall = o.pellet ? 1 - 0.5 * Math.min(1, d / o.range) : d > o.range * 0.7 ? 1 - 0.4 * ((d - o.range * 0.7) / (o.range * 0.3)) : 1;
      g.damageMob(m, o.dmg * fall * (1 + (o.longshot || 0) * Math.min(1, d / o.range)), { vx: cos, vy: sin, ang: o.a, crit: o.crit, critMul: o.critMul, stun: o.stun });
      g.fx.spawn(o.pellet ? 'hitpoof' : 'blood-explode', x, y, { scale: o.pellet ? 0.45 : 0.35 });
      if (o.pierce >= 0 && hit.size > o.pierce) return;
    }
  }
}

// ---------- Firing ----------
export function fireWeapon(g, slot, ax, ay) {
  const pl = g.player, it = slot.item;
  const ox = pl.x, oy = pl.y - 11;
  const ang = Math.atan2(ay - oy, ax - ox);
  const perk = g.perkMods(slot);

  if (slot.isMelee) {
    // swings cost stamina; exhausted swings are weaker
    const tired = pl.stamina < 8;
    pl.stamina = Math.max(0, pl.stamina - 8);
    if (tired) perk.dmg *= 0.6;
    const reach = (it.range || 32) + 22;
    let hits = 0;
    for (const m of g.mobs) {
      if (!m.alive) continue;
      const dx = m.x - ox, dy = m.cy - oy, d = Math.hypot(dx, dy);
      if (d > reach + m.radius) continue;
      let da = Math.atan2(dy, dx) - ang;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) > 1.0 && d > 14) continue;
      g.meleeHitAt = performance.now();
      g.damageMob(m, it.damage, { melee: true, ang, crit: perk.crit, stun: perk.stun, mul: perk.dmg, pierce: 0 });
      if (++hits > (it.pierce || 1)) break;
    }
    g.fx.spawn(it.damage >= 100 ? 'slash-big' : 'slash', ox + Math.cos(ang) * 18, oy + Math.sin(ang) * 18, { rot: ang });
    play.swing(it);
    if (hits) play.hit(ox, oy);
    return true;
  }

  if (slot.isThrowable) {
    if (slot.mag <= 0) return false;
    slot.mag--;
    const dist = Math.min(Math.hypot(ax - ox, ay - oy), it.range || 320);
    const sp = dist * 2.3;
    const fire = /incendiary|molotov/i.test(it.name), acid = /acid/i.test(it.name);
    g.projectiles.list.push({
      kind: 'grenade', x: ox, y: oy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, spin: 0,
      fuse: g.hasPerk('ShortFuse') ? 0.55 : 1.4, dmg: it.damage * perk.explosive,
      radius: 70 * perk.radius, element: fire ? 'fire' : acid ? 'acid' : /stun/i.test(it.name) ? 'freeze' : 'reg',
    });
    play.throwNade();
    return true;
  }

  // guns
  if (slot.mag <= 0) { play.dry(); g.startReload(); return false; }
  slot.mag--;
  if (g.hasPerk('AmmoSaver') && Math.random() < 0.3) slot.mag++;
  const pellets = Math.max(1, slot.stat('spread') || 1);
  const spreadRad = ((slot.stat('spread-angle') || 0) * Math.PI) / 180;
  const wobble = (pl.moving ? 0.07 : 0.025) * (pl.running ? 2 : 1);
  const explosive = EXPLOSIVE_CLASSES.has(it.class);
  const flame = it.class === 'thrower' ? (/acid/i.test(it.name) ? 'thrower-acid' : /freeze/i.test(it.name) ? 'thrower-freeze' : 'thrower-flames') : null;
  // recoil bloom: sustained fire widens the cone; it recovers while you pause
  const now = g.time || 0;
  slot.bloom = Math.max(0, (slot.bloom || 0) - (now - (slot.lastShot || 0)) * 0.35) + (BLOOM[it.class] ?? 0.012);
  slot.lastShot = now;
  const bloom = Math.min(0.14, slot.bloom);
  // pellet weapons split 1.6x the listed damage across pellets (a full point-blank hit)
  const dmg = slot.stat('damage') * perk.dmg * (explosive ? perk.explosive : 1) * (CLASS_DMG[it.class] ?? 1) * (pellets > 1 ? 1.6 / pellets : 1);
  for (let i = 0; i < pellets; i++) {
    const off = pellets > 1 ? (i / (pellets - 1) - 0.5) * spreadRad * 2 : 0;
    const a = ang + off + (Math.random() - 0.5) * (wobble + bloom) * 2;
    const speed = flame ? 260 : it.speed || 480;
    if (!explosive && !flame) {
      // hitscan: no visible projectile, just impacts where the round lands
      hitscan(g, { x: ox, y: oy, a, range: it.range || 320, dmg, longshot: perk.longshot, pierce: (it.pierce ?? 0) + perk.pierce,
        crit: perk.crit + (it['crit-chance'] || 0), critMul: it['crit-damage'] || 2, stun: perk.stun || it['stun-chance'] || 0, pellet: pellets > 1 });
      continue;
    }
    g.projectiles.bullet({
      x: ox + Math.cos(ang) * 4, y: oy + Math.sin(ang) * 4,
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
      range: flame ? 110 : it.range || 320, dmg,
      pierce: it.pierce ?? 0, crit: perk.crit + (it['crit-chance'] || 0), critMul: it['crit-damage'] || 2,
      stun: perk.stun || it['stun-chance'] || 0, flame,
      explode: explosive, radius: (it.class === 'rocket-launcher' ? 96 : 64) * perk.radius,
      sprite: it.class === 'bow' ? 'arrow-reg_default_x_0' : it.class === 'rocket-launcher' ? 'rocket-reg_default_x_0' : null,
      element: 'reg',
    });
  }
  if (!flame) {
    g.muzzle = 0.06;
    g.shake = Math.max(g.shake, pellets > 1 || it.damage >= 140 ? 3 : 1.2);
    play.shot(it, ox, oy);
    g.ejectShell(it);
  } else play.shot(it, ox, oy);
  g.alertMobs(ox, oy, it.attraction || 160);
  return true;
}
