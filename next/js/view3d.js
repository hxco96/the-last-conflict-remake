// 3D view for the preview build: three.js draws the map as a floor plus raised walls, objects fitted
// to their art, upright trees and props, and every character as an upright billboard painted by the
// existing 2D draw code. The simulation stays in 2D pixel coordinates; world.x = x / T, world.z = y / T.
// Everything flat (effects, decals of modes, lighting, HUD) stays on the 2D canvas above, drawn through
// an affine world-to-screen transform taken from this camera (see xform()).
import * as THREE from './vendor/three.module.js';
import { T } from './map.js';

const WALL_H = 1.25;      // short walls: nothing hides the player
const PITCH = (56 * Math.PI) / 180;
const FOV = 35;
const PAD = 8;            // pixels under an actor's feet inside its billboard canvas
const K = 1 / Math.cos(PITCH); // upright art is stretched by this so it reads 1:1 from the tilted camera

const PROP_H = { Car: 0.6, Obstruction: 0.5 };
const CADE_H = { Cade: 0.75, HeavyCade: 0.95, Fence: 0.85, Shutter: 1.15, Boarded: 0.9 };
const cadeStage = (c) => (c.hp <= 0 ? 4 : Math.min(3, Math.floor((1 - c.hp / c.maxHp) * 4)));

export function webglOk() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}

function tex(canvas, mips = false) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter;
  t.generateMipmaps = mips;
  return t;
}

// Opaque bounding box and average colour of a tile, so each object gets a box that fits its art.
const infoCache = new Map();
let infoCanvas = null;
function tileInfo(map, r, lid = r.lid) {
  const key = `${r.set}|${lid}|${+r.h}${+r.v}${+r.d}`;
  if (infoCache.has(key)) return infoCache.get(key);
  const tw = r.ts.tw, th = r.ts.th;
  infoCanvas = infoCanvas || document.createElement('canvas');
  infoCanvas.width = tw; infoCanvas.height = th;
  const c = infoCanvas.getContext('2d', { willReadFrequently: true });
  c.clearRect(0, 0, tw, th);
  map.drawTile(c, r, 0, 0, 0, 0, lid);
  const d = c.getImageData(0, 0, tw, th).data;
  let x0 = tw, y0 = th, x1 = -1, y1 = -1, n = 0, R = 0, G = 0, B = 0;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const i = (y * tw + x) * 4;
    if (d[i + 3] < 60) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    R += d[i]; G += d[i + 1]; B += d[i + 2]; n++;
  }
  const lin = (v) => Math.pow(v / n / 255, 2.2) * 0.55; // linear, darkened for the side faces
  const info = n ? { x0: x0 / tw, y0: y0 / th, x1: (x1 + 1) / tw, y1: (y1 + 1) / th, col: [lin(R), lin(G), lin(B)] } : null;
  infoCache.set(key, info);
  return info;
}

