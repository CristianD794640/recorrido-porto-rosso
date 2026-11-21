// Recorrido virtual – Porto Rosso, apartamento tipo 4
// Coordenadas: plano (x, y) en metros  ->  three.js (x, -y); altura = eje y de three.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const qs = new URLSearchParams(location.search);
const EYE = 1.60, RADIUS = 0.24, SPEED = 1.25, RUN = 2.4;
const isTouch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
if (isTouch) document.body.classList.add('touch');

// ------------------------------------------------------------------ renderer / escena
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.75 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = parseFloat(qs.get('exp') || '0.62');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc9d6e2);
const camera = new THREE.PerspectiveCamera(isTouch ? 75 : 70, innerWidth / innerHeight, 0.05, 400);
camera.rotation.order = 'YXZ';

const small = isTouch && Math.min(screen.width, screen.height) < 900;
const TEXDIR = (qs.get('tex') === '2k' || small || renderer.capabilities.maxTextureSize < 4096) ? 'tex2k/' : 'tex/';
const maxAniso = renderer.capabilities.getMaxAnisotropy();

// ------------------------------------------------------------------ carga
const manager = new THREE.LoadingManager();
const bar = document.getElementById('bar'), loadtxt = document.getElementById('loadtxt');
manager.onProgress = (url, done, total) => { bar.style.width = (100 * done / total).toFixed(0) + '%'; };
manager.onError = url => console.warn('No se pudo cargar', url);
const texLoader = new THREE.TextureLoader(manager);
const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
const gltfLoader = new GLTFLoader(manager).setDRACOLoader(draco);

const texPromises = [];
function tex(path, srgb = true) {
  let ok, ko;
  texPromises.push(new Promise(r => { ok = r; ko = r; }));
  const t = texLoader.load(path.replace(/^tex\//, TEXDIR), ok, undefined, () => { console.warn('Falta', path); ko(); });
  t.flipY = false;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}

const [meta, plan] = await Promise.all([
  fetch('bake_meta.json').then(r => r.json()),
  fetch('plan.json').then(r => r.json()),
]);
document.getElementById('f-area').textContent = plan.area_total.toLocaleString('es-CO');

const dollBg = new THREE.Color(0x2b2724);
let skyBg = scene.background;
try {
  const sky = texLoader.load('sky.jpg');
  sky.mapping = THREE.EquirectangularReflectionMapping;
  sky.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyBg = sky;
} catch (e) { /* sin panorama: color de fondo */ }

const gltf = await gltfLoader.loadAsync('apto.glb');
const root = gltf.scene;
scene.add(root);
root.updateMatrixWorld(true);

const atlasById = Object.fromEntries(meta.atlases.map(a => [a.id, a]));
const LS = meta.light_scale;
const collide = [];          // mallas contra las que se choca
const pickable = [];         // mallas para clic / medir
const ceiling = [];          // se ocultan en la vista 3D
const pbr = [];
const mirrors = [];
const outside = [];          // entorno: se oculta en la vista 3D
const furn = [];             // mobiliario del propietario: se puede ocultar
const vacio = [];            // materiales con mapa de luz alterno "apartamento vacío"

root.traverse(o => {
  if (!o.isMesh) return;
  const name = o.name || o.parent?.name || '';
  let m = /^BAKE_(\d+)_(\w+)/.exec(name) || /^BAKE_(\d+)_(\w+)/.exec(o.parent?.name || '');
  if (m) {
    const a = atlasById[+m[1]], kind = m[2];
    const mat = new THREE.MeshBasicMaterial({
      map: a.albedo ? tex(a.albedo) : null,
      color: a.albedo ? 0xffffff : new THREE.Color().setRGB(...a.color, THREE.LinearSRGBColorSpace),
      lightMap: tex(a.light), lightMapIntensity: LS,
    });
    if (kind === 'lino' || kind === 'velo') {
      mat.transparent = true; mat.opacity = kind === 'velo' ? 0.55 : 0.92; mat.side = THREE.DoubleSide; mat.depthWrite = false;
    }
    o.material = mat;
    if (a.mueble) furn.push(o);
    if (a.light_vacio) vacio.push({ mat, full: mat.lightMap, path: a.light_vacio, tex: null });
    const bb = new THREE.Box3().setFromObject(o);
    if (bb.max.x - bb.min.x > 40 || bb.min.y < -5) { outside.push(o); return; }   // terreno y vecinos
    if (kind === 'techo') ceiling.push(o);
    if (kind !== 'velo') collide.push(o);
    pickable.push(o);
  } else if (/MIRROR/.test(name)) {
    mirrors.push(o);
  } else {
    pbr.push(o);
    if (/_MUEBLE/.test(name)) furn.push(o);
    const n = name.toLowerCase();
    if (n.includes('vidrio')) {
      const copas = n.includes('copas');          // copas y vasos del bar: algo más visibles que los ventanales
      o.material = new THREE.MeshStandardMaterial({ color: copas ? 0xf6fbfc : 0xeef6fa, metalness: 0,
        roughness: copas ? 0.02 : 0.04, transparent: true, opacity: copas ? 0.32 : 0.14, depthWrite: false });
      collide.push(o);
    } else if (n.includes('led')) {
      o.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3.8, 3.4) });
      ceiling.push(o);
    } else {
      collide.push(o); pickable.push(o);
    }
  }
});
for (const o of new Set([...collide, ...pickable])) o.geometry.computeBoundsTree();

