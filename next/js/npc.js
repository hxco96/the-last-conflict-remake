import { Player, dirOf, cellOf, WALK, RUN, JUMP_TIME } from './actors.js';
import { T } from './map.js';
import { play } from './sfx.js';
import { hitscan } from './combat.js';

// Friendly humans from the original map markers: "Soilder" (object name "Soldier") spawns armed
// soldiers that join your squad when you reach them; "Survivor" spawns civilians who call for help
// (say_caged_help) until you rescue them with Use (say_caged_free). Both can be downed and revived.

const HAIR_M = ['hair-m-2', 'hair-m-16', 'hair-m-17', 'hair-m-18', 'hair-billy', 'hair-trison', 'hair-chris', 'hair-dally', 'hair-hao', 'hair-kurt', 'hair-janus', 'hair-ponyboy'];
const HAIR_F = ['hair-f-pony', 'hair-f-pigtail', 'hair-f-pony2', 'hair-f-long', 'hair-f-alice', 'hair-f-tifa', 'hair-f-21', 'hair-f-22'];
const PANTS = ['pants-12', 'pants-f-jill'];
const SHIRTS = ['ushirt-12', 'ushirt-dress', 'ushirt-m-cop', 'ushirt-f-cop'];
const COATS = ['oshirt-12', 'oshirt-lab', 'oshirt-cjacket'];
const SOLDIER_GUNS = ['M4A1-Carbine', 'AK-47', 'MP5', 'M16', 'Spas-12', 'UMP45', 'SA80', 'Beretta92', 'Police-Handgun'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function randomLook(kind, atlas) {
  const n = Math.floor(Math.random() * 6);
  const female = Math.random() < (kind === 'soldier' ? 0.25 : 0.5);
  const hair = female ? pick(HAIR_F) : pick(HAIR_M);
  let layers;
  if (kind === 'soldier') layers = ['body-army', 'head-nbase' + n, 'pupil', hair].concat(Math.random() < 0.35 ? ['hat-bandana'] : []);
  else layers = ['body-nbase' + n, pick(PANTS), pick(SHIRTS)].concat(Math.random() < 0.4 ? [pick(COATS)] : [], ['head-nbase' + n, 'pupil', hair]);
  return { female, layers: layers.filter((b) => atlas.bases.has(b)) };
}

export class NPC extends Player {
  constructor(x, y, kind, look, name, weapon) {
    super(x, y, look, kind);
    this.kind = kind;
    this.name = name;
    this.female = look.female;
    this.weapon = weapon;
    this.mag = weapon ? weapon['max-mag'] : 0;
    this.maxHp = this.hp = kind === 'soldier' ? 120 : 70;
    this.mode = kind === 'soldier' ? 'guard' : 'idle';
    this.cd = Math.random() * 500;
    this.reloadT = 0;
    this.recoilT = 0;
    this.flashT = 0;
    this.scanT = Math.random() * 0.3;
    this.target = null;
    this.downT = 0;
    this.dead = false;
    this.barkT = 3 + Math.random() * 10;
    this.aim = Math.random() * Math.PI * 2;
    this.leash = 90 + Math.random() * 80; // how far from the player this one is happy to drift
    this.fallbackT = 0;
    this.jumpCd = 0;
    this.allies = [];
    this.group = null;
    this.fbBark = 0;
    this.dir = dirOf(Math.cos(this.aim), Math.sin(this.aim));
  }

  get npc() { return true; }
  get active() { return this.alive && !this.dead; }
  say(list) { if (list && list.length) this.bark = { text: list[Math.floor(Math.random() * list.length)], t: 2.6 }; }
}

export function spawnNPC(game, kind, x, y) {
  const look = randomLook(kind, game.atlas.core);
  const names = look.female ? game.assets.barks.names_f : game.assets.barks.names_m;
  const name = names && names.length ? names[Math.floor(Math.random() * Math.min(names.length, 200))] : kind;
  const weapon = kind === 'soldier' ? game.data.item(pick(SOLDIER_GUNS)) : null;
  const n = new NPC(x, y, kind, { name, ...look }, name, weapon);
  n.homeX = x; n.homeY = y;
  game.npcs.push(n);
  return n;
}

// Nearest visible living mob within reach.
function scan(game, n, reach) {
  let best = null, bd = reach;
  for (const m of game.mobs) {
    if (!m.alive) continue;
    const d = Math.hypot(m.x - n.x, m.cy - (n.y - 11));
    if (d < bd && game.map.los(n.x, n.y - 11, m.x, m.cy)) { bd = d; best = m; }
  }
  return best;
}

export function updateNPC(game, n, dt) {
  if (n.dead) return;
  const B = game.assets.barks, pl = game.player, map = game.map;
  if (n.bark) { n.bark.t -= dt; if (n.bark.t <= 0) n.bark = null; }
  if (!n.alive) {
    n.downT -= dt;
    if (n.downT <= 0) { n.dead = true; game.msg(`${n.name} didn't make it.`, '#ff8b8b'); }
    return;
  }
  n.animT += dt * 1000;
  n.hurtT -= dt;
  n.cd -= dt * 1000;
  n.recoilT -= dt;
  n.flashT -= dt;
  const dP = Math.hypot(pl.x - n.x, pl.y - n.y);

  // soldiers join your squad when you reach them
  if (n.mode === 'guard' && pl.alive && dP < 110) {
    n.mode = 'follow';
    n.say(['On you!', 'With you.', 'Lead the way.', 'Moving with you.', "Let's go!"]);
    game.msg(`${n.name} joined your squad`, '#9cff9c');
  }
  // trapped survivors call for help
  n.barkT -= dt;
  if (n.barkT <= 0) {
    n.barkT = 8 + Math.random() * 12;
    if (n.mode === 'idle' && dP < 360) n.say(B.caged_help);
    else if (game.mobs.filter((m) => m.alive && Math.hypot(m.x - n.x, m.y - n.y) < 120).length >= 5) n.say(B.swarmed);
  }

  // combat
  n.scanT -= dt;
  const reach = n.weapon ? Math.min(n.weapon.range || 320, 300) : 36;
  if (n.scanT <= 0) { n.scanT = 0.25; n.target = scan(game, n, reach); sense(game, n); }
  const t = n.target && n.target.alive ? n.target : null;
  if (t) {
    n.aim = Math.atan2(t.cy - (n.y - 11), t.x - n.x);
    if (n.weapon) {
      if (n.reloadT > 0) { n.reloadT -= dt; if (n.reloadT <= 0) n.mag = n.weapon['max-mag']; }
      else if (n.mag <= 0) { n.reloadT = (n.weapon['reload-time'] || 2000) / 1000; play.reload(n.weapon); }
      else if (n.cd <= 0) {
        npcFire(game, n, t);
        n.cd = Math.max(160, n.weapon['fire-rate'] * 1.4);
        n.mag--;
      }
    } else if (n.cd <= 0 && Math.hypot(t.x - n.x, t.y - n.y) < 26) {
      game.damageMob(t, 20, { melee: true, ang: n.aim });
      play.swing(null);
      n.cd = 900;
    }
  } else if (n.mode !== 'follow' || dP < 70) n.aim += (Math.random() - 0.5) * 0.02;

  // movement: stay with the squad instead of hugging the player, and fall back when overrun
  let tx = null, ty = null, speed = WALK * 0.9;
  n.fallbackT -= dt;
  n.jumpCd -= dt;
  tickJump(game, n, dt);
  if (n.fallbackT > 0 && n.mode !== 'idle' && n.threat) {
    [tx, ty] = retreatPoint(game, n, dP);
    speed = RUN * 0.95;
  } else if (n.mode === 'follow' && pl.alive) {
    const g = n.group;
    if (dP > n.leash * 2.2 || (!g && dP > n.leash)) [tx, ty] = toward(game, n, pl, dP);
    else if (dP > n.leash) { tx = (g.x + pl.x) / 2; ty = (g.y + pl.y) / 2; } // group drifts to the player together
    else if (g && Math.hypot(g.x - n.x, g.y - n.y) > 60) { tx = g.x; ty = g.y; } // loosely cohesive when idle
    if (dP > 150 && tx !== null) speed = RUN * 0.95;
  } else if ((n.mode === 'guard' || n.mode === 'post') && Math.hypot(n.x - n.homeX, n.y - n.homeY) > 24) { tx = n.homeX; ty = n.homeY; }
  // survivors back away from zeds that get close
  if (!n.weapon && t && n.fallbackT <= 0 && Math.hypot(t.x - n.x, t.y - n.y) < 40) { tx = n.x - (t.x - n.x); ty = n.y - (t.y - n.y); speed = WALK * 0.75; }
  n.moving = tx !== null;
  n.running = speed > WALK;
  if (n.moving) {
    const vx = tx - n.x, vy = ty - n.y, vl = Math.hypot(vx, vy) || 1;
    hop(game, n, vx / vl, vy / vl);
    const bx = n.x, by = n.y;
    n.move(map, (vx / vl) * speed * dt, (vy / vl) * speed * dt);
    n.stuckT = Math.hypot(n.x - bx, n.y - by) < speed * dt * 0.2 ? (n.stuckT || 0) + dt : 0;
    if (!t) n.aim = Math.atan2(vy, vx);
  }
  n.dir = dirOf(Math.cos(n.aim), Math.sin(n.aim));
}

// Head for a target: straight when it is close and visible, otherwise along the flow field.
function toward(game, n, o, d) {
  if (d < 240 && game.map.los(n.x, n.y - 10, o.x, o.y - 10)) return [o.x, o.y];
  const [cx, cy] = cellOf(n);
  const nx = game.flow.next(cx, cy);
  if (nx && !game.map.blocking(nx[0], nx[1])) return [nx[0] * T + 16, nx[1] * T + 22];
  return [o.x, o.y];
}

// Once per scan: who is near me (my group) and is the area overrun?
function sense(game, n) {
  const al = [];
  let gx = 0, gy = 0;
  for (const o of game.npcs) {
    if (o === n || !o.active || !o.alive || o.mode === 'idle') continue;
    if (Math.hypot(o.x - n.x, o.y - n.y) < 240) { al.push(o); gx += o.x; gy += o.y; }
  }
  n.allies = al;
  n.group = al.length ? { x: gx / al.length, y: gy / al.length } : null;
  if (n.mode === 'idle') return; // caged survivors stay put
  let cnt = 0, mx = 0, my = 0;
  for (const m of game.mobs) {
    if (!m.alive) continue;
    if (Math.abs(m.x - n.x) > 170 || Math.abs(m.y - n.y) > 170) continue;
    if (Math.hypot(m.x - n.x, m.y - n.y) < 170) { cnt++; mx += m.x; my += m.y; }
  }
  const need = (n.weapon ? 6 : 3) + 2 * al.length;
  const hurt = n.hp < n.maxHp * 0.35;
  if (cnt >= need || (hurt && cnt >= 2)) {
    n.threat = { x: mx / cnt, y: my / cnt };
    if (n.fallbackT <= 0 && n.fbBark <= 0) { n.say(['Fall back!', 'Too many of them!', 'Pull back, pull back!', "We're overrun!"]); n.fbBark = 10; }
    n.fallbackT = 3;
    for (const o of al) if (Math.hypot(o.x - n.x, o.y - n.y) < 200) { o.fallbackT = Math.max(o.fallbackT, 2); o.threat = n.threat; }
  } else n.fbBark -= 0.25;
}

// Away from the horde, drifting toward the player (or the group) when that is the safer side.
function retreatPoint(game, n, dP) {
  const th = n.threat, pl = game.player;
  let ax = n.x - th.x, ay = n.y - th.y, al = Math.hypot(ax, ay) || 1;
  ax /= al; ay /= al;
  const safe = pl.alive && dP > 50 ? pl : n.group;
  if (safe) {
    const sx = safe.x - n.x, sy = safe.y - n.y, sl = Math.hypot(sx, sy) || 1;
    if ((ax * sx + ay * sy) / sl > -0.2) { ax += (sx / sl) * 0.8; ay += (sy / sl) * 0.8; }
  }
  if ((n.stuckT || 0) > 0.4) { // wedged against something: slide along it
    n.turn = n.turn ? -n.turn : (Math.random() < 0.5 ? 1 : -1);
    const c = Math.cos(1.2 * n.turn), s = Math.sin(1.2 * n.turn);
    [ax, ay] = [ax * c - ay * s, ax * s + ay * c];
    n.stuckT = 0;
  }
  return [n.x + ax * 60, n.y + ay * 60];
}

// Vault fences and barricades that block the way on foot but not in the air.
function hop(game, n, ux, uy) {
  if (n.airborne || n.jumpCd > 0) return;
  const m = game.map;
  if (m.boxHits(n.x + ux * 7, n.y + uy * 7, n.hw, n.hh) && !m.boxHits(n.x + ux * 22, n.y + uy * 22, n.hw, n.hh, true)) {
    n.jumpT = JUMP_TIME;
    n.jumpCd = 1.2;
  }
}

function tickJump(game, n, dt) {
  if (n.jumpT <= 0) return;
  n.jumpT -= dt;
  if (n.jumpT > 0) return;
  if (game.map.boxHits(n.x, n.y, n.hw, n.hh)) {
    n.landGrace = (n.landGrace || 0) + dt; // never land inside a fence: hang until clear
    if (n.landGrace < 0.6) n.jumpT = 0.02;
    else { n.jumpT = 0; n.landGrace = 0; game.unstick(n); }
  } else { n.jumpT = 0; n.landGrace = 0; }
}

function npcFire(game, n, t) {
  const it = n.weapon;
  const ox = n.x, oy = n.y - 11;
  const d = Math.hypot(t.x - ox, t.cy - oy);
  const a0 = Math.atan2(t.cy - oy, t.x - ox);
  // NPC accuracy: steady base falling off with distance; misses land just past the target
  const chance = Math.max(0.3, 0.85 - 0.4 * Math.min(1, d / (it.range || 320)));
  const ang = Math.atan(t.radius / Math.max(8, d));
  const a = Math.random() < chance ? a0 + (Math.random() - 0.5) * ang : a0 + (Math.random() < 0.5 ? -1 : 1) * (ang + 0.05 + Math.random() * 0.1);
  const pellets = Math.max(1, it.spread || 1), spread = ((it['spread-angle'] || 0) * Math.PI) / 180;
  for (let i = 0; i < pellets; i++) {
    const off = pellets > 1 ? (i / (pellets - 1) - 0.5) * spread * 2 : 0;
    hitscan(game, { x: ox, y: oy, a: a + off, range: it.range || 320, dmg: it.damage * 0.75, pierce: it.pierce ?? 0, crit: 0, pellet: pellets > 1 });
  }
  n.recoilT = 0.08;
  n.flashT = 0.06;
  play.shot(it, ox, oy);
  if (Math.hypot(n.x - game.player.x, n.y - game.player.y) < 220) game.ejectShell(it, n);
}

// Mobs bite NPCs through here; an NPC at 0 HP goes down and bleeds out unless revived.
export function hurtNPC(game, n, dmg) {
  if (!n.alive) return;
  n.hp -= dmg * 0.8;
  n.hurtT = 0.15;
  if (Math.random() < 0.5) play.hurt(n.female);
  if (n.hp <= 0) {
    n.hp = 0;
    n.alive = false;
    n.downT = 30;
    n.bark = null;
    play.die(n.female);
    game.msg(`${n.name} is down! Get to them and press Use to revive`, '#ff9b6b');
    for (const o of game.npcs) if (o !== n && o.alive && o.mode === 'follow' && Math.random() < 0.5) { o.say(game.assets.barks.leader_down); break; }
  }
}

export function reviveNPC(game, n) {
  n.alive = true;
  n.hp = n.maxHp * 0.4;
  n.mode = n.mode === 'post' ? 'post' : n.kind === 'soldier' ? 'follow' : n.mode === 'idle' ? 'follow' : n.mode;
  n.say(game.assets.barks.quick_thanks);
  game.fx.spawn('heal-quick', n.x, n.y - 14);
  play.heal();
}

export function rescueSurvivor(game, n) {
  n.mode = 'follow';
  n.say(game.assets.barks.caged_free);
  game.msg(`${n.name} is following you`, '#9cd4ff');
  play.pickup();
}
