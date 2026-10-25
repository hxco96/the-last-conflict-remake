import { Atlas } from './assets.js';
import { T } from './map.js';

// Movement speeds in px/s. Mob speeds come from mob_db and are scaled by MOB_SPEED_SCALE
// (a design choice: the original unit is not established; 1.0 felt too slow for solo play).
export const JUMP_TIME = 0.55;
export const WALK = 78, RUN = 128, MOB_SPEED_SCALE = 1.7, BOSS_HP_SCALE = 0.08;

export const dirOf = (dx, dy) => (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n');
const FLIP = { e: 'w', w: 'e', n: 'n', s: 's' };

export const LOOKS = [
  { name: 'Jill', layers: ['body-nbase2', 'pants-f-jill', 'ushirt-f-jill', 'head-nbase2', 'pupil', 'hair-f-jill'] },
  { name: 'Leon', layers: ['body-nbase1', 'pants-12', 'ushirt-m-cop', 'head-nbase1', 'pupil', 'hair-leon'] },
  { name: 'Chris', layers: ['body-army', 'head-nbase3', 'pupil', 'hair-chris'] },
  { name: 'Claire', layers: ['body-nbase0', 'pants-12', 'ushirt-12', 'oshirt-cjacket', 'head-nbase0', 'pupil', 'hair-f-pony'] },
  { name: 'Wesker', layers: ['body-nbase4', 'pants-12', 'oshirt-lab', 'head-nbase4', 'pupil', 'hair-wesker'] },
];

// Draws a stack of layer bases with one animation; returns false when nothing could be drawn.
function drawLayers(ctx, atlas, layers, anims, dir, t, x, y, loop = true) {
  let any = false;
  for (const base of layers) {
    let found = atlas.find(base, anims, [dir]);
    let flip = false;
    if (!found && (dir === 'e' || dir === 'w')) { found = atlas.find(base, anims, [FLIP[dir]]); flip = !!found; }
    if (!found) found = atlas.find(base, anims, ['s', 'x', 'e']);
    if (!found) continue;
    atlas.draw(ctx, Atlas.frameAt(found.list, t, loop), x, y, flip);
    any = true;
  }
  return any;
}

export class Player {
  constructor(x, y, look, cls) {
    this.x = x; this.y = y;
    this.look = look;
    this.cls = cls;
    this.dir = 's';
    this.anim = 'blink';
    this.animT = 0;
    this.maxHp = 100;
    this.hp = 100;
    this.stamina = 100;
    this.tired = false;
    this.infection = 0;
    this.infectT = 0;
    this.alive = true;
    this.hurtT = 0;
    this.moving = false;
    this.running = false;
    this.aim = 0;
    this.revives = 0;
    this.bark = null;
    this.jumpT = 0;
  }

  get hw() { return 5; }
  get hh() { return 4; }

  get airborne() { return this.jumpT > 0; }
  get jumpH() { return this.jumpT > 0 ? Math.sin((1 - this.jumpT / JUMP_TIME) * Math.PI) * 12 : 0; }

  move(map, dx, dy) {
    const air = this.airborne;
    if (dx && !map.boxHits(this.x + dx, this.y, this.hw, this.hh, air)) this.x += dx;
    if (dy && !map.boxHits(this.x, this.y + dy, this.hw, this.hh, air)) this.y += dy;
  }

  draw(ctx, atlas, weaponDraw) {
    const anims = !this.alive ? ['down', 'sleep'] : this.moving
      ? (this.hp < this.maxHp * 0.35 ? ['hurtwalk', 'walk'] : this.running ? ['run', 'walk'] : ['walk'])
      : (this.tired ? ['tiredidle', 'drawn'] : this.hp < this.maxHp * 0.35 ? ['hurtidle', 'drawn'] : ['drawn', 'blink']);
    const dir = this.alive ? this.dir : 'n';
    const behind = this.dir === 'n';
    const lift = this.jumpH;
    const wd = weaponDraw && (() => { ctx.save(); ctx.translate(0, -lift); weaponDraw(); ctx.restore(); });
    if (behind && wd) wd();
    if (this.hurtT > 0) ctx.filter = 'brightness(1.8) sepia(1) hue-rotate(-50deg) saturate(4)';
    const h = this.jumpH;
    if (h) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(this.x, this.y - 1, 6 - h * 0.2, 2.5, 0, 0, 7); ctx.fill(); }
    drawLayers(ctx, atlas, this.look.layers, h ? ['run', 'walk'] : anims, dir, this.animT, this.x, this.y - h);
    ctx.filter = 'none';
    if (!behind && wd && this.alive) wd();
  }
}

