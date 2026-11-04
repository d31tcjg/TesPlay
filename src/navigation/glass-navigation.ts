import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { advanceGlassMotion } from './glass-motion';
import type { GlassMotion } from './glass-motion';
import { GlassOptics } from './glass-optics';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

class GlassNavigation {
  private lens = document.createElement('span');
  private active: HTMLButtonElement | null = null;
  private candidate: HTMLButtonElement | null = null;
  private pointer: number | null = null;
  private startX = 0; private dragY = 0; private lastX = 0; private lastTime = 0; private pointerVelocity = 0;
  private frame = 0; private frameTime = 0; private initialized = false; private suppressClick = false;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private resize: ResizeObserver;
  private mutation: MutationObserver;
  private optics: GlassOptics;
  private state: GlassMotion = { x: 0, y: 0, targetX: 0, targetY: 0, velocityX: 0, velocityY: 0, lift: 0, liftVelocity: 0, pressed: false, dragging: false, holdUntil: 0 };

  constructor(private root: HTMLElement, private dock: boolean) {
    this.lens.className = 'glass-selection'; this.lens.setAttribute('aria-hidden', 'true');
    this.root.prepend(this.lens);
    this.optics = new GlassOptics(root, this.lens);
    this.resize = new ResizeObserver(() => this.sync()); this.resize.observe(root);
    this.mutation = new MutationObserver(() => this.sync());
    this.mutation.observe(root, { subtree: true, attributes: true, attributeFilter: ['data-glass-current', 'data-expanded', 'inert', 'aria-current', 'aria-expanded', 'aria-pressed'] });
    root.addEventListener('pointerdown', this.down);
    root.addEventListener('pointermove', this.move);
    root.addEventListener('pointerup', this.up);
    root.addEventListener('pointercancel', this.cancel);
    root.addEventListener('lostpointercapture', this.lostCapture);
    root.addEventListener('click', this.click, true);
    root.addEventListener('keydown', this.key);
    window.addEventListener('blur', this.cancel);
    this.reduced.addEventListener('change', this.preference);
    this.sync();
  }

  private buttons() {
    return [...this.root.querySelectorAll<HTMLButtonElement>('button[data-navigation-key]')].filter(button =>
      !button.closest('[inert]') && getComputedStyle(button).visibility !== 'hidden' && button.getBoundingClientRect().width > 0);
  }

  private position(button: HTMLButtonElement) {
    const r = button.getBoundingClientRect(), p = this.root.getBoundingClientRect();
    return { x: r.left - p.left + r.width / 2 - this.root.clientLeft, y: r.top - p.top + r.height / 2 - this.root.clientTop };
  }

  sync = () => {
    if (this.pointer !== null) return;
    const key = this.root.dataset.glassCurrent;
    const selected = this.buttons().find(button => button.dataset.navigationKey === key);
    if (!selected) {
      this.active = null; this.lens.hidden = true;
      this.clearPreview(); this.optics.invalidate(); return;
    }
    this.target(selected, false);
  };

  private target(button: HTMLButtonElement, feedback: boolean) {
    this.active = button; this.lens.hidden = false;
    const point = this.position(button);
    this.state.targetX = point.x; this.state.targetY = point.y;
    if (!this.initialized || this.reduced.matches) {
      this.state.x = point.x; this.state.y = point.y; this.initialized = true;
    }
    if (feedback) this.state.holdUntil = performance.now() + 130;
    this.run();
  }

  private paint() {
    if (!this.active) return;
    const lift = clamp(this.state.lift, 0, 1);
    const restingWidth = this.dock ? Math.min(86, this.active.getBoundingClientRect().width + 4) : 44;
    const restingHeight = this.dock ? 58 : 42;
    const width = restingWidth + (this.dock ? 108 - restingWidth : 10) * lift;
    const height = restingHeight + (this.dock ? 20 : 14) * lift;
    this.lens.style.width = `${width}px`; this.lens.style.height = `${height}px`;
    this.lens.style.setProperty('--lens-lift', String(lift));
    this.lens.dataset.lensState = lift > .015 ? 'moving' : 'settled';
    const stretch = Math.min(Math.abs(this.state.velocityX) / 16000, .035);
    this.lens.style.transform = `translate3d(${this.state.x - width / 2}px,${this.state.y - height / 2}px,0) scale(${1 + lift * .035 + stretch},${1 + lift * .025})`;
    this.optics.paint();
  }

  private run() {
    if (this.frame) return;
    this.frameTime = performance.now(); this.lens.style.willChange = 'transform';
    const tick = (now: number) => {
      const settled = advanceGlassMotion(this.state, (now - this.frameTime) / 1000, now, this.reduced.matches);
      this.frameTime = now; this.paint();
      if (!settled) this.frame = requestAnimationFrame(tick);
      else { this.frame = 0; this.state.dragging = false; this.lens.style.willChange = 'auto'; }
    };
    this.frame = requestAnimationFrame(tick);
  }