// puertas batientes: se cierran cuando uno está dentro del espacio hacia el que abren, y se abren al acercarse
// (cada hoja viene con su origen en la bisagra; "close" es el giro, en radianes, que la lleva a cerrada)
const doors = (meta.doors || []).map(d => ({ ...d,
  leafObj: d.leaf && root.getObjectByName(d.leaf), handleObj: d.handle && root.getObjectByName(d.handle), t: 0 }))
  .filter(d => d.leafObj);

// reflejos: un cubemap capturado en la sala para metales y vidrio (cuando ya cargaron las texturas)
function captureEnv() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(0.05, 100, cubeRT);
  cubeCam.position.set(3.0, 1.4, -4.4);
  scene.add(cubeCam);
  const hide = [...pbr, ...reflectors];
  const vis = hide.map(o => o.visible); hide.forEach(o => { o.visible = false; });
  cubeCam.update(renderer, scene);
  hide.forEach((o, i) => { o.visible = vis[i]; });
  const envMap = pmrem.fromCubemap(cubeRT.texture).texture;
  for (const o of pbr) { if (o.material.isMeshStandardMaterial) { o.material.envMap = envMap; o.material.envMapIntensity = 1.0; o.material.needsUpdate = true; } }
}

// espejos reales (Reflector) a partir de las cajas MIRROR_*
// Un espejo no se dibuja dentro del reflejo de otro (evita la recursión espejo-en-espejo, que crece
// de forma exponencial con 13 espejos) y solo se actualiza cuando la cámara está cerca.
const reflectors = [];
let inReflect = false;
for (const o of mirrors) {
  o.geometry.computeBoundingBox();
  const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
  const size = bb.getSize(new THREE.Vector3()), c = bb.getCenter(new THREE.Vector3());
  const thin = size.x < size.z ? 'x' : 'z';
  const w = thin === 'x' ? size.z : size.x, h = size.y;
  const tw = isTouch ? 512 : 768;
  const refl = new Reflector(new THREE.PlaneGeometry(w, h), {
    textureWidth: tw, textureHeight: Math.min(2 * tw, Math.round(tw * h / Math.max(w, 0.1))),
    color: 0xb9bcbe, clipBias: 0.003 });
  const draw = refl.onBeforeRender;
  refl.onBeforeRender = function (rend, scn, cam) {
    if (inReflect || cam.position.distanceTo(this.position) > 7) return;
    inReflect = true;
    try { draw.call(this, rend, scn, cam); } finally { inReflect = false; }
  };
  reflectors.push(refl);
  if (/MUEBLE/.test(o.name)) { furn.push(refl); refl.userData.mueble = true; }
  // la cara útil es la que da hacia el espacio libre
  const ray = new THREE.Raycaster();
  let best = 1, bestD = -1;
  for (const s of [1, -1]) {
    const dir = thin === 'x' ? new THREE.Vector3(s, 0, 0) : new THREE.Vector3(0, 0, s);
    ray.set(c.clone().addScaledVector(dir, (thin === 'x' ? size.x : size.z) / 2 + 0.01), dir);
    ray.far = 5;
    const hit = ray.intersectObjects(collide, false)[0];
    const d = hit ? hit.distance : 5;
    if (d > bestD) { bestD = d; best = s; }
  }
  const off = (thin === 'x' ? size.x : size.z) / 2 + 0.002;
  refl.position.copy(c).add(thin === 'x' ? new THREE.Vector3(best * off, 0, 0) : new THREE.Vector3(0, 0, best * off));
  refl.lookAt(refl.position.clone().add(thin === 'x' ? new THREE.Vector3(best, 0, 0) : new THREE.Vector3(0, 0, best)));
  o.visible = false;
  scene.add(refl);
  collide.push(o); o.geometry.computeBoundsTree();
}

