// Model danych: projekt (mieszkanie) -> pomieszczenia -> meble / otwory.
import { FURNITURE_TYPES, typeName, typeColor } from './labels.js';
import { ensurePositive, polygonArea, furnitureOutline, minAreaRect, roomToWorld, worldToRoom } from './geometry.js';

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
  };
  if (f.shape === 'L') {
    f.aw = props.aw ?? Math.min(0.9, f.w / 2);
    f.ad = props.ad ?? Math.min(0.9, f.d / 2);
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

/**
 * Scala kilka mebli w jeden (np. gdy skaner rozpoznał jeden mebel jako dwie bryły).
 * Wynik: prostopadłościan obejmujący wszystkie bryły, w pokoju pierwszego mebla.
 * Zwraca nowy mebel albo null.
 */
export function mergeFurniture(project, ids) {
  const items = ids.map((id) => findFurniture(project, id)).filter(Boolean);
  if (items.length < 2) return null;
  const target = items[0].room;
  const pts = [];
  let y0 = Infinity, y1 = -Infinity;
  for (const { room, f } of items) {
    for (const p of furnitureOutline(f)) pts.push(worldToRoom(target, roomToWorld(room, p)));
    y0 = Math.min(y0, f.y || 0);
    y1 = Math.max(y1, (f.y || 0) + f.h);
  }
  const r = minAreaRect(pts);
  // typ i nazwa po największej bryle
  const main = items.reduce((a, b) => (a.f.w * a.f.d * a.f.h >= b.f.w * b.f.d * b.f.h ? a : b)).f;
  const merged = createFurniture({
    type: main.type,
    name: main.name,
    color: main.color,
    x: r.x, z: r.z, y: y0 < 0.03 ? 0 : y0, rot: r.rot,
    w: Math.max(0.02, r.w), d: Math.max(0.02, r.d), h: y1 - (y0 < 0.03 ? 0 : y0),
    verified: items.some((it) => it.f.verified),
    notes: items.map((it) => it.f.notes).filter(Boolean).join('\n'),
    sourceLabel: items.map((it) => it.f.sourceLabel).filter(Boolean).join(' + ') || null,
  });
  merged.scanned = snapshotScanned(merged);
  for (const { room, f } of items) room.furniture = room.furniture.filter((x) => x.id !== f.id);
  target.furniture.push(merged);
  return merged;
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
  return {
    format: 'hause-scanner',
    ...project,
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
  p.version = MODEL_VERSION;
  return p;
}

// ---------- historia (cofnij / ponów) ----------
// Migawki bez siatek skanu (są duże i nie zmieniają się podczas edycji).
function snapshot(project) {
  return JSON.stringify(project, (k, v) => (k === 'mesh' ? undefined : v));
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
