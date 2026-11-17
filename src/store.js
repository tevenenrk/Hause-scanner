// Trwały zapis projektów w IndexedDB przeglądarki (osobno na Queście i na komputerze).
const DB_NAME = 'hause-scanner';
const STORE = 'projects';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function listProjects() {
  const all = await tx('readonly', (s) => s.getAll());
  return (all || [])
    .map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, rooms: p.rooms.length, furniture: p.rooms.reduce((n, r) => n + r.furniture.length, 0) }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function loadProject(id) {
  return tx('readonly', (s) => s.get(id));
}

export async function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  // structuredClone obsługuje Float32Array/Uint32Array siatek skanu
  return tx('readwrite', (s) => s.put(project));
}

export async function deleteProject(id) {
  return tx('readwrite', (s) => s.delete(id));
}

const LAST_KEY = 'hause-scanner:last-project';
export function rememberLastProject(id) { try { localStorage.setItem(LAST_KEY, id); } catch (e) { /* tryb prywatny */ } }
export function lastProjectId() { try { return localStorage.getItem(LAST_KEY); } catch (e) { return null; } }
