// Paczka dla AI: wszystko, czego model AI potrzebuje, żeby zrobić dokładniejszą makietę albo wizualizację.
// - README_dla_AI.md: opis i polecenie (co jest w paczce, układ współrzędnych, lista mebli i zdjęć),
// - scena.json: dane maszynowe (pokoje, drzwi, okna, meble z wymiarami i położeniem, kamery zdjęć),
// - rzuty/: plan z góry i widok 3D makiety,
// - kamery/: każde zdjęcie pomieszczenia + render makiety z dokładnie tej samej pozycji i kąta,
// - meble/: zdjęcia przypięte do mebli (także mebli, których jeszcze nie ma w mieszkaniu),
// - model.glb, projekt.hause.json.
import * as THREE from 'three';
import { makeZip, dataURLToBytes } from './zip.js';
import { roomToWorld, polygonArea, openingSegment, normalizeAngle, deg } from './geometry.js';
import { projectToJSON, activeVariant } from './model.js';
import { typeName } from './labels.js';
import { download, safeName } from './editor.js';

const r2 = (v) => Math.round(v * 100) / 100;
const cmi = (v) => Math.round(v * 100);

function slug(s) {
  return safeName(s).slice(0, 40) || 'x';
}

/** Render sceny edytora do PNG o zadanych wymiarach (bez zmiany układu strony). */
function renderShot(editor, camera, w, h) {
  const r = editor.renderer;
  r.setScissorTest(false);
  r.setSize(w, h, false);
  r.setViewport(0, 0, w, h);
  if (camera.isPerspectiveCamera) camera.aspect = w / h;
  camera.updateProjectionMatrix();
  r.render(editor.scene, camera);
  return dataURLToBytes(r.domElement.toDataURL('image/png'));
}

function sceneData(project) {
  const media = project.media || {};
  const rooms = project.rooms.map((room) => ({
    id: room.id,
    name: room.name,
    areaM2: r2(Math.abs(polygonArea(room.outline))),
    heightM: r2(room.height),
    outline: room.outline.map((p) => roomToWorld(room, p).map(r2)),
    openings: (room.openings || []).map((op) => {
      const { p0, p1 } = openingSegment(room.outline, op);
      return {
        type: op.type === 'door' ? 'drzwi' : 'okno',
        widthM: r2(op.width), heightM: r2(op.height), sillM: r2(op.sill || 0),
        from: roomToWorld(room, p0).map(r2), to: roomToWorld(room, p1).map(r2),
        swing: op.type === 'door' ? op.swing : undefined,
        linkedRoom: op.link ? (project.rooms.find((r) => r.id === op.link.roomId) || {}).name : undefined,
      };
    }),
  }));
  const furniture = [];
  const photoFiles = [];
  let n = 0;
  for (const room of project.rooms) {
    for (const f of room.furniture) {
      n++;
      const [x, z] = roomToWorld(room, [f.x, f.z]);
      const photos = (f.photos || []).filter((id) => media[id]).map((id, k) => {
        const file = `meble/${String(n).padStart(2, '0')}_${slug(f.name)}_${k + 1}.jpg`;
        photoFiles.push({ file, id });
        return file;
      });
      furniture.push({
        nr: n,
        id: f.id,
        name: f.name,
        type: f.type,
        typeName: typeName(f.type),
        room: room.name,
        status: f.scanned ? 'jest w mieszkaniu (ze skanu)' : 'nowy / planowany (nie ze skanu)',
        hidden: !!f.hidden,
        center: { x: r2(x), z: r2(z) },
        bottomM: r2(f.y || 0),
        rotationDeg: Math.round(deg(normalizeAngle((f.rot || 0) + (room.transform.rot || 0)))),
        sizeCm: { width: cmi(f.w), depth: cmi(f.d), height: cmi(f.h) },
        shape: f.shape,
        parts: f.shape === 'compound' ? f.parts.map((p) => ({ shape: p.shape, x: r2(p.x), z: r2(p.z), y: r2(p.y || 0), rotationDeg: Math.round(deg(p.rot || 0)), sizeCm: { width: cmi(p.w), depth: cmi(p.d), height: cmi(p.h) } })) : undefined,
        color: f.color,
        notes: f.notes || undefined,
        link: f.link || undefined,
        photos,
      });
    }
  }
  const cameras = (project.cameras || []).map((c, i) => {
    const base = `kamery/${String(i + 1).padStart(2, '0')}_${slug(c.name)}`;
    return {
      nr: i + 1,
      id: c.id,
      name: c.name,
      photo: c.mediaId && media[c.mediaId] ? `${base}_zdjecie.jpg` : null,
      render: `${base}_makieta.png`,
      position: c.pos.map(r2),
      lookAt: c.target.map(r2),
      verticalFovDeg: c.fov,
      aspect: r2(c.aspect || 4 / 3),
      notes: c.notes || undefined,
    };
  });
  return { rooms, furniture, cameras, photoFiles };
}

