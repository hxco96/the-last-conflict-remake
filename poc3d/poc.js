// Visual proof of concept: the real Highschool map, sprites and collision drawn by three.js,
// with top-down, third-person and first-person cameras. Not wired into the game itself.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { Atlas } from '../js/assets.js';
import { GameMap, T } from '../js/map.js';
import { Player, Mob, LOOKS } from '../js/actors.js';

const BASE = new URL('../', import.meta.url);
const url = (p) => new URL(p, BASE).href;
const loadImage = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error(src)); i.src = src; });
const loadJson = async (src) => { const r = await fetch(src); if (!r.ok) throw new Error(src); return r.json(); };

const MAP_FILE = new URLSearchParams(location.search).get('map') || 'highschool.json';
const ZEDS = 36;
const WALL_H = 1.6;

const $ = (id) => document.getElementById(id);

async function boot() {
  const [tilesets, p0, p1, mapJson, infJ, infI, coreJ, coreI] = await Promise.all([
    loadJson(url('assets/data/tilesets.json')),
    loadImage(url('assets/img/all_tilesets-0.png')), loadImage(url('assets/img/all_tilesets-1.png')),
    loadJson(url('assets/maps/' + MAP_FILE)),
    loadJson(url('assets/img/all_infecteds.json')), loadImage(url('assets/img/all_infecteds.png')),
    loadJson(url('assets/img/core_custom.json')), loadImage(url('assets/img/core_custom.png')),
  ]);
  const assets = { tilesets, tilePages: [p0, p1] };
  const map = new GameMap(mapJson, assets, 0);
  const infected = new Atlas(infJ, infI), core = new Atlas(coreJ, coreI);
  $('loading').remove();
  start(map, infected, core);
}

// ---------- level geometry from the tile grid ----------
function cellKinds(map) {
  // tile type per cell, read from the floor's tile layers (last non-empty type wins)
  const types = new Array(map.w * map.h).fill('');
  for (const layer of map.floor().layers || []) {
    if (layer.type !== 'tilelayer' || !layer.data || layer.name.startsWith('top_') || layer.name === 'markers') continue;
    for (let i = 0; i < layer.data.length; i++) { const r = map.resolve(layer.data[i]); if (r && r.meta.type) types[i] = r.meta.type; }
  }
  const height = new Float32Array(map.w * map.h);
  for (let i = 0; i < height.length; i++) {
    const d = map.dyn[i], t = types[i];
    if (d && d.kind === 'door') height[i] = d.open ? 0 : 1.45;
    else if (d && d.kind === 'cade') height[i] = d.hp > 0 ? (map.breach[i] ? 0.9 : 0.6) : (map.breach[i] ? 0.45 : 0);
    else if (!map.solid[i]) height[i] = 0;
    else if (t === 'Tree') height[i] = 1.3;
    else if (t === 'Window') height[i] = 0.45;
    else if (/^Fence_/.test(t)) height[i] = 0.7;
    else if (map.shotBlock[i]) height[i] = WALL_H;
    else height[i] = 0.55; // obstructions, cars, furniture
  }
  return height;
}