// Triangle soup builder.
class Buf {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; }
  quad(a, b, c, d, n, uvs, col) {
    const P = [a, b, c, a, c, d], Q = uvs ? [uvs[0], uvs[1], uvs[2], uvs[0], uvs[2], uvs[3]] : null;
    for (let i = 0; i < 6; i++) {
      this.pos.push(P[i][0], P[i][1], P[i][2]); this.nor.push(n[0], n[1], n[2]);
      if (Q) this.uv.push(Q[i][0], Q[i][1]);
      if (col) this.col.push(col[0], col[1], col[2]);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    if (this.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

// Height of each wall cell. Objects, doors, barricades and standing art are built separately.
function cellHeights(map) {
  const types = new Array(map.w * map.h).fill('');
  for (const layer of map.floor().layers || []) {
    if (layer.type !== 'tilelayer' || !layer.data || layer.name.startsWith('top_') || layer.name === 'markers') continue;
    for (let i = 0; i < layer.data.length; i++) { const r = map.resolve(layer.data[i]); if (r && r.meta.type) types[i] = r.meta.type; }
  }
  const skip = new Uint8Array(map.w * map.h);
  for (const p of map.solids) skip[p.cell] = 1;
  const H = new Float32Array(map.w * map.h);
  for (let i = 0; i < H.length; i++) {
    const t = types[i];
    if (map.dyn[i] || skip[i] || !map.solid[i] || t === 'Tree' || t === 'StreetLight' || t === 'VoidAll') H[i] = 0;
    else if (t === 'Window') H[i] = 0.4;
    else if (map.shotBlock[i]) H[i] = WALL_H;
    else H[i] = 0.5;
  }
  return H;
}

function dynSignature(map) {
  let s = '';
  for (const d of map.doors) s += d.open ? '1' : '0';
  for (const c of map.cades) s += cadeStage(c);
  return s;
}

export class View3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050608);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 200);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(-0.5, 1, 0.35); this.scene.add(sun);
    this.map = null;
    this.level = null;
    this.sig = '';
    this.sigT = 0;
    this.groundT = 0;
    this.sprites = new Map(); // key object -> billboard
    this.geos = new Map();    // billboard size -> shared geometry
    this.pageTex = new Map(); // tile page image -> texture
    this.frame = 0;
    this.v = new THREE.Vector3();
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.hit = new THREE.Vector3();
    this.w = 0; this.h = 0;
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const x = c.getContext('2d'), g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 32, 32);
    this.blobMat = new THREE.MeshBasicMaterial({ map: tex(c), transparent: true, depthWrite: false });
    this.blobGeo = new THREE.PlaneGeometry(0.8, 0.5); this.blobGeo.rotateX(-Math.PI / 2);
    this.sideMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------- level ----------
  setMap(map) {
    if (this.level) {
      for (const m of this.level.meshes) { this.scene.remove(m); m.geometry.dispose(); }
      this.level.groundTex.dispose(); this.level.wallTex.dispose();
    }
    for (const b of this.sprites.values()) this.dropSprite(b);
    this.sprites.clear();
    this.map = map;
    const { w, h, pw, ph } = map;
    const groundTex = tex(map.bot, true);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshLambertMaterial({ map: groundTex }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(w / 2, 0, h / 2);
    // one canvas for every raised face: floor + doors/barricades as they are now + the over-actor layer
    const wc = this.wallCanvas = document.createElement('canvas'); wc.width = pw; wc.height = ph;
    const f = wc.getContext('2d');
    f.drawImage(map.bot, 0, 0);
    for (const d of map.doors) map.drawDynamic(f, d);
    for (const c of map.cades) map.drawDynamic(f, { ...c, hit: 0 });
    f.drawImage(map.top, 0, 0);
    const wallTex = tex(wc, true);
    this.wallMat = new THREE.MeshLambertMaterial({ map: wallTex });
    this.level = { groundTex, wallTex, meshes: [ground], dyn: [] };
    this.scene.add(ground);
    this.buildStatic();
    this.buildDynamic(false);
  }

  add(mesh, list = this.level.meshes) {
    this.scene.add(mesh);
    list.push(mesh);
    if (list !== this.level.meshes) this.level.meshes.push(mesh);
    return mesh;
  }

  // A box over a rectangle of the wall canvas: its art on top, flat-coloured sides.
  box(tb, cb, px0, py0, px1, py1, h, col) {
    const { pw, ph } = this.map;
    const x0 = px0 / T, x1 = px1 / T, z0 = py0 / T, z1 = py1 / T;
    const u0 = px0 / pw, u1 = px1 / pw, vt = 1 - py0 / ph, vb = 1 - py1 / ph;
    tb.quad([x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0], [0, 1, 0], [[u0, vt], [u0, vb], [u1, vb], [u1, vt]]);
    if (h < 0.06) return;
    const side = (a, b, n) => cb.quad([a[0], h, a[1]], [a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], h, b[1]], n, null, col);
    side([x0, z1], [x1, z1], [0, 0, 1]);
    side([x1, z0], [x0, z0], [0, 0, -1]);
    side([x1, z1], [x1, z0], [1, 0, 0]);
    side([x0, z0], [x0, z1], [-1, 0, 0]);
  }

  buildStatic() {
    const map = this.map, { w, h, pw, ph } = map;
    const H = this.heights = cellHeights(map);
    const tb = new Buf(), cb = new Buf();
    const U = (x) => (x * T) / pw, V = (z) => 1 - (z * T) / ph;
    const hAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : H[y * w + x]);
    for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) {
      const top = H[cy * w + cx];
      if (!top) continue;
      const x0 = cx, x1 = cx + 1, z0 = cy, z1 = cy + 1;
      const uvs = [[U(x0), V(z0)], [U(x0), V(z1)], [U(x1), V(z1)], [U(x1), V(z0)]];
      tb.quad([x0, top, z0], [x0, top, z1], [x1, top, z1], [x1, top, z0], [0, 1, 0], uvs);
      const side = (nh, a, b, n) => { if (nh < top) tb.quad([a[0], top, a[1]], [a[0], nh, a[1]], [b[0], nh, b[1]], [b[0], top, b[1]], n, uvs); };
      side(hAt(cx, cy + 1), [x0, z1], [x1, z1], [0, 0, 1]);
      side(hAt(cx, cy - 1), [x1, z0], [x0, z0], [0, 0, -1]);
      side(hAt(cx + 1, cy), [x1, z1], [x1, z0], [1, 0, 0]);
      side(hAt(cx - 1, cy), [x0, z0], [x0, z1], [-1, 0, 0]);
    }
    // objects (crates, furniture, cars, gravestones): a box trimmed to the opaque part of the tile
    for (const p of map.solids) {
      const i = tileInfo(map, p.r);
      if (!i) continue;
      this.box(tb, cb, p.x + i.x0 * p.w, p.y + i.y0 * p.h, p.x + i.x1 * p.w, p.y + i.y1 * p.h, PROP_H[p.type] || 0.7, i.col);
    }
    this.add(new THREE.Mesh(tb.geometry(), this.wallMat));
    if (cb.pos.length) this.add(new THREE.Mesh(cb.geometry(), this.sideMat));

    // standing art (trees, street lights, tall props): upright cut-outs from the tile pages + a shadow
    const pages = new Map(), sb = new Buf();
    for (const u of map.uprights) {
      const i = tileInfo(map, u.r);
      if (!i) continue;
      const img = map.assets.tilePages[u.r.ts.atlas.page];
      if (!pages.has(img)) pages.set(img, new Buf());
      const [sx, sy, sw, sh] = map.tileSrc(u.r.ts, u.r.lid);
      let ua = sx / img.width, ub = (sx + sw) / img.width;
      if (u.r.h) [ua, ub] = [ub, ua];
      const va = 1 - sy / img.height, vb = 1 - (sy + sh) / img.height;
      const xa = u.x / T, xb = (u.x + u.w) / T, z = (u.y + u.h * i.y1) / T - 0.08;
      const yb = -((u.h * (1 - i.y1)) / T) * K, yt = yb + (u.h / T) * K;
      pages.get(img).quad([xa, yt, z], [xa, yb, z], [xb, yb, z], [xb, yt, z], [0, 0, 1], [[ua, va], [ua, vb], [ub, vb], [ub, va]]);
      const mx = (u.x + (u.w * (i.x0 + i.x1)) / 2) / T, r = Math.max(0.35, ((u.w * (i.x1 - i.x0)) / T) * 0.4);
      sb.quad([mx - r, 0.012, z - r * 0.5], [mx - r, 0.012, z + r * 0.5], [mx + r, 0.012, z + r * 0.5], [mx + r, 0.012, z - r * 0.5], [0, 1, 0], [[0, 1], [0, 0], [1, 0], [1, 1]]);
    }
    for (const [img, buf] of pages) {
      let t = this.pageTex.get(img);
      if (!t) {
        t = new THREE.Texture(img); t.colorSpace = THREE.SRGBColorSpace;
        t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
        this.pageTex.set(img, t);
      }
      this.add(new THREE.Mesh(buf.geometry(), new THREE.MeshBasicMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide })));
    }
    if (sb.pos.length) this.add(new THREE.Mesh(sb.geometry(), this.blobMat));
  }

  // Doors and barricades as slabs fitted to their art; rebuilt when one opens, closes or loses a stage.
  buildDynamic(redraw = true) {
    const map = this.map, L = this.level;
    for (const m of L.dyn) { this.scene.remove(m); m.geometry.dispose(); L.meshes.splice(L.meshes.indexOf(m), 1); }
    L.dyn = [];
    const f = this.wallCanvas.getContext('2d'), tb = new Buf(), cb = new Buf();
    const each = (e, lid, hgt) => {
      const tw = e.r.ts.tw, th = e.r.ts.th;
      if (redraw) {
        f.clearRect(e.x, e.y, tw, th);
        f.drawImage(map.bot, e.x, e.y, tw, th, e.x, e.y, tw, th);
        map.drawDynamic(f, { ...e, hit: 0 });
        f.drawImage(map.top, e.x, e.y, tw, th, e.x, e.y, tw, th);
      }
      const i = lid === null ? null : tileInfo(map, e.r, lid);
      if (i) this.box(tb, cb, e.x + i.x0 * tw, e.y + i.y0 * th, e.x + i.x1 * tw, e.y + i.y1 * th, hgt, i.col);
    };
    for (const d of map.doors) each(d, d.open ? d.openLid : d.closedLid, d.open ? 0.03 : WALL_H * 0.92);
    for (const c of map.cades) {
      const st = cadeStage(c), base = CADE_H[c.type] || 0.75;
      if (c.type === 'Boarded') each(c, c.hp > 0 ? c.r.lid : null, base);
      else each(c, c.baseLid + st, st >= 4 ? 0.03 : base * (1 - st * 0.18));
    }
    if (redraw) L.wallTex.needsUpdate = true;
    if (tb.pos.length) this.add(new THREE.Mesh(tb.geometry(), this.wallMat), L.dyn);
    if (cb.pos.length) this.add(new THREE.Mesh(cb.geometry(), this.sideMat), L.dyn);
    this.sig = dynSignature(map);
  }

  // ---------- camera ----------
  // Matches what the 2D zoom showed: vh world pixels of ground from top to bottom of the screen.
  setCamera(fx, fy, vh) {
    const D = ((vh / T) * Math.sin(PITCH)) / (2 * Math.tan(((FOV / 2) * Math.PI) / 180));
    const tx = fx / T, tz = fy / T;
    this.camera.position.set(tx, D * Math.sin(PITCH), tz + D * Math.cos(PITCH));
    this.camera.lookAt(tx, 0, tz);
    this.camera.updateMatrixWorld();
  }

  // world pixels (x, y) at height hpx world pixels -> screen pixels
  toScreen(x, y, hpx = 0) {
    const v = this.v.set(x / T, (hpx / T) * K, y / T).project(this.camera);
    return { x: (v.x + 1) * 0.5 * this.w, y: (1 - v.y) * 0.5 * this.h };
  }

  // screen pixels -> world pixels on the ground
  toWorld(sx, sy) {
    this.ndc.set((sx / this.w) * 2 - 1, -(sy / this.h) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    if (!this.ray.ray.intersectPlane(this.plane, this.hit)) return null;
    return { x: this.hit.x * T, y: this.hit.z * T };
  }

  // Affine world->screen transform that matches the ground plane around (x, y).
  xform(x, y) {
    const o = this.toScreen(x, y), ax = this.toScreen(x + T, y), ay = this.toScreen(x, y + T);
    const a = (ax.x - o.x) / T, b = (ax.y - o.y) / T, c = (ay.x - o.x) / T, d = (ay.y - o.y) / T;
    return [a, b, c, d, o.x - a * x - c * y, o.y - b * x - d * y];
  }

  // Ground rectangle the camera sees, in world pixels (used by spawn rules and culling).
  viewRect() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [sx, sy] of [[0, 0], [this.w, 0], [0, this.h], [this.w, this.h]]) {
      const p = this.toWorld(sx, sy);
      if (!p) continue;
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { x: x0, y: y0, vw: x1 - x0, vh: y1 - y0 };
  }

  // ---------- billboards ----------
  // Characters stand upright on the ground (so they never lean into the wall behind them) and are
  // stretched by K, which makes them read exactly as drawn from the tilted camera.
  sprite(key, size) {
    let b = this.sprites.get(key);
    if (b && b.size !== size) { this.dropSprite(b); b = null; }
    if (!b) {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false;
      const t = tex(c);
      let geo = this.geos.get(size);
      if (!geo) {
        geo = new THREE.PlaneGeometry(size / T, (size / T) * K);
        geo.translate(0, ((size / 2 - PAD) / T) * K, 0);
        this.geos.set(size, geo);
      }
      const s = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: t, alphaTest: 0.4 }));
      const shadow = new THREE.Mesh(this.blobGeo, this.blobMat);
      this.scene.add(s, shadow);
      b = { s, shadow, c, ctx, t, size, seen: 0 };
      this.sprites.set(key, b);
    }
    return b;
  }

  dropSprite(b) {
    this.scene.remove(b.s, b.shadow);
    b.s.material.dispose(); b.t.dispose();
  }

  // entry: { x, y, draw(ctx), key, size?, shadow? }
  billboard(e) {
    const size = e.size || 96;
    const b = this.sprite(e.key, size);
    b.seen = this.frame;
    const { ctx, c } = b;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(1, 0, 0, 1, Math.round(size / 2 - e.x), Math.round(size - PAD - e.y));
    ctx.save(); e.draw(ctx); ctx.restore();
    b.t.needsUpdate = true;
    b.s.visible = true;
    b.s.position.set(e.x / T, 0, e.y / T);
    b.shadow.visible = e.shadow !== false;
    b.shadow.position.set(e.x / T, 0.012, e.y / T);
  }

  // ---------- frame ----------
  begin(map, dt) {
    if (map !== this.map) this.setMap(map);
    this.frame++;
    this.sigT -= dt;
    if (this.sigT <= 0) {
      this.sigT = 0.2;
      if (dynSignature(map) !== this.sig) this.buildDynamic();
    }
    this.groundT -= dt;
    // blood decals paint into map.bot: re-upload soon after a new one, and now and then for anything else
    if (this.groundT <= 0 || (map.botDirty && this.groundT < 1.85)) { this.groundT = 2; map.botDirty = false; this.level.groundTex.needsUpdate = true; }
  }

  end() {
    for (const [k, b] of this.sprites) {
      if (b.seen === this.frame) continue;
      if (this.frame - b.seen > 120) { this.dropSprite(b); this.sprites.delete(k); } else { b.s.visible = false; b.shadow.visible = false; }
    }
    this.renderer.render(this.scene, this.camera);
  }

  hide() { this.canvas.style.display = 'none'; }
  show() { this.canvas.style.display = 'block'; }
}
