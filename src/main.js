// Punkt wejścia: ekran projektów, edytor, uruchamianie sesji XR.
import { Editor } from './editor.js';
import { XRApp, isARSupported, isVRSupported } from './xr/xrApp.js';
import { listProjects, loadProject, saveProject, deleteProject, rememberLastProject } from './store.js';
import { createProject, createDemoProject, projectFromJSON, uid } from './model.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 3500);
}

const state = { xrSupported: false, vrSupported: false, emulated: null, editor: null, xr: null };

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.has('emulate')) {
    try {
      const { env } = await (await import('./emulate.js')).setupEmulation(params.get('emulate'), { devUI: !params.has('nodevui') });
      state.emulated = env;
    } catch (e) {
      console.error(e);
      toast('Nie udało się uruchomić emulatora: ' + e.message, true);
    }
  }
  state.xrSupported = await isARSupported();
  state.vrSupported = await isVRSupported();
  $('xr-status').textContent = state.emulated
    ? `Emulator Quest 3 · pokój: ${state.emulated}`
    : state.xrSupported ? 'WebXR AR: dostępne ✓' : 'WebXR AR: niedostępne (edycja na PC)';
  $('xr-hint').innerHTML = state.xrSupported
    ? 'Gogle wykryte. Otwórz projekt i użyj <b>🥽 Skanuj pokój</b>. Najpierw wykonaj w Queście <b>Konfigurację przestrzeni</b> (Ustawienia → Środowisko fizyczne).'
    : 'Na komputerze możesz edytować projekty. Skanowanie działa w przeglądarce Meta Quest. Test bez gogli: dodaj <code>?emulate=office_small</code> do adresu strony.';

  state.editor = new Editor({
    toast,
    onStartXR: (mode, editor) => startXR(mode, editor),
    onProjectReplaced: () => {},
  });

  bindHome();
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', () => state.editor && state.editor.flushSave());
  await route();
  window.hause = { state, toast, startXR };
}

// ======================= routing =======================
async function route() {
  const m = location.hash.match(/^#\/p\/(.+)$/);
  if (m) {
    const project = await loadProject(decodeURIComponent(m[1]));
    if (!project) {
      toast('Nie znaleziono projektu.', true);
      location.hash = '#/';
      return;
    }
    showEditor(project);
  } else {
    await showHome();
  }
}

function showEditor(project) {
  $('home').hidden = true;
  $('topbar-project').hidden = false;
  rememberLastProject(project.id);
  state.editor.open(project, { xrSupported: state.xrSupported, vrSupported: state.vrSupported });
}

async function showHome() {
  if (state.editor) state.editor.close();
  $('topbar-project').hidden = true;
  $('home').hidden = false;
  const list = await listProjects();
  $('project-list').innerHTML = list.length
    ? list.map((p) => `
      <li>
        <span class="pname" data-open="${esc(p.id)}">${esc(p.name)}</span>
        <span class="meta">${p.rooms} pok. · ${p.furniture} mebli · ${new Date(p.updatedAt).toLocaleString('pl-PL')}</span>
        <button data-open="${esc(p.id)}" class="primary">Otwórz</button>
        <button data-del="${esc(p.id)}" class="danger" title="Usuń projekt">Usuń</button>
      </li>`).join('')
    : '<li class="hint">Brak projektów. Utwórz nowy albo otwórz demo.</li>';
}

function openProject(id) {
  location.hash = `#/p/${encodeURIComponent(id)}`;
}

function bindHome() {
  $('btn-new').addEventListener('click', async () => {
    const name = prompt('Nazwa projektu (np. „Mieszkanie”):', 'Moje mieszkanie');
    if (name === null) return;
    const p = createProject(name.trim() || 'Moje mieszkanie');
    await saveProject(p);
    openProject(p.id);
  });
  $('btn-demo').addEventListener('click', async () => {
    const p = createDemoProject();
    await saveProject(p);
    openProject(p.id);
  });
  $('file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const p = projectFromJSON(JSON.parse(await file.text()));
      if (await loadProject(p.id)) {
        if (!confirm('Projekt o tym identyfikatorze już istnieje. OK = zastąp go, Anuluj = zaimportuj jako kopię.')) {
          p.id = uid('prj');
          p.name += ' (import)';
        }
      }
      await saveProject(p);
      openProject(p.id);
    } catch (err) {
      toast('Nie udało się wczytać pliku: ' + err.message, true);
    }
  });
  $('project-list').addEventListener('click', async (e) => {
    const o = e.target.closest('[data-open]');
    if (o) return openProject(o.dataset.open);
    const d = e.target.closest('[data-del]');
    if (d && confirm('Usunąć projekt? Tej operacji nie można cofnąć.')) {
      await deleteProject(d.dataset.del);
      showHome();
    }
  });
}

// ======================= XR =======================
let xrSaveTimer = null;

function startXR(mode, editor) {
  if (state.xr) return;
  if (mode === 'vr' ? !state.vrSupported : !state.xrSupported) {
    toast('WebXR nie jest dostępne w tej przeglądarce. Otwórz stronę w przeglądarce Meta Quest.', true);
    return;
  }
  editor.flushSave();
  const project = editor.project;
  const sel = editor.selection;
  let roomId = sel && sel.roomId;
  if (!roomId && sel && sel.kind === 'furniture') {
    const r = project.rooms.find((x) => x.furniture.some((f) => f.id === sel.id));
    roomId = r && r.id;
  }
  if ((mode === 'edit' || mode === 'vr') && !project.rooms.length) {
    toast('Projekt nie ma jeszcze pokoi. Najpierw zeskanuj pokój.', true);
    return;
  }
  const app = new XRApp({
    project,
    mode,
    roomId,
    unbounded: !new URLSearchParams(location.search).has('bounded'),
    onSave: (p) => {
      clearTimeout(xrSaveTimer);
      xrSaveTimer = setTimeout(() => saveProject(p).catch((e) => console.error(e)), 800);
    },
    onExit: async (p) => {
      state.xr = null;
      clearTimeout(xrSaveTimer);
      try { await saveProject(p); } catch (e) { toast('Błąd zapisu: ' + e.message, true); }
      editor.project = p;
      editor.history.commit(p);
      editor.validateSelection();
      editor.refresh();
      editor.frameAll();
      toast('Zakończono sesję MR — zmiany zapisane.');
    },
  });
  state.xr = app;
  // requestSession musi zostać wywołane synchronicznie w obsłudze kliknięcia
  app.start().catch((e) => {
    state.xr = null;
    console.error(e);
    toast('Nie udało się uruchomić sesji MR: ' + e.message, true);
  });
}

init().catch((e) => {
  console.error(e);
  toast('Błąd uruchamiania: ' + e.message, true);
});
