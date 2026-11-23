// Poprawiony model 3D (GLB) — np. teksturowana makieta przygotowana przez AI z „Paczki dla AI”.
// Model leży w układzie mieszkania (te same współrzędne co scena.json: Y w górę, podłoga y = 0).
// Meble z modelu (dzieci węzła „Meble”) są podpinane do brył projektu: bryła jest niewidoczna,
// a realistyczny mebel jedzie razem z nią (przesuwanie, wersje układu, kolizje działają jak dla brył).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { minAreaRect, furnitureOutline, roomToWorld, worldToRoom, pointInPolygon } from './geometry.js';
import { uid } from './model.js';
import { typeColor } from './labels.js';

// ---------- dane w projekcie ----------
/** Ustawienia poprawionego modelu (tworzy domyślne). */
export function refSettings(project) {
  const r = project.refModel || (project.refModel = {});
  if (!r.offset) r.offset = { x: 0, y: 0, z: 0, rot: 0 };
  if (!r.bind) r.bind = {};
  if (!r.show) r.show = 'model'; // 'model' | 'boxes' | 'both'
  // wygląd: pomieszczenie (ściany + podłoga + sufit) i meble — każde: 'solid' | 'transparent' | 'off'
  const def = () => ({ room: 'solid', roomOpacity: 0.4, furn: 'solid', furnOpacity: 0.5 });
  if (!r.mr || !r.mr.room) r.mr = def(); // (starsze ustawienia ściany/podłoga/sufit → nowe domyślne)
  if (!r.model || !r.model.room) r.model = def();
  if (r.cams === undefined) r.cams = false; // miejsca zdjęć (kamery) przy poprawionym modelu
  return r;
}

export function hasRefModel(project) {
  return !!(project && project.refModel && project.refModel.modelId && project.models && project.models[project.refModel.modelId]);
}

/** Dodaje plik GLB do projektu i ustawia go jako poprawiony model. */
export function addRefModelData(project, buffer, name) {
  if (!project.models) project.models = {};
  for (const id of Object.keys(project.models)) delete project.models[id]; // jeden model na projekt
  const id = uid('glb');
  project.models[id] = { data: buffer, name: name || 'model.glb', size: buffer.byteLength, addedAt: new Date().toISOString() };
  const r = refSettings(project);
  r.modelId = id;
  r.bind = {};
  return id;
}

export function removeRefModel(project) {
  delete project.models;
  delete project.refModel;
}

// ---------- wczytywanie (z pamięcią podręczną parsowania) ----------
const parsed = new Map(); // modelId -> Promise<THREE.Group>

function parseGLB(id, buffer) {
  if (!parsed.has(id)) {
    const p = new GLTFLoader().parseAsync(buffer, '').then((g) => g.scene);
    p.catch(() => parsed.delete(id));
    parsed.set(id, p);
  }
  return parsed.get(id);
}

/** Wczytuje poprawiony model projektu; zwraca nową instancję RefModel albo null. */
export async function loadRefModel(project) {
  if (!hasRefModel(project)) return null;
  const id = project.refModel.modelId;
  const m = project.models[id];
  const buf = m.data instanceof ArrayBuffer ? m.data : m.data.buffer ? m.data.buffer.slice(m.data.byteOffset, m.data.byteOffset + m.data.byteLength) : m.data;
  const scene = await parseGLB(id, buf);
  return new RefModel(scene.clone(true), id);
}

// ---------- klasyfikacja węzłów ----------
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase();
const isFurnitureGroup = (o) => /^(meble|furniture)\b/.test(plain(o.name));
const isWallNode = (o) => /^(sciana|wall)/.test(plain(o.name)) || !!(o.userData && o.userData.out);
const isCeilingNode = (o) => !!(o.userData && o.userData.ceiling) || /^(sufit|ceiling)/.test(plain(o.name));
const isFloorNode = (o) => /^(podloga|floor)/.test(plain(o.name));

