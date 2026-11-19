import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRoom, meshCoverage } from '../src/scanCheck.js';
import { createRoom, createFurniture, createOpening } from '../src/model.js';

// siatka podłogi z trójkątów 20 cm, z pominięciem prostokąta „dziury”
function floorMesh(x0, z0, x1, z1, hole) {
  const pos = [], idx = [];
  for (let x = x0; x < x1 - 1e-9; x += 0.2) for (let z = z0; z < z1 - 1e-9; z += 0.2) {
    const cx = x + 0.1, cz = z + 0.1;
    if (hole && cx > hole[0] && cx < hole[2] && cz > hole[1] && cz < hole[3]) continue;
    const n = pos.length / 3;
    pos.push(x, 0, z, x + 0.2, 0, z, x + 0.2, 0, z + 0.2, x, 0, z + 0.2);
    idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

function goodRoom() {
  const room = createRoom({ outline: [[0, 0], [4, 0], [4, 3], [0, 3]], height: 2.6 });
  room.scan = { source: 'quest', hadFloorPlane: true, hadCeiling: true, wallPlanes: 4, edgeWallCoverage: [1, 1, 1, 1], mesh: floorMesh(0, 0, 4, 3) };
  room.openings.push(createOpening({ type: 'door', edge: 0, offset: 1, width: 0.9 }));
  room.furniture.push(createFurniture({ type: 'table', x: 2, z: 1.5, w: 1.2, d: 0.8, h: 0.75 }));
  return room;
}

test('poprawny pokój: werdykt ok, pełne pokrycie', () => {
  const r = checkRoom(goodRoom());
  assert.equal(r.verdict, 'ok', JSON.stringify(r.issues));
  assert.ok(r.coverage > 0.99);
});

test('wykrywa dziurę w skanie, brak ściany, wiszący i zdublowany mebel, brak drzwi', () => {
  const room = goodRoom();
  room.scan.mesh = floorMesh(0, 0, 4, 3, [2.6, 0.6, 3.8, 2.4]);
  room.scan.edgeWallCoverage = [1, 0.1, 1, 1];
  room.openings = [];
  room.furniture.push(createFurniture({ type: 'table', x: 2.05, z: 1.5, w: 1.2, d: 0.8, h: 0.75 })); // duplikat
  room.furniture.push(createFurniture({ type: 'bed', x: 1, z: 2.3, y: 0.6, w: 0.8, d: 0.5, h: 0.4 })); // wisi
  room.furniture.push(createFurniture({ type: 'other', x: 2, z: 1.5, w: 3.9, d: 2.9, h: 2.5, name: 'Bryła pokoju' })); // wielkości pokoju
  const r = checkRoom(room);
  const txt = r.issues.map((i) => i.text).join('\n');
  assert.equal(r.verdict, 'error');
  assert.match(txt, /Niezeskanowane miejsca/);
  assert.ok(r.holes.length > 10);
  assert.match(txt, /Ściana 2/);
  assert.match(txt, /Nie ma żadnych drzwi/);
  assert.match(txt, /dwa razy/);
  assert.match(txt, /wisi 60 cm/);
  assert.match(txt, /Bryła pokoju.*podłogi/);
  assert.ok(r.issues.find((i) => /wisi/.test(i.text)).fid);
});

test('meshCoverage bez siatki', () => {
  const room = createRoom({});
  assert.equal(meshCoverage(room).available, false);
});
