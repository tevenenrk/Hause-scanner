// Prosty panel UI w 3D (canvas jako tekstura), obsługiwany promieniem kontrolera lub dłoni.
import * as THREE from 'three';

const PX_W = 1024;
const PAD = 28;
const ROW_H = 92;
const GAP = 14;
const LINE_H = 40;

export class Panel3D {
  constructor({ width = 0.36 } = {}) {
    this.widthM = width;
    this.canvas = document.createElement('canvas');
    this.canvas.width = PX_W;
    this.canvas.height = 600;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // panel zawsze na wierzchu (bez testu głębi), rysowany po etykietach
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.renderOrder = 100;
    this.mesh.userData.isPanel = true;
    this.page = { title: '', lines: [], rows: [] };
    this.buttons = [];
    this.hoverId = null;
    this.onAction = null;
  }

  /** page = { title, lines: [string], rows: [[{ id, label, style?: 'primary'|'danger'|'active'|'muted', disabled? }]] } */
  setPage(page) {
    this.page = page;
    this.layout();
    this.draw();
  }

  layout() {
    const ctx = this.ctx;
    const lines = [];
    ctx.font = '30px system-ui, sans-serif';
    for (const l of this.page.lines || []) lines.push(...this.wrap(l, PX_W - PAD * 2));
    this.wrapped = lines;
    let y = PAD + (this.page.title ? 56 : 0) + lines.length * LINE_H + (lines.length ? GAP : 0);
    this.buttons = [];
    for (const row of this.page.rows || []) {
      const n = row.length;
      const w = (PX_W - PAD * 2 - GAP * (n - 1)) / n;
      row.forEach((b, i) => this.buttons.push({ ...b, x: PAD + i * (w + GAP), y, w, h: ROW_H }));
      y += ROW_H + GAP;
    }
    const h = Math.max(160, Math.ceil(y + PAD - GAP));
    if (this.canvas.height !== h) {
      this.canvas.height = h;
      this.texture.dispose();
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.material.map = this.texture;
    }
    this.mesh.scale.set(this.widthM, this.widthM * (h / PX_W), 1);
  }

  wrap(text, maxW) {
    const words = String(text).split(' ');
    const out = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (this.ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t;
    }
    if (cur) out.push(cur);
    return out;
  }

  draw() {
    const ctx = this.ctx;
    const W = PX_W, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    roundRect(ctx, 0, 0, W, H, 36);
    ctx.fillStyle = 'rgba(20,24,30,0.92)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.stroke();
    let y = PAD;
    if (this.page.title) {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 40px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(this.page.title, PAD, y);
      y += 56;
    }
    ctx.font = '30px system-ui, sans-serif';
    ctx.fillStyle = '#c9d1db';
    ctx.textBaseline = 'top';
    for (const l of this.wrapped || []) { ctx.fillText(l, PAD, y); y += LINE_H; }
    for (const b of this.buttons) {
      const hover = b.id === this.hoverId && !b.disabled;
      const colors = {
        primary: ['#2f6fde', '#4a86f0'],
        danger: ['#7a2424', '#a33434'],
        active: ['#c99a00', '#e0b000'],
        muted: ['#2a3038', '#3a424d'],
      }[b.style] || ['#353d48', '#4a5563'];
      roundRect(ctx, b.x, b.y, b.w, b.h, 18);
      ctx.fillStyle = hover ? colors[1] : colors[0];
      ctx.globalAlpha = b.disabled ? 0.4 : 1;
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `${b.label.length > 16 ? 26 : 32}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1, b.w - 16);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    }
    this.texture.needsUpdate = true;
  }

  buttonAtUV(uv) {
    const x = uv.x * PX_W;
    const y = (1 - uv.y) * this.canvas.height;
    return this.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) || null;
  }

  setHover(id) {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.draw();
  }

  /** Zwraca true, jeśli trafiono przycisk. */
  click(uv) {
    const b = this.buttonAtUV(uv);
    if (b && !b.disabled && this.onAction) {
      this.onAction(b.id, b);
      return true;
    }
    return !!b;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Etykieta tekstowa (sprite) do pokazania nad meblem w MR. */
export function makeTextSprite(text, { color = '#ffffff', bg = 'rgba(0,0,0,0.7)', height = 0.06 } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = 'bold 48px system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 40;
  c.width = w;
  c.height = 72;
  ctx.font = 'bold 48px system-ui, sans-serif';
  ctx.fillStyle = bg;
  roundRect(ctx, 0, 0, w, 72, 20);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 20, 38);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(height * (w / 72), height, 1);
  s.renderOrder = 30;
  return s;
}