/** Zgadywanie typu mebla po nazwie z modelu. */
export function guessType(name) {
  const n = plain(name);
  const rules = [
    [/dywan|rug|carpet/, 'rug'], [/kanap|sofa|naroznik/, 'couch'], [/fotel|armchair/, 'armchair'], [/krzesel|krzeslo|chair|taboret|stolek/, 'chair'],
    [/biurk|desk/, 'desk'], [/stol|table|lawa/, 'table'], [/lozk|bed/, 'bed'], [/szafa|wardrobe/, 'wardrobe'],
    [/regal|kallax|polk|shelf|wieza|biblio/, 'shelf'], [/szafk|komod|cabinet|storage|witryn/, 'storage'], [/telewiz|tv|ekran|monitor|screen/, 'screen'],
    [/lamp/, 'lamp'], [/rosl|kwiat|plant/, 'plant'], [/lodow|fridge/, 'fridge'], [/pral|washer/, 'washer'], [/kuchn|kitchen/, 'kitchen'],
  ];
  for (const [re, t] of rules) if (re.test(n)) return t;
  return 'other';
}

const _v = new THREE.Vector3();
const _inv = new THREE.Matrix4();

/** Punkty (x,z) i zakres y geometrii obiektu w układzie `frameInv` (macierz odwrotna ramki). */
function sampleObject(obj, frameInv, maxPts = 4000) {
  const pts = [];
  let y0 = Infinity, y1 = -Infinity;
  obj.updateWorldMatrix(true, true);
  const meshes = [];
  obj.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
  const total = meshes.reduce((n, m) => n + m.geometry.attributes.position.count, 0) || 1;
  const step = Math.max(1, Math.floor(total / maxPts));
  const M = new THREE.Matrix4();
  for (const m of meshes) {
    M.multiplyMatrices(frameInv, m.matrixWorld);
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += step) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(M);
      pts.push([_v.x, _v.z]);
      if (_v.y < y0) y0 = _v.y;
      if (_v.y > y1) y1 = _v.y;
    }
  }
  return { pts, y0, y1 };
}

function poseMatrix(x, y, z, rot) {
  return new THREE.Matrix4().makeRotationY(rot || 0).setPosition(x, y || 0, z);
}

/** Położenie mebla w układzie mieszkania (pokój + mebel). */
function furnitureApartmentMatrix(room, f) {
  const t = room.transform || { x: 0, z: 0, rot: 0 };
  return poseMatrix(t.x, 0, t.z, t.rot).multiply(poseMatrix(f.x, f.y || 0, f.z, f.rot));
}

