export type DecoderControllerState =
  'created' | 'configuring' | 'configured' | 'flushing' | 'failed' | 'closed';

export type DecoderControllerErrorCode =
  | 'ABORTED'
  | 'ADMISSION_OVERFLOW'
  | 'API_UNAVAILABLE'
  | 'CLOSED'
  | 'CONFIGURE_FAILED'
  | 'CONFIGURE_TIMEOUT'
  | 'CONSUMER_FAILED'
  | 'DECODE_FAILED'
  | 'DECODER_ERROR'
  | 'FLUSH_FAILED'
  | 'FLUSH_TIMEOUT'
  | 'INVALID_OPTIONS'
  | 'INVALID_STATE'
  | 'RECONCILIATION_TIMEOUT';

export class DecoderControllerError extends Error {
  readonly code: DecoderControllerErrorCode;

  constructor(code: DecoderControllerErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DecoderControllerError';
    this.code = code;
  }
}

/** Native calls are void; adapters may return thenables that must be bounded. */
export interface VideoDecoderLike {
  readonly decodeQueueSize: number;
  readonly state: CodecState;
  configure(config: VideoDecoderConfig): unknown;
  decode(chunk: EncodedVideoChunk): unknown;
  flush(): Promise<void>;
  close(): void;
}

export interface DecoderControllerMetrics {
  readonly state: DecoderControllerState;
  readonly acceptedSubmissions: number;
  readonly peakAcceptedSubmissions: number;
  readonly admissionWaiters: number;
  readonly peakAdmissionWaiters: number;
  readonly totalSubmissions: number;
  readonly reconciledByOutput: number;
  readonly reconciledByFlush: number;
  readonly cancelledSubmissions: number;
  readonly outputFrames: number;
  readonly matchedOutputFrames: number;
  readonly unmatchedOutputFrames: number;
  readonly callbackFrames: number;
  readonly peakCallbackFrames: number;
  readonly liveFrameHandles: number;
  readonly peakLiveFrameHandles: number;
  readonly deliveredFrames: number;
  readonly droppedFrames: number;
  readonly closedFrames: number;
  readonly frameCloseErrors: number;
  /** Observation only. This is never used for admission. */
  readonly decoderQueueSize: number | null;
  readonly terminalCode: DecoderControllerErrorCode | null;
}

export interface BoundedVideoDecoderControllerOptions {
  readonly createDecoder: (init: VideoDecoderInit) => VideoDecoderLike;
  readonly onFrame: (frame: OwnedVideoFrame) => void;
  readonly onTerminal?: (error: DecoderControllerError) => void;
  readonly observe?: (metrics: Readonly<DecoderControllerMetrics>) => void;
  readonly signal?: AbortSignal;
  readonly maxAcceptedSubmissions: number;
  /** Includes a frame currently entering the output callback. */
  readonly maxFrameHandles: number;
  readonly reconciliationTimeoutMs: number;
  readonly flushTimeoutMs: number;
  readonly configureTimeoutMs?: number;
  readonly maxAdmissionWaiters?: number;
}

interface MutableMetrics {
  state: DecoderControllerState;
  acceptedSubmissions: number;
  peakAcceptedSubmissions: number;
  admissionWaiters: number;
  peakAdmissionWaiters: number;
  totalSubmissions: number;
  reconciledByOutput: number;
  reconciledByFlush: number;
  cancelledSubmissions: number;
  outputFrames: number;
  matchedOutputFrames: number;
  unmatchedOutputFrames: number;
  callbackFrames: number;
  peakCallbackFrames: number;
  liveFrameHandles: number;
  peakLiveFrameHandles: number;
  deliveredFrames: number;
  droppedFrames: number;
  closedFrames: number;
  frameCloseErrors: number;
  terminalCode: DecoderControllerErrorCode | null;
}

