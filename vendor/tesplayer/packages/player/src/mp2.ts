import { MPEGDecoderWebWorker } from 'mpg123-decoder';

export type MpegAudioLayer = 1 | 2 | 3;

export interface MpegFrameInfo {
  readonly layer: MpegAudioLayer;
  readonly frameLength: number;
  readonly sampleRate: number;
  readonly bitrateKbps: number;
}

const MPEG1_BITRATES: Record<MpegAudioLayer, readonly number[]> = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};
const MPEG2_BITRATES: Record<MpegAudioLayer, readonly number[]> = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MPEG1_SAMPLE_RATES = [44_100, 48_000, 32_000] as const;

function parseHeader(data: Uint8Array, offset: number): MpegFrameInfo | null {
  const byte0 = data[offset];
  const byte1 = data[offset + 1];
  const byte2 = data[offset + 2];
  if (byte0 === undefined || byte1 === undefined || byte2 === undefined) return null;
  if (byte0 !== 0xff || (byte1 & 0xe0) !== 0xe0) return null;
  const versionBits = (byte1 >> 3) & 0x03;
  const layerBits = (byte1 >> 1) & 0x03;
  const bitrateIndex = (byte2 >> 4) & 0x0f;
  const sampleRateIndex = (byte2 >> 2) & 0x03;
  if (
    versionBits === 1 ||
    layerBits === 0 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3
  )
    return null;
  const layer = (4 - layerBits) as MpegAudioLayer;
  const baseSampleRate = MPEG1_SAMPLE_RATES[sampleRateIndex];
  if (baseSampleRate === undefined) return null;
  const sampleRate =
    versionBits === 3
      ? baseSampleRate
      : versionBits === 2
        ? baseSampleRate / 2
        : baseSampleRate / 4;
  const bitrateTable = versionBits === 3 ? MPEG1_BITRATES[layer] : MPEG2_BITRATES[layer];
  const bitrateKbps = bitrateTable[bitrateIndex];
  if (bitrateKbps === undefined || bitrateKbps === 0) return null;
  const padding = (byte2 >> 1) & 1;
  const coefficient = layer === 1 ? 12 : layer === 3 && versionBits !== 3 ? 72 : 144;
  const slotSize = layer === 1 ? 4 : 1;
  const frameLength =
    Math.floor((coefficient * bitrateKbps * 1000) / sampleRate + padding) * slotSize;
  if (frameLength < 4) return null;
  return { layer, frameLength, sampleRate, bitrateKbps };
}

export function inspectAlignedMpegAudioFrame(data: Uint8Array): MpegFrameInfo | null {
  const first = parseHeader(data, 0);
  if (!first || data.length < first.frameLength) return null;
  if (data.length === first.frameLength) return first;
  const next = parseHeader(data, first.frameLength);
  return next?.layer === first.layer ? first : null;
}

export function detectMpegAudioLayer(data: Uint8Array): MpegAudioLayer | null {
  return inspectAlignedMpegAudioFrame(data)?.layer ?? null;
}

export interface DecodedPcm {
  channelData: Float32Array[];
  samplesDecoded: number;
  sampleRate: number;
}

export interface Mp2WorkerLike {
  readonly ready: Promise<void>;
  decodeFrame(frame: Uint8Array): Promise<DecodedPcm>;
  reset(): Promise<void>;
  free(): Promise<void>;
  /** Present on the pinned WebWorker implementation, omitted from its .d.ts. */
  terminate?(): void;
}

export type Mp2WorkerFactory = () => Mp2WorkerLike;

type Mp2LifetimeState = 'active' | 'disposing' | 'terminated';

type DisposalOutcome =
  { readonly kind: 'completed' } | { readonly kind: 'failed'; readonly error: unknown };

export class Mp2Decoder {
  private worker: Mp2WorkerLike | null;
  private lifetimeState: Mp2LifetimeState = 'active';
  private cooperativeOutcome: Promise<DisposalOutcome> | null = null;
  private pendingDisposal: Promise<void> | null = null;
  private forceWaiter: ((outcome: DisposalOutcome) => void) | null = null;

  constructor(
    factory: Mp2WorkerFactory = () => new MPEGDecoderWebWorker({ enableGapless: false }),
  ) {
    const worker = factory();
    if (typeof worker.terminate !== 'function')
      throw new TypeError('MP2 worker does not provide callable terminate()');
    this.worker = worker;
  }

