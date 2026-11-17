// Sesja WebXR (immersive-ar) na Meta Quest: skan pokoju ze Space Setup, potwierdzanie mebli
// i edycja makiety w mieszanej rzeczywistości (skala 1:1, na tle passthrough).
import * as THREE from 'three';
import { Panel3D, makeTextSprite } from './ui3d.js';
import { LiveSceneOverlay } from './liveOverlay.js';
import { captureScene, sceneStats, floorPlanes } from './sceneCapture.js';
import { convertScene, roomFrameFromFloor } from '../scanConvert.js';
import { ApartmentView } from '../roomView.js';
import {
  computeConflicts, snapToWalls, normalizeAngle, rad, polygonCentroid, alignRotationToNearestWall, worldToRoom, roomToWorld,
  polygonArea, roomContainsWorldPoint,
} from '../geometry.js';
import {
  History, createFurniture, findFurniture, uid, mergeFurniture, splitFurniture, resizeFurniture,
  ensureVariants, activeVariant, switchVariant, createVariant, deleteVariant,
} from '../model.js';
import { computeClearances } from '../geometry.js';
import { FURNITURE_TYPES, TYPE_KEYS, TEMPLATES, typeName, typeColor } from '../labels.js';

// 'unbounded' = chodzenie po całym mieszkaniu bez granicy Guardian (przeglądarka Questa obsługuje ją
// eksperymentalnie). Gdy niedostępna — 'local-floor', a na końcu 'local'. Nic nie jest wymagane,
// żeby sesja nie wymuszała ustawiania granicy.
function sessionInit(preferUnbounded) {
  return {
    requiredFeatures: [],
    optionalFeatures: [...(preferUnbounded ? ['unbounded'] : []), 'local-floor', 'plane-detection', 'mesh-detection', 'hand-tracking', 'anchors', 'hit-test'],
  };
}

export async function isVRSupported() {
  try {
    return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr')));
  } catch (e) {
    return false;
  }
}

const PALETTE = ['#c8915a', '#8d6e52', '#f2efe9', '#3a3f47', '#6c8ebf', '#9b7fc4', '#5fa35f', '#d9534f', '#e8c547', '#9aa0a6', '#b9a28a', '#2f6fde'];

export async function isARSupported() {
  try {
    return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar')));
  } catch (e) {
    return false;
  }
}

const cmTxt = (m) => `${Math.round(m * 100)}`;

/** Poza 2D (x, z, rot) układu pokoju z macierzy 4x4 (konwencja obrotu jak w geometry.js). */
function pose2D(m) {
  return { x: m[12], z: m[14], rot: -Math.atan2(m[2], m[0]) };
}

function compose2D(a, b) {
  // a ∘ b : najpierw b, potem a
  const c = Math.cos(a.rot), s = Math.sin(a.rot);
  return { x: a.x + b.x * c + b.z * s, z: a.z - b.x * s + b.z * c, rot: normalizeAngle(a.rot + b.rot) };
}

function invert2D(a) {
  const c = Math.cos(-a.rot), s = Math.sin(-a.rot);
  return { x: -(a.x * c + a.z * s), z: -(-a.x * s + a.z * c), rot: -a.rot };
}

function matrixFrom2D(p, y = 0) {
  return new THREE.Matrix4().makeRotationY(p.rot).setPosition(p.x, y, p.z);
}

export class XRApp {
  /**
   * @param {object} o
   *  project, mode: 'scan' | 'edit', roomId?, onExit(project, info), onSave(project), statusEl?
   */
  constructor(o) {
    this.project = o.project;
    this.startMode = o.mode;
    this.preferredRoomId = o.roomId || null;
    this.onExit = o.onExit;
    this.onSave = o.onSave;
    this.history = new History(this.project);
    this.isVR = o.mode === 'vr';
    this.state = o.mode === 'scan' ? 'scan' : 'edit';
    this.walkRoot = null;
    this.mergeReturn = null;
    this.turnCooldown = 0;
    this.selectedId = null;
    this.activeDim = 'w';
    this.grab = null;
    this.alignDrag = null;
    this.showMesh = true; // siatka trójkątów ze Space Setup na żywo
    this.preferUnbounded = o.unbounded !== false;
    this.dollhouse = false;
    this.doll = null;
    this.message = '';
    this.frameCount = 0;
    this.scanStartTime = performance.now();
    this.controllers = [];
    this.dirty = false;
  }