function buildLevel(map) {
  const { w, h, pw, ph } = map;
  // ground: the existing floor prerender plus open doors
  const ground = document.createElement('canvas'); ground.width = pw; ground.height = ph;
  const g = ground.getContext('2d'); g.drawImage(map.bot, 0, 0);
  for (const d of map.doors) if (d.open) map.drawDynamic(g, d);
  // everything raised samples one canvas: floor + doors/barricades + the over-actor layer
  const full = document.createElement('canvas'); full.width = pw; full.height = ph;
  const f = full.getContext('2d'); f.drawImage(map.bot, 0, 0);
  for (const d of map.doors) map.drawDynamic(f, { ...d, open: false });
  for (const c of map.cades) map.drawDynamic(f, c);
  f.drawImage(map.top, 0, 0);

  const tex = (c) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 8; return t; };
  const groundTex = tex(ground), fullTex = tex(full);

  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshLambertMaterial({ map: groundTex }));
  plane.rotation.x = -Math.PI / 2; plane.position.set(w / 2, 0, h / 2);

  const H = cellKinds(map);
  const pos = [], nor = [], uv = [];
  const U = (x) => (x * T) / pw, V = (z) => 1 - (z * T) / ph;
  const quad = (a, b, c, d, n, ua, ub, uc, ud) => {
    for (const [p, q] of [[a, ua], [b, ub], [c, uc], [a, ua], [c, uc], [d, ud]]) { pos.push(...p); nor.push(...n); uv.push(...q); }
  };
  const hAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : H[y * w + x]);
  for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) {
    const top = H[cy * w + cx];
    if (!top) continue;
    const x0 = cx, x1 = cx + 1, z0 = cy, z1 = cy + 1;
    const u0 = U(x0), u1 = U(x1), vt = V(z0), vb = V(z1);
    // cap
    quad([x0, top, z0], [x0, top, z1], [x1, top, z1], [x1, top, z0], [0, 1, 0], [u0, vt], [u0, vb], [u1, vb], [u1, vt]);
    // sides: the cell's own tile art stretched over the face, down to the neighbour's height
    const side = (nh, a, b, n) => {
      if (nh >= top) return;
      const vlo = vt + (vb - vt) * (1 - nh / top) * 0 + (vb - vt), vhi = vt; // whole tile, top edge at the cap
      quad([a[0], top, a[1]], [a[0], nh, a[1]], [b[0], nh, b[1]], [b[0], top, b[1]], n, [u0, vhi], [u0, vlo], [u1, vlo], [u1, vhi]);
    };
    side(hAt(cx, cy + 1), [x0, z1], [x1, z1], [0, 0, 1]);   // south
    side(hAt(cx, cy - 1), [x1, z0], [x0, z0], [0, 0, -1]);  // north
    side(hAt(cx + 1, cy), [x1, z1], [x1, z0], [1, 0, 0]);   // east
    side(hAt(cx - 1, cy), [x0, z0], [x0, z1], [-1, 0, 0]);  // west
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const walls = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: fullTex, side: THREE.DoubleSide }));
  return { plane, walls, heights: H };
}

// ---------- sprites: the existing paper-doll drawing, one small canvas per actor ----------
const SPR = 48;
function spriteFor(scale = 1) {
  const c = document.createElement('canvas'); c.width = c.height = SPR;
  const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false;
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, alphaTest: 0.5, fog: true }));
  s.center.set(0.5, 4 / SPR);
  s.scale.set((SPR / T) * scale, (SPR / T) * scale, 1);
  return { s, c, ctx, t };
}
function paint(spr, actor, atlas) {
  const { ctx, c } = spr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.setTransform(1, 0, 0, 1, SPR / 2 - actor.x, SPR - 4 - actor.y);
  actor.draw(ctx, atlas);
  spr.t.needsUpdate = true;
}
// facing relative to the camera picks which of the 4 drawn directions to show
function viewDir(fx, fz, cam) {
  const cx = -Math.sin(cam.yaw), cz = -Math.cos(cam.yaw), rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw);
  const along = fx * cx + fz * cz, side = fx * rx + fz * rz;
  return Math.abs(side) > Math.abs(along) ? (side > 0 ? 'e' : 'w') : along > 0 ? 'n' : 's';
}

function zedLooks(atlas) {
  const out = [];
  for (const b of atlas.bases) {
    const m = /^body-(zed-.+)$/.exec(b);
    if (!m || /-d[12]$/.test(m[1])) continue;
    const s = m[1];
    const layers = ['legs-' + s, 'body-' + s, 'head-' + s, 'eyes-' + s].filter((x) => atlas.bases.has(x));
    if (layers.length >= 3) out.push(layers);
  }
  return out;
}