// ------------------------------------------------------------------ mostrar / quitar muebles
// Al quitar los muebles se ocultan sus mallas y piso, muros y carpintería cambian al mapa de luz
// horneado sin mobiliario (sin sus sombras). Ese juego de texturas se descarga la primera vez.
let furnOn = true, vacioReady = null;
const bFurn = document.getElementById('b-furn');
function loadVacio() {
  if (!vacioReady) {
    const loader = new THREE.TextureLoader();
    vacioReady = Promise.all(vacio.map(v => new Promise(res => {
      loader.load(v.path.replace(/^tex\//, TEXDIR), t => {
        t.flipY = false; t.colorSpace = THREE.LinearSRGBColorSpace; t.anisotropy = maxAniso; v.tex = t; res();
      }, undefined, () => { v.tex = v.full; res(); });
    })));
  }
  return vacioReady;
}
async function setFurniture(on) {
  furnOn = on;
  bFurn.classList.toggle('on', on); bFurn.setAttribute('aria-pressed', String(on));
  if (!on && vacio.some(v => !v.tex)) {
    hint('Preparando el apartamento vacío…', 20000);
    await loadVacio();
    if (furnOn) return;          // se volvió a activar mientras cargaba
  }
  for (const o of furn) o.visible = on;
  for (const v of vacio) v.mat.lightMap = on ? v.full : v.tex;
  hint(on ? 'Muebles visibles' : 'Apartamento vacío · así lo recibes', 3000);
}
bFurn.onclick = () => setFurniture(!furnOn);

// ------------------------------------------------------------------ minimapa
const svg = document.getElementById('map');
const allPts = plan.walls.flat();
const minX = Math.min(...allPts.map(p => p[0])) - 0.2, maxX = Math.max(...allPts.map(p => p[0])) + 0.2;
const minY = Math.min(...allPts.map(p => p[1])) - 0.2, maxY = Math.max(...allPts.map(p => p[1])) + 0.2;
// SVG: x a la derecha, y hacia arriba en el plano -> invertir
svg.setAttribute('viewBox', `${minX} ${-maxY} ${maxX - minX} ${maxY - minY}`);
const NS = 'http://www.w3.org/2000/svg';
const ptsAttr = pts => pts.map(p => `${p[0]},${-p[1]}`).join(' ');
const roomEls = [];
for (const r of plan.rooms) {
  const el = document.createElementNS(NS, 'polygon');
  el.setAttribute('points', ptsAttr(r.pts)); el.setAttribute('class', 'room');
  const t = document.createElementNS(NS, 'title'); t.textContent = `${r.name} · ${fmt(r.area)} m²`; el.appendChild(t);
  el.addEventListener('click', () => goRoom(r));
  svg.appendChild(el); roomEls.push(el);
}
for (const w of plan.walls) {
  const el = document.createElementNS(NS, 'polygon');
  el.setAttribute('points', ptsAttr(w)); el.setAttribute('class', 'wall'); svg.appendChild(el);
}
for (const o of plan.openings) {
  if (o.type !== 'window' && o.type !== 'slide') continue;
  const [x0, x1, y0, y1] = o.rect, el = document.createElementNS(NS, 'line');
  const horiz = (x1 - x0) > (y1 - y0);
  el.setAttribute('x1', horiz ? x0 : (x0 + x1) / 2); el.setAttribute('x2', horiz ? x1 : (x0 + x1) / 2);
  el.setAttribute('y1', -(horiz ? (y0 + y1) / 2 : y0)); el.setAttribute('y2', -(horiz ? (y0 + y1) / 2 : y1));
  el.setAttribute('class', 'win'); svg.appendChild(el);
}
for (const r of plan.rooms) {
  if (r.area < 2.5) continue;
  const cx = r.pts.reduce((s, p) => s + p[0], 0) / r.pts.length, cy = r.pts.reduce((s, p) => s + p[1], 0) / r.pts.length;
  const t = document.createElementNS(NS, 'text');
  t.setAttribute('x', cx); t.setAttribute('y', -cy); t.setAttribute('class', 'lbl');
  t.textContent = r.name.replace('Alcoba principal', 'Alc. ppal').replace('Sala - comedor', 'Sala-comedor');
  svg.appendChild(t);
}
const me = document.createElementNS(NS, 'g');
me.innerHTML = '<path d="M0 0 L1.3 -0.75 A1.5 1.5 0 0 1 1.3 0.75 Z" fill="rgba(217,163,91,.35)"/><circle r="0.2" fill="#d9a35b" stroke="#1d1b19" stroke-width="0.06"/>';
svg.appendChild(me);
document.getElementById('mapmin').onclick = e => {
  const box = document.getElementById('mapbox'); box.classList.toggle('min');
  e.currentTarget.textContent = box.classList.contains('min') ? '+' : '–';
};

