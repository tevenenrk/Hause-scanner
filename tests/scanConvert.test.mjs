import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertScene, mat4TransformPoint, mat4InvertRigid, mat4Multiply } from '../src/scanConvert.js';
import { rad, polygonArea, normalizeAngle } from '../src/geometry.js';

const near = (a, b, eps = 1e-4, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} oczekiwano ${b}, jest ${a}`);

// macierz: obrót wokół Y (jak three.js) + przesunięcie, kolumnowo
function poseY(theta, tx, ty, tz) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, ty, tz, 1];
}
// płaszczyzna podłogi z normalną w dół (test odporności)
function flipped(m) {
  return mat4Multiply(m, [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);
}

const ROOM = poseY(rad(30), 1, 0.02, -2); // układ pokoju w świecie
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const toWorld = (x, y, z) => mat4TransformPoint(ROOM, x, y, z);

function boxVerts(cx, cz, w, d, y0, h, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const out = [];
  for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) {
    for (const y of [y0, y0 + h]) {
      const x = cx + lx * c + lz * s, z = cz - lx * s + lz * c;
      out.push(...toWorld(x, y, z));
    }
  }
  return new Float32Array(out);
}

function makeScene({ flipFloor = false } = {}) {
  const corners = [[-2, -1.5], [2, -1.5], [2, 1.5], [-2, 1.5]];
  const planes = [];
  planes.push({ label: 'FLOOR', matrix: flipFloor ? flipped(ROOM) : ROOM, polygon: flipFloor ? corners.map(([x, z]) => [x, 0, -z]) : corners.map(([x, z]) => [x, 0, z]) });
  planes.push({ label: 'CEILING', matrix: I, polygon: corners.map(([x, z]) => toWorld(x, 2.5, z)) });
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    planes.push({ label: 'WALL_FACE', matrix: I, polygon: [toWorld(a[0], 0, a[1]), toWorld(b[0], 0, b[1]), toWorld(b[0], 2.5, b[1]), toWorld(a[0], 2.5, a[1])] });
  }
  // drzwi na ścianie z = 1.5 od x=-1.5 do -0.6
  planes.push({ label: 'DOOR_FRAME', matrix: I, polygon: [toWorld(-1.5, 0, 1.5), toWorld(-0.6, 0, 1.5), toWorld(-0.6, 2.05, 1.5), toWorld(-1.5, 2.05, 1.5)] });
  // okno na ścianie x = 2
  planes.push({ label: 'window', matrix: I, polygon: [toWorld(2, 0.9, -0.5), toWorld(2, 0.9, 0.7), toWorld(2, 2.1, 0.7), toWorld(2, 2.1, -0.5)] });
  // blat stołu (tylko płaszczyzna)
  planes.push({ label: 'TABLE', matrix: I, polygon: [[0.6, 0.35], [1.8, 0.35], [1.8, 0.85], [0.6, 0.85]].map(([x, z]) => toWorld(x, 0.75, z)) });
  // blat kanapy (płaszczyzna pokrywająca się z bryłą — nie może się zdublować)
  planes.push({ label: 'COUCH', matrix: I, polygon: [[0, -1], [1, -1], [1, -0.6], [0, -0.6]].map(([x, z]) => toWorld(x, 0.45, z)) });
  const meshes = [
    { label: 'COUCH', matrix: I, vertices: boxVerts(0.5, -0.8, 2, 0.9, 0, 0.8, rad(10)), indices: new Uint32Array([0, 1, 2]) },
    { label: 'LAMP', matrix: I, vertices: boxVerts(-1.7, -1.2, 0.3, 0.3, 0, 1.6, 0), indices: new Uint32Array([0, 1, 2]) },
    { label: 'GLOBAL_MESH', matrix: I, vertices: new Float32Array([...toWorld(0, 0, 0), ...toWorld(1, 0, 0), ...toWorld(0, 0, 1)]), indices: new Uint32Array([0, 1, 2]) },
  ];
  return { planes, meshes };
}

for (const flipFloor of [false, true]) {
  test(`convertScene: obrócony pokój (podłoga ${flipFloor ? 'odwrócona' : 'normalna'})`, () => {
    const { room, stats } = convertScene(makeScene({ flipFloor }));
    near(Math.abs(polygonArea(room.outline)), 12, 1e-3, 'pole');
    assert.equal(room.outline.length, 4);
    near(room.height, 2.5, 1e-3, 'wysokość');
    assert.equal(stats.walls, 4);

    // drzwi i okno
    const door = room.openings.find((o) => o.type === 'door');
    const win = room.openings.find((o) => o.type === 'window');
    assert.ok(door && win);
    near(door.width, 0.9, 1e-3, 'szer. drzwi');
    near(door.sill, 0, 1e-6);
    near(win.width, 1.2, 1e-3, 'szer. okna');
    near(win.sill, 0.9, 1e-3, 'parapet');

    // meble: kanapa (z bryły), lampa, stół (z płaszczyzny); kanapa z płaszczyzny nie dubluje się
    const byType = (t) => room.furniture.filter((f) => f.type === t);
    assert.equal(byType('couch').length, 1, 'jedna kanapa');
    assert.equal(byType('lamp').length, 1);
    assert.equal(byType('table').length, 1);
    const couch = byType('couch')[0];
    // pozycja w układzie pokoju jest niezależna od obrotu świata; układ może być przesunięty
    // (początek = środek podłogi), więc sprawdzamy względem obrysu
    const cx = room.outline.reduce((s, p) => s + p[0], 0) / 4;
    const cz = room.outline.reduce((s, p) => s + p[1], 0) / 4;
    const flip = 1; // odwrócona podłoga jest prostowana, więc układ pokoju jest ten sam
    near(couch.x - cx, 0.5, 1e-3, 'kanapa x');
    near((couch.z - cz) * flip, -0.8, 1e-3, 'kanapa z');
    near(couch.w, 2, 1e-3); near(couch.d, 0.9, 1e-3); near(couch.h, 0.8, 1e-3);
    const dr = Math.abs(normalizeAngle(couch.rot - flip * rad(10)));
    assert.ok(dr < 1e-3 || Math.abs(dr - Math.PI) < 1e-3, `obrót kanapy ${couch.rot}`);
    assert.equal(couch.verified, false);
    assert.ok(couch.scanned);
    const table = byType('table')[0];
    near(table.h, 0.75, 1e-3); near(table.w, 1.2, 1e-3); near(table.d, 0.5, 1e-3);

    assert.ok(room.scan.mesh && room.scan.mesh.positions.length === 9);
    // siatka globalna w układzie pokoju: y ≈ 0
    near(room.scan.mesh.positions[1], 0, 1e-4);
  });
}

test('convertScene bez podłogi buduje obrys ze ścian', () => {
  const s = makeScene();
  s.planes = s.planes.filter((p) => p.label !== 'FLOOR');
  const { room, stats } = convertScene(s);
  near(Math.abs(polygonArea(room.outline)), 12, 0.05, 'pole');
  assert.ok(stats.warnings.length > 0);
});

test('convertScene na pustych danych daje prostokąt zastępczy', () => {
  const { room, stats } = convertScene({ planes: [], meshes: [] });
  assert.equal(room.outline.length, 4);
  assert.ok(stats.warnings.length);
});

test('mat4InvertRigid', () => {
  const inv = mat4InvertRigid(ROOM);
  const p = mat4TransformPoint(inv, ...toWorld(0.3, 1.2, -0.7));
  near(p[0], 0.3); near(p[1], 1.2); near(p[2], -0.7);
});

// ---------- kilka pokoi w jednym Space Setup ----------
function twoRoomScene() {
  // pokój A: x∈[0,4], z∈[0,3]; pokój B: x∈[4.12,7.12], z∈[0,3] (ściana 12 cm)
  const rect = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const A = rect(0, 0, 4, 3), B = rect(4.12, 0, 7.12, 3);
  const floorPlane = (r) => {
    const cx = (r[0][0] + r[2][0]) / 2, cz = (r[0][1] + r[2][1]) / 2;
    return { label: 'floor', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, cx, 0, cz, 1], polygon: r.map(([x, z]) => [x - cx, 0, z - cz]) };
  };
  const wallsOf = (r) => r.map((a, i) => { const b = r[(i + 1) % 4]; return { label: 'wall', matrix: I, polygon: [[a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], 2.5, b[1]], [a[0], 2.5, a[1]]] }; });
  const box = (cx, cz, w, d, h) => { const v = []; for (const [x, z] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) for (const y of [0, h]) v.push(cx + x, y, cz + z); return new Float32Array(v); };
  // „globalna” siatka pokoju B bez etykiety: dużo wierzchołków
  const gv = [];
  for (let i = 0; i < 400; i++) gv.push(4.2 + Math.random() * 2.8, Math.random() * 2.4, 0.1 + Math.random() * 2.8);
  const planes = [
    floorPlane(A), floorPlane(B), ...wallsOf(A), ...wallsOf(B),
    { label: 'ceiling', matrix: I, polygon: A.map(([x, z]) => [x, 2.5, z]) },
    { label: 'ceiling', matrix: I, polygon: B.map(([x, z]) => [x, 2.7, z]) },
    // drzwi między pokojami, zaznaczone dwa razy (po obu stronach i nakładające się)
    { label: 'door', matrix: I, polygon: [[4, 0, 1], [4, 0, 1.9], [4, 2, 1.9], [4, 2, 1]] },
    { label: 'door', matrix: I, polygon: [[4, 0, 1.2], [4, 0, 2.0], [4, 2, 2.0], [4, 2, 1.2]] },
  ];
  const meshes = [
    { label: 'couch', matrix: I, vertices: box(1.5, 1, 2, 0.9, 0.8), indices: new Uint32Array([0, 1, 2]) },
    { label: 'bed', matrix: I, vertices: box(5.6, 1.5, 1.6, 2, 0.5), indices: new Uint32Array([0, 1, 2]) },
    { label: 'other', matrix: I, vertices: new Float32Array(gv), indices: new Uint32Array([0, 1, 2, 3, 4, 5]) },
  ];
  return { planes, meshes };
}

test('wiele pokoi: wybór pokoju, w którym stoi użytkownik, bez elementów sąsiedniego', async () => {
  const s = twoRoomScene();
  const a = convertScene(s, { viewerPoint: [1, 1] }).room;
  near(Math.abs(polygonArea(a.outline)), 12, 1e-3);
  near(a.height, 2.5, 1e-3);
  assert.deepEqual(a.furniture.map((f) => f.type), ['couch']);
  assert.equal(a.openings.filter((o) => o.type === 'door').length, 1, 'zdublowane drzwi scalone');
  near(a.openings[0].width, 1.0, 1e-3);
  const b = convertScene(s, { viewerPoint: [6, 1] }).room;
  near(Math.abs(polygonArea(b.outline)), 9, 1e-3);
  near(b.height, 2.7, 1e-3);
  assert.deepEqual(b.furniture.map((f) => f.type), ['bed'], 'siatka bez etykiety nie staje się bryłą wielkości pokoju');
  assert.ok(b.scan.mesh.positions.length > 0);
});

test('convertAllRooms układa pokoje względem siebie', async () => {
  const { convertAllRooms } = await import('../src/scanConvert.js');
  const res = convertAllRooms(twoRoomScene());
  assert.equal(res.length, 2);
  const [ra, rb] = res.map((r) => r.room);
  // środek pokoju B w układzie mieszkania = 4.12 m dalej w osi X niż A (oba środki: A (2,1.5), B (5.62,1.5))
  near(rb.transform.x - ra.transform.x, 3.62, 1e-3);
  near(rb.transform.z - ra.transform.z, 0, 1e-3);
});
