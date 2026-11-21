// Sesja WebXR (immersive-ar) na Meta Quest: skan pokoju ze Space Setup, potwierdzanie mebli
// i edycja makiety w mieszanej rzeczywistości (skala 1:1, na tle passthrough).
import * as THREE from 'three';
import { Panel3D, makeTextSprite } from './ui3d.js';
import { LiveSceneOverlay } from './liveOverlay.js';
import { captureScene, sceneStats, floorPlanes } from './sceneCapture.js';
import { convertScene, convertAllRooms, roomFrameFromFloor, listFloors, floorAtPoint } from '../scanConvert.js';
import { applyScanShape, applyBoxShape } from '../scanShape.js';
import { checkRoom, verdictText } from '../scanCheck.js';
import { PhotoCapture, fovYFromProj } from './photoCapture.js';
import { ApartmentView } from '../roomView.js';
import {
  computeConflicts, snapToWalls, normalizeAngle, rad, polygonCentroid, alignRotationToNearestWall, worldToRoom, roomToWorld,
  polygonArea, roomContainsWorldPoint, localToWorld, mountOf, attachToWall, moveEdge, edgeOf,
} from '../geometry.js';
import {
  History, createFurniture, createOpening, findFurniture, uid, mergeFurniture, splitFurniture, resizeFurniture,
  ensureVariants, activeVariant, switchVariant, createVariant, deleteVariant, addMedia, createCamera,
} from '../model.js';
import { computeClearances } from '../geometry.js';
import { FURNITURE_TYPES, TYPE_KEYS, TEMPLATES, PALETTE, typeName, typeColor } from '../labels.js';

// 'unbounded' = chodzenie po całym mieszkaniu bez granicy Guardian (przeglądarka Questa obsługuje ją
// eksperymentalnie). Gdy niedostępna — 'local-floor', a na końcu 'local'. Nic nie jest wymagane,
// żeby sesja nie wymuszała ustawiania granicy.
function sessionInit(preferUnbounded) {
  return {
    requiredFeatures: [],
    optionalFeatures: [...(preferUnbounded ? ['unbounded'] : []), 'local-floor', 'plane-detection', 'mesh-detection', 'hand-tracking', 'anchors', 'hit-test', 'camera-access'],
  };
}