function fmt(v, d = 1) { return v.toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function inPoly(x, y, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// ------------------------------------------------------------------ jugador
const player = { x: 0, z: 0, yaw: 0, pitch: -0.05 };
function setView(px, py, headingDeg) {
  player.x = px; player.z = -py;
  player.yaw = THREE.MathUtils.degToRad(headingDeg - 90);
  player.pitch = -0.05;
}
setView(...plan.start);
if (qs.has('debug')) window.__tour = { scene, camera, setView, player, walkTo: (x, z) => walkTo(x, z), setFurniture: on => setFurniture(on), nav: () => NAV };   // para capturas automáticas

const fade = document.getElementById('fade');
let viewRoom = null;   // espacio elegido en "Espacios": se muestra aunque el punto de vista caiga entre polígonos
function teleport(px, py, h, room = null) {
  fade.style.opacity = 1;
  setTimeout(() => { if (doll) setDoll(false); setView(px, py, h); viewRoom = room; walkTarget = null; walkPath = null; fade.style.opacity = 0; }, 260);
}
function goRoom(r) {
  const v = r.view || [r.pts.reduce((s, p) => s + p[0], 0) / r.pts.length, r.pts.reduce((s, p) => s + p[1], 0) / r.pts.length, 0];
  teleport(...v, r); roomsPanel.classList.remove('open'); bRooms.classList.remove('on');
}

// ------------------------------------------------------------------ navegación
// Rejilla 2D (5 cm) hecha con el plano: solo detienen los muros, ventanas y barandas, nunca los muebles.
// Se puede pisar el interior de los espacios y los vanos de puertas; el resto queda fuera.
const NAV = (() => {
  const res = 0.05, pad = 0.4, all = plan.walls.flat();
  const x0 = Math.min(...all.map(p => p[0])) - pad, y0 = Math.min(...all.map(p => p[1])) - pad;
  const W = Math.ceil((Math.max(...all.map(p => p[0])) + pad - x0) / res);
  const H = Math.ceil((Math.max(...all.map(p => p[1])) + pad - y0) / res);
  const rectPoly = ([a, b, c, d]) => [[a, c], [b, c], [b, d], [a, d]];
  function raster(polys, out) {
    for (const poly of polys) {
      const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
      const i0 = Math.max(0, Math.floor((Math.min(...xs) - x0) / res)), i1 = Math.min(W - 1, Math.ceil((Math.max(...xs) - x0) / res));
      const j0 = Math.max(0, Math.floor((Math.min(...ys) - y0) / res)), j1 = Math.min(H - 1, Math.ceil((Math.max(...ys) - y0) / res));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++)
        if (inPoly(x0 + (i + 0.5) * res, y0 + (j + 0.5) * res, poly)) out[j * W + i] = 1;
    }
  }
  const solid = new Uint8Array(W * H), inside = new Uint8Array(W * H);
  raster([...plan.walls, ...plan.openings.filter(o => ['window', 'railing', 'louver'].includes(o.type)).map(o => rectPoly(o.rect))], solid);
  raster([...plan.rooms.map(r => r.pts), ...plan.openings.filter(o => o.type === 'door' || o.type === 'slide').map(o => rectPoly(o.rect))], inside);
  // margen del cuerpo: 20 cm alrededor de muros y del borde del apartamento
  const R = Math.round(0.20 / res), offs = [];
  for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) if (di * di + dj * dj <= R * R) offs.push([di, dj]);
  const block = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (!solid[k] && inside[k]) continue;
    for (const [di, dj] of offs) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < W && jj < H) block[jj * W + ii] = 1;
    }
  }
  const cell = (x, y) => [Math.floor((x - x0) / res), Math.floor((y - y0) / res)];
  const freeCell = (i, j) => i >= 0 && j >= 0 && i < W && j < H && !block[j * W + i];
  const free = (x, y) => { const [i, j] = cell(x, y); return freeCell(i, j); };
  // línea libre entre dos puntos (para suavizar la ruta)
  function clear(ax, ay, bx, by) {
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / (res * 0.5));
    for (let k = 1; k <= n; k++) if (!free(ax + (bx - ax) * k / n, ay + (by - ay) * k / n)) return false;
    return true;
  }
  function nearestFree(i, j, maxR = 12) {
    if (freeCell(i, j)) return [i, j];
    for (let r = 1; r <= maxR; r++)
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++)
        if (Math.max(Math.abs(di), Math.abs(dj)) === r && freeCell(i + di, j + dj)) return [i + di, j + dj];
    return null;
  }
  // A* con 8 vecinos; devuelve puntos del plano (x, y) ya suavizados
  function path(ax, ay, bx, by) {
    const s = nearestFree(...cell(ax, ay)), t = nearestFree(...cell(bx, by));
    if (!s || !t) return null;
    const N = W * H, g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), done = new Uint8Array(N);
    const sk = s[1] * W + s[0], tk = t[1] * W + t[0];
    const heap = [], push = (k, f) => { heap.push([f, k]); let c = heap.length - 1;
      while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => { const top = heap[0], last = heap.pop();
      if (heap.length) { heap[0] = last; let c = 0;
        for (;;) { const l = 2 * c + 1, r = l + 1; let m = c;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } }
      return top; };
    const hfun = k => { const dx = Math.abs(k % W - t[0]), dy = Math.abs(((k / W) | 0) - t[1]); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    g[sk] = 0; push(sk, hfun(sk));
    const nb = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
    let found = false, iter = 0;
    while (heap.length && iter++ < 400000) {
      const [, k] = pop();
      if (done[k]) continue; done[k] = 1;
      if (k === tk) { found = true; break; }
      const i = k % W, j = (k / W) | 0;
      for (const [di, dj, c] of nb) {
        const ii = i + di, jj = j + dj;
        if (!freeCell(ii, jj) || (di && dj && (!freeCell(i + di, j) || !freeCell(i, j + dj)))) continue;
        const kk = jj * W + ii, ng = g[k] + c;
        if (ng < g[kk]) { g[kk] = ng; from[kk] = k; push(kk, ng + hfun(kk)); }
      }
    }
    if (!found) return null;
    const raw = [];
    for (let k = tk; k !== -1; k = from[k]) raw.push([x0 + (k % W + 0.5) * res, y0 + (((k / W) | 0) + 0.5) * res]);
    raw.reverse(); raw[raw.length - 1] = free(bx, by) ? [bx, by] : raw[raw.length - 1];
    const out = []; let cur = [ax, ay], idx = 0;
    while (idx < raw.length - 1) {
      let far = idx + 1;
      for (let k = raw.length - 1; k > idx + 1; k--) if (clear(cur[0], cur[1], raw[k][0], raw[k][1])) { far = k; break; }
      out.push(raw[far]); cur = raw[far]; idx = far;
    }
    if (!out.length) out.push(raw[raw.length - 1]);
    return out;
  }
  return { free, path };
})();

