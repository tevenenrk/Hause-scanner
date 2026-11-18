// Konwersja danych sceny z Meta Quest (WebXR plane-detection + mesh-detection)
// na uproszczony model pomieszczenia: obrys, wysokość, drzwi/okna, meble jako bryłki.
// Czyste funkcje — wejście to „surowe” dane wyciągnięte z XRFrame (zob. xr/sceneCapture.js).
//
// scanData = {
//   planes: [{ label, matrix: number[16] (przestrzeń płaszczyzny -> przestrzeń referencyjna), polygon: [[x,y,z], ...] }],
//   meshes: [{ label, matrix: number[16], vertices: Float32Array (xyz), indices: Uint32Array }],
// }

import {
  ensurePositive, simplifyPolygon, polygonArea, polygonPerimeter, convexHull, minAreaRect,
  distPointSegment, edgeOf, projectT, sub, dot, cross, norm, pointInPolygon, furnitureFootprints, dist,
} from './geometry.js';
import { normalizeLabel, isStructureLabel, isDoorLabel, isWindowLabel, isWallLabel, labelToType } from './labels.js';
import { createRoom, createFurniture, createOpening, snapshotScanned } from './model.js';

// ---------- macierze 4x4 (kolumnowo, jak w WebXR) ----------
export function mat4Multiply(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/** Odwrotność macierzy sztywnej (obrót + przesunięcie). */
export function mat4InvertRigid(m) {
  const o = new Array(16).fill(0);
  // transpozycja obrotu
  o[0] = m[0]; o[1] = m[4]; o[2] = m[8];
  o[4] = m[1]; o[5] = m[5]; o[6] = m[9];
  o[8] = m[2]; o[9] = m[6]; o[10] = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  o[12] = -(o[0] * tx + o[4] * ty + o[8] * tz);
  o[13] = -(o[1] * tx + o[5] * ty + o[9] * tz);
  o[14] = -(o[2] * tx + o[6] * ty + o[10] * tz);
  o[15] = 1;
  return o;
}

export function mat4TransformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Macierz obrotu o 180° wokół X (odwrócenie płaszczyzny podłogi, gdyby normalna była w dół). */
const FLIP_X = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

/**
 * Wyznacza układ pomieszczenia z macierzy płaszczyzny podłogi: oś Y w górę (pionowo w świecie),
 * oś X wzdłuż lokalnej osi X płaszczyzny rzutowanej na poziom — odporne na drobne pochylenie.
 */
export function roomFrameFromFloor(floorMatrix) {
  let m = floorMatrix.slice();
  if (m[5] < 0) m = mat4Multiply(m, FLIP_X); // normalna (kolumna Y) skierowana w dół
  // poziomujemy: Y = (0,1,0) świata, X = rzut lokalnego X na poziom
  let xx = m[0], xz = m[2];
  const l = Math.hypot(xx, xz) || 1;
  xx /= l; xz /= l;
  // Z = X × Y (układ prawoskrętny) = (-xz, 0, xx)
  return [xx, 0, xz, 0, 0, 1, 0, 0, -xz, 0, xx, 0, m[12], m[13], m[14], 1];
}

function planePointsInRoom(plane, toRoom) {
  const m = mat4Multiply(toRoom, plane.matrix);
  return plane.polygon.map((p) => mat4TransformPoint(m, p[0], p[1] ?? 0, p[2]));
}

/** Odcinek poziomy (rzut na XZ) opisujący pionową płaszczyznę + zakres wysokości. */
function verticalPlaneSegment(points3) {
  const pts = points3.map((p) => [p[0], p[2]]);
  let best = null;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = dist(pts[i], pts[j]);
    if (!best || d > best.d) best = { d, a: pts[i], b: pts[j] };
  }
  const ys = points3.map((p) => p[1]);
  return { a: best ? best.a : pts[0], b: best ? best.b : pts[0], length: best ? best.d : 0, y0: Math.min(...ys), y1: Math.max(...ys) };
}

function planeNormalY(plane, toRoom) {
  const m = mat4Multiply(toRoom, plane.matrix);
  return Math.abs(m[5]); // składowa Y lokalnej osi Y (normalnej)
}