export async function isVRSupported() {
  try {
    return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr')));
  } catch (e) {
    return false;
  }
}


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
    // edycja/VR zaczyna się od ekranu wyboru trybu i wersji
    this.state = o.mode === 'scan' ? 'scan' : 'start';
    this.tab = 'furniture';
    this.selWall = null;
    this.walkRoot = null;
    this.mergeReturn = null;
    this.turnCooldown = 0;
    this.selectedId = null;
    this.activeDim = 'w';
    this.grab = null;
    this.alignDrag = null;
    this.showMesh = false; // trójkąty skanu na żywo w trybie edycji (przy skanie zawsze)
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
    // przy skanie trójkąty zawsze widoczne; potem wg ustawień użytkownika
    this.live.setStyle(this.state === 'scan' ? { mesh: 0.45, furniture: true, planes: true } : this.liveStyle());
    scene.add(this.live.group);

    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = false;
    scene.add(this.root);
    this.view = new ApartmentView({ mode: 'mr', cssLabels: false });
    this.root.add(this.view.group);
    this.labels = new THREE.Group();
    this.root.add(this.labels);
    this.holesGroup = new THREE.Group(); // czerwone kafelki: niezeskanowane miejsca
    this.root.add(this.holesGroup);
    this.buildGuide();

    this.panel = new Panel3D({ width: 0.46 });
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
      this.state = 'start';
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
    if (this.photo) this.photo.dispose();
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
      c.addEventListener('squeezestart', () => { if (this.dollhouse) this.startDollGrab(c); else this.placePanel(true); });
      c.addEventListener('squeezeend', () => this.endDollGrab(c));
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
    if (this.frameCount % 30 === 1 && this.head) this.floorLevel = this.estimateFloorY(this.isVR ? null : frame);
    if (this.pendingPhoto && pose) this.processPhoto(pose);
    if (this.needDollPlace && this.head) {
      this.needDollPlace = false;
      this.placeDollInFront();
      this.applyDollMatrix();
      this.placePanel(true);
    }
    if (!this.panelPlaced && this.head) this.placePanel(false);
    else if (this.head && this.frameCount % 30 === 0) this.keepPanelInView();

    if (this.state === 'scan' && this.pendingSave) {
      const which = this.pendingSave;
      this.pendingSave = false;
      if (which === 'all') this.doSaveAllRooms(frame); else this.doSaveScan(frame);
    }
    if (this.state === 'scan') this.updateScan(frame, now);
    if (!this.aligned && this.state !== 'scan') this.tryAlign(frame);
    const liveOn = !this.isVR && (this.state === 'scan' || (this.showMesh && !this.dollhouse && !this.walking));
    this.live.visible = liveOn;
    if (liveOn) this.live.update(frame, this.refSpace);
    if (this.state === 'scan' && this.frameCount % 45 === 0) this.updatePanel();

    this.updateGrab(dt);
    this.updateGuide(now / 1000);
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
      saveScan: () => this.saveScan('one'),
      saveAll: () => this.saveScan('all'),
      shapeScan: () => {
        const s = this.sel();
        if (!s) return;
        const err = applyScanShape(s.room, s.f);
        this.shapeMsg = err || 'Kształt ze skanu: bryła złożona z kilku części.';
        this.commit();
      },
      shapeBox: () => { const s = this.sel(); if (s) { applyBoxShape(s.f); this.shapeMsg = 'Zwykły prostopadłościan.'; this.commit(); } },
      roomCapture: () => this.startRoomCapture(),
      scanUseSaved: () => { this.scanChoice = 'saved'; this.updatePanel(); },
      scanNew: () => { this.scanChoice = 'new'; this.startRoomCapture(); this.updatePanel(); },
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
      setColor: () => { const s = this.sel(); if (s) { s.f.color = arg === 'type' ? typeColor(s.f.type) : arg; if (this.state === 'colors') this.state = 'edit'; this.commit(); } },
      shape: () => this.cycleShape(),
      split: () => { const parts = splitFurniture(this.project, this.selectedId); if (parts.length) { this.selectedId = parts[0].id; this.state = 'edit'; this.commit(); } },
      elev: () => { const s = this.sel(); if (s) { s.f.y = Math.max(0, (s.f.y || 0) + parseFloat(arg) / 100); this.commit(); } },
      nudge: () => this.nudgeSelected(arg),
      resetScan: () => { const s = this.sel(); if (s && s.f.scanned) { Object.assign(s.f, s.f.scanned); this.commit(); } },
      verified: () => { const s = this.sel(); if (s) { s.f.verified = !s.f.verified; this.commit(); } },
      variants: () => { this.tab = 'versions'; this.state = 'edit'; this.selectedId = null; this.refresh(); },
      varSwitch: () => { switchVariant(this.project, arg); this.selectedId = null; if (this.state !== 'start') this.state = 'edit'; this.commit(); },
      varNew: () => { createVariant(this.project); this.selectedId = null; if (this.state !== 'start') this.state = 'edit'; this.commit(); },
      varDel: () => { deleteVariant(this.project, this.project.activeVariantId); this.selectedId = null; this.state = 'edit'; this.commit(); },
      hidden: () => { this.state = 'hidden'; this.updatePanel(); },
      unhide: () => { const s = findFurniture(this.project, arg); if (s) { s.f.hidden = false; this.selectedId = s.f.id; this.state = 'edit'; this.commit(); } },
      verifyAll: () => this.nextVerify(),
      rooms: () => { this.state = 'rooms'; this.updatePanel(); },
      goRoom: () => { this.state = 'edit'; if (this.dollhouse) this.dollhouse = false; this.enterWalk(arg); },
      exitWalk: () => this.exitWalk(),
      photo: () => { this.photoReturn = this.selectedId ? 'furniture' : 'tools'; this.state = 'photo'; this.updatePanel(); },
      photoTake: () => this.requestPhoto(null),
      photoFurn: () => this.requestPhoto(this.selectedId),
      photoBack: () => { this.state = 'edit'; this.refresh(); },
      tab: () => { this.tab = arg; this.state = 'edit'; if (arg === 'walls') this.selectedId = null; if (arg !== 'walls') this.selWall = null; this.refresh(); },
      start: () => { if (arg === 'menu') { this.state = 'start'; this.selectedId = null; this.selWall = null; this.refresh(); } else this.chooseMode(arg); },
      modeMR: () => { if (this.dollhouse) this.exitDollhouse(); else if (this.walking) this.exitWalk(); this.tab = 'mode'; this.refresh(); },
      modeDoll: () => { this.enterDollhouse(); this.tab = 'mode'; this.refresh(); },
      modeWalk: () => this.chooseMode('walk'),
      wallMove: () => this.moveSelectedWall(parseFloat(arg) / 100),
      wallOpening: () => this.addOpeningOnWall(arg),
      wallDeselect: () => { this.selWall = null; this.refresh(); },
      roomHeight: () => { const r = this.selWall && this.project.rooms.find((x) => x.id === this.selWall.roomId); if (r) { r.height = Math.max(1.8, Math.round((r.height + parseFloat(arg) / 100) * 100) / 100); this.commit(); } },
      floorAdj: () => this.adjustFloor(parseFloat(arg) / 100),
      mount: () => { const s0 = this.sel(); if (s0) { s0.f.mount = arg; if (arg === 'wall') { const a = attachToWall(s0.room, s0.f, 2); if (a) Object.assign(s0.f, a); if (!s0.f.y) s0.f.y = 1.2; } else s0.f.y = 0; this.commit(); } },
      liveMesh: () => { const st = this.liveStyle(); st.mesh = parseFloat(arg); this.showMesh = st.mesh > 0; this.live.setStyle(st); this.saveLook(); },
      liveFurn: () => { const st = this.liveStyle(); st.furniture = !st.furniture; this.live.setStyle(st); this.saveLook(); },
      livePlanes: () => { const st = this.liveStyle(); st.planes = !st.planes; this.live.setStyle(st); this.saveLook(); },
      check: () => this.openCheck(),
      issue: () => this.gotoIssue(+arg),
      checkBack: () => { this.state = this.checkReturn || 'edit'; if (this.state !== 'scan') this.holesGroup.clear(); this.refresh(); },
      look: () => { this.tab = 'view'; this.state = 'edit'; this.selectedId = null; this.refresh(); },
      lookWall: () => { this.lookFor().wallStyle = arg; this.saveLook(); },
      lookWallOp: () => { const l = this.lookFor(); l.wallOpacity = parseFloat(arg); if (l.wallStyle !== 'transparent') l.wallStyle = 'transparent'; this.saveLook(); },
      lookFurn: () => { this.lookFor().furnStyle = arg; this.saveLook(); },
      lookFurnOp: () => { const l = this.lookFor(); l.furnOpacity = parseFloat(arg); l.furnStyle = 'solid'; this.saveLook(); },
      lookFloor: () => { const l = this.lookFor(); l.floor = !l.floor; this.saveLook(); },
      display: () => { const s = this.sel(); if (s) { s.f.display = arg === 'normal' ? undefined : arg; this.commit(); } },
      measure: () => { this.state = 'measure'; this.selectedId = null; this.refresh(); },
      measureClear: () => { this.measures = []; this.refresh(); },
      newBox: () => this.addTemplate(TEMPLATES.find((t) => t.key === 'box')),
      add: () => { this.state = 'add'; this.updatePanel(); },
      addTpl: () => this.addTemplate(TEMPLATES[+arg]),
      align: () => { this.state = 'align'; this.selectedId = null; this.refresh(); },
      alignMove: () => this.alignMove(arg),
      alignRot: () => this.alignRotate(rad(parseFloat(arg))),
      alignReset: () => { const r = this.anchorRoom(); if (r) { r.xrAlign = { x: 0, z: 0, rot: 0 }; this.aligned = false; this.commit(); } },
      back: () => {
        if (this.state === 'merge' && this.mergeReturn === 'verify') this.state = 'verify';
        else if (this.state === 'colors') this.state = 'edit';
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
    if (st === 'check') {
      const res = this.checkRes;
      if (!res) return { title: 'Kontrola skanu', lines: ['Brak danych do sprawdzenia.'], rows: [[{ id: 'checkBack', label: '← Wróć' }]] };
      const icon = { error: '✖', warn: '⚠', info: 'ℹ' };
      const rows = res.issues.slice(0, 8).map((it, i) => [{ id: `issue:${i}`, label: `${icon[it.level]} ${it.text.length > 70 ? it.text.slice(0, 68) + '…' : it.text}`, style: it.level === 'error' ? 'danger' : it.level === 'warn' ? 'active' : 'muted' }]);
      rows.push([{ id: 'checkBack', label: '← Wróć', style: 'primary' }]);
      return {
        title: `Kontrola skanu${this.checkRoomRef ? ' — ' + this.checkRoomRef.name : ''}`,
        lines: [verdictText(res), res.issues.length > 8 ? `Pokazano 8 z ${res.issues.length} uwag (pełna lista na PC).` : 'Kliknij uwagę o meblu, żeby go wskazać.'],
        rows,
      };
    }
    if (st === 'scan' && !this.scanChoice && this.scanStats && this.scanStats.planes) {
      // w goglach jest już zapisany skan (Space Setup) — użyć go czy skanować od nowa?
      const s = this.scanStats;
      return {
        title: 'Skan pokoju',
        lines: [
          `Gogle mają już zapisany skan (Space Setup): podłogi ${s.floors}, ściany ${s.walls}, meble ${s.furniture}. Widzisz go teraz jako trójkąty i bryły.`,
          'Możesz go użyć albo zeskanować pomieszczenie od nowa. Nowy skan zastąpi ten zapisany w goglach (to ustawienie systemowe Questa, wspólne dla wszystkich projektów).',
        ],
        rows: [
          [{ id: 'scanUseSaved', label: 'Użyj zapisanego skanu' }],
          [{ id: 'scanNew', label: '↻ Zeskanuj od nowa', style: 'primary' }],
          [{ id: 'cancel', label: 'Anuluj', style: 'muted' }],
        ],
      };
    }
    if (st === 'scan') {
      const s = this.scanStats || { planes: 0, meshes: 0, floors: 0, walls: 0, furniture: 0 };
      const enabled = (this.session && this.session.enabledFeatures) || [];
      const lines = [];
      if (enabled.length && !enabled.includes('plane-detection')) lines.push('Przeglądarka nie udostępniła danych pomieszczenia (plane-detection). Zezwól na dostęp do danych przestrzennych.');
      lines.push(`Wykryto: podłoga ${s.floors ? 'tak' : 'NIE'}, ściany: ${s.walls}, meble/obiekty: ${s.furniture}, trójkąty siatki: ${this.live.stats.globalTriangles.toLocaleString('pl-PL')}.`);
      lines.push(this.refType === 'unbounded' ? 'Tryb bez granicy: możesz chodzić po całym mieszkaniu.' : `Przestrzeń: ${this.refType} (z granicą Guardian).`);
      if (!s.planes && performance.now() - this.scanStartTime > 2500) lines.push('Brak danych pokoju. Uruchom konfigurację przestrzeni (Space Setup) i obejdź pokój, zaznaczając meble.');
      else lines.push('Turkusowe trójkąty to siatka ze skanu, żółte to meble ze Space Setup. Tam, gdzie nie ma trójkątów, pokój nie jest zeskanowany: popraw w Space Setup.');
      if ((this.scanFloors || 0) >= 2) lines.push(`Space Setup zawiera ${this.scanFloors} pokoje. ${this.scanHereArea ? 'Podświetlony jest ten, w którym stoisz.' : 'Stań w pokoju, który chcesz zapisać.'}`);
      if (this.checkRes) lines.push(verdictText(this.checkRes) + (this.checkRes.holes.length ? ' Czerwone kafelki = niezeskanowane miejsca.' : ''));
      if (this.message) lines.push(this.message);
      return {
        title: 'Skan pokoju',
        lines,
        rows: (this.scanFloors || 0) >= 2
          ? [
            [{ id: 'saveScan', label: `Zapisz pokój, w którym stoję${this.scanHereArea ? ` (${this.scanHereArea.toFixed(1)} m²)` : ''}`, style: 'primary', disabled: !this.scanHereArea }],
            [{ id: 'saveAll', label: `Zapisz wszystkie pokoje (${this.scanFloors})` }, { id: 'check', label: '✔ Szczegóły kontroli' }],
            [{ id: 'roomCapture', label: '↻ Zeskanuj od nowa' }, { id: 'cancel', label: 'Anuluj', style: 'muted' }],
          ]
          : [
            [{ id: 'saveScan', label: 'Zapisz pokój', style: 'primary', disabled: !s.planes }, { id: 'check', label: '✔ Szczegóły kontroli', disabled: !this.checkRes }],
            [{ id: 'roomCapture', label: s.planes ? '↻ Zeskanuj od nowa' : 'Skanuj (Space Setup)' }, { id: 'cancel', label: 'Anuluj', style: 'muted' }],
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
      rows.push([
        { id: 'shapeBox', label: 'Bryła: prostopadłościan', style: f.shape !== 'compound' ? 'active' : undefined },
        { id: 'shapeScan', label: 'Bryła: kształt ze skanu', style: f.fromScan ? 'active' : undefined },
      ]);
      rows.push([{ id: 'mergeStart', label: '⧉ Scal z inną bryłą (to jeden mebel)' }]);
      rows.push([{ id: 'vhide', label: 'Tymczasowy (ukryj)' }, { id: 'vdel', label: 'To nie mebel', style: 'danger' }, { id: 'vskip', label: 'Pomiń resztę', style: 'muted' }]);
      return {
        title: `Co to jest? (zostało ${left})`,
        lines: [`Podświetlona bryła: ${cmTxt(f.w)}×${cmTxt(f.d)}×${cmTxt(f.h)} cm (skaner: ${f.sourceLabel || '—'}).`, this.shapeMsg || ''].filter(Boolean),
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
    if (st === 'measure') {
      const m = this.measures || [];
      const last = m.length >= 2 && m.length % 2 === 0 ? this.measureText(m[m.length - 2], m[m.length - 1]) : null;
      return {
        title: '📏 Miarka',
        lines: [
          'Wskaż spustem dwa punkty: mebel, ścianę albo podłogę. W makiecie mierzysz w prawdziwej skali.',
          m.length % 2 === 1 ? 'Wskaż drugi punkt…' : last ? `Ostatni pomiar: ${last}` : '',
        ].filter(Boolean),
        rows: [[{ id: 'measureClear', label: 'Wyczyść pomiary' }, { id: 'back', label: 'Gotowe', style: 'primary' }]],
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
          [{ id: 'shapeBox', label: 'Prostopadłościan', style: f.shape === 'box' ? 'active' : undefined }, { id: 'shapeScan', label: 'Kształt ze skanu', style: f.fromScan ? 'active' : undefined }],
          [{ id: 'elev:-5', label: 'Niżej 5' }, { id: 'elev:-1', label: 'Niżej 1' }, { id: 'elev:1', label: 'Wyżej 1' }, { id: 'elev:5', label: 'Wyżej 5' }],
          [{ id: 'nudge:left', label: '← 1 cm' }, { id: 'nudge:fwd', label: '↑ 1 cm' }, { id: 'nudge:back', label: '↓ 1 cm' }, { id: 'nudge:right', label: '→ 1 cm' }],
          [{ id: 'resetScan', label: '↺ Jak w skanie', disabled: !f.scanned }, { id: 'verified', label: f.verified ? 'Potwierdzony ✓' : 'Oznacz potwierdzony' }],
          [{ id: 'undo', label: '↶ Cofnij', disabled: !this.history.canUndo }, { id: 'back', label: '← Wróć', style: 'primary' }],
        ],
      };
    }
    if (st === 'colors' && found) {
      const rows = [];
      for (let i = 0; i < PALETTE.length; i += 6) rows.push(PALETTE.slice(i, i + 6).map((c) => ({ id: `setColor:${c}`, label: '', color: c, selected: c.toLowerCase() === String(found.f.color).toLowerCase() })));
      rows.push([{ id: 'setColor:type', label: 'Kolor typu mebla', color: typeColor(found.f.type) }, { id: 'back', label: '← Wróć', style: 'muted' }]);
      return { title: `Kolor: ${found.f.name}`, lines: ['Wybierz kolor — zaznaczony ma białą ramkę.'], rows };
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
        lines: [
          `${cmTxt(f.w)} × ${cmTxt(f.d)} × ${cmTxt(f.h)} cm${mountOf(f) === 'wall' ? `, ${cmTxt(f.y || 0)} cm nad podłogą` : ''}. ${confTxt}`,
          mountOf(f) === 'wall'
            ? 'Przesuwanie: trzymaj spust na meblu — przykleja się tyłem do najbliższej ściany. Gałka przód/tył: wyżej/niżej.'
            : 'Przesuwanie: trzymaj spust na meblu. Gałka przód/tył: dalej/bliżej, w bok: obrót. Kulki na bryle zmieniają wymiary.',
        ],
        rows: [
          [{ id: 'type', label: `Typ: ${typeName(f.type)} ▸`, style: 'primary' }, { id: 'mount:floor', label: '▁ Na podłodze', style: mountOf(f) === 'floor' ? 'active' : undefined }, { id: 'mount:wall', label: '▕ Na ścianie', style: mountOf(f) === 'wall' ? 'active' : undefined }],
          [{ id: 'rot:90', label: '⟲ 90°' }, { id: 'rot:15', label: '⟲ 15°' }, { id: 'rot:-15', label: '⟳ 15°' }, { id: 'rot:-90', label: '⟳ 90°' }, { id: 'alignWall', label: '∥ do ściany' }],
          [dimLabel('w', `↔ Szer. ${cmTxt(f.w)}`), dimLabel('d', `↕ Głęb. ${cmTxt(f.d)}`), dimLabel('h', `⇕ Wys. ${cmTxt(f.h)}`)],
          [{ id: 'dimAdd:-10', label: '−10' }, { id: 'dimAdd:-5', label: '−5' }, { id: 'dimAdd:-1', label: '−1' }, { id: 'dimAdd:1', label: '+1' }, { id: 'dimAdd:5', label: '+5' }, { id: 'dimAdd:10', label: '+10' }],
          [...PALETTE.slice(0, 5).map((c) => ({ id: `setColor:${c}`, label: '', color: c, selected: c.toLowerCase() === String(f.color).toLowerCase() })), { id: 'colors', label: 'Więcej kolorów' }],
          [{ id: 'display:normal', label: 'Pełny', style: !f.display ? 'active' : undefined }, { id: 'display:transparent', label: 'Półprzezr.', style: f.display === 'transparent' ? 'active' : undefined }, { id: 'display:edges', label: 'Krawędzie', style: f.display === 'edges' ? 'active' : undefined }, { id: 'hide', label: 'Ukryj' }],
          [{ id: 'snap', label: '⇥ Dosuń' }, { id: 'mergeStart', label: '⧉ Scal z…' }, { id: 'dup', label: '⧉ Duplikuj' }, { id: 'photo', label: `📷 Zdjęcie${(f.photos || []).length ? ` (${f.photos.length})` : ''}` }, { id: 'more', label: 'Więcej…' }],
          [{ id: 'undo', label: '↶ Cofnij', disabled: !this.history.canUndo }, { id: 'del', label: '🗑 Usuń', style: 'danger' }, { id: 'deselect', label: '✓ Gotowe', style: 'primary' }],
        ],
      };
    }
    if (st === 'photo') return this.buildPhotoPage();
    if (st === 'start') return this.buildStartPage();
    if (this.selWall && this.tab === 'walls') return this.buildWallPage();
    return this.buildTabPage();
  }

  // ======================= menu: start i zakładki =======================
  modeName() {
    if (this.dollhouse) return '🧱 Makieta';
    if (this.walking) return '🚶 Spacer wirtualny';
    return this.isVR ? 'VR' : '🏠 W mieszkaniu (MR 1:1)';
  }

  variantRows(perRow = 3) {
    const vs = ensureVariants(this.project);
    const btns = vs.map((v) => ({ id: `varSwitch:${v.id}`, label: v.name, style: v.id === this.project.activeVariantId ? 'tabActive' : 'tab' }));
    const rows = [];
    for (let i = 0; i < btns.length; i += perRow) rows.push(btns.slice(i, i + perRow));
    return rows;
  }

  buildStartPage() {
    const modes = [
      ...(!this.isVR ? [[{ id: 'start:mr', label: '🏠 Jestem w mieszkaniu — model na prawdziwych pokojach', style: 'primary' }]] : []),
      [{ id: 'start:doll', label: '🧱 Makieta — miniatura do przestawiania mebli', style: this.isVR ? 'primary' : undefined }],
      [{ id: 'start:walk', label: '🚶 Spacer wirtualny — chodzę po modelu jak w grze' }],
    ];
    return {
      title: 'Co chcesz zrobić?',
      lines: [`Projekt: ${this.project.name}. Wybierz wersję układu mebli (każda wersja to osobne przemeblowanie), a potem tryb.`],
      rows: [
        ...this.variantRows(3),
        [{ id: 'varNew', label: '+ Nowa wersja (kopia zaznaczonej)' }],
        ...modes,
      ],
    };
  }

  chooseMode(mode) {
    this.state = 'edit';
    this.tab = 'furniture';
    if (mode === 'doll') { if (!this.dollhouse) this.enterDollhouse(); else this.refresh(); return; }
    if (mode === 'walk') {
      if (this.project.rooms.length > 1) { this.state = 'rooms'; this.updatePanel(); return; }
      this.enterWalk(this.project.rooms[0] && this.project.rooms[0].id);
      return;
    }
    // MR 1:1
    if (this.dollhouse) this.exitDollhouse(); else if (this.walking) this.exitWalk(); else this.refresh();
  }

  buildTabPage() {
    const tabs = [['mode', 'Tryb'], ['furniture', 'Meble'], ['walls', 'Ściany'], ['view', 'Widok'], ['tools', 'Narzędzia'], ['versions', 'Wersje']];
    const tab = this.tab || 'furniture';
    const tabRow = tabs.map(([k, n]) => ({ id: `tab:${k}`, label: n, style: tab === k ? 'tabActive' : 'tab' }));
    const bottom = [
      { id: 'undo', label: '↶ Cofnij', disabled: !this.history.canUndo },
      { id: 'redo', label: '↷ Ponów', disabled: !this.history.canRedo },
      { id: 'exit', label: '💾 Zapisz i wyjdź', style: 'primary' },
    ];
    const status = `${this.modeName()} · wersja: ${activeVariant(this.project).name}`;
    const on = (c) => (c ? 'active' : undefined);
    const hiddenCount = this.project.rooms.reduce((n, r) => n + r.furniture.filter((f) => f.hidden).length, 0);
    const unverCount = this.unverified().length;
    let title = '', lines = [status], rows = [];
    if (tab === 'mode') {
      title = 'Tryb';
      rows.push([
        ...(!this.isVR ? [{ id: 'modeMR', label: '🏠 W mieszkaniu', style: on(!this.dollhouse && !this.walking) }] : []),
        { id: 'modeDoll', label: '🧱 Makieta', style: on(this.dollhouse) },
        { id: 'modeWalk', label: '🚶 Spacer', style: on(this.walking) },
      ]);
      if (this.dollhouse) {
        lines.push(`Skala 1:${Math.round(1 / this.doll.scale)}. Grip (albo szczypnięcie poza meblem) chwyta makietę ręką, obie ręce: rozsuwanie powiększa. Gałka: obrót i wielkość.`);
        rows.push([{ id: 'dollRot:45', label: '⟲ 45°' }, { id: 'dollRot:-45', label: '⟳ 45°' }, { id: 'dollScale:0.8', label: '− Mniejsza' }, { id: 'dollScale:1.25', label: '+ Większa' }]);
        rows.push([{ id: 'dollHere', label: 'Ustaw przed sobą' }]);
      } else if (this.walking) {
        lines.push('Lewa gałka: chodzenie. Prawa: w bok obrót o 30°, do przodu celowanie teleportem (puść, aby się przenieść).');
        rows.push([{ id: 'rooms', label: 'Przejdź do pokoju ▸' }, { id: 'floorAdj:-5', label: 'Podłoga niżej 5 cm' }, { id: 'floorAdj:5', label: 'Podłoga wyżej 5 cm' }]);
      } else {
        lines.push(this.alignInfo || 'Model leży na prawdziwych pokojach. Jeśli jest przesunięty, użyj „Wyrównaj model”.');
        rows.push([{ id: 'align', label: '⌖ Wyrównaj model' }]);
      }
    } else if (tab === 'furniture') {
      title = 'Meble';
      lines.push('Chwyć mebel spustem (lub szczypnięciem) i prowadź promieniem. Gałka przód/tył: dalej/bliżej, w bok: obrót. Kliknij mebel, żeby zmienić typ, wymiary, kolor.');
      rows.push([{ id: 'newBox', label: '▢ + Nowa bryła' }, { id: 'add', label: '🛋 + Mebel z katalogu' }]);
      rows.push([
        { id: 'verifyAll', label: `❓ Do potwierdzenia (${unverCount})`, disabled: !unverCount },
        { id: 'hidden', label: `👁 Ukryte (${hiddenCount})`, disabled: !hiddenCount },
      ]);
    } else if (tab === 'walls') {
      title = 'Ściany';
      lines.push('Wskaż ścianę spustem i ciągnij, żeby ją przesunąć (np. gdy skaner wziął szafę za ścianę). W tej zakładce meble są zablokowane.');
    } else if (tab === 'view') {
      const l = this.lookFor();
      title = `Widok ${this.dollhouse || this.walking || this.isVR ? 'makiety' : 'w pokoju'}`;
      rows.push([{ id: 'lookWall:off', label: 'Ściany: wył.', style: on(l.wallStyle === 'off') }, { id: 'lookWall:edges', label: 'Krawędzie', style: on(l.wallStyle === 'edges') }, { id: 'lookWall:transparent', label: 'Półprzezr.', style: on(l.wallStyle === 'transparent') }, { id: 'lookWall:solid', label: 'Pełne', style: on(l.wallStyle === 'solid') }]);
      rows.push([0.1, 0.25, 0.5, 0.75].map((v) => ({ id: `lookWallOp:${v}`, label: `Ściany ${Math.round(v * 100)}%`, style: on(l.wallStyle === 'transparent' && Math.abs(l.wallOpacity - v) < 0.01) })));
      rows.push([{ id: 'lookFurn:solid', label: 'Meble: bryły', style: on(l.furnStyle === 'solid') }, { id: 'lookFurn:edges', label: 'Meble: krawędzie', style: on(l.furnStyle === 'edges') }, { id: 'lookFloor', label: l.floor ? 'Podłoga: wł.' : 'Podłoga: wył.', style: on(l.floor) }]);
      rows.push([1, 0.7, 0.4, 0.2].map((v) => ({ id: `lookFurnOp:${v}`, label: `Meble ${Math.round(v * 100)}%`, style: on(l.furnStyle === 'solid' && Math.abs(l.furnOpacity - v) < 0.01) })));
      if (!this.isVR) {
        rows.push([{ id: 'liveMesh:0', label: 'Trójkąty skanu: wył.', style: on(!this.showMesh) }, { id: 'liveMesh:0.2', label: 'słabe', style: on(this.showMesh && this.liveStyle().mesh <= 0.25) }, { id: 'liveMesh:0.45', label: 'wyraźne', style: on(this.showMesh && this.liveStyle().mesh > 0.25) }]);
        rows.push([{ id: 'liveFurn', label: `Żółte bryły skanu: ${this.liveStyle().furniture ? 'wł.' : 'wył.'}`, style: on(this.liveStyle().furniture) }, { id: 'livePlanes', label: `Płaszczyzny skanu: ${this.liveStyle().planes ? 'wł.' : 'wył.'}`, style: on(this.liveStyle().planes) }]);
      }
    } else if (tab === 'tools') {
      title = 'Narzędzia';
      rows.push([{ id: 'photo', label: `📷 Zdjęcia (${(this.project.cameras || []).length})` }, { id: 'measure', label: '📏 Miarka' }, { id: 'check', label: '✔ Kontrola skanu' }]);
      if (!this.isVR && !this.dollhouse && !this.walking) rows.push([{ id: 'align', label: '⌖ Wyrównaj model do pokoju' }]);
      rows.push([{ id: 'start:menu', label: '☰ Ekran startowy (tryb i wersja)' }]);
    } else if (tab === 'versions') {
      title = 'Wersje układu';
      lines.push('Każda wersja to osobne ustawienie mebli w tym samym mieszkaniu. Zaczynasz od „Stan obecny”, potem „+ Nowa wersja” robi kopię bieżącej do przemeblowania.');
      rows.push(...this.variantRows(3));
      rows.push([{ id: 'varNew', label: '+ Nowa wersja (kopia bieżącej)', style: 'primary' }, { id: 'varDel', label: 'Usuń bieżącą', style: 'danger', disabled: ensureVariants(this.project).length <= 1 }]);
    }
    return { title, lines, rows: [tabRow, ...rows, bottom] };
  }

  /** Kamery zdjęć do pokazania — bez tych tuż przy głowie (zasłaniałyby widok zaraz po zrobieniu zdjęcia). */
  visibleCameras() {
    const cams = this.project.cameras || [];
    if (!this.head || this.dollhouse) return cams;
    const head = new THREE.Vector3().setFromMatrixPosition(this.head);
    return cams.filter((c) => new THREE.Vector3(...c.pos).applyMatrix4(this.root.matrix).distanceTo(head) > 0.6);
  }

  // ======================= zdjęcia z gogli =======================
  photoAllowed() {
    return !this.isVR && !this.dollhouse && !this.walking;
  }

  buildPhotoPage() {
    const sel = this.selectedId && findFurniture(this.project, this.selectedId);
    const n = (this.project.cameras || []).length;
    const lines = [];
    if (!this.photoAllowed()) {
      lines.push('Zdjęcia robisz w trybie 🏠 „W mieszkaniu” (kamera widzi prawdziwy pokój). Przełącz tryb w zakładce „Tryb”.');
    } else {
      lines.push('Spójrz na to, co chcesz sfotografować, i naciśnij spust poza panelem albo „Zrób zdjęcie”. Zdjęcie zapisze się razem z miejscem i kierunkiem — na makiecie pojawi się różowa kamera, a zdjęcie trafi do paczki dla AI.');
      if (this.photo && this.photo.mode === 'video') lines.push('Kamera: zwykły obraz (kąt widzenia przybliżony — można go poprawić na PC).');
      if (this.photo && this.photo.mode === 'xr') lines.push('Kamera: WebXR (dokładna pozycja i obiektyw).');
    }
    if (this.photoMsg) lines.push(this.photoMsg);
    return {
      title: `📷 Zdjęcia (${n})`,
      lines,
      image: this.lastPhoto || null,
      rows: [
        [{ id: 'photoTake', label: '📷 Zrób zdjęcie pomieszczenia', style: 'primary', disabled: !this.photoAllowed() || !!this.pendingPhoto }],
        ...(sel ? [[{ id: 'photoFurn', label: `📷 Zdjęcie i przypnij do: ${sel.f.name}`, disabled: !this.photoAllowed() || !!this.pendingPhoto }]] : []),
        [{ id: 'photoBack', label: '← Wróć', style: 'muted' }],
      ],
    };
  }

  /** Zlecenie zdjęcia — samo zdjęcie robimy w następnej klatce XR (tylko tam XRFrame jest ważny). */
  requestPhoto(attachId) {
    if (!this.photoAllowed()) { this.photoMsg = 'Przełącz na tryb „W mieszkaniu”.'; this.updatePanel(); return; }
    this.pendingPhoto = { attachId };
    this.photoMsg = 'Robię zdjęcie…';
    this.updatePanel();
  }

  processPhoto(pose) {
    if (!this.photo) this.photo = new PhotoCapture(this.renderer, this.session);
    if (!this.photo.mode) {
      if (this.photoStarting) return;
      this.photoStarting = true;
      this.photo.start(pose).then((ok) => {
        this.photoStarting = false;
        if (!ok) {
          this.pendingPhoto = null;
          this.photoMsg = `Brak dostępu do kamery gogli (${this.photo.error || 'odmowa'}). Zezwól przeglądarce na kamerę albo dodaj zdjęcia na PC.`;
          this.photo = null;
          this.updatePanel();
        }
      });
      return;
    }
    const shot = this.photo.capture(pose);
    if (!shot) return; // obraz jeszcze niegotowy — spróbujemy w kolejnej klatce
    const req = this.pendingPhoto;
    this.pendingPhoto = null;
    this.savePhoto(shot, req.attachId);
  }

  savePhoto(shot, attachId) {
    // kamera: świat XR -> układ mieszkania
    const M = new THREE.Matrix4().fromArray(shot.matrix).premultiply(this.root.matrix.clone().invert());
    const pos = new THREE.Vector3().setFromMatrixPosition(M);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(M);
    const target = pos.clone().addScaledVector(fwd, 2);
    const found = attachId && findFurniture(this.project, attachId);
    const n = (this.project.cameras || []).length + 1;
    const name = found ? `${found.f.name} (zdjęcie)` : `Zdjęcie ${n}`;
    const mediaId = addMedia(this.project, shot.data, { w: shot.w, h: shot.h, name: `${name}.jpg` });
    const cam = createCamera({
      name, mediaId,
      pos: pos.toArray().map((v) => Math.round(v * 1000) / 1000),
      target: target.toArray().map((v) => Math.round(v * 1000) / 1000),
      fov: Math.round(fovYFromProj(shot.proj) * 10) / 10,
      aspect: shot.w / shot.h,
      notes: shot.mode === 'xr' ? 'Zdjęcie z gogli (WebXR, dokładna pozycja).' : 'Zdjęcie z gogli (kąt widzenia przybliżony).',
    });
    cam.source = shot.mode === 'xr' ? 'quest-webxr' : 'quest-video';
    if (!this.project.cameras) this.project.cameras = [];
    this.project.cameras.push(cam);
    if (found) { found.f.photos = found.f.photos || []; found.f.photos.push(mediaId); }
    this.lastPhoto = shot.data;
    this.photoMsg = `✓ Zapisano: ${name}${found ? ' — przypięte do mebla' : ''}.`;
    const c = this.controllers.find((x) => x.visible);
    if (c) this.haptic(c, 0.6, 60);
    this.commit();
  }

  // ======================= ściany w goglach =======================
  buildWallPage() {
    const r = this.project.rooms.find((x) => x.id === this.selWall.roomId);
    if (!r) { this.selWall = null; return this.buildTabPage(); }
    const e = edgeOf(r.outline, this.selWall.index);
    return {
      title: `Ściana ${this.selWall.index + 1} · ${r.name}`,
      lines: [`Długość ${cmTxt(e.length)} cm, wysokość pokoju ${cmTxt(r.height)} cm. Ciągnij ścianę spustem albo użyj przycisków.`],
      rows: [
        [{ id: 'wallMove:-5', label: '→← Do środka 5' }, { id: 'wallMove:-1', label: 'Do środka 1' }, { id: 'wallMove:1', label: 'Na zewnątrz 1' }, { id: 'wallMove:5', label: '←→ Na zewnątrz 5' }],
        [{ id: 'wallOpening:door', label: '🚪 + Drzwi tutaj' }, { id: 'wallOpening:window', label: '🪟 + Okno tutaj' }],
        [{ id: 'roomHeight:-5', label: 'Pokój niższy 5 cm' }, { id: 'roomHeight:5', label: 'Pokój wyższy 5 cm' }],
        [{ id: 'undo', label: '↶ Cofnij', disabled: !this.history.canUndo }, { id: 'wallDeselect', label: '✓ Gotowe', style: 'primary' }],
      ],
    };
  }

  moveSelectedWall(offset) {
    const r = this.selWall && this.project.rooms.find((x) => x.id === this.selWall.roomId);
    if (!r) return;
    r.outline = moveEdge(r.outline, this.selWall.index, offset);
    this.commit();
  }

  addOpeningOnWall(type) {
    const r = this.selWall && this.project.rooms.find((x) => x.id === this.selWall.roomId);
    if (!r) return;
    const e = edgeOf(r.outline, this.selWall.index);
    const op = createOpening({ type, edge: this.selWall.index });
    op.width = Math.min(op.width, Math.max(0.3, e.length - 0.1));
    op.offset = Math.max(0, (e.length - op.width) / 2);
    r.openings.push(op);
    this.commit();
  }

  startWallDrag(c, hit) {
    const { roomId, index } = hit.object.userData;
    const room = this.project.rooms.find((x) => x.id === roomId);
    if (!room) return;
    this.selWall = { roomId, index };
    const e = edgeOf(room.outline, index);
    const rot = room.transform.rot || 0;
    const ox = -e.inward[0], oz = -e.inward[1];
    const ax = ox * Math.cos(rot) + oz * Math.sin(rot), az = -ox * Math.sin(rot) + oz * Math.cos(rot);
    const dir = new THREE.Vector3(ax, 0, az).transformDirection(this.root.matrix);
    const scale = new THREE.Vector3().setFromMatrixScale(this.root.matrix).x;
    this.wallDrag = { c, roomId, index, outline0: room.outline.map((p) => [p[0], p[1]]), origin: hit.point.clone(), dir, scale, changed: false };
    this.haptic(c, 0.4, 20);
    this.refresh();
  }

  updateWallDrag() {
    const d = this.wallDrag;
    const room = this.project.rooms.find((x) => x.id === d.roomId);
    if (!room) { this.wallDrag = null; return; }
    const rc = this.rayFrom(d.c);
    const o = rc.ray.origin, dr = rc.ray.direction, u = d.dir;
    const w0 = d.origin.clone().sub(o);
    const b = u.dot(dr), dd = u.dot(w0), e = dr.dot(w0);
    const den = 1 - b * b;
    if (den < 1e-4) return;
    const off = Math.round((((b * e - dd) / den) / d.scale) * 100) / 100;
    if (Math.abs(off - (d.last || 0)) < 0.005) return;
    d.last = off;
    room.outline = moveEdge(d.outline0, d.index, off);
    d.changed = true;
    if (this.frameCount % 2 === 0) {
      this.view.setOptions({ conflicts: this.allConflicts() });
      this.view.rebuild(this.project);
    }
    if (this.frameCount % 10 === 0) this.updatePanel();
  }

  // ======================= skan =======================
  updateScan(frame, now) {
    if (this.frameCount % 20 === 0) {
      const s = { ...sceneStats(frame), tri: this.live.stats.globalTriangles };
      const changed = !this.scanStats || JSON.stringify(s) !== JSON.stringify(this.scanStats);
      this.scanStats = s;
      if (changed && s.planes) this.updateScanPreview(frame);
      if (changed || this.frameCount % 120 === 0) this.updatePanel();
    }
  }

  updateScanPreview(frame) {
    try {
      const data = captureScene(frame, this.refSpace);
      const floors = listFloors(data);
      this.scanFloors = floors.length;
      const vp = this.headPoint();
      const here = vp ? floorAtPoint(floors, vp) : null;
      this.scanHereArea = here !== null ? floors.find((f) => f.index === here).area : null;
      const { room, frame: m } = convertScene(data, { keepGlobalMesh: true, viewerPoint: vp });
      this.previewRoom = room;
      this.checkRes = checkRoom(room);
      this.checkRoomRef = room;
      this.showHoles(room, this.checkRes);
      this.setRootMatrix(new THREE.Matrix4().fromArray(m));
      this.view.setOptions({ showMesh: false, conflicts: new Map(), selectedId: null });
      this.view.rebuild({ rooms: [room] });
    } catch (e) {
      console.error(e);
      this.message = 'Błąd podglądu: ' + e.message;
    }
  }

  startRoomCapture() {
    if (this.roomCaptureUsed) {
      this.message = 'Skanowanie można uruchomić raz na sesję. Kliknij „Anuluj”, a potem znowu „Skanuj pokój”, albo użyj Ustawienia → Środowisko fizyczne → Konfiguracja przestrzeni.';
      this.updatePanel();
      return;
    }
    if (this.session.initiateRoomCapture) {
      this.roomCaptureUsed = true;
      this.message = 'Po skanowaniu systemowym nowe dane pojawią się tu automatycznie.';
      this.session.initiateRoomCapture().catch((e) => {
        this.roomCaptureUsed = false;
        this.message = 'Nie można uruchomić Space Setup z aplikacji (' + (e && e.message) + '). Uruchom ją w ustawieniach Questa: Środowisko fizyczne → Konfiguracja przestrzeni.';
        this.updatePanel();
      });
    } else {
      this.message = 'Ta przeglądarka nie pozwala uruchomić Space Setup z aplikacji. Uruchom ją w ustawieniach Questa: Środowisko fizyczne → Konfiguracja przestrzeni.';
      this.updatePanel();
    }
  }

  /** Kliknięcie przychodzi poza callbackiem klatki — XRFrame jest wtedy nieważny, więc zapis odkładamy do następnej klatki. */
  saveScan(which = 'one') {
    this.pendingSave = which;
  }

  headPoint() {
    if (!this.head) return null;
    return [this.head.elements[12], this.head.elements[14]];
  }

  /** Wszystkie pokoje ze Space Setup naraz, ułożone względem siebie. */
  doSaveAllRooms(frame) {
    this.live.setStyle(this.liveStyle());
    this.holesGroup.clear();
    const data = captureScene(frame, this.refSpace);
    const n = this.project.rooms.length + 1;
    const results = convertAllRooms(data, { startNumber: n, keepGlobalMesh: true });
    if (!results.length) { this.message = 'Nie znaleziono pokoi (brak podłóg w Space Setup).'; this.updatePanel(); return; }
    // pokój już zapisany wcześniej (to samo pole) — nie dublujemy, tylko układamy resztę względem niego
    let match = null;
    for (const r of results) {
      const e = this.project.rooms.find((x) => x.scan && x.scan.floorArea && Math.abs(x.scan.floorArea - r.room.scan.floorArea) / x.scan.floorArea < 0.03);
      if (e) { match = { e, r }; break; }
    }
    let M = { x: 0, z: 0, rot: 0 };
    if (match) {
      M = compose2D(match.e.transform, invert2D(match.r.room.transform));
    } else if (this.project.rooms.length) {
      let maxX = -Infinity, minZ = Infinity;
      for (const r of this.project.rooms) for (const p of r.outline) { const w = roomToWorld(r, p); maxX = Math.max(maxX, w[0]); minZ = Math.min(minZ, w[1]); }
      let gMinX = Infinity, gMinZ = Infinity;
      for (const { room } of results) for (const p of room.outline) { const w = roomToWorld(room, p); gMinX = Math.min(gMinX, w[0]); gMinZ = Math.min(gMinZ, w[1]); }
      M = { x: maxX + 0.5 - gMinX, z: minZ - gMinZ, rot: 0 };
    }
    const vp = this.headPoint();
    const hereIdx = vp ? floorAtPoint(listFloors(data), vp) : null;
    let anchor = null, added = 0;
    results.forEach(({ room, frame: fm }, i) => {
      const isMatch = match && match.r.room === room;
      if (isMatch) {
        if (!anchor) anchor = { room: match.e, frame: fm };
        return;
      }
      room.transform = compose2D(M, room.transform);
      room.name = `Pokój ${n + added}`;
      this.project.rooms.push(room);
      added++;
      const fl = listFloors(data).filter((f) => f.area > 0.8)[i];
      if (fl && fl.index === hereIdx) anchor = { room, frame: fm };
    });
    if (!anchor) {
      const last = results.find((r) => !(match && match.r === r)) || results[0];
      anchor = { room: this.project.rooms.find((r) => r === last.room) || match.e, frame: last.frame };
    }
    this.anchorRoomId = anchor.room.id;
    this.anchorFrame = anchor.frame;
    this.aligned = true;
    this.commit();
    this.applyAlignment();
    this.message = '';
    this.alignInfo = `Zapisano pokoje: ${added}${match ? ` (ułożone względem „${match.e.name}”)` : ''}. Ściany każdego pokoju są osobno, położenie jak w rzeczywistości.`;
    const first = this.unverified()[0];
    if (first) { this.state = 'verify'; this.selectedId = first.id; } else this.state = 'edit';
    this.refresh();
  }

  doSaveScan(frame) {
    this.live.setStyle(this.liveStyle());
    this.holesGroup.clear();
    const data = captureScene(frame, this.refSpace);
    const n = this.project.rooms.length + 1;
    const { room, stats, frame: m } = convertScene(data, { name: `Pokój ${n}`, keepGlobalMesh: true, viewerPoint: this.headPoint() });
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
    if (this.walking) { if (this.walkRoot) this.setRootMatrix(this.walkRoot); return; }
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
    this.walking = false;
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
    this.walking = true;
    this.dollDrag = null;
    if (this.dollGrabs) this.dollGrabs.clear();
    this.view.mode = 'editor';
    this.view.setOptions({ wallMode: 'full', showZones: true, showGhosts: false, showLabels: false, mode: 'furniture' });
    const c = roomToWorld(room, polygonCentroid(room.outline));
    const head = this.head ? new THREE.Vector3().setFromMatrixPosition(this.head) : new THREE.Vector3();
    // poziom podłogi: z płaszczyzny podłogi Space Setup (MR) albo z przestrzeni local-floor; plus ręczna korekta
    const fy = (this.floorLevel ?? (this.refType === 'local-floor' ? 0 : head.y - 1.6)) + this.floorOffset();
    this.walkRoot = new THREE.Matrix4().makeTranslation(head.x - c[0], fy, head.z - c[1]);
    this.applyAlignment();
    this.placePanel(true);
    this.refresh();
  }

  floorOffset() {
    return (this.project.view && this.project.view.floorOffset) || 0;
  }

  /** Ręczna korekta wysokości podłogi w spacerze (gdy gogle źle ocenią poziom). */
  adjustFloor(d) {
    const v = this.project.view || (this.project.view = {});
    v.floorOffset = Math.round(((v.floorOffset || 0) + d) * 100) / 100;
    if (this.walkRoot) this.walkRoot.elements[13] += d;
    this.applyAlignment();
    this.saveLook();
  }

  /** AR: powrót ze spaceru wirtualnego do modelu nałożonego na prawdziwy pokój. */
  exitWalk() {
    if (this.isVR) return;
    this.walking = false;
    this.view.mode = 'mr';
    this.teleportAim = null;
    this.aligned = false; // ponowne dopasowanie do podłogi ze Space Setup
    this.applyAlignment();
    this.placePanel(true);
    this.refresh();
  }

  /** Chodzenie gałką (lewa), obrót skokowy i teleport (prawa) — jak w grach VR. */
  updateLocomotion(dt) {
    if (!this.walking || this.dollhouse || !this.walkRoot || !this.head) { if (this.teleMarker) this.teleMarker.visible = false; return; }
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
      } else if (src.handedness === 'right' && sy < -0.6) {
        // celowanie teleportem
        this.teleportAim = this.rayFloor(c);
      } else if (src.handedness === 'right' && this.teleportAim && Math.abs(sy) < 0.25) {
        const d = this.teleportAim.clone().sub(headPos);
        if (Math.hypot(d.x, d.z) < 15) this.walkRoot.premultiply(new THREE.Matrix4().makeTranslation(-d.x, 0, -d.z));
        this.teleportAim = null;
        changed = true;
      } else if (src.handedness === 'right' && Math.abs(sx) > 0.6 && Math.abs(sy) < 0.5 && this.turnCooldown === 0) {
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
    if (!this.teleMarker) {
      this.teleMarker = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.25, 32), new THREE.MeshBasicMaterial({ color: 0x40e0ff, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthTest: false }));
      this.teleMarker.rotation.x = -Math.PI / 2;
      this.teleMarker.renderOrder = 40;
      this.scene.add(this.teleMarker);
    }
    this.teleMarker.visible = !!this.teleportAim;
    if (this.teleportAim) this.teleMarker.position.copy(this.teleportAim).setY(this.teleportAim.y + 0.01);
  }

  exitDollhouse() {
    if (this.isVR) { this.enterWalk(this.anchorRoomId); return; }
    this.dollhouse = false;
    this.walking = false;
    this.dollDrag = null;
    if (this.dollGrabs) this.dollGrabs.clear();
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

  // ======================= wskaźnik pytanego mebla =======================
  buildGuide() {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false, transparent: true, opacity: 0.95 });
    const arrow = new THREE.Group();
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.12, 20), mat);
    head.rotation.x = Math.PI; // grot w dół
    head.position.y = 0.06;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 12), mat);
    shaft.position.y = 0.2;
    arrow.add(head, shaft);
    arrow.traverse((o) => { o.renderOrder = 50; });
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]);
    const line = new THREE.Line(lineGeo, new THREE.LineDashedMaterial({ color: 0xffd400, dashSize: 0.04, gapSize: 0.03, depthTest: false, transparent: true, opacity: 0.8 }));
    line.renderOrder = 50;
    const offGeo = new THREE.ConeGeometry(0.035, 0.11, 16);
    offGeo.rotateX(Math.PI / 2); // grot wzdłuż +Z (lookAt)
    const off = new THREE.Mesh(offGeo, mat);
    off.renderOrder = 51;
    this.guide = { arrow, line, off, group: new THREE.Group() };
    this.guide.group.add(arrow, line, off);
    this.guide.group.visible = false;
    this.scene.add(this.guide.group);
  }

  /** Strzałka nad meblem, o który pyta „Co to jest?”, linia od panelu i strzałka kierunku, gdy mebel jest poza wzrokiem. */
  updateGuide(t) {
    const g = this.guide;
    const id = this.selectedId && (this.state === 'verify' || this.state === 'merge' || this.guideId === this.selectedId) ? this.selectedId : null;
    const obj = id && this.view.furnitureObjects.get(id);
    if (!obj || !this.head) {
      if (g.group.visible) { g.group.visible = false; this.view.applyHighlights(); }
      return;
    }
    g.group.visible = true;
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const top = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
    const k = this.dollhouse ? 0.5 : 1;
    g.arrow.scale.setScalar(k);
    g.arrow.position.copy(top).add(new THREE.Vector3(0, (0.03 + 0.04 * (1 + Math.sin(t * 5))) * k, 0));
    // linia od dolnej krawędzi panelu do strzałki
    const p0 = new THREE.Vector3(0, -0.5, 0).applyMatrix4(this.panel.mesh.matrixWorld);
    const pos = g.line.geometry.attributes.position;
    pos.setXYZ(0, p0.x, p0.y, p0.z);
    pos.setXYZ(1, g.arrow.position.x, g.arrow.position.y + 0.3 * k, g.arrow.position.z);
    pos.needsUpdate = true;
    g.line.geometry.computeBoundingSphere();
    g.line.computeLineDistances();
    g.line.visible = this.panel.mesh.visible;
    // strzałka kierunku, gdy mebel jest poza polem widzenia
    const headPos = new THREE.Vector3().setFromMatrixPosition(this.head);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.head);
    const toT = top.clone().sub(headPos);
    const outOfView = toT.angleTo(fwd) > rad(32);
    g.off.visible = outOfView;
    if (outOfView) {
      g.off.position.copy(headPos).addScaledVector(fwd, 0.45).add(new THREE.Vector3(0, -0.08, 0));
      g.off.lookAt(top);
      g.off.scale.setScalar(1 + 0.15 * Math.sin(t * 6));
    }
    // pulsujące podświetlenie bryły
    const mat = obj.userData.mat;
    if (mat) { mat.emissive.setHex(0xffd400); mat.emissiveIntensity = 0.25 + 0.25 * (1 + Math.sin(t * 5)) / 2; }
  }

  // ======================= kontrola skanu =======================
  showHoles(room, res, inApartment = false) {
    this.holesGroup.clear();
    if (!res || !res.holes.length) return;
    const geo = new THREE.PlaneGeometry(res.cell * 0.9, res.cell * 0.9);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }), res.holes.length);
    const m = new THREE.Matrix4();
    res.holes.forEach((h, i) => {
      const p = inApartment ? roomToWorld(room, h) : h;
      m.makeTranslation(p[0], 0.015, p[1]);
      mesh.setMatrixAt(i, m);
    });
    mesh.renderOrder = 5;
    this.holesGroup.add(mesh);
  }

  openCheck() {
    this.checkReturn = this.state === 'check' ? this.checkReturn : this.state;
    if (this.state !== 'scan') {
      const room = this.anchorRoom() || this.project.rooms[0];
      if (room) {
        this.checkRoomRef = room;
        this.checkRes = checkRoom(room);
        this.showHoles(room, this.checkRes, true);
      }
    }
    this.state = 'check';
    this.updatePanel();
  }

  gotoIssue(i) {
    const it = this.checkRes && this.checkRes.issues[i];
    if (!it) return;
    if (it.fid && findFurniture(this.project, it.fid)) {
      this.selectedId = it.fid;
      this.guideId = it.fid; // strzałka wskaże mebel
      this.state = 'edit';
      this.refresh();
    } else if (it.edge !== undefined) {
      this.message = 'Ściany i otwory poprawisz najdokładniej na PC (tryb „Ściany”).';
      this.updatePanel();
    }
  }

  // ======================= wygląd =======================
  lookFor() {
    const v = this.project.view || (this.project.view = {});
    if (!v.mr) v.mr = { wallStyle: 'transparent', wallOpacity: 0.25, furnStyle: 'solid', furnOpacity: 1, floor: false };
    if (!v.model) v.model = { wallStyle: 'solid', wallOpacity: 0.5, furnStyle: 'solid', furnOpacity: 1, floor: true };
    return this.dollhouse || this.walking || this.isVR ? v.model : v.mr;
  }

  liveStyle() {
    const v = this.project.view || (this.project.view = {});
    if (!v.live) v.live = { mesh: 0.45, furniture: true, planes: true };
    return v.live;
  }

  saveLook() {
    this.dirty = true;
    if (this.onSave) this.onSave(this.project);
    this.refresh();
  }

  // ======================= miarka =======================
  /** Punkt trafiony promieniem: meble, ściany, podłoga makiety, siatka skanu na żywo, a w ostateczności podłoga. */
  measureHit(c) {
    const rc = this.rayFrom(c);
    const objs = [...this.view.getPickables()];
    if (this.live.visible) objs.push(...this.live.group.children);
    const hits = rc.intersectObjects(objs, true).filter((h) => h.object.visible !== false);
    if (hits.length) return hits[0].point.clone();
    return this.rayFloor(c);
  }

  measureText(a, b) {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const dxz = Math.hypot(a[0] - b[0], a[2] - b[2]);
    return Math.abs(a[1] - b[1]) > 0.02 ? `${cmTxt(d)} cm (poziomo ${cmTxt(dxz)} cm)` : `${cmTxt(d)} cm`;
  }

  // ======================= uchwyty zmiany wymiarów =======================
  /** Oś mebla w świecie + skala makiety. */
  furnitureAxisWorld(room, f, key) {
    const rot = (f.rot || 0) + (room.transform.rot || 0);
    const dirApt = key === 'h' ? new THREE.Vector3(0, 1, 0) : key === 'w' ? new THREE.Vector3(Math.cos(rot), 0, -Math.sin(rot)) : new THREE.Vector3(Math.sin(rot), 0, Math.cos(rot));
    const scale = new THREE.Vector3().setFromMatrixScale(this.root.matrix).x;
    const dir = dirApt.clone().transformDirection(this.root.matrix);
    return { dir, scale };
  }

  startResize(c, handle) {
    const found = findFurniture(this.project, handle.fid);
    if (!found) return;
    const { room, f } = found;
    const { dir, scale } = this.furnitureAxisWorld(room, f, handle.key);
    const cw = roomToWorld(room, [f.x, f.z]);
    const baseY = handle.key === 'h' ? (f.y || 0) : (f.y || 0) + f.h / 2;
    const origin = new THREE.Vector3(cw[0], baseY, cw[1]).applyMatrix4(this.root.matrix);
    this.resize = { c, key: handle.key, fid: f.id, origin, dir, scale, half0: handle.key === 'h' ? 0 : f[handle.key] / 2, x0: f.x, z0: f.z, size0: f[handle.key] };
    this.haptic(c, 0.4, 20);
  }

  updateResize() {
    const r = this.resize;
    const found = findFurniture(this.project, r.fid);
    if (!found) { this.resize = null; return; }
    const { f } = found;
    const rc = this.rayFrom(r.c);
    const o = rc.ray.origin, d = rc.ray.direction, u = r.dir;
    const w0 = r.origin.clone().sub(o);
    const b = u.dot(d), dd = u.dot(w0), e = d.dot(w0);
    const den = 1 - b * b;
    if (den < 1e-4) return;
    const t = ((b * e - dd) / den) / r.scale; // w metrach rzeczywistych (także w makiecie)
    const size = Math.max(0.05, Math.round((t + r.half0) * 100) / 100);
    if (Math.abs(size - f[r.key]) < 0.005) return;
    resizeFurniture(f, r.key, size);
    if (r.key !== 'h') {
      // przeciwległa ściana bryły zostaje w miejscu
      const shift = size / 2 - r.half0;
      const ax = r.key === 'w' ? [Math.cos(f.rot || 0), -Math.sin(f.rot || 0)] : [Math.sin(f.rot || 0), Math.cos(f.rot || 0)];
      f.x = r.x0 + ax[0] * shift;
      f.z = r.z0 + ax[1] * shift;
    }
    r.changed = true;
    if (this.frameCount % 2 === 0) {
      this.view.setOptions({ conflicts: this.allConflicts() });
      this.view.rebuild(this.project);
      this.updateSelectionLabel();
    }
    if (this.frameCount % 10 === 0) this.updatePanel();
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
    if (this.state === 'photo') {
      this.requestPhoto(this.photoReturn === 'furniture' ? this.selectedId : null);
      return;
    }
    if (this.state === 'measure') {
      const p = this.measureHit(c);
      if (p) {
        const q = p.applyMatrix4(this.root.matrix.clone().invert());
        if (!this.measures) this.measures = [];
        if (this.measures.length >= 20) this.measures = [];
        this.measures.push([q.x, q.y, q.z]);
        this.haptic(c, 0.3, 15);
        this.updateSelectionLabel();
        this.updatePanel();
      }
      return;
    }
    if (this.state === 'edit' && this.tab === 'walls') {
      const wh = this.rayFrom(c).intersectObjects(this.view.getPickables(['wall']), false)[0];
      if (wh) this.startWallDrag(c, wh);
      return; // w zakładce „Ściany” meble są zablokowane
    }
    if (this.handleMeshes && this.handleMeshes.length) {
      const hh = this.rayFrom(c).intersectObjects(this.handleMeshes, false)[0];
      if (hh) { this.startResize(c, hh.object.userData.handle); return; }
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
      this.startDollGrab(c);
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
      // chwyt „na kiju”: mebel trzyma się końca promienia; gałka przód/tył = dalej/bliżej
      const cp = this.ctrlPos(c);
      const hit = fh.point.clone();
      const cw = roomToWorld(found.room, [found.f.x, found.f.z]);
      const centerW = new THREE.Vector3(cw[0], 0, cw[1]).applyMatrix4(this.root.matrix);
      {
        this.grab = {
          c, id, moved: false,
          dist: Math.max(0.15, Math.hypot(hit.x - cp.x, hit.z - cp.z)),
          off: new THREE.Vector2(centerW.x - hit.x, centerW.z - hit.z),
        };
      }
      this.haptic(c);
      this.refresh();
    }
  }

  onSelectEnd(c) {
    this.endDollGrab(c);
    if (this.wallDrag && this.wallDrag.c === c) {
      const changed = this.wallDrag.changed;
      this.wallDrag = null;
      if (changed) this.commit(); else this.refresh();
    }
    if (this.resize && this.resize.c === c) {
      const changed = this.resize.changed;
      this.resize = null;
      if (changed) this.commit(); else this.refresh();
    }
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

  // ---- chwytanie makiety: jedna ręka przenosi i obraca, dwie ręce dodatkowo skalują (rozsuwanie dłoni) ----
  ctrlPos(c) { return new THREE.Vector3().setFromMatrixPosition(c.matrixWorld); }

  ctrlYaw(c) {
    const f = new THREE.Vector3(0, 0, -1).transformDirection(c.matrixWorld);
    return Math.atan2(-f.x, -f.z);
  }

  startDollGrab(c) {
    if (!this.dollhouse) return;
    if (!this.dollGrabs) this.dollGrabs = new Map();
    this.dollGrabs.set(c, true);
    this.resetDollGrabBase();
    this.haptic(c, 0.3, 20);
  }

  endDollGrab(c) {
    if (!this.dollGrabs || !this.dollGrabs.has(c)) return;
    this.dollGrabs.delete(c);
    if (this.dollGrabs.size) this.resetDollGrabBase();
    else this.updatePanel();
  }

  resetDollGrabBase() {
    const cs = [...this.dollGrabs.keys()];
    const base = { pos: this.doll.pos.clone(), yaw: this.doll.yaw, scale: this.doll.scale };
    if (cs.length === 1) {
      base.p = this.ctrlPos(cs[0]);
      base.cyaw = this.ctrlYaw(cs[0]);
    } else {
      const a = this.ctrlPos(cs[0]), b = this.ctrlPos(cs[1]);
      base.mid = a.clone().add(b).multiplyScalar(0.5);
      base.dist = Math.max(0.02, a.distanceTo(b));
      base.ang = Math.atan2(-(b.z - a.z), b.x - a.x);
    }
    this.dollBase = base;
  }

  updateDollGrab() {
    const cs = [...this.dollGrabs.keys()];
    const B = this.dollBase;
    const Y = new THREE.Vector3(0, 1, 0);
    if (cs.length === 1) {
      const p = this.ctrlPos(cs[0]);
      const dyaw = this.ctrlYaw(cs[0]) - B.cyaw;
      this.doll.yaw = B.yaw + dyaw;
      this.doll.pos = p.clone().add(B.pos.clone().sub(B.p).applyAxisAngle(Y, dyaw));
    } else {
      const a = this.ctrlPos(cs[0]), b = this.ctrlPos(cs[1]);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const k = Math.max(0.02, a.distanceTo(b)) / B.dist;
      const dyaw = Math.atan2(-(b.z - a.z), b.x - a.x) - B.ang;
      this.doll.scale = Math.min(0.6, Math.max(0.01, B.scale * k));
      const kk = this.doll.scale / B.scale;
      this.doll.yaw = B.yaw + dyaw;
      this.doll.pos = mid.clone().add(B.pos.clone().sub(B.mid).applyAxisAngle(Y, dyaw).multiplyScalar(kk));
    }
    this.applyDollMatrix();
    if (this.frameCount % 15 === 0) this.updatePanel();
  }

  updateDollhouse(dt) {
    if (this.dollGrabs && this.dollGrabs.size) { this.updateDollGrab(); return; }
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
    if (this.resize) { this.updateResize(); return; }
    if (this.wallDrag) { this.updateWallDrag(); return; }
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
    const g = this.grab;
    const wallMount = mountOf(f) === 'wall';
    const sx = this.stickX(c), sy = this.stickY(c);
    // gałka przód/tył: mebel na podłodze — dalej/bliżej; mebel wiszący — wyżej/niżej
    if (sy) {
      if (wallMount) {
        f.y = Math.max(0, Math.min(room.height - f.h, (f.y || 0) - sy * dt * 0.5));
        g.moved = true;
      } else {
        g.dist = Math.min(15, Math.max(0.15, g.dist - sy * dt * 1.8));
      }
    }
    const cp = this.ctrlPos(c);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(c.matrixWorld);
    dir.y = 0;
    if (dir.lengthSq() > 1e-4) {
      dir.normalize();
      const wx = cp.x + dir.x * g.dist + g.off.x, wz = cp.z + dir.z * g.dist + g.off.y;
      const local = worldToRoom(room, this.worldToApartment(new THREE.Vector3(wx, 0, wz)));
      if (Math.hypot(local[0] - f.x, local[1] - f.z) > 0.002 || g.moved) {
        f.x = local[0];
        f.z = local[1];
        if (wallMount) {
          const a = attachToWall(room, f, 0.6);
          if (a) { f.x = a.x; f.z = a.z; f.rot = a.rot; g.onWall = true; } else g.onWall = false;
        } else {
          const s2 = snapToWalls(room, f, 0.05);
          if (s2) { f.x = s2.x; f.z = s2.z; }
        }
        g.moved = true;
      }
    }
    // gałka w bok: obrót (mebel przyklejony do ściany obraca się razem ze ścianą)
    if (sx && !(wallMount && g.onWall)) {
      f.rot = normalizeAngle((f.rot || 0) - sx * dt * 1.6);
      g.moved = true;
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
    this.shapeMsg = '';
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
    let look = this.lookFor();
    if (this.tab === 'walls' && this.state === 'edit' && look.wallStyle === 'off') look = { ...look, wallStyle: 'edges' }; // ściany muszą dać się wskazać
    this.view.setOptions({
      showMesh: false, conflicts: this.allConflicts(), selectedId: this.selectedId, look, cameras: this.visibleCameras(), cameraSize: this.dollhouse ? 0.45 : 0.15,
      selection: this.selWall ? { kind: 'edge', roomId: this.selWall.roomId, index: this.selWall.index } : null,
    });
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
    // uchwyty zmiany wymiarów (szerokość / głębokość / wysokość)
    this.handleMeshes = [];
    if (s && !s.f.hidden && !this.grab && this.state === 'edit') {
      const f = s.f;
      const hs = this.dollhouse ? 0.022 / this.doll.scale : 0.045;
      const defs = [['w', f.w / 2, (f.y || 0) + f.h / 2, 0, 0xff4040], ['d', 0, (f.y || 0) + f.h / 2, f.d / 2, 0x4080ff], ['h', 0, (f.y || 0) + f.h + hs, 0, 0x30d050]];
      for (const [key, lx, y, lz, color] of defs) {
        const w = roomToWorld(s.room, localToWorld(f, lx, lz));
        const m = new THREE.Mesh(new THREE.SphereGeometry(hs, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
        m.renderOrder = 35;
        m.position.set(w[0], y, w[1]);
        m.userData = { handle: { key, fid: f.id }, isClearance: true };
        this.labels.add(m);
        this.handleMeshes.push(m);
      }
    }
    // pomiary miarką (punkty w układzie mieszkania — w makiecie wymiary są rzeczywiste)
    const ms = this.measures || [];
    if (ms.length) {
      const pr = this.dollhouse ? 0.01 / this.doll.scale : 0.015;
      ms.forEach((p, i) => {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(pr, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false }));
        dot.renderOrder = 36;
        dot.position.set(p[0], p[1], p[2]);
        dot.userData.isClearance = true;
        this.labels.add(dot);
        if (i % 2 === 1) {
          const a = ms[i - 1];
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...p)]), new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false }));
          line.renderOrder = 36;
          line.userData.isClearance = true;
          this.labels.add(line);
          const t = makeTextSprite(this.measureText(a, p), { color: '#ffd400', bg: 'rgba(0,0,0,0.85)', height: 0.05 });
          t.scale.multiplyScalar(k);
          t.position.set((a[0] + p[0]) / 2, (a[1] + p[1]) / 2 + 0.04 * k, (a[2] + p[2]) / 2);
          this.labels.add(t);
        }
      });
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
