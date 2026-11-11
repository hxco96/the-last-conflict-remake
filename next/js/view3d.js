// 3D view for the preview build: three.js draws the map as a floor plus extruded walls and every
// character as an upright, camera-facing billboard painted by the existing 2D draw code.
// The simulation stays in 2D pixel coordinates; world.x = x / T, world.z = y / T, y is up.
// Everything flat (effects, projectiles, decals of modes, lighting, HUD) stays on the 2D canvas
// above, drawn through an affine world-to-screen transform taken from this camera (see xform()).
import * as THREE from './vendor/three.module.js';
import { T } from './map.js';

const WALL_H = 1.25;      // short walls: nothing hides the player
const PITCH = (56 * Math.PI) / 180;
const FOV = 35;
const PAD = 8;            // pixels under an actor's feet inside its billboard canvas

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

// Height of each cell from what the simulation already knows (solid, shot-blocking, doors, barricades).
function cellHeights(map) {
  const types = new Array(map.w * map.h).fill('');
  for (const layer of map.floor().layers || []) {
    if (layer.type !== 'tilelayer' || !layer.data || layer.name.startsWith('top_') || layer.name === 'markers') continue;
    for (let i = 0; i < layer.data.length; i++) { const r = map.resolve(layer.data[i]); if (r && r.meta.type) types[i] = r.meta.type; }
  }
  const H = new Float32Array(map.w * map.h);
  for (let i = 0; i < H.length; i++) {
    const d = map.dyn[i], t = types[i];
    if (d && d.kind === 'door') H[i] = d.open ? 0 : WALL_H * 0.95;
    else if (d && d.kind === 'cade') H[i] = d.hp > 0 ? 0.25 + 0.4 * (d.hp / d.maxHp) : 0;
    else if (!map.solid[i]) H[i] = 0;
    else if (t === 'Tree') H[i] = 1.1;
    else if (t === 'Window') H[i] = 0.4;
    else if (/^Fence_/.test(t)) H[i] = 0.6;
    else if (map.shotBlock[i]) H[i] = WALL_H;
    else H[i] = 0.5; // obstructions, cars, furniture
  }
  return H;
}

function dynSignature(map) {
  let s = '';
  for (const d of map.doors) s += d.open ? '1' : '0';
  for (const c of map.cades) s += c.hp <= 0 ? 4 : Math.min(3, Math.floor((1 - c.hp / c.maxHp) * 4));
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
    this.frame = 0;
    this.v = new THREE.Vector3();
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.hit = new THREE.Vector3();
    this.w = 0; this.h = 0;
    this.blob = this.makeBlob();
  }

  makeBlob() {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const x = c.getContext('2d'), g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 32, 32);
    const geo = new THREE.PlaneGeometry(0.8, 0.5); geo.rotateX(-Math.PI / 2);
    return { geo, mat: new THREE.MeshBasicMaterial({ map: tex(c), transparent: true, depthWrite: false }) };
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
      this.scene.remove(this.level.ground, this.level.walls);
      this.level.ground.geometry.dispose(); this.level.walls.geometry.dispose();
      this.level.groundTex.dispose(); this.level.wallTex.dispose();
    }
    for (const b of this.sprites.values()) this.dropSprite(b);
    this.sprites.clear();
    this.map = map;
    const groundTex = tex(map.bot, true);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(map.w, map.h), new THREE.MeshLambertMaterial({ map: groundTex }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(map.w / 2, 0, map.h / 2);
    this.wallCanvas = document.createElement('canvas'); this.wallCanvas.width = map.pw; this.wallCanvas.height = map.ph;
    const wallTex = tex(this.wallCanvas, true);
    const walls = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ map: wallTex }));
    this.level = { ground, walls, groundTex, wallTex };
    this.scene.add(ground, walls);
    this.rebuildWalls();
  }

  rebuildWalls() {
    const map = this.map, { w, h, pw, ph } = map;
    const f = this.wallCanvas.getContext('2d');
    f.clearRect(0, 0, pw, ph);
    f.drawImage(map.bot, 0, 0);
    for (const d of map.doors) map.drawDynamic(f, { ...d, open: false });
    for (const c of map.cades) map.drawDynamic(f, { ...c, hit: 0 });
    f.drawImage(map.top, 0, 0);
    this.level.wallTex.needsUpdate = true;

    const H = this.heights = cellHeights(map);
    const pos = [], nor = [], uv = [];
    const U = (x) => (x * T) / pw, V = (z) => 1 - (z * T) / ph;
    const quad = (a, b, c, d, n, ua, ub, uc, ud) => {
      for (const [p, q] of [[a, ua], [b, ub], [c, uc], [a, ua], [c, uc], [d, ud]]) { pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]); uv.push(q[0], q[1]); }
    };
    const hAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : H[y * w + x]);
    for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) {
      const top = H[cy * w + cx];
      if (!top) continue;
      const x0 = cx, x1 = cx + 1, z0 = cy, z1 = cy + 1;
      const u0 = U(x0), u1 = U(x1), vt = V(z0), vb = V(z1);
      quad([x0, top, z0], [x0, top, z1], [x1, top, z1], [x1, top, z0], [0, 1, 0], [u0, vt], [u0, vb], [u1, vb], [u1, vt]);
      const side = (nh, a, b, n) => {
        if (nh >= top) return;
        quad([a[0], top, a[1]], [a[0], nh, a[1]], [b[0], nh, b[1]], [b[0], top, b[1]], n, [u0, vt], [u0, vb], [u1, vb], [u1, vt]);
      };
      side(hAt(cx, cy + 1), [x0, z1], [x1, z1], [0, 0, 1]);
      side(hAt(cx, cy - 1), [x1, z0], [x0, z0], [0, 0, -1]);
      side(hAt(cx + 1, cy), [x1, z1], [x1, z0], [1, 0, 0]);
      side(hAt(cx - 1, cy), [x0, z0], [x0, z1], [-1, 0, 0]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    this.level.walls.geometry.dispose();
    this.level.walls.geometry = geo;
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
    const v = this.v.set(x / T, hpx / T, y / T).project(this.camera);
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
  sprite(key, size) {
    let b = this.sprites.get(key);
    if (b && b.size !== size) { this.dropSprite(b); b = null; }
    if (!b) {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false;
      const t = tex(c);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, alphaTest: 0.4 }));
      s.center.set(0.5, PAD / size);
      s.scale.set(size / T, size / T, 1);
      const shadow = new THREE.Mesh(this.blob.geo, this.blob.mat);
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
    const size = e.size || 64;
    const b = this.sprite(e.key, size);
    b.seen = this.frame;
    const { ctx, c } = b;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(1, 0, 0, 1, Math.round(size / 2 - e.x), Math.round(size - PAD - e.y));
    ctx.save(); e.draw(ctx); ctx.restore();
    b.t.needsUpdate = true;
    b.s.visible = true;
    b.s.position.set(e.x / T, 0, e.y / T + 0.02);
    b.shadow.visible = e.shadow !== false;
    b.shadow.position.set(e.x / T, 0.01, e.y / T);
  }

  // ---------- frame ----------
  begin(map, dt) {
    if (map !== this.map) this.setMap(map);
    this.frame++;
    this.sigT -= dt;
    if (this.sigT <= 0) {
      this.sigT = 0.2;
      const s = dynSignature(map);
      if (s !== this.sig) this.rebuildWalls();
    }
    this.groundT -= dt;
    if (this.groundT <= 0) { this.groundT = 0.75; this.level.groundTex.needsUpdate = true; } // blood decals paint into map.bot
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