function readme(project, data, variantName) {
  const furnRows = data.furniture.filter((f) => !f.hidden).map((f) =>
    `| ${f.nr} | ${f.name} (${f.typeName}) | ${f.room} | ${f.sizeCm.width}×${f.sizeCm.depth}×${f.sizeCm.height} | x ${f.center.x}, z ${f.center.z}${f.bottomM ? `, ${cmi(f.bottomM)} cm nad podłogą` : ''}, obrót ${f.rotationDeg}° | ${f.status}${f.shape === 'compound' ? ', kształt złożony' : ''} | ${f.photos.join(', ') || '—'} | ${[f.notes, f.link].filter(Boolean).join(' · ') || ''} |`).join('\n');
  const camRows = data.cameras.map((c) =>
    `| ${c.nr} | ${c.name} | ${c.photo || '—'} | ${c.render} | (${c.position.join(', ')}) → (${c.lookAt.join(', ')}) | ${c.verticalFovDeg}° | ${c.notes || ''} |`).join('\n');
  const roomRows = data.rooms.map((r) =>
    `| ${r.name} | ${r.areaM2} m² | ${cmi(r.heightM)} cm | ${r.openings.filter((o) => o.type === 'drzwi').length} drzwi, ${r.openings.filter((o) => o.type === 'okno').length} okien |`).join('\n');
  return `# Paczka dla AI — ${project.name}

Wersja układu mebli: **${variantName}**. Wygenerowano: ${new Date().toLocaleString('pl-PL')} (Hause Scanner).

## Zadanie (polecenie dla AI)

Na podstawie tej paczki przygotuj **dokładniejszą makietę 3D albo realistyczną wizualizację** mieszkania.

- Bryły w makiecie (\`model.glb\`, \`rzuty/\`, \`kamery/*_makieta.png\`) pokazują **gdzie** stoi każdy mebel i **jak duży** jest. Wymiary są w centymetrach i są wiarygodne.
- Zdjęcia (\`kamery/*_zdjecie.jpg\`, \`meble/*.jpg\`) pokazują, **jak** meble i pomieszczenia naprawdę wyglądają: kolory, materiały, kształty.
- Dla każdego zdjęcia pomieszczenia jest **render makiety z dokładnie tej samej pozycji, kierunku i kąta widzenia** (\`*_makieta.png\`). Porównaj parę „zdjęcie ↔ render”, żeby przypisać wygląd do brył.
- Meble ze statusem „nowy / planowany” jeszcze nie stoją w mieszkaniu. Ich wygląd pokazują zdjęcia w \`meble/\` (np. ze sklepu), a położenie bryła.
- Zachowaj położenie i wymiary z makiety. Nie przesuwaj mebli, chyba że ktoś o to poprosi.

*(EN: Use box positions/dimensions from the mock-up and appearance from the photos; each room photo has a mock-up render from the identical camera pose. Keep positions and sizes.)*

## Układ współrzędnych

- Jednostki: metry (wymiary mebli w tabeli: centymetry). Podłoga: y = 0, oś Y w górę.
- Plan leży w płaszczyźnie X–Z. Na \`rzuty/plan_z_gory.png\` oś X biegnie w prawo, a oś Z w dół obrazka.
- \`center\` to środek mebla na planie, \`rotationDeg\` to obrót wokół osi pionowej (0° = szerokość wzdłuż osi X).
- Kamery: \`position\` to miejsce aparatu, \`lookAt\` to punkt, w który patrzy, a \`verticalFovDeg\` to pionowy kąt widzenia.

## Pomieszczenia

| Pokój | Powierzchnia | Wysokość | Otwory |
|---|---|---|---|
${roomRows}

## Meble

| Nr | Mebel | Pokój | Wymiary (szer×gł×wys, cm) | Położenie | Status | Zdjęcia | Uwagi / link |
|---|---|---|---|---|---|---|---|
${furnRows || '| — | brak | | | | | | |'}

## Zdjęcia z perspektywą (kamery)

| Nr | Nazwa | Zdjęcie | Render makiety z tej pozycji | Pozycja → kierunek | Kąt | Opis |
|---|---|---|---|---|---|---|
${camRows || '| — | brak zdjęć z kamerą | | | | | |'}

## Pliki

- \`scena.json\`: wszystko powyżej w formie danych (dokładne obrysy pokoi, drzwi, okna, części mebli złożonych).
- \`rzuty/plan_z_gory.png\`, \`rzuty/widok_3d.png\`: podgląd makiety.
- \`model.glb\`: model 3D makiety (Blender, przeglądarki 3D).
- \`projekt.hause.json\`: pełny projekt do ponownego wczytania w Hause Scanner (bez zdjęć).
`;
}