interface SubmissionCredit {
  readonly id: number;
  readonly timestamp: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface AdmissionWaiter {
  readonly resolve: () => void;
  readonly reject: (error: DecoderControllerError) => void;
  readonly signal: AbortSignal | null;
  readonly onAbort: (() => void) | null;
}

interface RaceSuccess<T> {
  readonly kind: 'success';
  readonly value: T;
}

interface RaceFailure {
  readonly kind: 'failure';
  readonly error: unknown;
}

interface RaceTerminal {
  readonly kind: 'terminal';
  readonly error: DecoderControllerError;
}

interface RaceTimeout {
  readonly kind: 'timeout';
}

type RaceResult<T> = RaceSuccess<T> | RaceFailure | RaceTerminal | RaceTimeout;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new DecoderControllerError(
      'INVALID_OPTIONS',
      `${name} must be a positive safe integer`,
    );
  return value;
}

function timeoutValue(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647)
    throw new DecoderControllerError(
      'INVALID_OPTIONS',
      `${name} must be finite, positive, and no larger than 2147483647`,
    );
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'Unknown failure';
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? typeof (value as { then?: unknown }).then === 'function'
    : false;
}

function isDecoderLike(value: unknown): value is VideoDecoderLike {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
    return false;
  const candidate = value as {
    configure?: unknown;
    decode?: unknown;
    flush?: unknown;
    close?: unknown;
  };
  return (
    typeof candidate.configure === 'function' &&
    typeof candidate.decode === 'function' &&
    typeof candidate.flush === 'function' &&
    typeof candidate.close === 'function'
  );
}

function tryCloseMalformedDecoder(value: unknown): void {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
    return;
  const candidate = value as { close?: unknown };
  if (typeof candidate.close !== 'function') return;
  try {
    candidate.close.call(value);
  } catch {
    // There is no usable controller instance; best-effort release is the only safe action.
  }
}

/**
 * Idempotent ownership handle around exactly one decoder callback allocation.
 * The controller never clones the underlying VideoFrame.
 */
export class OwnedVideoFrame {
  private closed = false;

  constructor(
    private readonly rawFrame: VideoFrame,
    private readonly release: (handle: OwnedVideoFrame, frame: VideoFrame) => void,
  ) {}

  get frame(): VideoFrame {
    if (this.closed)
      throw new DecoderControllerError(
        'CLOSED',
        'Video frame ownership has been released',
      );
    return this.rawFrame;
  }

  get timestamp(): number {
    return this.rawFrame.timestamp;
  }

  get displayWidth(): number {
    return this.rawFrame.displayWidth;
  }

  get displayHeight(): number {
    return this.rawFrame.displayHeight;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.release(this, this.rawFrame);
  }
}

/**
 * Bounds accepted decoder work independently of VideoDecoder.decodeQueueSize and
 * counts each callback frame before deciding whether it can be retained.
 */
export class BoundedVideoDecoderController {
  private readonly decoder: VideoDecoderLike;
  private readonly onFrame: (frame: OwnedVideoFrame) => void;
  private readonly onTerminal: ((error: DecoderControllerError) => void) | undefined;
  private readonly observeHook:
    ((metrics: Readonly<DecoderControllerMetrics>) => void) | undefined;
  private readonly maxAcceptedSubmissions: number;
  private readonly maxFrameHandles: number;
  private readonly reconciliationTimeoutMs: number;
  private readonly flushTimeoutMs: number;
  private readonly configureTimeoutMs: number;
  private readonly maxAdmissionWaiters: number;
  private readonly outerSignal: AbortSignal | undefined;
  private readonly outerAbort: (() => void) | null;
  private readonly credits: SubmissionCredit[] = [];
  private readonly frames = new Set<OwnedVideoFrame>();
  private readonly admissionWaiters: AdmissionWaiter[] = [];
  private readonly metrics: MutableMetrics = {
    state: 'created',
    acceptedSubmissions: 0,
    peakAcceptedSubmissions: 0,
    admissionWaiters: 0,
    peakAdmissionWaiters: 0,
    totalSubmissions: 0,
    reconciledByOutput: 0,
    reconciledByFlush: 0,
    cancelledSubmissions: 0,
    outputFrames: 0,
    matchedOutputFrames: 0,
    unmatchedOutputFrames: 0,
    callbackFrames: 0,
    peakCallbackFrames: 0,
    liveFrameHandles: 0,
    peakLiveFrameHandles: 0,
    deliveredFrames: 0,
    droppedFrames: 0,
    closedFrames: 0,
    frameCloseErrors: 0,
    terminalCode: null,
  };
  private readonly terminalPromise: Promise<DecoderControllerError>;
  private resolveTerminal!: (error: DecoderControllerError) => void;
  private nextCreditId = 1;
  private decoderClosed = false;
  private terminalError: DecoderControllerError | null = null;

