// Typy mebli i mapowanie etykiet semantycznych z Meta Quest (Space Setup / WebXR semanticLabel).

export const FURNITURE_TYPES = {
  table:    { name: 'Stół',            color: '#c8915a', size: [1.4, 0.8, 0.75] },
  desk:     { name: 'Biurko',          color: '#b07a4a', size: [1.2, 0.6, 0.75] },
  couch:    { name: 'Kanapa',          color: '#6c8ebf', size: [2.0, 0.9, 0.85] },
  armchair: { name: 'Fotel',           color: '#7f9fcf', size: [0.85, 0.85, 0.9] },
  chair:    { name: 'Krzesło',         color: '#a3845c', size: [0.45, 0.5, 0.9] },
  bed:      { name: 'Łóżko',           color: '#9b7fc4', size: [1.6, 2.0, 0.45] },
  wardrobe: { name: 'Szafa',           color: '#8d6e52', size: [1.0, 0.6, 2.0] },
  storage:  { name: 'Szafka / komoda', color: '#a07855', size: [1.0, 0.45, 0.85] },
  shelf:    { name: 'Regał',           color: '#94704f', size: [0.8, 0.3, 1.9] },
  screen:   { name: 'Telewizor / ekran', color: '#3a3f47', size: [1.2, 0.1, 0.7] },
  lamp:     { name: 'Lampa',           color: '#e8c547', size: [0.4, 0.4, 1.6] },
  plant:    { name: 'Roślina',         color: '#5fa35f', size: [0.4, 0.4, 1.0] },
  fridge:   { name: 'Lodówka',         color: '#d9dde3', size: [0.6, 0.65, 1.85] },
  washer:   { name: 'Pralka',          color: '#cfd6de', size: [0.6, 0.6, 0.85] },
  kitchen:  { name: 'Zabudowa kuchenna', color: '#b9a28a', size: [2.4, 0.6, 0.9] },
  rug:      { name: 'Dywan',           color: '#c9b79c', size: [2.0, 1.4, 0.01] },
  other:    { name: 'Inny przedmiot',  color: '#9aa0a6', size: [0.6, 0.6, 0.6] },
};

export const TYPE_KEYS = Object.keys(FURNITURE_TYPES);

/** Normalizuje etykietę z WebXR ("COUCH", "wall_art", "door frame") do postaci "couch", "wall art", "door frame". */
export function normalizeLabel(label) {
  return String(label || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

const STRUCTURE = new Set(['floor', 'ceiling', 'wall', 'wall face', 'invisible wall face', 'inner wall face', 'global mesh', 'wall art', 'door', 'door frame', 'window', 'window frame', 'opening']);

export function isStructureLabel(label) {
  return STRUCTURE.has(normalizeLabel(label));
}

export function isWallLabel(label) {
  const l = normalizeLabel(label);
  return l === 'wall' || l === 'wall face' || l === 'invisible wall face' || l === 'inner wall face';
}

export function isDoorLabel(label) {
  const l = normalizeLabel(label);
  return l === 'door' || l === 'door frame' || l === 'opening';
}

export function isWindowLabel(label) {
  const l = normalizeLabel(label);
  return l === 'window' || l === 'window frame';
}

/** Mapuje etykietę Questa na typ mebla w aplikacji. */
export function labelToType(label) {
  const l = normalizeLabel(label);
  switch (l) {
    case 'table': return 'table';
    case 'desk': return 'desk';
    case 'couch': case 'sofa': return 'couch';
    case 'chair': return 'chair';
    case 'bed': return 'bed';
    case 'storage': case 'cabinet': return 'storage';
    case 'shelf': case 'bookshelf': return 'shelf';
    case 'screen': case 'tv': return 'screen';
    case 'lamp': return 'lamp';
    case 'plant': return 'plant';
    default: return 'other';
  }
}

export function typeName(type) {
  return (FURNITURE_TYPES[type] || FURNITURE_TYPES.other).name;
}

export function typeColor(type) {
  return (FURNITURE_TYPES[type] || FURNITURE_TYPES.other).color;
}

/** Gotowe szablony do dodawania mebli w edytorze. */
export const TEMPLATES = [
  { key: 'wardrobe', type: 'wardrobe', shape: 'box', w: 1.0, d: 0.6, h: 2.0 },
  { key: 'bed160', name: 'Łóżko 160×200', type: 'bed', shape: 'box', w: 1.6, d: 2.0, h: 0.45 },
  { key: 'bed90', name: 'Łóżko 90×200', type: 'bed', shape: 'box', w: 0.9, d: 2.0, h: 0.45 },
  { key: 'couch', type: 'couch', shape: 'box', w: 2.0, d: 0.9, h: 0.85 },
  { key: 'couchL', name: 'Kanapa narożna', type: 'couch', shape: 'L', w: 2.5, d: 1.6, h: 0.85, aw: 0.9, ad: 0.9 },
  { key: 'armchair', type: 'armchair', shape: 'box', w: 0.85, d: 0.85, h: 0.9 },
  { key: 'table', type: 'table', shape: 'box', w: 1.4, d: 0.8, h: 0.75 },
  { key: 'tableRound', name: 'Stół okrągły', type: 'table', shape: 'cylinder', w: 1.0, d: 1.0, h: 0.75 },
  { key: 'chair', type: 'chair', shape: 'box', w: 0.45, d: 0.5, h: 0.9 },
  { key: 'desk', type: 'desk', shape: 'box', w: 1.2, d: 0.6, h: 0.75 },
  { key: 'deskL', name: 'Biurko narożne', type: 'desk', shape: 'L', w: 1.6, d: 1.2, h: 0.75, aw: 0.6, ad: 0.6 },
  { key: 'storage', type: 'storage', shape: 'box', w: 1.0, d: 0.45, h: 0.85 },
  { key: 'shelf', type: 'shelf', shape: 'box', w: 0.8, d: 0.3, h: 1.9 },
  { key: 'tvstand', name: 'Szafka RTV', type: 'storage', shape: 'box', w: 1.6, d: 0.4, h: 0.5 },
  { key: 'fridge', type: 'fridge', shape: 'box', w: 0.6, d: 0.65, h: 1.85 },
  { key: 'washer', type: 'washer', shape: 'box', w: 0.6, d: 0.6, h: 0.85 },
  { key: 'kitchen', type: 'kitchen', shape: 'box', w: 2.4, d: 0.6, h: 0.9 },
  { key: 'plant', type: 'plant', shape: 'cylinder', w: 0.4, d: 0.4, h: 1.0 },
  { key: 'box', name: 'Prostopadłościan', type: 'other', shape: 'box', w: 0.6, d: 0.6, h: 0.6 },
  { key: 'cyl', name: 'Walec', type: 'other', shape: 'cylinder', w: 0.5, d: 0.5, h: 0.6 },
];

/** Paleta kolorów mebli (PC i gogle). */
export const PALETTE = ['#c8915a', '#8d6e52', '#f2efe9', '#3a3f47', '#6c8ebf', '#9b7fc4', '#5fa35f', '#d9534f', '#e8c547', '#9aa0a6', '#b9a28a', '#2f6fde'];
