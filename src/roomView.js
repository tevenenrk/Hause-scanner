// Budowanie sceny Three.js z modelu (wspólne dla edytora na PC i trybu MR).
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { edgeOf, openingSegment, doorZone, furnitureOutline, furnitureLocalParts } from './geometry.js';
import { typeName } from './labels.js';

export const WALL_T = 0.1;
const COLOR_SELECTED = 0xffd400;
const COLOR_CONFLICT = 0xff3030;
const COLOR_WARN = 0xff9b20;

function furnitureGeometry(f) {
  if (f.shape === 'cylinder') {
    const g = new THREE.CylinderGeometry(0.5, 0.5, f.h, 32);
    g.scale(f.w, 1, f.d);
    g.translate(0, f.h / 2, 0);
    return g;
  }
  if (f.shape === 'L') {
    const hw = f.w / 2, hd = f.d / 2;
    const aw = Math.min(f.aw || hw, f.w), ad = Math.min(f.ad || hd, f.d);
    const loc = [[-hw, -hd], [hw, -hd], [hw, -hd + ad], [-hw + aw, -hd + ad], [-hw + aw, hd], [-hw, hd]];
    const shape = new THREE.Shape(loc.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: f.h, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    return g;
  }
  const g = new THREE.BoxGeometry(f.w, f.h, f.d);
  g.translate(0, f.h / 2, 0);
  return g;
}

function makeLabel(text, cls = 'label3d') {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  const obj = new CSS2DObject(el);
  obj.userData.isLabel = true;
  return obj;
}

export class ApartmentView {
  /**
   * @param {object} opts
   *  mode: 'editor' | 'mr'
   *  cssLabels: czy tworzyć etykiety CSS2D (tylko edytor)
   */
  constructor(opts = {}) {
    this.mode = opts.mode || 'editor';
    this.cssLabels = opts.cssLabels ?? this.mode === 'editor';
    this.group = new THREE.Group();
    this.group.name = 'apartment';
    this.roomGroups = new Map();
    this.furnitureObjects = new Map();
    this.pickables = [];
    // look: wygląd w goglach { wallStyle: 'off'|'edges'|'transparent'|'solid', wallOpacity, furnStyle: 'solid'|'edges', furnOpacity, floor }
    this.options = { look: null, cameras: null, showCameras: true, wallMode: 'full', showMesh: false, showGhosts: true, showLabels: true, showZones: true, selectedId: null, conflicts: new Map(), selection: null, mode: 'furniture' };
    this.materials = {
      floor: new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.95, side: THREE.DoubleSide }),
      floorSel: new THREE.MeshStandardMaterial({ color: 0xd9e8ff, roughness: 0.95, side: THREE.DoubleSide }),
      wall: new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.9 }),
      wallSel: new THREE.MeshStandardMaterial({ color: 0xffe680, roughness: 0.9 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x8fc8ff, transparent: true, opacity: 0.35, roughness: 0.1 }),
      zone: new THREE.MeshBasicMaterial({ color: COLOR_WARN, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }),
      mesh: new THREE.MeshBasicMaterial({ color: 0x5577aa, wireframe: true, transparent: true, opacity: 0.22, depthWrite: false }),
      hiddenPick: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false, side: THREE.DoubleSide }),
      outline: new THREE.LineBasicMaterial({ color: 0x00e0ff }),
      outlineSel: new THREE.LineBasicMaterial({ color: COLOR_SELECTED }),
      ghost: new THREE.LineDashedMaterial({ color: 0x777777, dashSize: 0.08, gapSize: 0.05 }),
      doorArc: new THREE.LineBasicMaterial({ color: 0x8a6d3b }),
    };
  }

  setOptions(o) { Object.assign(this.options, o); }

  dispose() {
    // poprawiony model (GLB) ma własne zasoby współdzielone z pamięcią podręczną — nie zwalniamy ich tutaj
    if (this.refRoot && this.refRoot.parent) this.refRoot.parent.remove(this.refRoot);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.userData.ownMaterial) o.material.dispose();
      if (o.isCSS2DObject && o.element && o.element.parentNode) o.element.parentNode.removeChild(o.element);
    });
    this.group.clear();
  }

  /** Czy pokazujemy poprawiony model (GLB) zamiast brył. */
  get refActive() {
    return !!(this.options.refModel && this.options.refShow && this.options.refShow !== 'boxes');
  }

  rebuild(project) {
    this.dispose();
    this.project = project;
    this.roomGroups.clear();
    this.furnitureObjects.clear();
    this.pickables = [];
    const rm = this.refActive ? this.options.refModel : null;
    this.refRoot = rm ? rm.root : null;
    for (const room of project.rooms) {
      const g = this.buildRoom(room);
      this.group.add(g);
      this.roomGroups.set(room.id, g);
    }
    if (this.options.showCameras && Array.isArray(this.options.cameras)) {
      for (const cam of this.options.cameras) if (cam.id !== this.options.hiddenCameraId) this.group.add(this.buildCamera(cam));
    }
    if (rm) {
      const st = this.options.refSettings || {};
      rm.setOffset(st.offset);
      rm.blackout = !!this.options.refBlackout;
      rm.setLook(this.options.refLook || {});
      rm.sync(project, st);
      this.group.add(rm.root);
      // klik w realistyczny mebel zaznacza jego bryłę
      for (const p of rm.pieceList) {
        const b = rm.binding[p.key];
        const hit = b && rm.byFid.get(b.fid) === p ? this.furnitureObjects.get(b.fid) : null;
        p.obj.traverse((o) => {
          if (!o.isMesh) return;
          if (hit && p.obj.visible) {
            Object.assign(o.userData, { kind: 'furniture', id: b.fid, roomId: hit.userData.roomId });
            this.pickables.push(o);
          } else if (o.userData.kind === 'furniture') {
            delete o.userData.kind;
          }
        });
      }
      rm.updateCutaway(this.lastEye || null);
    }
    this.applyHighlights();
  }

  /** Przekrój poprawionego modelu względem oka (pozycja w układzie świata). */
  updateCutaway(eyeWorld) {
    if (!this.refRoot || !this.refRoot.parent) return;
    this.lastEye = this.group.worldToLocal(eyeWorld.clone());
    this.options.refModel.updateCutaway(this.lastEye);
  }

  buildRoom(room) {
    const g = new THREE.Group();
    g.name = `room:${room.name}`;
    g.userData.roomId = room.id;
    const t = room.transform || { x: 0, z: 0, rot: 0 };
    g.position.set(t.x, 0, t.z);
    g.rotation.y = t.rot;
    const sel = this.options.selection;
    const outline = room.outline;
    const isMR = this.mode === 'mr';
    const look = this.options.look;

    // podłoga
    const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
    const floorGeo = new THREE.ShapeGeometry(shape);
    floorGeo.rotateX(-Math.PI / 2);
    const ref = this.refActive;
    if (ref || (look ? look.floor : !isMR)) {
      const roomSelected = sel && sel.kind === 'room' && sel.roomId === room.id;
      const floor = new THREE.Mesh(floorGeo, ref ? this.materials.hiddenPick : roomSelected ? this.materials.floorSel : this.materials.floor);
      floor.receiveShadow = true;
      floor.userData = { kind: 'floor', roomId: room.id };
      floor.name = 'floor';
      g.add(floor);
      this.pickables.push(floor);
    } else {
      floorGeo.dispose();
    }

    // obrys (linia na podłodze) — w MR główna wskazówka wyrównania
    const pts = outline.map(([x, z]) => new THREE.Vector3(x, 0.005, z));
    pts.push(pts[0].clone());
    const ol = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.materials.outline);
    ol.userData.kind = 'outline';
    if (!ref && (isMR || this.options.mode === 'walls')) g.add(ol); else ol.geometry.dispose();
    if (isMR && !ref && !(look && look.wallStyle !== 'off')) {
      const top = pts.map((p) => new THREE.Vector3(p.x, room.height, p.z));
      const tl = new THREE.Line(new THREE.BufferGeometry().setFromPoints(top), new THREE.LineBasicMaterial({ color: 0x00e0ff, transparent: true, opacity: 0.35 }));
      tl.userData.ownMaterial = true;
      g.add(tl);
    }

    // ściany i otwory
    const drawWalls = !ref && (look ? look.wallStyle !== 'off' : (!isMR && this.options.wallMode !== 'hidden'));
    if (drawWalls) {
      const wallH = this.options.wallMode === 'low' ? Math.min(1.0, room.height) : room.height;
      this.wallLook = look ? this.makeWallLook(look) : null;
      for (let i = 0; i < outline.length; i++) this.buildWall(g, room, i, wallH);
    }
    const clipH = !isMR && this.options.wallMode === 'low' ? Math.min(1.0, room.height) : Infinity;
    if (!ref) for (const op of room.openings || []) this.buildOpeningMarks(g, room, op, isMR, clipH);

    // strefy drzwi
    if (!isMR && !ref && this.options.showZones) {
      for (const op of room.openings || []) {
        const zone = doorZone(outline, op);
        if (!zone) continue;
        const zs = new THREE.Shape(zone.map(([x, z]) => new THREE.Vector2(x, -z)));
        const zg = new THREE.ShapeGeometry(zs);
        zg.rotateX(-Math.PI / 2);
        const zm = new THREE.Mesh(zg, this.materials.zone);
        zm.position.y = 0.006;
        zm.renderOrder = 1;
        g.add(zm);
      }
    }

    // meble
    for (const f of room.furniture) {
      if (f.hidden) continue;
      const obj = this.buildFurniture(f, room);
      g.add(obj);
      this.furnitureObjects.set(f.id, obj);
      if (!isMR && !ref && this.options.showGhosts && f.scanned) {
        const ghost = this.buildGhost(f);
        if (ghost) g.add(ghost);
      }
    }

    // siatka ze skanu
    if (this.options.showMesh && room.scan && room.scan.mesh && room.scan.mesh.positions.length) {
      const mg = new THREE.BufferGeometry();
      mg.setAttribute('position', new THREE.BufferAttribute(room.scan.mesh.positions, 3));
      if (room.scan.mesh.indices && room.scan.mesh.indices.length) mg.setIndex(new THREE.BufferAttribute(room.scan.mesh.indices, 1));
      const m = new THREE.Mesh(mg, this.materials.mesh);
      m.userData.kind = 'scanMesh';
      m.renderOrder = 2;
      g.add(m);
    }

    // nazwa pokoju
    if (this.cssLabels && this.options.showLabels && this.options.mode === 'rooms') {
      let cx = 0, cz = 0;
      for (const [x, z] of outline) { cx += x; cz += z; }
      const lab = makeLabel(room.name, 'label3d room');
      lab.position.set(cx / outline.length, 0.1, cz / outline.length);
      g.add(lab);
    }
    return g;
  }

  /** Materiały ścian dla wyglądu w goglach (półprzezroczyste / krawędzie). */
  makeWallLook(look) {
    if (this.wallLookCache && this.wallLookCache.key === JSON.stringify(look)) return this.wallLookCache;
    const op = look.wallStyle === 'solid' ? 1 : look.wallStyle === 'edges' ? 0 : look.wallOpacity;
    const mat = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.9, transparent: op < 1, opacity: op, depthWrite: op >= 1, colorWrite: op > 0 });
    const edge = new THREE.LineBasicMaterial({ color: 0x00d0ff, transparent: true, opacity: look.wallStyle === 'edges' ? 0.95 : 0.35 });
    const selMat = new THREE.MeshStandardMaterial({ color: 0xffd400, transparent: true, opacity: 0.55, depthWrite: false, emissive: 0x806a00 });
    this.wallLookCache = { key: JSON.stringify(look), mat, selMat, edge, edges: look.wallStyle === 'edges' || look.wallStyle === 'transparent' };
    return this.wallLookCache;
  }

  buildWall(g, room, i, wallH) {
    const e = edgeOf(room.outline, i);
    if (e.length < 0.01) return;
    const sel = this.options.selection;
    const selected = sel && sel.kind === 'edge' && sel.roomId === room.id && sel.index === i;
    const wl = this.wallLook;
    const mat = selected ? (wl ? wl.selMat : this.materials.wallSel) : wl ? wl.mat : this.materials.wall;
    const ops = (room.openings || []).filter((o) => o.edge % room.outline.length === i)
      .map((o) => ({ o, s: Math.max(0, Math.min(o.offset, e.length)), t: Math.min(e.length, o.offset + o.width) }))
      .sort((a, b) => a.s - b.s);
    const out = [-e.inward[0], -e.inward[1]];
    const angle = -Math.atan2(e.dir[1], e.dir[0]);
    const addPiece = (s, t, y0, y1) => {
      if (t - s < 0.005 || y1 - y0 < 0.005) return;
      const ext0 = s <= 0.0001 ? WALL_T : 0, ext1 = t >= e.length - 0.0001 ? WALL_T : 0;
      const L = t - s + ext0 + ext1;
      const geo = new THREE.BoxGeometry(L, y1 - y0, WALL_T);
      const m = new THREE.Mesh(geo, mat);
      const mid = (s - ext0 + t + ext1) / 2;
      m.position.set(e.a[0] + e.dir[0] * mid + out[0] * WALL_T / 2, (y0 + y1) / 2, e.a[1] + e.dir[1] * mid + out[1] * WALL_T / 2);
      m.rotation.y = angle;
      m.receiveShadow = true;
      m.userData = { kind: 'wall', roomId: room.id, index: i };
      g.add(m);
      this.pickables.push(m);
      if (wl && wl.edges) {
        const el = new THREE.LineSegments(new THREE.EdgesGeometry(geo), wl.edge);
        el.position.copy(m.position);
        el.rotation.copy(m.rotation);
        g.add(el);
      }
    };
    let cur = 0;
    for (const { o, s, t } of ops) {
      addPiece(cur, s, 0, wallH);
      const sill = Math.min(o.sill || 0, wallH);
      const top = Math.min((o.sill || 0) + o.height, wallH);
      addPiece(s, t, 0, sill);
      addPiece(s, t, top, wallH);
      cur = Math.max(cur, t);
    }
    addPiece(cur, e.length, 0, wallH);
  }

  buildOpeningMarks(g, room, op, isMR, clipH = Infinity) {
    const { p0, p1, edge } = openingSegment(room.outline, op);
    const sel = this.options.selection;
    const selected = sel && sel.kind === 'opening' && sel.id === op.id;
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (len < 0.01) return;
    const angle = -Math.atan2(edge.dir[1], edge.dir[0]);
    const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    const out = [-edge.inward[0], -edge.inward[1]];
    // ramka (pick + widoczność) — przycięta do wysokości obniżonych ścian
    const y0 = op.sill || 0;
    const y1 = Math.min(y0 + op.height, clipH);
    const visH = y1 - y0;
    const frameGeo = new THREE.BoxGeometry(len, Math.max(0.02, visH), WALL_T * 1.15);
    const frameMat = op.type === 'window' ? this.materials.glass : new THREE.MeshStandardMaterial({ color: selected ? COLOR_SELECTED : 0xb08850, transparent: true, opacity: isMR ? 0.25 : 0.18 });
    const frame = new THREE.Mesh(frameGeo, selected && op.type === 'window' ? new THREE.MeshStandardMaterial({ color: COLOR_SELECTED, transparent: true, opacity: 0.5 }) : frameMat);
    if (frame.material !== this.materials.glass) frame.userData.ownMaterial = true;
    frame.position.set(mid[0] + out[0] * WALL_T / 2, y0 + Math.max(0.02, visH) / 2, mid[1] + out[1] * WALL_T / 2);
    frame.rotation.y = angle;
    frame.userData = { ...frame.userData, kind: 'opening', roomId: room.id, id: op.id };
    if (visH <= 0.01) {
      // okno powyżej obniżonej ściany: zostaw tylko cienki znacznik na krawędzi ściany
      frame.scale.y = 1;
      frame.position.y = clipH - 0.01;
    }
    g.add(frame);
    this.pickables.push(frame);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(frameGeo), selected ? this.materials.outlineSel : new THREE.LineBasicMaterial({ color: op.type === 'door' ? 0x8a6d3b : 0x3a7bd5 }));
    if (!selected) edges.userData.ownMaterial = true;
    edges.position.copy(frame.position);
    edges.rotation.copy(frame.rotation);
    g.add(edges);
    // łuk otwierania drzwi
    if (op.type === 'door' && op.swing !== 'none') {
      const dirIn = op.swing === 'out' ? out : edge.inward;
      const r = len;
      const pts = [];
      for (let k = 0; k <= 16; k++) {
        const a = (k / 16) * (Math.PI / 2);
        const v = [edge.dir[0] * Math.cos(a) + dirIn[0] * Math.sin(a), edge.dir[1] * Math.cos(a) + dirIn[1] * Math.sin(a)];
        pts.push(new THREE.Vector3(p0[0] + v[0] * r, 0.01, p0[1] + v[1] * r));
      }
      pts.push(new THREE.Vector3(p0[0], 0.01, p0[1]));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.materials.doorArc));
    }
  }

  /** Kamera zdjęcia: ostrosłup widzenia (skąd i w którą stronę zrobiono zdjęcie). */
  buildCamera(cam) {
    const g = new THREE.Group();
    const sel = this.options.selection && this.options.selection.kind === 'camera' && this.options.selection.id === cam.id;
    const color = sel ? COLOR_SELECTED : 0xff2e88;
    const pos = new THREE.Vector3(...cam.pos), target = new THREE.Vector3(...cam.target);
    const m = new THREE.Matrix4().lookAt(pos, target, new THREE.Vector3(0, 1, 0));
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    const L = this.options.cameraSize || 0.45; // długość ostrosłupa [m]
    const hh = Math.tan(((cam.fov || 55) * Math.PI) / 360) * L, hw = hh * (cam.aspect || 4 / 3);
    const c = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => new THREE.Vector3(x, y, -L));
    const pts = [];
    for (const v of c) pts.push(new THREE.Vector3(), v);
    for (let i = 0; i < 4; i++) pts.push(c[i], c[(i + 1) % 4]);
    pts.push(new THREE.Vector3(-hw * 0.4, hh, -L), new THREE.Vector3(0, hh * 1.4, -L), new THREE.Vector3(0, hh * 1.4, -L), new THREE.Vector3(hw * 0.4, hh, -L)); // „góra” zdjęcia
    const lineMat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
    lines.renderOrder = 15;
    lines.userData.ownMaterial = true;
    const faceGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), c[0], c[1], new THREE.Vector3(), c[1], c[2], new THREE.Vector3(), c[2], c[3], new THREE.Vector3(), c[3], c[0], c[0], c[1], c[2], c[0], c[2], c[3]]);
    const face = new THREE.Mesh(faceGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    face.userData = { kind: 'camera', id: cam.id, ownMaterial: true };
    g.add(lines, face);
    g.position.copy(pos);
    g.quaternion.copy(q);
    g.userData = { kind: 'camera', id: cam.id };
    this.pickables.push(face);
    if (this.cssLabels && this.options.showLabels) {
      const lab = makeLabel('📷 ' + cam.name, 'label3d camera');
      lab.position.set(0, hh * 1.6, -L);
      g.add(lab);
    }
    return g;
  }

  buildFurniture(f, room) {
    const isMR = this.mode === 'mr';
    const obj = new THREE.Group();
    obj.position.set(f.x, f.y || 0, f.z);
    obj.rotation.y = f.rot || 0;
    obj.userData = { kind: 'furniture', id: f.id, roomId: room.id };
    // kształt złożony (scalone bryły) = kilka części, każda z własnym położeniem w układzie mebla
    const parts = f.shape === 'compound' && Array.isArray(f.parts) && f.parts.length ? f.parts : [{ ...f, x: 0, z: 0, y: 0, rot: 0 }];
    // wygląd: globalny (look) + własny mebla (f.display: 'transparent' | 'edges')
    const look = this.options.look;
    // z poprawionym modelem bryła jest niewidoczna (model: tylko zaznaczenie) albo ma same krawędzie (model + bryły)
    const refMode = this.refActive ? this.options.refShow : null;
    const style = refMode || f.display === 'edges' || (look && look.furnStyle === 'edges' && f.display !== 'transparent') ? 'edges' : 'solid';
    let opacity = look ? look.furnOpacity : isMR ? 0.45 : 1;
    if (f.display === 'transparent') opacity = Math.min(opacity, 0.3);
    if (style === 'edges') opacity = 0;
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(f.color), roughness: 0.75, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, colorWrite: opacity > 0 });
    const edgeBase = style === 'edges' ? new THREE.Color(f.color).offsetHSL(0, 0, 0.15).getHex() : 0x222222;
    const edgeMat = new THREE.LineBasicMaterial({ color: edgeBase, transparent: true, opacity: refMode === 'model' ? 0 : style === 'edges' || isMR ? 0.95 : 0.5, depthTest: !refMode });
    obj.userData.edgeBase = edgeBase;
    obj.userData.edgeOpacity = edgeMat.opacity;
    obj.userData.hardOpacity = edgeMat.opacity; // przy poprawionym modelu bez czerwonych konturów kolizji
    obj.userData.meshes = [];
    obj.userData.edgeMat = edgeMat;
    obj.userData.mat = mat;
    parts.forEach((p, i) => {
      const geo = furnitureGeometry(p);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.x || 0, p.y || 0, p.z || 0);
      mesh.rotation.y = p.rot || 0;
      mesh.castShadow = !isMR && !refMode;
      mesh.receiveShadow = !isMR && !refMode;
      mesh.userData = { kind: 'furniture', id: f.id, roomId: room.id, ownMaterial: i === 0 };
      obj.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edgeMat);
      edges.position.copy(mesh.position);
      edges.rotation.copy(mesh.rotation);
      edges.userData = { ownMaterial: i === 0, role: 'edges' };
      if (refMode) edges.renderOrder = 2; // nad czernią za oknami
      obj.add(edges);
      obj.userData.meshes.push(mesh);
      this.pickables.push(mesh);
    });
    if (this.cssLabels && this.options.showLabels) {
      const lab = makeLabel((f.verified ? '' : '? ') + f.name);
      lab.position.set(0, f.h + 0.08, 0);
      lab.userData.role = 'nameLabel';
      obj.add(lab);
      obj.userData.label = lab;
    }
    return obj;
  }

  buildGhost(f) {
    const s = f.scanned;
    const moved = Math.hypot(s.x - f.x, s.z - f.z) > 0.02 || Math.abs((s.rot || 0) - (f.rot || 0)) > 0.02 || Math.abs(s.w - f.w) > 0.01 || Math.abs(s.d - f.d) > 0.01;
    if (!moved) return null;
    const outline = furnitureOutline({ ...f, ...s, shape: f.shape === 'L' ? 'box' : f.shape });
    const pts = outline.map(([x, z]) => new THREE.Vector3(x, 0.012, z));
    pts.push(pts[0].clone());
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.materials.ghost);
    line.computeLineDistances();
    line.userData.kind = 'ghost';
    return line;
  }

  /** Aktualizuje tylko transformację mebla (szybko, podczas przeciągania). */
  updateFurnitureTransform(f) {
    const obj = this.furnitureObjects.get(f.id);
    if (!obj) return;
    obj.position.set(f.x, f.y || 0, f.z);
    obj.rotation.y = f.rot || 0;
    if (this.refRoot && this.refRoot.parent && this.project) {
      const room = this.project.rooms.find((r) => r.id === obj.userData.roomId);
      if (room) this.options.refModel.updateFor(room, f);
    }
  }

  applyHighlights() {
    const { selectedId, conflicts } = this.options;
    for (const [id, obj] of this.furnitureObjects) {
      const mat = obj.userData.mat, edgeMat = obj.userData.edgeMat;
      const list = conflicts.get(id) || [];
      const hard = list.some((c) => c.kind !== 'door');
      const warn = !hard && list.length > 0;
      mat.emissive.setHex(hard ? COLOR_CONFLICT : warn ? COLOR_WARN : 0x000000);
      mat.emissiveIntensity = hard || warn ? 0.55 : 0;
      const sel = id === selectedId || !!(this.options.selectedIds && this.options.selectedIds.has(id));
      edgeMat.color.setHex(sel ? COLOR_SELECTED : hard ? COLOR_CONFLICT : obj.userData.edgeBase);
      edgeMat.opacity = sel ? 1 : hard ? obj.userData.hardOpacity : obj.userData.edgeOpacity;
      if (obj.userData.label) obj.userData.label.element.classList.toggle('conflict', hard);
      if (obj.userData.label) obj.userData.label.element.classList.toggle('selected', sel);
    }
  }

  /** Lista obiektów do „trafiania” promieniem. */
  getPickables(kinds) {
    return kinds ? this.pickables.filter((o) => kinds.includes(o.userData.kind)) : this.pickables;
  }
}

export function furnitureSummary(f) {
  const cm = (v) => Math.round(v * 100);
  return `${f.name} (${typeName(f.type)}) ${cm(f.w)}×${cm(f.d)}×${cm(f.h)} cm`;
}

export { furnitureLocalParts };
