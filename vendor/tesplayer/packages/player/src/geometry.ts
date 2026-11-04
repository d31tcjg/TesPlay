import type { PlayerAspectMode } from '@canvas-stream-player/contracts';

export interface VideoLayout {
  readonly drawWidth: number;
  readonly drawHeight: number;
  readonly sourceWidthAfterRotation: number;
  readonly sourceHeightAfterRotation: number;
}

export function computeVideoLayout(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  rotation: 0 | 90 | 180 | 270,
  mode: PlayerAspectMode,
): VideoLayout {
  if (
    ![sourceWidth, sourceHeight, targetWidth, targetHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    throw new RangeError('Video layout dimensions must be finite and positive');
  const swap = rotation === 90 || rotation === 270;
  const rotatedWidth = swap ? sourceHeight : sourceWidth;
  const rotatedHeight = swap ? sourceWidth : sourceHeight;
  const containScale = Math.min(targetWidth / rotatedWidth, targetHeight / rotatedHeight);
  const coverScale = Math.max(targetWidth / rotatedWidth, targetHeight / rotatedHeight);
  const scale = mode === 'fill' ? coverScale : containScale;
  const visibleWidth = rotatedWidth * scale;
  const visibleHeight = rotatedHeight * scale;
  return {
    drawWidth: swap ? visibleHeight : visibleWidth,
    drawHeight: swap ? visibleWidth : visibleHeight,
    sourceWidthAfterRotation: visibleWidth,
    sourceHeightAfterRotation: visibleHeight,
  };
}
