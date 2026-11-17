// Odczyt danych sceny (Space Setup) z XRFrame: płaszczyzny i siatki z etykietami semantycznymi.

/** Zwraca dane w formacie oczekiwanym przez convertScene(). */
export function captureScene(frame, refSpace) {
  const planes = [];
  const meshes = [];
  if (frame.detectedPlanes) {
    for (const plane of frame.detectedPlanes) {
      const pose = frame.getPose(plane.planeSpace, refSpace);
      if (!pose) continue;
      planes.push({
        label: plane.semanticLabel || plane.orientation || 'other',
        matrix: Array.from(pose.transform.matrix),
        polygon: Array.from(plane.polygon || [], (p) => [p.x, p.y, p.z]),
      });
    }
  }
  if (frame.detectedMeshes) {
    for (const mesh of frame.detectedMeshes) {
      const pose = frame.getPose(mesh.meshSpace, refSpace);
      if (!pose) continue;
      meshes.push({
        label: mesh.semanticLabel || 'other',
        matrix: Array.from(pose.transform.matrix),
        vertices: new Float32Array(mesh.vertices),
        indices: new Uint32Array(mesh.indices),
      });
    }
  }
  return { planes, meshes };
}

export function sceneStats(frame) {
  let planes = 0, meshes = 0, floors = 0, walls = 0, furniture = 0;
  if (frame.detectedPlanes) for (const p of frame.detectedPlanes) {
    planes++;
    const l = String(p.semanticLabel || '').toLowerCase();
    if (l === 'floor') floors++;
    if (l.startsWith('wall') && l !== 'wall art') walls++;
  }
  if (frame.detectedMeshes) for (const m of frame.detectedMeshes) {
    meshes++;
    const l = String(m.semanticLabel || '').toLowerCase().replace(/_/g, ' ');
    if (l !== 'global mesh') furniture++;
  }
  return { planes, meshes, floors, walls, furniture };
}

/** Płaszczyzny podłogi z macierzami i polami (do wyrównania modelu w trybie MR). */
export function floorPlanes(frame, refSpace) {
  const out = [];
  if (!frame.detectedPlanes) return out;
  for (const plane of frame.detectedPlanes) {
    if (String(plane.semanticLabel || '').toLowerCase() !== 'floor') continue;
    const pose = frame.getPose(plane.planeSpace, refSpace);
    if (!pose) continue;
    const poly = Array.from(plane.polygon || [], (p) => [p.x, p.z]);
    let a = 0;
    for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
    out.push({ matrix: Array.from(pose.transform.matrix), area: Math.abs(a / 2) });
  }
  return out;
}
