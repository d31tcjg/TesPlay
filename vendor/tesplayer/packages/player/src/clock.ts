export class MediaClock {
  private mediaSeconds = 0;
  private monotonicMs = 0;
  private contextSeconds: number | null = null;
  private running = false;
  private rate = 1;

  start(mediaSeconds: number, monotonicMs: number): void {
    this.mediaSeconds = mediaSeconds;
    this.monotonicMs = monotonicMs;
    this.contextSeconds = null;
    this.running = true;
  }

  anchorAudio(mediaSeconds: number, contextSeconds: number): void {
    this.mediaSeconds = mediaSeconds;
    this.contextSeconds = contextSeconds;
  }

  now(monotonicMs: number, contextSeconds?: number): number {
    if (!this.running) return this.mediaSeconds;
    if (this.contextSeconds !== null && contextSeconds !== undefined) {
      return Math.max(
        0,
        this.mediaSeconds + (contextSeconds - this.contextSeconds) * this.rate,
      );
    }
    return Math.max(
      0,
      this.mediaSeconds + ((monotonicMs - this.monotonicMs) / 1000) * this.rate,
    );
  }

  pause(monotonicMs: number, contextSeconds?: number): number {
    this.mediaSeconds = this.now(monotonicMs, contextSeconds);
    this.monotonicMs = monotonicMs;
    this.contextSeconds = null;
    this.running = false;
    return this.mediaSeconds;
  }

  seek(mediaSeconds: number, monotonicMs: number): void {
    this.mediaSeconds = Math.max(0, mediaSeconds);
    this.monotonicMs = monotonicMs;
    this.contextSeconds = null;
  }

  setRate(rate: number, monotonicMs: number, contextSeconds?: number): void {
    const current = this.now(monotonicMs, contextSeconds);
    this.mediaSeconds = current;
    this.monotonicMs = monotonicMs;
    this.contextSeconds = contextSeconds ?? null;
    this.rate = rate;
  }

  get playbackRate(): number {
    return this.rate;
  }
  get isAudioAnchored(): boolean {
    return this.contextSeconds !== null;
  }
}

export function presentationDelaySeconds(
  kind: 'audio' | 'video',
  signedAvOffsetMs: number,
): number {
  // Positive: audio leads, so delay video. Negative: delay audio.
  return kind === 'video'
    ? Math.max(0, signedAvOffsetMs) / 1000
    : Math.max(0, -signedAvOffsetMs) / 1000;
}
