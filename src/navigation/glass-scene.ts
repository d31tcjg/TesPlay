export type GlassPatch = { canvas: HTMLCanvasElement; left: number; top: number; width: number; height: number };
const intersects = (a: DOMRect | GlassPatch, b: DOMRect | GlassPatch) =>
  a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

function readableImage(image: HTMLImageElement) {
  try {
    const url = new URL(image.currentSrc || image.src, location.href);
    return url.origin === location.origin || ['data:', 'blob:'].includes(url.protocol) || image.crossOrigin === 'anonymous';
  } catch { return false; }
}

/** Paint only the small region behind a bar; never snapshot the page or media player. */
export class GlassScene {
  private canvas = document.createElement('canvas');
  private images = new Map<string, HTMLImageElement>();
  private observer: MutationObserver;
  private disposed = false;
  constructor(private root: HTMLElement, private dirty: () => void) {
    this.observer = new MutationObserver(records => {
      if (records.some(record => {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        return !element?.closest('.glass-navigation');
      })) dirty();
    });
    // Observe a stable shell: remote tabs replace their <main> when selected.
    const content = root.closest('.cinema-remote,.app-shell') || document.querySelector('main');
    if (content) this.observer.observe(content, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'style', 'class'] });
    document.addEventListener('load', this.loaded, true);
  }
  private loaded = (event: Event) => { if (event.target instanceof HTMLImageElement && !this.root.contains(event.target)) this.dirty(); };

  capture(): GlassPatch {
    const rect = this.root.getBoundingClientRect();
    const extra = this.root.querySelector<HTMLElement>('.navigation-actions');
    const additional = extra && !extra.inert && getComputedStyle(extra).visibility !== 'hidden' ? extra.getBoundingClientRect() : rect;
    const patch: GlassPatch = { canvas: this.canvas, left: Math.min(rect.left, additional.left) - 40,
      top: Math.min(rect.top, additional.top) - 40, width: Math.ceil(Math.max(rect.right, additional.right) - Math.min(rect.left, additional.left) + 80),
      height: Math.ceil(Math.max(rect.bottom, additional.bottom) - Math.min(rect.top, additional.top) + 80) };
    this.canvas.width = Math.max(1, patch.width); this.canvas.height = Math.max(1, patch.height);
    const ctx = this.canvas.getContext('2d'); if (!ctx) return patch;
    ctx.fillStyle = '#101012'; ctx.fillRect(0, 0, patch.width, patch.height);
    ctx.translate(-patch.left, -patch.top);
    this.hero(ctx, patch);
    const targets = new Set<HTMLElement>();
    for (const x of [.1, .35, .6, .9]) for (const y of [.15, .5, .85]) {
      const pointX = Math.max(0, Math.min(innerWidth - 1, patch.left + patch.width * x));
      const pointY = Math.max(0, Math.min(innerHeight - 1, patch.top + patch.height * y));
      for (const element of document.elementsFromPoint(pointX, pointY)) {
        if (!(element instanceof HTMLElement) || element.closest('.glass-navigation') || !element.closest('main')) continue;
        const container = element.closest<HTMLElement>('article,.service-card,.page-heading,.section-heading,.row-heading,.hero,.empty-state,.cinema-queue-item,.cinema-empty,.cinema-title,.remote-library-heading');
        if (container) targets.add(container);
      }
    }
    // Backgrounds first, then already-decoded artwork, then foreground labels.
    for (const target of targets) {
      if (target.matches('.hero')) continue;
      const r = target.getBoundingClientRect(), style = getComputedStyle(target);
      if (!intersects(r, patch) || style.backgroundColor === 'rgba(0, 0, 0, 0)') continue;
      ctx.save(); this.rounded(ctx, r, parseFloat(style.borderRadius) || 0);
      ctx.fillStyle = style.backgroundColor; ctx.fill(); ctx.restore();
    }
    document.querySelectorAll<HTMLImageElement>('main img').forEach(image => {
      if (!image.complete || !image.naturalWidth || !readableImage(image)) return;
      const r = image.getBoundingClientRect(); if (!intersects(r, patch)) return;
      const style = getComputedStyle(image); if (style.visibility === 'hidden') return;
      ctx.save(); this.rounded(ctx, r, parseFloat(style.borderRadius) || 0); ctx.clip();
      this.image(ctx, image, r, style.objectFit === 'contain' ? 'contain' : 'cover'); ctx.restore();
    });
    for (const target of targets) this.text(ctx, target, patch);
    return patch;
  }

  private image(ctx: CanvasRenderingContext2D, image: HTMLImageElement, rect: DOMRect, fit: 'cover' | 'contain', yPosition = .5) {
    const scale = (fit === 'cover' ? Math.max : Math.min)(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    ctx.drawImage(image, rect.left + (rect.width - width) / 2, rect.top + (rect.height - height) * yPosition, width, height);
  }
  private rounded(ctx: CanvasRenderingContext2D, rect: DOMRect, radius: number) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(rect.left, rect.top, rect.width, rect.height, radius);
    else ctx.rect(rect.left, rect.top, rect.width, rect.height);
  }
  private hero(ctx: CanvasRenderingContext2D, patch: GlassPatch) {
    const hero = document.querySelector<HTMLElement>('.hero'); if (!hero) return;
    const rect = hero.getBoundingClientRect(); if (!intersects(rect, patch)) return;
    const url = getComputedStyle(hero).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
    if (url) {
      let image = this.images.get(url);
      if (!image) {
        image = new Image(); image.decoding = 'async'; image.onload = () => { if (!this.disposed) this.dirty(); };
        image.src = url; this.images.set(url, image);
        if (this.images.size > 3) this.images.delete(this.images.keys().next().value!);
      }
      if (image.complete && image.naturalWidth && readableImage(image)) {
        ctx.save(); ctx.beginPath(); ctx.rect(rect.left, rect.top, rect.width, rect.height); ctx.clip(); this.image(ctx, image, rect, 'cover', .4);
        const horizontal = ctx.createLinearGradient(rect.left, 0, rect.right, 0);
        [[0, '#101012ef'], [.27, '#101012ab'], [.62, '#1010122b'], [1, '#1010120d']].forEach(([stop, color]) => horizontal.addColorStop(stop as number, color as string));
        ctx.fillStyle = horizontal; ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
        const vertical = ctx.createLinearGradient(0, rect.bottom, 0, rect.top);
        [[0, '#101012'], [.27, '#10101240'], [.65, '#10101200'], [1, '#10101210']].forEach(([stop, color]) => vertical.addColorStop(stop as number, color as string));
        ctx.fillStyle = vertical; ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
        const top = ctx.createLinearGradient(0, rect.top, 0, rect.top + 112); top.addColorStop(0, '#08090c9e'); top.addColorStop(1, '#08090c00');
        ctx.fillStyle = top; ctx.fillRect(rect.left, rect.top, rect.width, 112); ctx.restore();
      }
    }
  }
  private text(ctx: CanvasRenderingContext2D, target: HTMLElement, patch: GlassPatch) {
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT); let node: Node | null, count = 0;
    while ((node = walker.nextNode()) && count++ < 100) {
      if (!node.textContent?.trim() || !node.parentElement || node.parentElement.closest('svg,[hidden]')) continue;
      const range = document.createRange(); range.selectNodeContents(node); const rect = range.getBoundingClientRect();
      if (!rect.width || !intersects(rect, patch)) continue;
      const style = getComputedStyle(node.parentElement); if (style.visibility === 'hidden') continue;
      ctx.save(); ctx.beginPath(); ctx.rect(rect.left, rect.top, rect.width, rect.height); ctx.clip();
      ctx.fillStyle = style.color; ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`; ctx.textBaseline = 'top';
      ctx.fillText(node.textContent.trim(), rect.left, rect.top, rect.width); ctx.restore();
    }
  }
  destroy() {
    this.disposed = true; this.observer.disconnect(); document.removeEventListener('load', this.loaded, true);
    this.images.forEach(image => { image.onload = null; }); this.images.clear(); this.canvas.width = this.canvas.height = 1;
  }
}