  constructor(options: BoundedVideoDecoderControllerOptions) {
    this.maxAcceptedSubmissions = positiveInteger(
      options.maxAcceptedSubmissions,
      'maxAcceptedSubmissions',
    );
    this.maxFrameHandles = positiveInteger(options.maxFrameHandles, 'maxFrameHandles');
    this.reconciliationTimeoutMs = timeoutValue(
      options.reconciliationTimeoutMs,
      'reconciliationTimeoutMs',
    );
    this.flushTimeoutMs = timeoutValue(options.flushTimeoutMs, 'flushTimeoutMs');
    this.configureTimeoutMs = timeoutValue(
      options.configureTimeoutMs ?? options.flushTimeoutMs,
      'configureTimeoutMs',
    );
    this.maxAdmissionWaiters = positiveInteger(
      options.maxAdmissionWaiters ?? options.maxAcceptedSubmissions,
      'maxAdmissionWaiters',
    );
    this.onFrame = options.onFrame;
    this.onTerminal = options.onTerminal;
    this.observeHook = options.observe;
    this.outerSignal = options.signal;
    this.terminalPromise = new Promise((resolve) => {
      this.resolveTerminal = resolve;
    });

    let candidate: unknown;
    try {
      candidate = options.createDecoder({
        output: (frame) => {
          this.acceptOutput(frame);
        },
        error: (error) => {
          this.fail(
            new DecoderControllerError(
              'DECODER_ERROR',
              `Video decoder callback failed: ${errorMessage(error)}`,
              error,
            ),
          );
        },
      });
    } catch (error) {
      throw new DecoderControllerError(
        'API_UNAVAILABLE',
        `Video decoder construction failed: ${errorMessage(error)}`,
        error,
      );
    }
    if (!isDecoderLike(candidate)) {
      tryCloseMalformedDecoder(candidate);
      throw new DecoderControllerError(
        'API_UNAVAILABLE',
        'Video decoder does not implement configure, decode, flush, and close',
      );
    }
    this.decoder = candidate;

    if (this.outerSignal?.aborted) {
      this.outerAbort = null;
      this.abort(this.outerSignal.reason);
    } else if (this.outerSignal) {
      this.outerAbort = (): void => {
        this.abort(this.outerSignal?.reason);
      };
      this.outerSignal.addEventListener('abort', this.outerAbort, { once: true });
    } else {
      this.outerAbort = null;
    }
    this.emitObservation();
  }

  get state(): DecoderControllerState {
    return this.metrics.state;
  }

  get snapshot(): Readonly<DecoderControllerMetrics> {
    return this.makeSnapshot();
  }

  async configure(config: VideoDecoderConfig): Promise<void> {
    this.requireState('created', 'configure');
    this.metrics.state = 'configuring';
    this.emitObservation();
    let result: unknown;
    try {
      result = this.decoder.configure(config);
    } catch (error) {
      const failure = new DecoderControllerError(
        'CONFIGURE_FAILED',
        `Video decoder configure failed: ${errorMessage(error)}`,
        error,
      );
      this.fail(failure);
      throw failure;
    }
    if (isPromiseLike(result)) {
      try {
        await this.awaitWithTimeout(
          Promise.resolve(result),
          this.configureTimeoutMs,
          'CONFIGURE_TIMEOUT',
          'Video decoder configure did not settle before its deadline',
        );
      } catch (error) {
        if (error === this.terminalError) throw error;
        const failure =
          error instanceof DecoderControllerError && error.code === 'CONFIGURE_TIMEOUT'
            ? error
            : new DecoderControllerError(
                'CONFIGURE_FAILED',
                `Video decoder configure rejected: ${errorMessage(error)}`,
                error,
              );
        this.fail(failure);
        throw failure;
      }
    }
    this.throwIfTerminal();
    this.metrics.state = 'configured';
    this.emitObservation();
  }

