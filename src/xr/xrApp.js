// Sesja WebXR (immersive-ar) na Meta Quest: skan pokoju ze Space Setup, potwierdzanie mebli
// i edycja makiety w mieszanej rzeczywistości (skala 1:1, na tle passthrough).
import * as THREE from 'three';
import { Panel3D, makeTextSprite } from './ui3d.js';
import { captureScene, sceneStats, floorPlanes } from './sceneCapture.js';
import { convertScene, roomFrameFromFloor } from '../scanConvert.js';
import { ApartmentView } from '../roomView.js';
import {
  computeConflicts, snapToWalls, normalizeAngle, rad, polygonCentroid, alignRotationToNearestWall, worldToRoom, roomToWorld,
  polygonArea, roomContainsWorldPoint,
} from '../geometry.js';
import { History, createFurniture, findFurniture, uid } from '../model.js';
import { FURNITURE_TYPES, TYPE_KEYS, TEMPLATES, typeName, typeColor } from '../labels.js';

const SESSION_INIT = {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['plane-detection', 'mesh-detection', 'hand-tracking', 'anchors', 'hit-test'],
};

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
    this.state = o.mode === 'scan' ? 'scan' : 'edit';
    this.selectedId = null;
    this.activeDim = 'w';
    this.grab = null;
    this.alignDrag = null;
    this.showMesh = false;
    this.message = '';
    this.frameCount = 0;
    this.scanStartTime = performance.now();
    this.controllers = [];
    this.dirty = false;
  }

  // ======================= start / koniec =======================
  /** Musi być wywołane bezpośrednio w obsłudze kliknięcia (gest użytkownika). */
  start() {
    const sessionPromise = navigator.xr.requestSession('immersive-ar', SESSION_INIT);
    return sessionPromise.then((session) => this.onSessionStarted(session));
  }

  async onSessionStarted(session) {
    this.session = session;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
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
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.02, 50);

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
    const pose = frame.getViewerPose(this.refSpace);
    if (pose) this.head = new THREE.Matrix4().fromArray(pose.transform.matrix);
    if (!this.panelPlaced && this.head) this.placePanel(false);
    else if (this.head && this.frameCount % 30 === 0) this.keepPanelInView();

    if (this.state === 'scan' && this.pendingSave) {
      this.pendingSave = false;
      this.doSaveScan(frame);
    }
    if (this.state === 'scan') this.updateScan(frame, now);
    if (!this.aligned && this.state !== 'scan') this.tryAlign(frame);

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
      add: () => { this.state = 'add'; this.updatePanel(); },
      addTpl: () => this.addTemplate(TEMPLATES[+arg]),
      align: () => { this.state = 'align'; this.selectedId = null; this.refresh(); },
      alignMove: () => this.alignMove(arg),
      alignRot: () => this.alignRotate(rad(parseFloat(arg))),
      alignReset: () => { const r = this.anchorRoom(); if (r) { r.xrAlign = { x: 0, z: 0, rot: 0 }; this.aligned = false; this.commit(); } },
      back: () => { this.state = 'edit'; this.refresh(); },
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
      lines.push(`Wykryto: podłoga ${s.floors ? 'tak' : 'NIE'}, ściany: ${s.walls}, meble/obiekty: ${s.furniture}.`);
      if (!s.planes && performance.now() - this.scanStartTime > 2500) lines.push('Brak danych pokoju. Uruchom konfigurację przestrzeni (Space Setup) i obejdź pokój, zaznaczając meble.');
      else lines.push('Niebieskie linie to obrys, bryły to meble. Jeśli czegoś brakuje, popraw w Space Setup.');
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
          [{ id: 'type', label: 'Zmień typ' }, { id: 'dup', label: 'Duplikuj' }, { id: 'hide', label: 'Ukryj' }, { id: 'del', label: 'Usuń', style: 'danger' }],
          [{ id: 'undo', label: '↶ Cofnij', disabled: !this.history.canUndo }, { id: 'deselect', label: 'Gotowe', style: 'primary' }],
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
        [{ id: 'mesh', label: this.showMesh ? 'Siatka skanu: wł.' : 'Siatka skanu: wył.', style: this.showMesh ? 'active' : undefined }],
        [{ id: 'exit', label: 'Zapisz i wyjdź', style: 'primary' }],
      ],
    };
  }

  // ======================= skan =======================
  updateScan(frame, now) {
    if (this.frameCount % 20 === 0) {
      const s = sceneStats(frame);
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
      const m = matrixFrom2D({ x: pos.x, z: pos.z, rot: yaw });
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
    const r = this.anchorRoom();
    if (!r || !this.anchorFrame) return;
    const a = r.xrAlign || { x: 0, z: 0, rot: 0 };
    const F = new THREE.Matrix4().fromArray(this.anchorFrame);
    const A = matrixFrom2D(a);
    const Tinv = matrixFrom2D(r.transform).invert();
    this.setRootMatrix(F.multiply(A).multiply(Tinv));
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

  updateGrab(dt) {
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
    s.f[k] = Math.max(0.02, s.f[k] + delta);
    if (s.f.shape === 'cylinder' && k === 'w') s.f.d = s.f.w;
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
    const local = worldToRoom(room, this.worldToApartment(p));
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
    this.view.setOptions({ showMesh: this.showMesh, conflicts: this.allConflicts(), selectedId: this.selectedId });
    this.view.rebuild(this.project);
    this.updateSelectionLabel();
    this.updatePanel();
  }

  updateSelectionLabel() {
    for (const ch of [...this.labels.children]) {
      ch.material.map.dispose();
      ch.material.dispose();
      this.labels.remove(ch);
    }
    const addLabel = (f, room, text, color, bg) => {
      const s = makeTextSprite(text, { color, bg });
      const w = roomToWorld(room, [f.x, f.z]);
      s.position.set(w[0], (f.y || 0) + f.h + 0.1, w[1]);
      this.labels.add(s);
    };
    const s = this.sel();
    if (s) addLabel(s.f, s.room, `${s.f.name}  ${cmTxt(s.f.w)}×${cmTxt(s.f.d)}×${cmTxt(s.f.h)}`, '#111111', 'rgba(255,212,0,0.95)');
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
