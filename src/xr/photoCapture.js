// Zdjęcia z kamer gogli w trakcie sesji MR (na podstawie projektu room-scanner).
// Dwie drogi, zależnie od tego, co udostępni przeglądarka Questa:
//  1. WebXR "camera-access": obraz kamery zgrany z widokiem — pozycja i obiektyw znane dokładnie.
//  2. getUserMedia: zwykły strumień z kamery; pozycja z gogli, kąt widzenia przybliżony.
// Zdjęcie = { data (JPEG data URL), w, h, matrix (kamera -> świat XR, 16 liczb), proj (16 liczb), mode, approx? }
import * as THREE from 'three';

const PHOTO_W = 1024;
export const DEFAULT_VIDEO_FOV_H = 80; // stopnie — przybliżenie dla getUserMedia

function flipToImageData(pixels, w, h) {
  const out = new ImageData(w, h);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.data.set(pixels.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return out;
}

/** Macierz projekcji z poziomego kąta widzenia (stopnie) i proporcji obrazu. */
export function projFromFov(fovH, aspect) {
  const fovY = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fovH) / 2) / aspect));
  const cam = new THREE.PerspectiveCamera(fovY, aspect, 0.05, 30);
  return Array.from(cam.projectionMatrix.elements);
}

/** Pionowy kąt widzenia (stopnie) z macierzy projekcji. */
export function fovYFromProj(proj) {
  return THREE.MathUtils.radToDeg(2 * Math.atan(1 / proj[5]));
}

export class PhotoCapture {
  constructor(renderer, session) {
    this.renderer = renderer;
    this.session = session;
    this.mode = null; // 'xr' | 'video' | null
    this.binding = null;
    this.video = null;
    this.stream = null;
    this.error = '';
    this.canvas = document.createElement('canvas');
    this._quad = null;
  }

  static viewHasCamera(pose) {
    return !!(pose && pose.views && pose.views[0] && pose.views[0].camera);
  }

  /** Wybiera sposób robienia zdjęć (pose — bieżąca pozycja widza, do sprawdzenia camera-access). */
  async start(pose) {
    if (this.mode) return true;
    if (PhotoCapture.viewHasCamera(pose) && typeof XRWebGLBinding !== 'undefined') {
      try {
        this.binding = new XRWebGLBinding(this.session, this.renderer.getContext());
        this.mode = 'xr';
        return true;
      } catch (err) {
        this.error = String((err && err.message) || err);
      }
    }
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('brak getUserMedia');
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: 'environment' },
        audio: false,
      });
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = this.stream;
      await video.play();
      this.video = video;
      this.mode = 'video';
      return true;
    } catch (err) {
      this.error = String((err && err.message) || err);
      return false;
    }
  }

  /** Robi zdjęcie — wywoływać w pętli klatki XR (pose z bieżącej klatki). */
  capture(pose) {
    if (!pose) return null;
    if (this.mode === 'xr') return this.captureXR(pose);
    if (this.mode === 'video') return this.captureVideo(pose);
    return null;
  }

  captureXR(pose) {
    const view = pose.views[0];
    if (!view || !view.camera) return null;
    const glTex = this.binding.getCameraImage(view.camera);
    if (!glTex) return null;
    const renderer = this.renderer;
    const w = PHOTO_W;
    const h = Math.max(1, Math.round((PHOTO_W * view.camera.height) / view.camera.width));
    if (!this._quad) {
      const tex = new THREE.Texture();
      const scene = new THREE.Scene();
      const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, depthTest: false });
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
      this._quad = { tex, scene, mat, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), rt: null };
    }
    const q = this._quad;
    if (!q.rt || q.rt.width !== w || q.rt.height !== h) {
      if (q.rt) q.rt.dispose();
      q.rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    }
    // tekstura kamery z WebXR podpięta pod obiekt three.js
    renderer.properties.get(q.tex).__webglTexture = glTex;
    const prevRT = renderer.getRenderTarget();
    const prevXR = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(q.rt);
    renderer.render(q.scene, q.cam);
    const pixels = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(q.rt, 0, 0, w, h, pixels);
    renderer.setRenderTarget(prevRT);
    renderer.xr.enabled = prevXR;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.getContext('2d').putImageData(flipToImageData(pixels, w, h), 0, 0);
    return {
      data: this.canvas.toDataURL('image/jpeg', 0.85), w, h,
      matrix: Array.from(view.transform.matrix), proj: Array.from(view.projectionMatrix), mode: 'xr',
    };
  }

  captureVideo(pose) {
    const v = this.video;
    if (!v || !v.videoWidth) return null;
    const w = PHOTO_W;
    const h = Math.round((PHOTO_W * v.videoHeight) / v.videoWidth);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.getContext('2d').drawImage(v, 0, 0, w, h);
    const approx = { fovH: DEFAULT_VIDEO_FOV_H, aspect: w / h };
    // pozycja: środek głowy (kamera jest kilka cm obok — przybliżenie)
    return {
      data: this.canvas.toDataURL('image/jpeg', 0.85), w, h,
      matrix: Array.from(pose.transform.matrix), proj: projFromFov(approx.fovH, approx.aspect), mode: 'video', approx,
    };
  }

  dispose() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this._quad) {
      if (this._quad.rt) this._quad.rt.dispose();
      this._quad.mat.dispose();
      this._quad.scene.children[0].geometry.dispose();
    }
    this.mode = null;
  }
}