  async submit(chunk: EncodedVideoChunk, signal?: AbortSignal): Promise<void> {
    this.requireState('configured', 'decode');
    while (this.credits.length >= this.maxAcceptedSubmissions) {
      await this.waitForAdmission(signal);
      this.requireState('configured', 'decode');
    }
    if (signal?.aborted) throw this.abortError(signal.reason);
    this.throwIfTerminal();

    const creditId = this.nextCreditId++;
    const credit: SubmissionCredit = {
      id: creditId,
      timestamp: chunk.timestamp,
      timer: setTimeout(() => {
        if (!this.credits.some((candidate) => candidate.id === creditId)) return;
        this.fail(
          new DecoderControllerError(
            'RECONCILIATION_TIMEOUT',
            `Submission ${String(creditId)} at timestamp ${String(chunk.timestamp)} produced no matching output before its deadline`,
          ),
        );
      }, this.reconciliationTimeoutMs),
    };
    this.credits.push(credit);
    this.metrics.totalSubmissions++;
    this.syncCreditMetrics();

    let result: unknown;
    try {
      result = this.decoder.decode(chunk);
    } catch (error) {
      const failure = new DecoderControllerError(
        'DECODE_FAILED',
        `Video decoder decode failed: ${errorMessage(error)}`,
        error,
      );
      this.fail(failure);
      throw failure;
    }
    if (isPromiseLike(result)) {
      try {
        await this.awaitWithTimeout(
          Promise.resolve(result),
          this.reconciliationTimeoutMs,
          'RECONCILIATION_TIMEOUT',
          `Submission ${String(creditId)} decode call did not settle before its deadline`,
        );
      } catch (error) {
        if (error === this.terminalError) throw error;
        const failure =
          error instanceof DecoderControllerError
            ? error
            : new DecoderControllerError(
                'DECODE_FAILED',
                `Video decoder decode rejected: ${errorMessage(error)}`,
                error,
              );
        this.fail(failure);
        throw failure;
      }
    }
    this.throwIfTerminal();
    this.emitObservation();
  }

  async flush(options: { readonly timeoutMs?: number } = {}): Promise<void> {
    this.requireState('configured', 'flush');
    const timeoutMs = timeoutValue(
      options.timeoutMs ?? this.flushTimeoutMs,
      'flush timeout',
    );
    this.metrics.state = 'flushing';
    this.rejectAdmissionWaiters(
      new DecoderControllerError('INVALID_STATE', 'Decoder started flushing'),
    );
    this.emitObservation();

    let result: unknown;
    try {
      result = (this.decoder.flush as unknown as () => unknown)();
    } catch (error) {
      const failure = new DecoderControllerError(
        'FLUSH_FAILED',
        `Video decoder flush failed: ${errorMessage(error)}`,
        error,
      );
      this.fail(failure);
      throw failure;
    }
    if (!isPromiseLike(result)) {
      const failure = new DecoderControllerError(
        'API_UNAVAILABLE',
        'Video decoder flush did not return a promise',
      );
      this.fail(failure);
      throw failure;
    }

    try {
      await this.awaitWithTimeout(
        Promise.resolve(result),
        timeoutMs,
        'FLUSH_TIMEOUT',
        'Video decoder flush did not settle before its deadline',
      );
    } catch (error) {
      if (error === this.terminalError) throw error;
      const failure =
        error instanceof DecoderControllerError && error.code === 'FLUSH_TIMEOUT'
          ? error
          : new DecoderControllerError(
              'FLUSH_FAILED',
              `Video decoder flush rejected: ${errorMessage(error)}`,
              error,
            );
      this.fail(failure);
      throw failure;
    }

    this.throwIfTerminal();
    const reconciled = this.credits.length;
    for (const credit of this.credits.splice(0)) clearTimeout(credit.timer);
    this.metrics.reconciledByFlush += reconciled;
    this.syncCreditMetrics();
    this.metrics.state = 'configured';
    this.emitObservation();
  }

  abort(reason?: unknown): void {
    this.fail(this.abortError(reason));
  }

  close(): void {
    if (this.metrics.state === 'closed' || this.metrics.state === 'failed') return;
    const closed = new DecoderControllerError('CLOSED', 'Decoder controller is closed');
    this.terminate(closed, false);
  }