export class Mob {
  constructor(def, x, y, atlas, outfits) {
    this.def = def;
    this.id = def.id;
    this.x = x; this.y = y;
    this.boss = def.hp >= 15000;
    this.maxHp = Math.round(def.hp * (this.boss ? BOSS_HP_SCALE : 1));
    this.hp = this.maxHp;
    this.speed = def.speed * MOB_SPEED_SCALE;
    this.dir = 's';
    this.state = 'walk';
    this.stateT = 0;
    this.animT = Math.random() * 1000;
    this.cds = (def.attacks || []).map((a) => ({ a, t: Math.random() * a.cd * 0.5 }));
    this.stun = 0;
    this.flash = 0;
    this.losT = 0;
    this.seen = false;
    this.alive = true;
    this.deadT = 0;
    this.rushV = null;
    this.hitDone = false;
    this.groan = 2 + Math.random() * 8;
    this.layers = Mob.layersFor(def, atlas, outfits);
    this.radius = this.boss ? 18 : def.speed >= 100 ? 7 : 8;
  }

  // Negative sprite/body/legs ids index parallel outfit groups in outfits.rktd (-2 male, -3/-4 its
  // dismembered variants, -1 fat bodies...). legs-id 0 means "legs matching the head outfit".
  static skinsFor(def, outfits) {
    const sid = def['sprite-id'];
    if (sid >= 0) return { head: def.name, body: def.name, legs: def.name.replace(/-d[12]$/, '') };
    const i = Math.floor(Math.random() * 64);
    const pick = (gid) => { const l = outfits.get(gid); return l && l.length ? l[i % l.length] : null; };
    const head = pick(sid) || def.name;
    const body = def['body-id'] < 0 ? pick(def['body-id']) || head : head;
    const legs = def['legs-id'] < 0 ? pick(def['legs-id']) || body : head.replace(/-d[12]$/, '');
    return { head, body, legs };
  }

  static layersFor(def, atlas, outfits) {
    for (let tries = 0; tries < 4; tries++) {
      const s = Mob.skinsFor(def, outfits);
      const layers = ['legs-' + s.legs, 'body-' + s.body, 'head-' + s.head, 'eyes-' + s.head].filter((b) => atlas.bases.has(b));
      if (layers.length) return layers;
    }
    return [];
  }

  get hw() { return 5; }
  get hh() { return 4; }
  get cy() { return this.y - 10; }

  move(map, dx, dy) {
    if (dx && !map.boxHits(this.x + dx, this.y, this.hw, this.hh)) this.x += dx;
    else if (dx) return false;
    if (dy && !map.boxHits(this.x, this.y + dy, this.hw, this.hh)) this.y += dy;
    else if (dy) return false;
    return true;
  }

  draw(ctx, atlas) {
    let anims;
    if (!this.alive) anims = ['death', 'walk'];
    else if (this.state === 'attack') anims = ['battack', 'walk'];
    else if (this.state === 'rush') anims = ['rush', 'run', 'walk'];
    else anims = ['walk', 'idle', 'default'];
    const scale = this.boss ? 1.6 : 1;
    if (!this.alive) ctx.globalAlpha = Math.max(0, 1 - Math.max(0, this.deadT - 1.2) / 0.8);
    if (scale !== 1) {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.scale(scale, scale);
      ctx.translate(-this.x, -this.y);
    }
    if (this.flash > 0) ctx.filter = 'brightness(3)';
    drawLayers(ctx, atlas, this.layers, anims, this.dir, this.alive ? this.animT : this.deadT * 1000, this.x, this.y, this.alive);
    ctx.filter = 'none';
    if (scale !== 1) ctx.restore();
    ctx.globalAlpha = 1;
  }
}

export function cellOf(e) { return [Math.floor(e.x / T), Math.floor((e.y - 2) / T)]; }
