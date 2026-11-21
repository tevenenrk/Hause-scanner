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

/** Czy obraz jest (prawie) całkiem czarny — wtedy zdjęcie się nie udało i trzeba spróbować ponownie. */
export function isBlackImage(canvas) {
  const w = 32, h = 24;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let sum = 0, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    sum += l;
    if (l > max) max = l;
  }
  return sum / (w * h) < 4 && max < 16;
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
    if (!this.noXR && PhotoCapture.viewHasCamera(pose) && typeof XRWebGLBinding !== 'undefined') {
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
      video.autoplay = true;
      // element w DOM (niewidoczny), żeby przeglądarka nie wstrzymywała klatek wideo
      Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
      document.body.appendChild(video);
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

  /** Przełącza na zwykłą kamerę (gdy WebXR camera-access daje czarny obraz). */
  async switchToVideo(pose) {
    this.noXR = true;
    this.binding = null;
    this.mode = null;
    return this.start(pose);
  }

  /**
   * Odczyt obrazu kamery WebXR bezpośrednio z tekstury (framebuffer + readPixels) — bez próbkowania,
   * więc nie zależy od filtrów tekstury (próbkowanie tekstury bez mipmap dawało czarny obraz).
   */
  readCameraTexture(glTex, cw, ch) {
    const gl = this.renderer.getContext();
    const fb = gl.createFramebuffer();
    let pixels = null;
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glTex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        pixels = new Uint8Array(cw * ch * 4);
        gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      }
    } catch (e) {
      pixels = null;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      this.renderer.resetState(); // three.js musi wiedzieć, że zmieniliśmy stan WebGL
    }
    return pixels;
  }

  captureXR(pose) {
    const view = pose.views[0];
    if (!view || !view.camera) return null;
    const glTex = this.binding.getCameraImage(view.camera);
    if (!glTex) return null;
    const renderer = this.renderer;
    const cw = view.camera.width, ch = view.camera.height;
    // 1) bezpośredni odczyt pełnej rozdzielczości
    const raw = this.readCameraTexture(glTex, cw, ch);
    if (raw) {
      const full = document.createElement('canvas');
      full.width = cw; full.height = ch;
      full.getContext('2d').putImageData(flipToImageData(raw, cw, ch), 0, 0);
      const w = Math.min(PHOTO_W, cw), h = Math.round((w * ch) / cw);
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.getContext('2d').drawImage(full, 0, 0, w, h);
      const black = isBlackImage(this.canvas);
      if (!black) {
        return {
          data: this.canvas.toDataURL('image/jpeg', 0.85), w, h,
          matrix: Array.from(view.transform.matrix), proj: Array.from(view.projectionMatrix), mode: 'xr',
        };
      }
    }
    // 2) zapasowo: narysowanie tekstury na prostokącie (z ustawionym filtrem bez mipmap)
    const w = PHOTO_W;
    const h = Math.max(1, Math.round((PHOTO_W * ch) / cw));
    try {
      const gl = renderer.getContext();
      gl.bindTexture(gl.TEXTURE_2D, glTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      renderer.resetState();
    } catch (e) { /* tekstura może być nieprzezroczysta (opaque) — wtedy zostaje odczyt wyżej */ }
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
      black: isBlackImage(this.canvas),
    };
  }

  captureVideo(pose) {
    const v = this.video;
    if (!v || !v.videoWidth || v.readyState < 2) return null; // brak jeszcze klatki obrazu
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
      black: isBlackImage(this.canvas),
    };
  }

  dispose() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.video) this.video.remove();
    if (this._quad) {
      if (this._quad.rt) this._quad.rt.dispose();
      this._quad.mat.dispose();
      this._quad.scene.children[0].geometry.dispose();
    }
    this.mode = null;
  }
}
