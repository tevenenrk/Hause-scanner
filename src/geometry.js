// Czysta geometria 2D/3D (bez Three.js) — testowalna w Node.
// Konwencje:
//  * jednostki: metry, kąty: radiany
//  * plan pomieszczenia leży w płaszczyźnie XZ, oś Y w górę, podłoga na y = 0
//  * obrót mebla `rot` jest obrotem wokół osi +Y jak w Three.js (rotation.y):
//      lokalny punkt (lx, lz) -> świat (x + lx*cos + lz*sin,  z - lx*sin + lz*cos)
//  * obrys pomieszczenia jest wielokątem o dodatnim polu (shoelace na parach [x, z]);
//    wnętrze leży po lewej stronie krawędzi, normalna do wnętrza krawędzi (dx, dz) to (-dz, dx).

export const EPS = 1e-9;

// ---------- wektory 2D ----------
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const scale = (a, s) => [a[0] * s, a[1] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const len = (a) => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
export const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export function normalizeAngle(a) {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}

export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;

// ---------- wielokąty ----------
export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function polygonPerimeter(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) s += dist(poly[i], poly[(i + 1) % poly.length]);
  return s;
}

export function polygonCentroid(poly) {
  const a = polygonArea(poly);
  if (Math.abs(a) < EPS) {
    const c = poly.reduce((s, p) => add(s, p), [0, 0]);
    return scale(c, 1 / Math.max(1, poly.length));
  }
  let cx = 0, cz = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const f = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * f;
    cz += (p[1] + q[1]) * f;
  }
  return [cx / (6 * a), cz / (6 * a)];
}

/** Zwraca kopię wielokąta o dodatnim polu (orientacja zgodna z konwencją pliku). */
export function ensurePositive(poly) {
  const p = poly.map((v) => [v[0], v[1]]);
  return polygonArea(p) < 0 ? p.reverse() : p;
}

/** Usuwa duplikaty i punkty prawie współliniowe. */
export function simplifyPolygon(poly, distTol = 0.01, angleTolDeg = 2) {
  let pts = poly.map((p) => [p[0], p[1]]);
  // duplikaty
  pts = pts.filter((p, i) => dist(p, pts[(i + 1) % pts.length]) > distTol / 2);
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const ab = sub(b, a), bc = sub(c, b);
      const ang = Math.abs(Math.atan2(cross(ab, bc), dot(ab, bc)));
      const dev = distPointSegment(b, a, c);
      if (ang < rad(angleTolDeg) || dev < distTol / 2) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > pt[1]) !== (zj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi + EPS) + xi) inside = !inside;
  }
  return inside;
}

export function distPointSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < EPS ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, add(a, scale(ab, t)));
}

/** Parametr t rzutu punktu p na prostą ab (0 = a, 1 = b), bez obcinania. */
export function projectT(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  return l2 < EPS ? 0 : dot(sub(p, a), ab) / l2;
}

export function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross(sub(p4, p3), sub(p1, p3));
  const d2 = cross(sub(p4, p3), sub(p2, p3));
  const d3 = cross(sub(p2, p1), sub(p3, p1));
  const d4 = cross(sub(p2, p1), sub(p4, p1));
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

/** Przecięcie promienia (o, kierunek d jednostkowy) z odcinkiem ab; zwraca odległość lub null. */
export function raySegment(o, d, a, b) {
  const e = sub(b, a);
  const den = cross(d, e);
  if (Math.abs(den) < EPS) return null;
  const ao = sub(a, o);
  const t = cross(ao, e) / den;
  const u = cross(ao, d) / den;
  if (t >= 0 && u >= -1e-6 && u <= 1 + 1e-6) return t;
  return null;
}

/** Przecięcie dwóch prostych (punkt + kierunek). */
export function lineIntersect(p, r, q, s) {
  const den = cross(r, s);
  if (Math.abs(den) < 1e-6) return null;
  const t = cross(sub(q, p), s) / den;
  return add(p, scale(r, t));
}

