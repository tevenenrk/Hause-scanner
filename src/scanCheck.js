// Kontrola kompletności i sensowności skanu pokoju.
// Zwraca listę uwag (błąd / ostrzeżenie / informacja) z celem (mebel, ściana), żeby można było
// od razu przejść do miejsca problemu, oraz „dziury” — niezeskanowane miejsca na podłodze.
import {
  polygonArea, pointInPolygon, distPointSegment, computeConflicts, furnitureFootprints,
  footprintsIntersect, edgeOf, dist,
} from './geometry.js';
import { typeName } from './labels.js';

const WALL_MOUNTED = new Set(['screen', 'lamp', 'shelf', 'storage', 'kitchen', 'other']);

/**
 * Pokrycie podłogi siatką skanu: siatka komórek `cell` m; komórka jest „zeskanowana”,
 * jeśli trafia w nią jakikolwiek fragment trójkąta (rzut z góry).
 */
export function meshCoverage(room, cell = 0.25) {
  const mesh = room.scan && room.scan.mesh;
  const outline = room.outline;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of outline) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell)), nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const inside = new Uint8Array(nx * nz), hit = new Uint8Array(nx * nz);
  let insideCount = 0;
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const c = [minX + (ix + 0.5) * cell, minZ + (iz + 0.5) * cell];
    // komórki przy samej ścianie pomijamy (siatka bywa tam rzadsza)
    if (pointInPolygon(c, outline) && minDistToOutline(c, outline) > cell * 0.6) { inside[iz * nx + ix] = 1; insideCount++; }
  }
  if (!mesh || !mesh.positions || !mesh.positions.length) return { available: false, coverage: 0, holes: [], cell, outsideArea: 0 };
  const P = mesh.positions;
  const I = mesh.indices && mesh.indices.length ? mesh.indices : null;
  let outside = new Set();
  const mark = (x, y, z) => {
    const ix = Math.floor((x - minX) / cell), iz = Math.floor((z - minZ) / cell);
    if (ix >= 0 && iz >= 0 && ix < nx && iz < nz) hit[iz * nx + ix] = 1;
    // siatka poza obrysem (na wysokości mebli/ścian) — obrys może być za mały
    if (y > 0.1 && y < 2.0 && !pointInPolygon([x, z], outline) && minDistToOutline([x, z], outline) > 0.5) {
      outside.add(`${Math.floor(x / 0.5)},${Math.floor(z / 0.5)}`);
    }
  };
  const triCount = I ? I.length / 3 : P.length / 9;
  for (let t = 0; t < triCount; t++) {
    const a = I ? I[t * 3] : t * 3, b = I ? I[t * 3 + 1] : t * 3 + 1, c = I ? I[t * 3 + 2] : t * 3 + 2;
    const A = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]], B = [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]], C = [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
    const L = Math.max(Math.hypot(A[0] - B[0], A[2] - B[2]), Math.hypot(B[0] - C[0], B[2] - C[2]), Math.hypot(A[0] - C[0], A[2] - C[2]));
    const n = Math.min(40, Math.max(1, Math.ceil(L / (cell * 0.5))));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, v = j / n, w = 1 - u - v;
      mark(A[0] * w + B[0] * u + C[0] * v, A[1] * w + B[1] * u + C[1] * v, A[2] * w + B[2] * u + C[2] * v);
    }
  }
  const holes = [];
  let covered = 0;
  for (let k = 0; k < nx * nz; k++) {
    if (!inside[k]) continue;
    if (hit[k]) covered++;
    else holes.push([minX + ((k % nx) + 0.5) * cell, minZ + (Math.floor(k / nx) + 0.5) * cell]);
  }
  return { available: true, coverage: insideCount ? covered / insideCount : 1, holes, cell, outsideArea: outside.size * 0.25 };
}

function minDistToOutline(p, outline) {
  let d = Infinity;
  for (let k = 0; k < outline.length; k++) d = Math.min(d, distPointSegment(p, outline[k], outline[(k + 1) % outline.length]));
  return d;
}