  private markPreview(button: HTMLButtonElement) {
    this.root.querySelectorAll<HTMLButtonElement>('button[data-navigation-key]').forEach(item => { item.dataset.glassPreview = String(item === button); });
  }
  private clearPreview() {
    this.root.querySelectorAll<HTMLButtonElement>('[data-glass-preview]').forEach(button => { delete button.dataset.glassPreview; });
  }

  private down = (event: PointerEvent) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('button[data-navigation-key]');
    if (!button || !this.buttons().includes(button)) return;
    this.pointer = event.pointerId; this.startX = this.lastX = event.clientX;
    this.lastTime = event.timeStamp; this.pointerVelocity = 0; this.suppressClick = false;
    this.state.pressed = true; this.state.dragging = false; this.candidate = button;
    this.root.dataset.pressed = 'true'; this.root.setPointerCapture(event.pointerId);
    this.markPreview(button); this.target(button, true);
    this.dragY = this.state.targetY;
  };
  private move = (event: PointerEvent) => {
    if (event.pointerId !== this.pointer) return;
    if (Math.abs(event.clientX - this.startX) > 6) this.state.dragging = true;
    if (!this.state.dragging) return;
    const choices = this.buttons().map(button => ({ button, ...this.position(button) })).filter(point => Math.abs(point.y - this.dragY) < 24).sort((a, b) => a.x - b.x);
    if (!choices.length) return;
    const rect = this.root.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left - this.root.clientLeft, choices[0].x, choices.at(-1)!.x);
    const nearest = choices.reduce((a, b) => Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a);
    this.candidate = nearest.button; this.active = nearest.button;
    this.state.targetX = x; this.state.targetY = nearest.y;
    const elapsed = event.timeStamp - this.lastTime;
    if (elapsed > 0) this.pointerVelocity = (event.clientX - this.lastX) / elapsed * 1000;
    this.lastX = event.clientX; this.lastTime = event.timeStamp;
    this.markPreview(nearest.button); this.run();
  };
  private up = (event: PointerEvent) => {
    if (event.pointerId !== this.pointer) return;
    const button = this.candidate, id = this.pointer;
    this.pointer = null; this.state.pressed = false; this.root.dataset.pressed = 'false';
    this.suppressClick = true;
    if (this.state.dragging) this.state.velocityX = clamp(this.pointerVelocity * .25, -700, 700);
    if (id !== null && this.root.hasPointerCapture(id)) this.root.releasePointerCapture(id);
    if (button) { this.target(button, true); button.focus({ preventScroll: true }); button.click(); }
    this.candidate = null; this.clearPreview(); this.run();
    queueMicrotask(this.sync);
  };
  private lostCapture = () => { if (this.pointer !== null) this.cancel(); };
  private cancel = () => {
    const id = this.pointer;
    this.pointer = null; this.candidate = null; this.state.pressed = false; this.state.dragging = false;
    this.root.dataset.pressed = 'false'; this.clearPreview();
    if (id !== null && this.root.hasPointerCapture(id)) this.root.releasePointerCapture(id);
    this.sync(); this.run();
  };
  private click = (event: MouseEvent) => {
    if (this.suppressClick && event.isTrusted && event.detail > 0) { event.preventDefault(); event.stopPropagation(); this.suppressClick = false; return; }
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('button[data-navigation-key]');
    if (button && this.buttons().includes(button)) this.target(button, true);
  };
  private key = (event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = this.buttons(); if (!buttons.length) return;
    event.preventDefault(); const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index].focus({ preventScroll: true }); buttons[index].click();
  };
  private preference = () => { this.run(); };

  destroy() {
    cancelAnimationFrame(this.frame); this.resize.disconnect(); this.mutation.disconnect();
    this.root.removeEventListener('pointerdown', this.down); this.root.removeEventListener('pointermove', this.move);
    this.root.removeEventListener('pointerup', this.up); this.root.removeEventListener('pointercancel', this.cancel);
    this.root.removeEventListener('lostpointercapture', this.lostCapture); this.root.removeEventListener('click', this.click, true);
    this.root.removeEventListener('keydown', this.key); window.removeEventListener('blur', this.cancel);
    this.reduced.removeEventListener('change', this.preference); this.optics.destroy(); this.clearPreview(); this.lens.remove();
  }
}

export function useGlassNavigation(ref: RefObject<HTMLElement | null>, current: string, expanded: boolean, dock = false) {
  const controller = useRef<GlassNavigation | null>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const instance = new GlassNavigation(ref.current, dock); controller.current = instance;
    return () => { instance.destroy(); controller.current = null; };
  }, [ref, dock]);
  useLayoutEffect(() => { controller.current?.sync(); }, [current, expanded]);
}