  private acceptOutput(rawFrame: VideoFrame): void {
    const handle = new OwnedVideoFrame(rawFrame, (owned, frame) => {
      this.releaseFrame(owned, frame);
    });
    this.frames.add(handle);
    this.metrics.outputFrames++;
    this.metrics.callbackFrames++;
    this.metrics.peakCallbackFrames = Math.max(
      this.metrics.peakCallbackFrames,
      this.metrics.callbackFrames,
    );
    this.metrics.liveFrameHandles++;
    this.metrics.peakLiveFrameHandles = Math.max(
      this.metrics.peakLiveFrameHandles,
      this.metrics.liveFrameHandles,
    );

    const creditIndex = this.credits.findIndex(
      (credit) => credit.timestamp === rawFrame.timestamp,
    );
    if (creditIndex >= 0) {
      const [credit] = this.credits.splice(creditIndex, 1);
      if (credit) clearTimeout(credit.timer);
      this.metrics.matchedOutputFrames++;
      this.metrics.reconciledByOutput++;
      this.syncCreditMetrics();
      this.releaseOneAdmissionWaiter();
    } else {
      this.metrics.unmatchedOutputFrames++;
    }
    this.emitObservation();

    try {
      if (
        (this.metrics.state !== 'configured' && this.metrics.state !== 'flushing') ||
        this.terminalError !== null
      ) {
        this.metrics.droppedFrames++;
        handle.close();
        return;
      }
      // Equality is full: retaining this callback frame would consume the slot
      // reserved for a future callback and allow the next callback to exceed the cap.
      if (this.metrics.liveFrameHandles >= this.maxFrameHandles) {
        this.metrics.droppedFrames++;
        handle.close();
        return;
      }
      try {
        this.onFrame(handle);
        this.metrics.deliveredFrames++;
      } catch (error) {
        this.metrics.droppedFrames++;
        handle.close();
        this.fail(
          new DecoderControllerError(
            'CONSUMER_FAILED',
            `Video frame consumer failed: ${errorMessage(error)}`,
            error,
          ),
        );
      }
    } finally {
      this.metrics.callbackFrames--;
      this.emitObservation();
    }
  }

  private releaseFrame(handle: OwnedVideoFrame, rawFrame: VideoFrame): void {
    if (!this.frames.delete(handle)) return;
    this.metrics.liveFrameHandles--;
    try {
      rawFrame.close();
    } catch {
      this.metrics.frameCloseErrors++;
    } finally {
      this.metrics.closedFrames++;
      this.emitObservation();
    }
  }

  private reconcileAllAsCancelled(): void {
    const cancelled = this.credits.length;
    for (const credit of this.credits.splice(0)) clearTimeout(credit.timer);
    this.metrics.cancelledSubmissions += cancelled;
    this.syncCreditMetrics();
  }

  private syncCreditMetrics(): void {
    this.metrics.acceptedSubmissions = this.credits.length;
    this.metrics.peakAcceptedSubmissions = Math.max(
      this.metrics.peakAcceptedSubmissions,
      this.metrics.acceptedSubmissions,
    );
  }