/** Grupuje dziury w skupiska (sąsiednie komórki), żeby raportować sensowne obszary. */
function clusterHoles(holes, cell) {
  const key = (p) => `${Math.round(p[0] / cell)},${Math.round(p[1] / cell)}`;
  const map = new Map(holes.map((p) => [key(p), p]));
  const seen = new Set();
  const clusters = [];
  for (const [k, p] of map) {
    if (seen.has(k)) continue;
    const stack = [p], list = [];
    seen.add(k);
    while (stack.length) {
      const q = stack.pop();
      list.push(q);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = `${Math.round(q[0] / cell) + dx},${Math.round(q[1] / cell) + dz}`;
        if (map.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(map.get(nk)); }
      }
    }
    const cx = list.reduce((s, q) => s + q[0], 0) / list.length, cz = list.reduce((s, q) => s + q[1], 0) / list.length;
    clusters.push({ area: list.length * cell * cell, center: [cx, cz], cells: list.length });
  }
  return clusters.sort((a, b) => b.area - a.area);
}

/**
 * Pełna kontrola pokoju. Zwraca { verdict: 'ok'|'warn'|'error', issues: [{level, text, fid?, edge?, point?}], holes, coverage }.
 */
export function checkRoom(room, { cell = 0.25 } = {}) {
  const issues = [];
  const add = (level, text, extra = {}) => issues.push({ level, text, ...extra });
  const scan = room.scan || {};
  const area = Math.abs(polygonArea(room.outline || []));

  // --- konstrukcja ---
  if (scan.source === 'quest' || scan.source === undefined) {
    if (scan.hadFloorPlane === false) add('error', 'Brak podłogi w skanie — obrys wyznaczony ze ścian. Popraw Space Setup albo narysuj obrys w trybie „Ściany”.');
    if (scan.hadCeiling === false) add('warn', 'Brak sufitu w skanie — wysokość pokoju jest szacowana. Sprawdź ją w panelu pokoju.');
    if (typeof scan.wallPlanes === 'number' && scan.wallPlanes < 3) add('error', `Za mało ścian w skanie (${scan.wallPlanes}). Pokój jest prawdopodobnie niedokończony.`);
    (scan.edgeWallCoverage || []).forEach((c, i) => {
      const e = edgeOf(room.outline, i);
      if (e.length > 0.6 && c < 0.5) add('warn', `Ściana ${i + 1} (${Math.round(e.length * 100)} cm) nie została zeskanowana jako ściana (${Math.round(c * 100)}% pokrycia). Sprawdź, czy obrys jest tu prawidłowy.`, { edge: i });
    });
  }
  if (area < 2) add('error', `Bardzo mała powierzchnia (${area.toFixed(1)} m²) — to raczej fragment pokoju.`);
  if (area > 80) add('warn', `Bardzo duża powierzchnia (${area.toFixed(1)} m²) — czy to nie kilka pokoi naraz?`);
  if (room.height < 2.1) add('warn', `Niska wysokość pokoju (${Math.round(room.height * 100)} cm) — sprawdź sufit.`);
  if (room.height > 4) add('warn', `Duża wysokość pokoju (${Math.round(room.height * 100)} cm) — sprawdź sufit.`);
  for (let i = 0; i < room.outline.length; i++) {
    const e = edgeOf(room.outline, i);
    if (e.length < 0.12) add('info', `Ściana ${i + 1} ma tylko ${Math.round(e.length * 100)} cm — może to błąd obrysu (do usunięcia narożnik).`, { edge: i });
  }

  // --- drzwi i okna ---
  const doors = (room.openings || []).filter((o) => o.type === 'door');
  if (!doors.length) add('warn', 'Nie ma żadnych drzwi — dodaj je (tryb „Ściany” → + Drzwi), żeby można było połączyć pokoje.');
  for (const d of doors) {
    if (d.width > 2.2) add('warn', `Bardzo szerokie drzwi (${Math.round(d.width * 100)} cm) — czy to nie dwa przejścia albo otwarte skrzydło?`, { edge: d.edge });
    if (d.height < 1.7) add('warn', `Niskie drzwi (${Math.round(d.height * 100)} cm).`, { edge: d.edge });
  }

  // --- pokrycie siatką ---
  const cov = meshCoverage(room, cell);
  let holes = [];
  if (cov.available) {
    const clusters = clusterHoles(cov.holes, cell).filter((c) => c.cells >= 3);
    holes = clusters.flatMap((c) => cov.holes.filter((h) => Math.hypot(h[0] - c.center[0], h[1] - c.center[1]) < Math.sqrt(c.area) * 1.2));
    const holeArea = clusters.reduce((s, c) => s + c.area, 0);
    if (holeArea >= 0.5) {
      add(holeArea > 2 ? 'error' : 'warn', `Niezeskanowane miejsca: ok. ${holeArea.toFixed(1)} m² (${Math.round((1 - cov.coverage) * 100)}% podłogi). Obejdź te miejsca w Space Setup — czerwone kafelki pokazują, gdzie.`, { point: clusters[0].center });
    }
    if (cov.outsideArea >= 1) add('warn', `Skan sięga ok. ${cov.outsideArea.toFixed(1)} m² poza obrys pokoju — obrys może być za mały albo w skanie jest kawałek sąsiedniego pomieszczenia.`);
  } else if (scan.source === 'quest') {
    add('info', 'Brak siatki skanu — nie da się sprawdzić, czy cały pokój jest zeskanowany.');
  }

  // --- meble ---
  const conflicts = computeConflicts(room);
  const items = room.furniture.filter((f) => !f.hidden);
  for (const f of items) {
    const name = `${f.name}`;
    const vol = f.w * f.d * f.h;
    if (f.w < 0.05 || f.d < 0.03 || f.h < 0.03) add('warn', `„${name}” jest bardzo mały (${Math.round(f.w * 100)}×${Math.round(f.d * 100)}×${Math.round(f.h * 100)} cm) — może to szum skanu.`, { fid: f.id });
    if (f.w * f.d > area * 0.4) add('error', `„${name}” zajmuje ${Math.round((f.w * f.d / Math.max(area, 0.01)) * 100)}% podłogi — to raczej błąd (np. bryła wielkości pokoju).`, { fid: f.id });
    if ((f.y || 0) + f.h > room.height + 0.05) add('warn', `„${name}” jest wyższy niż pokój (${Math.round(((f.y || 0) + f.h) * 100)} cm).`, { fid: f.id });
    const c = conflicts.get(f.id) || [];
    if (c.some((x) => x.kind === 'wall')) add('warn', `„${name}” wystaje za ścianę.`, { fid: f.id });
    // wiszący w powietrzu (nie stoi na podłodze ani na innym meblu)
    if ((f.y || 0) > 0.1 && !WALL_MOUNTED.has(f.type)) {
      const fp = furnitureFootprints(f);
      const support = items.some((o) => o !== f && Math.abs((o.y || 0) + o.h - (f.y || 0)) < 0.08 && footprintsIntersect(fp, furnitureFootprints(o)));
      if (!support) add('warn', `„${name}” (${typeName(f.type)}) wisi ${Math.round((f.y || 0) * 100)} cm nad podłogą i na niczym nie stoi.`, { fid: f.id });
    }
    // zdublowane bryły
    for (const o of items) {
      if (o.id <= f.id) continue;
      const ov = o.w * o.d * o.h;
      if (dist([f.x, f.z], [o.x, o.z]) < 0.25 && Math.min(vol, ov) / Math.max(vol, ov) > 0.6 && Math.abs((f.y || 0) - (o.y || 0)) < 0.15) {
        add('warn', `„${name}” i „${o.name}” wyglądają na tę samą bryłę zeskanowaną dwa razy (usuń jedną albo scal).`, { fid: f.id });
      }
    }
  }
  const unv = items.filter((f) => !f.verified).length;
  if (unv) add('info', `Do potwierdzenia typu: ${unv} mebli („Co to jest?”).`);
  if (!items.length) add('info', 'W pokoju nie ma żadnych mebli — jeśli są, zaznacz je w Space Setup albo dodaj ręcznie.');

  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  const verdict = issues.some((i) => i.level === 'error') ? 'error' : issues.some((i) => i.level === 'warn') ? 'warn' : 'ok';
  return { verdict, issues, holes, cell, coverage: cov.available ? cov.coverage : null };
}

export function verdictText(res) {
  const n = res.issues.filter((i) => i.level !== 'info').length;
  if (res.verdict === 'ok') return `✓ Skan wygląda dobrze${res.coverage !== null ? ` (pokrycie podłogi ${Math.round(res.coverage * 100)}%)` : ''}.`;
  return `${res.verdict === 'error' ? '✖' : '⚠'} Kontrola skanu: ${n} ${n === 1 ? 'uwaga' : n < 5 ? 'uwagi' : 'uwag'}${res.coverage !== null ? `, pokrycie podłogi ${Math.round(res.coverage * 100)}%` : ''}.`;
}