function meshPointsInRoom(mesh, toRoom) {
  const m = mat4Multiply(toRoom, mesh.matrix);
  const v = mesh.vertices;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    const p = mat4TransformPoint(m, v[i], v[i + 1], v[i + 2]);
    out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
  }
  return out;
}

/** Obrys z płaszczyzn ścian, gdy brak płaszczyzny podłogi: łączy kolejne ściany (posortowane kątowo) w narożnikach. */
function outlineFromWalls(walls) {
  if (walls.length < 3) {
    const pts = walls.flatMap((w) => [w.a, w.b]);
    return pts.length >= 3 ? convexHull(pts) : null;
  }
  const cx = walls.reduce((s, w) => s + (w.a[0] + w.b[0]) / 2, 0) / walls.length;
  const cz = walls.reduce((s, w) => s + (w.a[1] + w.b[1]) / 2, 0) / walls.length;
  const sorted = walls.map((w) => ({ ...w, ang: Math.atan2((w.a[1] + w.b[1]) / 2 - cz, (w.a[0] + w.b[0]) / 2 - cx) })).sort((p, q) => p.ang - q.ang);
  const corners = [];
  for (let i = 0; i < sorted.length; i++) {
    const w1 = sorted[i], w2 = sorted[(i + 1) % sorted.length];
    const r = sub(w1.b, w1.a), s = sub(w2.b, w2.a);
    const den = cross(r, s);
    if (Math.abs(den) < 1e-6) { corners.push(w1.b); continue; }
    const t = cross(sub(w2.a, w1.a), s) / den;
    corners.push([w1.a[0] + r[0] * t, w1.a[1] + r[1] * t]);
  }
  return convexHull(corners);
}

function nearestEdge(outline, center, dirSeg) {
  let best = null;
  for (let k = 0; k < outline.length; k++) {
    const e = edgeOf(outline, k);
    const d = distPointSegment(center, e.a, e.b);
    const par = Math.abs(cross(e.dir, dirSeg));
    if (par > 0.35) continue; // nierównoległe (> ~20°)
    if (!best || d < best.d) best = { k, d, e };
  }
  return best;
}

/** Odległość punktu od brzegu obrysu. */
function distToOutline(pt, outline) {
  let d = Infinity;
  for (let k = 0; k < outline.length; k++) d = Math.min(d, distPointSegment(pt, outline[k], outline[(k + 1) % outline.length]));
  return d;
}

/** Punkt należy do pokoju: wewnątrz obrysu albo najwyżej `margin` od jego brzegu. */
function inRoom(pt, outline, margin = 0.15) {
  return pointInPolygon(pt, outline) || distToOutline(pt, outline) <= margin;
}

/** Siatka wyglądająca na globalną (tysiące wierzchołków), nawet bez etykiety — bryły mebli mają ich kilka-kilkanaście. */
function isGlobalMeshLike(m) {
  return m.label === 'global mesh' || (m.vertices && m.vertices.length / 3 > 300 && !['table', 'couch', 'bed', 'desk', 'storage', 'shelf', 'screen', 'lamp', 'plant', 'chair'].includes(m.label));
}

const ORIENTATION_LABELS = new Set(['horizontal', 'vertical', 'plane', 'mesh', '']);

/** Płaszczyzny podłóg w danych sceny (każda = osobny pokój w Space Setup). */
export function listFloors(scanData) {
  const out = [];
  (scanData.planes || []).forEach((p, index) => {
    if (normalizeLabel(p.label) !== 'floor' || !p.polygon || p.polygon.length < 3) return;
    const frame = roomFrameFromFloor(p.matrix);
    const inv = mat4InvertRigid(frame);
    const m = mat4Multiply(inv, p.matrix);
    const poly = p.polygon.map((q) => { const r = mat4TransformPoint(m, q[0], q[1] ?? 0, q[2]); return [r[0], r[2]]; });
    out.push({ index, area: Math.abs(polygonArea(poly)), matrix: p.matrix, frame, polyRoom: poly });
  });
  return out;
}

/** Indeks podłogi, na której stoi punkt świata [x, z] (np. głowa użytkownika); null gdy żadna. */
export function floorAtPoint(floors, pt) {
  for (const f of floors) {
    const inv = mat4InvertRigid(f.frame);
    const q = mat4TransformPoint(inv, pt[0], 0, pt[1]);
    if (pointInPolygon([q[0], q[2]], f.polyRoom)) return f.index;
  }
  return null;
}