// paso con deslizamiento: si el paso completo choca, se intenta cada eje por separado
function move(dx, dz) {
  const x = player.x, z = player.z;
  const ok = (nx, nz) => NAV.free(nx, -nz) || !NAV.free(x, -z);   // si ya está en un borde, puede salir
  if (ok(x + dx, z + dz)) { player.x += dx; player.z += dz; return true; }
  if (Math.abs(dx) > 1e-6 && ok(x + dx, z)) { player.x += dx; return true; }
  if (Math.abs(dz) > 1e-6 && ok(x, z + dz)) { player.z += dz; return true; }
  return false;
}

// ------------------------------------------------------------------ entrada
const keys = {};
addEventListener('keydown', e => { if (e.target.tagName !== 'INPUT') keys[e.code] = true; if (e.code === 'Escape') cancelMeasure(); });
addEventListener('keyup', e => { keys[e.code] = false; });

let drag = null, walkTarget = null, walkPath = null;
function walkTo(x, z) {
  const p = NAV.path(player.x, -player.z, x, -z);
  if (!p) { walkPath = null; walkTarget = null; hint('No se puede llegar a ese punto caminando'); return; }
  walkPath = p.map(([px, py]) => new THREE.Vector2(px, -py));
  walkTarget = walkPath.shift();
}
const ndc = new THREE.Vector2();
function pick(ev, list = pickable) {
  ndc.set(ev.clientX / innerWidth * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  const r = new THREE.Raycaster(); r.firstHitOnly = true;
  r.setFromCamera(ndc, camera);
  return r.intersectObjects(list.filter(o => o.visible), false)[0];
}
canvas.addEventListener('pointerdown', e => {
  if (doll) return;
  canvas.setPointerCapture(e.pointerId);
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now() };
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', e => {
  if (drag && e.pointerId === drag.id) {
    const k = isTouch ? 0.0055 : 0.0042;
    player.yaw += (e.clientX - drag.x) * k;
    player.pitch = THREE.MathUtils.clamp(player.pitch + (e.clientY - drag.y) * k, -1.2, 1.2);
    drag.x = e.clientX; drag.y = e.clientY;
  } else if (!isTouch && !doll) hover(e);
});
canvas.addEventListener('pointerup', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const moved = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0), quick = performance.now() - drag.t < 350;
  drag = null; canvas.classList.remove('dragging');
  if (moved < 7 && quick) click(e);
});
canvas.addEventListener('pointercancel', () => { drag = null; canvas.classList.remove('dragging'); });

