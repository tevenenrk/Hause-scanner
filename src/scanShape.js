// Uproszczony kształt mebla z trójkątów skanu (zamiast jednego prostopadłościanu).
// Bierzemy górne powierzchnie siatki pokoju (trójkąty skierowane w górę) wewnątrz bryły mebla,
// budujemy mapę wysokości na siatce ~8-12 cm i łączymy komórki o podobnej wysokości w prostokąty.
// Wynik: kilka brył (np. kanapa: siedzisko + oparcie + podłokietniki) jako kształt złożony.
import { worldToLocal } from './geometry.js';

/**
 * @param {object} room  pokój z room.scan.mesh (pozycje w układzie pokoju)
 * @param {object} f     mebel (prosty kształt; dla złożonego liczymy od jego prostokąta obejmującego)
 * @param {object} opts  { cell, tolerance, maxParts }
 * @returns {{ parts, cells, samples } | { error }}
 */
export function shapeFromScan(room, f, opts = {}) {
  const mesh = room.scan && room.scan.mesh;
  if (!mesh || !mesh.positions || !mesh.positions.length) return { error: 'Ten pokój nie ma zapisanej siatki skanu.' };
  const P = mesh.positions;
  const I = mesh.indices && mesh.indices.length ? mesh.indices : null;
  const fy = f.y || 0;
  const margin = 0.03;
  const hw = f.w / 2, hd = f.d / 2;
  const cell = opts.cell || Math.min(0.12, Math.max(0.06, Math.min(f.w, f.d) / 8));
  const nx = Math.max(1, Math.round(f.w / cell)), nz = Math.max(1, Math.round(f.d / cell));
  const cw = f.w / nx, cd = f.d / nz;
  const grid = new Float32Array(nx * nz).fill(-1);
  let samples = 0;

  const addSample = (x, y, z) => {
    const h = y - fy;
    if (h < 0.03 || h > f.h + 0.08) return;
    const [lx, lz] = worldToLocal(f, x, z);
    if (lx < -hw - margin || lx > hw + margin || lz < -hd - margin || lz > hd + margin) return;
    const ix = Math.min(nx - 1, Math.max(0, Math.floor((lx + hw) / cw)));
    const iz = Math.min(nz - 1, Math.max(0, Math.floor((lz + hd) / cd)));
    const k = iz * nx + ix;
    if (h > grid[k]) grid[k] = Math.min(h, f.h);
    samples++;
  };

  const triCount = I ? I.length / 3 : P.length / 9;
  for (let t = 0; t < triCount; t++) {
    const a = I ? I[t * 3] : t * 3, b = I ? I[t * 3 + 1] : t * 3 + 1, c = I ? I[t * 3 + 2] : t * 3 + 2;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    const cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
    // normalna: tylko powierzchnie skierowane w górę (siedziska, blaty, oparcia od góry) — bez ścian i boków
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nxn = uy * vz - uz * vy, nyn = uz * vx - ux * vz, nzn = ux * vy - uy * vx;
    const len = Math.hypot(nxn, nyn, nzn) || 1;
    if (Math.abs(nyn / len) < 0.6) continue;
    // próbki: wierzchołki, środek i środki krawędzi (gęściej dla dużych trójkątów)
    addSample(ax, ay, az); addSample(bx, by, bz); addSample(cx, cy, cz);
    addSample((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3);
    addSample((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    addSample((bx + cx) / 2, (by + cy) / 2, (bz + cz) / 2);
    addSample((ax + cx) / 2, (ay + cy) / 2, (az + cz) / 2);
  }
  const filled = grid.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
  if (filled < Math.max(2, nx * nz * 0.2)) return { error: 'Za mało trójkątów skanu w obrębie tego mebla.' };

  // uzupełnianie dziur wartością sąsiadów (2 przebiegi)
  for (let pass = 0; pass < 2; pass++) {
    const copy = grid.slice();
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const k = iz * nx + ix;
      if (copy[k] > 0) continue;
      let s = 0, n = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = ix + dx, z = iz + dz;
        if (x < 0 || z < 0 || x >= nx || z >= nz) continue;
        const v = copy[z * nx + x];
        if (v > 0) { s += v; n++; }
      }
      if (n >= 2) grid[k] = s / n;
    }
  }
  // wygładzenie medianą 3x3 (usuwa pojedyncze szpilki szumu)
  const med = grid.slice();
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const vals = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const x = ix + dx, z = iz + dz;
      if (x >= 0 && z >= 0 && x < nx && z < nz) vals.push(grid[z * nx + x]);
    }
    vals.sort((a, b) => a - b);
    med[iz * nx + ix] = vals[Math.floor(vals.length / 2)];
  }

  const maxParts = opts.maxParts || 8;
  const minArea = 3 * cw * cd; // drobne kawałki = szum skanu
  // 1) wysokości grupujemy w 1-4 poziomy (np. siedzisko / podłokietniki / oparcie)
  const vals = Array.from(med).filter((v) => v > 0.04);
  const { centers, assign } = clusterHeights(vals, opts.levelTolerance || 0.05);
  let level = new Int32Array(nx * nz);
  for (let k = 0; k < med.length; k++) level[k] = med[k] > 0.04 ? assign(med[k]) + 1 : 0;
  // 2) wygładzenie przypisania (większość w otoczeniu 3x3) — usuwa pojedyncze komórki szumu
  for (let pass = 0; pass < 2; pass++) {
    const next = level.slice();
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const count = new Map();
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const x = ix + dx, z = iz + dz;
        if (x < 0 || z < 0 || x >= nx || z >= nz) continue;
        const L = level[z * nx + x];
        count.set(L, (count.get(L) || 0) + 1);
      }
      let best = level[iz * nx + ix], bestN = 0;
      for (const [L, n] of count) if (n > bestN) { best = L; bestN = n; }
      if (bestN >= 5) next[iz * nx + ix] = best;
    }
    level = next;
  }
  // 3) prostokąty
  const all = mergeLevels(level, centers, nx, nz, cw, cd, hw, hd);
  let parts = all.filter((p) => p.w * p.d >= minArea);
  if (!parts.length) parts = all;
  if (parts.length > maxParts) parts = parts.sort((a, b) => b.w * b.d - a.w * a.d).slice(0, maxParts);
  if (centers.length <= 1 || new Set(parts.map((p) => p.h)).size <= 1) parts = [{ shape: 'box', x: 0, z: 0, y: 0, rot: 0, w: f.w, d: f.d, h: Math.max(...parts.map((p) => p.h)) }];
  return { parts, cells: [nx, nz], samples };
}

