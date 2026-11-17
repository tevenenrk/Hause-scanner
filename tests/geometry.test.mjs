import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  minAreaRect, polygonArea, ensurePositive, computeConflicts, moveEdge, setEdgeLength, edgeOf,
  snapToWalls, computeClearances, furnitureFootprints, localToWorld, worldToLocal, rad, simplifyPolygon,
  alignRotationToNearestWall, doorZone, normalizeAngle,
} from '../src/geometry.js';
import { createRoom, createFurniture, createOpening, History, projectToJSON, projectFromJSON, createProject, createDemoProject } from '../src/model.js';

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} oczekiwano ${b}, jest ${a}`);

test('localToWorld / worldToLocal są odwrotne i zgodne z Three.js rotation.y', () => {
  const f = { x: 1, z: 2, rot: rad(90) };
  // obrót o +90° wokół Y: lokalne +X -> świat -Z
  const p = localToWorld(f, 1, 0);
  near(p[0], 1); near(p[1], 1);
  const l = worldToLocal(f, p[0], p[1]);
  near(l[0], 1); near(l[1], 0);
});

test('minAreaRect odtwarza obrócony prostokąt', () => {
  const f = { x: 0.5, z: -0.8, rot: rad(25), w: 2, d: 0.9, shape: 'box' };
  const pts = furnitureFootprints(f)[0];
  // dodajmy punkty wewnątrz
  pts.push([0.5, -0.8], [0.6, -0.7]);
  const r = minAreaRect(pts);
  near(r.x, 0.5, 1e-6); near(r.z, -0.8, 1e-6);
  near(r.w, 2, 1e-6); near(r.d, 0.9, 1e-6);
  near(Math.abs(normalizeAngle(r.rot - rad(25))) % Math.PI, 0, 1e-6, 'rot');
});

test('ensurePositive i simplifyPolygon', () => {
  const cw = [[0, 0], [0, 3], [4, 3], [4, 0]];
  assert.ok(polygonArea(cw) < 0);
  const p = ensurePositive(cw);
  assert.ok(polygonArea(p) > 0);
  const noisy = [[0, 0], [2, 0.002], [4, 0], [4, 3], [0, 3]];
  assert.equal(simplifyPolygon(noisy).length, 4);
});

test('konflikty: ściana, meble, strefa drzwi, piętrowanie', () => {
  const room = createRoom({ outline: [[0, 0], [4, 0], [4, 3], [0, 3]] });
  room.openings.push(createOpening({ type: 'door', edge: 0, offset: 1, width: 0.9 }));
  const a = createFurniture({ name: 'A', x: 3.0, z: 2.0, w: 1, d: 1, h: 1 });
  const b = createFurniture({ name: 'B', x: 3.4, z: 2.0, w: 1, d: 1, h: 1 }); // nachodzi na A i wystaje za ścianę x=4? 3.4+0.5=3.9 nie
  const c = createFurniture({ name: 'C', x: 0.2, z: 1.5, w: 1, d: 0.5, h: 1 }); // wystaje za ścianę x=0
  const lamp = createFurniture({ name: 'Lampa', x: 3.0, z: 2.0, y: 1.0, w: 0.3, d: 0.3, h: 0.5 }); // stoi na A
  const d = createFurniture({ name: 'D', x: 1.45, z: 0.4, w: 0.6, d: 0.6, h: 1 }); // w strefie drzwi
  const flush = createFurniture({ name: 'Flush', x: 0.5, z: 2.75, w: 1, d: 0.5, h: 1 }); // przy ścianie z=3 dokładnie
  room.furniture.push(a, b, c, lamp, d, flush);
  const conf = computeConflicts(room);
  assert.ok(conf.get(a.id).some((x) => x.kind === 'furniture' && x.otherId === b.id));
  assert.ok(!conf.get(a.id).some((x) => x.otherId === lamp.id), 'lampa na stole nie koliduje');
  assert.ok(conf.get(c.id).some((x) => x.kind === 'wall'));
  assert.ok(conf.get(d.id).some((x) => x.kind === 'door'));
  assert.ok(!conf.has(flush.id), 'mebel dosunięty do ściany nie koliduje');
  b.hidden = true;
  assert.ok(!computeConflicts(room).has(a.id), 'ukryty mebel nie koliduje');
});

test('kształt L: wcięcie nie koliduje', () => {
  const room = createRoom({ outline: [[0, 0], [6, 0], [6, 6], [0, 6]] });
  const L = createFurniture({ shape: 'L', x: 3, z: 3, w: 2.5, d: 1.6, aw: 0.9, ad: 0.9, h: 0.85 });
  // wcięcie jest w rogu (+x, +z) lokalnie
  const pouf = createFurniture({ x: 3 + 0.9, z: 3 + 0.6, w: 0.4, d: 0.4, h: 0.4 });
  room.furniture.push(L, pouf);
  assert.ok(!computeConflicts(room).has(pouf.id));
  pouf.x = 3 - 0.9; // w ramieniu
  assert.ok(computeConflicts(room).has(pouf.id));
});

test('moveEdge i setEdgeLength na prostokącie', () => {
  const r = [[0, 0], [4, 0], [4, 3], [0, 3]];
  const m = moveEdge(r, 1, 0.5); // ściana x=4 na zewnątrz o 0.5
  near(m[1][0], 4.5); near(m[2][0], 4.5); near(m[1][1], 0); near(m[2][1], 3);
  const s = setEdgeLength(r, 0, 5);
  near(edgeOf(s, 0).length, 5);
  near(edgeOf(s, 1).length, 3);
  const s2 = setEdgeLength(r, 1, 2.5);
  near(edgeOf(s2, 1).length, 2.5);
});

test('snapToWalls dosuwa mebel do ściany', () => {
  const room = createRoom({ outline: [[0, 0], [4, 0], [4, 3], [0, 3]] });
  const f = createFurniture({ x: 2, z: 0.33, w: 1, d: 0.6, h: 1, rot: 0 });
  const s = snapToWalls(room, f, 0.05);
  assert.ok(s);
  near(s.z, 0.3, 1e-9);
  const far = createFurniture({ x: 2, z: 1.5, w: 1, d: 0.6, h: 1 });
  assert.equal(snapToWalls(room, far, 0.05), null);
});

test('computeClearances mierzy odległości do ścian i mebli', () => {
  const room = createRoom({ outline: [[0, 0], [4, 0], [4, 3], [0, 3]] });
  const f = createFurniture({ x: 1, z: 1.5, w: 1, d: 0.6, h: 1 });
  const g = createFurniture({ x: 3, z: 1.5, w: 0.5, d: 0.5, h: 1 });
  room.furniture.push(f, g);
  const c = Object.fromEntries(computeClearances(room, f).map((x) => [x.dir, x.dist]));
  near(c['-x'], 0.5, 1e-9);
  near(c['+x'], 3 - 0.25 - 1.5, 1e-9);
  near(c['-z'], 1.2, 1e-9);
  near(c['+z'], 1.2, 1e-9);
});

test('alignRotationToNearestWall', () => {
  const room = createRoom({ outline: [[0, 0], [4, 0], [4, 3], [0, 3]] });
  const f = createFurniture({ x: 1, z: 0.5, w: 1, d: 0.6, h: 1, rot: rad(80) });
  near(Math.abs(alignRotationToNearestWall(room, f)), Math.PI / 2, 1e-9);
});

test('doorZone po stronie wnętrza', () => {
  const outline = [[0, 0], [4, 0], [4, 3], [0, 3]];
  const z = doorZone(outline, createOpening({ type: 'door', edge: 0, offset: 1, width: 0.8 }));
  assert.ok(z.every((p) => p[1] >= -1e-9));
  assert.equal(doorZone(outline, createOpening({ type: 'door', edge: 0, swing: 'out' })), null);
});

test('History: cofnij/ponów zachowuje siatkę skanu', () => {
  const p = createProject();
  const room = createRoom({});
  room.scan.mesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
  p.rooms.push(room);
  const h = new History(p);
  room.furniture.push(createFurniture({ name: 'X' }));
  assert.ok(h.commit(p));
  const undone = h.undo(p);
  assert.equal(undone.rooms[0].furniture.length, 0);
  assert.ok(undone.rooms[0].scan.mesh.positions instanceof Float32Array);
  const redone = h.redo(undone);
  assert.equal(redone.rooms[0].furniture.length, 1);
});

test('eksport/import JSON z siatką', () => {
  const p = createDemoProject();
  p.rooms[0].scan.mesh = { positions: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]), indices: new Uint32Array([0, 1, 2]) };
  const json = JSON.parse(JSON.stringify(projectToJSON(p)));
  const back = projectFromJSON(json);
  assert.equal(back.rooms.length, 2);
  assert.deepEqual(Array.from(back.rooms[0].scan.mesh.positions), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(back.rooms[0].furniture.length, p.rooms[0].furniture.length);
});

test('projekt demo: konflikty tylko dla zamierzonych przypadków', () => {
  const p = createDemoProject();
  for (const room of p.rooms) {
    const conf = computeConflicts(room);
    assert.equal(conf.size, 0, `${room.name}: ${JSON.stringify([...conf])}`);
  }
});

test('mergeFurniture: dwie bryły -> jeden mebel obejmujący obie', async () => {
  const { mergeFurniture, findFurniture } = await import('../src/model.js');
  const p = createProject();
  const room = createRoom({ outline: [[0, 0], [5, 0], [5, 4], [0, 4]] });
  const a = createFurniture({ type: 'couch', x: 1, z: 1, w: 1.0, d: 0.9, h: 0.8, verified: false, sourceLabel: 'couch' });
  const b = createFurniture({ type: 'other', x: 2, z: 1, w: 1.0, d: 0.9, h: 0.45, y: 0, verified: false, sourceLabel: 'other' });
  const c = createFurniture({ name: 'Zostaje', x: 4, z: 3 });
  room.furniture.push(a, b, c);
  p.rooms.push(room);
  const m = mergeFurniture(p, [a.id, b.id]);
  assert.ok(m);
  assert.equal(room.furniture.length, 2);
  assert.ok(!findFurniture(p, a.id) && !findFurniture(p, b.id));
  near(m.w, 2.0, 1e-9); near(m.d, 0.9, 1e-9); near(m.h, 0.8, 1e-9);
  near(m.x, 1.5, 1e-9); near(m.z, 1, 1e-9);
  assert.equal(m.type, 'couch');
  assert.equal(m.sourceLabel, 'couch + other');
  assert.equal(mergeFurniture(p, [m.id]), null);
});