const reticle = document.getElementById('reticle');
function hover(e) {
  const h = pick(e);
  if (h && !measuring && h.face && h.face.normal.clone().transformDirection(h.object.matrixWorld).y > 0.7 && h.point.y < 0.25) {
    reticle.style.display = 'block'; reticle.style.left = e.clientX + 'px'; reticle.style.top = e.clientY + 'px';
  } else reticle.style.display = 'none';
}
function click(e) {
  const h = pick(e);
  if (!h) return;
  if (measuring) return addMeasurePoint(h.point);
  const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
  if (n.y > 0.7 && h.point.y < 0.25) walkTo(h.point.x, h.point.z);
}

// joystick táctil
const joy = document.getElementById('joy'), knob = joy.querySelector('i');
const joyVec = new THREE.Vector2();
let joyId = null;
function joySet(e) {
  const r = joy.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let dx = e.clientX - cx, dy = e.clientY - cy; const R = r.width / 2 - 12, d = Math.hypot(dx, dy);
  if (d > R) { dx *= R / d; dy *= R / d; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`; joyVec.set(dx / R, dy / R);
}
joy.addEventListener('pointerdown', e => { joyId = e.pointerId; joy.setPointerCapture(e.pointerId); joySet(e); walkTarget = null; walkPath = null; e.stopPropagation(); });
joy.addEventListener('pointermove', e => { if (e.pointerId === joyId) joySet(e); });
const joyEnd = e => { if (e.pointerId === joyId) { joyId = null; joyVec.set(0, 0); knob.style.transform = ''; } };
joy.addEventListener('pointerup', joyEnd); joy.addEventListener('pointercancel', joyEnd);

// ------------------------------------------------------------------ medir
let measuring = false, mA = null, mPreview = null;
const measures = [];
const bMeasure = document.getElementById('b-measure');
const lineMat = new THREE.LineBasicMaterial({ color: 0xd9a35b, depthTest: false, toneMapped: false });
const dotGeo = new THREE.SphereGeometry(0.025, 12, 8), dotMat = new THREE.MeshBasicMaterial({ color: 0xd9a35b, depthTest: false, toneMapped: false });
function dot(p) { const d = new THREE.Mesh(dotGeo, dotMat); d.position.copy(p); d.renderOrder = 5; scene.add(d); return d; }
function addMeasurePoint(p) {
  if (!mA) { mA = { p: p.clone(), dot: dot(p) }; hint('Toca el segundo punto'); return; }
  const g = new THREE.BufferGeometry().setFromPoints([mA.p, p]);
  const line = new THREE.Line(g, lineMat); line.renderOrder = 5; scene.add(line);
  const lab = document.createElement('div'); lab.className = 'mlabel';
  lab.textContent = fmt(mA.p.distanceTo(p), 2) + ' m'; document.body.appendChild(lab);
  measures.push({ objs: [mA.dot, dot(p), line], lab, mid: mA.p.clone().add(p).multiplyScalar(0.5) });
  mA = null; hint('Medida lista · toca otro punto para medir de nuevo');
}
function cancelMeasure() { if (mA) { scene.remove(mA.dot); mA = null; } }
function clearMeasures() { for (const m of measures) { m.objs.forEach(o => scene.remove(o)); m.lab.remove(); } measures.length = 0; cancelMeasure(); }
bMeasure.onclick = () => {
  measuring = !measuring; bMeasure.classList.toggle('on', measuring); canvas.classList.toggle('measure', measuring);
  if (measuring) hint('Toca dos puntos (piso, muros, muebles) para medir la distancia', 6000);
  else { clearMeasures(); hint(''); }
};

// ------------------------------------------------------------------ vista 3D (maqueta)
let doll = false;
const orbit = new OrbitControls(camera, canvas);
orbit.enabled = false; orbit.enableDamping = true; orbit.maxPolarAngle = Math.PI * 0.47; orbit.minDistance = 4; orbit.maxDistance = 30;
const bDoll = document.getElementById('b-doll');
function setDoll(on) {
  doll = on; bDoll.classList.toggle('on', on); orbit.enabled = on;
  for (const o of ceiling) o.visible = !on;
  for (const o of outside) o.visible = !on;
  scene.background = on ? dollBg : skyBg;
  document.getElementById('joy').style.visibility = on ? 'hidden' : '';
  if (on) {
    reticle.style.display = 'none';
    orbit.target.set(7.1, 0, -5.4);
    camera.position.set(player.x - 6, 15, player.z + 9);
    orbit.update();
    hint('Arrastra para girar · pellizca o rueda para acercar · toca el piso para entrar ahí', 6000);
  } else { camera.rotation.set(player.pitch, player.yaw, 0); }
}
bDoll.onclick = () => setDoll(!doll);
canvas.addEventListener('click', e => {
  if (!doll) return;
  const h = pick(e);
  if (h && h.point.y < 0.25 && h.face.normal.clone().transformDirection(h.object.matrixWorld).y > 0.7) {
    const yawTo = Math.atan2(-(h.point.x - camera.position.x), -(h.point.z - camera.position.z));
    fade.style.opacity = 1;
    setTimeout(() => { setDoll(false); player.x = h.point.x; player.z = h.point.z; player.yaw = yawTo; player.pitch = -0.05; fade.style.opacity = 0; }, 260);
  }
});

// ------------------------------------------------------------------ panel de espacios / ayuda
const roomsPanel = document.getElementById('rooms'), bRooms = document.getElementById('b-rooms');
for (const r of [...plan.rooms].sort((a, b) => b.area - a.area)) {
  const b = document.createElement('button');
  b.innerHTML = `${r.name}<span>${fmt(r.area)} m²</span>`;
  b.onclick = () => goRoom(r);
  roomsPanel.appendChild(b);
}
bRooms.onclick = () => { roomsPanel.classList.toggle('open'); bRooms.classList.toggle('on', roomsPanel.classList.contains('open')); };
const HOWTO = isTouch
  ? 'Arrastra con un dedo para mirar · usa el <b>joystick</b> para caminar · toca el piso para ir hasta ahí'
  : 'Arrastra con el mouse para mirar · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> o flechas para caminar (<kbd>Shift</kbd> más rápido) · clic en el piso para ir hasta ahí';
document.getElementById('howto').innerHTML = HOWTO;
document.getElementById('b-help').onclick = () => hint(HOWTO, 7000);
const hintEl = document.getElementById('hint'); let hintT = 0;
function hint(html, ms = 3500) {
  clearTimeout(hintT);
  if (!html) { hintEl.classList.add('hide'); return; }
  hintEl.innerHTML = html; hintEl.classList.remove('hide');
  hintT = setTimeout(() => hintEl.classList.add('hide'), ms);
}

// ------------------------------------------------------------------ puertas
function roomAt(x, y) {
  let best = null;
  for (const r of plan.rooms) if (inPoly(x, y, r.pts) && (!best || r.area < best.area)) best = r;
  return best;
}
for (const d of doors) d.room = roomAt(d.c[0] + d.n[0] * 0.6, d.c[1] + d.n[1] * 0.6);   // espacio donde queda la hoja abierta
function updateDoors(dt) {
  const px = player.x, py = -player.z;
  const fx = -Math.sin(player.yaw), fy = Math.cos(player.yaw);       // hacia dónde se mira, en el plano
  const ahead = [walkTarget, ...(walkPath || []).slice(0, 2)].filter(Boolean);
  for (const d of doors) {
    let close = false;
    if (!doll && d.room) {
      const dx = d.c[0] - px, dy = d.c[1] - py, dist = Math.hypot(dx, dy);
      const side = (px - d.c[0]) * d.n[0] + (py - d.c[1]) * d.n[1];
      const goingOut = (dist < 1.1 && (dx * fx + dy * fy) / (dist || 1) > 0.55)
        || ahead.some(p => Math.hypot(p.x - d.c[0], -p.y - d.c[1]) < 0.8);
      close = side > 0.3 && inPoly(px, py, d.room.pts) && !goingOut;
    }
    const goal = close ? 1 : 0;
    if (d.t === goal) continue;
    d.t = goal > d.t ? Math.min(goal, d.t + dt * 2.2) : Math.max(goal, d.t - dt * 2.6);
    const e = d.t * d.t * (3 - 2 * d.t);
    d.leafObj.rotation.y = d.close * e;
    if (d.handleObj) d.handleObj.rotation.y = d.close * e;
  }
}

// ------------------------------------------------------------------ bucle
const clock = new THREE.Clock();
const wName = document.getElementById('w-name'), wArea = document.getElementById('w-area');
let lastRoom = null;
const proj = new THREE.Vector3();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (doll) {
    orbit.update();
  } else {
    // teclado / joystick
    let f = 0, s = 0;
    if (keys.KeyW || keys.ArrowUp) f += 1;
    if (keys.KeyS || keys.ArrowDown) f -= 1;
    if (keys.KeyA) s -= 1;
    if (keys.KeyD) s += 1;
    if (keys.ArrowLeft) player.yaw += 1.6 * dt;
    if (keys.ArrowRight) player.yaw -= 1.6 * dt;
    f -= joyVec.y; s += joyVec.x;
    const sp = (keys.ShiftLeft || keys.ShiftRight ? RUN : SPEED) * dt;
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    if (f || s) {
      walkTarget = null; walkPath = null;
      const l = Math.min(1, Math.hypot(f, s));
      const n = Math.hypot(f, s) || 1;
      move((fx * f / n + -fz * s / n) * sp * l, (fz * f / n + fx * s / n) * sp * l);
    } else if (walkTarget) {
      const dx = walkTarget.x - player.x, dz = walkTarget.y - player.z, d = Math.hypot(dx, dz);
      if (d < 0.06) walkTarget = walkPath && walkPath.length ? walkPath.shift() : null;
      else {
        const step = Math.min(d, SPEED * 1.3 * dt);
        // girar suavemente hacia el destino
        const want = Math.atan2(-dx, -dz);
        let diff = ((want - player.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        player.yaw += diff * Math.min(1, dt * 4);
        if (!move(dx / d * step, dz / d * step)) { player.x += dx / d * step; player.z += dz / d * step; }   // nunca se queda trabado
      }
    }
    camera.position.set(player.x, EYE, player.z);
    camera.rotation.set(player.pitch, player.yaw, 0);
  }

  updateDoors(dt);

  // espacio actual + minimapa
  const px = doll ? orbit.target.x : player.x, py = doll ? -orbit.target.z : -player.z;
  let here = null;
  // los polígonos del plano se traslapan (la alcoba incluye su baño): gana el espacio más pequeño
  let hereI = -1;
  plan.rooms.forEach((r, i) => { if (inPoly(player.x, -player.z, r.pts) && (!here || r.area < here.area)) { here = r; hereI = i; } });
  if (here) viewRoom = null;
  else if (viewRoom || lastRoom) { here = viewRoom || lastRoom; hereI = plan.rooms.indexOf(here); }   // huecos entre polígonos
  roomEls.forEach((el, i) => el.classList.toggle('here', i === hereI));
  if (here !== lastRoom) {
    lastRoom = here;
    wName.textContent = here ? here.name : 'Porto Rosso · Apto 4';
    wArea.textContent = here ? `${fmt(here.area)} m²` : `124 m² totales · ${fmt(plan.area_total)} m² privados`;
  }
  const headDeg = -THREE.MathUtils.radToDeg(player.yaw) - 90;   // rumbo en el plano (SVG con y invertida)
  me.setAttribute('transform', `translate(${player.x} ${player.z}) rotate(${headDeg})`);

  renderer.render(scene, camera);
  for (const m of measures) {
    proj.copy(m.mid).project(camera);
    const vis = proj.z < 1;
    m.lab.style.display = vis ? '' : 'none';
    if (vis) { m.lab.style.left = (proj.x + 1) / 2 * innerWidth + 'px'; m.lab.style.top = (1 - proj.y) / 2 * innerHeight + 'px'; }
  }
  requestAnimationFrame(frame);
}

// campo de visión: al menos ~80° horizontales también con el celular en vertical
function fitCamera() {
  camera.aspect = innerWidth / innerHeight;
  const hfov = THREE.MathUtils.degToRad(82);
  const v = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / camera.aspect));
  camera.fov = THREE.MathUtils.clamp(v, 62, 100);
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
fitCamera();
addEventListener('resize', fitCamera);

// listo
await Promise.all(texPromises);
captureEnv();
loadtxt.textContent = 'Listo';
const enter = document.getElementById('enter');
enter.style.display = 'inline-block'; enter.focus();
enter.onclick = () => { document.getElementById('intro').classList.add('hide'); hint(HOWTO, 7000); };
requestAnimationFrame(frame);