  // ======================= start / koniec =======================
  /** Musi być wywołane bezpośrednio w obsłudze kliknięcia (gest użytkownika). */
  start() {
    const sessionPromise = this.isVR
      ? navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'hand-tracking'] })
      : navigator.xr.requestSession('immersive-ar', sessionInit(this.preferUnbounded));
    return sessionPromise.then((session) => this.onSessionStarted(session));
  }

  async onSessionStarted(session) {
    this.session = session;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0);
    renderer.xr.enabled = true;
    // wybór przestrzeni odniesienia: unbounded -> local-floor -> local
    const enabled = session.enabledFeatures ? [...session.enabledFeatures] : null;
    const candidates = this.isVR ? ['local-floor', 'local'] : this.preferUnbounded ? ['unbounded', 'local-floor', 'local'] : ['local-floor', 'local'];
    this.refType = 'local';
    for (const t of candidates) {
      if (enabled && t !== 'local' && !enabled.includes(t)) continue;
      try { await session.requestReferenceSpace(t); this.refType = t; break; } catch (e) { /* następna */ }
    }
    renderer.xr.setReferenceSpaceType(this.refType);
    // Canvas musi być w DOM (emulator IWER rysuje go na swoim podglądzie); na Queście i tak przykrywa go sesja immersive.
    Object.assign(renderer.domElement.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '50' });
    document.body.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
    const dl = new THREE.DirectionalLight(0xffffff, 1.2);
    dl.position.set(1, 3, 2);
    scene.add(dl);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.02, 200);
    if (this.isVR) {
      // pełny VR: tło, podłoże i siatka zamiast obrazu z kamer
      scene.background = new THREE.Color(0xcfdbe6);
      const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 48), new THREE.MeshStandardMaterial({ color: 0xb7c2cc, roughness: 1 }));
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.01;
      scene.add(ground);
      const grid = new THREE.GridHelper(60, 60, 0x8f9aa5, 0xa5afb9);
      grid.position.y = -0.005;
      scene.add(grid);
    }

    this.live = new LiveSceneOverlay();
    scene.add(this.live.group);

    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = false;
    scene.add(this.root);
    this.view = new ApartmentView({ mode: 'mr', cssLabels: false });
    this.root.add(this.view.group);
    this.labels = new THREE.Group();
    this.root.add(this.labels);

    this.panel = new Panel3D({ width: 0.4 });
    this.panel.onAction = (id) => this.onPanelAction(id);
    scene.add(this.panel.mesh);
    this.panelPlaced = false;

    this.raycaster = new THREE.Raycaster();
    this.setupControllers();

    await renderer.xr.setSession(session);
    this.refSpace = renderer.xr.getReferenceSpace();
    session.addEventListener('end', () => this.onSessionEnded());
    this.lastTime = performance.now();
    renderer.setAnimationLoop((t, frame) => this.onFrame(t, frame));
    if (this.isVR) {
      // gotowy model: start od makiety
      this.aligned = true;
      this.anchorRoomId = this.preferredRoomId || (this.project.rooms[0] && this.project.rooms[0].id);
      this.needDollPlace = true;
      this.enterDollhouse();
    }
    this.updatePanel();
  }

  end() {
    if (this.session) this.session.end().catch(() => this.onSessionEnded());
  }

  onSessionEnded() {
    if (this.ended) return;
    this.ended = true;
    this.renderer.setAnimationLoop(null);
    this.view.dispose();
    this.live.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    if (this.onExit) this.onExit(this.project, { changed: this.dirty });
  }

  // ======================= kontrolery =======================
  setupControllers() {
    for (let i = 0; i < 2; i++) {
      const c = this.renderer.xr.getController(i);
      const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
      line.scale.z = 2;
      c.add(line);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      dot.visible = false;
      this.scene.add(dot);
      c.userData = { line, dot, index: i };
      c.addEventListener('connected', (e) => { c.userData.inputSource = e.data; c.visible = true; });
      c.addEventListener('disconnected', () => { c.userData.inputSource = null; c.visible = false; });
      c.addEventListener('selectstart', () => this.onSelectStart(c));
      c.addEventListener('selectend', () => this.onSelectEnd(c));
      c.addEventListener('squeezestart', () => this.placePanel(true));
      this.scene.add(c);
      this.controllers.push(c);
    }
  }

  rayFrom(c) {
    const m = c.matrixWorld;
    const origin = new THREE.Vector3().setFromMatrixPosition(m);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    this.raycaster.set(origin, dir);
    return this.raycaster;
  }

  floorY() {
    return new THREE.Vector3().setFromMatrixPosition(this.root.matrix).y;
  }

  rayFloor(c) {
    const rc = this.rayFrom(c);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.floorY());
    const p = new THREE.Vector3();
    return rc.ray.intersectPlane(plane, p) ? p : null;
  }

  panelHit(c) {
    if (!this.panel.mesh.visible) return null;
    const hits = this.rayFrom(c).intersectObject(this.panel.mesh, false);
    return hits[0] || null;
  }

  furnitureHit(c) {
    const hits = this.rayFrom(c).intersectObjects(this.view.getPickables(['furniture']), false);
    return hits[0] || null;
  }

  haptic(c, strength = 0.4, ms = 25) {
    const gp = c.userData.inputSource && c.userData.inputSource.gamepad;
    const act = gp && gp.hapticActuators && gp.hapticActuators[0];
    if (act && act.pulse) act.pulse(strength, ms).catch(() => {});
  }

  // ======================= układy współrzędnych =======================
  /** Ustawia macierz root (układ mieszkania -> świat XR). */
  setRootMatrix(m) {
    this.root.matrix.copy(m);
    this.root.matrixWorldNeedsUpdate = true;
  }

  worldToApartment(p) {
    const inv = this.root.matrix.clone().invert();
    const q = p.clone().applyMatrix4(inv);
    return [q.x, q.z];
  }

  // ======================= pętla =======================
  onFrame(t, frame) {
    if (!frame || this.ended) return; // three.js woła pętlę także po zakończeniu sesji (bez XRFrame)
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.frameCount++;
    // gdy system pokazuje własne okno (Space Setup, granica, menu) — nie zasłaniamy go
    const visible = !this.session.visibilityState || this.session.visibilityState === 'visible';
    this.scene.visible = visible;
    if (visible !== this.wasVisible) {
      this.wasVisible = visible;
      if (visible && this.frameCount > 1) this.placePanel(true);
    }
    const pose = frame.getViewerPose(this.refSpace);
    if (pose) this.head = new THREE.Matrix4().fromArray(pose.transform.matrix);
    if (this.needDollPlace && this.head) {
      this.needDollPlace = false;
      this.placeDollInFront();
      this.applyDollMatrix();
      this.placePanel(true);
    }
    if (!this.panelPlaced && this.head) this.placePanel(false);
    else if (this.head && this.frameCount % 30 === 0) this.keepPanelInView();

    if (this.state === 'scan' && this.pendingSave) {
      this.pendingSave = false;
      this.doSaveScan(frame);
    }
    if (this.state === 'scan') this.updateScan(frame, now);
    if (!this.aligned && this.state !== 'scan') this.tryAlign(frame);
    const liveOn = !this.isVR && (this.state === 'scan' || (this.showMesh && !this.dollhouse));
    this.live.visible = liveOn;
    if (liveOn) this.live.update(frame, this.refSpace);
    if (this.state === 'scan' && this.frameCount % 45 === 0) this.updatePanel();

    this.updateGrab(dt);
    this.updateRays();
    this.renderer.render(this.scene, this.camera);
  }

  updateRays() {
    for (const c of this.controllers) {
      const { line, dot } = c.userData;
      if (!c.visible) { dot.visible = false; continue; }
      let dist = 2;
      let hover = null;
      const ph = this.panelHit(c);
      if (ph) {
        dist = ph.distance;
        const b = this.panel.buttonAtUV(ph.uv);
        hover = b ? b.id : null;
        this.panel.setHover(hover);
        c.userData.overPanel = true;
      } else {
        c.userData.overPanel = false;
        const fh = this.state !== 'scan' ? this.furnitureHit(c) : null;
        if (fh) dist = fh.distance;
        else {
          const fp = this.rayFloor(c);
          if (fp) dist = Math.min(5, fp.distanceTo(new THREE.Vector3().setFromMatrixPosition(c.matrixWorld)));
        }
      }
      line.scale.z = dist;
      dot.visible = true;
      dot.position.copy(this.raycaster.ray.at(dist, new THREE.Vector3()));
    }
    if (!this.controllers.some((c) => c.userData.overPanel)) this.panel.setHover(null);
  }

  // ======================= panel =======================
  placePanel(force) {
    if (!this.head) return;
    const pos = new THREE.Vector3().setFromMatrixPosition(this.head);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.head);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    const p = pos.clone().addScaledVector(fwd, 0.6);
    // w makiecie panel z lewej strony, żeby nie zasłaniał miniatury
    if (this.dollhouse) p.add(new THREE.Vector3(fwd.z, 0, -fwd.x).multiplyScalar(0.42));
    p.y = pos.y - 0.18;
    this.panel.mesh.position.copy(p);
    this.panel.mesh.lookAt(pos.x, p.y + 0.12, pos.z);
    this.panelPlaced = true;
    if (force) this.panel.mesh.visible = true;
  }

  keepPanelInView() {
    const pos = new THREE.Vector3().setFromMatrixPosition(this.head);
    const toPanel = this.panel.mesh.position.clone().sub(pos);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.head);
    const angle = toPanel.angleTo(fwd);
    if (toPanel.length() > 1.6 || angle > rad(75)) {
      this.offView = (this.offView || 0) + 1;
      if (this.offView > 3) { this.placePanel(false); this.offView = 0; }
    } else this.offView = 0;
  }

  onPanelAction(id) {
    const [cmd, arg] = id.split(':');
    const handlers = {
      saveScan: () => this.saveScan(),
      roomCapture: () => this.startRoomCapture(),
      exit: () => this.exitAndSave(),
      cancel: () => this.end(),
      vtype: () => this.verifyAs(arg),
      vok: () => this.verifyAs(null),
      vhide: () => this.verifyHide(),
      vdel: () => this.verifyDelete(),
      vskip: () => { this.state = 'edit'; this.selectedId = null; this.refresh(); },
      undo: () => this.undo(),
      redo: () => this.redo(),
      mesh: () => { this.showMesh = !this.showMesh; this.refresh(); },
      doll: () => this.enterDollhouse(),
      dollExit: () => this.exitDollhouse(),
      dollRot: () => { this.doll.yaw += rad(parseFloat(arg)); this.applyDollMatrix(); this.refresh(); },
      dollScale: () => { this.doll.scale = Math.min(0.5, Math.max(0.01, this.doll.scale * parseFloat(arg))); this.applyDollMatrix(); this.refresh(); },
      dollHere: () => { this.placeDollInFront(); this.applyDollMatrix(); this.refresh(); },
      mergeStart: () => { this.mergeReturn = this.state === 'verify' ? 'verify' : null; this.state = 'merge'; this.updatePanel(); },
      more: () => { this.state = 'more'; this.updatePanel(); },
      colors: () => { this.state = 'colors'; this.updatePanel(); },
      setColor: () => { const s = this.sel(); if (s) { s.f.color = arg === 'type' ? typeColor(s.f.type) : arg; this.state = 'more'; this.commit(); } },
      shape: () => this.cycleShape(),
      split: () => { const parts = splitFurniture(this.project, this.selectedId); if (parts.length) { this.selectedId = parts[0].id; this.state = 'edit'; this.commit(); } },
      elev: () => { const s = this.sel(); if (s) { s.f.y = Math.max(0, (s.f.y || 0) + parseFloat(arg) / 100); this.commit(); } },
      nudge: () => this.nudgeSelected(arg),
      resetScan: () => { const s = this.sel(); if (s && s.f.scanned) { Object.assign(s.f, s.f.scanned); this.commit(); } },
      verified: () => { const s = this.sel(); if (s) { s.f.verified = !s.f.verified; this.commit(); } },
      variants: () => { this.state = 'variants'; this.updatePanel(); },
      varSwitch: () => { switchVariant(this.project, arg); this.selectedId = null; this.state = 'edit'; this.commit(); },
      varNew: () => { createVariant(this.project); this.selectedId = null; this.state = 'edit'; this.commit(); },
      varDel: () => { deleteVariant(this.project, this.project.activeVariantId); this.selectedId = null; this.state = 'variants'; this.commit(); },
      hidden: () => { this.state = 'hidden'; this.updatePanel(); },
      unhide: () => { const s = findFurniture(this.project, arg); if (s) { s.f.hidden = false; this.selectedId = s.f.id; this.state = 'edit'; this.commit(); } },
      verifyAll: () => this.nextVerify(),
      rooms: () => { this.state = 'rooms'; this.updatePanel(); },
      goRoom: () => { this.state = 'edit'; if (this.dollhouse) this.dollhouse = false; this.enterWalk(arg); },
      add: () => { this.state = 'add'; this.updatePanel(); },
      addTpl: () => this.addTemplate(TEMPLATES[+arg]),
      align: () => { this.state = 'align'; this.selectedId = null; this.refresh(); },
      alignMove: () => this.alignMove(arg),
      alignRot: () => this.alignRotate(rad(parseFloat(arg))),
      alignReset: () => { const r = this.anchorRoom(); if (r) { r.xrAlign = { x: 0, z: 0, rot: 0 }; this.aligned = false; this.commit(); } },
      back: () => {
        if (this.state === 'merge' && this.mergeReturn === 'verify') this.state = 'verify';
        else if (this.state === 'colors') this.state = 'more';
        else this.state = 'edit';
        this.mergeReturn = null;
        this.refresh();
      },
      deselect: () => { this.selectedId = null; this.state = 'edit'; this.refresh(); },
      rot: () => this.rotateSelected(rad(parseFloat(arg))),
      dim: () => { this.activeDim = arg; this.updatePanel(); },
      dimAdd: () => this.resizeSelected(parseFloat(arg) / 100),
      snap: () => this.snapSelected(),
      alignWall: () => this.alignSelectedToWall(),
      hide: () => this.hideSelected(),
      del: () => this.deleteSelected(),
      dup: () => this.duplicateSelected(),
      type: () => { this.state = 'type'; this.updatePanel(); },
      setType: () => this.setSelectedType(arg),
    };
    if (handlers[cmd]) handlers[cmd]();
  }

  updatePanel() {
    this.panel.setPage(this.buildPage());
  }

  buildPage() {
    const st = this.state;
    if (st === 'scan') {
      const s = this.scanStats || { planes: 0, meshes: 0, floors: 0, walls: 0, furniture: 0 };
      const enabled = (this.session && this.session.enabledFeatures) || [];
      const lines = [];
      if (enabled.length && !enabled.includes('plane-detection')) lines.push('Przeglądarka nie udostępniła danych pomieszczenia (plane-detection). Zezwól na dostęp do danych przestrzennych.');
      lines.push(`Wykryto: podłoga ${s.floors ? 'tak' : 'NIE'}, ściany: ${s.walls}, meble/obiekty: ${s.furniture}, trójkąty siatki: ${this.live.stats.globalTriangles.toLocaleString('pl-PL')}.`);
      lines.push(this.refType === 'unbounded' ? 'Tryb bez granicy: możesz chodzić po całym mieszkaniu.' : `Przestrzeń: ${this.refType} (z granicą Guardian).`);
      if (!s.planes && performance.now() - this.scanStartTime > 2500) lines.push('Brak danych pokoju. Uruchom konfigurację przestrzeni (Space Setup) i obejdź pokój, zaznaczając meble.');
      else lines.push('Turkusowe trójkąty to siatka ze skanu, żółte to meble ze Space Setup. Tam, gdzie nie ma trójkątów, pokój nie jest zeskanowany: popraw w Space Setup.');
      if (this.message) lines.push(this.message);
      return {
        title: 'Skan pokoju',
        lines,
        rows: [
          [{ id: 'saveScan', label: 'Zapisz pokój', style: 'primary', disabled: !s.planes }],
          [{ id: 'roomCapture', label: 'Space Setup (skanuj)' }, { id: 'cancel', label: 'Anuluj', style: 'muted' }],
        ],
      };
    }
    if (st === 'verify') {
      const found = this.selectedId && findFurniture(this.project, this.selectedId);
      if (!found) return { title: 'Gotowe', lines: [], rows: [[{ id: 'vskip', label: 'Dalej' }]] };
      const f = found.f;
      const left = this.unverified().length;
      const rows = [[{ id: 'vok', label: `✓ Tak, to ${typeName(f.type)}`, style: 'primary' }]];
      const keys = TYPE_KEYS.filter((k) => k !== f.type);
      for (let i = 0; i < keys.length; i += 4) rows.push(keys.slice(i, i + 4).map((k) => ({ id: `vtype:${k}`, label: FURNITURE_TYPES[k].name.split(' /')[0] })));
      rows.push([{ id: 'mergeStart', label: '⧉ Scal z inną bryłą (to jeden mebel)' }]);
      rows.push([{ id: 'vhide', label: 'Tymczasowy (ukryj)' }, { id: 'vdel', label: 'To nie mebel', style: 'danger' }, { id: 'vskip', label: 'Pomiń resztę', style: 'muted' }]);
      return {
        title: `Co to jest? (zostało ${left})`,
        lines: [`Podświetlona bryła: ${cmTxt(f.w)}×${cmTxt(f.d)}×${cmTxt(f.h)} cm (skaner: ${f.sourceLabel || '—'}).`],
        rows,
      };
    }
    if (st === 'add') {
      const rows = [];
      for (let i = 0; i < TEMPLATES.length; i += 3) rows.push(TEMPLATES.slice(i, i + 3).map((t, j) => ({ id: `addTpl:${i + j}`, label: t.name || typeName(t.type) })));
      rows.push([{ id: 'back', label: '← Wróć', style: 'muted' }]);
      return { title: 'Dodaj mebel', lines: ['Mebel pojawi się przed Tobą na podłodze. Potem chwyć go spustem.'], rows };
    }
    if (st === 'align') {
      return {
        title: 'Wyrównanie modelu',
        lines: [
          this.alignInfo || '',
          'Trzymaj spust i przeciągaj, aby przesunąć cały model. Gałka obraca. Albo użyj przycisków (kierunki względem Ciebie).',
        ],
        rows: [
          [{ id: 'alignMove:fwd5', label: '↑ 5 cm' }, { id: 'alignMove:fwd1', label: '↑ 1 cm' }, { id: 'alignMove:back1', label: '↓ 1 cm' }, { id: 'alignMove:back5', label: '↓ 5 cm' }],
          [{ id: 'alignMove:left5', label: '← 5 cm' }, { id: 'alignMove:left1', label: '← 1 cm' }, { id: 'alignMove:right1', label: '→ 1 cm' }, { id: 'alignMove:right5', label: '→ 5 cm' }],
          [{ id: 'alignRot:5', label: '⟲ 5°' }, { id: 'alignRot:0.5', label: '⟲ 0,5°' }, { id: 'alignRot:-0.5', label: '⟳ 0,5°' }, { id: 'alignRot:-5', label: '⟳ 5°' }],
          [{ id: 'alignReset', label: 'Reset', style: 'muted' }, { id: 'back', label: 'Gotowe', style: 'primary' }],
        ],
      };
    }
    const found = this.selectedId && findFurniture(this.project, this.selectedId);
    if (st === 'merge' && found) {
      return {
        title: `Scal: ${found.f.name}`,
        lines: ['Wskaż spustem drugą bryłę, która jest częścią tego samego mebla. Obie bryły połączą się w jeden mebel o złożonym kształcie (suma brył) i będą się przesuwać razem.'],
        rows: [[{ id: 'back', label: 'Anuluj', style: 'muted' }]],
      };
    }
    if (st === 'more' && found) {
      const f = found.f;
      const clear = computeClearances(found.room, f).map((c) => `${{ '+x': 'prawo', '-x': 'lewo', '+z': 'przód', '-z': 'tył' }[c.dir]} ${cmTxt(c.dist)}`).join(', ');
      const shapeNames = { box: 'prostopadłościan', L: 'kształt L', cylinder: 'walec', compound: `złożony (${(f.parts || []).length} bryły)` };
      return {
        title: `${f.name}: szczegóły`,
        lines: [
          `Kształt: ${shapeNames[f.shape] || f.shape}. Nad podłogą: ${cmTxt(f.y || 0)} cm. Potwierdzony: ${f.verified ? 'tak' : 'nie'}.`,
          clear ? `Wolne miejsce: ${clear} cm.` : '',
        ].filter(Boolean),
        rows: [
          f.shape === 'compound'
            ? [{ id: 'split', label: '✂ Rozdziel bryły' }, { id: 'colors', label: 'Kolor…' }]
            : [{ id: 'shape', label: 'Zmień kształt ▸' }, { id: 'colors', label: 'Kolor…' }],
          [{ id: 'elev:-5', label: 'Niżej 5' }, { id: 'elev:-1', label: 'Niżej 1' }, { id: 'elev:1', label: 'Wyżej 1' }, { id: 'elev:5', label: 'Wyżej 5' }],
          [{ id: 'nudge:left', label: '← 1 cm' }, { id: 'nudge:fwd', label: '↑ 1 cm' }, { id: 'nudge:back', label: '↓ 1 cm' }, { id: 'nudge:right', label: '→ 1 cm' }],
          [{ id: 'resetScan', label: '↺ Jak w skanie', disabled: !f.scanned }, { id: 'verified', label: f.verified ? 'Potwierdzony ✓' : 'Oznacz potwierdzony' }],
          [{ id: 'undo', label: '↶ Cofnij', disabled: !this.history.canUndo }, { id: 'back', label: '← Wróć', style: 'primary' }],
        ],
      };
    }
    if (st === 'colors' && found) {
      const rows = [];
      for (let i = 0; i < PALETTE.length; i += 4) rows.push(PALETTE.slice(i, i + 4).map((c) => ({ id: `setColor:${c}`, label: c === found.f.color ? `● ${c}` : c, style: c === found.f.color ? 'active' : undefined })));
      rows.push([{ id: 'setColor:type', label: 'Kolor typu' }, { id: 'back', label: '← Wróć', style: 'muted' }]);
      return { title: 'Kolor mebla', lines: [], rows };
    }
    if (st === 'variants') {
      const vs = ensureVariants(this.project);
      const rows = vs.map((v) => [{ id: `varSwitch:${v.id}`, label: (v.id === this.project.activeVariantId ? '● ' : '') + v.name, style: v.id === this.project.activeVariantId ? 'active' : undefined }]);
      rows.push([{ id: 'varNew', label: '+ Nowa wersja (kopia)', style: 'primary' }, { id: 'varDel', label: 'Usuń bieżącą', style: 'danger', disabled: vs.length <= 1 }]);
      rows.push([{ id: 'back', label: '← Wróć', style: 'muted' }]);
      return { title: 'Wersje układu', lines: ['Każda wersja to osobne ustawienie mebli w tym samym mieszkaniu. Nowa wersja = kopia bieżącej, potem ją przemeblowujesz.'], rows };
    }
    if (st === 'hidden') {
      const hidden = [];
      for (const r of this.project.rooms) for (const f of r.furniture) if (f.hidden) hidden.push(f);
      const rows = [];
      for (let i = 0; i < hidden.length; i += 2) rows.push(hidden.slice(i, i + 2).map((f) => ({ id: `unhide:${f.id}`, label: `Pokaż: ${f.name}` })));
      rows.push([{ id: 'back', label: '← Wróć', style: 'muted' }]);
      return { title: `Ukryte meble (${hidden.length})`, lines: hidden.length ? [] : ['Brak ukrytych mebli.'], rows };
    }
    if (st === 'rooms') {
      const rows = this.project.rooms.map((r) => [{ id: `goRoom:${r.id}`, label: `${r.name} (${Math.abs(polygonArea(r.outline)).toFixed(1)} m²)` }]);
      rows.push([{ id: 'back', label: '← Wróć', style: 'muted' }]);
      return { title: 'Przejdź do pokoju', lines: [], rows };
    }
    if (st === 'type' && found) {
      const rows = [];
      for (let i = 0; i < TYPE_KEYS.length; i += 4) rows.push(TYPE_KEYS.slice(i, i + 4).map((k) => ({ id: `setType:${k}`, label: FURNITURE_TYPES[k].name.split(' /')[0], style: k === found.f.type ? 'active' : undefined })));
      rows.push([{ id: 'back', label: '← Wróć', style: 'muted' }]);
      return { title: `Typ: ${found.f.name}`, lines: [], rows };
    }
    if (found) {
      const f = found.f;
      const conf = computeConflicts(found.room).get(f.id) || [];
      const confTxt = conf.length ? '⚠ ' + conf.map((c) => c.label).filter((v, i, a) => a.indexOf(v) === i).join(', ') : '✓ Mieści się, brak kolizji';
      const dimLabel = (k, n) => ({ id: `dim:${k}`, label: n, style: this.activeDim === k ? 'active' : undefined });
      return {
        title: f.name,
        lines: [`${cmTxt(f.w)} × ${cmTxt(f.d)} × ${cmTxt(f.h)} cm`, confTxt],
        rows: [
          [{ id: 'rot:90', label: '⟲ 90°' }, { id: 'rot:15', label: '⟲ 15°' }, { id: 'rot:-15', label: '⟳ 15°' }, { id: 'rot:-90', label: '⟳ 90°' }],
          [dimLabel('w', `Szer. ${cmTxt(f.w)}`), dimLabel('d', `Głęb. ${cmTxt(f.d)}`), dimLabel('h', `Wys. ${cmTxt(f.h)}`)],
          [{ id: 'dimAdd:-5', label: '−5 cm' }, { id: 'dimAdd:-1', label: '−1 cm' }, { id: 'dimAdd:1', label: '+1 cm' }, { id: 'dimAdd:5', label: '+5 cm' }],
          [{ id: 'snap', label: 'Dosuń do ściany' }, { id: 'alignWall', label: 'Równolegle do ściany' }],
          [{ id: 'type', label: 'Zmień typ' }, { id: 'mergeStart', label: 'Scal z…' }, { id: 'dup', label: 'Duplikuj' }],
          [{ id: 'more', label: 'Więcej… (kształt, wysokość, kolor)' }],
          [{ id: 'hide', label: 'Ukryj' }, { id: 'del', label: 'Usuń', style: 'danger' }],
          [{ id: 'undo', label: '↶ Cofnij', disabled: !this.history.canUndo }, { id: 'deselect', label: 'Gotowe', style: 'primary' }],
        ],
      };
    }
    const hiddenCount = this.project.rooms.reduce((n, r) => n + r.furniture.filter((f) => f.hidden).length, 0);
    const unverCount = this.unverified().length;
    const variantRow = [
      { id: 'variants', label: `Wersja: ${activeVariant(this.project).name}` },
      { id: 'hidden', label: `Ukryte (${hiddenCount})`, disabled: !hiddenCount },
    ];
    if (unverCount) variantRow.push({ id: 'verifyAll', label: `Do potwierdzenia (${unverCount})` });
    if (this.dollhouse) {
      return {
        title: 'Makieta mieszkania',
        lines: [
          `Skala 1:${Math.round(1 / this.doll.scale)}. Gałka: lewo/prawo obraca, góra/dół zmienia wielkość.`,
          'Spust na podłodze makiety: przesuwanie makiety. Meble chwytasz i przesuwasz jak zwykle.',
        ],
        rows: [
          [{ id: 'dollRot:45', label: '⟲ 45°' }, { id: 'dollRot:-45', label: '⟳ 45°' }, { id: 'dollScale:0.8', label: '− Mniejsza' }, { id: 'dollScale:1.25', label: '+ Większa' }],
          [{ id: 'dollHere', label: 'Przed siebie' }, { id: 'add', label: '+ Dodaj mebel' }],
          [{ id: 'undo', label: '↶ Cofnij', disabled: !this.history.canUndo }, { id: 'redo', label: '↷ Ponów', disabled: !this.history.canRedo }],
          variantRow,
          this.isVR
            ? [{ id: 'rooms', label: '🚶 Spacer 1:1 (wybierz pokój)', style: 'primary' }, { id: 'exit', label: 'Zapisz i wyjdź' }]
            : [{ id: 'dollExit', label: 'Wróć do 1:1 w pokoju', style: 'primary' }, { id: 'exit', label: 'Zapisz i wyjdź' }],
        ],
      };
    }
    // spacer po gotowym modelu w VR
    if (this.isVR) {
      return {
        title: 'Spacer po mieszkaniu (VR)',
        lines: ['Lewa gałka: chodzenie, prawa gałka: obrót o 30°. Spust na meblu: przesuwanie, gałka obraca chwycony mebel. Grip przywołuje panel.'],
        rows: [
          [{ id: 'undo', label: '↶ Cofnij', disabled: !this.history.canUndo }, { id: 'redo', label: '↷ Ponów', disabled: !this.history.canRedo }],
          [{ id: 'add', label: '+ Dodaj mebel' }, { id: 'rooms', label: 'Przejdź do pokoju' }],
          variantRow,
          [{ id: 'doll', label: '🏠 Makieta' }, { id: 'exit', label: 'Zapisz i wyjdź', style: 'primary' }],
        ],
      };
    }
    // edycja — menu główne
    const anchor = this.anchorRoom();
    return {
      title: `Edycja w MR${anchor ? ' — ' + anchor.name : ''}`,
      lines: [
        'Wyceluj w mebel i trzymaj spust (lub szczypnij), aby go przesuwać. Gałka obraca chwycony mebel. Grip przywołuje panel.',
        this.alignInfo || '',
      ].filter(Boolean),
      rows: [
        [{ id: 'undo', label: '↶ Cofnij', disabled: !this.history.canUndo }, { id: 'redo', label: '↷ Ponów', disabled: !this.history.canRedo }],
        [{ id: 'add', label: '+ Dodaj mebel' }, { id: 'align', label: 'Wyrównaj model' }],
        [{ id: 'mesh', label: this.showMesh ? 'Trójkąty skanu: wł.' : 'Trójkąty skanu: wył.', style: this.showMesh ? 'active' : undefined }, { id: 'doll', label: '🏠 Makieta' }],
        variantRow,
        [{ id: 'exit', label: 'Zapisz i wyjdź', style: 'primary' }],
      ],
    };
  }

  // ======================= skan =======================
  updateScan(frame, now) {
    if (this.frameCount % 20 === 0) {
      const s = { ...sceneStats(frame), tri: this.live.stats.globalTriangles };
      const changed = !this.scanStats || JSON.stringify(s) !== JSON.stringify(this.scanStats);
      this.scanStats = s;
      if (changed || this.frameCount % 120 === 0) this.updatePanel();
      if (changed && s.planes) this.updateScanPreview(frame);
    }
  }

  updateScanPreview(frame) {
    try {
      const data = captureScene(frame, this.refSpace);
      const { room, frame: m } = convertScene(data, { keepGlobalMesh: false });
      this.previewRoom = room;
      this.setRootMatrix(new THREE.Matrix4().fromArray(m));
      this.view.setOptions({ showMesh: false, conflicts: new Map(), selectedId: null });
      this.view.rebuild({ rooms: [room] });
    } catch (e) {
      console.error(e);
      this.message = 'Błąd podglądu: ' + e.message;
    }
  }

  startRoomCapture() {
    if (this.session.initiateRoomCapture) {
      this.session.initiateRoomCapture().catch((e) => {
        this.message = 'Nie można uruchomić Space Setup z aplikacji (' + (e && e.message) + '). Uruchom ją w ustawieniach Questa: Środowisko fizyczne → Konfiguracja przestrzeni.';
        this.updatePanel();
      });
    } else {
      this.message = 'Ta przeglądarka nie pozwala uruchomić Space Setup z aplikacji. Uruchom ją w ustawieniach Questa: Środowisko fizyczne → Konfiguracja przestrzeni.';
      this.updatePanel();
    }
  }

  /** Kliknięcie przychodzi poza callbackiem klatki — XRFrame jest wtedy nieważny, więc zapis odkładamy do następnej klatki. */
  saveScan() {
    this.pendingSave = true;
  }

  doSaveScan(frame) {
    const data = captureScene(frame, this.refSpace);
    const n = this.project.rooms.length + 1;
    const { room, stats, frame: m } = convertScene(data, { name: `Pokój ${n}`, keepGlobalMesh: true });
    // Ułożenie w mieszkaniu: jeśli w tej sesji widać też podłogę wcześniej zeskanowanego pokoju, policz położenie względne.
    const placed = this.autoPlaceRoom(room, m, frame);
    if (!placed) {
      let maxX = -Infinity, minZ = Infinity;
      for (const r of this.project.rooms) for (const p of r.outline) {
        const w = roomToWorld(r, p);
        maxX = Math.max(maxX, w[0]);
        minZ = Math.min(minZ, w[1]);
      }
      if (isFinite(maxX)) {
        const minLocalX = Math.min(...room.outline.map((p) => p[0]));
        const minLocalZ = Math.min(...room.outline.map((p) => p[1]));
        room.transform = { x: maxX + 0.5 - minLocalX, z: minZ - minLocalZ, rot: 0 };
      }
    }
    this.project.rooms.push(room);
    this.anchorRoomId = room.id;
    this.anchorFrame = m;
    this.aligned = true;
    this.commit();
    this.applyAlignment();
    this.message = '';
    const warn = stats.warnings.length ? ' Uwagi: ' + stats.warnings.join(' ') : '';
    this.alignInfo = `Zapisano: ${room.name}, ${Math.abs(polygonArea(room.outline)).toFixed(1)} m², mebli: ${room.furniture.length}${placed ? ', dopasowano do sąsiedniego pokoju' : ''}.${warn}`;
    const first = this.unverified()[0];
    if (first) {
      this.state = 'verify';
      this.selectedId = first.id;
    } else {
      this.state = 'edit';
    }
    this.refresh();
  }

  /** Jeśli Quest udostępnia w tej sesji kilka podłóg, dopasuj nowy pokój do już istniejącego (po polu powierzchni). */
  autoPlaceRoom(newRoom, newFrameArr, frame) {
    const floors = floorPlanes(frame, this.refSpace);
    if (floors.length < 2 || !this.project.rooms.length) return false;
    const newPose = pose2D(newFrameArr);
    for (const fl of floors) {
      const fr = roomFrameFromFloor(fl.matrix);
      const p = pose2D(fr);
      if (Math.hypot(p.x - newPose.x, p.z - newPose.z) < 0.05) continue; // to nowy pokój
      const match = this.project.rooms.find((r) => r.scan && r.scan.floorArea && Math.abs(r.scan.floorArea - fl.area) / r.scan.floorArea < 0.05);
      if (!match) continue;
      // T_new = T_match ∘ A_match^-1 ∘ P_match^-1 ∘ P_new
      const rel = compose2D(invert2D(p), newPose);
      const a = match.xrAlign || { x: 0, z: 0, rot: 0 };
      newRoom.transform = compose2D(compose2D(match.transform, invert2D(a)), rel);
      return true;
    }
    return false;
  }

  // ======================= wyrównanie (edycja) =======================
  anchorRoom() {
    return this.project.rooms.find((r) => r.id === this.anchorRoomId) || null;
  }

  /** Szuka podłogi z Space Setup i dopasowuje do niej pokój z projektu. */
  tryAlign(frame) {
    if (this.alignAttempts === undefined) this.alignAttempts = 0;
    this.alignAttempts++;
    if (this.alignAttempts % 15 !== 1) return;
    const floors = floorPlanes(frame, this.refSpace);
    const rooms = this.project.rooms;
    if (!rooms.length) return;
    let best = null;
    for (const fl of floors) {
      for (const r of rooms) {
        const area = r.scan && r.scan.floorArea;
        const score = area ? Math.abs(area - fl.area) / area : 1;
        const pref = r.id === this.preferredRoomId ? -0.02 : 0;
        if (!best || score + pref < best.score) best = { fl, r, score: score + pref };
      }
    }
    if (best && best.score < 0.12) {
      this.anchorRoomId = best.r.id;
      this.anchorFrame = roomFrameFromFloor(best.fl.matrix);
      this.aligned = true;
      this.alignInfo = `Model dopasowany do podłogi pokoju „${best.r.name}”. Sprawdź, czy linie pokrywają się ze ścianami.`;
      this.applyAlignment();
      this.refresh();
      return;
    }
    // po ~3 s bez dopasowania: ustaw model przed użytkownikiem
    if (this.alignAttempts > 180 || (!floors.length && this.alignAttempts > 90)) {
      const r = rooms.find((x) => x.id === this.preferredRoomId) || rooms[0];
      this.anchorRoomId = r.id;
      const head = this.head || new THREE.Matrix4();
      const pos = new THREE.Vector3().setFromMatrixPosition(head);
      const fwd = new THREE.Vector3(0, 0, -1).transformDirection(head);
      const yaw = -Math.atan2(fwd.z, fwd.x) + Math.PI / 2;
      const c = polygonCentroid(r.outline);
      const m = matrixFrom2D({ x: pos.x, z: pos.z, rot: yaw }, this.estimateFloorY(frame));
      m.multiply(new THREE.Matrix4().makeTranslation(-c[0], 0, -c[1]));
      // F = m ∘ A^-1, aby zapisana korekta A nie przesuwała modelu ustawionego wokół użytkownika
      m.multiply(matrixFrom2D(r.xrAlign || { x: 0, z: 0, rot: 0 }).invert());
      this.anchorFrame = m.toArray();
      this.aligned = true;
      this.alignInfo = floors.length
        ? 'Nie rozpoznano pokoju (inna powierzchnia niż w projekcie). Ustaw model ręcznie: „Wyrównaj model”.'
        : 'Brak danych Space Setup. Model ustawiony wokół Ciebie — wyrównaj go ręcznie.';
      this.applyAlignment();
      this.refresh();
    }
  }

  /** root = F(podłoga) ∘ A(korekta) ∘ T(pokój)^-1 */
  applyAlignment() {
    if (this.dollhouse) { this.applyDollMatrix(); return; }
    if (this.isVR) { if (this.walkRoot) this.setRootMatrix(this.walkRoot); return; }
    const r = this.anchorRoom();
    if (!r || !this.anchorFrame) return;
    const a = r.xrAlign || { x: 0, z: 0, rot: 0 };
    const F = new THREE.Matrix4().fromArray(this.anchorFrame);
    const A = matrixFrom2D(a);
    const Tinv = matrixFrom2D(r.transform).invert();
    this.setRootMatrix(F.multiply(A).multiply(Tinv));
  }

  /** Poziom podłogi w przestrzeni odniesienia (w 'unbounded'/'local' y=0 nie musi być podłogą). */
  estimateFloorY(frame) {
    const floors = frame ? floorPlanes(frame, this.refSpace) : [];
    if (floors.length) return Math.min(...floors.map((f) => f.matrix[13]));
    if (this.refType === 'local-floor') return 0;
    const headY = this.head ? this.head.elements[13] : 1.6;
    return headY - 1.6;
  }

  // ======================= makieta (miniatura mieszkania) =======================
  apartmentBounds() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const r of this.project.rooms) for (const p of r.outline) {
      const w = roomToWorld(r, p);
      minX = Math.min(minX, w[0]); maxX = Math.max(maxX, w[0]);
      minZ = Math.min(minZ, w[1]); maxZ = Math.max(maxZ, w[1]);
    }
    if (!isFinite(minX)) return { cx: 0, cz: 0, size: 4 };
    return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, size: Math.max(maxX - minX, maxZ - minZ, 1) };
  }

  placeDollInFront() {
    if (!this.head) return;
    const pos = new THREE.Vector3().setFromMatrixPosition(this.head);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.head).setY(0).normalize();
    const p = pos.clone().addScaledVector(fwd, 0.75);
    p.y = Math.max(pos.y - 0.55, pos.y - 1.0);
    this.doll.pos = p;
    this.doll.yaw = -Math.atan2(fwd.z, fwd.x) - Math.PI / 2;
  }

  enterDollhouse() {
    const b = this.apartmentBounds();
    this.doll = { cx: b.cx, cz: b.cz, scale: Math.min(0.2, 0.8 / b.size), yaw: 0, pos: new THREE.Vector3(0, 1, -0.8) };
    this.placeDollInFront();
    this.dollhouse = true;
    this.selectedId = null;
    this.state = 'edit';
    this.view.mode = 'editor';
    this.view.setOptions({ wallMode: 'low', showZones: false, showGhosts: false, showLabels: false, mode: 'furniture' });
    this.applyDollMatrix();
    this.placePanel(true);
    this.refresh();
  }

  /** VR: spacer 1:1 — środek wybranego pokoju pod użytkownikiem. */
  enterWalk(roomId) {
    const room = this.project.rooms.find((r) => r.id === roomId) || this.anchorRoom() || this.project.rooms[0];
    if (!room) return;
    this.anchorRoomId = room.id;
    this.dollhouse = false;
    this.dollDrag = null;
    this.view.mode = 'editor';
    this.view.setOptions({ wallMode: 'full', showZones: true, showGhosts: false, showLabels: false, mode: 'furniture' });
    const c = roomToWorld(room, polygonCentroid(room.outline));
    const head = this.head ? new THREE.Vector3().setFromMatrixPosition(this.head) : new THREE.Vector3();
    this.walkRoot = new THREE.Matrix4().makeTranslation(head.x - c[0], 0, head.z - c[1]);
    this.applyAlignment();
    this.placePanel(true);
    this.refresh();
  }

  /** Chodzenie gałką (lewa) i obrót skokowy (prawa) w VR. */
  updateLocomotion(dt) {
    if (!this.isVR || this.dollhouse || !this.walkRoot || !this.head) return;
    this.turnCooldown = Math.max(0, this.turnCooldown - dt);
    const headPos = new THREE.Vector3().setFromMatrixPosition(this.head);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.head).setY(0).normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    let changed = false;
    for (const c of this.controllers) {
      const src = c.userData.inputSource;
      if (!src || !src.gamepad || (this.grab && this.grab.c === c)) continue;
      const sx = this.stickX(c), sy = this.stickY(c);
      if (src.handedness === 'left' && (sx || sy)) {
        const v = fwd.clone().multiplyScalar(-sy).addScaledVector(right, sx).multiplyScalar(1.4 * dt);
        // użytkownik idzie do przodu = świat przesuwa się do tyłu
        this.walkRoot.premultiply(new THREE.Matrix4().makeTranslation(-v.x, 0, -v.z));
        changed = true;
      } else if (src.handedness === 'right' && sx && this.turnCooldown === 0) {
        const ang = sx > 0 ? rad(30) : -rad(30);
        const m = new THREE.Matrix4().makeTranslation(headPos.x, 0, headPos.z)
          .multiply(new THREE.Matrix4().makeRotationY(ang))
          .multiply(new THREE.Matrix4().makeTranslation(-headPos.x, 0, -headPos.z));
        this.walkRoot.premultiply(m);
        this.turnCooldown = 0.35;
        changed = true;
      }
    }
    if (changed) this.applyAlignment();
  }

  exitDollhouse() {
    if (this.isVR) { this.enterWalk(this.anchorRoomId); return; }
    this.dollhouse = false;
    this.dollDrag = null;
    this.view.mode = 'mr';
    this.applyAlignment();
    this.placePanel(true);
    this.refresh();
  }

  applyDollMatrix() {
    const d = this.doll;
    const m = new THREE.Matrix4().makeTranslation(d.pos.x, d.pos.y, d.pos.z)
      .multiply(new THREE.Matrix4().makeRotationY(d.yaw))
      .multiply(new THREE.Matrix4().makeScale(d.scale, d.scale, d.scale))
      .multiply(new THREE.Matrix4().makeTranslation(-d.cx, 0, -d.cz));
    this.setRootMatrix(m);
  }

  /** Przesunięcie modelu w kierunku względem użytkownika. */
  alignMove(arg) {
    const r = this.anchorRoom();
    if (!r || !this.head) return;
    const step = arg.endsWith('5') ? 0.05 : 0.01;
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.head).setY(0).normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const d = { fwd: fwd, back: fwd.clone().negate(), left: right.clone().negate(), right }[arg.replace(/\d+$/, '')];
    this.alignTranslateWorld(d.clone().multiplyScalar(step));
    this.commit();
  }

  /** Przesuwa model o wektor w świecie (przelicza na korektę w układzie podłogi). */
  alignTranslateWorld(v) {
    const r = this.anchorRoom();
    const F = new THREE.Matrix4().fromArray(this.anchorFrame);
    const rotF = new THREE.Matrix4().extractRotation(F).invert();
    const local = v.clone().applyMatrix4(rotF);
    r.xrAlign = { ...r.xrAlign, x: r.xrAlign.x + local.x, z: r.xrAlign.z + local.z };
    this.applyAlignment();
  }

  /** Obrót modelu wokół środka pokoju-kotwicy. */
  alignRotate(delta) {
    const r = this.anchorRoom();
    if (!r) return;
    const a = r.xrAlign;
    const c = polygonCentroid(r.outline);
    // punkt środka w układzie podłogi przed i po obrocie — kompensujemy przesunięcie
    const before = roomToWorld({ transform: a }, c);
    const na = { ...a, rot: normalizeAngle(a.rot + delta) };
    const after = roomToWorld({ transform: na }, c);
    r.xrAlign = { x: na.x + before[0] - after[0], z: na.z + before[1] - after[1], rot: na.rot };
    this.applyAlignment();
    this.commit();
  }

  // ======================= wybór i chwytanie =======================
  onSelectStart(c) {
    const ph = this.panelHit(c);
    if (ph) {
      if (this.panel.click(ph.uv)) this.haptic(c, 0.3, 15);
      return;
    }
    if (this.state === 'scan') return;
    if (this.state === 'align') {
      const fp = this.rayFloor(c);
      if (fp) this.alignDrag = { c, last: fp };
      return;
    }
    const fh = this.furnitureHit(c);
    if (this.state === 'merge') {
      if (fh && fh.object.userData.id !== this.selectedId) {
        const merged = mergeFurniture(this.project, [this.selectedId, fh.object.userData.id]);
        if (merged) this.selectedId = merged.id;
        this.state = this.mergeReturn === 'verify' && merged && !merged.verified ? 'verify' : 'edit';
        this.mergeReturn = null;
        this.haptic(c, 0.6, 40);
        this.commit();
      }
      return;
    }
    if (!fh && this.dollhouse) {
      const fp = this.rayFloor(c);
      if (fp) this.dollDrag = { c, last: fp };
      return;
    }
    if (fh) {
      const { id } = fh.object.userData;
      const found = findFurniture(this.project, id);
      if (!found) return;
      if (this.state === 'verify') {
        this.selectedId = id;
        this.refresh();
        return;
      }
      this.selectedId = id;
      if (this.state === 'type' || this.state === 'add') this.state = 'edit';
      const fp = this.rayFloor(c);
      if (fp) {
        const ap = this.worldToApartment(fp);
        const local = worldToRoom(found.room, ap);
        this.grab = { c, id, off: [found.f.x - local[0], found.f.z - local[1]], moved: false };
      }
      this.haptic(c);
      this.refresh();
    }
  }

  onSelectEnd(c) {
    if (this.dollDrag && this.dollDrag.c === c) this.dollDrag = null;
    if (this.alignDrag && this.alignDrag.c === c) {
      this.alignDrag = null;
      this.commit();
    }
    if (this.grab && this.grab.c === c) {
      const moved = this.grab.moved;
      const id = this.grab.id;
      this.grab = null;
      if (moved) {
        this.reparent(id);
        this.commit();
      }
    }
  }

  stickX(c) {
    const gp = c.userData.inputSource && c.userData.inputSource.gamepad;
    if (!gp || !gp.axes || gp.axes.length < 4) return 0;
    const x = gp.axes[2];
    return Math.abs(x) > 0.25 ? x : 0;
  }

  stickY(c) {
    const gp = c.userData.inputSource && c.userData.inputSource.gamepad;
    if (!gp || !gp.axes || gp.axes.length < 4) return 0;
    const y = gp.axes[3];
    return Math.abs(y) > 0.25 ? y : 0;
  }

  updateDollhouse(dt) {
    if (this.dollDrag) {
      const fp = this.rayFloor(this.dollDrag.c);
      if (fp) {
        const d = fp.clone().sub(this.dollDrag.last);
        d.y = 0;
        // ograniczenie skoku (promień prawie równoległy do podłogi)
        if (d.length() < 0.5) { this.doll.pos.add(d); this.applyDollMatrix(); }
        this.dollDrag.last = fp;
      }
    }
    if (this.grab) return;
    let changed = false;
    for (const c of this.controllers) {
      if (!c.visible) continue;
      const sx = this.stickX(c), sy = this.stickY(c);
      if (sx) { this.doll.yaw -= sx * dt * 1.5; changed = true; }
      if (sy) { this.doll.scale = Math.min(0.5, Math.max(0.01, this.doll.scale * (1 - sy * dt * 0.8))); changed = true; }
    }
    if (changed) {
      this.applyDollMatrix();
      if (this.frameCount % 10 === 0) this.updatePanel();
    }
  }

  updateGrab(dt) {
    if (this.dollhouse) this.updateDollhouse(dt);
    else this.updateLocomotion(dt);
    if (this.alignDrag) {
      const c = this.alignDrag.c;
      const fp = this.rayFloor(c);
      if (fp) {
        const d = fp.clone().sub(this.alignDrag.last);
        d.y = 0;
        if (d.lengthSq() > 1e-8) this.alignTranslateWorld(d);
        this.alignDrag.last = fp;
      }
      const sx = this.stickX(c);
      if (sx) {
        const r = this.anchorRoom();
        const a = r.xrAlign;
        const cc = polygonCentroid(r.outline);
        const before = roomToWorld({ transform: a }, cc);
        const na = { ...a, rot: normalizeAngle(a.rot - sx * dt * 0.5) };
        const after = roomToWorld({ transform: na }, cc);
        r.xrAlign = { x: na.x + before[0] - after[0], z: na.z + before[1] - after[1], rot: na.rot };
        this.applyAlignment();
      }
      return;
    }
    if (!this.grab) return;
    const found = findFurniture(this.project, this.grab.id);
    if (!found) { this.grab = null; return; }
    const { room, f } = found;
    const c = this.grab.c;
    const fp = this.rayFloor(c);
    if (fp) {
      const local = worldToRoom(room, this.worldToApartment(fp));
      const nx = local[0] + this.grab.off[0], nz = local[1] + this.grab.off[1];
      if (Math.hypot(nx - f.x, nz - f.z) > 0.002) {
        f.x = nx;
        f.z = nz;
        const s = snapToWalls(room, f, 0.05);
        if (s) { f.x = s.x; f.z = s.z; }
        this.grab.moved = true;
      }
    }
    const sx = this.stickX(c);
    if (sx) {
      f.rot = normalizeAngle((f.rot || 0) - sx * dt * 1.6);
      this.grab.moved = true;
    }
    if (this.grab.moved) {
      this.view.updateFurnitureTransform(f);
      if (this.frameCount % 3 === 0) {
        this.view.setOptions({ conflicts: this.allConflicts() });
        this.view.applyHighlights();
      }
      this.updateSelectionLabel();
    }
  }

  reparent(id) {
    const found = findFurniture(this.project, id);
    if (!found) return;
    const { room, f } = found;
    const w = roomToWorld(room, [f.x, f.z]);
    if (roomContainsWorldPoint(room, w)) return;
    const target = this.project.rooms.find((r) => r !== room && roomContainsWorldPoint(r, w));
    if (!target) return;
    const local = worldToRoom(target, w);
    f.x = local[0];
    f.z = local[1];
    f.rot = normalizeAngle((f.rot || 0) + room.transform.rot - target.transform.rot);
    room.furniture.splice(room.furniture.indexOf(f), 1);
    target.furniture.push(f);
  }

  // ======================= operacje na meblach =======================
  sel() {
    return this.selectedId ? findFurniture(this.project, this.selectedId) : null;
  }

  rotateSelected(d) {
    const s = this.sel();
    if (!s) return;
    s.f.rot = normalizeAngle((s.f.rot || 0) + d);
    this.commit();
  }

  resizeSelected(delta) {
    const s = this.sel();
    if (!s) return;
    const k = this.activeDim;
    resizeFurniture(s.f, k, s.f[k] + delta);
    this.commit();
  }

  snapSelected() {
    const s = this.sel();
    if (!s) return;
    const r = snapToWalls(s.room, s.f, 0.3);
    if (r) { s.f.x = r.x; s.f.z = r.z; this.commit(); }
  }

  alignSelectedToWall() {
    const s = this.sel();
    if (!s) return;
    s.f.rot = alignRotationToNearestWall(s.room, s.f);
    this.commit();
  }

  hideSelected() {
    const s = this.sel();
    if (!s) return;
    s.f.hidden = true;
    this.selectedId = null;
    this.state = 'edit';
    this.commit();
  }

  deleteSelected() {
    const s = this.sel();
    if (!s) return;
    s.room.furniture = s.room.furniture.filter((x) => x.id !== s.f.id);
    this.selectedId = null;
    this.state = 'edit';
    this.commit();
  }

  duplicateSelected() {
    const s = this.sel();
    if (!s) return;
    const copy = { ...structuredClone(s.f), id: uid('f'), name: s.f.name + ' (kopia)', x: s.f.x + 0.3, z: s.f.z + 0.3, scanned: null };
    s.room.furniture.push(copy);
    this.selectedId = copy.id;
    this.commit();
  }

  cycleShape() {
    const s = this.sel();
    if (!s || s.f.shape === 'compound') return;
    const order = ['box', 'L', 'cylinder'];
    const f = s.f;
    f.shape = order[(order.indexOf(f.shape) + 1) % order.length];
    if (f.shape === 'L') { f.aw = f.aw || Math.min(0.9, f.w / 2); f.ad = f.ad || Math.min(0.9, f.d / 2); }
    this.commit();
  }

  /** Przesunięcie o 1 cm w kierunku względem użytkownika. */
  nudgeSelected(dir) {
    const s = this.sel();
    if (!s || !this.head) return;
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.head).setY(0).normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const w = { fwd, back: fwd.clone().negate(), left: right.clone().negate(), right }[dir];
    if (!w) return;
    // kierunek świata -> układ mieszkania (bez skali makiety) -> układ pokoju
    const rot = new THREE.Matrix4().extractRotation(this.root.matrix).invert();
    const a = w.clone().applyMatrix4(rot).setY(0).normalize();
    const t = s.room.transform.rot || 0;
    const c = Math.cos(-t), sn = Math.sin(-t);
    s.f.x += (a.x * c + a.z * sn) * 0.01;
    s.f.z += (-a.x * sn + a.z * c) * 0.01;
    this.commit();
  }

  setSelectedType(type) {
    const s = this.sel();
    if (!s) return;
    const def = s.f.name === typeName(s.f.type);
    s.f.type = type;
    s.f.color = typeColor(type);
    if (def) s.f.name = typeName(type);
    s.f.verified = true;
    this.state = 'edit';
    this.commit();
  }

  addTemplate(tpl) {
    const room = this.anchorRoom() || this.project.rooms[0];
    if (!room || !this.head) return;
    const pos = new THREE.Vector3().setFromMatrixPosition(this.head);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.head).setY(0).normalize();
    const p = pos.clone().addScaledVector(fwd, 1.2);
    const local = this.dollhouse ? polygonCentroid(room.outline) : worldToRoom(room, this.worldToApartment(p));
    const f = createFurniture({ ...tpl, name: tpl.name || typeName(tpl.type), x: local[0], z: local[1], verified: true });
    room.furniture.push(f);
    this.selectedId = f.id;
    this.state = 'edit';
    this.commit();
  }

  // ---- potwierdzanie typów (dopytywanie) ----
  unverified() {
    const out = [];
    for (const r of this.project.rooms) for (const f of r.furniture) if (!f.verified && !f.hidden) out.push(f);
    // najpierw z bieżącego pokoju
    const a = this.anchorRoom();
    if (a) out.sort((x, y) => (a.furniture.includes(y) ? 1 : 0) - (a.furniture.includes(x) ? 1 : 0));
    return out;
  }

  nextVerify() {
    const next = this.unverified()[0];
    if (next) { this.selectedId = next.id; this.state = 'verify'; } else { this.selectedId = null; this.state = 'edit'; }
    this.commit();
  }

  verifyAs(type) {
    const s = this.sel();
    if (!s) return this.nextVerify();
    if (type) {
      const def = s.f.name === typeName(s.f.type);
      s.f.type = type;
      s.f.color = typeColor(type);
      if (def) s.f.name = typeName(type);
    }
    s.f.verified = true;
    this.nextVerify();
  }

  verifyHide() {
    const s = this.sel();
    if (s) { s.f.hidden = true; s.f.verified = true; }
    this.nextVerify();
  }

  verifyDelete() {
    const s = this.sel();
    if (s) s.room.furniture = s.room.furniture.filter((x) => x !== s.f);
    this.nextVerify();
  }

  // ======================= model / historia =======================
  allConflicts() {
    const m = new Map();
    for (const r of this.project.rooms) for (const [id, l] of computeConflicts(r)) m.set(id, l);
    return m;
  }

  commit() {
    if (this.history.commit(this.project)) {
      this.dirty = true;
      if (this.onSave) this.onSave(this.project);
    }
    this.refresh();
  }

  undo() {
    const p = this.history.undo(this.project);
    if (p) this.replaceProject(p);
  }

  redo() {
    const p = this.history.redo(this.project);
    if (p) this.replaceProject(p);
  }

  replaceProject(p) {
    // zachowujemy tę samą referencję obiektu projektu (używaną poza sesją XR)
    Object.keys(this.project).forEach((k) => delete this.project[k]);
    Object.assign(this.project, p);
    if (this.selectedId && !findFurniture(this.project, this.selectedId)) { this.selectedId = null; if (this.state !== 'align') this.state = 'edit'; }
    this.dirty = true;
    if (this.onSave) this.onSave(this.project);
    this.applyAlignment();
    this.refresh();
  }

  refresh() {
    if (this.state === 'scan') { this.updatePanel(); return; }
    // zapisana siatka nie jest potrzebna w MR — trójkąty pokazuje podgląd na żywo (LiveSceneOverlay)
    this.view.setOptions({ showMesh: false, conflicts: this.allConflicts(), selectedId: this.selectedId });
    this.view.rebuild(this.project);
    this.updateSelectionLabel();
    this.updatePanel();
  }

  updateSelectionLabel() {
    for (const ch of [...this.labels.children]) {
      if (ch.material.map) ch.material.map.dispose();
      ch.material.dispose();
      if (ch.geometry && ch.userData.isClearance) ch.geometry.dispose();
      this.labels.remove(ch);
    }
    // etykiety są w układzie mieszkania — w makiecie kompensujemy skalę, żeby były czytelne
    const k = this.dollhouse ? 0.35 / this.doll.scale : 1;
    const addLabel = (f, room, text, color, bg) => {
      const s = makeTextSprite(text, { color, bg });
      const w = roomToWorld(room, [f.x, f.z]);
      s.scale.multiplyScalar(k);
      s.position.set(w[0], (f.y || 0) + f.h + 0.1 * k, w[1]);
      this.labels.add(s);
    };
    const s = this.sel();
    if (s) addLabel(s.f, s.room, `${s.f.name}  ${cmTxt(s.f.w)}×${cmTxt(s.f.d)}×${cmTxt(s.f.h)}`, '#111111', 'rgba(255,212,0,0.95)');
    // wolne miejsce wokół zaznaczonego mebla (linie + odległości), jak na PC
    if (s && !s.f.hidden) {
      const y = (s.f.y || 0) + Math.min(s.f.h, 0.3);
      for (const c of computeClearances(s.room, s.f)) {
        const a = roomToWorld(s.room, c.from), b = roomToWorld(s.room, c.to);
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a[0], y, a[1]), new THREE.Vector3(b[0], y, b[1])]),
          new THREE.LineBasicMaterial({ color: c.dist < 0.05 ? 0xff4040 : 0x30d070, depthTest: false }),
        );
        line.renderOrder = 25;
        line.userData.isClearance = true;
        this.labels.add(line);
        if (c.dist > 0.01) {
          const t = makeTextSprite(`${cmTxt(c.dist)} cm`, { color: '#ffffff', bg: c.dist < 0.6 ? 'rgba(200,40,40,0.9)' : 'rgba(20,120,60,0.9)', height: 0.045 });
          t.scale.multiplyScalar(k);
          t.position.set((a[0] + b[0]) / 2, y + 0.02 * k, (a[1] + b[1]) / 2);
          this.labels.add(t);
        }
      }
    }
    if (this.state === 'verify' || this.state === 'edit') {
      for (const r of this.project.rooms) for (const f of r.furniture) {
        if (!f.verified && !f.hidden && f.id !== this.selectedId) addLabel(f, r, '?', '#ffffff', 'rgba(47,111,222,0.9)');
      }
    }
  }

  exitAndSave() {
    this.dirty = true;
    this.end();
  }
}
