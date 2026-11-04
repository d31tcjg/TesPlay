import type { PlayerSnapshot } from '@canvas-stream-player/contracts';

import { EngineFault } from './errors.js';
import { computeVideoLayout } from './geometry.js';

const MAX_CANVAS_PIXELS = 8_294_400;

type CanvasView = Pick<PlayerSnapshot, 'rotationDegrees' | 'aspectMode'>;

export interface CanvasSample {
  readonly displayWidth: number;
  readonly displayHeight: number;
  draw(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Owns one raster copy for paused redraws, never the decoded frame itself. */
export class CanvasRenderer {
  private readonly context: CanvasRenderingContext2D;
  private picture: {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    displayWidth: number;
    displayHeight: number;
  } | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!context)
      throw new EngineFault('DEMUX_FAILED', 'Canvas 2D rendering is unavailable');
    this.context = context;
  }

  drawSample(sample: CanvasSample, view: CanvasView): void {
    if (this.picture === null) {
      const document = (this.canvas as Partial<Pick<HTMLCanvasElement, 'ownerDocument'>>)
        .ownerDocument;
      const buffer = document?.createElement('canvas');
      const context = buffer?.getContext('2d', { alpha: false });
      if (buffer && context)
        this.picture = {
          canvas: buffer,
          context,
          displayWidth: sample.displayWidth,
          displayHeight: sample.displayHeight,
        };
    }
    const picture = this.picture;
    if (picture === null) {
      this.paintSample(sample, view);
      return;
    }
    // One bounded raster copy supports paused redraws without retaining a
    // decoded frame or a decoder admission credit after presentation.
    const scale = Math.min(
      1,
      4096 / sample.displayWidth,
      4096 / sample.displayHeight,
      Math.sqrt(MAX_CANVAS_PIXELS / (sample.displayWidth * sample.displayHeight)),
    );
    const width = Math.max(1, Math.floor(sample.displayWidth * scale));
    const height = Math.max(1, Math.floor(sample.displayHeight * scale));
    if (picture.canvas.width !== width) picture.canvas.width = width;
    if (picture.canvas.height !== height) picture.canvas.height = height;
    picture.displayWidth = sample.displayWidth;
    picture.displayHeight = sample.displayHeight;
    picture.context.fillStyle = '#000';
    picture.context.fillRect(0, 0, width, height);
    sample.draw(picture.context, 0, 0, width, height);
    this.redrawPicture(view);
  }

  redrawPicture(view: CanvasView): void {
    const picture = this.picture;
    if (picture === null) return;
    this.paintSample(
      {
        displayWidth: picture.displayWidth,
        displayHeight: picture.displayHeight,
        draw: (context, x, y, width, height) => {
          context.drawImage(picture.canvas, x, y, width, height);
        },
      },
      view,
    );
  }

  clearPicture(): void {
    if (this.picture !== null) {
      this.picture.canvas.width = 0;
      this.picture.canvas.height = 0;
      this.picture = null;
    }
    this.context.save();
    this.context.fillStyle = '#000';
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.restore();
  }

  private paintSample(sample: CanvasSample, view: CanvasView): void {
    const dpr = clamp(globalThis.devicePixelRatio || 1, 1, 4);
    const cssWidth = Math.max(1, this.canvas.clientWidth || sample.displayWidth);
    const cssHeight = Math.max(1, this.canvas.clientHeight || sample.displayHeight);
    const scaleLimit = Math.min(
      dpr,
      Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight)),
    );
    const width = Math.max(1, Math.round(cssWidth * scaleLimit));
    const height = Math.max(1, Math.round(cssHeight * scaleLimit));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const layout = computeVideoLayout(
      sample.displayWidth,
      sample.displayHeight,
      width,
      height,
      view.rotationDegrees,
      view.aspectMode ?? 'fit',
    );
    this.context.save();
    this.context.fillStyle = '#000';
    this.context.fillRect(0, 0, width, height);
    this.context.translate(width / 2, height / 2);
    this.context.rotate((view.rotationDegrees * Math.PI) / 180);
    sample.draw(
      this.context,
      -layout.drawWidth / 2,
      -layout.drawHeight / 2,
      layout.drawWidth,
      layout.drawHeight,
    );
    this.context.restore();
  }
}
