import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeFromScan, applyScanShape } from '../src/scanShape.js';
import { createRoom, createFurniture } from '../src/model.js';
import { computeConflicts } from '../src/geometry.js';

// górne powierzchnie kanapy: siedzisko 0.45 m, oparcie 0.85 m (tył 20 cm), podłokietniki 0.65 m (po 20 cm)
function sofaMesh(cx, cz) {
  const pos = [], idx = [];
  const quad = (x0, z0, x1, z1, y) => {
    // zagęszczona siatka 5 cm
    for (let x = x0; x < x1 - 1e-9; x += 0.05) for (let z = z0; z < z1 - 1e-9; z += 0.05) {
      const n = pos.length / 3;
      const xa = cx + x, xb = cx + Math.min(x + 0.05, x1), za = cz + z, zb = cz + Math.min(z + 0.05, z1);
      pos.push(xa, y, za, xb, y, za, xb, y, zb, xa, y, zb);
      idx.push(n, n + 2, n + 1, n, n + 3, n + 2);
    }
  };
  quad(-1, -0.45, 1, -0.25, 0.85); // oparcie
  quad(-1, -0.25, -0.8, 0.45, 0.65); // podłokietnik lewy
  quad(0.8, -0.25, 1, 0.45, 0.65); // podłokietnik prawy
  quad(-0.8, -0.25, 0.8, 0.45, 0.45); // siedzisko
  quad(-3, -3, 3, 3, 0); // podłoga (ignorowana)
  // ściana za kanapą (pionowa — ignorowana)
  const n = pos.length / 3;
  pos.push(cx - 1, 0, cz - 0.47, cx + 1, 0, cz - 0.47, cx + 1, 2.5, cz - 0.47, cx - 1, 2.5, cz - 0.47);
  idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

test('kształt ze skanu: kanapa -> siedzisko, oparcie, podłokietniki', () => {
  const room = createRoom({ outline: [[-3, -3], [3, -3], [3, 3], [-3, 3]] });
  room.scan.mesh = sofaMesh(0, 0);
  const f = createFurniture({ type: 'couch', x: 0, z: 0, w: 2, d: 0.9, h: 0.85 });
  const res = shapeFromScan(room, f);
  assert.ok(!res.error, res.error);
  const hs = [...new Set(res.parts.map((p) => Math.round(p.h * 20) / 20))].sort();
  assert.ok(res.parts.length >= 3 && res.parts.length <= 10, `części: ${res.parts.length}`);
  assert.ok(hs.includes(0.45) && hs.includes(0.85), `wysokości ${hs}`);
  assert.equal(applyScanShape(room, f), null);
  assert.equal(f.shape, 'compound');
  // nad siedziskiem (0.45) półka na 0.5 m nie koliduje, nad oparciem tak
  const shelf = createFurniture({ x: 0, z: 0.15, y: 0.5, w: 0.3, d: 0.3, h: 0.1 });
  room.furniture.push(f, shelf);
  assert.ok(!computeConflicts(room).has(shelf.id));
  shelf.z = -0.35;
  assert.ok(computeConflicts(room).has(shelf.id));
});

test('kształt ze skanu bez siatki zwraca błąd', () => {
  const room = createRoom({});
  const f = createFurniture({ x: 0, z: 0 });
  assert.ok(shapeFromScan(room, f).error);
});
