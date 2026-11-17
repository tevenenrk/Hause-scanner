// Podgląd „na żywo” danych Space Setup: trójkątna siatka pokoju (global mesh), bryły mebli
// i płaszczyzny, nakładane na passthrough. Aktualizowane, gdy gogle zmienią dane (lastChangedTime).
import * as THREE from 'three';
import { normalizeLabel } from '../labels.js';

const PLANE_COLORS = {
  floor: 0x33cc66, ceiling: 0x8899aa, wall: 0x3399ff, 'wall face': 0x3399ff,
  door: 0xffaa00, 'door frame': 0xffaa00, window: 0x66ddff, 'window frame': 0x66ddff,
};

function planeGeometry(plane) {
  const contour = Array.from(plane.polygon || [], (p) => new THREE.Vector2(p.x, p.z));
  if (contour.length < 3) return null;
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const positions = new Float32Array(contour.length * 3);
  contour.forEach((p, i) => { positions[i * 3] = p.x; positions[i * 3 + 2] = p.y; });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(tris.flat());
  return g;
}

export class LiveSceneOverlay {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'liveScan';
    this.tracked = new Map();
    this.stats = { triangles: 0, meshes: 0, planes: 0, globalTriangles: 0 };
    this.showPlanes = true;
  }

  get visible() { return this.group.visible; }
  set visible(v) { this.group.visible = v; }

  _remove(entry) {
    this.group.remove(entry.object);
    entry.object.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }

  _build(item, kind) {
    const label = normalizeLabel(item.semanticLabel || (kind === 'plane' ? 'plane' : 'mesh'));
    const isGlobal = label === 'global mesh';
    if (kind === 'mesh') {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(item.vertices), 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(item.indices), 1));
      const obj = new THREE.Group();
      // wypełnienie (lekko) + krawędzie trójkątów
      obj.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: isGlobal ? 0x00ccff : 0xffcc33, transparent: true, opacity: isGlobal ? 0.08 : 0.12, side: THREE.DoubleSide, depthWrite: false })));
      obj.add(new THREE.Mesh(g.clone(), new THREE.MeshBasicMaterial({ color: isGlobal ? 0x66eeff : 0xffdd55, wireframe: true, transparent: true, opacity: isGlobal ? 0.45 : 0.7, depthWrite: false })));
      obj.userData = { label, triangles: item.indices.length / 3, isGlobal };
      return obj;
    }
    const g = planeGeometry(item);
    if (!g) return null;
    const color = PLANE_COLORS[label] ?? 0xcc66ff;
    const obj = new THREE.Group();
    obj.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false })));
    const pts = Array.from(item.polygon, (p) => new THREE.Vector3(p.x, 0.002, p.z));
    pts.push(pts[0].clone());
    obj.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })));
    obj.userData = { label, triangles: 0, isGlobal: false, plane: true };
    return obj;
  }

  _upsert(item, kind, frame, ref, seen) {
    seen.add(item);
    let entry = this.tracked.get(item);
    if (!entry || entry.changed !== item.lastChangedTime) {
      if (entry) this._remove(entry);
      const object = this._build(item, kind);
      if (!object) return;
      object.matrixAutoUpdate = false;
      this.group.add(object);
      entry = { object, changed: item.lastChangedTime, kind };
      this.tracked.set(item, entry);
    }
    const pose = frame.getPose(kind === 'mesh' ? item.meshSpace : item.planeSpace, ref);
    if (pose) {
      entry.object.matrix.fromArray(pose.transform.matrix);
      entry.object.matrixWorldNeedsUpdate = true;
      entry.object.visible = kind === 'mesh' || this.showPlanes;
    } else {
      entry.object.visible = false;
    }
  }

  /** Wywołuj w każdej klatce (wewnątrz callbacku XR). */
  update(frame, ref) {
    const seen = new Set();
    if (frame.detectedMeshes) for (const m of frame.detectedMeshes) this._upsert(m, 'mesh', frame, ref, seen);
    if (frame.detectedPlanes) for (const p of frame.detectedPlanes) this._upsert(p, 'plane', frame, ref, seen);
    for (const [item, entry] of this.tracked) {
      if (!seen.has(item)) { this._remove(entry); this.tracked.delete(item); }
    }
    let triangles = 0, meshes = 0, planes = 0, globalTriangles = 0;
    for (const e of this.tracked.values()) {
      if (e.kind === 'mesh') { meshes++; triangles += e.object.userData.triangles; if (e.object.userData.isGlobal) globalTriangles += e.object.userData.triangles; } else planes++;
    }
    this.stats = { triangles, meshes, planes, globalTriangles };
  }

  dispose() {
    for (const e of this.tracked.values()) this._remove(e);
    this.tracked.clear();
  }
}