export function convexHull(points) {
  const pts = points.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(sub(lower[lower.length - 1], lower[lower.length - 2]), sub(p, lower[lower.length - 2])) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(sub(upper[upper.length - 1], upper[upper.length - 2]), sub(p, upper[upper.length - 2])) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Prostokąt o minimalnym polu obejmujący punkty (rotating calipers po krawędziach otoczki).
 * Zwraca { x, z, w, d, rot } w konwencji mebla (w >= d).
 */
export function minAreaRect(points) {
  const hull = convexHull(points);
  if (hull.length === 0) return { x: 0, z: 0, w: 0, d: 0, rot: 0 };
  if (hull.length < 3) {
    const a = hull[0], b = hull[hull.length - 1];
    const c = lerp2(a, b, 0.5);
    const u = sub(b, a);
    return { x: c[0], z: c[1], w: len(u), d: 0, rot: -Math.atan2(u[1], u[0]) };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const u = norm(sub(b, a));
    const v = [-u[1], u[0]];
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const pu = dot(p, u), pv = dot(p, v);
      if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area - 1e-9) best = { area, u, v, minU, maxU, minV, maxV };
  }
  const cu = (best.minU + best.maxU) / 2, cv = (best.minV + best.maxV) / 2;
  const c = add(scale(best.u, cu), scale(best.v, cv));
  let w = best.maxU - best.minU, d = best.maxV - best.minV;
  let axis = best.u;
  if (d > w) { [w, d] = [d, w]; axis = best.v; }
  // lokalna oś X mebla w świecie to (cos rot, -sin rot) => rot = -atan2(axis.z, axis.x)
  let rot = -Math.atan2(axis[1], axis[0]);
  // normalizacja do (-90°, 90°] — prostokąt jest symetryczny
  while (rot > Math.PI / 2 + 1e-9) rot -= Math.PI;
  while (rot <= -Math.PI / 2 + 1e-9) rot += Math.PI;
  return { x: c[0], z: c[1], w, d, rot };
}

// ---------- meble ----------
export function localToWorld(f, lx, lz) {
  const c = Math.cos(f.rot || 0), s = Math.sin(f.rot || 0);
  return [f.x + lx * c + lz * s, f.z - lx * s + lz * c];
}

export function worldToLocal(f, x, z) {
  const c = Math.cos(f.rot || 0), s = Math.sin(f.rot || 0);
  const dx = x - f.x, dz = z - f.z;
  return [dx * c - dz * s, dx * s + dz * c];
}

/** Lokalne osie mebla w świecie. */
export function furnitureAxes(f) {
  const c = Math.cos(f.rot || 0), s = Math.sin(f.rot || 0);
  return { ax: [c, -s], az: [s, c] };
}

function rectLocal(x0, z0, x1, z1) {
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
}

/** Wielokąty wypukłe (lokalne) opisujące rzut mebla. inset > 0 zmniejsza je (tolerancja styku). */
export function furnitureLocalParts(f, inset = 0) {
  // kształt złożony (suma brył): części mają pozycję/obrót w układzie mebla
  if (f.shape === 'compound' && Array.isArray(f.parts) && f.parts.length) {
    return f.parts.flatMap((p) => furnitureFootprints(p, inset));
  }
  const hw = f.w / 2, hd = f.d / 2;
  const i = Math.min(inset, hw * 0.4, hd * 0.4);
  if (f.shape === 'cylinder') {
    const n = 24, rx = Math.max(0.001, hw - i), rz = Math.max(0.001, hd - i);
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      pts.push([Math.cos(a) * rx, Math.sin(a) * rz]);
    }
    return [pts];
  }
  if (f.shape === 'L') {
    const aw = Math.min(f.aw || f.w / 2, f.w), ad = Math.min(f.ad || f.d / 2, f.d);
    return [
      rectLocal(-hw + i, -hd + i, hw - i, -hd + ad - i), // pas tylny (wzdłuż szerokości)
      rectLocal(-hw + i, -hd + i, -hw + aw - i, hd - i), // pas boczny (wzdłuż głębokości)
    ];
  }
  return [rectLocal(-hw + i, -hd + i, hw - i, hd - i)];
}