/** 1D k-means: najmniejsza liczba poziomów (1-4), przy której każdy poziom jest „płaski” (±tol). */
function clusterHeights(vals, tol) {
  if (!vals.length) return { centers: [0], assign: () => 0 };
  const sorted = [...vals].sort((a, b) => a - b);
  let best = null;
  for (let K = 1; K <= 4; K++) {
    let c = Array.from({ length: K }, (_, i) => sorted[Math.min(sorted.length - 1, Math.floor(((i + 0.5) / K) * sorted.length))]);
    let groups;
    for (let it = 0; it < 20; it++) {
      groups = Array.from({ length: K }, () => []);
      for (const v of sorted) {
        let bi = 0;
        for (let i = 1; i < K; i++) if (Math.abs(v - c[i]) < Math.abs(v - c[bi])) bi = i;
        groups[bi].push(v);
      }
      c = groups.map((g, i) => (g.length ? g.reduce((s, v) => s + v, 0) / g.length : c[i]));
    }
    // rozrzut: 80% wartości w grupie mieści się w ±tol od środka
    const ok = groups.every((g, i) => !g.length || g.filter((v) => Math.abs(v - c[i]) <= tol).length >= 0.8 * g.length);
    best = { c };
    if (ok) break;
  }
  const centers = best.c.map((v, i) => ({ v, i })).filter((x) => sorted.some((s) => Math.abs(s - x.v) < 0.5)).map((x) => x.v).sort((a, b) => a - b);
  // łączymy poziomy bliższe niż tol
  const merged = [];
  for (const v of centers) if (!merged.length || v - merged[merged.length - 1] > tol * 1.5) merged.push(v); else merged[merged.length - 1] = Math.max(merged[merged.length - 1], v);
  const assign = (v) => { let bi = 0; for (let i = 1; i < merged.length; i++) if (Math.abs(v - merged[i]) < Math.abs(v - merged[bi])) bi = i; return bi; };
  return { centers: merged, assign };
}

/** Łączy sąsiednie komórki tego samego poziomu w prostokąty (zachłannie). */
function mergeLevels(level, centers, nx, nz, cw, cd, hw, hd) {
  const used = new Uint8Array(nx * nz);
  const parts = [];
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const k = iz * nx + ix;
    if (used[k] || level[k] === 0) continue;
    const L = level[k];
    let x1 = ix;
    while (x1 + 1 < nx && !used[iz * nx + x1 + 1] && level[iz * nx + x1 + 1] === L) x1++;
    let z1 = iz;
    outer: while (z1 + 1 < nz) {
      for (let x = ix; x <= x1; x++) if (used[(z1 + 1) * nx + x] || level[(z1 + 1) * nx + x] !== L) break outer;
      z1++;
    }
    for (let z = iz; z <= z1; z++) for (let x = ix; x <= x1; x++) used[z * nx + x] = 1;
    const w = (x1 - ix + 1) * cw, d = (z1 - iz + 1) * cd;
    parts.push({ shape: 'box', x: -hw + ix * cw + w / 2, z: -hd + iz * cd + d / 2, y: 0, rot: 0, w, d, h: Math.max(0.03, centers[L - 1]) });
  }
  return parts;
}

/** Zamienia mebel na kształt ze skanu (kształt złożony). Zwraca komunikat błędu albo null. */
export function applyScanShape(room, f, opts) {
  const base = f.shape === 'compound' ? { ...f, shape: 'box' } : f;
  const res = shapeFromScan(room, base, opts);
  if (res.error) return res.error;
  if (res.parts.length < 2) return 'Skan pokazuje tu zwykły prostopadłościan — zostawiam bryłę.';
  f.shape = 'compound';
  f.parts = res.parts;
  f.fromScan = true;
  f.h = Math.max(...res.parts.map((p) => p.h));
  return null;
}

/** Powrót do zwykłego prostopadłościanu (wymiary bez zmian). */
export function applyBoxShape(f) {
  if (f.shape === 'compound') delete f.parts;
  f.shape = 'box';
  f.fromScan = false;
  if (f.scanned) f.h = Math.max(f.h, f.scanned.h || f.h);
}