  private waitForAdmission(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(this.abortError(signal.reason));
    this.throwIfTerminal();
    if (this.admissionWaiters.length >= this.maxAdmissionWaiters)
      return Promise.reject(
        new DecoderControllerError(
          'ADMISSION_OVERFLOW',
          'The bounded decoder admission waiter limit was reached',
        ),
      );

    return new Promise((resolve, reject) => {
      const onAbort = signal
        ? (): void => {
            const index = this.admissionWaiters.indexOf(waiter);
            if (index >= 0) this.admissionWaiters.splice(index, 1);
            if (onAbort !== null) signal.removeEventListener('abort', onAbort);
            this.syncWaiterMetrics();
            reject(this.abortError(signal.reason));
          }
        : null;
      const waiter: AdmissionWaiter = {
        resolve,
        reject,
        signal: signal ?? null,
        onAbort,
      };
      if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true });
      this.admissionWaiters.push(waiter);
      this.syncWaiterMetrics();
      this.emitObservation();
    });
  }

  private releaseOneAdmissionWaiter(): void {
    const waiter = this.admissionWaiters.shift();
    if (!waiter) return;
    this.cleanupWaiter(waiter);
    this.syncWaiterMetrics();
    waiter.resolve();
  }

  private rejectAdmissionWaiters(error: DecoderControllerError): void {
    for (const waiter of this.admissionWaiters.splice(0)) {
      this.cleanupWaiter(waiter);
      waiter.reject(error);
    }
    this.syncWaiterMetrics();
  }

  private cleanupWaiter(waiter: AdmissionWaiter): void {
    if (waiter.signal && waiter.onAbort)
      waiter.signal.removeEventListener('abort', waiter.onAbort);
  }

  private syncWaiterMetrics(): void {
    this.metrics.admissionWaiters = this.admissionWaiters.length;
    this.metrics.peakAdmissionWaiters = Math.max(
      this.metrics.peakAdmissionWaiters,
      this.metrics.admissionWaiters,
    );
  }

  private async awaitWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutCode: 'CONFIGURE_TIMEOUT' | 'FLUSH_TIMEOUT' | 'RECONCILIATION_TIMEOUT',
    timeoutMessage: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed: Promise<RaceResult<T>> = promise.then(
      (value): RaceSuccess<T> => ({ kind: 'success', value }),
      (error: unknown): RaceFailure => ({ kind: 'failure', error }),
    );
    const terminal: Promise<RaceTerminal> = this.terminalPromise.then((error) => ({
      kind: 'terminal',
      error,
    }));
    const timeout = new Promise<RaceTimeout>((resolve) => {
      timer = setTimeout(() => {
        resolve({ kind: 'timeout' });
      }, timeoutMs);
    });
    const result = await Promise.race([observed, terminal, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    switch (result.kind) {
      case 'success':
        return result.value;
      case 'failure':
        throw result.error;
      case 'terminal':
        throw result.error;
      case 'timeout':
        throw new DecoderControllerError(timeoutCode, timeoutMessage);
    }
  }

  private requireState(expected: DecoderControllerState, operation: string): void {
    this.throwIfTerminal();
    if (this.metrics.state !== expected)
      throw new DecoderControllerError(
        'INVALID_STATE',
        `Cannot ${operation} while decoder controller is ${this.metrics.state}`,
      );
  }

  private throwIfTerminal(): void {
    if (this.terminalError) throw this.terminalError;
  }

  private abortError(reason?: unknown): DecoderControllerError {
    return new DecoderControllerError(
      'ABORTED',
      'Decoder controller was aborted',
      reason,
    );
  }

  private fail(error: DecoderControllerError): void {
    if (this.terminalError) return;
    this.terminate(error, true);
  }

  private terminate(error: DecoderControllerError, notifyTerminal: boolean): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.metrics.state = notifyTerminal ? 'failed' : 'closed';
    this.metrics.terminalCode = error.code;
    if (this.outerSignal && this.outerAbort)
      this.outerSignal.removeEventListener('abort', this.outerAbort);
    this.reconcileAllAsCancelled();
    this.rejectAdmissionWaiters(error);
    for (const frame of [...this.frames]) frame.close();
    this.closeDecoder();
    this.resolveTerminal(error);
    this.emitObservation();
    if (notifyTerminal && this.onTerminal) {
      try {
        this.onTerminal(error);
      } catch {
        // Terminal callbacks cannot regain authority or prevent exact resource release.
      }
    }
  }

  private closeDecoder(): void {
    if (this.decoderClosed) return;
    this.decoderClosed = true;
    try {
      this.decoder.close();
    } catch {
      // Continue terminal cleanup. close() has already consumed this ownership right.
    }
  }

  private makeSnapshot(): Readonly<DecoderControllerMetrics> {
    let decoderQueueSize: number | null = null;
    if (!this.decoderClosed) {
      try {
        const sampled = this.decoder.decodeQueueSize;
        decoderQueueSize = Number.isFinite(sampled) && sampled >= 0 ? sampled : null;
      } catch {
        decoderQueueSize = null;
      }
    }
    return Object.freeze({ ...this.metrics, decoderQueueSize });
  }

  private emitObservation(): void {
    if (!this.observeHook) return;
    try {
      this.observeHook(this.makeSnapshot());
    } catch {
      // Metrics observers are non-authoritative and cannot break resource ownership.
    }
  }
}