export function furnitureFootprints(f, inset = 0) {
  return furnitureLocalParts(f, inset).map((part) => part.map(([lx, lz]) => localToWorld(f, lx, lz)));
}

/** Wszystkie kontury mebla w świecie (dla kształtu złożonego — po jednym na część). */
export function furnitureOutlines(f) {
  if (f.shape === 'compound' && Array.isArray(f.parts) && f.parts.length) {
    return f.parts.flatMap((p) => furnitureOutlines(p)).map((poly) => poly.map(([lx, lz]) => localToWorld(f, lx, lz)));
  }
  return [furnitureOutline(f)];
}

/** Bryły mebla w świecie: [{ polys, y0, y1 }] — kształt złożony ma osobne wysokości części. */
export function furnitureSolids(f, inset = 0) {
  const fy = f.y || 0;
  if (f.shape === 'compound' && Array.isArray(f.parts) && f.parts.length) {
    return f.parts.map((p) => ({
      polys: furnitureFootprints(p, inset).map((poly) => poly.map(([lx, lz]) => localToWorld(f, lx, lz))),
      y0: fy + (p.y || 0),
      y1: fy + (p.y || 0) + p.h,
    }));
  }
  return [{ polys: furnitureFootprints(f, inset), y0: fy, y1: fy + f.h }];
}

/** Obrys (kontur) mebla w świecie — dla L zwraca 6-kąt, dla reszty pierwszą część. */
export function furnitureOutline(f) {
  if (f.shape === 'compound' && Array.isArray(f.parts) && f.parts.length) {
    return convexHull(furnitureOutlines(f).flat());
  }
  if (f.shape === 'L') {
    const hw = f.w / 2, hd = f.d / 2;
    const aw = Math.min(f.aw || hw, f.w), ad = Math.min(f.ad || hd, f.d);
    const loc = [[-hw, -hd], [hw, -hd], [hw, -hd + ad], [-hw + aw, -hd + ad], [-hw + aw, hd], [-hw, hd]];
    return loc.map(([lx, lz]) => localToWorld(f, lx, lz));
  }
  return furnitureFootprints(f)[0];
}

function projectPoly(poly, axis) {
  let min = Infinity, max = -Infinity;
  for (const p of poly) {
    const v = dot(p, axis);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/** Test SAT dla dwóch wielokątów wypukłych. */
export function convexPolysIntersect(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const e = sub(poly[(i + 1) % poly.length], poly[i]);
      const axis = [-e[1], e[0]];
      const [amin, amax] = projectPoly(a, axis);
      const [bmin, bmax] = projectPoly(b, axis);
      if (amax <= bmin || bmax <= amin) return false;
    }
  }
  return true;
}

export function footprintsIntersect(fa, fb) {
  for (const a of fa) for (const b of fb) if (convexPolysIntersect(a, b)) return true;
  return false;
}

export function yRange(f) {
  const y = f.y || 0;
  return [y, y + f.h];
}

export function yOverlap(a, b, tol = 0.01) {
  const [a0, a1] = yRange(a), [b0, b1] = yRange(b);
  return Math.min(a1, b1) - Math.max(a0, b0) > tol;
}

// ---------- ściany i otwory ----------
export function edgeOf(outline, i) {
  const a = outline[i], b = outline[(i + 1) % outline.length];
  const dir = norm(sub(b, a));
  return { a, b, dir, length: dist(a, b), inward: [-dir[1], dir[0]] };
}

/** Otwór (drzwi/okno) jako odcinek na krawędzi obrysu. */
export function openingSegment(outline, op) {
  const e = edgeOf(outline, op.edge % outline.length);
  const off = Math.max(0, Math.min(op.offset, Math.max(0, e.length - op.width)));
  const p0 = add(e.a, scale(e.dir, off));
  const p1 = add(e.a, scale(e.dir, Math.min(e.length, off + op.width)));
  return { p0, p1, edge: e };
}