// ---------- the scene ----------
function start(map, infected, core) {
  const canvas = $('view');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(1.5, devicePixelRatio || 1));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 80);
  camera.rotation.order = 'YXZ';

  const level = buildLevel(map);
  scene.add(level.plane, level.walls);

  const ambient = new THREE.AmbientLight(0x8090b0, 0.5);
  const moon = new THREE.DirectionalLight(0x9db0ff, 0.35); moon.position.set(-0.4, 1, 0.3);
  scene.add(ambient, moon);
  const torch = new THREE.SpotLight(0xfff1d0, 30, 18, 0.5, 0.45, 1.2);
  scene.add(torch, torch.target);
  const muzzle = new THREE.PointLight(0xffc070, 0, 6, 1.5); scene.add(muzzle);
  const lamps = Array.from({ length: 6 }, () => { const l = new THREE.PointLight(0xffb060, 0, 6, 1.4); scene.add(l); return l; });
  const fog = new THREE.Fog(0x05070a, 6, 26);
  let night = true;
  const applyLights = () => {
    scene.fog = night ? fog : null;
    scene.background = new THREE.Color(night ? 0x05070a : 0x20242c);
    ambient.intensity = night ? 0.45 : 2.2; moon.intensity = night ? 0.35 : 1.4; torch.visible = night;
    $('lightsBtn').textContent = 'L Lights: ' + (night ? 'night' : 'day');
  };

  // player
  const ps = (map.markers.PlayerSpawn || [])[0];
  const spawn = ps ? { x: ps.x + 16, y: ps.y + 24 } : map.randomWalkable();
  const player = new Player(spawn.x, spawn.y, LOOKS[1], 'riot');
  player.face = { x: 0, z: -1 };
  const pSpr = spriteFor(); scene.add(pSpr.s);

  // zombies
  const looks = zedLooks(infected);
  const zeds = [];
  const cam = { mode: 'third', yaw: 0, pitch: -0.15 };
  const near = (r0, r1) => {
    for (let k = 0; k < 200; k++) {
      const a = Math.random() * Math.PI * 2, r = (r0 + Math.random() * (r1 - r0)) * T;
      const x = player.x + Math.cos(a) * r, y = player.y + Math.sin(a) * r;
      if (!map.boxHits(x, y, 5, 4, false, true)) return { x, y };
    }
    return map.randomWalkable();
  };
  const makeZed = () => {
    const at = near(5, 16);
    const z = Object.create(Mob.prototype);
    Object.assign(z, { x: at.x, y: at.y, dir: 's', state: 'walk', animT: Math.random() * 1000, alive: true, deadT: 0, flash: 0, boss: false,
      atlas: infected, layers: looks[Math.floor(Math.random() * looks.length)], speed: (24 + Math.random() * 16) * 1.7, face: { x: 0, z: 1 } });
    z.spr = spriteFor(); scene.add(z.spr.s);
    return z;
  };
  for (let i = 0; i < ZEDS; i++) zeds.push(makeZed());

  // ---------- input ----------
  const keys = new Set();
  addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'Digit1') setMode('top'); if (e.code === 'Digit2') setMode('third'); if (e.code === 'Digit3') setMode('first');
    if (e.code === 'KeyL') { night = !night; applyLights(); }
    if (e.code === 'Space') shoot();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  const mouse = { x: 0, y: 0, has: false, drag: null };
  const locked = () => document.pointerLockElement === canvas;
  // pointer lock where the browser allows it; otherwise drag to look and click to shoot
  canvas.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.has = true;
    const look = cam.mode !== 'top' && (locked() || mouse.drag);
    if (mouse.drag) mouse.drag.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (look) { cam.yaw -= e.movementX * 0.0025; cam.pitch = Math.max(-1.2, Math.min(1.0, cam.pitch - e.movementY * 0.0025)); }
  });
  canvas.addEventListener('mousedown', (e) => {
    if (locked() || cam.mode === 'top') { shoot(); return; }
    mouse.drag = { moved: 0 };
    try { const r = canvas.requestPointerLock?.(); if (r && r.catch) r.catch(() => {}); } catch { /* not allowed here */ }
  });
  addEventListener('mouseup', () => { if (mouse.drag && mouse.drag.moved < 6 && !locked()) shoot(); mouse.drag = null; });
  document.querySelectorAll('#ui button[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('lightsBtn').addEventListener('click', () => { night = !night; applyLights(); });

  // touch: left half = move stick, right half = look (a short tap shoots)
  const touch = { move: null, look: null, mx: 0, my: 0 };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    e.preventDefault(); // no emulated mouse clicks after a tap
    if (e.clientX < innerWidth / 2) touch.move = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
    else touch.look = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (touch.move && e.pointerId === touch.move.id) { touch.mx = Math.max(-1, Math.min(1, (e.clientX - touch.move.x0) / 50)); touch.my = Math.max(-1, Math.min(1, (e.clientY - touch.move.y0) / 50)); }
    if (touch.look && e.pointerId === touch.look.id) {
      const dx = e.clientX - touch.look.x, dy = e.clientY - touch.look.y; touch.look.x = e.clientX; touch.look.y = e.clientY; touch.look.moved += Math.abs(dx) + Math.abs(dy);
      if (cam.mode === 'top') { mouse.x = e.clientX; mouse.y = e.clientY; mouse.has = true; } else { cam.yaw -= dx * 0.006; cam.pitch = Math.max(-1.2, Math.min(1, cam.pitch - dy * 0.006)); }
    }
  });
  const endTouch = (e) => {
    if (touch.move && e.pointerId === touch.move.id) { touch.move = null; touch.mx = touch.my = 0; }
    if (touch.look && e.pointerId === touch.look.id) { if (touch.look.moved < 12 && performance.now() - touch.look.t < 300) shoot(); touch.look = null; }
  };
  canvas.addEventListener('pointerup', endTouch); canvas.addEventListener('pointercancel', endTouch);

  let padPrev = [];
  const pad = () => { for (const p of navigator.getGamepads?.() || []) if (p && p.connected) return p; return null; };

  function setMode(m) {
    cam.mode = m;
    if (m === 'first') cam.pitch = 0; else if (m === 'third') cam.pitch = -0.2;
    if (m === 'top' && document.pointerLockElement) document.exitPointerLock();
    document.querySelectorAll('#ui button[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    $('cross').style.display = m === 'top' ? 'none' : 'block';
    camera.fov = m === 'top' ? 40 : m === 'third' ? 62 : 72; camera.updateProjectionMatrix();
  }

  // ---------- shooting (hitscan along the facing, like the game) ----------
  let flashT = 0;
  function shoot() {
    flashT = 0.07;
    let best = null, bestD = 18 * T;
    for (const z of zeds) {
      if (!z.alive) continue;
      const dx = z.x - player.x, dy = z.y - player.y, d = Math.hypot(dx, dy);
      if (d > bestD || d < 1) continue;
      const along = (dx * player.face.x + dy * player.face.z) / d;
      const tol = Math.max(0.985, 1 - 12 / d); // wider cone up close
      if (along < tol || !map.los(player.x, player.y - 10, z.x, z.y - 10)) continue;
      best = z; bestD = d;
    }
    if (best) { best.alive = false; best.deadT = 0; best.flash = 0.1; }
  }

  // ---------- loop ----------
  const ray = new THREE.Raycaster(), groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3(), ndc = new THREE.Vector2();
  let last = performance.now(), fps = 60, lampT = 0;
  setMode('third'); applyLights();

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;

    // input
    let mx = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) + touch.mx;
    let my = (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0) + touch.my;
    let run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const gp = pad();
    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
      mx += dz(gp.axes[0]); my += dz(gp.axes[1]);
      const lx = dz(gp.axes[2] || 0), ly = dz(gp.axes[3] || 0);
      if (cam.mode === 'top') { if (lx || ly) { player.face = { x: lx / Math.hypot(lx, ly), z: ly / Math.hypot(lx, ly) }; player.padAim = true; } }
      else { cam.yaw -= lx * 2.6 * dt; cam.pitch = Math.max(-1.2, Math.min(1, cam.pitch - ly * 1.8 * dt)); }
      const pressed = (i) => gp.buttons[i] && gp.buttons[i].pressed && !padPrev[i];
      if (pressed(7) || pressed(5)) shoot();
      if (pressed(3)) setMode(cam.mode === 'top' ? 'third' : cam.mode === 'third' ? 'first' : 'top');
      if (gp.buttons[10]?.pressed || gp.buttons[6]?.pressed) run = true;
      padPrev = gp.buttons.map((b) => b.pressed);
    }
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    // camera-relative movement (top-down: screen up = north)
    const yaw = cam.mode === 'top' ? 0 : cam.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const wx = rx * mx - fx * my, wz = rz * mx - fz * my;
    player.moving = len > 0.1; player.running = run && player.moving;
    const sp = (player.running ? 128 : 78) * dt;
    if (player.moving) player.move(map, wx * sp, wz * sp);
    player.animT += dt * 1000;

    // facing: camera forward in 3rd/1st person, mouse ray on the ground in top-down
    if (cam.mode !== 'top') player.face = { x: fx, z: fz };
    else if (mouse.has && !player.padAim) {
      ndc.set((mouse.x / innerWidth) * 2 - 1, -(mouse.y / innerHeight) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      if (ray.ray.intersectPlane(groundPlane, hit)) { const dx = hit.x - player.x / T, dz = hit.z - player.y / T, l = Math.hypot(dx, dz) || 1; player.face = { x: dx / l, z: dz / l }; }
    } else if (player.moving && !player.padAim) { const l = Math.hypot(wx, wz); player.face = { x: wx / l, z: wz / l }; }

    // zombies walk straight at the player and slide along walls
    for (const z of zeds) {
      if (!z.alive) {
        z.deadT += dt;
        if (z.deadT > 2.2) { scene.remove(z.spr.s); Object.assign(z, makeZed()); }
        continue;
      }
      z.animT += dt * 1000; if (z.flash > 0) z.flash -= dt;
      const dx = player.x - z.x, dy = player.y - z.y, d = Math.hypot(dx, dy);
      if (d > 20 * T) continue;
      z.face = { x: dx / d, z: dy / d };
      if (d < 18) { z.state = 'attack'; continue; }
      z.state = 'walk';
      const s = z.speed * dt;
      z.move(map, (dx / d) * s, 0); z.move(map, 0, (dy / d) * s);
    }
    // keep zeds from stacking
    for (let i = 0; i < zeds.length; i++) for (let j = i + 1; j < zeds.length; j++) {
      const a = zeds[i], b = zeds[j]; if (!a.alive || !b.alive) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d > 0 && d < 12) { const p = (12 - d) / 2 / d; a.move(map, -dx * p, -dy * p); b.move(map, dx * p, dy * p); }
    }

    // camera
    const px = player.x / T, pz = player.y / T;
    if (cam.mode === 'top') {
      cam.yaw = 0;
      camera.position.set(px, 13, pz + 8.5);
      camera.lookAt(px, 0, pz);
    } else if (cam.mode === 'third') {
      const back = 3.0, side = 0.55, up = 1.35 - cam.pitch * 1.4;
      const want = new THREE.Vector3(px - fx * back + rx * side, Math.max(0.5, up), pz - fz * back + rz * side);
      // pull in if a wall is between the player and the camera
      const steps = 12; let k = steps;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, x = px + (want.x - px) * t, z = pz + (want.z - pz) * t;
        const h = level.heights[Math.floor(z) * map.w + Math.floor(x)] || 0;
        if (h > want.y - 0.2) { k = s - 1; break; }
      }
      const t = Math.max(0.25, k / steps);
      camera.position.set(px + (want.x - px) * t, want.y, pz + (want.z - pz) * t);
      camera.rotation.set(cam.pitch - 0.12, cam.yaw, 0);
    } else {
      camera.position.set(px, 0.78 + (player.moving ? Math.abs(Math.sin(player.animT / 140)) * 0.03 : 0), pz);
      camera.rotation.set(cam.pitch, cam.yaw, 0);
    }

    // lights: flashlight from the player along the facing, nearest map lamps
    torch.position.set(px, 0.9, pz);
    torch.target.position.set(px + player.face.x * 6, cam.mode === 'first' ? 0.9 + Math.tan(cam.pitch) * 6 : 0.2, pz + player.face.z * 6);
    if (flashT > 0) { flashT -= dt; muzzle.position.set(px + player.face.x * 0.6, 0.8, pz + player.face.z * 0.6); muzzle.intensity = 12; $('flash').style.opacity = cam.mode === 'top' ? 0 : 1; }
    else { muzzle.intensity = 0; $('flash').style.opacity = 0; }
    lampT -= dt;
    if (lampT <= 0) {
      lampT = 0.5;
      const ls = map.lights.map((l) => [l, Math.hypot(l.x - player.x, l.y - player.y)]).sort((a, b) => a[1] - b[1]).slice(0, lamps.length);
      lamps.forEach((L, i) => { const e = ls[i]; if (!e || !night) { L.intensity = 0; return; } L.position.set(e[0].x / T, 1.2, e[0].y / T); L.distance = Math.max(3, e[0].radius / T * 1.6); L.intensity = 4; });
    }

    // sprites: draw the existing paper-dolls with the direction seen from the camera
    const shade = (x, y) => {
      if (!night) return 1;
      let b = 0.42;
      const dx = x - player.x, dy = y - player.y, d = Math.hypot(dx, dy) / T;
      if (d < 0.8) b = 1;
      else if (d < 18) { const c = (dx * player.face.x + dy * player.face.z) / (d * T); if (c > 0.85) b += (1 - d / 18) * 1.1 * Math.min(1, (c - 0.85) / 0.08); }
      for (const L of lamps) if (L.intensity > 0) { const ld = Math.hypot(L.position.x - x / T, L.position.z - y / T); if (ld < L.distance) b += 0.5 * (1 - ld / L.distance); }
      if (flashT > 0 && d < 6) b += 0.6;
      return Math.min(1.2, b);
    };
    pSpr.s.visible = cam.mode !== 'first';
    if (pSpr.s.visible) {
      player.dir = viewDir(player.face.x, player.face.z, cam);
      paint(pSpr, player, core);
      pSpr.s.position.set(px, 0, pz + 0.01);
    }
    for (const z of zeds) {
      const visible = Math.abs(z.x - player.x) < 26 * T && Math.abs(z.y - player.y) < 26 * T;
      z.spr.s.visible = visible;
      if (!visible) continue;
      z.dir = viewDir(z.face.x, z.face.z, cam);
      paint(z.spr, z, infected);
      z.spr.s.position.set(z.x / T, 0, z.y / T + 0.01);
      const b = shade(z.x, z.y); z.spr.s.material.color.setRGB(b, b, b);
    }

    renderer.render(scene, camera);
    $('stats').textContent = `${Math.round(fps)} fps · ${renderer.info.render.calls} draws · ${zeds.filter((z) => z.alive).length} zeds`;
    requestAnimationFrame(frame);
  }

  const resize = () => { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
  addEventListener('resize', resize); resize();
  window.__poc = { setMode, player, cam, zeds, shoot, setNight: (v) => { night = v; applyLights(); } };
  requestAnimationFrame(frame);
}

boot().catch((e) => { $('loading').textContent = 'Failed to load: ' + e.message; console.error(e); });
