// Model danych: projekt (mieszkanie) -> pomieszczenia -> meble / otwory.
import { FURNITURE_TYPES, typeName, typeColor } from './labels.js';
import { ensurePositive, polygonArea, openingSegment, furnitureOutlines, minAreaRect, roomToWorld, worldToRoom, localToWorld, worldToLocal, normalizeAngle } from './geometry.js';

export const MODEL_VERSION = 1;

export function uid(prefix = 'id') {
  const r = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${r}`;
}

export function createProject(name = 'Moje mieszkanie') {
  const now = new Date().toISOString();
  return { id: uid('prj'), name, version: MODEL_VERSION, createdAt: now, updatedAt: now, rooms: [] };
}

export function createRoom(props = {}) {
  return {
    id: uid('room'),
    name: props.name || 'Pokój',
    transform: { x: 0, z: 0, rot: 0, ...(props.transform || {}) },
    height: props.height ?? 2.6,
    outline: ensurePositive(props.outline || [[-2, -1.5], [2, -1.5], [2, 1.5], [-2, 1.5]]),
    openings: props.openings || [],
    furniture: props.furniture || [],
    // korekta wyrównania w MR (względem podłogi ze Space Setup)
    xrAlign: { x: 0, z: 0, rot: 0, ...(props.xrAlign || {}) },
    scan: props.scan || { source: 'manual', capturedAt: new Date().toISOString() },
  };
}

export function createFurniture(props = {}) {
  const type = props.type || 'other';
  const def = FURNITURE_TYPES[type] || FURNITURE_TYPES.other;
  const f = {
    id: uid('f'),
    name: props.name || typeName(type),
    type,
    shape: props.shape || 'box',
    x: props.x ?? 0,
    z: props.z ?? 0,
    y: props.y ?? 0,
    rot: props.rot ?? 0,
    w: props.w ?? def.size[0],
    d: props.d ?? def.size[1],
    h: props.h ?? def.size[2],
    color: props.color || typeColor(type),
    hidden: !!props.hidden,
    verified: props.verified ?? true,
    notes: props.notes || '',
    scanned: props.scanned || null,
    sourceLabel: props.sourceLabel || null,
    photos: Array.isArray(props.photos) ? props.photos.slice() : [],
    link: props.link || '',
  };
  if (f.shape === 'L') {
    f.aw = props.aw ?? Math.min(0.9, f.w / 2);
    f.ad = props.ad ?? Math.min(0.9, f.d / 2);
  }
  if (props.display) f.display = props.display;
  if (props.fromScan) f.fromScan = true;
  if (props.fromModel) f.fromModel = true;
  if (f.shape === 'compound') {
    f.parts = (props.parts || []).map((p) => ({ ...p }));
    if (!f.parts.length) f.shape = 'box';
  }
  return f;
}

export function createOpening(props = {}) {
  const type = props.type || 'door';
  return {
    id: uid('op'),
    type,
    edge: props.edge ?? 0,
    offset: props.offset ?? 0.3,
    width: props.width ?? (type === 'door' ? 0.9 : 1.2),
    height: props.height ?? (type === 'door' ? 2.05 : 1.4),
    sill: props.sill ?? (type === 'door' ? 0 : 0.85),
    swing: props.swing ?? (type === 'door' ? 'in' : 'none'),
  };
}

/** Kopia stanu pozycji z chwili skanu — pozwala wrócić do oryginału i pokazać „ducha”. */
export function snapshotScanned(f) {
  return { x: f.x, z: f.z, y: f.y, rot: f.rot, w: f.w, d: f.d, h: f.h };
}

export function findFurniture(project, id) {
  for (const room of project.rooms) {
    const f = room.furniture.find((x) => x.id === id);
    if (f) return { room, f };
  }
  return null;
}

/** Części mebla w układzie pokoju (proste bryły: box / L / cylinder). */
function partsInRoom(f) {
  if (f.shape === 'compound' && Array.isArray(f.parts) && f.parts.length) {
    return f.parts.map((p) => {
      const [x, z] = localToWorld(f, p.x, p.z);
      return { ...p, x, z, rot: normalizeAngle((p.rot || 0) + (f.rot || 0)), y: (f.y || 0) + (p.y || 0) };
    });
  }
  const { shape, w, d, h, aw, ad, x, z, rot } = f;
  return [{ shape: shape || 'box', w, d, h, aw, ad, x, z, rot: rot || 0, y: f.y || 0 }];
}

/** Przelicza część z układu pokoju `from` do układu pokoju `to`. */
function partToRoom(p, from, to) {
  if (from === to) return { ...p };
  const [x, z] = worldToRoom(to, roomToWorld(from, [p.x, p.z]));
  return { ...p, x, z, rot: normalizeAngle(p.rot + (from.transform.rot || 0) - (to.transform.rot || 0)) };
}

/**
 * Scala kilka mebli w jeden obiekt o kształcie złożonym (suma brył, jak sumowanie boolowskie):
 * każda bryła zachowuje swój kształt, położenie i wysokość, a całość przesuwa się i obraca razem.
 * Wynik trafia do pokoju pierwszego mebla. Zwraca nowy mebel albo null.
 */
export function mergeFurniture(project, ids) {
  const items = ids.map((id) => findFurniture(project, id)).filter(Boolean);
  if (items.length < 2) return null;
  const target = items[0].room;
  const parts = items.flatMap(({ room, f }) => partsInRoom(f).map((p) => partToRoom(p, room, target)));
  // układ nowego mebla: prostokąt obejmujący wszystkie części
  const pts = parts.flatMap((p) => furnitureOutlines(p).flat());
  const r = minAreaRect(pts);
  const y0 = Math.min(...parts.map((p) => p.y));
  const y1 = Math.max(...parts.map((p) => p.y + p.h));
  const frame = { x: r.x, z: r.z, rot: r.rot };
  const localParts = parts.map((p) => {
    const [lx, lz] = worldToLocal(frame, p.x, p.z);
    const out = { shape: p.shape, x: lx, z: lz, y: p.y - y0, rot: normalizeAngle(p.rot - frame.rot), w: p.w, d: p.d, h: p.h };
    if (p.shape === 'L') { out.aw = p.aw; out.ad = p.ad; }
    return out;
  });
  const main = items.reduce((a, b) => (a.f.w * a.f.d * a.f.h >= b.f.w * b.f.d * b.f.h ? a : b)).f;
  const merged = createFurniture({
    type: main.type,
    name: main.name,
    color: main.color,
    shape: 'compound',
    parts: localParts,
    x: r.x, z: r.z, y: y0, rot: r.rot,
    w: Math.max(0.02, r.w), d: Math.max(0.02, r.d), h: y1 - y0,
    verified: items.some((it) => it.f.verified),
    notes: items.map((it) => it.f.notes).filter(Boolean).join('\n'),
    sourceLabel: items.map((it) => it.f.sourceLabel).filter(Boolean).join(' + ') || null,
  });
  merged.scanned = snapshotScanned(merged);
  for (const { room, f } of items) room.furniture = room.furniture.filter((x) => x.id !== f.id);
  target.furniture.push(merged);
  return merged;
}

/** Rozdziela mebel złożony z powrotem na osobne bryły. Zwraca listę nowych mebli. */
export function splitFurniture(project, id) {
  const found = findFurniture(project, id);
  if (!found || found.f.shape !== 'compound') return [];
  const { room, f } = found;
  const out = partsInRoom(f).map((p, i) => {
    const nf = createFurniture({
      type: f.type, name: `${f.name} ${i + 1}`, color: f.color, shape: p.shape,
      x: p.x, z: p.z, y: p.y, rot: p.rot, w: p.w, d: p.d, h: p.h, aw: p.aw, ad: p.ad, verified: f.verified,
    });
    nf.scanned = snapshotScanned(nf);
    return nf;
  });
  room.furniture = room.furniture.filter((x) => x.id !== id).concat(out);
  return out;
}

/** Zmiana wymiaru (w / d / h) z proporcjonalnym skalowaniem części mebla złożonego. */
export function resizeFurniture(f, key, value) {
  value = Math.max(0.02, value);
  if (f.shape === 'compound' && Array.isArray(f.parts) && f[key] > 0) {
    const r = value / f[key];
    for (const p of f.parts) {
      const q = Math.round(normalizeAngle(p.rot || 0) / (Math.PI / 2));
      const swapped = Math.abs(q) % 2 === 1;
      if (key === 'h') { p.y *= r; p.h *= r; continue; }
      if (key === 'w') p.x *= r; else p.z *= r;
      const dimKey = (key === 'w') !== swapped ? 'w' : 'd';
      p[dimKey] *= r;
      if (p.shape === 'L') { if (dimKey === 'w') p.aw *= r; else p.ad *= r; }
    }
  }
  if (f.shape === 'cylinder' && key === 'w' && Math.abs(f.w - f.d) < 1e-6) f.d = value;
  f[key] = value;
}

// ---------- wersje układu (alternatywne przemeblowania) ----------
function cloneFurnitureList(list) {
  return JSON.parse(JSON.stringify(list || []));
}

/** Zapewnia listę wersji; pierwsza to bieżący układ. */
export function ensureVariants(project) {
  if (!Array.isArray(project.variants) || !project.variants.length) {
    const id = uid('var');
    project.variants = [{ id, name: 'Stan obecny', createdAt: new Date().toISOString(), furniture: {} }];
    project.activeVariantId = id;
  }
  if (!project.variants.some((v) => v.id === project.activeVariantId)) project.activeVariantId = project.variants[0].id;
  return project.variants;
}

export function activeVariant(project) {
  ensureVariants(project);
  return project.variants.find((v) => v.id === project.activeVariantId);
}

/** Zapamiętuje meble z pokoi w aktywnej wersji. */
export function storeActiveVariant(project) {
  const v = activeVariant(project);
  v.furniture = {};
  for (const r of project.rooms) v.furniture[r.id] = cloneFurnitureList(r.furniture);
  v.updatedAt = new Date().toISOString();
}

export function switchVariant(project, id) {
  ensureVariants(project);
  const target = project.variants.find((v) => v.id === id);
  if (!target || id === project.activeVariantId) return false;
  storeActiveVariant(project);
  for (const r of project.rooms) {
    // pokój dodany po utworzeniu wersji: zostaje z bieżącymi meblami
    if (target.furniture && target.furniture[r.id]) r.furniture = cloneFurnitureList(target.furniture[r.id]);
  }
  project.activeVariantId = id;
  return true;
}

/** Nowa wersja jako kopia bieżącego układu; od razu staje się aktywna. */
export function createVariant(project, name) {
  ensureVariants(project);
  storeActiveVariant(project);
  const v = { id: uid('var'), name: name || `Wersja ${project.variants.length + 1}`, createdAt: new Date().toISOString(), furniture: {} };
  for (const r of project.rooms) v.furniture[r.id] = cloneFurnitureList(r.furniture);
  project.variants.push(v);
  project.activeVariantId = v.id;
  return v;
}

export function deleteVariant(project, id) {
  ensureVariants(project);
  if (project.variants.length <= 1) return false;
  if (id === project.activeVariantId) {
    const other = project.variants.find((v) => v.id !== id);
    switchVariant(project, other.id);
  }
  project.variants = project.variants.filter((v) => v.id !== id);
  return true;
}

// ---------- zdjęcia i kamery ----------
/** Dodaje zdjęcie (data URL) do wspólnej bazy projektu. Zwraca id. */
export function addMedia(project, data, meta = {}) {
  if (!project.media) project.media = {};
  const id = uid('img');
  project.media[id] = { data, name: meta.name || 'zdjecie.jpg', w: meta.w || 0, h: meta.h || 0, addedAt: new Date().toISOString() };
  return id;
}

/** Kamera = miejsce i kierunek, z którego zrobiono zdjęcie (układ mieszkania, metry). */
export function createCamera(props = {}) {
  return {
    id: uid('cam'),
    name: props.name || 'Zdjęcie',
    mediaId: props.mediaId || null,
    pos: props.pos || [0, 1.5, 0],
    target: props.target || [0, 1.2, -2],
    fov: props.fov || 55,
    aspect: props.aspect || 4 / 3,
    notes: props.notes || '',
  };
}

/** Usuwa zdjęcia, do których nic się już nie odwołuje (wszystkie wersje układu i kamery). */
export function pruneMedia(project) {
  if (!project.media) return 0;
  const used = new Set();
  const scanF = (list) => (list || []).forEach((f) => (f.photos || []).forEach((id) => used.add(id)));
  project.rooms.forEach((r) => scanF(r.furniture));
  (project.variants || []).forEach((v) => Object.values(v.furniture || {}).forEach(scanF));
  (project.cameras || []).forEach((c) => c.mediaId && used.add(c.mediaId));
  let n = 0;
  for (const id of Object.keys(project.media)) if (!used.has(id)) { delete project.media[id]; n++; }
  return n;
}

// ---------- łączenie pokoi przez drzwi ----------
function rotVec(v, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c];
}

/** Środek drzwi i normalna na zewnątrz pokoju (w układzie pokoju). */
function doorFrame(room, op) {
  const { p0, p1, edge } = openingSegment(room.outline, op);
  return { c: [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2], out: [-edge.inward[0], -edge.inward[1]] };
}

/**
 * Łączy drzwi opA (pokój A, nieruchomy) z drzwiami opB (pokój B — przesuwany i obracany),
 * tak żeby były naprzeciw siebie po dwóch stronach ściany o grubości `wall` [m].
 */
export function linkDoors(project, roomAId, opAId, roomBId, opBId, wall = 0.12) {
  const A = project.rooms.find((r) => r.id === roomAId), B = project.rooms.find((r) => r.id === roomBId);
  if (!A || !B || A === B) return false;
  const opA = A.openings.find((o) => o.id === opAId), opB = B.openings.find((o) => o.id === opBId);
  if (!opA || !opB) return false;
  const fa = doorFrame(A, opA), fb = doorFrame(B, opB);
  const cA = roomToWorld(A, fa.c);
  const nA = rotVec(fa.out, A.transform.rot || 0);
  const target = [cA[0] + nA[0] * wall, cA[1] + nA[1] * wall];
  // obrót B: jego normalna na zewnątrz ma wskazywać przeciwnie do normalnej A
  const phi = (v) => Math.atan2(v[1], v[0]);
  const rot = normalizeAngle(phi(fb.out) - phi([-nA[0], -nA[1]]));
  const cb = rotVec(fb.c, rot);
  B.transform = { x: target[0] - cb[0], z: target[1] - cb[1], rot };
  unlinkDoor(project, roomAId, opAId);
  unlinkDoor(project, roomBId, opBId);
  opA.link = { roomId: B.id, openingId: opB.id, wall };
  opB.link = { roomId: A.id, openingId: opA.id, wall };
  return true;
}

export function unlinkDoor(project, roomId, opId) {
  const room = project.rooms.find((r) => r.id === roomId);
  const op = room && room.openings.find((o) => o.id === opId);
  if (!op || !op.link) return;
  const other = project.rooms.find((r) => r.id === op.link.roomId);
  const oop = other && other.openings.find((o) => o.id === op.link.openingId);
  if (oop) delete oop.link;
  delete op.link;
}

export function touch(project) {
  project.updatedAt = new Date().toISOString();
}

// ---------- serializacja ----------
function toBase64(typed) {
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

function fromBase64(b64, Ctor) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Ctor(bytes.buffer);
}

/** Projekt -> obiekt gotowy do JSON.stringify (siatki jako base64). */
export function projectToJSON(project, { includeMesh = true } = {}) {
  const models = {};
  if (includeMesh && project.models) {
    for (const [id, m] of Object.entries(project.models)) models[id] = { ...m, data: toBase64(ArrayBuffer.isView(m.data) ? m.data : new Uint8Array(m.data)) };
  }
  return {
    format: 'hause-scanner',
    ...project,
    models,
    rooms: project.rooms.map((r) => {
      const scan = { ...r.scan };
      if (scan.mesh && includeMesh) {
        scan.mesh = { positions: toBase64(scan.mesh.positions), indices: toBase64(scan.mesh.indices) };
      } else {
        delete scan.mesh;
      }
      return { ...r, scan };
    }),
  };
}

export function projectFromJSON(obj) {
  if (!obj || !Array.isArray(obj.rooms)) throw new Error('To nie jest plik projektu Hause Scanner.');
  const p = { ...obj };
  delete p.format;
  p.rooms = obj.rooms.map((r) => {
    const room = createRoom({ ...r });
    room.id = r.id || room.id;
    room.furniture = (r.furniture || []).map((f) => ({ ...createFurniture(f), id: f.id || uid('f') }));
    room.openings = (r.openings || []).map((o) => ({ ...createOpening(o), id: o.id || uid('op') }));
    if (r.scan && r.scan.mesh && typeof r.scan.mesh.positions === 'string') {
      room.scan = { ...r.scan, mesh: { positions: fromBase64(r.scan.mesh.positions, Float32Array), indices: fromBase64(r.scan.mesh.indices, Uint32Array) } };
    }
    return room;
  });
  if (obj.models) {
    p.models = {};
    for (const [id, m] of Object.entries(obj.models)) if (typeof m.data === 'string') p.models[id] = { ...m, data: fromBase64(m.data, Uint8Array).buffer };
  }
  p.version = MODEL_VERSION;
  return p;
}

// ---------- historia (cofnij / ponów) ----------
// Migawki bez siatek skanu (są duże i nie zmieniają się podczas edycji).
function snapshot(project) {
  return JSON.stringify(project, (k, v) => (k === 'mesh' || k === 'media' || k === 'models' ? undefined : v));
}

export class History {
  constructor(project, limit = 100) {
    this.limit = limit;
    this.reset(project);
  }
  reset(project) {
    this.undoStack = [];
    this.redoStack = [];
    this.current = snapshot(project);
  }
  /** Wywołaj PO zmianie projektu. */
  commit(project) {
    const s = snapshot(project);
    if (s === this.current) return false;
    this.undoStack.push(this.current);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.current = s;
    return true;
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  undo(project) { return this._move(project, this.undoStack, this.redoStack); }
  redo(project) { return this._move(project, this.redoStack, this.undoStack); }
  _move(project, from, to) {
    if (!from.length) return null;
    to.push(this.current);
    this.current = from.pop();
    const restored = JSON.parse(this.current);
    // przywróć siatki skanu z bieżącego projektu
    const meshes = new Map(project.rooms.map((r) => [r.id, r.scan && r.scan.mesh]));
    for (const r of restored.rooms) if (meshes.get(r.id)) r.scan.mesh = meshes.get(r.id);
    restored.media = project.media || {}; // zdjęcia nie są cofane (duże dane)
    if (project.models) restored.models = project.models; // poprawiony model GLB też nie
    return restored;
  }
}

// ---------- pokój demonstracyjny ----------
export function createDemoProject() {
  const p = createProject('Demo — mieszkanie');
  const living = createRoom({
    name: 'Salon',
    height: 2.65,
    outline: [[0, 0], [5.2, 0], [5.2, 4.1], [2.4, 4.1], [2.4, 3.2], [0, 3.2]],
    scan: { source: 'demo', capturedAt: new Date().toISOString() },
  });
  living.openings.push(createOpening({ type: 'door', edge: 3, offset: 0.0, width: 0.9 }));
  living.openings.push(createOpening({ type: 'window', edge: 1, offset: 1.0, width: 1.8 }));
  living.openings.push(createOpening({ type: 'window', edge: 0, offset: 1.5, width: 1.4 }));
  const add = (room, props, verified = true) => {
    const f = createFurniture({ ...props, verified });
    f.scanned = snapshotScanned(f);
    room.furniture.push(f);
    return f;
  };
  add(living, { type: 'couch', shape: 'L', x: 1.35, z: 1.0, w: 2.5, d: 1.6, aw: 0.9, ad: 0.9, h: 0.85, rot: 0 });
  add(living, { type: 'table', x: 4.2, z: 2.6, w: 1.4, d: 0.85, h: 0.76, rot: Math.PI / 2 });
  add(living, { type: 'storage', name: 'Szafka RTV', x: 2.6, z: 3.0, w: 1.6, d: 0.4, h: 0.5, rot: 0 });
  add(living, { type: 'screen', x: 2.6, z: 3.12, y: 0.5, w: 1.25, d: 0.08, h: 0.72, rot: 0 });
  add(living, { type: 'plant', shape: 'cylinder', x: 4.9, z: 0.3, w: 0.45, d: 0.45, h: 1.2 });
  add(living, { type: 'other', name: 'Karton (tymczasowo)', x: 3.4, z: 1.0, w: 0.6, d: 0.5, h: 0.5, rot: 0.3 }, false);

  const bed = createRoom({
    name: 'Sypialnia',
    height: 2.65,
    outline: [[0, 0], [3.4, 0], [3.4, 3.6], [0, 3.6]],
    transform: { x: 5.32, z: 0, rot: 0 },
    scan: { source: 'demo', capturedAt: new Date().toISOString() },
  });
  bed.openings.push(createOpening({ type: 'door', edge: 3, offset: 0.3, width: 0.8 }));
  bed.openings.push(createOpening({ type: 'window', edge: 1, offset: 1.0, width: 1.4 }));
  add(bed, { type: 'bed', x: 1.7, z: 1.05, w: 1.6, d: 2.05, h: 0.5, rot: 0 });
  add(bed, { type: 'wardrobe', x: 2.85, z: 3.28, w: 1.0, d: 0.6, h: 2.1, rot: 0 });
  add(bed, { type: 'storage', name: 'Komoda', x: 0.25, z: 1.0, w: 0.9, d: 0.45, h: 0.85, rot: Math.PI / 2 });
  p.rooms.push(living, bed);
  return p;
}

export function roomArea(room) {
  return Math.abs(polygonArea(room.outline || []));
}
