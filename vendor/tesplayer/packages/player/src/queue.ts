import { abortError } from './errors.js';

interface Waiter<T> {
  resolve(value: T | null): void;
  reject(error: Error): void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Queue closed');
}

export class BoundedAsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly readers: Waiter<T>[] = [];
  private readonly writers: (() => void)[] = [];
  private closedError: Error | null = null;
  private ended = false;

  constructor(
    readonly capacity: number,
    private readonly disposeValue: (value: T) => void,
    private readonly onDepth: (depth: number) => void = () => undefined,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError('Queue capacity must be a positive integer');
  }

  get depth(): number {
    return this.values.length;
  }

  async push(value: T, signal: AbortSignal): Promise<void> {
    while (
      !this.ended &&
      this.closedError === null &&
      this.values.length >= this.capacity
    )
      await this.waitForWriter(signal);
    if (signal.aborted) {
      this.disposeValue(value);
      throw abortError();
    }
    if (this.ended || this.closedError !== null) {
      this.disposeValue(value);
      throw this.closedError ?? abortError('Queue is closed');
    }
    const reader = this.readers.shift();
    if (reader) reader.resolve(value);
    else {
      this.values.push(value);
      this.onDepth(this.values.length);
    }
  }

  async shift(signal: AbortSignal): Promise<T | null> {
    if (this.values.length > 0) {
      const value = this.values.shift();
      this.onDepth(this.values.length);
      this.writers.shift()?.();
      return value ?? null;
    }
    if (this.closedError !== null) throw this.closedError;
    if (this.ended) return null;
    if (signal.aborted) throw abortError();
    return new Promise<T | null>((resolve, reject) => {
      const waiter: Waiter<T> = { resolve, reject };
      const onAbort = (): void => {
        const index = this.readers.indexOf(waiter);
        if (index >= 0) this.readers.splice(index, 1);
        reject(abortError());
      };
      const wrappedResolve = (value: T | null): void => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const wrappedReject = (error: Error): void => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      };
      waiter.resolve = wrappedResolve;
      waiter.reject = wrappedReject;
      signal.addEventListener('abort', onAbort, { once: true });
      this.readers.push(waiter);
    });
  }

  end(): void {
    if (this.ended || this.closedError !== null) return;
    this.ended = true;
    for (const reader of this.readers.splice(0)) reader.resolve(null);
    for (const writer of this.writers.splice(0)) writer();
  }

  close(error: unknown = abortError()): void {
    if (this.closedError !== null) return;
    const closedError = asError(error);
    this.closedError = closedError;
    for (const value of this.values.splice(0)) this.disposeValue(value);
    this.onDepth(0);
    for (const reader of this.readers.splice(0)) reader.reject(closedError);
    for (const writer of this.writers.splice(0)) writer();
  }

  private waitForWriter(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const release = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const index = this.writers.indexOf(release);
        if (index >= 0) this.writers.splice(index, 1);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.writers.push(release);
    });
  }
}

export function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