/** Strefa otwierania drzwi (kwadrat po stronie, w którą otwierają się drzwi). */
export function doorZone(outline, op) {
  if (op.type !== 'door' || op.swing === 'none' || op.swing === 'out') return null;
  const { p0, p1, edge } = openingSegment(outline, op);
  const depth = Math.min(op.width, 1.0);
  const q0 = add(p0, scale(edge.inward, depth));
  const q1 = add(p1, scale(edge.inward, depth));
  return [p0, p1, q1, q0];
}

/** Przesuwa ścianę (krawędź i) równolegle o `offset` m (dodatnio = na zewnątrz pomieszczenia). */
export function moveEdge(outline, i, offset) {
  const n = outline.length;
  const out = outline.map((p) => [p[0], p[1]]);
  const e = edgeOf(outline, i);
  const shift = scale(e.inward, -offset);
  const a2 = add(e.a, shift);
  const prev = edgeOf(outline, (i - 1 + n) % n);
  const next = edgeOf(outline, (i + 1) % n);
  const ia = lineIntersect(a2, e.dir, prev.a, prev.dir) || a2;
  const ib = lineIntersect(a2, e.dir, next.a, next.dir) || add(e.b, shift);
  out[i] = ia;
  out[(i + 1) % n] = ib;
  return out;
}

/** Ustawia długość ściany i, przesuwając równolegle następną ścianę (i+1). */
export function setEdgeLength(outline, i, newLength) {
  const n = outline.length;
  const e = edgeOf(outline, i);
  const next = edgeOf(outline, (i + 1) % n);
  const delta = newLength - e.length;
  const dn = dot(e.dir, next.inward);
  if (Math.abs(dn) < 0.2) return outline.map((p) => [p[0], p[1]]);
  // przesunięcie prostej i+1 o `offset` na zewnątrz przesuwa wierzchołek b wzdłuż e o -offset/dn
  return moveEdge(outline, (i + 1) % n, -delta * dn);
}

export function splitEdge(outline, i, t = 0.5) {
  const n = outline.length;
  const out = outline.map((p) => [p[0], p[1]]);
  out.splice(i + 1, 0, lerp2(outline[i], outline[(i + 1) % n], t));
  return out;
}

export function removeVertex(outline, i) {
  if (outline.length <= 3) return outline.map((p) => [p[0], p[1]]);
  const out = outline.map((p) => [p[0], p[1]]);
  out.splice(i, 1);
  return out;
}

// ---------- analiza pomieszczenia ----------
/**
 * Wylicza konflikty mebli w pomieszczeniu.
 * Zwraca Map<id, Array<{kind: 'wall'|'furniture'|'door', otherId?, label}>>
 */