  async ready(): Promise<void> {
    const worker = this.activeWorker();
    await worker.ready;
  }

  async decode(frame: Uint8Array): Promise<DecodedPcm> {
    const worker = this.activeWorker();
    if (detectMpegAudioLayer(frame) !== 2)
      throw new Error('Encoded frame is not aligned MPEG Layer II');
    return worker.decodeFrame(frame);
  }

  async reset(): Promise<void> {
    if (this.lifetimeState !== 'active') return;
    await this.worker?.reset();
  }

  async dispose(): Promise<void> {
    if (this.lifetimeState === 'terminated') return;
    if (this.pendingDisposal) return this.pendingDisposal;

    const worker = this.worker;
    if (!worker) throw new Error('MP2 decoder lost worker termination authority');
    if (this.cooperativeOutcome === null) this.startCooperativeDisposal(worker);

    const forced = new Promise<DisposalOutcome>((resolve) => {
      this.forceWaiter = resolve;
    });
    const cooperative = this.cooperativeOutcome;
    if (!cooperative) throw new Error('MP2 decoder disposal did not start');

    const attempt = Promise.race([cooperative, forced]).then((outcome) => {
      if (outcome.kind === 'failed') throw outcome.error;
    });
    const tracked: Promise<void> = attempt.finally(() => {
      if (this.pendingDisposal === tracked) this.pendingDisposal = null;
      this.forceWaiter = null;
    });
    this.pendingDisposal = tracked;
    return tracked;
  }

  /**
   * Synchronously terminates the pinned worker when cooperative `free()` cannot run.
   * The wrapper's public type omits `terminate()`, but the class extends Worker in
   * @wasm-audio-decoders/common 9.0.7 and its own free() ends by calling terminate().
   * A failed direct termination retains ownership, rejects any disposal waiter,
   * and throws synchronously so teardown callers can never mistake it for success.
   */
  forceTerminate(): void {
    if (this.lifetimeState === 'terminated') return;
    const worker = this.worker;
    if (!worker) throw new Error('MP2 decoder lost worker termination authority');

    this.lifetimeState = 'disposing';
    const error = this.tryTerminate(worker);
    if (error) {
      if (this.forceWaiter) {
        const waiter = this.forceWaiter;
        this.forceWaiter = null;
        waiter({ kind: 'failed', error });
      }
      throw error;
    }

    this.confirmTerminated(worker);
    const waiter = this.forceWaiter;
    this.forceWaiter = null;
    waiter?.({ kind: 'completed' });
  }

  private activeWorker(): Mp2WorkerLike {
    if (this.lifetimeState !== 'active' || !this.worker)
      throw new Error('MP2 decoder disposed');
    return this.worker;
  }

  private startCooperativeDisposal(worker: Mp2WorkerLike): void {
    this.lifetimeState = 'disposing';
    this.cooperativeOutcome = Promise.resolve()
      .then(() => {
        if (this.lifetimeState === 'terminated') return;
        return worker.free();
      })
      .then<DisposalOutcome, DisposalOutcome>(
        () => {
          this.confirmTerminated(worker);
          return { kind: 'completed' };
        },
        (freeError: unknown) => {
          if (this.lifetimeState === 'terminated')
            return { kind: 'failed', error: freeError };
          const terminationError = this.tryTerminate(worker);
          if (terminationError) {
            return {
              kind: 'failed',
              error: new AggregateError(
                [freeError, terminationError],
                'MP2 cooperative and forced disposal failed',
              ),
            };
          }
          this.confirmTerminated(worker);
          return { kind: 'failed', error: freeError };
        },
      );
  }

  private tryTerminate(worker: Mp2WorkerLike): Error | null {
    if (typeof worker.terminate !== 'function')
      return new Error('MP2 worker does not provide callable terminate()');
    try {
      worker.terminate();
      return null;
    } catch (error) {
      return new Error('MP2 worker termination failed', { cause: error });
    }
  }

  private confirmTerminated(worker: Mp2WorkerLike): void {
    if (this.worker !== worker) return;
    this.lifetimeState = 'terminated';
    this.worker = null;
  }
}