/**
 * Główna konwersja jednego pokoju. Zwraca { room, stats, frame }.
 * opts.floorIndex — która płaszczyzna podłogi (gdy Space Setup ma kilka pokoi);
 * opts.viewerPoint — [x, z] w świecie: wybierz pokój, w którym stoi użytkownik.
 * Elementy spoza obrysu wybranego pokoju (ściany, meble, siatka innych pokoi) są pomijane.
 */
export function convertScene(scanData, opts = {}) {
  const planes = (scanData.planes || []).map((p) => ({ ...p, label: normalizeLabel(p.label) }));
  const meshes = (scanData.meshes || []).map((m) => ({ ...m, label: normalizeLabel(m.label) }));
  const stats = { planes: planes.length, meshes: meshes.length, walls: 0, doors: 0, windows: 0, furniture: 0, warnings: [], floors: 0, skipped: 0 };

  // 1. Układ pomieszczenia = wybrana płaszczyzna podłogi
  const floorsInfo = listFloors(scanData);
  stats.floors = floorsInfo.length;
  let floorIdx = opts.floorIndex ?? null;
  if (floorIdx === null && opts.viewerPoint && floorsInfo.length) floorIdx = floorAtPoint(floorsInfo, opts.viewerPoint);
  if (floorIdx === null && floorsInfo.length) floorIdx = floorsInfo.reduce((a, b) => (b.area > a.area ? b : a)).index;
  const floor = floorIdx !== null ? planes[floorIdx] : null;
  let frame;
  if (floor) {
    frame = roomFrameFromFloor(floor.matrix);
  } else {
    stats.warnings.push('Brak płaszczyzny podłogi — układ wyznaczony z położenia ścian.');
    frame = IDENTITY.slice();
  }
  const toRoom = mat4InvertRigid(frame);

  // 2. Ściany
  let walls = planes
    .filter((p) => isWallLabel(p.label) && p.polygon && p.polygon.length >= 2)
    .map((p) => verticalPlaneSegment(planePointsInRoom(p, toRoom)))
    .filter((w) => w.length > 0.2);

  // jeśli nie było podłogi, poziom podłogi = najniższy punkt ścian
  if (!floor && walls.length) {
    const y0 = Math.min(...walls.map((w) => w.y0));
    frame[13] += y0;
    for (const w of walls) { w.y0 -= y0; w.y1 -= y0; }
  }
  const toRoom2 = mat4InvertRigid(frame);

  // 3. Obrys
  let outline = null;
  if (floor) {
    const pts = planePointsInRoom(floor, toRoom2).map((p) => [p[0], p[2]]);
    outline = simplifyPolygon(ensurePositive(pts), 0.02, 3);
  } else if (walls.length) {
    outline = outlineFromWalls(walls);
  }
  if (!outline || outline.length < 3 || Math.abs(polygonArea(outline)) < 0.5) {
    stats.warnings.push('Nie udało się wyznaczyć obrysu — wstawiono prostokąt 4×3 m do ręcznej korekty.');
    outline = [[-2, -1.5], [2, -1.5], [2, 1.5], [-2, 1.5]];
  }
  outline = ensurePositive(outline);
  const roomArea = Math.abs(polygonArea(outline));
  let maxExtent = 0;
  for (const a of outline) for (const b of outline) maxExtent = Math.max(maxExtent, dist(a, b));

  // tylko ściany tego pokoju (środek odcinka przy obrysie)
  if (floor) walls = walls.filter((w) => distToOutline([(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2], outline) < 0.4);
  stats.walls = walls.length;

  // 4. Wysokość — sufit nad tym pokojem
  let height = null;
  const centroid = outline.reduce((s, q) => [s[0] + q[0] / outline.length, s[1] + q[1] / outline.length], [0, 0]);
  const ceilings = planes.filter((p) => p.label === 'ceiling' && p.polygon && p.polygon.length >= 3).map((p) => planePointsInRoom(p, toRoom2));
  const ceil = ceilings.find((pts) => pointInPolygon(centroid, ensurePositive(pts.map((q) => [q[0], q[2]])))) || (floorsInfo.length <= 1 ? ceilings[0] : null);
  if (ceil) height = ceil.reduce((s, p) => s + p[1], 0) / ceil.length;
  if (!height || height < 1.8 || height > 6) height = walls.length ? Math.max(...walls.map((w) => w.y1)) : 2.6;
  if (!height || height < 1.8 || height > 6) height = 2.6;

  const room = createRoom({
    name: opts.name || 'Pokój',
    outline,
    height: Math.round(height * 1000) / 1000,
    scan: {
      source: opts.source || 'quest',
      capturedAt: new Date().toISOString(),
      floorArea: roomArea,
      floorPerimeter: polygonPerimeter(outline),
      hadFloorPlane: !!floor,
    },
  });

  // 5. Drzwi i okna (bez duplikatów na tej samej ścianie)
  for (const p of planes) {
    const isDoor = isDoorLabel(p.label), isWin = isWindowLabel(p.label);
    if (!isDoor && !isWin) continue;
    const seg = verticalPlaneSegment(planePointsInRoom(p, toRoom2));
    if (seg.length < 0.3) continue;
    const center = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2];
    const ne = nearestEdge(outline, center, norm(sub(seg.b, seg.a)));
    if (!ne || ne.d > 0.5) continue; // drzwi innego pokoju albo otwarte skrzydło
    const t0 = projectT(seg.a, ne.e.a, ne.e.b) * ne.e.length;
    const t1 = projectT(seg.b, ne.e.a, ne.e.b) * ne.e.length;
    let start = Math.max(0, Math.min(t0, t1));
    let end = Math.min(ne.e.length, Math.max(t0, t1));
    if (end - start < 0.3) continue;
    const type = isDoor ? 'door' : 'window';
    const dupOp = room.openings.find((o) => o.edge === ne.k && o.type === type && Math.min(o.offset + o.width, end) - Math.max(o.offset, start) > -0.1);
    if (dupOp) {
      // to samo przejście zaznaczone dwa razy — łączymy
      const s0 = Math.min(dupOp.offset, start), e0 = Math.max(dupOp.offset + dupOp.width, end);
      dupOp.offset = s0;
      dupOp.width = e0 - s0;
      continue;
    }
    const y0 = Math.max(0, seg.y0);
    room.openings.push(createOpening({
      type,
      edge: ne.k,
      offset: start,
      width: end - start,
      height: Math.max(0.3, seg.y1 - (isDoor && y0 < 0.2 ? 0 : y0)),
      sill: isDoor && y0 < 0.2 ? 0 : y0,
    }));
  }
  stats.doors = room.openings.filter((o) => o.type === 'door').length;
  stats.windows = room.openings.filter((o) => o.type === 'window').length;

  const tooBig = (r, h) => r.w * r.d > 0.5 * roomArea || (r.w > 0.85 * maxExtent && h > 0.8 * room.height);

  // 6. Meble z siatek (bryły ograniczające) + siatka trójkątów (tylko ten pokój)
  const meshParts = [];
  for (const m of meshes) {
    if (!m.vertices || m.vertices.length < 9) continue;
    if (isGlobalMeshLike(m)) {
      if (opts.keepGlobalMesh !== false) meshParts.push({ positions: meshPointsInRoom(m, toRoom2), indices: m.indices ? new Uint32Array(m.indices) : null });
      continue;
    }
    if (isStructureLabel(m.label)) continue;
    const pts3 = meshPointsInRoom(m, toRoom2);
    const xz = [];
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pts3.length; i += 3) {
      xz.push([pts3[i], pts3[i + 2]]);
      if (pts3[i + 1] < y0) y0 = pts3[i + 1];
      if (pts3[i + 1] > y1) y1 = pts3[i + 1];
    }
    const r = minAreaRect(xz);
    if (r.w < 0.05 || y1 - y0 < 0.03) continue;
    if (!inRoom([r.x, r.z], outline) || tooBig(r, y1 - y0)) { stats.skipped++; continue; }
    const type = labelToType(m.label);
    const f = createFurniture({
      type,
      x: r.x, z: r.z, y: y0 < 0.08 ? 0 : y0, rot: r.rot,
      w: Math.max(0.05, r.w), d: Math.max(0.03, r.d), h: y1 - (y0 < 0.08 ? 0 : y0),
      verified: false,
      sourceLabel: m.label,
    });
    f.scanned = snapshotScanned(f);
    room.furniture.push(f);
  }
  if (meshParts.length) room.scan.mesh = cropMeshToRoom(meshParts, outline, 0.4);

  // 7. Meble tylko z płaszczyzn (np. blat stołu bez bryły) — bez duplikatów
  for (const p of planes) {
    if (isStructureLabel(p.label) || ORIENTATION_LABELS.has(p.label) || !p.polygon || p.polygon.length < 3) continue;
    const pts3 = planePointsInRoom(p, toRoom2);
    const xz = pts3.map((q) => [q[0], q[2]]);
    const horizontal = planeNormalY(p, toRoom2) > 0.8;
    const r = minAreaRect(xz);
    const center = [r.x, r.z];
    if (!inRoom(center, outline)) continue;
    const dup = room.furniture.some((f) => furnitureFootprints({ ...f, w: f.w + 0.2, d: f.d + 0.2 }).some((part) => pointInPolygon(center, part)));
    if (dup) continue;
    const type = labelToType(p.label);
    let f;
    if (horizontal) {
      const top = pts3.reduce((s, q) => s + q[1], 0) / pts3.length;
      if (top < 0.1 || r.w < 0.1 || tooBig(r, top) || top > room.height - 0.15) continue;
      f = createFurniture({ type, x: r.x, z: r.z, y: 0, rot: r.rot, w: r.w, d: Math.max(0.1, r.d), h: top, verified: false, sourceLabel: p.label });
    } else if (type === 'screen') {
      const seg = verticalPlaneSegment(pts3);
      const dir = norm(sub(seg.b, seg.a));
      f = createFurniture({ type, x: (seg.a[0] + seg.b[0]) / 2, z: (seg.a[1] + seg.b[1]) / 2, y: Math.max(0, seg.y0), rot: -Math.atan2(dir[1], dir[0]), w: seg.length, d: 0.08, h: seg.y1 - seg.y0, verified: false, sourceLabel: p.label });
    } else {
      continue;
    }
    f.scanned = snapshotScanned(f);
    room.furniture.push(f);
  }

  stats.furniture = room.furniture.length;
  return { room, stats, frame };
}