export function computeConflicts(room, { tolerance = 0.005 } = {}) {
  const res = new Map();
  const push = (id, item) => { if (!res.has(id)) res.set(id, []); res.get(id).push(item); };
  const items = room.furniture.filter((f) => !f.hidden);
  // płaskie rzeczy na podłodze (dywan) nie kolidują z meblami ani z drzwiami
  const flat = (f) => f.type === 'rug' || ((f.y || 0) < 0.01 && f.h < 0.04);
  const fps = new Map(items.map((f) => [f.id, furnitureFootprints(f, tolerance)]));
  const outline = room.outline;
  const zones = (room.openings || []).map((op) => ({ op, zone: doorZone(outline, op) })).filter((z) => z.zone);

  for (const f of items) {
    const parts = fps.get(f.id);
    // ściany: wierzchołek poza obrysem lub przecięcie krawędzi
    let wall = false;
    if (outline && outline.length >= 3) {
      outer: for (const part of parts) {
        for (const p of part) if (!pointInPolygon(p, outline)) { wall = true; break outer; }
        for (let i = 0; i < part.length; i++) {
          const p = part[i], q = part[(i + 1) % part.length];
          for (let k = 0; k < outline.length; k++) {
            if (segmentsIntersect(p, q, outline[k], outline[(k + 1) % outline.length])) { wall = true; break outer; }
          }
        }
      }
    }
    if (wall) push(f.id, { kind: 'wall', label: 'ściana' });
    // drzwi
    if ((f.y || 0) < 1.9 && !flat(f)) {
      for (const { op, zone } of zones) {
        if (footprintsIntersect(parts, [zone])) push(f.id, { kind: 'door', otherId: op.id, label: 'strefa otwierania drzwi' });
      }
    }
  }
  // meble między sobą
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (flat(a) || flat(b) || !yOverlap(a, b)) continue;
      const sa = furnitureSolids(a, tolerance), sb = furnitureSolids(b, tolerance);
      const hit = sa.some((x) => sb.some((y) => Math.min(x.y1, y.y1) - Math.max(x.y0, y.y0) > 0.01 && footprintsIntersect(x.polys, y.polys)));
      if (hit) {
        push(a.id, { kind: 'furniture', otherId: b.id, label: b.name });
        push(b.id, { kind: 'furniture', otherId: a.id, label: a.name });
      }
    }
  }
  return res;
}

/**
 * Odległości od mebla do najbliższej przeszkody w 4 kierunkach jego osi lokalnych.
 * Zwraca [{dir: '+x'|'-x'|'+z'|'-z', dist, from:[x,z], to:[x,z]}]
 */
export function computeClearances(room, f, maxDist = 6) {
  const { ax, az } = furnitureAxes(f);
  const segs = [];
  const outline = room.outline || [];
  for (let k = 0; k < outline.length; k++) segs.push([outline[k], outline[(k + 1) % outline.length]]);
  for (const o of room.furniture) {
    if (o.id === f.id || o.hidden || !yOverlap(o, f)) continue;
    for (const ol of furnitureOutlines(o)) {
      for (let k = 0; k < ol.length; k++) segs.push([ol[k], ol[(k + 1) % ol.length]]);
    }
  }
  const out = [];
  const dirs = [
    ['+x', ax, f.w / 2], ['-x', scale(ax, -1), f.w / 2],
    ['+z', az, f.d / 2], ['-z', scale(az, -1), f.d / 2],
  ];
  // promienie wypuszczamy z 3 punktów na boku, aby nie przegapić przeszkody przy krawędzi
  for (const [name, d, half] of dirs) {
    const side = [-d[1], d[0]];
    const sideHalf = name.endsWith('x') ? f.d / 2 : f.w / 2;
    let best = null;
    for (const s of [-0.9, 0, 0.9]) {
      const origin = add(add([f.x, f.z], scale(d, half)), scale(side, s * sideHalf));
      for (const [a, b] of segs) {
        const t = raySegment(origin, d, a, b);
        if (t !== null && t < maxDist && (!best || t < best.dist)) best = { dir: name, dist: t, from: origin, to: add(origin, scale(d, t)) };
      }
    }
    if (best) out.push(best);
  }
  return out;
}

/** Sposób mocowania mebla: 'floor' (stoi na podłodze) albo 'wall' (wisi na ścianie). */
export function mountOf(f) {
  if (f.mount) return f.mount;
  return f.type === 'screen' || (f.y || 0) > 0.3 ? 'wall' : 'floor';
}

/**
 * Mebel wiszący: przykleja tył mebla do najbliższej ściany (w zasięgu `maxDist` od środka),
 * obraca go tyłem do ściany i pozwala przesuwać tylko wzdłuż niej. Zwraca { x, z, rot } albo null.
 */
