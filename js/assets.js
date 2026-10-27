// Asset loading and TexturePacker atlas helpers.
// Frame names follow the original convention: <base>_<anim>_<dir>_<index>[_<durationMs>]

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('failed to load ' + src));
  img.src = src;
});
const loadJson = async (src) => {
  const r = await fetch(src);
  if (!r.ok) throw new Error('failed to load ' + src);
  return r.json();
};

const FRAME_RE = /^(.+?)_([^_]+)_([nsewx])_(\d+)(?:_(-?\d+))?/;

export class Atlas {
  constructor(json, image) {
    this.image = image;
    this.frames = json.frames;
    this.anims = new Map();
    for (const name of Object.keys(this.frames)) {
      const m = FRAME_RE.exec(name);
      if (!m) continue;
      const key = m[1] + '|' + m[2] + '|' + m[3];
      let list = this.anims.get(key);
      if (!list) this.anims.set(key, (list = []));
      const dur = m[5] === undefined ? 100 : Math.max(+m[5], 0);
      list.push({ i: +m[4], f: this.frames[name], dur: dur || 100 });
    }
    for (const list of this.anims.values()) list.sort((a, b) => a.i - b.i);
    this.bases = new Set([...this.anims.keys()].map((k) => k.split('|')[0]));
  }

  anim(base, anim, dir) {
    return this.anims.get(base + '|' + anim + '|' + dir) || null;
  }

  // Find an animation for base trying the given anims and directions in order.
  find(base, anims, dirs) {
    for (const a of anims) for (const d of dirs) {
      const l = this.anims.get(base + '|' + a + '|' + d);
      if (l) return { list: l, dir: d };
    }
    return null;
  }

  static frameAt(list, tMs, loop = true) {
    if (list.length === 1) return list[0].f;
    let total = 0;
    for (const e of list) total += e.dur;
    let t = loop ? tMs % total : Math.min(tMs, total - 1);
    for (const e of list) { if (t < e.dur) return e.f; t -= e.dur; }
    return list[list.length - 1].f;
  }

  static duration(list) {
    let total = 0;
    for (const e of list) total += e.dur;
    return total;
  }

  // Draw a frame anchored at the bottom-centre of its untrimmed source box.
  draw(ctx, f, x, y, flip = false, scale = 1) {
    const [fx, fy, fw, fh, ox, oy, sw, sh] = f;
    const left = x - (sw * scale) / 2, top = y - sh * scale;
    if (!flip) {
      ctx.drawImage(this.image, fx, fy, fw, fh, Math.round(left + ox * scale), Math.round(top + oy * scale), fw * scale, fh * scale);
    } else {
      // undo the mirror by hand instead of save()/restore(): this runs per layer per zed, and the state stack is the costly part
      const rx = Math.round(x);
      ctx.translate(rx, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.image, fx, fy, fw, fh, Math.round(-(sw * scale) / 2 + ox * scale), Math.round(top + oy * scale), fw * scale, fh * scale);
      ctx.scale(-1, 1);
      ctx.translate(-rx, 0);
    }
  }

  // Draw a frame centred on (x, y).
  drawCentered(ctx, f, x, y, scale = 1, rot = 0) {
    const [fx, fy, fw, fh, ox, oy, sw, sh] = f;
    ctx.save();
    ctx.translate(x, y);
    if (rot) ctx.rotate(rot);
    ctx.drawImage(this.image, fx, fy, fw, fh, (ox - sw / 2) * scale, (oy - sh / 2) * scale, fw * scale, fh * scale);
    ctx.restore();
  }
}

export async function loadAssets(onProgress = () => {}) {
  const jobs = {
    infected: ['assets/img/all_infecteds.json', 'assets/img/all_infecteds.png'],
    core: ['assets/img/core_custom.json', 'assets/img/core_custom.png'],
    combat: ['assets/img/combat_anims.json', 'assets/img/combat_anims.png'],
    lights: ['assets/img/all_lights.json', 'assets/img/all_lights.png'],
  };
  const total = Object.keys(jobs).length * 2 + 7;
  let done = 0;
  const tick = (p) => { done++; onProgress(done / total); return p; };

  const atlasP = Object.entries(jobs).map(async ([k, [j, i]]) => {
    const [json, img] = await Promise.all([loadJson(j).then(tick), loadImage(i).then(tick)]);
    return [k, new Atlas(json, img)];
  });
  const [atlases, tilePage0, tilePage1, title, tables, tilesets, mapIndex, barks] = await Promise.all([
    Promise.all(atlasP),
    loadImage('assets/img/all_tilesets-0.png').then(tick),
    loadImage('assets/img/all_tilesets-1.png').then(tick),
    loadImage('assets/img/titlescreen.png').then(tick),
    loadJson('assets/data/tables.json').then(tick),
    loadJson('assets/data/tilesets.json').then(tick),
    loadJson('assets/maps/index.json').then(tick),
    loadJson('assets/data/barks.json').then(tick),
  ]);
  // Mech robot atlases (one image each)
  const robotNames = await loadJson('assets/img/robots/index.json').catch(() => []);
  const robots = await Promise.all(robotNames.map(async (n) => new Atlas(await loadJson(`assets/img/robots/${n}.json`), await loadImage(`assets/img/robots/${n}.png`))));
  try {
    const font = new FontFace('Bebas', 'url(assets/img/BebasNeue-Regular.ttf)');
    document.fonts.add(await font.load());
  } catch { /* fall back to system font */ }

  return {
    atlas: Object.fromEntries(atlases),
    robots,
    tilePages: [tilePage0, tilePage1],
    title, tables, tilesets, mapIndex, barks,
    loadMap: (file) => loadJson('assets/maps/' + file),
  };
}