/** Łączy siatki i zostawia trójkąty, których środek leży w pokoju (z marginesem). */
function cropMeshToRoom(parts, outline, margin) {
  const pos = [], idx = [];
  for (const part of parts) {
    const P = part.positions;
    const nV = P.length / 3;
    const I = part.indices && part.indices.length ? part.indices : Uint32Array.from({ length: nV }, (_, i) => i);
    const remap = new Map();
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      const cx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3, cz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
      if (!inRoom([cx, cz], outline, margin)) continue;
      for (const v of [a, b, c]) {
        let n = remap.get(v);
        if (n === undefined) { n = pos.length / 3; remap.set(v, n); pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); }
        idx.push(n);
      }
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Poza 2D (x, z, rot) z macierzy 4x4 — konwencja obrotu jak w geometry.js. */
export function pose2DFromMatrix(m) {
  return { x: m[12], z: m[14], rot: -Math.atan2(m[2], m[0]) };
}

function compose2D(a, b) {
  const c = Math.cos(a.rot), s = Math.sin(a.rot);
  return { x: a.x + b.x * c + b.z * s, z: a.z - b.x * s + b.z * c, rot: a.rot + b.rot };
}

function invert2D(a) {
  const c = Math.cos(-a.rot), s = Math.sin(-a.rot);
  return { x: -(a.x * c + a.z * s), z: -(-a.x * s + a.z * c), rot: -a.rot };
}

/**
 * Wszystkie pokoje ze Space Setup naraz (każda podłoga = pokój), ułożone względem siebie
 * tak jak w rzeczywistości. Transformacje są względem pierwszego pokoju.
 */
export function convertAllRooms(scanData, opts = {}) {
  const floors = listFloors(scanData).filter((f) => f.area > 0.8);
  const results = floors.map((f, i) => convertScene(scanData, { ...opts, floorIndex: f.index, name: opts.names ? opts.names[i] : `Pokój ${(opts.startNumber || 1) + i}` }));
  if (!results.length) return [];
  const p0 = pose2DFromMatrix(results[0].frame);
  const inv0 = invert2D(p0);
  for (const r of results) r.room.transform = compose2D(inv0, pose2DFromMatrix(r.frame));
  return results;
}