export function attachToWall(room, f, maxDist = 0.6) {
  const outline = room.outline || [];
  let best = null;
  for (let k = 0; k < outline.length; k++) {
    const e = edgeOf(outline, k);
    if (e.length < 0.2) continue;
    const d = distPointSegment([f.x, f.z], e.a, e.b);
    if (d <= maxDist + f.d / 2 && (!best || d < best.d)) best = { d, e };
  }
  if (!best) return null;
  const { e } = best;
  // tył mebla (lokalne -Z) ma patrzeć w ścianę: lokalne +Z = normalna do wnętrza
  const rot = Math.atan2(e.inward[0], e.inward[1]);
  const half = Math.min(f.w / 2, e.length / 2);
  let t = projectT([f.x, f.z], e.a, e.b) * e.length;
  t = Math.max(half, Math.min(e.length - half, t));
  const p = add(add(e.a, scale(e.dir, t)), scale(e.inward, f.d / 2));
  return { x: p[0], z: p[1], rot: normalizeAngle(rot) };
}

/** Dosuwa mebel do najbliższej równoległej ściany, jeśli jest w zasięgu `tol`. Zwraca nowe {x, z} lub null. */
export function snapToWalls(room, f, tol = 0.05) {
  const outline = room.outline || [];
  let x = f.x, z = f.z, snapped = false;
  const used = [];
  for (let pass = 0; pass < 2; pass++) {
    let best = null;
    for (let k = 0; k < outline.length; k++) {
      if (used.includes(k)) continue;
      const e = edgeOf(outline, k);
      const cur = { ...f, x, z };
      const parts = furnitureFootprints(cur);
      // równoległość: jedna z osi mebla prawie równoległa do ściany
      const { ax } = furnitureAxes(cur);
      const ang = Math.abs(cross(ax, e.dir));
      if (!(ang < 0.035 || ang > 0.9994)) continue;
      // najmniejsza odległość wierzchołków mebla od prostej ściany (mierzona do wnętrza)
      let minD = Infinity;
      let within = false;
      for (const part of parts) for (const p of part) {
        const dd = dot(sub(p, e.a), e.inward);
        if (dd < minD) minD = dd;
        const t = projectT(p, e.a, e.b);
        if (t > -0.05 && t < 1.05) within = true;
      }
      if (!within) continue;
      if (Math.abs(minD) <= tol && (!best || Math.abs(minD) < Math.abs(best.d))) best = { k, d: minD, inward: e.inward };
    }
    if (!best) break;
    x -= best.inward[0] * best.d;
    z -= best.inward[1] * best.d;
    used.push(best.k);
    snapped = true;
  }
  return snapped ? { x, z } : null;
}

/** Kąt obrotu mebla wyrównujący go do najbliższej ściany (najmniejsza zmiana). */
export function alignRotationToNearestWall(room, f) {
  const outline = room.outline || [];
  let best = null;
  for (let k = 0; k < outline.length; k++) {
    const e = edgeOf(outline, k);
    const dd = distPointSegment([f.x, f.z], e.a, e.b);
    if (!best || dd < best.dd) best = { dd, e };
  }
  if (!best) return f.rot || 0;
  const wallRot = -Math.atan2(best.e.dir[1], best.e.dir[0]);
  let r = wallRot;
  let bestR = r, bestDiff = Infinity;
  for (let q = 0; q < 4; q++) {
    const cand = normalizeAngle(wallRot + (q * Math.PI) / 2);
    const diff = Math.abs(normalizeAngle(cand - (f.rot || 0)));
    if (diff < bestDiff) { bestDiff = diff; bestR = cand; }
  }
  return bestR;
}

// ---------- pomieszczenie w mieszkaniu ----------
export function roomToWorld(room, p) {
  const t = room.transform || { x: 0, z: 0, rot: 0 };
  return localToWorld({ x: t.x, z: t.z, rot: t.rot }, p[0], p[1]);
}

export function worldToRoom(room, p) {
  const t = room.transform || { x: 0, z: 0, rot: 0 };
  return worldToLocal({ x: t.x, z: t.z, rot: t.rot }, p[0], p[1]);
}

export function roomContainsWorldPoint(room, p) {
  return room.outline && room.outline.length >= 3 && pointInPolygon(worldToRoom(room, p), room.outline);
}
