import { GlassScene } from './glass-scene';
import type { GlassPatch } from './glass-scene';
import { glassFragment, glassVertex } from './glass-shaders';

const colors = ['#ffffff', '#ffb084'] as const;
type IconCache = Map<string, HTMLImageElement>;

function loadIcons(root: HTMLElement, cache: IconCache) {
  return Promise.all([...root.querySelectorAll<SVGSVGElement>('button svg')].flatMap(svg => colors.map(color => new Promise<void>(resolve => {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); clone.setAttribute('width', '48'); clone.setAttribute('height', '48');
    clone.removeAttribute('class'); clone.setAttribute('style', `color:${color};fill:none;stroke:${color}`);
    const image = new Image(); image.onload = () => { cache.set(svg.outerHTML + color, image); resolve(); }; image.onerror = () => resolve();
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  }))));
}

class GlassSurface {
  private canvas = document.createElement('canvas');
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private sceneTexture: WebGLTexture;
  private iconsTexture: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private ui = document.createElement('canvas');
  private valid = true;

  constructor(private element: HTMLElement, private root: HTMLElement, private lens: boolean, private icons: IconCache) {
    this.canvas.className = 'glass-optics'; this.canvas.setAttribute('aria-hidden', 'true');
    const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true });
    if (!gl) throw new Error('Optical backdrop is unavailable'); this.gl = gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type); if (!shader) throw new Error('No shader');
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); throw new Error('No optical shader'); }
      return shader;
    };
    const program = gl.createProgram(), buffer = gl.createBuffer(); if (!program || !buffer) throw new Error('No optical program');
    this.program = program; this.buffer = buffer;
    const vertex = compile(gl.VERTEX_SHADER, glassVertex), fragment = compile(gl.FRAGMENT_SHADER, glassFragment);
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('No optical program');
    gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPosition'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    ['uScene', 'uIcons', 'uResolution', 'uSize', 'uOrigin', 'uDocument', 'uScale', 'uIconsOrigin', 'uIconsSize', 'uDpr', 'uLens', 'uLift'].forEach(name => { this.uniforms[name] = gl.getUniformLocation(program, name); });
    const texture = (unit: number) => {
      const value = gl.createTexture(); if (!value) throw new Error('No optical texture');
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, value);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return value;
    };
    this.sceneTexture = texture(0); this.iconsTexture = texture(1); this.ui.width = this.ui.height = 1;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.ui);
    this.canvas.addEventListener('webglcontextlost', this.lost); element.prepend(this.canvas);
  }
  private lost = (event: Event) => { event.preventDefault(); this.valid = false; this.element.dataset.optics = 'fallback'; this.canvas.hidden = true; };

  upload(patch: GlassPatch) {
    if (!this.valid) return; const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, patch.canvas);
    this.element.dataset.optics = 'ready';
  }
  private drawIcons(rect: DOMRect) {
    const w = Math.max(1, Math.ceil(rect.width * 2)), h = Math.max(1, Math.ceil(rect.height * 2));
    if (this.ui.width !== w || this.ui.height !== h) { this.ui.width = w; this.ui.height = h; }
    const ctx = this.ui.getContext('2d'); if (!ctx) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
    this.root.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      const svg = button.querySelector('svg'); if (!svg || button.closest('[inert]') || getComputedStyle(button).visibility === 'hidden') return;
      const active = button.dataset.glassPreview !== undefined ? button.dataset.glassPreview === 'true' : button.dataset.navigationKey === this.root.dataset.glassCurrent;
      const color = active ? colors[1] : colors[0], icon = this.icons.get(svg.outerHTML + color), r = svg.getBoundingClientRect();
      if (icon) ctx.drawImage(icon, r.left - rect.left, r.top - rect.top, r.width, r.height);
      const label = button.querySelector<HTMLElement>('.navigation-label');
      if (label) {
        const lr = label.getBoundingClientRect(), style = getComputedStyle(label);
        ctx.fillStyle = color; ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label.textContent || '', lr.left - rect.left + lr.width / 2, lr.top - rect.top + lr.height / 2 + .3);
      }
    });
    const gl = this.gl; gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.iconsTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.ui);
  }
  paint(patch: GlassPatch) {
    if (!this.valid || this.element.hidden) return;
    const r = this.element.getBoundingClientRect(), bar = this.root.getBoundingClientRect();
    const actions = this.root.querySelector<HTMLElement>('.navigation-actions');
    const extra = actions && !actions.inert ? actions.getBoundingClientRect() : bar;
    const root = new DOMRect(Math.min(bar.left, extra.left), Math.min(bar.top, extra.top),
      Math.max(bar.right, extra.right) - Math.min(bar.left, extra.left), Math.max(bar.bottom, extra.bottom) - Math.min(bar.top, extra.top));
    const width = this.element.clientWidth, height = this.element.clientHeight; if (!width || !height) return;
    const dpr = Math.min(devicePixelRatio || 1, 2), w = Math.round(width * dpr), h = Math.round(height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    const gl = this.gl, u = this.uniforms; gl.useProgram(this.program); gl.viewport(0, 0, w, h);
    if (this.lens) this.drawIcons(root);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture); gl.uniform1i(u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.iconsTexture); gl.uniform1i(u.uIcons, 1);
    gl.uniform2f(u.uResolution, w, h); gl.uniform2f(u.uSize, width, height); gl.uniform1f(u.uDpr, dpr);
    gl.uniform2f(u.uOrigin, r.left - patch.left, r.top - patch.top); gl.uniform2f(u.uDocument, patch.width, patch.height);
    gl.uniform2f(u.uScale, r.width / width, r.height / height); gl.uniform1f(u.uLens, this.lens ? 1 : 0);
    gl.uniform1f(u.uLift, Number(this.element.style.getPropertyValue('--lens-lift')) || 0);
    gl.uniform2f(u.uIconsOrigin, root.left - patch.left, root.top - patch.top); gl.uniform2f(u.uIconsSize, root.width, root.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  destroy() {
    this.canvas.removeEventListener('webglcontextlost', this.lost);
    const gl = this.gl; gl.deleteTexture(this.sceneTexture); gl.deleteTexture(this.iconsTexture); gl.deleteBuffer(this.buffer); gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext(); this.canvas.remove(); delete this.element.dataset.optics;
  }
}

export class GlassOptics {
  private surfaces: GlassSurface[] = [];
  private icons: IconCache = new Map();
  private scene: GlassScene;
  private patch: GlassPatch | null = null;
  private dirty = true; private disposed = false; private frame = 0; private lastRect = '';
  private resize: ResizeObserver;
  private transparency = matchMedia('(prefers-reduced-transparency: reduce)');
  private contrast = matchMedia('(prefers-contrast: more)');
  constructor(private root: HTMLElement, private lens: HTMLElement) {
    this.scene = new GlassScene(root, this.invalidate);
    this.resize = new ResizeObserver(this.invalidate); this.resize.observe(root);
    const actions = root.querySelector('.navigation-actions'); if (actions) this.resize.observe(actions);
    window.addEventListener('scroll', this.invalidate, { passive: true, capture: true }); window.addEventListener('resize', this.invalidate);
    this.transparency.addEventListener('change', this.preference); this.contrast.addEventListener('change', this.preference);
    void this.initialize();
  }
  private async initialize() {
    if (this.transparency.matches || this.contrast.matches) return;
    await loadIcons(this.root, this.icons);
    if (this.disposed || this.surfaces.length || this.transparency.matches || this.contrast.matches) return;
    try { this.surfaces.push(new GlassSurface(this.root, this.root, false, this.icons)); this.surfaces.push(new GlassSurface(this.lens, this.root, true, this.icons)); this.invalidate(); }
    catch { this.surfaces.forEach(surface => surface.destroy()); this.surfaces = []; }
  }
  private preference = () => {
    this.surfaces.forEach(surface => surface.destroy()); this.surfaces = [];
    void this.initialize();
  };
  invalidate = () => { this.dirty = true; this.paint(); };
  paint = () => {
    if (this.disposed || this.frame || !this.surfaces.length) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0; const r = this.root.getBoundingClientRect(), key = [r.x, r.y, r.width, r.height].join(',');
      if (key !== this.lastRect) { this.lastRect = key; this.dirty = true; }
      try {
        if (this.dirty || !this.patch) { this.dirty = false; this.patch = this.scene.capture(); this.surfaces.forEach(surface => surface.upload(this.patch!)); }
        this.surfaces.forEach(surface => surface.paint(this.patch!));
      } catch { this.surfaces.forEach(surface => surface.destroy()); this.surfaces = []; }
    });
  };
  destroy() {
    this.disposed = true; cancelAnimationFrame(this.frame); this.resize.disconnect(); this.scene.destroy();
    window.removeEventListener('scroll', this.invalidate, true); window.removeEventListener('resize', this.invalidate);
    this.transparency.removeEventListener('change', this.preference); this.contrast.removeEventListener('change', this.preference);
    this.surfaces.forEach(surface => surface.destroy()); this.surfaces = []; this.icons.clear();
  }
}