function rectArea(r) { return Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]); }
function bboxOf(pts) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, z] of pts) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], z); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], z); }
  return b;
}
function iou(a, b) {
  const i = rectArea([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  const u = rectArea(a) + rectArea(b) - i;
  return u > 1e-9 ? i / u : 0;
}

export class RefModel {
  constructor(scene, modelId) {
    this.modelId = modelId;
    this.root = new THREE.Group();
    this.root.name = 'refModel';
    this.statics = new THREE.Group(); // ściany, podłoga, okna… (stoją w miejscu)
    this.pieces = new THREE.Group(); // meble (jeżdżą razem z bryłami)
    this.root.add(this.statics, this.pieces);
    this.walls = []; // { obj, out: Vector3, center: Vector3 }
    this.ceilingObjs = [];
    this.floorObjs = [];
    this.pieceList = []; // { key, name, obj, orig: Matrix4 }
    this.offset = { x: 0, y: 0, z: 0, rot: 0 };

    scene.updateMatrixWorld(true);
    const furnGroup = [];
    scene.traverse((o) => { if (o !== scene && isFurnitureGroup(o)) furnGroup.push(o); });
    const top = scene.children.length === 1 && !scene.children[0].isMesh && !isFurnitureGroup(scene.children[0]) ? scene.children[0] : scene;
    // meble: każde dziecko węzła „Meble” to jeden mebel
    const used = new Set();
    const counts = {};
    for (const g of furnGroup) {
      for (const ch of [...g.children]) {
        const name = (ch.name || 'Mebel').replace(/_/g, ' ').trim(); // GLTFExporter zamienia spacje na „_”
        counts[name] = (counts[name] || 0) + 1;
        const key = `${name}#${counts[name]}`;
        const orig = ch.matrixWorld.clone();
        this.pieces.add(ch);
        ch.matrixAutoUpdate = false;
        ch.matrix.copy(orig);
        ch.userData.refKey = key;
        ch.traverse((o) => { o.userData.refKey = key; if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        this.pieceList.push({ key, name, obj: ch, orig });
        used.add(ch);
      }
    }
    // pozostałe węzły najwyższego poziomu → części stałe
    for (const ch of [...top.children]) {
      if (used.has(ch) || isFurnitureGroup(ch)) continue;
      const m = ch.matrixWorld.clone();
      this.statics.add(ch);
      ch.matrixAutoUpdate = false;
      ch.matrix.copy(m);
      ch.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
    }
    this.statics.updateMatrixWorld(true);
    const inv = new THREE.Matrix4();
    let ceilingY = 0;
    for (const ch of this.statics.children) {
      const s = sampleObject(ch, inv, 800);
      ch.userData.refBox = s.pts.length ? { ...bboxOf(s.pts), y0: s.y0, y1: s.y1 } : null;
      if (isCeilingNode(ch) && s.pts.length) ceilingY = Math.max(ceilingY, s.y0);
    }
    if (!ceilingY) for (const ch of this.statics.children) if (ch.userData.refBox) ceilingY = Math.max(ceilingY, ch.userData.refBox.y1);
    this.ceilingY = ceilingY || 2.5;
    for (const ch of this.statics.children) {
      const b = ch.userData.refBox;
      if (isWallNode(ch)) {
        const ud = ch.userData || {};
        const center = ud.center ? new THREE.Vector3(ud.center.x, ud.center.y || 0, ud.center.z) : new THREE.Vector3(b ? (b[0] + b[2]) / 2 : 0, 0, b ? (b[1] + b[3]) / 2 : 0);
        const out = ud.out ? new THREE.Vector3(ud.out.x, 0, ud.out.z).normalize() : null;
        this.walls.push({ obj: ch, out, center });
      } else if (isCeilingNode(ch) || (b && b.y0 > this.ceilingY * 0.6)) {
        this.ceilingObjs.push(ch); // sufit i to, co z niego zwisa (lampa)
      } else if (isFloorNode(ch)) {
        this.floorObjs.push(ch);
      }
    }
    // ściany bez kierunku „na zewnątrz”: od środka modelu
    const all = bboxOf(this.walls.map((w) => [w.center.x, w.center.z]));
    const mid = new THREE.Vector3((all[0] + all[2]) / 2, 0, (all[1] + all[3]) / 2);
    for (const w of this.walls) if (!w.out) w.out = new THREE.Vector3(w.center.x - mid.x, 0, w.center.z - mid.z).normalize();
    // własne kopie materiałów: osobno pomieszczenie i meble (przezroczystość ustawiana niezależnie)
    this.roomMats = this.cloneMaterials(this.statics);
    this.furnMats = this.cloneMaterials(this.pieces);
    // obrys modelu (do sprawdzania, czy oko jest w środku)
    let bb = null;
    for (const ch of this.statics.children) {
      const b = ch.userData.refBox;
      if (!b) continue;
      bb = bb ? [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])] : [b[0], b[1], b[2], b[3]];
    }
    this.bounds = bb || [-3, -3, 3, 3];
    // „czarna skrzynka” za oknami i drzwiami: widoczna tylko tam, gdzie nie narysowano modelu (stencil)
    const pad = 2;
    const sx = this.bounds[2] - this.bounds[0] + 2 * pad, sz = this.bounds[3] - this.bounds[1] + 2 * pad;
    const shellGeo = new THREE.BoxGeometry(sx, this.ceilingY + 2 * pad, sz);
    shellGeo.translate((this.bounds[0] + this.bounds[2]) / 2, this.ceilingY / 2, (this.bounds[1] + this.bounds[3]) / 2);
    this.shell = new THREE.Mesh(shellGeo, new THREE.MeshBasicMaterial({
      color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 1, depthWrite: false,
      stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
    }));
    this.shell.renderOrder = 1; // po ścianach (także półprzezroczystych), przed etykietami i panelem
    this.shell.frustumCulled = false;
    this.shell.visible = false;
    this.statics.add(this.shell);
    this.blackout = false;
    this.look = { room: 'solid', roomOpacity: 0.4, furn: 'solid', furnOpacity: 0.5 };
    this.eye = null;
  }

  /** Kopiuje materiały w poddrzewie; zwraca listę kopii. Każda kopia zaznacza swoje piksele w stencilu. */
  cloneMaterials(root) {
    const map = new Map();
    root.traverse((o) => {
      if (!o.isMesh) return;
      const swap = (m) => {
        if (!map.has(m)) {
          const c = m.clone();
          c.userData.base = { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite };
          if (!m.transparent) {
            // szyby (przezroczyste z natury) zostawiają stencil pusty → za oknem widać czerń
            Object.assign(c, { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp });
          }
          map.set(m, c);
        }
        return map.get(m);
      };
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
    return [...map.values()];
  }

  /** Czerń za oknami i drzwiami zamiast obrazu z kamer (MR i spacer w AR). */
  setBlackout(on) {
    this.blackout = !!on;
    this.updateCutaway(this.eye);
  }

  /** Przesunięcie całego modelu (gdy model AI nie leży dokładnie w układzie projektu). */
  setOffset(o) {
    this.offset = { x: 0, y: 0, z: 0, rot: 0, ...(o || {}) };
    const O = poseMatrix(this.offset.x, this.offset.y, this.offset.z, this.offset.rot);
    this.statics.matrixAutoUpdate = false;
    this.statics.matrix.copy(O);
    this.offsetMatrix = O;
    // środki i kierunki ścian w układzie mieszkania
    for (const w of this.walls) {
      w.c = w.center.clone().applyMatrix4(O);
      w.o = w.out.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.offset.rot);
    }
    this.statics.updateMatrixWorld(true);
  }

  /** Wygląd: { room: 'solid'|'transparent'|'off', roomOpacity, furn: 'solid'|'transparent'|'off', furnOpacity } */
  setLook(look) {
    const l = { ...this.look, ...(look || {}) };
    if (!l.room) l.room = 'solid';
    if (!l.furn) l.furn = 'solid';
    this.look = l;
    const apply = (mats, op, keepDepth) => {
      for (const m of mats) {
        const b = m.userData.base;
        m.transparent = op < 1 || b.transparent;
        m.opacity = op < 1 ? b.opacity * op : b.opacity;
        // meble półprzezroczyste zapisują głębię: widać „ducha” mebla bez jego wnętrza
        m.depthWrite = op < 1 ? keepDepth : b.depthWrite;
        m.needsUpdate = true;
      }
    };
    apply(this.roomMats, l.room === 'transparent' ? l.roomOpacity : 1, false);
    apply(this.furnMats, l.furn === 'transparent' ? l.furnOpacity : 1, true);
    this.pieces.visible = l.furn !== 'off';
    this.updateCutaway(this.eye);
  }

  /**
   * Przekrój jak w domku dla lalek: ściany, przed którymi stoi oko, i sufit (gdy oko jest nad nim) znikają.
   * eye — pozycja oka w układzie mieszkania (Vector3) albo null.
   */
  updateCutaway(eye) {
    this.eye = eye ? eye.clone() : null;
    const off = this.look.room === 'off';
    for (const ch of this.statics.children) if (ch !== this.shell) ch.visible = !off;
    if (off) { this.shell.visible = false; return; }
    for (const w of this.walls) {
      let vis = true;
      if (eye && w.c) vis = _v.subVectors(eye, w.c).setY(0).dot(w.o) <= 0.05;
      w.obj.visible = vis;
    }
    const top = this.ceilingY + (this.offset.y || 0);
    const ceilVis = !(eye && eye.y > top - 0.05);
    for (const o of this.ceilingObjs) o.visible = ceilVis;
    // czerń za otworami tylko wtedy, gdy oko jest w środku modelu (nie na makiecie)
    let inside = false;
    if (eye) {
      const loc = _v.copy(eye).applyMatrix4(_inv.copy(this.offsetMatrix || _inv.identity()).invert());
      const b = this.bounds;
      inside = loc.x > b[0] && loc.x < b[2] && loc.z > b[1] && loc.z < b[3] && loc.y < top;
    }
    this.shell.visible = this.blackout && inside;
  }

  // ---------- meble ----------
  /** Ramka i obrys (w układzie mieszkania) mebla z modelu w położeniu oryginalnym. */
  pieceFootprint(p) {
    const O = this.offsetMatrix || new THREE.Matrix4();
    // geometria mebla względem jego węzła → do mieszkania: O · orig
    const base = new THREE.Matrix4().multiplyMatrices(O, p.orig);
    const saved = p.obj.matrix.clone();
    p.obj.matrix.copy(base);
    p.obj.matrixWorldNeedsUpdate = true;
    const parentInv = new THREE.Matrix4();
    if (this.pieces.parent) { this.pieces.updateWorldMatrix(true, false); parentInv.copy(this.pieces.matrixWorld).invert(); }
    const s = sampleObject(p.obj, parentInv);
    p.obj.matrix.copy(saved);
    p.obj.matrixWorldNeedsUpdate = true;
    return s;
  }

  /**
   * Łączy meble z modelu z bryłami projektu (po pokrywaniu się rzutów i nazwie).
   * Meble bez pary dostają nową bryłę. Zwraca { matched, created }.
   */
  autoBind(project, settings) {
    const furn = [];
    for (const room of project.rooms) for (const f of room.furniture) {
      const poly = furnitureOutline(f).map((p) => roomToWorld(room, p));
      furn.push({ room, f, box: bboxOf(poly), y0: f.y || 0, y1: (f.y || 0) + f.h });
    }
    const pieces = this.pieceList.map((p) => {
      const s = this.pieceFootprint(p);
      return { p, s, box: bboxOf(s.pts) };
    }).filter((x) => x.s.pts.length);
    const cand = [];
    for (const x of pieces) for (const c of furn) {
      const yo = Math.min(x.s.y1, c.y1) - Math.max(x.s.y0, c.y0);
      if (yo <= 0.02) continue;
      let score = iou(x.box, c.box);
      if (score < 0.12) continue;
      if (guessType(x.p.name) === c.f.type) score += 0.25;
      cand.push({ x, c, score });
    }
    cand.sort((a, b) => b.score - a.score);
    const usedP = new Set(), usedF = new Set();
    settings.bind = {};
    let matched = 0, created = 0;
    for (const { x, c } of cand) {
      if (usedP.has(x.p.key) || usedF.has(c.f.id)) continue;
      usedP.add(x.p.key); usedF.add(c.f.id);
      settings.bind[x.p.key] = { fid: c.f.id, base: this.apartmentPose(c.room, c.f) };
      matched++;
    }
    for (const x of pieces) {
      if (usedP.has(x.p.key)) continue;
      const r = minAreaRect(x.s.pts);
      const center = [r.x, r.z];
      const room = project.rooms.find((rm) => rm.outline && rm.outline.length >= 3 && pointInPolygon(worldToRoom(rm, center), rm.outline))
        || project.rooms.slice().sort((a, b) => dist2(worldToRoom(a, center)) - dist2(worldToRoom(b, center)))[0];
      if (!room) continue;
      const t = room.transform || { x: 0, z: 0, rot: 0 };
      const local = worldToRoom(room, center);
      const type = guessType(x.p.name);
      const f = makeBox({
        name: x.p.name, type, x: local[0], z: local[1], y: Math.max(0, x.s.y0), rot: r.rot - t.rot,
        w: Math.max(0.03, r.w), d: Math.max(0.03, r.d), h: Math.max(0.01, x.s.y1 - Math.max(0, x.s.y0)),
      });
      room.furniture.push(f);
      // nowa bryła trafia też do pozostałych wersji układu (mebel z modelu stoi w każdej)
      for (const v of project.variants || []) {
        if (v.id !== project.activeVariantId && v.furniture && v.furniture[room.id]) v.furniture[room.id].push(JSON.parse(JSON.stringify(f)));
      }
      settings.bind[x.p.key] = { fid: f.id, base: this.apartmentPose(room, f) };
      created++;
    }
    return { matched, created };
  }

  apartmentPose(room, f) {
    const t = room.transform || { x: 0, z: 0, rot: 0 };
    const p = roomToWorld(room, [f.x, f.z]);
    return { x: p[0], z: p[1], y: f.y || 0, rot: (f.rot || 0) + t.rot };
  }

  /** Ustawia meble modelu według brył projektu (aktywna wersja układu). */
  sync(project, settings) {
    const byId = new Map();
    for (const room of project.rooms) for (const f of room.furniture) byId.set(f.id, { room, f });
    this.binding = settings.bind || {};
    this.byFid = new Map();
    for (const p of this.pieceList) {
      const b = this.binding[p.key];
      const hit = b && byId.get(b.fid);
      if (b && hit) this.byFid.set(b.fid, p);
      this.placePiece(p, hit ? hit.room : null, hit ? hit.f : null, b);
    }
  }

  placePiece(p, room, f, b) {
    const O = this.offsetMatrix || new THREE.Matrix4();
    if (!b) { p.obj.visible = true; p.obj.matrix.multiplyMatrices(O, p.orig); p.obj.matrixWorldNeedsUpdate = true; return; }
    if (!f || f.hidden) { p.obj.visible = false; return; }
    p.obj.visible = true;
    const cur = furnitureApartmentMatrix(room, f);
    const base = poseMatrix(b.base.x, b.base.y, b.base.z, b.base.rot);
    p.obj.matrix.copy(cur).multiply(base.invert()).multiply(O).multiply(p.orig);
    p.obj.matrixWorldNeedsUpdate = true;
  }

  /** Szybka aktualizacja jednego mebla (podczas przeciągania). */
  updateFor(room, f) {
    const p = this.byFid && this.byFid.get(f.id);
    if (p) this.placePiece(p, room, f, this.binding[p.key]);
  }

  /** Klucz mebla z modelu podpiętego do bryły (albo null). */
  pieceOf(fid) {
    const p = this.byFid && this.byFid.get(fid);
    return p ? p.key : null;
  }

  pieceNames() {
    return this.pieceList.map((p) => ({ key: p.key, name: p.name }));
  }
}

function dist2(p) { return p[0] * p[0] + p[1] * p[1]; }

/** Nowa bryła dla mebla z modelu (bez importu model.js → brak cyklu). */
function makeBox(p) {
  return {
    id: uid('f'), name: p.name, type: p.type, shape: 'box', x: p.x, z: p.z, y: p.y, rot: p.rot, w: p.w, d: p.d, h: p.h,
    color: typeColor(p.type), hidden: false, verified: true, notes: 'Dodano z poprawionego modelu.', scanned: null, sourceLabel: 'model', photos: [], link: '', fromModel: true,
  };
}

/** Przypina mebel z modelu do konkretnej bryły (ręczna zmiana pary na PC). */
export function bindPiece(project, refModel, key, fid) {
  const s = refSettings(project);
  for (const k of Object.keys(s.bind)) if (s.bind[k].fid === fid) delete s.bind[k];
  if (!key) return;
  let hit = null;
  for (const room of project.rooms) for (const f of room.furniture) if (f.id === fid) hit = { room, f };
  if (!hit) return;
  // nowa para: mebel z modelu w swoim oryginalnym miejscu odpowiada obecnemu położeniu bryły
  s.bind[key] = { fid, base: refModel.apartmentPose(hit.room, hit.f) };
}
