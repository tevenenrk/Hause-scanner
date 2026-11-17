// Edytor makiety (PC / przeglądarka Questa w trybie 2D).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { GLTFExporter } from 'three/addons/GLTFExporter.js';
import { ApartmentView } from './roomView.js';
import {
  computeConflicts, computeClearances, snapToWalls, alignRotationToNearestWall, edgeOf, moveEdge, setEdgeLength,
  splitEdge, removeVertex, projectT, worldToRoom, roomToWorld, roomContainsWorldPoint, polygonCentroid, polygonArea,
  normalizeAngle, rad, deg, localToWorld, worldToLocal,
} from './geometry.js';
import {
  History, createFurniture, createOpening, createRoom, findFurniture, snapshotScanned, projectToJSON, projectFromJSON, uid,
  mergeFurniture,
} from './model.js';
import { FURNITURE_TYPES, TYPE_KEYS, TEMPLATES, typeName, typeColor } from './labels.js';
import { saveProject } from './store.js';

const cm = (m) => Math.round(m * 1000) / 10; // metry -> cm z dokładnością 1 mm
const fmtCm = (m) => `${Math.round(m * 100)} cm`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function safeName(s) {
  return String(s || 'projekt').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'projekt';
}

export class Editor {
  constructor({ onStartXR, toast, onProjectReplaced }) {
    this.onStartXR = onStartXR;
    this.toast = toast;
    this.onProjectReplaced = onProjectReplaced;
    this.project = null;
    this.mode = 'furniture';
    this.view = '3d';
    this.selection = null;
    this.extra = new Set(); // dodatkowo zaznaczone meble (Shift/Ctrl+klik)
    this.opts = { showMesh: false, showGhosts: true, showLabels: true, showZones: true, snap: true, wallMode: 'low' };
    this.conflicts = new Map();
    this.measure = [];
    this.drag = null;
    this.saveTimer = null;
    this.xrSupported = false;

    this.el = {
      root: document.getElementById('editor'),
      viewport: document.getElementById('viewport'),
      hint: document.getElementById('viewport-hint'),
      props: document.getElementById('props'),
      roomList: document.getElementById('room-list'),
      issues: document.getElementById('issues'),
      verify: document.getElementById('verify-card'),
      saveStatus: document.getElementById('save-status'),
      projectName: document.getElementById('project-name'),
    };
    this.initThree();
    this.initUI();
  }

  // ======================= Three.js =======================
  initThree() {
    const vp = this.el.viewport;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    vp.appendChild(this.renderer.domElement);
    this.labelRenderer = new CSS2DRenderer();
    Object.assign(this.labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    vp.appendChild(this.labelRenderer.domElement);

    this.scene = new THREE.Scene();
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    this.scene.background = new THREE.Color(dark ? 0x2a3037 : 0xdfe4ea);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(6, 12, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 0.5, far: 40 });
    this.sun = sun;
    this.scene.add(sun, sun.target);
    const grid = new THREE.GridHelper(60, 60, dark ? 0x4a525c : 0xb8c0ca, dark ? 0x353c44 : 0xcdd3da);
    grid.position.y = -0.002;
    this.scene.add(grid);

    this.view3d = new ApartmentView({ mode: 'editor' });
    this.scene.add(this.view3d.group);
    this.overlay = new THREE.Group();
    this.scene.add(this.overlay);

    this.persp = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
    this.persp.position.set(6, 8, 10);
    this.ortho = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 200);
    this.ortho.position.set(0, 50, 0);
    this.ortho.up.set(0, 0, -1);
    this.ortho.lookAt(0, 0, 0);

    this.controls3d = new OrbitControls(this.persp, this.renderer.domElement);
    this.controls3d.enableDamping = true;
    this.controls3d.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controlsTop = new OrbitControls(this.ortho, this.renderer.domElement);
    this.controlsTop.enableRotate = false;
    this.controlsTop.screenSpacePanning = true;
    this.controlsTop.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controlsTop.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controlsTop.enabled = false;