export async function exportAIPackage(editor) {
  const project = editor.project;
  const media = project.media || {};
  const files = [];
  const data = sceneData(project);
  const variant = activeVariant(project);

  // --- rendery makiety ---
  const prevOpts = { ...editor.view3d.options };
  editor.view3d.setOptions({ wallMode: 'full', showGhosts: false, showZones: false, showLabels: false, selection: null, selectedId: null, selectedIds: new Set(), showCameras: false });
  editor.view3d.rebuild(project);
  editor.overlay.visible = false;
  try {
    // plan z góry
    const box = new THREE.Box3();
    for (const room of project.rooms) for (const p of room.outline) { const w = roomToWorld(room, p); box.expandByPoint(new THREE.Vector3(w[0], 0, w[1])); }
    if (box.isEmpty()) box.set(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 0, 3));
    box.expandByScalar(0.5);
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const aspect = size.x / Math.max(size.z, 0.1);
    let W = 1600, Hc = Math.round(1600 / aspect);
    if (Hc > 2400) { Hc = 2400; W = Math.round(2400 * aspect); }
    const ortho = new THREE.OrthographicCamera(-size.x / 2, size.x / 2, size.z / 2, -size.z / 2, 0.1, 100);
    ortho.position.set(c.x, 50, c.z);
    ortho.up.set(0, 0, -1);
    ortho.lookAt(c.x, 0, c.z);
    files.push({ name: 'rzuty/plan_z_gory.png', data: renderShot(editor, ortho, W, Hc) });
    // widok 3D
    const persp = new THREE.PerspectiveCamera(45, 4 / 3, 0.05, 200);
    const rr = Math.max(size.x, size.z, 3);
    persp.position.set(c.x + rr * 0.45, rr * 1.0, c.z + rr * 0.95);
    persp.lookAt(c);
    files.push({ name: 'rzuty/widok_3d.png', data: renderShot(editor, persp, 1600, 1200) });
    // render z pozycji każdej kamery (te same proporcje co zdjęcie)
    for (const cam of data.cameras) {
      const src = project.cameras.find((x) => x.id === cam.id);
      const pc = new THREE.PerspectiveCamera(src.fov || 55, src.aspect || 4 / 3, 0.02, 200);
      pc.position.set(...src.pos);
      pc.lookAt(new THREE.Vector3(...src.target));
      const w = 1280, h = Math.round(1280 / (src.aspect || 4 / 3));
      files.push({ name: cam.render, data: renderShot(editor, pc, w, h) });
      if (cam.photo) files.push({ name: cam.photo, data: dataURLToBytes(media[src.mediaId].data) });
    }
  } finally {
    editor.overlay.visible = true;
    editor.view3d.setOptions(prevOpts);
    editor.resize();
    editor.refresh();
  }

  // --- zdjęcia mebli ---
  for (const pf of data.photoFiles) files.push({ name: pf.file, data: dataURLToBytes(media[pf.id].data) });

  // --- dane ---
  const scene = {
    format: 'hause-scanner/ai-package',
    version: 1,
    project: project.name,
    variant: variant.name,
    variants: (project.variants || []).map((v) => v.name),
    units: 'm (sizeCm w centymetrach)',
    coordinateSystem: 'Y w górę, podłoga y=0, plan w X–Z; rotationDeg wokół osi Y (0° = szerokość wzdłuż X)',
    rooms: data.rooms,
    furniture: data.furniture,
    cameras: data.cameras,
  };
  files.push({ name: 'scena.json', data: JSON.stringify(scene, null, 2) });
  const pj = projectToJSON({ ...project, media: undefined }, { includeMesh: false });
  delete pj.media;
  files.push({ name: 'projekt.hause.json', data: JSON.stringify(pj) });
  try {
    files.push({ name: 'model.glb', data: new Uint8Array(await editor.buildGLB()) });
  } catch (e) {
    console.warn('GLB pominięty:', e);
  }
  files.unshift({ name: 'README_dla_AI.md', data: readme(project, data, variant.name) });

  const zip = makeZip(files);
  download(new Blob([zip], { type: 'application/zip' }), `${safeName(project.name)}_paczka_AI.zip`);
  editor.toast(`Paczka dla AI gotowa: ${files.length} plików (${(zip.length / 1048576).toFixed(1)} MB).`);
  return { files: files.map((f) => f.name), size: zip.length };
}