    this.raycaster = new THREE.Raycaster();
    this.floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(vp);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e), { capture: true });
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.running = false;
    const loop = () => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      this.activeControls.update();
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
    };
    this.loop = loop;
  }

  get camera() { return this.view === 'top' ? this.ortho : this.persp; }
  /** Opcje widoku z uwzględnieniem trybu „Makieta”. */
  get viewOpts() {
    return this.view === 'model' ? { ...this.opts, wallMode: 'full', showLabels: false, showGhosts: false, showZones: false } : this.opts;
  }
  get activeControls() { return this.view === 'top' ? this.controlsTop : this.controls3d; }

  resize() {
    const vp = this.el.viewport;
    const w = Math.max(1, vp.clientWidth), h = Math.max(1, vp.clientHeight);
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const half = this.orthoHalf || 5;
    this.ortho.left = -half * (w / h);
    this.ortho.right = half * (w / h);
    this.ortho.top = half;
    this.ortho.bottom = -half;
    this.ortho.updateProjectionMatrix();
  }

  frameAll() {
    const box = new THREE.Box3();
    for (const room of this.project.rooms) for (const p of room.outline) {
      const w = roomToWorld(room, p);
      box.expandByPoint(new THREE.Vector3(w[0], 0, w[1]));
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 0, 3));
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z, 3);
    this.controls3d.target.copy(c);
    this.persp.position.set(c.x + r * 0.35, r * 1.05, c.z + r * 0.95);
    this.persp.lookAt(c);
    this.controlsTop.target.set(c.x, 0, c.z);
    this.ortho.position.set(c.x, 50, c.z);
    this.ortho.lookAt(c.x, 0, c.z);
    this.orthoHalf = r * 0.62;
    this.ortho.zoom = 1;
    this.sun.position.set(c.x + 6, 12, c.z + 4);
    this.sun.target.position.copy(c);
    this.resize();
  }

  // ======================= cykl życia =======================
  open(project, { xrSupported = false } = {}) {
    this.project = project;
    this.xrSupported = xrSupported;
    this.history = new History(project);
    this.selection = null;
    this.measure = [];
    this.el.projectName.value = project.name;
    this.el.root.hidden = false;
    this.setMode('furniture');
    this.setView(this.view);
    this.resize();
    this.refresh();
    this.frameAll();
    this.updateXRButtons();
    if (!this.running) { this.running = true; this.loop(); }
    this.el.saveStatus.textContent = 'Zapisano';
  }

  close() {
    this.running = false;
    this.flushSave();
    this.el.root.hidden = true;
  }

  updateXRButtons() {
    for (const id of ['btn-scan', 'btn-mr']) {
      const b = document.getElementById(id);
      b.disabled = !this.xrSupported;
      if (!this.xrSupported) b.title = 'Dostępne w przeglądarce Meta Quest (WebXR AR). Na komputerze: dodaj ?emulate=office_small do adresu, aby przetestować w emulatorze.';
    }
  }

  // ======================= zmiany modelu =======================
  /** Pełne odświeżenie po zmianie (przebudowa sceny, paneli). */
  refresh() {
    this.computeAllConflicts();
    this.view3d.setOptions({ ...this.viewOpts, selection: this.selection, selectedId: this.selection && this.selection.kind === 'furniture' ? this.selection.id : null, selectedIds: this.extra, conflicts: this.conflicts, mode: this.mode });
    this.view3d.rebuild(this.project);
    this.updateOverlay();
    this.renderPanels();
    document.getElementById('btn-undo').disabled = !this.history.canUndo;
    document.getElementById('btn-redo').disabled = !this.history.canRedo;
  }

  computeAllConflicts() {
    this.conflicts = new Map();
    for (const room of this.project.rooms) for (const [id, list] of computeConflicts(room)) this.conflicts.set(id, list);
  }

  /** Zatwierdza zmianę: historia + zapis + odświeżenie. */
  commit() {
    if (this.history.commit(this.project)) this.scheduleSave();
    this.refresh();
  }

  scheduleSave() {
    this.el.saveStatus.textContent = 'Zapisywanie…';
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 600);
  }

  async flushSave() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      await saveProject(this.project);
      this.el.saveStatus.textContent = 'Zapisano';
    } catch (e) {
      console.error(e);
      this.el.saveStatus.textContent = 'Błąd zapisu!';
      this.toast('Nie udało się zapisać projektu: ' + e.message, true);
    }
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
    this.project = p;
    this.validateSelection();
    this.scheduleSave();
    this.refresh();
    if (this.onProjectReplaced) this.onProjectReplaced(p);
  }

  validateSelection() {
    for (const id of [...this.extra]) if (!findFurniture(this.project, id)) this.extra.delete(id);
    const s = this.selection;
    if (!s) return;
    const room = s.roomId && this.project.rooms.find((r) => r.id === s.roomId);
    if (s.kind === 'furniture' && !findFurniture(this.project, s.id)) this.selection = null;
    else if (s.kind !== 'furniture' && !room) this.selection = null;
    else if (s.kind === 'opening' && !room.openings.some((o) => o.id === s.id)) this.selection = null;
    else if ((s.kind === 'edge' || s.kind === 'vertex') && s.index >= room.outline.length) this.selection = null;
  }

  room(id) { return this.project.rooms.find((r) => r.id === id); }

  selected() {
    const s = this.selection;
    if (!s) return null;
    if (s.kind === 'furniture') return findFurniture(this.project, s.id);
    const room = this.room(s.roomId);
    if (!room) return null;
    if (s.kind === 'opening') return { room, op: room.openings.find((o) => o.id === s.id) };
    return { room };
  }

  select(sel, { keepExtra = false } = {}) {
    this.selection = sel;
    if (!keepExtra) this.extra.clear();
    this.refresh();
  }

  /** Shift/Ctrl+klik: dodaje/usuwa mebel z zaznaczenia wielokrotnego. */
  toggleExtra(id) {
    const s = this.selection;
    if (!s || s.kind !== 'furniture') return this.select({ kind: 'furniture', id });
    if (id === s.id) {
      // odznacz główny: następny z dodatkowych staje się głównym
      const next = [...this.extra][0];
      if (!next) return this.select(null);
      this.extra.delete(next);
      this.selection = { kind: 'furniture', id: next };
    } else if (this.extra.has(id)) this.extra.delete(id);
    else this.extra.add(id);
    this.refresh();
  }

  selectedFurnitureIds() {
    const s = this.selection;
    if (!s || s.kind !== 'furniture') return [];
    return [s.id, ...this.extra];
  }

  mergeSelected() {
    const ids = this.selectedFurnitureIds();
    if (ids.length < 2) return this.toast('Zaznacz co najmniej 2 bryły (Shift/Ctrl + klik).');
    const merged = mergeFurniture(this.project, ids);
    if (!merged) return;
    this.extra.clear();
    this.selection = { kind: 'furniture', id: merged.id };
    this.commit();
    this.toast(`Scalono ${ids.length} bryły w „${merged.name}” (Ctrl+Z cofa).`);
  }

  // ======================= tryby i widoki =======================
  setMode(mode) {
    if (this.mode === 'measure' && mode !== 'measure') this.measure = [];
    this.mode = mode;
    if (mode === 'furniture' && this.selection && this.selection.kind !== 'furniture') this.selection = null;
    if (mode === 'walls' && this.selection && !['edge', 'vertex', 'opening'].includes(this.selection.kind)) this.selection = null;
    if (mode === 'rooms' && this.selection && this.selection.kind !== 'room') this.selection = null;
    for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('active', b.dataset.mode === mode);
    const hints = {
      furniture: 'Kliknij mebel, aby go zaznaczyć, przeciągnij, aby przesunąć. Shift/Ctrl + klik zaznacza kilka (np. do scalenia). R obrót o 15°, strzałki = 1 cm, Del = usuń, H = ukryj. Alt wyłącza przyciąganie.',
      walls: 'Przeciągaj narożniki (kropki), aby poprawić obrys. Kliknij ścianę, aby zmienić jej długość lub przesunąć ją. Drzwi i okna przeciągaj wzdłuż ściany.',
      rooms: 'Przeciągnij pokój, aby ułożyć mieszkanie. Obrót i dokładna pozycja w panelu po prawej.',
      measure: 'Miarka: kliknij dwa punkty (podłoga, mebel, ściana). Esc czyści pomiary.',
    };
    this.el.hint.textContent = hints[mode] || '';
    if (this.project) this.refresh();
  }

  setView(view) {
    const prev = this.view;
    this.view = view;
    this.controls3d.enabled = view !== 'top';
    this.controlsTop.enabled = view === 'top';
    this.controls3d.autoRotate = view === 'model';
    this.controls3d.autoRotateSpeed = 1.2;
    if (!this.autoRotateBound) {
      this.autoRotateBound = true;
      this.controls3d.addEventListener('start', () => { this.controls3d.autoRotate = false; });
    }
    if (this.project && (prev === 'model') !== (view === 'model')) this.refresh();
    for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('active', b.dataset.view === view);
    this.resize();
  }

  // ======================= nakładki (uchwyty, wymiary, miarka) =======================
  clearOverlay() {
    this.overlay.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.isCSS2DObject && o.element) o.element.remove();
    });
    this.overlay.clear();
  }

  roomOverlayGroup(room) {
    const g = new THREE.Group();
    const t = room.transform;
    g.position.set(t.x, 0, t.z);
    g.rotation.y = t.rot;
    this.overlay.add(g);
    return g;
  }

  label(text, cls, pos, parent) {
    const el = document.createElement('div');
    el.className = 'label3d ' + (cls || '');
    el.textContent = text;
    const o = new CSS2DObject(el);
    o.position.copy(pos);
    parent.add(o);
    return o;
  }

  updateOverlay() {
    this.clearOverlay();
    if (!this.project) return;
    const handleGeo = new THREE.SphereGeometry(0.07, 16, 12);
    // tryb ścian: uchwyty narożników + długości ścian
    if (this.mode === 'walls') {
      for (const room of this.project.rooms) {
        const g = this.roomOverlayGroup(room);
        room.outline.forEach((p, i) => {
          const sel = this.selection && this.selection.kind === 'vertex' && this.selection.roomId === room.id && this.selection.index === i;
          const m = new THREE.Mesh(handleGeo, new THREE.MeshBasicMaterial({ color: sel ? 0xffd400 : 0x00a0ff, depthTest: false }));
          m.renderOrder = 10;
          m.position.set(p[0], 0.02, p[1]);
          m.userData = { kind: 'vertex', roomId: room.id, index: i };
          g.add(m);
          const e = edgeOf(room.outline, i);
          const mid = new THREE.Vector3((e.a[0] + e.b[0]) / 2 + e.inward[0] * 0.25, 0.05, (e.a[1] + e.b[1]) / 2 + e.inward[1] * 0.25);
          this.label(fmtCm(e.length), 'measure', mid, g);
        });
      }
    }
    // zaznaczony mebel: odległości do przeszkód
    const s = this.selection;
    if (s && s.kind === 'furniture' && this.mode === 'furniture') {
      const found = findFurniture(this.project, s.id);
      if (found && !found.f.hidden) {
        const g = this.roomOverlayGroup(found.room);
        for (const c of computeClearances(found.room, found.f)) {
          const y = Math.min(found.f.h, 0.3) + (found.f.y || 0);
          const a = new THREE.Vector3(c.from[0], y, c.from[1]), b = new THREE.Vector3(c.to[0], y, c.to[1]);
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineDashedMaterial({ color: c.dist < 0.05 ? 0xd93838 : 0x1e8a4a, dashSize: 0.05, gapSize: 0.03, depthTest: false }));
          line.computeLineDistances();
          line.renderOrder = 9;
          g.add(line);
          if (c.dist > 0.005) this.label(fmtCm(c.dist), 'clear' + (c.dist < 0.6 ? ' tight' : ''), a.clone().lerp(b, 0.5), g);
        }
      }
    }
    // miarka
    if (this.measure.length) {
      const mat = new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false });
      for (let i = 0; i < this.measure.length; i++) {
        const p = this.measure[i];
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false }));
        dot.renderOrder = 11;
        dot.position.copy(p);
        this.overlay.add(dot);
        if (i % 2 === 1) {
          const a = this.measure[i - 1];
          const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, p]), mat);
          l.renderOrder = 11;
          this.overlay.add(l);
          const d = a.distanceTo(p);
          const dxz = Math.hypot(a.x - p.x, a.z - p.z);
          const txt = Math.abs(a.y - p.y) > 0.02 ? `${fmtCm(d)} (poziomo ${fmtCm(dxz)})` : fmtCm(d);
          this.label(txt, 'measure', a.clone().lerp(p, 0.5), this.overlay);
        }
      }
    }
  }

  // ======================= wskaźnik =======================
  setPointer(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  hitObjects(objs) {
    const hits = this.raycaster.intersectObjects(objs, false);
    return hits.length ? hits[0] : null;
  }

  floorHit() {
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.floorPlane, p) ? p : null;
  }

  overlayHandles() {
    const out = [];
    this.overlay.traverse((o) => { if (o.userData && o.userData.kind === 'vertex') out.push(o); });
    return out;
  }

  onPointerDown(e) {
    if (e.button !== 0 || !this.project) return;
    this.setPointer(e);
    this.down = { x: e.clientX, y: e.clientY, moved: false, handled: false };
    const mode = this.mode;
    if (mode === 'measure') {
      const hit = this.hitObjects(this.view3d.getPickables());
      const p = hit ? hit.point.clone() : this.floorHit();
      if (p) {
        if (this.measure.length % 2 === 0 && this.measure.length >= 6) this.measure = [];
        this.measure.push(p);
        this.updateOverlay();
      }
      this.stopControls(e);
      return;
    }
    if (mode === 'furniture') {
      const hit = this.hitObjects(this.view3d.getPickables(['furniture']));
      if (hit) {
        const { id, roomId } = hit.object.userData;
        const room = this.room(roomId);
        const f = room.furniture.find((x) => x.id === id);
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          this.toggleExtra(id);
          this.stopControls(e);
          return;
        }
        if (!this.selection || (this.selection.id !== id && !this.extra.has(id))) this.select({ kind: 'furniture', id });
        else if (this.extra.has(id)) { this.extra.delete(id); this.extra.add(this.selection.id); this.select({ kind: 'furniture', id }, { keepExtra: true }); }
        const fp = this.floorHit();
        if (fp) {
          const local = worldToRoom(room, [fp.x, fp.z]);
          this.drag = { type: 'furniture', id, roomId, off: [f.x - local[0], f.z - local[1]], start: { x: f.x, z: f.z } };
        }
        this.stopControls(e);
      }
      return;
    }
    if (mode === 'walls') {
      const h = this.hitObjects(this.overlayHandles());
      if (h) {
        const { roomId, index } = h.object.userData;
        this.select({ kind: 'vertex', roomId, index });
        this.drag = { type: 'vertex', roomId, index };
        this.stopControls(e);
        return;
      }
      const hit = this.hitObjects(this.view3d.getPickables(['opening', 'wall']));
      if (hit && hit.object.userData.kind === 'opening') {
        const { roomId, id } = hit.object.userData;
        const room = this.room(roomId);
        const op = room.openings.find((o) => o.id === id);
        this.select({ kind: 'opening', roomId, id });
        const fp = this.floorHit();
        if (fp && op) {
          const e2 = edgeOf(room.outline, op.edge);
          const t = projectT(worldToRoom(room, [fp.x, fp.z]), e2.a, e2.b) * e2.length;
          this.drag = { type: 'opening', roomId, id, grab: t - op.offset };
        }
        this.stopControls(e);
        return;
      }
      if (hit && hit.object.userData.kind === 'wall') {
        this.select({ kind: 'edge', roomId: hit.object.userData.roomId, index: hit.object.userData.index });
        this.stopControls(e);
      }
      return;
    }
    if (mode === 'rooms') {
      const hit = this.hitObjects(this.view3d.getPickables(['floor', 'wall', 'furniture', 'opening']));
      if (hit) {
        const roomId = hit.object.userData.roomId;
        if (!this.selection || this.selection.roomId !== roomId) this.select({ kind: 'room', roomId });
        const fp = this.floorHit();
        const room = this.room(roomId);
        if (fp) this.drag = { type: 'room', roomId, startHit: [fp.x, fp.z], startT: { ...room.transform } };
        this.stopControls(e);
      }
    }
  }

  stopControls() {
    this.activeControls.enabled = false;
    if (this.down) this.down.handled = true;
  }

  onPointerMove(e) {
    if (!this.down) return;
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 3) this.down.moved = true;
    if (!this.drag || !this.down.moved) return;
    this.setPointer(e);
    const fp = this.floorHit();
    if (!fp) return;
    const d = this.drag;
    const room = this.room(d.roomId);
    if (d.type === 'furniture') {
      const f = room.furniture.find((x) => x.id === d.id);
      const local = worldToRoom(room, [fp.x, fp.z]);
      f.x = local[0] + d.off[0];
      f.z = local[1] + d.off[1];
      if (this.opts.snap && !e.altKey) {
        const s = snapToWalls(room, f, 0.06);
        if (s) { f.x = s.x; f.z = s.z; }
      }
      d.changed = true;
      this.view3d.updateFurnitureTransform(f);
      this.liveConflicts(room);
      this.updateOverlay();
      this.renderPropsIfIdle();
    } else if (d.type === 'vertex') {
      const local = worldToRoom(room, [fp.x, fp.z]);
      let p = [Math.round(local[0] * 100) / 100, Math.round(local[1] * 100) / 100];
      // przyciąganie do osi sąsiednich narożników (zachowanie kątów prostych)
      if (!e.altKey) {
        const n = room.outline.length;
        for (const j of [(d.index - 1 + n) % n, (d.index + 1) % n]) {
          const q = room.outline[j];
          if (Math.abs(p[0] - q[0]) < 0.04) p[0] = q[0];
          if (Math.abs(p[1] - q[1]) < 0.04) p[1] = q[1];
        }
      }
      room.outline[d.index] = p;
      d.changed = true;
      this.refresh();
    } else if (d.type === 'opening') {
      const op = room.openings.find((o) => o.id === d.id);
      const e2 = edgeOf(room.outline, op.edge);
      const t = projectT(worldToRoom(room, [fp.x, fp.z]), e2.a, e2.b) * e2.length;
      op.offset = Math.max(0, Math.min(e2.length - op.width, Math.round((t - d.grab) * 100) / 100));
      d.changed = true;
      this.refresh();
    } else if (d.type === 'room') {
      room.transform.x = Math.round((d.startT.x + fp.x - d.startHit[0]) * 100) / 100;
      room.transform.z = Math.round((d.startT.z + fp.z - d.startHit[1]) * 100) / 100;
      d.changed = true;
      const g = this.view3d.roomGroups.get(room.id);
      if (g) g.position.set(room.transform.x, 0, room.transform.z);
      this.renderPropsIfIdle();
    }
  }

  liveConflicts(room) {
    for (const f of room.furniture) this.conflicts.delete(f.id);
    for (const [id, list] of computeConflicts(room)) this.conflicts.set(id, list);
    this.view3d.setOptions({ conflicts: this.conflicts });
    this.view3d.applyHighlights();
  }

  onPointerUp(e) {
    if (!this.down) return;
    const wasClick = !this.down.moved && !this.down.handled;
    this.down = null;
    this.activeControls.enabled = true;
    const d = this.drag;
    this.drag = null;
    if (d && d.changed) {
      if (d.type === 'furniture') this.maybeReparent(d.id);
      this.commit();
      return;
    }
    if (wasClick && !d && e.target === this.renderer.domElement && this.mode !== 'measure') {
      // klik w pustą przestrzeń -> odznacz
      if (this.selection) this.select(null);
    }
  }

  onDoubleClick(e) {
    this.setPointer(e);
    const hit = this.hitObjects(this.view3d.getPickables(['furniture', 'floor']));
    if (hit) this.focusOn(hit.point);
  }

  focusOn(p) {
    const ctl = this.activeControls;
    const delta = new THREE.Vector3(p.x, 0, p.z).sub(new THREE.Vector3(ctl.target.x, 0, ctl.target.z));
    ctl.target.add(delta);
    this.camera.position.add(delta);
  }

  /** Mebel przeciągnięty do innego pokoju zmienia przynależność. */
  maybeReparent(id) {
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
    f.rot = normalizeAngle((f.rot || 0) + (room.transform.rot - target.transform.rot));
    room.furniture.splice(room.furniture.indexOf(f), 1);
    target.furniture.push(f);
    this.toast(`„${f.name}” przeniesiono do: ${target.name}`);
  }

  // ======================= operacje =======================
  updateFurniture(id, patch, { commit = true } = {}) {
    const found = findFurniture(this.project, id);
    if (!found) return;
    Object.assign(found.f, patch);
    if (commit) this.commit();
  }

  rotateSelected(deltaRad) {
    const s = this.selected();
    if (!s || !s.f) return;
    s.f.rot = normalizeAngle((s.f.rot || 0) + deltaRad);
    this.commit();
  }

  nudgeSelected(dx, dz) {
    const s = this.selected();
    if (!s || !s.f) return;
    s.f.x += dx;
    s.f.z += dz;
    this.commit();
  }

  deleteSelected() {
    const s = this.selection;
    if (!s) return;
    if (s.kind === 'furniture') {
      const ids = this.selectedFurnitureIds();
      if (ids.length > 1) {
        for (const room of this.project.rooms) room.furniture = room.furniture.filter((f) => !ids.includes(f.id));
        this.extra.clear();
        this.toast(`Usunięto ${ids.length} mebli (Ctrl+Z cofa)`);
        this.selection = null;
        this.commit();
        return;
      }
      const found = findFurniture(this.project, s.id);
      if (!found) return;
      found.room.furniture = found.room.furniture.filter((f) => f.id !== s.id);
      this.toast(`Usunięto „${found.f.name}” (Ctrl+Z cofa)`);
    } else if (s.kind === 'opening') {
      const room = this.room(s.roomId);
      room.openings = room.openings.filter((o) => o.id !== s.id);
    } else if (s.kind === 'vertex') {
      const room = this.room(s.roomId);
      if (room.outline.length <= 3) return this.toast('Pomieszczenie musi mieć co najmniej 3 narożniki.', true);
      this.removeVertexFix(room, s.index);
    } else if (s.kind === 'room') {
      const room = this.room(s.roomId);
      if (!confirm(`Usunąć pokój „${room.name}” razem z meblami?`)) return;
      this.project.rooms = this.project.rooms.filter((r) => r.id !== s.roomId);
    } else {
      return;
    }
    this.selection = null;
    this.commit();
  }

  /** Usuwa narożnik i przenumerowuje krawędzie otworów. */
  removeVertexFix(room, i) {
    const n = room.outline.length;
    room.outline = removeVertex(room.outline, i);
    // krawędzie i-1 oraz i łączą się w jedną (nowy indeks i-1)
    room.openings = room.openings.filter((o) => {
      if (o.edge === i || o.edge === (i - 1 + n) % n) {
        o.edge = (i - 1 + n) % n;
        if (o.edge >= room.outline.length) o.edge = room.outline.length - 1;
      } else if (o.edge > i) o.edge -= 1;
      return true;
    });
  }

  splitSelectedEdge() {
    const s = this.selection;
    if (!s || s.kind !== 'edge') return;
    const room = this.room(s.roomId);
    room.outline = splitEdge(room.outline, s.index, 0.5);
    for (const o of room.openings) if (o.edge > s.index) o.edge += 1;
    this.selection = { kind: 'vertex', roomId: room.id, index: s.index + 1 };
    this.commit();
  }

  duplicateSelected() {
    const s = this.selected();
    if (!s || !s.f) return;
    const copy = { ...structuredClone(s.f), id: uid('f'), name: s.f.name + ' (kopia)', x: s.f.x + 0.3, z: s.f.z + 0.3, scanned: null };
    s.room.furniture.push(copy);
    this.selection = { kind: 'furniture', id: copy.id };
    this.commit();
  }

  /** Pokój, w którym dodawać nowe elementy. */
  targetRoom() {
    const s = this.selection;
    if (s && s.roomId) return this.room(s.roomId);
    if (s && s.kind === 'furniture') { const f = findFurniture(this.project, s.id); if (f) return f.room; }
    const t = this.activeControls.target;
    return this.project.rooms.find((r) => roomContainsWorldPoint(r, [t.x, t.z])) || this.project.rooms[0];
  }

  addFurniture(tpl) {
    let room = this.targetRoom();
    if (!room) {
      room = createRoom({ name: 'Pokój 1' });
      this.project.rooms.push(room);
    }
    const t = this.activeControls.target;
    let pos = worldToRoom(room, [t.x, t.z]);
    if (!roomContainsWorldPoint(room, [t.x, t.z])) pos = polygonCentroid(room.outline);
    const f = createFurniture({ ...tpl, name: tpl.name || typeName(tpl.type), x: pos[0], z: pos[1], verified: true });
    room.furniture.push(f);
    this.selection = { kind: 'furniture', id: f.id };
    if (this.mode !== 'furniture') this.setMode('furniture');
    this.commit();
    this.toast(`Dodano: ${f.name} — przeciągnij go na miejsce.`);
  }

  addOpening(type) {
    const s = this.selection;
    let room, edge;
    if (s && s.kind === 'edge') { room = this.room(s.roomId); edge = s.index; }
    else if (s && s.kind === 'opening') { room = this.room(s.roomId); edge = room.openings.find((o) => o.id === s.id).edge; }
    else {
      this.setMode('walls');
      this.toast('Najpierw kliknij ścianę, na której mają być ' + (type === 'door' ? 'drzwi.' : 'okno.'));
      return;
    }
    const e = edgeOf(room.outline, edge);
    const op = createOpening({ type, edge });
    op.width = Math.min(op.width, Math.max(0.3, e.length - 0.1));
    op.offset = Math.max(0, (e.length - op.width) / 2);
    room.openings.push(op);
    this.selection = { kind: 'opening', roomId: room.id, id: op.id };
    this.commit();
  }

  addRoom() {
    let maxX = -Infinity, minZ = Infinity;
    for (const r of this.project.rooms) for (const p of r.outline) {
      const w = roomToWorld(r, p);
      maxX = Math.max(maxX, w[0]);
      minZ = Math.min(minZ, w[1]);
    }
    const room = createRoom({ name: `Pokój ${this.project.rooms.length + 1}`, outline: [[0, 0], [3.5, 0], [3.5, 3], [0, 3]], transform: { x: isFinite(maxX) ? maxX + 0.5 : 0, z: isFinite(minZ) ? minZ : 0, rot: 0 } });
    this.project.rooms.push(room);
    this.selection = { kind: 'room', roomId: room.id };
    this.setMode('rooms');
    this.commit();
    this.frameAll();
  }

  // ======================= eksport / import =======================
  exportJSON(includeMesh = true) {
    const json = JSON.stringify(projectToJSON(this.project, { includeMesh }));
    download(new Blob([json], { type: 'application/json' }), `${safeName(this.project.name)}.hause.json`);
  }

  async exportGLB() {
    const v = new ApartmentView({ mode: 'editor', cssLabels: false });
    v.setOptions({ wallMode: 'full', showMesh: false, showGhosts: false, showZones: false, showLabels: false, conflicts: new Map() });
    v.rebuild(this.project);
    v.group.traverse((o) => {
      if (o.isMesh && o.userData && o.userData.id) {
        const found = findFurniture(this.project, o.userData.id);
        if (found) o.name = found.f.name;
      }
    });
    try {
      const glb = await new GLTFExporter().parseAsync(v.group, { binary: true });
      download(new Blob([glb], { type: 'model/gltf-binary' }), `${safeName(this.project.name)}.glb`);
    } catch (e) {
      this.toast('Eksport GLB nie powiódł się: ' + e.message, true);
    } finally {
      v.dispose();
    }
  }

  async importRoomsFromFile(file) {
    try {
      const obj = projectFromJSON(JSON.parse(await file.text()));
      const existing = new Set(this.project.rooms.map((r) => r.id));
      let n = 0;
      for (const r of obj.rooms) {
        if (existing.has(r.id)) r.id = uid('room');
        this.project.rooms.push(r);
        n++;
      }
      this.commit();
      this.frameAll();
      this.toast(`Dołączono pokoje: ${n}. Ułóż je w trybie „Pokoje”.`);
    } catch (e) {
      this.toast('Nie udało się wczytać pliku: ' + e.message, true);
    }
  }

  // ======================= UI =======================
  initUI() {
    const $ = (id) => document.getElementById(id);
    for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => this.setMode(b.dataset.mode));
    for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => this.setView(b.dataset.view));
    $('btn-undo').addEventListener('click', () => this.undo());
    $('btn-redo').addEventListener('click', () => this.redo());
    $('btn-add-door').addEventListener('click', () => this.addOpening('door'));
    $('btn-add-window').addEventListener('click', () => this.addOpening('window'));
    $('btn-add-room').addEventListener('click', () => this.addRoom());
    $('btn-export-json').addEventListener('click', () => this.exportJSON(true));
    $('btn-export-json-light').addEventListener('click', () => this.exportJSON(false));
    $('btn-export-glb').addEventListener('click', () => this.exportGLB());
    $('file-import-editor').addEventListener('change', (e) => { if (e.target.files[0]) this.importRoomsFromFile(e.target.files[0]); e.target.value = ''; });
    $('btn-scan').addEventListener('click', () => this.onStartXR && this.onStartXR('scan', this));
    $('btn-mr').addEventListener('click', () => this.onStartXR && this.onStartXR('edit', this));
    this.el.projectName.addEventListener('change', () => {
      this.project.name = this.el.projectName.value.trim() || 'Bez nazwy';
      this.commit();
    });

    // menu rozwijane
    const addMenu = $('menu-add');
    addMenu.innerHTML = TEMPLATES.map((t, i) => {
      const n = t.name || typeName(t.type);
      return `<button data-tpl="${i}">${esc(n)} <span class="hint">${Math.round(t.w * 100)}×${Math.round(t.d * 100)}×${Math.round(t.h * 100)}</span></button>`;
    }).join('');
    addMenu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tpl]');
      if (!b) return;
      this.addFurniture(TEMPLATES[+b.dataset.tpl]);
      addMenu.classList.remove('open');
    });
    for (const [btn, menu] of [['btn-add', 'menu-add'], ['btn-show', 'menu-show'], ['btn-export', 'menu-export']]) {
      $(btn).addEventListener('click', (e) => {
        e.stopPropagation();
        const m = $(menu);
        const open = !m.classList.contains('open');
        document.querySelectorAll('.menu.open').forEach((x) => x.classList.remove('open'));
        m.classList.toggle('open', open);
      });
    }
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu')) document.querySelectorAll('.menu.open').forEach((x) => x.classList.remove('open'));
    });
    $('menu-export').addEventListener('click', (e) => { if (e.target.closest('button')) $('menu-export').classList.remove('open'); });
    $('menu-show').addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.opt) this.opts[t.dataset.opt] = t.checked;
      if (t.name === 'wallMode') this.opts.wallMode = t.value;
      if (t.dataset.opt === 'showMesh' && t.checked && !this.project.rooms.some((r) => r.scan && r.scan.mesh)) this.toast('Ten projekt nie zawiera siatki ze skanu.');
      this.refresh();
    });

    // klawiatura
    window.addEventListener('keydown', (e) => this.onKey(e));

    // panele (delegacja zdarzeń)
    this.el.roomList.addEventListener('click', (e) => this.onListClick(e));
    this.el.roomList.addEventListener('dblclick', (e) => {
      const it = e.target.closest('[data-fid]');
      if (!it) return;
      const obj = this.view3d.furnitureObjects.get(it.dataset.fid);
      if (obj) this.focusOn(obj.getWorldPosition(new THREE.Vector3()));
    });
    this.el.issues.addEventListener('click', (e) => {
      const it = e.target.closest('[data-fid]');
      if (it) { this.setMode('furniture'); this.select({ kind: 'furniture', id: it.dataset.fid }); }
    });
    this.el.verify.addEventListener('click', (e) => this.onVerifyClick(e));
    this.el.props.addEventListener('change', (e) => this.onPropChange(e));
    this.el.props.addEventListener('click', (e) => this.onPropClick(e));
  }

  onKey(e) {
    if (this.el.root.hidden) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); this.redo(); return; }
    if (ctrl && (k === 'd' || k === 'D')) { e.preventDefault(); this.duplicateSelected(); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this.deleteSelected(); return; }
    if (k === 'Escape') { this.measure = []; this.select(null); return; }
    if (k === 'r' || k === 'R') { this.rotateSelected((e.shiftKey ? -1 : 1) * rad(15)); return; }
    if (k === 'h' || k === 'H') { const s = this.selected(); if (s && s.f) this.updateFurniture(s.f.id, { hidden: !s.f.hidden }); return; }
    if (k === 'v' || k === 'V') { this.setView(this.view === '3d' ? 'top' : '3d'); return; }
    if (k === 'm' || k === 'M') { this.setMode('measure'); return; }
    if (k === '1') return this.setMode('furniture');
    if (k === '2') return this.setMode('walls');
    if (k === '3') return this.setMode('rooms');
    const step = e.shiftKey ? 0.1 : 0.01;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (arrows[k]) {
      const s = this.selected();
      if (s && s.f) {
        e.preventDefault();
        // strzałki w układzie ekranu (widok z góry): przelicz na układ pokoju
        const room = s.room;
        const c = Math.cos(-room.transform.rot), sn = Math.sin(-room.transform.rot);
        const [dx, dz] = arrows[k];
        this.nudgeSelected(dx * c + dz * sn, -dx * sn + dz * c);
      }
    }
  }

  renderPropsIfIdle() {
    if (this.el.props.contains(document.activeElement)) return;
    this.renderProps();
  }

  renderPanels() {
    this.renderRoomList();
    this.renderIssues();
    this.renderVerify();
    if (!this.el.props.contains(document.activeElement) || !this.lastPropsKey || this.lastPropsKey !== this.propsKey()) this.renderProps();
  }

  propsKey() {
    const s = this.selection;
    return s ? `${s.kind}:${s.id || ''}:${s.roomId || ''}:${s.index ?? ''}` : 'none';
  }

  renderRoomList() {
    const s = this.selection;
    const html = this.project.rooms.map((room) => {
      const roomSel = s && s.kind === 'room' && s.roomId === room.id;
      const items = room.furniture.map((f) => {
        const conf = this.conflicts.get(f.id) || [];
        const hard = conf.some((c) => c.kind !== 'door');
        const badge = hard ? '<span class="badge conflict" title="Koliduje">!</span>' : conf.length ? '<span class="badge warn" title="W strefie drzwi">!</span>' : '';
        const unv = f.verified ? '' : '<span class="badge unverified" title="Do potwierdzenia">?</span>';
        const sel = (s && s.kind === 'furniture' && s.id === f.id) || this.extra.has(f.id);
        return `<div class="item ${sel ? 'selected' : ''} ${f.hidden ? 'hidden-item' : ''}" data-fid="${f.id}" title="Dwuklik: pokaż na widoku">
          <span class="nm">${esc(f.name)}</span>${unv}${badge}
          <button class="eye" data-eye="${f.id}" title="${f.hidden ? 'Pokaż' : 'Ukryj (np. mebel tymczasowy)'}">${f.hidden ? '◌' : '●'}</button></div>`;
      }).join('');
      return `<div class="room-block">
        <div class="room-title ${roomSel ? 'selected' : ''}" data-rid="${room.id}"><span>${esc(room.name)}</span><span class="meta">${(Math.abs(polygonArea(room.outline))).toFixed(1)} m²</span></div>
        ${items || '<div class="item hint">brak mebli</div>'}
      </div>`;
    }).join('');
    this.el.roomList.innerHTML = `<h3>Pokoje i meble</h3>${html || '<p class="hint">Brak pokoi. Zeskanuj pokój goglami albo dodaj pusty pokój (+ Pokój).</p>'}`;
  }

  onListClick(e) {
    const eye = e.target.closest('[data-eye]');
    if (eye) {
      e.stopPropagation();
      const found = findFurniture(this.project, eye.dataset.eye);
      if (found) this.updateFurniture(found.f.id, { hidden: !found.f.hidden });
      return;
    }
    const it = e.target.closest('[data-fid]');
    if (it) {
      if (this.mode !== 'furniture') this.setMode('furniture');
      if (e.shiftKey || e.ctrlKey || e.metaKey) this.toggleExtra(it.dataset.fid);
      else this.select({ kind: 'furniture', id: it.dataset.fid });
      return;
    }
    const rt = e.target.closest('[data-rid]');
    if (rt) {
      if (this.mode !== 'rooms') this.setMode('rooms');
      this.select({ kind: 'room', roomId: rt.dataset.rid });
    }
  }

  renderIssues() {
    const rows = [];
    for (const room of this.project.rooms) for (const f of room.furniture) {
      const list = this.conflicts.get(f.id);
      if (!list) continue;
      const hard = list.filter((c) => c.kind !== 'door');
      const txt = (hard.length ? hard : list).map((c) => c.label).filter((v, i, a) => a.indexOf(v) === i).join(', ');
      rows.push(`<div class="issue ${hard.length ? '' : 'warn'}" data-fid="${f.id}"><b>${esc(f.name)}</b>: ${hard.length ? 'koliduje z' : 'stoi w'} ${esc(txt)}</div>`);
    }
    this.el.issues.innerHTML = rows.length ? `<h3>Problemy (${rows.length})</h3>${rows.join('')}` : '';
  }

  // ---- „dopytywanie”: potwierdzanie wykrytych przedmiotów ----
  nextUnverified() {
    for (const room of this.project.rooms) for (const f of room.furniture) if (!f.verified && !f.hidden) return { room, f };
    return null;
  }

  renderVerify() {
    const s = this.selection;
    let target = null;
    if (s && s.kind === 'furniture') {
      const found = findFurniture(this.project, s.id);
      if (found && !found.f.verified) target = found;
    }
    const total = this.project.rooms.reduce((n, r) => n + r.furniture.filter((f) => !f.verified && !f.hidden).length, 0);
    if (!total) { this.el.verify.hidden = true; return; }
    this.el.verify.hidden = false;
    if (!target) {
      this.el.verify.innerHTML = `<div class="q">Do potwierdzenia: ${total}</div><div class="note hint">Skaner wykrył przedmioty, ale nie zawsze trafnie je nazywa.</div><div class="chips"><button class="primary" data-vstart>Przejrzyj po kolei</button></div>`;
      return;
    }
    const f = target.f;
    const chips = TYPE_KEYS.map((k) => `<button data-vtype="${k}" ${k === f.type ? 'class="primary"' : ''}>${esc(FURNITURE_TYPES[k].name)}</button>`).join('');
    this.el.verify.innerHTML = `
      <div class="q">Co to jest? <span class="hint">(${total} do potwierdzenia)</span></div>
      <div class="note">Skaner: <b>${esc(f.sourceLabel || '—')}</b> · ${Math.round(f.w * 100)}×${Math.round(f.d * 100)}×${Math.round(f.h * 100)} cm</div>
      <div class="chips">${chips}</div>
      <div class="chips">
        <button data-vok>✓ Zgadza się</button>
        <button data-vhide title="Zostaje w danych, ale znika z makiety">Tymczasowy — ukryj</button>
        <button class="danger" data-vdel>To nie mebel — usuń</button>
      </div>`;
  }

  onVerifyClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-vstart')) {
      const n = this.nextUnverified();
      if (n) { this.setMode('furniture'); this.select({ kind: 'furniture', id: n.f.id }); }
      return;
    }
    const s = this.selected();
    if (!s || !s.f) return;
    const f = s.f;
    if (b.dataset.vtype) {
      const wasDefaultName = !f.name || f.name === typeName(f.type);
      f.type = b.dataset.vtype;
      f.color = typeColor(f.type);
      if (wasDefaultName) f.name = typeName(f.type);
      f.verified = true;
    } else if (b.hasAttribute('data-vok')) {
      f.verified = true;
    } else if (b.hasAttribute('data-vhide')) {
      f.hidden = true;
      f.verified = true;
    } else if (b.hasAttribute('data-vdel')) {
      s.room.furniture = s.room.furniture.filter((x) => x !== f);
    }
    const next = this.nextUnverified();
    this.selection = next ? { kind: 'furniture', id: next.f.id } : null;
    this.commit();
    if (next) {
      const obj = this.view3d.furnitureObjects.get(next.f.id);
      if (obj) this.focusOn(obj.getWorldPosition(new THREE.Vector3()));
    }
  }

  // ---- panel właściwości ----
  renderProps() {
    this.lastPropsKey = this.propsKey();
    const s = this.selection;
    const sel = this.selected();
    let html = '';
    const num = (key, val, step = 1, attrs = '') => `<input type="number" data-k="${key}" value="${val}" step="${step}" ${attrs}>`;
    if (s && s.kind === 'furniture' && this.extra.size) {
      const items = this.selectedFurnitureIds().map((id) => findFurniture(this.project, id)).filter(Boolean);
      html = `
        <h2>Zaznaczono: ${items.length}</h2>
        <div class="note">${items.map((it) => `${esc(it.f.name)} (${Math.round(it.f.w * 100)}×${Math.round(it.f.d * 100)}×${Math.round(it.f.h * 100)})`).join('<br>')}</div>
        <p class="note">Skaner czasem rozpoznaje jeden mebel jako kilka brył. „Scal” zastąpi je jedną bryłą, która obejmuje wszystkie zaznaczone.</p>
        <div class="btns">
          <button class="primary" data-act="merge">⧉ Scal w jeden mebel</button>
          <button data-act="clearExtra">Odznacz</button>
          <button class="danger" data-act="del">🗑 Usuń zaznaczone</button>
        </div>`;
    } else if (s && s.kind === 'furniture' && sel && sel.f) {
      const f = sel.f;
      const conf = this.conflicts.get(f.id) || [];
      const clear = f.hidden ? [] : computeClearances(sel.room, f);
      const dirNames = { '+x': 'w prawo (oś szer.)', '-x': 'w lewo (oś szer.)', '+z': 'przód (oś gł.)', '-z': 'tył (oś gł.)' };
      const typeOpts = TYPE_KEYS.map((k) => `<option value="${k}" ${k === f.type ? 'selected' : ''}>${esc(FURNITURE_TYPES[k].name)}</option>`).join('');
      const shapeOpts = [['box', 'Prostopadłościan'], ['L', 'Kształt L'], ['cylinder', 'Walec / owal']].map(([v, n]) => `<option value="${v}" ${v === f.shape ? 'selected' : ''}>${n}</option>`).join('');
      const sc = f.scanned;
      html = `
        <h2>${esc(f.name)}</h2>
        <div class="row"><span>Nazwa</span><input data-k="name" value="${esc(f.name)}"></div>
        <div class="row"><span>Typ</span><select data-k="type">${typeOpts}</select></div>
        <div class="row"><span>Kształt</span><select data-k="shape">${shapeOpts}</select></div>
        <h3>Wymiary [cm]</h3>
        <div class="row3">
          <label>${f.shape === 'cylinder' ? 'Średnica X' : 'Szerokość'}${num('w', cm(f.w), 0.5, 'min="1"')}</label>
          <label>${f.shape === 'cylinder' ? 'Średnica Z' : 'Głębokość'}${num('d', cm(f.d), 0.5, 'min="1"')}</label>
          <label>Wysokość${num('h', cm(f.h), 0.5, 'min="1"')}</label>
        </div>
        ${f.shape === 'L' ? `<div class="row3"><label>Ramię boczne${num('aw', cm(f.aw), 0.5)}</label><label>Ramię tylne${num('ad', cm(f.ad), 0.5)}</label><label></label></div>` : ''}
        ${sc ? `<div class="note">Ze skanu: ${Math.round(sc.w * 100)}×${Math.round(sc.d * 100)}×${Math.round(sc.h * 100)} cm. Popraw wymiary, mierząc miarką.</div>` : ''}
        <h3>Położenie</h3>
        <div class="row3">
          <label>X [cm]${num('x', cm(f.x), 1)}</label>
          <label>Z [cm]${num('z', cm(f.z), 1)}</label>
          <label>Nad podłogą${num('y', cm(f.y || 0), 1, 'min="0"')}</label>
        </div>
        <div class="row"><span>Obrót [°]</span>${num('rotDeg', Math.round(deg(f.rot || 0) * 10) / 10, 1)}</div>
        <div class="btns">
          <button data-act="rot" data-v="-90">⟲ 90°</button><button data-act="rot" data-v="-15">⟲ 15°</button>
          <button data-act="rot" data-v="15">⟳ 15°</button><button data-act="rot" data-v="90">⟳ 90°</button>
        </div>
        <div class="btns">
          <button data-act="alignWall" title="Obróć równolegle do najbliższej ściany">∥ Wyrównaj do ściany</button>
          <button data-act="snapWall" title="Dosuń do najbliższej ściany (do 30 cm)">⇥ Dosuń do ściany</button>
        </div>
        ${conf.length ? `<div class="conflicts">⚠ ${esc(conf.map((c) => (c.kind === 'furniture' ? 'koliduje z: ' : c.kind === 'wall' ? 'wystaje za ' : 'w ') + c.label).join('; '))}</div>` : '<div class="note" style="color:var(--ok)">✓ Mieści się — brak kolizji</div>'}
        ${clear.length ? `<h3>Wolne miejsce wokół</h3><div class="clear-list">${clear.map((c) => `<span>${dirNames[c.dir]}</span><b>${fmtCm(c.dist)}</b>`).join('')}</div>` : ''}
        <h3>Inne</h3>
        <div class="row"><span>Kolor</span><input type="color" data-k="color" value="${esc(f.color)}"></div>
        <div class="row"><span>Ukryty</span><label><input type="checkbox" data-k="hidden" ${f.hidden ? 'checked' : ''}> tymczasowy / poza makietą</label></div>
        <div class="row"><span>Potwierdzony</span><label><input type="checkbox" data-k="verified" ${f.verified ? 'checked' : ''}> typ sprawdzony</label></div>
        <div class="row"><span>Notatki</span><textarea data-k="notes">${esc(f.notes)}</textarea></div>
        <div class="btns">
          <button data-act="mergeHint" title="Shift/Ctrl + klik zaznacza kilka brył">⧉ Scal z…</button>
          <button data-act="dup">⧉ Duplikuj</button>
          ${sc ? '<button data-act="resetScan" title="Przywróć pozycję i wymiary ze skanu">↺ Jak w skanie</button>' : ''}
          <button class="danger" data-act="del">🗑 Usuń</button>
        </div>`;
    } else if (s && (s.kind === 'edge') && sel) {
      const room = sel.room;
      const e = edgeOf(room.outline, s.index);
      html = `
        <h2>Ściana ${s.index + 1} · ${esc(room.name)}</h2>
        <div class="row"><span>Długość [cm]</span>${num('edgeLen', cm(e.length), 0.5)}</div>
        <div class="note">Zmiana długości przesuwa sąsiednią ścianę (następną w kolejności).</div>
        <div class="row"><span>Przesuń o [cm]</span><input type="number" id="edge-shift" value="0" step="1"></div>
        <div class="btns"><button data-act="edgeShift">Przesuń ścianę</button><span class="note">+ na zewnątrz, − do środka</span></div>
        <div class="btns">
          <button data-act="addDoor">+ Drzwi tutaj</button>
          <button data-act="addWindow">+ Okno tutaj</button>
          <button data-act="split" title="Dodaj narożnik w połowie ściany (np. dla wnęki)">✂ Podziel ścianę</button>
        </div>`;
    } else if (s && s.kind === 'vertex' && sel) {
      const room = sel.room;
      const p = room.outline[s.index];
      html = `
        <h2>Narożnik ${s.index + 1} · ${esc(room.name)}</h2>
        <div class="row3"><label>X [cm]${num('vx', cm(p[0]), 1)}</label><label>Z [cm]${num('vz', cm(p[1]), 1)}</label><label></label></div>
        <div class="note">Przeciągaj kropkę na widoku. Przy sąsiednich narożnikach przyciąga do osi (Alt wyłącza).</div>
        <div class="btns"><button class="danger" data-act="del">Usuń narożnik</button></div>`;
    } else if (s && s.kind === 'opening' && sel && sel.op) {
      const op = sel.op;
      const swingOpts = [['in', 'do środka'], ['out', 'na zewnątrz'], ['none', 'brak / przesuwne']].map(([v, n]) => `<option value="${v}" ${op.swing === v ? 'selected' : ''}>${n}</option>`).join('');
      html = `
        <h2>${op.type === 'door' ? 'Drzwi' : 'Okno'} · ${esc(sel.room.name)}</h2>
        <div class="row"><span>Rodzaj</span><select data-k="opType"><option value="door" ${op.type === 'door' ? 'selected' : ''}>Drzwi</option><option value="window" ${op.type === 'window' ? 'selected' : ''}>Okno</option></select></div>
        <div class="row3">
          <label>Od narożnika${num('opOffset', cm(op.offset), 1, 'min="0"')}</label>
          <label>Szerokość${num('opWidth', cm(op.width), 1, 'min="10"')}</label>
          <label>Wysokość${num('opHeight', cm(op.height), 1, 'min="10"')}</label>
        </div>
        <div class="row"><span>Parapet [cm]</span>${num('opSill', cm(op.sill || 0), 1, 'min="0"')}</div>
        ${op.type === 'door' ? `<div class="row"><span>Otwierane</span><select data-k="opSwing">${swingOpts}</select></div>` : ''}
        <div class="btns"><button class="danger" data-act="del">Usuń</button></div>`;
    } else if (s && s.kind === 'room' && sel) {
      const room = sel.room;
      const t = room.transform;
      html = `
        <h2>${esc(room.name)}</h2>
        <div class="row"><span>Nazwa</span><input data-k="roomName" value="${esc(room.name)}"></div>
        <div class="row"><span>Wysokość [cm]</span>${num('roomHeight', cm(room.height), 1)}</div>
        <div class="note">Powierzchnia: ${Math.abs(polygonArea(room.outline)).toFixed(2)} m² · źródło: ${esc(room.scan && room.scan.source)}</div>
        <h3>Położenie w mieszkaniu</h3>
        <div class="row3">
          <label>X [cm]${num('rtx', cm(t.x), 1)}</label>
          <label>Z [cm]${num('rtz', cm(t.z), 1)}</label>
          <label>Obrót [°]${num('rtrot', Math.round(deg(t.rot) * 10) / 10, 0.5)}</label>
        </div>
        <div class="btns">
          <button data-act="roomRot" data-v="-90">⟲ 90°</button><button data-act="roomRot" data-v="-1">⟲ 1°</button>
          <button data-act="roomRot" data-v="1">⟳ 1°</button><button data-act="roomRot" data-v="90">⟳ 90°</button>
        </div>
        <div class="btns"><button class="danger" data-act="del">Usuń pokój</button></div>`;
    } else {
      const rooms = this.project.rooms.length;
      const furn = this.project.rooms.reduce((n, r) => n + r.furniture.length, 0);
      html = `
        <h2>${esc(this.project.name)}</h2>
        <p class="note">${rooms} pok. · ${furn} mebli · ${this.conflicts.size ? `<span style="color:var(--danger)">${this.conflicts.size} z problemami</span>` : 'brak kolizji'}</p>
        <h3>Jak używać</h3>
        <p class="note"><b>Meble</b>: kliknij i przeciągaj. Kolor czerwony oznacza kolizję, pomarańczowy strefę drzwi. Przerywany obrys pokazuje pozycję ze skanu.</p>
        <p class="note"><b>Ściany</b>: popraw błędy skanu (narożniki, długości ścian, drzwi, okna).</p>
        <p class="note"><b>Pokoje</b>: ułóż kilka zeskanowanych pokoi w całe mieszkanie.</p>
        <p class="note">Skróty: <kbd>R</kbd> obrót, <kbd>Del</kbd> usuń, <kbd>H</kbd> ukryj, <kbd>Ctrl+D</kbd> duplikuj, <kbd>Ctrl+Z</kbd> cofnij, <kbd>V</kbd> widok 3D/z góry, <kbd>M</kbd> miarka, strzałki = 1 cm (Shift = 10 cm), dwuklik = wyśrodkuj.</p>`;
    }
    this.el.props.innerHTML = `<div class="props">${html}</div>`;
  }

  onPropChange(e) {
    const t = e.target;
    const k = t.dataset.k;
    if (!k) return;
    const s = this.selection;
    const sel = this.selected();
    if (!sel) return;
    const v = t.type === 'checkbox' ? t.checked : t.value;
    const m = (x) => { const n = parseFloat(String(x).replace(',', '.')); return isFinite(n) ? n / 100 : null; };
    if (s.kind === 'furniture') {
      const f = sel.f;
      switch (k) {
        case 'name': f.name = String(v).trim() || typeName(f.type); break;
        case 'type': { const def = !f.name || f.name === typeName(f.type); f.type = v; f.color = typeColor(v); if (def) f.name = typeName(v); f.verified = true; break; }
        case 'shape':
          f.shape = v;
          if (v === 'L') { f.aw = f.aw || Math.min(0.9, f.w / 2); f.ad = f.ad || Math.min(0.9, f.d / 2); }
          if (v === 'cylinder') { f.d = f.w; }
          break;
        case 'w': case 'd': case 'h': case 'aw': case 'ad': { const n = m(v); if (n && n > 0) f[k] = n; break; }
        case 'x': case 'z': { const n = m(v); if (n !== null) f[k] = n; break; }
        case 'y': { const n = m(v); if (n !== null) f.y = Math.max(0, n); break; }
        case 'rotDeg': { const n = parseFloat(v); if (isFinite(n)) f.rot = normalizeAngle(rad(n)); break; }
        case 'color': f.color = v; break;
        case 'hidden': f.hidden = v; break;
        case 'verified': f.verified = v; break;
        case 'notes': f.notes = v; break;
        default: return;
      }
    } else if (s.kind === 'edge') {
      if (k === 'edgeLen') {
        const n = m(v);
        if (n && n > 0.05) sel.room.outline = setEdgeLength(sel.room.outline, s.index, n);
      }
    } else if (s.kind === 'vertex') {
      const n = m(v);
      if (n !== null) sel.room.outline[s.index][k === 'vx' ? 0 : 1] = n;
    } else if (s.kind === 'opening') {
      const op = sel.op;
      const n = m(v);
      if (k === 'opType') { op.type = v; if (v === 'window') { op.swing = 'none'; if (!op.sill) op.sill = 0.85; } else { op.sill = 0; op.swing = 'in'; } }
      else if (k === 'opSwing') op.swing = v;
      else if (n !== null) {
        if (k === 'opOffset') op.offset = Math.max(0, n);
        if (k === 'opWidth' && n > 0.1) op.width = n;
        if (k === 'opHeight' && n > 0.1) op.height = n;
        if (k === 'opSill') op.sill = Math.max(0, n);
      }
    } else if (s.kind === 'room') {
      const room = sel.room;
      if (k === 'roomName') room.name = String(v).trim() || 'Pokój';
      else if (k === 'roomHeight') { const n = m(v); if (n && n > 1.5) room.height = n; }
      else if (k === 'rtx') { const n = m(v); if (n !== null) room.transform.x = n; }
      else if (k === 'rtz') { const n = m(v); if (n !== null) room.transform.z = n; }
      else if (k === 'rtrot') { const n = parseFloat(v); if (isFinite(n)) room.transform.rot = normalizeAngle(rad(n)); }
    }
    this.lastPropsKey = null;
    this.commit();
  }

  onPropClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const s = this.selection;
    const sel = this.selected();
    if (!sel) return;
    switch (act) {
      case 'rot': this.rotateSelected(rad(+b.dataset.v)); break;
      case 'alignWall': sel.f.rot = alignRotationToNearestWall(sel.room, sel.f); this.commit(); break;
      case 'snapWall': {
        const r = snapToWalls(sel.room, sel.f, 0.3);
        if (r) { sel.f.x = r.x; sel.f.z = r.z; this.commit(); } else this.toast('Brak równoległej ściany w odległości do 30 cm. Najpierw użyj „Wyrównaj do ściany”.');
        break;
      }
      case 'dup': this.duplicateSelected(); break;
      case 'merge': this.mergeSelected(); break;
      case 'mergeHint': this.toast('Przytrzymaj Shift lub Ctrl i kliknij drugą bryłę (na widoku albo na liście), potem „Scal w jeden mebel”.'); break;
      case 'clearExtra': this.extra.clear(); this.refresh(); break;
      case 'resetScan': Object.assign(sel.f, sel.f.scanned); this.commit(); break;
      case 'del': this.deleteSelected(); break;
      case 'edgeShift': {
        const n = parseFloat(document.getElementById('edge-shift').value);
        if (isFinite(n) && n !== 0) { sel.room.outline = moveEdge(sel.room.outline, s.index, n / 100); this.commit(); }
        break;
      }
      case 'addDoor': this.addOpening('door'); break;
      case 'addWindow': this.addOpening('window'); break;
      case 'split': this.splitSelectedEdge(); break;
      case 'roomRot': {
        // obrót wokół środka pokoju
        const room = sel.room;
        const c = polygonCentroid(room.outline);
        const before = roomToWorld(room, c);
        room.transform.rot = normalizeAngle(room.transform.rot + rad(+b.dataset.v));
        const after = roomToWorld(room, c);
        room.transform.x += before[0] - after[0];
        room.transform.z += before[1] - after[1];
        this.commit();
        break;
      }
      default: break;
    }
  }
}

export { localToWorld, worldToLocal, snapshotScanned };
