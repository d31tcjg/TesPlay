import type {
  PlaybackSession,
  PlayerCommand,
  PlayerEngine,
  PlayerEngineServices,
  PlayerError,
  PlayerEvent,
  PlayerLoadRequest,
  PlayerPolicy,
  PlayerSnapshot,
  PlayerSubtitleCue,
} from '@canvas-stream-player/contracts';
import { DEFAULT_PLAYER_POLICY } from '@canvas-stream-player/contracts';
import {
  ALL_FORMATS,
  AudioBufferSink,
  BufferSource,
  CustomPathedSource,
  EncodedPacketSink,
  HLS_FORMATS,
  Input,
  ReadableStreamSource,
  UrlSource,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny';

import { probeTrackDecoderCapability } from './capabilities.js';
import { MediaClock, presentationDelaySeconds } from './clock.js';
import {
  BoundedVideoDecoderController,
  type OwnedVideoFrame,
} from './decoder-controller.js';
import {
  EngineFault,
  abortError,
  engineFault,
  isAbortError,
  safeErrorCause,
  safePublicText,
  timeoutError,
} from './errors.js';
import { CanvasRenderer, type CanvasSample } from './canvas-renderer.js';
import { HlsResources } from './hls-resources.js';
import { detectMpegAudioLayer, Mp2Decoder } from './mp2.js';
import { BoundedAsyncQueue, waitForDelay } from './queue.js';
import {
  activeCuesAt,
  loadSubtitleResource,
  mergeSubtitleWindowCues,
  type SubtitleTimelineState,
} from './subtitles.js';

export interface PlayerEngineOptions {
  canvas: HTMLCanvasElement;
  audioContext?: AudioContext;
  policy?: PlayerPolicy;
  services: PlayerEngineServices;
  capabilities: PlayerEngine['capabilities'];
  /** Focused test seam. Production callers should omit this field. */
  dependencies?: PlayerEngineDependencies;
}

interface DisposableInput {
  dispose(): void;
}

interface OwnedVideoSample extends CanvasSample {
  readonly timestamp: number;
  close(): void;
}

export interface VideoDecoderLike {
  readonly decodeQueueSize: number;
  readonly state: CodecState;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  flush(): Promise<void>;
  close(): void;
}

export interface EnginePipeline {
  inputs: DisposableInput[];
  videoTrack: InputVideoTrack | null;
  audioTrack: InputAudioTrack | null;
  timelineOrigin: number;
  duration: number | null;
  seekableStart: number;
  seekableEnd: number | null;
  liveRefreshSeconds: number | null;
  actualQualityId: string | null;
  actualAudioTrackId: string | null;
}

export interface EnginePipelineMetadata {
  duration: number | null;
  seekableStart: number;
  seekableEnd: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  codedWidth?: number | null;
  codedHeight?: number | null;
}

export interface PlayerEngineDependencies {
  fetch?: typeof fetch;
  createInput?: (options: ConstructorParameters<typeof Input>[0]) => Input;
  createVideoDecoder?: (init: VideoDecoderInit) => VideoDecoderLike;
  createAudioSink?: (track: InputAudioTrack) => AudioBufferSink;
  createPacketSink?: (track: InputAudioTrack | InputVideoTrack) => EncodedPacketSink;
  createMp2Decoder?: () => Mp2Decoder;
  openPipeline?: (context: {
    session: PlaybackSession;
    signal: AbortSignal;
    registerInput: (input: DisposableInput) => void;
  }) => Promise<EnginePipeline>;
  inspectPipeline?: (
    pipeline: EnginePipeline,
    signal: AbortSignal,
  ) => Promise<EnginePipelineMetadata>;
}

type PlaybackEndpoint = PlaybackSession['endpoints'][number];
type IntervalHandle = ReturnType<typeof setInterval>;

type InvocationDomain = 'generation' | 'selection' | 'subtitle' | 'audio' | 'controls';

interface Operation {
  readonly generation: number;
  readonly controller: AbortController;
  readonly inputs: Set<DisposableInput>;
  readonly videoDecoders: Set<VideoDecoderLike>;
  readonly videoDecoderControllers: Set<BoundedVideoDecoderController>;
  readonly videoFrames: Set<OwnedVideoSample>;
  readonly videoQueues: Set<BoundedAsyncQueue<OwnedVideoSample>>;
  readonly mp2Decoders: Set<Mp2Decoder>;
  readonly tasks: Set<Promise<unknown>>;
  readonly hls: HlsResources;
  readonly timers: Set<IntervalHandle>;
  pipeline: EnginePipeline | null;
  outerSignal: AbortSignal | null;
  outerAbort: (() => void) | null;
  subtitleController: AbortController | null;
  subtitleEpoch: number;
  recoveryTask: Promise<void> | null;
  liveTimelineOffset: number | null;
  liveRefreshStarted: boolean;
  readonly lastRawTimestamp: Record<'audio' | 'video', number | null>;
  readonly trackTimelineOffset: Record<'audio' | 'video', number | null>;
  readonly authorityVersions: Record<InvocationDomain, number>;
  readonly invocations: Map<InvocationDomain, InvocationAuthority>;
  readonly audioNodes: Set<AudioBufferSourceNode>;
  gain: GainNode | null;
  nextAudioTime: number;
  audioEnded: boolean;
  basePresentationTime: number;
  lastVideoTimestamp: number | null;
  terminalError: boolean;
  disposed: boolean;
}

/**
 * Immutable public-call identity with an explicitly transferable operation lease.
 * A transfer is allowed only when that invocation itself replaces its generation.
 */
interface InvocationAuthority {
  readonly id: number;
  readonly domain: InvocationDomain;
  operation: Operation;
  version: number;
  readonly controller: AbortController;
  operationAbort: (() => void) | null;
}

interface ResolvedPlayerEngineDependencies {
  fetch: typeof fetch;
  createInput(options: ConstructorParameters<typeof Input>[0]): Input;
  createVideoDecoder(init: VideoDecoderInit): VideoDecoderLike;
  createAudioSink(track: InputAudioTrack): AudioBufferSink;
  createPacketSink(track: InputAudioTrack | InputVideoTrack): EncodedPacketSink;
  createMp2Decoder(): Mp2Decoder;
  openPipeline: PlayerEngineDependencies['openPipeline'] | undefined;
  inspectPipeline: PlayerEngineDependencies['inspectPipeline'] | undefined;
}

const CLEANUP_TIMEOUT_MS = 2_000;

function browserBaseUrl(): string {
  const runtime = globalThis as unknown as { location?: Location };
  return runtime.location?.href ?? 'http://localhost/';
}

function endpointUrl(endpoint: PlaybackEndpoint): string {
  return new URL(endpoint.accessUrl, browserBaseUrl()).href;
}

function endpointFor(
  session: PlaybackSession,
  role: PlaybackEndpoint['role'],
): PlaybackEndpoint | undefined {
  return session.endpoints.find((endpoint) => endpoint.role === role);
}

function isHls(session: PlaybackSession): boolean {
  return session.streamKind.startsWith('hls-');
}

function isContinuous(session: PlaybackSession): boolean {
  return session.streamKind === 'continuous-ts' || session.streamKind === 'growing-fmp4';
}

function credentialsFor(endpoint: PlaybackEndpoint): RequestCredentials {
  return endpoint.route === 'direct' ? 'omit' : 'same-origin';
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

async function directRepresentationId(response: Response): Promise<string | null> {
  const etag = response.headers.get('etag');
  if (etag === null || !/^"[\x21\x23-\x7e\x80-\xff]*"$/u.test(etag)) return null;
  const contentRange = response.headers.get('content-range');
  const rangeMatch =
    contentRange === null ? null : /^bytes \d+-\d+\/(\d+)$/u.exec(contentRange);
  const totalText = rangeMatch?.[1] ?? response.headers.get('content-length');
  if (totalText === null || !/^\d+$/u.test(totalText)) return null;
  const total = Number(totalText);
  if (!Number.isSafeInteger(total) || total <= 0 || response.url === '') return null;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      `canvas-stream-player-media-representation-v1\0${response.url}\0${etag}\0${String(total)}`,
    ),
  );
  return `mr1_${base64Url(new Uint8Array(digest))}`;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function isoNow(): string {
  return new Date().toISOString();
}

function normalizedUrl(value: string | URL | Request): string {
  const raw =
    typeof value === 'string' ? value : value instanceof URL ? value.href : value.url;
  const url = new URL(raw, browserBaseUrl());
  url.hash = '';
  return url.href;
}

function isAudioContextRunning(context: AudioContext | null): context is AudioContext {
  return context?.state === 'running';
}

function audioContextState(
  context: AudioContext | null,
): PlayerSnapshot['diagnostics']['audioContextState'] {
  if (!context) return 'unavailable';
  return context.state === 'interrupted' ? 'suspended' : context.state;
}

export class CanvasPlayerEngine implements PlayerEngine {
  readonly capabilities;
  private readonly renderer: CanvasRenderer;
  private readonly services: PlayerEngineServices;
  private readonly policy: PlayerPolicy;
  private readonly dependencies: ResolvedPlayerEngineDependencies;
  private readonly clock = new MediaClock();
  private readonly listeners = new Set<(event: PlayerEvent) => void>();
  private readonly disposedInputs = new WeakSet<object>();
  private readonly compatibilityModes = new Set<string>();
  private audioContext: AudioContext | null;
  private readonly ownsAudioContext: boolean;

  private operation: Operation;
  private request: PlayerLoadRequest | null = null;
  private session: PlaybackSession | null = null;
  private subtitleCues: PlayerSubtitleCue[] = [];
  private lastProgressMonotonic = 0;
  private nextInvocationId = 0;
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  private state: PlayerSnapshot;

  constructor(options: PlayerEngineOptions) {
    this.renderer = new CanvasRenderer(options.canvas);
    this.services = options.services;
    this.policy = {
      ...DEFAULT_PLAYER_POLICY,
      ...options.policy,
      startupTimeoutMs: {
        ...DEFAULT_PLAYER_POLICY.startupTimeoutMs,
        ...options.policy?.startupTimeoutMs,
      },
    };
    const dependencies = options.dependencies ?? {};
    this.dependencies = {
      fetch: dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      createInput:
        dependencies.createInput ?? ((inputOptions) => new Input(inputOptions)),
      createVideoDecoder:
        dependencies.createVideoDecoder ?? ((init) => new VideoDecoder(init)),
      createAudioSink:
        dependencies.createAudioSink ?? ((track) => new AudioBufferSink(track)),
      createPacketSink:
        dependencies.createPacketSink ?? ((track) => new EncodedPacketSink(track)),
      createMp2Decoder: dependencies.createMp2Decoder ?? (() => new Mp2Decoder()),
      openPipeline: dependencies.openPipeline,
      inspectPipeline: dependencies.inspectPipeline,
    };
    this.capabilities = options.capabilities;
    this.audioContext = options.audioContext ?? null;
    this.ownsAudioContext = options.audioContext === undefined;
    this.operation = this.createOperation(0);
    this.state = this.initialSnapshot();
  }

  getSnapshot(): PlayerSnapshot {
    this.updatePosition();
    return structuredClone(this.state);
  }

  subscribe(listener: (event: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: 'state', snapshot: this.getSnapshot() });
    return () => {
      this.listeners.delete(listener);
    };
  }

  async load(request: PlayerLoadRequest, signal?: AbortSignal): Promise<void> {
    this.assertAlive();
    const invocation = this.createInvocation(this.operation, 'generation', false);
    this.compatibilityModes.clear();
    const deadlineMs = this.startupTimeoutFor(request.session);
    const deadlineAt = this.services.now() + deadlineMs;
    const abortFromOuter = (): void => {
      invocation.controller.abort(signal?.reason ?? abortError());
    };
    if (signal?.aborted) abortFromOuter();
    else signal?.addEventListener('abort', abortFromOuter, { once: true });
    try {
      await this.withInvocationDeadline(
        invocation,
        deadlineAt,
        'Playback startup timed out',
        true,
        async () => {
          try {
            await this.loadInternal(request, signal, true, false, invocation);
          } catch (error) {
            if (!this.isInvocationAuthoritative(invocation))
              throw this.staleInvocationFault(invocation);
            if (isAbortError(error)) throw error;
            await this.handlePlaybackFailure(
              error,
              'load',
              invocation.operation,
              invocation,
            );
            this.ensureInvocationLease(invocation);
            if (this.state.phase === 'error')
              throw this.boundaryFault(error, 'DEMUX_FAILED', 'Playback load failed');
            this.ensureInvocationCurrent(invocation);
          }
        },
      );
    } catch (error) {
      if (!this.isInvocationAuthoritative(invocation))
        throw this.staleInvocationFault(invocation);
      if (error instanceof EngineFault && error.code === 'NETWORK_TIMEOUT')
        await this.fail(error, invocation.operation);
      throw this.boundaryFault(error, 'DEMUX_FAILED', 'Playback load failed');
    } finally {
      signal?.removeEventListener('abort', abortFromOuter);
      this.releaseInvocation(invocation);
    }
  }

  async dispatch(command: PlayerCommand): Promise<void> {
    this.assertAlive();
    this.assertOperationAcceptsCommands();
    const invocation = this.createInvocation(this.operation, this.commandDomain(command));
    const initialOperation = invocation.operation;
    const priorState = structuredClone(this.state);
    const priorSubtitleCues = [...this.subtitleCues];
    const commandDeadlineAt =
      this.services.now() +
      (this.session
        ? this.startupTimeoutFor(this.session)
        : this.policy.startupTimeoutMs.direct);
    try {
      const nonfatalSelection =
        command.type === 'select-quality' ||
        command.type === 'select-audio-track' ||
        command.type === 'select-subtitle-track' ||
        command.type === 'extract-subtitles';
      await this.withInvocationDeadline(
        invocation,
        commandDeadlineAt,
        `Playback ${command.type} timed out`,
        () => !nonfatalSelection || invocation.operation !== initialOperation,
        () => this.executeCommand(command, invocation),
      );
    } catch (error) {
      const nonfatalSelection =
        invocation.operation === initialOperation &&
        (command.type === 'select-quality' ||
          command.type === 'select-audio-track' ||
          command.type === 'select-subtitle-track' ||
          command.type === 'extract-subtitles');
      if (!this.isInvocationAuthoritative(invocation))
        throw this.staleInvocationFault(invocation);
      if (nonfatalSelection) {
        if (command.type === 'select-subtitle-track')
          invocation.operation.subtitleController?.abort(abortError());
        this.state.selectedQualityId = priorState.selectedQualityId;
        this.state.selectedAudioTrackId = priorState.selectedAudioTrackId;
        this.state.selectedSubtitleTrackId = priorState.selectedSubtitleTrackId;
        this.subtitleCues = priorSubtitleCues;
        this.state.activeSubtitleCues = activeCuesAt(
          this.subtitleCues,
          this.state.positionSeconds,
        );
        this.emitState();
        this.ensureInvocationLease(invocation);
        throw this.boundaryFault(error, 'DEMUX_FAILED', 'Player selection failed');
      }
      if (error instanceof EngineFault && error.code === 'NETWORK_TIMEOUT') {
        await this.fail(error, invocation.operation);
        throw error;
      }
      await this.handlePublicFailure(
        error,
        `command:${command.type}`,
        invocation.operation,
      );
      if (!this.isInvocationAuthoritative(invocation))
        throw this.staleInvocationFault(invocation);
      throw this.boundaryFault(error, 'DEMUX_FAILED', 'Player command failed');
    } finally {
      this.releaseInvocation(invocation);
    }
  }

  async unlockAudio(): Promise<void> {
    this.assertAlive();
    this.assertOperationAcceptsCommands();
    const invocation = this.createInvocation(this.operation, 'audio');
    const deadlineAt =
      this.services.now() +
      (this.session
        ? this.startupTimeoutFor(this.session)
        : this.policy.startupTimeoutMs.direct);
    try {
      this.audioContext ??= new AudioContext({ latencyHint: 'playback' });
      const context = this.audioContext;
      if (context.state === 'closed')
        throw new EngineFault('AUDIO_LOCKED', 'Audio output is closed');
      if (context.state !== 'running') {
        await this.withInvocationDeadline(
          invocation,
          deadlineAt,
          'Audio unlock timed out',
          false,
          () => context.resume(),
        );
      }
      this.ensureInvocationCurrent(invocation);
      this.state.audioUnlocked = context.state === 'running';
      this.state.diagnostics.audioContextState = audioContextState(context);
      if (!this.state.audioUnlocked)
        throw new EngineFault('AUDIO_LOCKED', 'Audio output requires a user gesture', {
          retryable: true,
        });
      this.ensureGain(invocation.operation);
      this.emitState();
      this.ensureInvocationCurrent(invocation);
      if (this.state.phase === 'playing') await this.restartAtCurrentPosition(invocation);
    } catch (error) {
      if (!this.isInvocationAuthoritative(invocation))
        throw this.staleInvocationFault(invocation);
      this.state.audioUnlocked = false;
      this.state.diagnostics.audioContextState = audioContextState(this.audioContext);
      this.emit({ type: 'audio-unlock-required' });
      if (!this.isInvocationAuthoritative(invocation))
        throw this.staleInvocationFault(invocation);
      this.emitState();
      if (!this.isInvocationAuthoritative(invocation))
        throw this.staleInvocationFault(invocation);
      throw this.boundaryFault(error, 'AUDIO_LOCKED', 'Audio unlock failed');
    } finally {
      this.releaseInvocation(invocation);
    }
  }

  private async executeCommand(
    command: PlayerCommand,
    invocation: InvocationAuthority,
  ): Promise<void> {
    this.ensureInvocationCurrent(invocation);
    switch (command.type) {
      case 'play':
        await this.play(invocation);
        return;
      case 'pause':
        await this.pause(invocation);
        return;
      case 'stop':
        await this.stop(invocation);
        return;
      case 'seek':
        await this.seek(command.positionSeconds, undefined, invocation);
        return;
      case 'set-volume':
        this.state.volume = command.volume;
        this.applyGain(invocation.operation);
        this.ensureInvocationCurrent(invocation);
        this.emitState();
        this.ensureInvocationCurrent(invocation);
        return;
      case 'set-muted':
        this.state.muted = command.muted;
        this.applyGain(invocation.operation);
        this.ensureInvocationCurrent(invocation);
        this.emitState();
        this.ensureInvocationCurrent(invocation);
        return;
      case 'set-rate':
        await this.setRate(command.rate, invocation);
        return;
      case 'set-av-offset':
        this.state.diagnostics.signedAvOffsetMs = clamp(
          command.signedAvOffsetMs,
          -this.policy.maxSignedAvOffsetMs,
          this.policy.maxSignedAvOffsetMs,
        );
        await this.restartAtCurrentPosition(invocation);
        return;
      case 'set-rotation':
        this.state.rotationDegrees = command.degrees;
        this.renderer.redrawPicture(this.state);
        this.emitState();
        this.ensureInvocationCurrent(invocation);
        return;
      case 'set-aspect-mode':
        this.state.aspectMode = command.mode;
        this.renderer.redrawPicture(this.state);
        this.emitState();
        this.ensureInvocationCurrent(invocation);
        return;
      case 'select-quality':
        await this.select({ qualityId: command.qualityId }, invocation);
        return;
      case 'select-audio-track':
        await this.select({ audioTrackId: command.trackId }, invocation);
        return;
      case 'select-subtitle-track':
        await this.selectSubtitle(command.trackId, invocation);
        return;
      case 'extract-subtitles':
        await this.extractSubtitles(invocation);
        return;
      case 'recover':
        await this.recover(
          command.hard,
          command.reason,
          invocation.operation,
          invocation,
        );
        return;
      default:
        throw new EngineFault('BAD_REQUEST', 'Unsupported player command');
    }
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    this.destroyPromise = this.destroyInternal();
    return this.destroyPromise;
  }

  private async destroyInternal(): Promise<void> {
    const old = this.operation;
    const replacement = this.createOperation(old.generation + 1);
    replacement.controller.abort();
    replacement.disposed = true;
    this.operation = replacement;
    this.abortOperation(old);
    await this.drainOperation(old);
    if (
      this.audioContext &&
      this.ownsAudioContext &&
      this.audioContext.state !== 'closed'
    ) {
      try {
        await this.withCleanupDeadline(this.audioContext.close());
      } catch {
        // Browser AudioContext shutdown is best-effort after bounded task cleanup.
      }
    }
    this.audioContext = null;
    this.request = null;
    this.session = null;
    this.renderer.clearPicture();
    this.subtitleCues = [];
    this.state.phase = 'destroyed';
    this.state.audioUnlocked = false;
    this.state.diagnostics.audioContextState = 'closed';
    this.emitState();
    this.listeners.clear();
  }

  private async loadInternal(
    request: PlayerLoadRequest,
    outerSignal: AbortSignal | undefined,
    resetPosition: boolean,
    preserveCounters: boolean,
    invocation: InvocationAuthority,
  ): Promise<void> {
    const previousDiagnostics = this.state.diagnostics;
    const operation = this.replaceOperation(outerSignal, invocation);
    this.ensureInvocationCurrent(invocation);
    this.renderer.clearPicture();
    this.request = request;
    this.session = request.session;
    this.subtitleCues = [];
    const requestedQuality = request.preferredQualityId;
    if (
      requestedQuality !== null &&
      !request.session.qualities.some((quality) => quality.id === requestedQuality)
    )
      throw new EngineFault('BAD_REQUEST', 'Requested quality is unavailable');
    const requestedAudio = request.preferredAudioTrackId;
    if (
      requestedAudio !== null &&
      !request.session.tracks.some(
        (track) => track.kind === 'audio' && track.id === requestedAudio,
      )
    )
      throw new EngineFault('BAD_REQUEST', 'Requested audio track is unavailable');
    const requestedSubtitle = request.preferredSubtitleTrackId;
    if (
      requestedSubtitle !== null &&
      !request.session.subtitles.some((track) => track.id === requestedSubtitle)
    )
      throw new EngineFault('BAD_REQUEST', 'Requested subtitle track is unavailable');

    const initialStart = resetPosition
      ? (request.resumePositionSeconds ?? 0)
      : this.state.positionSeconds;
    this.clock.seek(initialStart, this.services.now());
    this.state = {
      ...this.initialSnapshot(),
      generation: operation.generation,
      phase: 'loading',
      sessionId: request.session.id,
      isLive: request.session.isLive,
      positionSeconds: initialStart,
      playbackRate: this.state.playbackRate,
      volume: this.state.volume,
      muted: this.state.muted,
      rotationDegrees: this.state.rotationDegrees,
      aspectMode: this.state.aspectMode ?? 'fit',
      qualities: request.session.qualities,
      selectedQualityId: null,
      audioTracks: request.session.tracks.filter((track) => track.kind === 'audio'),
      selectedAudioTrackId: null,
      subtitleTracks: request.session.subtitles,
      selectedSubtitleTrackId: requestedSubtitle,
      activeSubtitleCues: [],
      diagnostics: {
        ...this.initialSnapshot().diagnostics,
        generation: operation.generation,
        route: request.session.route,
        streamKind: request.session.streamKind,
        signedAvOffsetMs: clamp(
          request.signedAvOffsetMs,
          -this.policy.maxSignedAvOffsetMs,
          this.policy.maxSignedAvOffsetMs,
        ),
        retryCount: preserveCounters ? previousDiagnostics.retryCount : 0,
        stallCount: preserveCounters ? previousDiagnostics.stallCount : 0,
        hardRecoveryCount: preserveCounters ? previousDiagnostics.hardRecoveryCount : 0,
        routeDemotionCount: preserveCounters ? previousDiagnostics.routeDemotionCount : 0,
      },
    };
    this.emitState();
    this.ensureInvocationCurrent(invocation);
    this.rejectProtection(request.session);
    if (
      request.session.route === 'direct' &&
      this.dependencies.openPipeline === undefined
    ) {
      try {
        await this.probeDirectEndpoints(request.session, operation);
      } catch (error) {
        this.ensureCurrent(operation);
        this.ensureInvocationCurrent(invocation);
        const demote = this.services.requestRouteDemotion?.bind(this.services);
        if (!demote) throw error;
        if (this.state.diagnostics.routeDemotionCount >= this.policy.maxRouteDemotions)
          throw new EngineFault(
            'RECOVERY_EXHAUSTED',
            'Direct-route demotion limit reached',
          );
        this.state.diagnostics.routeDemotionCount++;
        const replacement = await demote(
          request.session.id,
          `trusted-direct probe: ${safeErrorCause(error)}`,
          invocation.controller.signal,
          request.session.generationId,
        );
        this.ensureInvocationCurrent(invocation);
        await this.loadInternal(
          { ...request, session: replacement },
          undefined,
          resetPosition,
          true,
          invocation,
        );
        return;
      }
    }
    if (request.session.streamKind === 'flv') {
      await this.requestCompatibility(
        'flv-remux',
        'FLV requires server codec-copy remux',
        initialStart,
        operation,
        invocation,
      );
      return;
    }

    const localPipeline = await this.awaitOperation(operation, () =>
      this.openPipeline(request.session, operation),
    );
    this.ensureCurrent(operation);
    operation.pipeline = localPipeline;
    const metadata = await this.inspectTracks(localPipeline, operation, invocation);
    if (metadata === null) return;
    this.ensureInvocationCurrent(invocation);
    this.applyPipelineMetadata(localPipeline, metadata);

    let start = initialStart;
    if (
      request.session.isLive &&
      request.startAtLiveEdge &&
      request.resumePositionSeconds === null
    ) {
      const edge = localPipeline.seekableEnd;
      const refresh = localPipeline.liveRefreshSeconds;
      if (edge !== null && refresh !== null)
        start = Math.max(
          localPipeline.seekableStart,
          edge - refresh * this.policy.liveEdgeTargetDurations,
        );
    }
    start = this.clampToSeekWindow(start);
    this.state.positionSeconds = start;
    this.clock.seek(start, this.services.now());
    if (
      request.session.subtitles.some(
        (track) => track.id === requestedSubtitle && track.origin === 'demuxed',
      )
    ) {
      await this.extractSubtitles(invocation, requestedSubtitle ?? undefined);
    } else {
      await this.loadSelectedSubtitles(operation);
    }
    this.ensureInvocationCurrent(invocation);
    this.state.phase = 'ready';
    this.lastProgressMonotonic = this.services.now();
    this.emitState();
    this.ensureInvocationCurrent(invocation);
    this.reportDetached(
      'lifecycle',
      'ready',
      {
        durationSeconds: this.state.durationSeconds,
      },
      operation,
    );
    this.ensureInvocationCurrent(invocation);
    this.startLiveRefresh(operation);
    if (request.autoplay) await this.play(invocation);
  }

  private async play(invocation: InvocationAuthority): Promise<void> {
    const operation = invocation.operation;
    this.ensureInvocationCurrent(invocation);
    this.assertOperationAcceptsCommands();
    if (!this.session || !this.request)
      throw new EngineFault('BAD_REQUEST', 'No media is loaded');
    if (this.state.phase === 'playing') return;
    if (this.state.phase === 'ended') {
      await this.seek(this.state.seekableStartSeconds ?? 0, true, invocation);
      return;
    }
    if (!operation.pipeline) {
      const local = await this.openPipeline(this.session, operation);
      this.ensureInvocationCurrent(invocation);
      operation.pipeline = local;
      const metadata = await this.inspectTracks(local, operation, invocation);
      this.ensureInvocationCurrent(invocation);
      if (metadata === null) return;
      this.applyPipelineMetadata(local, metadata);
    }
    const pipeline = operation.pipeline;
    this.state.audioUnlocked = isAudioContextRunning(this.audioContext);
    this.state.diagnostics.audioContextState = audioContextState(this.audioContext);
    // Playback needs a local gesture before audio output and decoder work begin.
    if (pipeline.audioTrack && !isAudioContextRunning(this.audioContext)) {
      this.emitState();
      this.ensureInvocationCurrent(invocation);
      this.emit({ type: 'audio-unlock-required' });
      return;
    }
    const start = this.clampToSeekWindow(this.state.positionSeconds);
    const now = this.services.now();
    this.clock.start(start, now);
    // Reopening after a pause can take seconds. History and recovery must stay
    // at the saved place until the first decoded sound establishes the clock.
    if (pipeline.audioTrack) this.clock.pause(now);
    operation.basePresentationTime = this.presentationNow();
    operation.nextAudioTime =
      operation.basePresentationTime +
      0.05 +
      presentationDelaySeconds('audio', this.state.diagnostics.signedAvOffsetMs);
    operation.lastVideoTimestamp = null;
    operation.audioEnded = false;
    this.state.phase = 'playing';
    this.startLiveRefresh(operation);
    this.lastProgressMonotonic = this.services.now();
    this.startStateTimer(operation);
    this.emitState();
    this.ensureInvocationCurrent(invocation);
    const tasks: Promise<void>[] = [];
    if (pipeline.videoTrack)
      tasks.push(
        this.runVideo(pipeline.videoTrack, pipeline.timelineOrigin, start, operation),
      );
    if (pipeline.audioTrack)
      tasks.push(
        this.runAudio(
          pipeline.audioTrack,
          pipeline.timelineOrigin,
          start,
          operation,
        ).then(() => {
          operation.audioEnded = true;
        }),
      );
    const playback = Promise.all(tasks).then(() => {
      if (!this.isCurrent(operation) || this.state.phase !== 'playing') return;
      this.updatePosition();
      if (!this.state.isLive) this.finishNaturalEnd(operation);
    });
    void this.trackTask(
      operation,
      playback.catch(async (error: unknown) => {
        if (this.isCancellation(error, operation)) return;
        await this.handlePlaybackFailure(error, 'decode', operation);
      }),
    );
  }

  private async pause(invocation: InvocationAuthority): Promise<void> {
    this.ensureInvocationCurrent(invocation);
    if (this.state.phase !== 'playing' && this.state.phase !== 'stalled') return;
    this.state.positionSeconds = this.clock.pause(
      this.services.now(),
      this.playheadAudioTime(),
    );
    const old = this.operation;
    this.replaceOperation(undefined, invocation);
    this.ensureInvocationCurrent(invocation);
    await this.drainOperation(old);
    this.ensureInvocationCurrent(invocation);
    this.state.phase = 'paused';
    this.emitState();
    this.ensureInvocationCurrent(invocation);
  }

  private async stop(invocation: InvocationAuthority): Promise<void> {
    this.ensureInvocationCurrent(invocation);
    const old = this.operation;
    this.replaceOperation(undefined, invocation);
    this.ensureInvocationCurrent(invocation);
    await this.drainOperation(old);
    this.ensureInvocationCurrent(invocation);
    const start = this.state.seekableStartSeconds ?? 0;
    this.state.positionSeconds = start;
    this.clock.seek(start, this.services.now());
    this.state.phase = 'stopped';
    this.state.activeSubtitleCues = [];
    this.emitState();
    this.ensureInvocationCurrent(invocation);
  }

  private async seek(
    positionSeconds: number,
    resumeOverride: boolean | undefined,
    invocation: InvocationAuthority,
  ): Promise<void> {
    this.ensureInvocationCurrent(invocation);
    if (!this.request || !this.session) return;
    const wasPlaying =
      resumeOverride ??
      (this.state.phase === 'playing' || this.state.phase === 'stalled');
    const target = this.clampToSeekWindow(positionSeconds);
    this.state.phase = 'seeking';
    this.emitState();
    this.ensureInvocationCurrent(invocation);
    const old = this.operation;
    const operation = this.replaceOperation(undefined, invocation);
    this.ensureInvocationCurrent(invocation);
    await this.drainOperation(old);
    this.ensureInvocationCurrent(invocation);
    this.state.positionSeconds = target;
    this.clock.seek(target, this.services.now());
    const local = await this.openPipeline(this.session, operation);
    this.ensureInvocationCurrent(invocation);
    operation.pipeline = local;
    const metadata = await this.inspectTracks(local, operation, invocation);
    this.ensureInvocationCurrent(invocation);
    if (metadata === null) return;
    this.applyPipelineMetadata(local, metadata);
    await this.loadSelectedSubtitles(operation);
    this.ensureInvocationCurrent(invocation);
    this.state.activeSubtitleCues = activeCuesAt(this.subtitleCues, target);
    this.state.phase = wasPlaying ? 'ready' : 'paused';
    this.startLiveRefresh(operation);
    this.emitState();
    this.ensureInvocationCurrent(invocation);
    if (wasPlaying) await this.play(invocation);
  }

  private async setRate(rate: number, invocation: InvocationAuthority): Promise<void> {
    this.ensureInvocationCurrent(invocation);
    this.clock.setRate(rate, this.services.now(), this.audioContext?.currentTime);
    this.state.playbackRate = rate;
    await this.restartAtCurrentPosition(invocation);
  }

  private async restartAtCurrentPosition(invocation: InvocationAuthority): Promise<void> {
    this.ensureInvocationCurrent(invocation);
    if (this.state.phase !== 'playing' && this.state.phase !== 'stalled') {
      this.emitState();
      this.ensureInvocationCurrent(invocation);
      return;
    }
    this.updatePosition();
    await this.seek(this.state.positionSeconds, undefined, invocation);
  }

  private async select(
    selection: {
      qualityId?: string;
      audioTrackId?: string;
    },
    invocation: InvocationAuthority,
  ): Promise<void> {
    const session = this.session;
    const request = this.request;
    if (!session || !request) return;
    if (!this.services.requestSelection)
      throw new EngineFault('BAD_REQUEST', 'Server selection callback is unavailable');
    if (
      selection.qualityId !== undefined &&
      !session.qualities.some((quality) => quality.id === selection.qualityId)
    )
      throw new EngineFault('BAD_REQUEST', 'Requested quality is unavailable');
    if (
      selection.audioTrackId !== undefined &&
      !session.tracks.some(
        (track) => track.kind === 'audio' && track.id === selection.audioTrackId,
      )
    )
      throw new EngineFault('BAD_REQUEST', 'Requested audio track is unavailable');
    const wasPlaying = this.state.phase === 'playing';
    this.updatePosition();
    const position = this.state.positionSeconds;
    const requestSelection = this.services.requestSelection.bind(this.services);
    const replacement = await requestSelection(
      session.id,
      { ...selection, expectedGenerationId: this.expectedGenerationId(session) },
      invocation.controller.signal,
    );
    this.ensureInvocationCurrent(invocation);
    const nextRequest: PlayerLoadRequest = {
      ...request,
      session: replacement,
      autoplay: wasPlaying,
      resumePositionSeconds: position,
      preferredQualityId: selection.qualityId ?? this.state.selectedQualityId,
      preferredAudioTrackId: selection.audioTrackId ?? this.state.selectedAudioTrackId,
      preferredSubtitleTrackId: this.state.selectedSubtitleTrackId,
      signedAvOffsetMs: this.state.diagnostics.signedAvOffsetMs,
    };
    await this.loadInternal(nextRequest, undefined, true, true, invocation);
  }

  private async selectSubtitle(
    trackId: string | null,
    invocation: InvocationAuthority,
  ): Promise<void> {
    const operation = invocation.operation;
    const selected =
      trackId === null
        ? undefined
        : this.session?.subtitles.find((track) => track.id === trackId);
    if (trackId !== null && selected === undefined)
      throw new EngineFault('BAD_REQUEST', 'Requested subtitle track is unavailable');
    if (selected?.origin === 'demuxed') {
      await this.extractSubtitles(invocation, selected.id);
      return;
    }
    operation.subtitleEpoch++;
    operation.subtitleController?.abort();
    const subtitleController = new AbortController();
    operation.subtitleController = subtitleController;
    const abortSubtitleInvocation = (): void => {
      subtitleController.abort(invocation.controller.signal.reason);
    };
    if (invocation.controller.signal.aborted) abortSubtitleInvocation();
    else
      invocation.controller.signal.addEventListener('abort', abortSubtitleInvocation, {
        once: true,
      });
    this.state.selectedSubtitleTrackId = trackId;
    this.subtitleCues = [];
    this.state.activeSubtitleCues = [];
    const epoch = operation.subtitleEpoch;
    try {
      if (trackId) await this.loadSelectedSubtitles(operation, epoch);
      this.ensureInvocationCurrent(invocation);
      this.ensureSubtitleCurrent(operation, epoch, trackId);
      this.state.activeSubtitleCues = activeCuesAt(
        this.subtitleCues,
        this.state.positionSeconds,
      );
      this.emitState();
      this.ensureInvocationCurrent(invocation);
    } finally {
      invocation.controller.signal.removeEventListener('abort', abortSubtitleInvocation);
    }
  }

  private async extractSubtitles(
    invocation: InvocationAuthority,
    requestedTrackId?: string,
  ): Promise<void> {
    const session = this.session;
    const request = this.request;
    if (!session || !request) return;
    const target =
      requestedTrackId === undefined
        ? (session.subtitles.find(
            (track) => track.origin === 'demuxed' && track.default,
          ) ?? session.subtitles.find((track) => track.origin === 'demuxed'))
        : session.subtitles.find((track) => track.id === requestedTrackId);
    if (target?.origin === 'server-extracted') {
      await this.selectSubtitle(target.id, invocation);
      return;
    }
    if (
      target?.origin !== 'demuxed' ||
      target.selector?.kind !== 'file-track' ||
      target.selector.trackKind !== 'subtitle'
    ) {
      throw new EngineFault(
        'DEMUX_FAILED',
        'No supported embedded text subtitle is available',
      );
    }
    const requestCompatibility = this.services.requestCompatibility.bind(this.services);
    const replacement = await requestCompatibility(
      session.id,
      'subtitle-extract',
      `User selected embedded text subtitle ${target.id}`,
      invocation.controller.signal,
      undefined,
      session.generationId,
      target.id,
    );
    this.ensureInvocationCurrent(invocation);
    const extracted = replacement.subtitles.find(
      (track) => track.id === target.id && track.origin === 'server-extracted',
    );
    if (!extracted) {
      throw new EngineFault(
        'DEMUX_FAILED',
        'The selected embedded text subtitle was not extracted',
      );
    }
    this.session = replacement;
    this.request = {
      ...request,
      session: replacement,
      preferredSubtitleTrackId: extracted.id,
    };
    this.state.subtitleTracks = replacement.subtitles;
    await this.selectSubtitle(extracted.id, invocation);
  }

  private recover(
    hard: boolean,
    reason: string,
    operation: Operation,
    invocation?: InvocationAuthority,
  ): Promise<void> {
    if (operation.recoveryTask) return operation.recoveryTask;
    const recoveryInvocation = invocation ?? this.createInvocation(operation);
    const ownsInvocation = invocation === undefined;
    const recovery = this.withInvocationDeadline(
      recoveryInvocation,
      this.services.now() +
        (this.session
          ? this.startupTimeoutFor(this.session)
          : this.policy.startupTimeoutMs.provider),
      'Playback recovery timed out',
      true,
      () =>
        this.recoverSerial(hard, safePublicText(reason), operation, recoveryInvocation),
    )
      .catch(async (error: unknown) => {
        if (
          error instanceof EngineFault &&
          error.code === 'NETWORK_TIMEOUT' &&
          this.isInvocationAuthoritative(recoveryInvocation)
        )
          await this.fail(error, recoveryInvocation.operation);
        throw error;
      })
      .finally(() => {
        if (ownsInvocation) this.releaseInvocation(recoveryInvocation);
        if (operation.recoveryTask === recovery) operation.recoveryTask = null;
      });
    operation.recoveryTask = recovery;
    return recovery;
  }

  private async recoverSerial(
    hard: boolean,
    reason: string,
    operation: Operation,
    invocation: InvocationAuthority,
  ): Promise<void> {
    this.ensureInvocationCurrent(invocation);
    if (!hard) {
      this.state.diagnostics.stallCount++;
      this.updatePosition();
      const position = this.state.positionSeconds;
      const shouldResume =
        this.state.phase === 'playing' || this.state.phase === 'stalled';
      this.reportDetached('recovery', 'soft', { reason }, operation);
      this.ensureInvocationCurrent(invocation);
      if (shouldResume) {
        this.state.phase = 'stalled';
        await this.seek(position, undefined, invocation);
      }
      return;
    }
    if (this.state.diagnostics.hardRecoveryCount >= this.policy.maxHardRecoveries) {
      await this.fail(
        new EngineFault('RECOVERY_EXHAUSTED', 'Hard recovery limit reached', {
          safeCause: reason,
        }),
        operation,
      );
      return;
    }
    this.state.diagnostics.hardRecoveryCount++;
    const attempt = this.state.diagnostics.hardRecoveryCount;
    const shouldResume = this.state.phase === 'playing' || this.state.phase === 'stalled';
    this.updatePosition();
    const position = this.state.positionSeconds;
    this.state.phase = 'seeking';
    this.emitState();
    this.ensureInvocationCurrent(invocation);
    this.reportDetached('recovery', 'hard', { reason, attempt }, operation);
    this.ensureInvocationCurrent(invocation);
    await this.seek(position, shouldResume, invocation);
  }

  private async openPipeline(
    session: PlaybackSession,
    operation: Operation,
  ): Promise<EnginePipeline> {
    if (this.dependencies.openPipeline) {
      const pipeline = await this.dependencies.openPipeline({
        session,
        signal: operation.controller.signal,
        registerInput: (input) => {
          this.registerInput(operation, input);
        },
      });
      this.ensureCurrent(operation);
      return pipeline;
    }
    const inputs: Input[] = [];
    const create = async (endpoint: PlaybackEndpoint): Promise<Input> => {
      this.ensureCurrent(operation);
      let input: Input;
      if (isContinuous(session)) {
        const response = await this.fetchEndpoint(endpoint, operation);
        this.ensureCurrent(operation);
        if (!response.ok || !response.body)
          throw new EngineFault('DEMUX_FAILED', 'Continuous stream request failed', {
            retryable: response.status >= 500,
            safeCause: `status=${String(response.status)}`,
          });
        input = this.dependencies.createInput({
          source: new ReadableStreamSource(response.body, {
            maxCacheSize: this.policy.maxBufferedBytes,
            handleUnhandledError: (error) => {
              this.reportDetached(
                'error',
                'continuous-source-background-error',
                { cause: safeErrorCause(error) },
                operation,
              );
            },
          }),
          formats: ALL_FORMATS,
        });
      } else {
        const rootUrl = endpointUrl(endpoint);
        if (isHls(session)) {
          operation.hls.registerRoot(rootUrl, endpoint.route === 'direct');
        }
        const sourceOptions: ConstructorParameters<typeof UrlSource>[1] = {
          requestInit: {
            credentials: credentialsFor(endpoint),
            redirect: 'error',
            referrerPolicy: 'no-referrer',
          },
          maxCacheSize: this.policy.maxBufferedBytes,
          parallelism: 2,
          // Transport retries belong to policyFetch, including HTTP failures.
          getRetryDelay: () => null,
          fetchFn: (fetchInput, init) =>
            this.policyFetch(endpoint, fetchInput, init, session, operation),
          handleUnhandledError: (error) => {
            this.reportDetached(
              'error',
              'source-background-error',
              { cause: safeErrorCause(error) },
              operation,
            );
          },
        };
        const source = isHls(session)
          ? new CustomPathedSource(rootUrl, async ({ path }) => {
              this.ensureCurrent(operation);
              const resource = operation.hls.getResource(path);
              if (!resource)
                throw new EngineFault(
                  'HLS_MANIFEST_INVALID',
                  'HLS requested an unclassified child resource',
                );
              if (['playlist', 'variant', 'rendition'].includes(resource.kind)) {
                // Manifests are validated and bounded before being buffered.
                // They are complete documents, not range-addressed video files.
                // Each live refresh requests a fresh source through this handler.
                const response = await this.policyFetch(
                  endpoint,
                  path,
                  sourceOptions.requestInit,
                  session,
                  operation,
                );
                if (!response.ok)
                  throw new EngineFault(
                    'HLS_MANIFEST_INVALID',
                    'HLS playlist request failed',
                    { safeCause: `status=${String(response.status)}` },
                  );
                const bytes = new Uint8Array(await response.arrayBuffer());
                this.ensureCurrent(operation);
                return new BufferSource(bytes);
              }
              return new UrlSource(path, sourceOptions);
            })
          : new UrlSource(rootUrl, sourceOptions);
        input = this.dependencies.createInput({
          source,
          formats: isHls(session) ? HLS_FORMATS : ALL_FORMATS,
          formatOptions: { hls: { offsetTimestampsByDateTime: false } },
        });
      }
      this.registerInput(operation, input);
      inputs.push(input);
      return input;
    };

    try {
      if (
        session.streamKind === 'dual-input' ||
        (endpointFor(session, 'audio') && endpointFor(session, 'manifest'))
      ) {
        const videoEndpoint =
          endpointFor(session, 'video') ?? endpointFor(session, 'manifest');
        const audioEndpoint = endpointFor(session, 'audio');
        if (!videoEndpoint || !audioEndpoint)
          throw new EngineFault('DEMUX_FAILED', 'Dual input endpoints are incomplete');
        const [videoInput, audioInput] = await Promise.all([
          create(videoEndpoint),
          create(audioEndpoint),
        ]);
        this.ensureCurrent(operation);
        const [videoSelection, audioSelection] = await Promise.all([
          this.chooseVideoTrack(videoInput, session, operation, videoEndpoint),
          this.chooseAudioTrack(audioInput, session, null, operation, audioEndpoint),
        ]);
        const videoTrack = videoSelection.track;
        const audioTrack = audioSelection.track;
        this.ensureCurrent(operation);
        const [videoFirst, audioFirst, videoDuration, audioDuration] = await Promise.all([
          videoTrack?.getFirstTimestamp(),
          audioTrack?.getFirstTimestamp(),
          videoTrack
            ? this.startupDuration(videoInput, [videoTrack], session)
            : undefined,
          audioTrack
            ? this.startupDuration(audioInput, [audioTrack], session)
            : undefined,
        ]);
        this.ensureCurrent(operation);
        const finiteStarts = [videoFirst, audioFirst].filter(
          (value): value is number => typeof value === 'number' && Number.isFinite(value),
        );
        const origin = finiteStarts.length > 0 ? Math.min(...finiteStarts) : 0;
        const finiteEnds = [videoDuration, audioDuration].filter(
          (value): value is number => typeof value === 'number' && Number.isFinite(value),
        );
        const rawEnd = finiteEnds.length > 0 ? Math.max(...finiteEnds) : null;
        return {
          inputs,
          videoTrack,
          audioTrack,
          timelineOrigin: origin,
          duration: rawEnd === null ? null : Math.max(0, rawEnd - origin),
          seekableStart: 0,
          seekableEnd: rawEnd === null ? null : Math.max(0, rawEnd - origin),
          liveRefreshSeconds: null,
          actualQualityId: videoSelection.id,
          actualAudioTrackId: audioSelection.id,
        };
      }

      const endpoint =
        endpointFor(session, isHls(session) ? 'manifest' : 'muxed') ??
        session.endpoints[0];
      if (!endpoint)
        throw new EngineFault('DEMUX_FAILED', 'Playback session has no endpoint');
      const input = await create(endpoint);
      if (!(await input.canRead()))
        throw new EngineFault('DEMUX_FAILED', 'Unsupported or invalid media container');
      this.ensureCurrent(operation);
      const videoSelection = await this.chooseVideoTrack(
        input,
        session,
        operation,
        endpoint,
      );
      const audioSelection = await this.chooseAudioTrack(
        input,
        session,
        videoSelection.track,
        operation,
        endpoint,
      );
      const tracks = [videoSelection.track, audioSelection.track].filter(
        (track): track is InputVideoTrack | InputAudioTrack => track !== null,
      );
      const [firstTimestamp, rawDuration, refreshIntervals] = await Promise.all([
        tracks.length > 0 ? input.getFirstTimestamp(tracks) : Promise.resolve(0),
        this.startupDuration(input, tracks, session),
        Promise.all(tracks.map((track) => track.getLiveRefreshInterval())),
      ]);
      this.ensureCurrent(operation);
      const origin = Number.isFinite(firstTimestamp) ? firstTimestamp : 0;
      const normalizedEnd =
        Number.isFinite(rawDuration) && rawDuration !== null
          ? Math.max(0, rawDuration - origin)
          : null;
      const refresh = refreshIntervals.find(
        (value): value is number => typeof value === 'number' && value > 0,
      );
      return {
        inputs,
        videoTrack: videoSelection.track,
        audioTrack: audioSelection.track,
        timelineOrigin: origin,
        duration: session.isLive ? null : normalizedEnd,
        seekableStart:
          session.isLive && normalizedEnd !== null
            ? Math.max(
                0,
                normalizedEnd -
                  (operation.hls.liveWindowDurationSeconds ?? normalizedEnd),
              )
            : 0,
        seekableEnd: normalizedEnd,
        liveRefreshSeconds: refresh ?? null,
        actualQualityId: videoSelection.id,
        actualAudioTrackId: audioSelection.id,
      };
    } catch (error) {
      for (const input of inputs) this.disposeInput(input);
      throw error;
    }
  }

  private async startupDuration(
    input: Input,
    tracks: (InputVideoTrack | InputAudioTrack)[],
    session: PlaybackSession,
  ): Promise<number | null> {
    const metadata = await input.getDurationFromMetadata(tracks, { skipLiveWait: true });
    if (metadata !== null && Number.isFinite(metadata) && metadata > 0) return metadata;
    // Live duration is its rolling window, never an end-of-stream scan.
    return session.isLive
      ? metadata
      : input.computeDuration(tracks, { skipLiveWait: true });
  }

  private async chooseVideoTrack(
    input: Input,
    session: PlaybackSession,
    operation: Operation,
    endpoint: PlaybackEndpoint,
  ): Promise<{ track: InputVideoTrack | null; id: string | null }> {
    const tracks = await input.getVideoTracks();
    this.ensureCurrent(operation);
    if (tracks.length === 0) return { track: null, id: null };
    const requestedId =
      this.request?.preferredQualityId ?? session.selectedQualityId ?? null;
    const desired = session.qualities.find((quality) => quality.id === requestedId);
    if (desired?.selector?.kind === 'file-track') {
      const selector = desired.selector;
      if (
        selector.resourceId !== endpoint.resourceId ||
        selector.trackKind !== 'video' ||
        selector.representation !== endpoint.representation ||
        selector.representationId !== endpoint.representationId
      ) {
        throw new EngineFault(
          'BAD_REQUEST',
          'Video selection does not match the pinned endpoint',
        );
      }
      const selected = tracks.find((track) => track.number === selector.trackNumber);
      if (!selected)
        throw new EngineFault('BAD_REQUEST', 'Selected video track is absent');
      return { track: selected, id: desired.id };
    }
    if (
      desired &&
      (desired.selector?.kind !== 'endpoint' ||
        desired.selector.resourceId !== endpoint.resourceId)
    )
      throw new EngineFault(
        'BAD_REQUEST',
        'Exact video track selector is required for quality selection',
      );
    const primary = await input.getPrimaryVideoTrack();
    this.ensureCurrent(operation);
    return {
      track: primary,
      id:
        desired?.id ??
        (tracks.length === 1 && session.qualities.length === 1
          ? (session.qualities[0]?.id ?? null)
          : null),
    };
  }

  private async chooseAudioTrack(
    input: Input,
    session: PlaybackSession,
    videoTrack: InputVideoTrack | null,
    operation: Operation,
    endpoint: PlaybackEndpoint,
  ): Promise<{ track: InputAudioTrack | null; id: string | null }> {
    const allTracks = await input.getAudioTracks();
    this.ensureCurrent(operation);
    if (allTracks.length === 0) return { track: null, id: null };
    const tracks = videoTrack ? await videoTrack.getPairableAudioTracks() : allTracks;
    this.ensureCurrent(operation);
    if (videoTrack && tracks.length === 0)
      throw new EngineFault('DEMUX_FAILED', 'Selected video has no pairable audio track');
    const requestedId =
      this.request?.preferredAudioTrackId ?? session.selectedAudioTrackId ?? null;
    const desired = session.tracks.find(
      (track) => track.kind === 'audio' && track.id === requestedId,
    );
    if (desired?.selector?.kind === 'file-track') {
      const selector = desired.selector;
      if (
        selector.resourceId !== endpoint.resourceId ||
        selector.trackKind !== 'audio' ||
        selector.representation !== endpoint.representation ||
        selector.representationId !== endpoint.representationId
      ) {
        throw new EngineFault(
          'BAD_REQUEST',
          'Audio selection does not match the pinned endpoint',
        );
      }
      const selected = tracks.find((track) => track.number === selector.trackNumber);
      if (!selected)
        throw new EngineFault(
          'BAD_REQUEST',
          'Selected audio track is absent or unpairable',
        );
      return { track: selected, id: desired.id };
    }
    if (
      desired &&
      (desired.selector?.kind !== 'endpoint' ||
        desired.selector.resourceId !== endpoint.resourceId)
    )
      throw new EngineFault(
        'BAD_REQUEST',
        'Exact audio track selector is required for audio selection',
      );
    const primary = videoTrack
      ? await videoTrack.getPrimaryPairableAudioTrack()
      : await input.getPrimaryAudioTrack();
    this.ensureCurrent(operation);
    const audioTracks = session.tracks.filter((track) => track.kind === 'audio');
    const onlyId = audioTracks.at(0)?.id ?? null;
    return {
      track: primary,
      id:
        desired?.id ?? (tracks.length === 1 && audioTracks.length === 1 ? onlyId : null),
    };
  }

  private async inspectTracks(
    pipeline: EnginePipeline,
    operation: Operation,
    invocation: InvocationAuthority,
  ): Promise<EnginePipelineMetadata | null> {
    if (this.dependencies.inspectPipeline)
      return this.dependencies.inspectPipeline(pipeline, operation.controller.signal);
    if (!pipeline.videoTrack && !pipeline.audioTrack)
      throw new EngineFault(
        'DEMUX_FAILED',
        'Media has no playable audio or video tracks',
      );
    const metadata: EnginePipelineMetadata = {
      duration: pipeline.duration,
      seekableStart: pipeline.seekableStart,
      seekableEnd: pipeline.seekableEnd,
    };
    if (pipeline.videoTrack) {
      const config = await pipeline.videoTrack.getDecoderConfig();
      this.ensureCurrent(operation);
      const capability = config
        ? await probeTrackDecoderCapability(config, 'video')
        : null;
      this.ensureCurrent(operation);
      const [codec, width, height] = await Promise.all([
        pipeline.videoTrack.getCodecParameterString(),
        pipeline.videoTrack.getCodedWidth(),
        pipeline.videoTrack.getCodedHeight(),
      ]);
      this.ensureCurrent(operation);
      metadata.videoCodec = codec;
      metadata.codedWidth = width;
      metadata.codedHeight = height;
      if (!capability?.supported) {
        await this.requestCompatibility(
          'full',
          'Video codec is unsupported by this browser',
          this.state.positionSeconds,
          operation,
          invocation,
        );
        return null;
      }
    }
    if (pipeline.audioTrack) {
      const config = await pipeline.audioTrack.getDecoderConfig();
      this.ensureCurrent(operation);
      const capability = config
        ? await probeTrackDecoderCapability(config, 'audio')
        : null;
      const codec = await pipeline.audioTrack.getCodecParameterString();
      this.ensureCurrent(operation);
      metadata.audioCodec = codec;
      if (!capability?.supported) {
        const firstPacket = await this.dependencies
          .createPacketSink(pipeline.audioTrack)
          .getFirstPacket({ skipLiveWait: true });
        this.ensureCurrent(operation);
        if (!firstPacket || detectMpegAudioLayer(firstPacket.data) !== 2) {
          await this.requestCompatibility(
            'audio-only',
            'Audio codec is unsupported by this browser',
            this.state.positionSeconds,
            operation,
            invocation,
          );
          return null;
        }
      }
    }
    return metadata;
  }

  private applyPipelineMetadata(
    pipeline: EnginePipeline,
    metadata: EnginePipelineMetadata,
  ): void {
    this.state.durationSeconds = this.session?.isLive ? null : metadata.duration;
    this.state.seekableStartSeconds = Math.max(0, metadata.seekableStart);
    this.state.seekableEndSeconds = metadata.seekableEnd;
    this.state.selectedQualityId = pipeline.actualQualityId;
    this.state.selectedAudioTrackId = pipeline.actualAudioTrackId;
    this.state.diagnostics.videoCodec = metadata.videoCodec ?? null;
    this.state.diagnostics.audioCodec = metadata.audioCodec ?? null;
    this.state.diagnostics.codedWidth = metadata.codedWidth ?? null;
    this.state.diagnostics.codedHeight = metadata.codedHeight ?? null;
  }

  private async runVideo(
    track: InputVideoTrack,
    timelineOrigin: number,
    start: number,
    operation: Operation,
  ): Promise<void> {
    let liveFrames = 0;
    let acceptedSubmissions = 0;
    const updateVideoQueueDepth = (): void => {
      if (this.isCurrent(operation))
        this.state.diagnostics.videoQueueDepth = liveFrames + acceptedSubmissions;
    };
    const queue = new BoundedAsyncQueue<OwnedVideoSample>(
      this.policy.maxVideoFrames,
      (sample) => {
        sample.close();
      },
    );
    operation.videoQueues.add(queue);
    const rawStart =
      timelineOrigin +
      (this.state.isLive ? start - (this.state.seekableStartSeconds ?? 0) : start);
    let videoController: BoundedVideoDecoderController | null = null;
    const currentVideoController = (): BoundedVideoDecoderController | null =>
      videoController;
    const producer = (async (): Promise<void> => {
      try {
        const config = await track.getDecoderConfig();
        this.ensureCurrent(operation);
        if (!config)
          throw new EngineFault('DECODE_FAILED', 'Video decoder config is unavailable');
        const controller = new BoundedVideoDecoderController({
          createDecoder: (init) => this.dependencies.createVideoDecoder(init),
          signal: operation.controller.signal,
          maxAcceptedSubmissions: this.policy.maxVideoFrames,
          maxAdmissionWaiters: this.policy.maxVideoFrames,
          maxFrameHandles: this.policy.maxVideoFrames + 1,
          reconciliationTimeoutMs: Math.max(
            this.policy.progressTimeoutMs,
            this.policy.hardStallMs,
          ),
          flushTimeoutMs: this.policy.hardStallMs,
          observe: (metrics) => {
            acceptedSubmissions = metrics.acceptedSubmissions;
            updateVideoQueueDepth();
          },
          onFrame: (owned) => {
            liveFrames++;
            updateVideoQueueDepth();
            const sample = this.ownControlledVideoFrame(owned, operation, () => {
              liveFrames--;
              updateVideoQueueDepth();
            });
            void queue
              .push(sample, operation.controller.signal)
              .catch((error: unknown) => {
                queue.close(error);
              });
          },
          onTerminal: (error) => {
            queue.close(error);
          },
        });
        videoController = controller;
        operation.videoDecoderControllers.add(controller);
        await controller.configure(config);
        const sink = this.dependencies.createPacketSink(track);
        const keyPacket =
          (await sink.getKeyPacket(rawStart, {
            skipLiveWait: false,
            verifyKeyPackets: true,
          })) ??
          (await sink.getFirstKeyPacket({
            skipLiveWait: false,
            verifyKeyPackets: true,
          }));
        this.ensureCurrent(operation);
        if (!keyPacket) {
          queue.end();
          return;
        }
        for await (const packet of sink.packets(keyPacket, undefined, {
          skipLiveWait: false,
          verifyKeyPackets: true,
        })) {
          this.ensureCurrent(operation);
          while (
            liveFrames + controller.snapshot.acceptedSubmissions >=
            this.policy.maxVideoFrames
          ) {
            await waitForDelay(1, operation.controller.signal);
            this.ensureCurrent(operation);
            if (controller.state === 'failed' || controller.state === 'closed') {
              throw new EngineFault(
                'DECODE_FAILED',
                'Video decoder stopped while awaiting admission',
              );
            }
          }
          const duration = Number.isFinite(packet.duration)
            ? Math.max(0, Math.round(packet.duration * 1_000_000))
            : undefined;
          await controller.submit(
            new EncodedVideoChunk({
              type: packet.type,
              timestamp: Math.round(packet.timestamp * 1_000_000),
              ...(duration === undefined ? {} : { duration }),
              data: packet.data,
            }),
            operation.controller.signal,
          );
        }
        await this.awaitOperation(operation, () => controller.flush());
        queue.end();
      } catch (error) {
        queue.close(error);
        if (!this.isCancellation(error, operation)) throw error;
      }
    })();
    void this.trackTask(operation, producer).catch(() => undefined);
    try {
      for (;;) {
        const sample = await queue.shift(operation.controller.signal);
        if (!sample) break;
        try {
          this.ensureCurrent(operation);
          const mediaTimestamp = this.normalizeMediaTimestamp(
            'video',
            sample.timestamp,
            timelineOrigin,
            start,
            operation,
          );
          this.handlePtsDiscontinuity(mediaTimestamp, start, operation);
          // Decoder preroll is needed for reference frames, not presentation.
          if (!this.state.isLive && mediaTimestamp < start) continue;
          const due = await this.waitUntilVideoDue(mediaTimestamp, start, operation);
          this.ensureCurrent(operation);
          const now = this.presentationNow();
          const latenessMs = (now - due) * 1000;
          if (latenessMs > this.policy.lateFrameDropMs) {
            this.state.diagnostics.droppedFrames++;
            if (latenessMs > this.policy.severeLateFrameMs)
              this.reportDetached(
                'clock',
                'severe-late-frame',
                { latenessMs: Math.round(latenessMs) },
                operation,
              );
            continue;
          }
          this.drawSample(sample);
          this.state.diagnostics.renderedFrames++;
          this.markPresentedProgress(mediaTimestamp, operation);
          operation.lastVideoTimestamp = mediaTimestamp;
        } finally {
          sample.close();
        }
      }
      await producer;
    } finally {
      queue.close();
      operation.videoQueues.delete(queue);
      const controller = currentVideoController();
      if (controller !== null) {
        // Frames stay owned until presentation drains; producer EOF alone must
        // not close frames that are still waiting for their presentation time.
        operation.videoDecoderControllers.delete(controller);
        controller.close();
      }
      if (this.isCurrent(operation)) this.state.diagnostics.videoQueueDepth = 0;
    }
  }

  private async waitUntilVideoDue(
    mediaTimestamp: number,
    start: number,
    operation: Operation,
  ): Promise<number> {
    for (;;) {
      this.ensureCurrent(operation);
      if (
        operation.pipeline?.audioTrack &&
        !operation.audioEnded &&
        (!this.clock.isAudioAnchored ||
          (this.audioContext && operation.nextAudioTime <= this.audioContext.currentTime))
      ) {
        await waitForDelay(25, operation.controller.signal);
        continue;
      }
      // Audio startup/underruns can change this base while a frame is waiting.
      // Recompute on every wake, including the value used for late-frame drops.
      let due =
        operation.basePresentationTime +
        (mediaTimestamp - start) / this.state.playbackRate +
        presentationDelaySeconds('video', this.state.diagnostics.signedAvOffsetMs);
      if (
        !operation.pipeline?.audioTrack &&
        operation.lastVideoTimestamp === null &&
        (this.presentationNow() - due) * 1000 > this.policy.lateFrameDropMs
      ) {
        operation.basePresentationTime =
          this.presentationNow() - (mediaTimestamp - start) / this.state.playbackRate;
        this.clock.seek(mediaTimestamp, this.services.now());
        due = this.presentationNow();
      }
      const delayMs = (due - this.presentationNow()) * 1000;
      if (delayMs <= 0) return due;
      await waitForDelay(
        Math.min(delayMs, 25, this.policy.decodeLookaheadMs),
        operation.controller.signal,
      );
    }
  }

  private handlePtsDiscontinuity(
    mediaTimestamp: number,
    start: number,
    operation: Operation,
  ): void {
    const previous = operation.lastVideoTimestamp;
    if (previous === null) return;
    const backwardsMs = (previous - mediaTimestamp) * 1000;
    if (backwardsMs > this.policy.ptsDiscontinuityMs) {
      operation.basePresentationTime =
        this.presentationNow() - (mediaTimestamp - start) / this.state.playbackRate;
      this.clock.seek(mediaTimestamp, this.services.now());
    }
  }

  private normalizeMediaTimestamp(
    kind: 'audio' | 'video',
    rawTimestamp: number,
    timelineOrigin: number,
    start: number,
    operation: Operation,
  ): number {
    const rawMediaTimestamp = rawTimestamp - timelineOrigin;
    if (!this.state.isLive) return rawMediaTimestamp;
    operation.liveTimelineOffset ??= start - rawMediaTimestamp;
    let offset = operation.trackTimelineOffset[kind] ?? operation.liveTimelineOffset;
    const previousRaw = operation.lastRawTimestamp[kind];
    if (
      previousRaw !== null &&
      (previousRaw - rawMediaTimestamp) * 1000 > this.policy.ptsDiscontinuityMs
    )
      offset += previousRaw - rawMediaTimestamp;
    operation.lastRawTimestamp[kind] = rawMediaTimestamp;
    operation.trackTimelineOffset[kind] = offset;
    return rawMediaTimestamp + offset;
  }

  private async runAudio(
    track: InputAudioTrack,
    timelineOrigin: number,
    start: number,
    operation: Operation,
  ): Promise<void> {
    if (!isAudioContextRunning(this.audioContext)) {
      this.state.audioUnlocked = false;
      this.state.diagnostics.audioContextState = audioContextState(this.audioContext);
      this.emit({ type: 'audio-unlock-required' });
      return;
    }
    const config = await track.getDecoderConfig();
    this.ensureCurrent(operation);
    const native = config
      ? (await probeTrackDecoderCapability(config, 'audio')).supported
      : false;
    this.ensureCurrent(operation);
    const packetSink = this.dependencies.createPacketSink(track);
    const rawStart =
      timelineOrigin +
      (this.state.isLive ? start - (this.state.seekableStartSeconds ?? 0) : start);
    const firstPacket =
      (await packetSink.getPacket(rawStart, { skipLiveWait: true })) ??
      (await packetSink.getFirstPacket({ skipLiveWait: true }));
    this.ensureCurrent(operation);
    const layer = firstPacket ? detectMpegAudioLayer(firstPacket.data) : null;
    if (!native || layer === 2) {
      if (layer !== 2)
        throw new EngineFault('DECODE_FAILED', 'Audio decoder is unsupported');
      await this.runMp2Audio(track, timelineOrigin, start, operation, firstPacket);
      return;
    }
    const sink = this.dependencies.createAudioSink(track);
    for await (const wrapped of sink.buffers(rawStart, undefined, {
      skipLiveWait: false,
    })) {
      this.ensureCurrent(operation);
      await this.waitForAudioCapacity(operation);
      this.scheduleAudioBuffer(
        wrapped.buffer,
        this.normalizeMediaTimestamp(
          'audio',
          wrapped.timestamp,
          timelineOrigin,
          start,
          operation,
        ),
        start,
        operation,
      );
    }
  }

  private async runMp2Audio(
    track: InputAudioTrack,
    timelineOrigin: number,
    start: number,
    operation: Operation,
    knownFirstPacket?: Awaited<ReturnType<EncodedPacketSink['getFirstPacket']>>,
  ): Promise<void> {
    const sink = this.dependencies.createPacketSink(track);
    const decoder = this.dependencies.createMp2Decoder();
    operation.mp2Decoders.add(decoder);
    try {
      await this.awaitOperation(operation, () => decoder.ready());
      this.ensureCurrent(operation);
      const rawStart =
        timelineOrigin +
        (this.state.isLive ? start - (this.state.seekableStartSeconds ?? 0) : start);
      const packet =
        knownFirstPacket ??
        (await sink.getPacket(rawStart, { skipLiveWait: true })) ??
        (await sink.getFirstPacket({ skipLiveWait: true }));
      this.ensureCurrent(operation);
      if (!packet || detectMpegAudioLayer(packet.data) !== 2)
        throw new EngineFault('DECODE_FAILED', 'Stream is not aligned MPEG Layer II');
      for await (const encoded of sink.packets(packet, undefined, {
        skipLiveWait: false,
      })) {
        this.ensureCurrent(operation);
        if (detectMpegAudioLayer(encoded.data) !== 2)
          throw new EngineFault(
            'DECODE_FAILED',
            'MPEG audio layer changed within stream',
          );
        await this.waitForAudioCapacity(operation);
        const pcm = await this.awaitOperation(operation, () =>
          decoder.decode(encoded.data),
        );
        this.ensureCurrent(operation);
        if (!pcm.samplesDecoded) continue;
        const context = this.audioContext;
        if (!isAudioContextRunning(context))
          throw new EngineFault('AUDIO_LOCKED', 'Audio output became unavailable', {
            retryable: true,
          });
        const buffer = context.createBuffer(
          pcm.channelData.length,
          pcm.samplesDecoded,
          pcm.sampleRate,
        );
        pcm.channelData.forEach((channel, index) => {
          buffer.copyToChannel(new Float32Array(channel), index);
        });
        this.scheduleAudioBuffer(
          buffer,
          this.normalizeMediaTimestamp(
            'audio',
            encoded.timestamp,
            timelineOrigin,
            start,
            operation,
          ),
          start,
          operation,
        );
      }
    } finally {
      await this.disposeMp2Decoder(decoder);
      operation.mp2Decoders.delete(decoder);
    }
  }

  private scheduleAudioBuffer(
    buffer: AudioBuffer,
    mediaTimestamp: number,
    start: number,
    operation: Operation,
  ): void {
    const context = this.audioContext;
    if (!isAudioContextRunning(context) || !this.isCurrent(operation)) return;
    const source = context.createBufferSource();
    this.ensureCurrent(operation);
    operation.audioNodes.add(source);
    source.buffer = buffer;
    source.playbackRate.value = this.state.playbackRate;
    source.connect(this.ensureGain(operation));
    this.ensureCurrent(operation);
    const ideal =
      operation.basePresentationTime +
      (mediaTimestamp - start) / this.state.playbackRate +
      presentationDelaySeconds('audio', this.state.diagnostics.signedAvOffsetMs);
    const scheduleAt = Math.max(
      context.currentTime + 0.01,
      ideal,
      operation.nextAudioTime,
    );
    if (
      !this.clock.isAudioAnchored ||
      (operation.nextAudioTime <= context.currentTime &&
        (scheduleAt - ideal) * 1000 > this.policy.lateFrameDropMs)
    ) {
      // Audio startup and an underrun can schedule later than the provisional
      // timeline. Video must follow that actual audio anchor after reopening.
      operation.basePresentationTime =
        scheduleAt -
        (mediaTimestamp - start) / this.state.playbackRate -
        presentationDelaySeconds('audio', this.state.diagnostics.signedAvOffsetMs);
      if (!this.clock.isAudioAnchored) this.clock.start(start, this.services.now());
      this.clock.anchorAudio(mediaTimestamp, scheduleAt);
    }
    source.start(scheduleAt);
    this.ensureCurrent(operation);
    operation.nextAudioTime = scheduleAt + buffer.duration / this.state.playbackRate;
    source.onended = (): void => {
      try {
        source.disconnect();
      } catch {
        // Browser nodes may already be disconnected during reset.
      }
      operation.audioNodes.delete(source);
      if (this.isCurrent(operation)) {
        this.markPresentedProgress(mediaTimestamp, operation);
        this.state.diagnostics.audioQueueSeconds = Math.max(
          0,
          operation.nextAudioTime - context.currentTime,
        );
      }
    };
    this.state.diagnostics.audioQueueSeconds = Math.max(
      0,
      operation.nextAudioTime - context.currentTime,
    );
  }

  private async waitForAudioCapacity(operation: Operation): Promise<void> {
    while (
      this.audioContext &&
      operation.nextAudioTime - this.audioContext.currentTime >
        this.policy.maxAudioSeconds
    ) {
      this.ensureCurrent(operation);
      await waitForDelay(25, operation.controller.signal);
    }
  }

  private ownVideoFrame(
    frame: VideoFrame,
    operation: Operation,
    onClose: () => void,
  ): OwnedVideoSample {
    let closed = false;
    const sample: OwnedVideoSample = {
      timestamp: frame.timestamp / 1_000_000,
      displayWidth: frame.displayWidth,
      displayHeight: frame.displayHeight,
      draw: (context, x, y, width, height) => {
        if (closed) throw new EngineFault('DECODE_FAILED', 'Video frame is closed');
        context.drawImage(frame, x, y, width, height);
      },
      close: () => {
        if (closed) return;
        closed = true;
        frame.close();
        operation.videoFrames.delete(sample);
        onClose();
      },
    };
    operation.videoFrames.add(sample);
    return sample;
  }

  private ownControlledVideoFrame(
    owned: OwnedVideoFrame,
    operation: Operation,
    onClose: () => void,
  ): OwnedVideoSample {
    let closed = false;
    const sample: OwnedVideoSample = {
      timestamp: owned.timestamp / 1_000_000,
      displayWidth: owned.displayWidth,
      displayHeight: owned.displayHeight,
      draw: (context, x, y, width, height) => {
        if (closed) throw new EngineFault('DECODE_FAILED', 'Video frame is closed');
        context.drawImage(owned.frame, x, y, width, height);
      },
      close: () => {
        if (closed) return;
        closed = true;
        owned.close();
        operation.videoFrames.delete(sample);
        onClose();
      },
    };
    operation.videoFrames.add(sample);
    return sample;
  }

  private drawSample(sample: OwnedVideoSample): void {
    this.renderer.drawSample(sample, this.state);
  }

  private ensureGain(operation: Operation): GainNode {
    this.ensureCurrent(operation);
    const context = this.audioContext;
    if (!context)
      throw new EngineFault('AUDIO_LOCKED', 'Audio output is unavailable', {
        retryable: true,
      });
    let gain = operation.gain;
    if (!gain) {
      gain = context.createGain();
      this.ensureCurrent(operation);
      operation.gain = gain;
      gain.connect(context.destination);
      this.ensureCurrent(operation);
    }
    this.applyGain(operation);
    return gain;
  }

  private applyGain(operation: Operation): void {
    if (operation.gain && this.audioContext)
      operation.gain.gain.setValueAtTime(
        this.state.muted ? 0 : this.state.volume,
        this.audioContext.currentTime,
      );
    this.ensureCurrent(operation);
  }

  private async policyFetch(
    endpoint: PlaybackEndpoint,
    input: string | URL | Request,
    init: RequestInit | undefined,
    session: PlaybackSession,
    operation: Operation,
  ): Promise<Response> {
    this.ensureCurrent(operation);
    const url = normalizedUrl(input);
    const resource = operation.hls.getResource(url);
    if (isHls(session) && !resource) {
      throw new EngineFault(
        'HLS_MANIFEST_INVALID',
        'HLS requested an unclassified child resource',
      );
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (resource && ['playlist', 'variant', 'rendition'].includes(resource.kind)) {
      // UrlSource probes with Range even for playlists. The broker deliberately
      // rewrites complete bounded manifests, so playlist byte ranges are invalid.
      headers.delete('range');
    }
    const response = await this.fetchResourceWithRetry(
      input,
      {
        ...init,
        headers,
        credentials: credentialsFor(endpoint),
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      },
      operation,
      // The short trusted-direct probe deadline must not interrupt a provider
      // preparing the next segment of a Plex transcode or YouTube stream.
      endpoint.route === 'secure-proxy'
        ? this.policy.startupTimeoutMs.provider
        : this.policy.directProbeTimeoutMs,
    );
    this.ensureCurrent(operation);
    if (!response.ok) {
      if (resource?.kind === 'key')
        throw new EngineFault('HLS_KEY_FAILED', 'HLS AES-128 key request failed', {
          safeCause: `status=${String(response.status)}; role=key`,
        });
      return response;
    }
    const observedRepresentation =
      endpoint.route === 'direct'
        ? await directRepresentationId(response)
        : response.headers.get('x-csp-representation-id');
    if (
      endpoint.representationId !== undefined &&
      observedRepresentation !== endpoint.representationId
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new EngineFault('DEMUX_FAILED', 'Media representation changed');
    }
    return isHls(session)
      ? operation.hls.validateResponse(response, url, resource)
      : response;
  }

  private async fetchResourceWithRetry(
    input: string | URL | Request,
    init: RequestInit,
    operation: Operation,
    timeoutMs: number,
  ): Promise<Response> {
    const signal = AbortSignal.any([
      operation.controller.signal,
      ...(init.signal ? [init.signal] : []),
    ]);
    for (let attempt = 0; ; attempt++) {
      this.ensureCurrent(operation);
      signal.throwIfAborted();
      try {
        const response = await this.fetchWithTimeout(input, init, operation, timeoutMs);
        if (
          ![408, 429, 500, 502, 503, 504].includes(response.status) ||
          attempt + 1 >= this.policy.segmentAttempts
        )
          return response;
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        if (
          signal.aborted ||
          attempt + 1 >= this.policy.segmentAttempts ||
          !(
            error instanceof TypeError ||
            (error instanceof EngineFault && error.retryable)
          )
        )
          throw error;
      }
      this.ensureCurrent(operation);
      signal.throwIfAborted();
      this.state.diagnostics.retryCount++;
      await waitForDelay(this.policy.segmentRetryBaseMs * 2 ** attempt, signal);
    }
  }

  private fetchEndpoint(
    endpoint: PlaybackEndpoint,
    operation: Operation,
  ): Promise<Response> {
    return this.fetchWithTimeout(
      endpointUrl(endpoint),
      {
        credentials: credentialsFor(endpoint),
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: { Accept: endpoint.mimeType ?? '*/*' },
      },
      operation,
      this.policy.directProbeTimeoutMs,
    );
  }

  private async probeDirectEndpoints(
    session: PlaybackSession,
    operation: Operation,
  ): Promise<void> {
    for (const endpoint of session.endpoints) {
      if (endpoint.route !== 'direct') continue;
      const expectedUrl = endpointUrl(endpoint);
      const headers = new Headers({ Accept: endpoint.mimeType ?? '*/*' });
      if (!isHls(session)) headers.set('Range', 'bytes=0-0');
      const response = await this.fetchWithTimeout(
        expectedUrl,
        {
          method: 'GET',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          headers,
        },
        operation,
        this.policy.directProbeTimeoutMs,
      );
      if (!response.ok || response.url === '') {
        void response.body?.cancel().catch(() => undefined);
        throw new EngineFault('DEMUX_FAILED', 'Trusted-direct CORS probe failed');
      }
      if (new URL(response.url).origin !== new URL(expectedUrl).origin) {
        void response.body?.cancel().catch(() => undefined);
        throw new EngineFault('DEMUX_FAILED', 'Trusted-direct redirect changed origin');
      }
      const observed =
        endpoint.representationId === undefined
          ? null
          : await directRepresentationId(response);
      void response.body?.cancel().catch(() => undefined);
      if (
        endpoint.representationId !== undefined &&
        observed !== endpoint.representationId
      ) {
        throw new EngineFault(
          'DEMUX_FAILED',
          'Trusted-direct response did not prove the pinned media representation',
        );
      }
    }
  }

  private async fetchWithTimeout(
    input: string | URL | Request,
    init: RequestInit,
    operation: Operation,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    // Fetch resolves at the headers, but its signal also owns the response body.
    // Keep worker/operation cancellation connected after that point: UrlSource
    // aborts finished range workers to release their open-ended HTTP streams.
    const signal = AbortSignal.any([
      controller.signal,
      operation.controller.signal,
      ...(init.signal ? [init.signal] : []),
    ]);
    const timer = setTimeout(() => {
      controller.abort(timeoutError());
    }, timeoutMs);
    try {
      return await this.dependencies.fetch(input, {
        ...init,
        signal,
      });
    } catch (error) {
      if (
        controller.signal.reason instanceof DOMException &&
        controller.signal.reason.name === 'TimeoutError'
      )
        throw new EngineFault('NETWORK_TIMEOUT', 'Network request timed out', {
          retryable: true,
          safeCause: `deadlineMs=${String(timeoutMs)}`,
          cause: error,
        });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private rejectProtection(session: PlaybackSession): void {
    if (session.protection === 'clear' || session.protection === 'hls-aes-128') return;
    throw new EngineFault('PROTECTION_UNSUPPORTED', 'Playback protection is unsupported');
  }

  private async loadSelectedSubtitles(
    operation: Operation,
    requestedEpoch?: number,
  ): Promise<void> {
    const selectedId = this.state.selectedSubtitleTrackId;
    const selected = this.session?.subtitles.find((track) => track.id === selectedId);
    if (!selected) return;
    if (selected.format !== 'webvtt' && selected.format !== 'srt')
      throw new EngineFault('DEMUX_FAILED', 'Subtitle format requires server extraction');
    const format = selected.format;
    const epoch = requestedEpoch ?? ++operation.subtitleEpoch;
    operation.subtitleController?.abort();
    const subtitleController = new AbortController();
    operation.subtitleController = subtitleController;
    const abort = (): void => {
      subtitleController.abort(operation.controller.signal.reason);
    };
    operation.controller.signal.addEventListener('abort', abort, { once: true });
    const cleanup = (): void => {
      operation.controller.signal.removeEventListener('abort', abort);
    };
    const url = new URL(selected.url, browserBaseUrl()).href;
    const credentials: RequestCredentials =
      new URL(url).origin === new URL(browserBaseUrl()).origin ? 'same-origin' : 'omit';
    const seen = new Set<string>();
    const timelineState: SubtitleTimelineState = {
      epoch: 0,
      discontinuitySequence: null,
      lastUnwrappedMpegTs: null,
    };
    const readWindow = async () => {
      const loaded = await loadSubtitleResource(url, format, subtitleController.signal, {
        credentials,
        fetchFn: this.dependencies.fetch,
        maxPlaylistEntries: this.policy.maxPlaylistEntries,
        maxSegmentKeys: this.policy.maxSegmentKeys,
        seenSegments: seen,
        timelineState,
      });
      this.ensureSubtitleCurrent(operation, epoch, selected.id);
      this.subtitleCues = mergeSubtitleWindowCues(
        this.subtitleCues,
        loaded.cues,
        loaded.windowStartSeconds ??
          (loaded.live ? this.state.seekableStartSeconds : null),
      );
      this.state.activeSubtitleCues = activeCuesAt(
        this.subtitleCues,
        this.state.positionSeconds,
      );
      return loaded;
    };
    let refreshing = false;
    try {
      const initial = await readWindow();
      if (!initial.live || initial.refreshMs === null) return;
      // Initial cues settle startup/selection. Refresh is operation-owned work,
      // not an infinite await that holds the load or subtitle command open.
      refreshing = true;
      const refresh = async (): Promise<void> => {
        let window = initial;
        try {
          while (window.live && window.refreshMs !== null) {
            await waitForDelay(window.refreshMs, subtitleController.signal);
            window = await readWindow();
            this.emitState();
          }
        } finally {
          cleanup();
        }
      };
      void this.trackTask(operation, refresh()).catch((error: unknown) => {
        if (
          !this.isCancellation(error, operation) &&
          operation.subtitleEpoch === epoch &&
          !subtitleController.signal.aborted
        ) {
          this.reportDetached(
            'lifecycle',
            'subtitle-refresh-failed',
            { code: 'SUBTITLE_REFRESH_FAILED' },
            operation,
          );
        }
      });
    } finally {
      if (!refreshing) cleanup();
    }
  }

  private updatePosition(): void {
    if (this.state.phase === 'playing' || this.state.phase === 'stalled') {
      const position = this.clock.now(this.services.now(), this.playheadAudioTime());
      const low = this.state.seekableStartSeconds ?? 0;
      const high =
        this.state.seekableEndSeconds ??
        this.state.durationSeconds ??
        Number.POSITIVE_INFINITY;
      this.state.positionSeconds = clamp(position, low, high);
      this.state.activeSubtitleCues = activeCuesAt(
        this.subtitleCues,
        this.state.positionSeconds,
      );
      this.state.diagnostics.audioQueueSeconds = this.audioContext
        ? Math.max(0, this.operation.nextAudioTime - this.audioContext.currentTime)
        : 0;
    }
  }

  private markPresentedProgress(mediaTimestamp: number, operation: Operation): void {
    if (!this.isCurrent(operation)) return;
    this.lastProgressMonotonic = this.services.now();
    this.state.diagnostics.lastProgressAt = isoNow();
    const clock = this.clock.now(this.services.now(), this.audioContext?.currentTime);
    this.state.diagnostics.measuredAvDriftMs = Math.round(
      (mediaTimestamp - clock) * 1000,
    );
  }

  private startStateTimer(operation: Operation): void {
    if (operation.timers.size > 0) return;
    let lastWatchdogAt = this.services.now();
    const timer = setInterval(
      () => {
        if (!this.isCurrent(operation) || this.state.phase !== 'playing') {
          clearInterval(timer);
          operation.timers.delete(timer);
          return;
        }
        this.updatePosition();
        if (
          !this.state.isLive &&
          this.state.durationSeconds !== null &&
          this.state.positionSeconds >= this.state.durationSeconds - 0.02 &&
          this.state.diagnostics.audioQueueSeconds <= 0.05
        ) {
          this.finishNaturalEnd(operation);
          return;
        }
        const now = this.services.now();
        if (now - lastWatchdogAt < this.policy.stallCheckIntervalMs) {
          this.emitState();
          return;
        }
        lastWatchdogAt = now;
        const stalledFor = now - this.lastProgressMonotonic;
        const softThreshold = Math.min(
          this.policy.softStallMs,
          this.policy.progressTimeoutMs,
        );
        if (stalledFor >= this.policy.hardStallMs) {
          void this.recover(true, 'hard-stall-watchdog', operation).catch(
            (error: unknown) => {
              if (!this.isCancellation(error, operation))
                void this.handlePlaybackFailure(error, 'recovery', operation).catch(
                  () => undefined,
                );
            },
          );
        } else if (stalledFor >= softThreshold) {
          this.state.phase = 'stalled';
          void this.recover(false, 'soft-stall-watchdog', operation).catch(
            (error: unknown) => {
              if (!this.isCancellation(error, operation))
                void this.handlePlaybackFailure(error, 'recovery', operation).catch(
                  () => undefined,
                );
            },
          );
        }
        this.emitState();
      },
      Math.min(250, this.policy.stallCheckIntervalMs),
    );
    operation.timers.add(timer);
  }

  private finishNaturalEnd(operation: Operation): void {
    if (!this.isCurrent(operation) || this.state.phase === 'ended') return;
    const sessionId = this.session?.id ?? null;
    this.state.phase = 'ended';
    this.state.activeSubtitleCues = [];
    for (const timer of operation.timers) clearInterval(timer);
    operation.timers.clear();
    this.emitState();
    if (!this.isCurrent(operation)) return;
    if (sessionId) this.emit({ type: 'ended', sessionId });
  }

  private startLiveRefresh(operation: Operation): void {
    if (!this.state.isLive || operation.liveRefreshStarted) return;
    operation.liveRefreshStarted = true;
    void this.trackTask(operation, this.refreshLiveBounds(operation)).catch(
      (error: unknown) => {
        if (!this.isCancellation(error, operation))
          void this.handlePlaybackFailure(error, 'live-refresh', operation).catch(
            () => undefined,
          );
      },
    );
  }

  private async refreshLiveBounds(operation: Operation): Promise<void> {
    for (;;) {
      this.ensureCurrent(operation);
      const pipeline = operation.pipeline;
      if (!pipeline) return;
      const track = pipeline.videoTrack ?? pipeline.audioTrack;
      const interval = track ? await track.getLiveRefreshInterval() : null;
      this.ensureCurrent(operation);
      if (interval === null || interval <= 0) return;
      await waitForDelay(interval * 1000, operation.controller.signal);
      this.ensureCurrent(operation);
      const activeTracks = [pipeline.videoTrack, pipeline.audioTrack].filter(
        (item): item is InputVideoTrack | InputAudioTrack => item !== null,
      );
      if (activeTracks.length === 0) return;
      const input = pipeline.inputs.find(
        (candidate): candidate is Input => candidate instanceof Input,
      );
      if (!input) return;
      const end = await input.getDurationFromMetadata(activeTracks, {
        skipLiveWait: true,
      });
      this.ensureCurrent(operation);
      if (end !== null && Number.isFinite(end)) {
        const normalizedEnd = Math.max(0, end - pipeline.timelineOrigin);
        this.state.seekableEndSeconds = normalizedEnd;
        this.state.seekableStartSeconds = Math.max(
          0,
          normalizedEnd - (operation.hls.liveWindowDurationSeconds ?? normalizedEnd),
        );
      }
      this.state.positionSeconds = this.clampToSeekWindow(this.state.positionSeconds);
      this.emitState();
    }
  }

  private async handlePlaybackFailure(
    error: unknown,
    stage: string,
    operation: Operation,
    invocation?: InvocationAuthority,
  ): Promise<void> {
    if (invocation && !this.isInvocationAuthoritative(invocation)) return;
    if (
      operation !== this.operation ||
      operation.disposed ||
      operation.terminalError ||
      operation.controller.signal.aborted ||
      this.destroyed
    )
      return;
    const failureInvocation = invocation ?? this.createInvocation(operation);
    if (
      error instanceof EngineFault &&
      (error.code === 'PROTECTION_UNSUPPORTED' ||
        error.code === 'HLS_MANIFEST_INVALID' ||
        error.code === 'HLS_KEY_FAILED' ||
        error.code === 'NETWORK_TIMEOUT')
    ) {
      await this.fail(error, operation);
      return;
    }
    const safeReason = `${stage}: ${safeErrorCause(error)}`;
    if (
      this.services.requestRouteDemotion &&
      this.session &&
      this.request &&
      this.state.diagnostics.routeDemotionCount < this.policy.maxRouteDemotions
    ) {
      const session = this.session;
      const request = this.request;
      this.state.diagnostics.routeDemotionCount++;
      try {
        const demote = this.services.requestRouteDemotion.bind(this.services);
        const replacement = await demote(
          session.id,
          safeReason,
          failureInvocation.controller.signal,
          this.expectedGenerationId(session),
        );
        this.ensureInvocationCurrent(failureInvocation);
        await this.loadInternal(
          {
            ...request,
            session: replacement,
            autoplay: this.state.phase === 'playing' || request.autoplay,
            resumePositionSeconds: this.state.positionSeconds,
          },
          undefined,
          true,
          true,
          failureInvocation,
        );
        return;
      } catch (demotionError) {
        if (!this.isInvocationAuthoritative(failureInvocation)) return;
        if (this.isCancellation(demotionError, operation)) return;
        this.reportDetached(
          'recovery',
          'route-demotion-failed',
          { cause: safeErrorCause(demotionError) },
          operation,
        );
        if (!this.isInvocationAuthoritative(failureInvocation)) return;
        if (this.isCancellation(demotionError, operation)) return;
      }
    }
    if (
      this.state.diagnostics.hardRecoveryCount < this.policy.maxHardRecoveries &&
      operation.pipeline
    ) {
      await this.recover(true, safeReason, operation, failureInvocation);
      return;
    }
    await this.fail(
      engineFault(
        error,
        stage === 'decode' ? 'DECODE_FAILED' : 'DEMUX_FAILED',
        `Playback ${stage} failed`,
      ),
      operation,
    );
  }

  private async requestCompatibility(
    mode: 'audio-only' | 'full' | 'flv-remux',
    reason: string,
    seekSeconds: number | undefined,
    operation: Operation,
    invocation: InvocationAuthority,
  ): Promise<void> {
    const session = this.session;
    const request = this.request;
    if (!session || !request) return;
    if (this.compatibilityModes.has(mode))
      throw new EngineFault(
        'RECOVERY_EXHAUSTED',
        'Compatibility mode was already attempted',
        {
          safeCause: mode,
        },
      );
    this.compatibilityModes.add(mode);
    const safeReason = safePublicText(reason);
    this.ensureInvocationCurrent(invocation);
    this.emit({
      type: 'compatibility-requested',
      mode,
      reason: safeReason,
      generation: operation.generation,
    });
    this.ensureInvocationCurrent(invocation);
    const requestCompatibility = this.services.requestCompatibility.bind(this.services);
    const replacement = await requestCompatibility(
      session.id,
      mode,
      safeReason,
      invocation.controller.signal,
      seekSeconds,
      this.expectedGenerationId(session),
    );
    this.ensureInvocationCurrent(invocation);
    await this.loadInternal(
      {
        ...request,
        session: replacement,
        autoplay: request.autoplay || this.state.phase === 'playing',
        resumePositionSeconds: seekSeconds ?? this.state.positionSeconds,
      },
      undefined,
      true,
      true,
      invocation,
    );
  }

  private expectedGenerationId(session: PlaybackSession): string {
    if (session.generationId === undefined) {
      throw new EngineFault('BAD_REQUEST', 'Playback generation is unavailable');
    }
    return session.generationId;
  }

  private createOperation(generation: number): Operation {
    return {
      generation,
      controller: new AbortController(),
      inputs: new Set(),
      videoDecoders: new Set(),
      videoDecoderControllers: new Set(),
      videoFrames: new Set(),
      videoQueues: new Set(),
      mp2Decoders: new Set(),
      tasks: new Set(),
      hls: new HlsResources(this.policy, () => this.session?.isLive === true),
      timers: new Set(),
      pipeline: null,
      outerSignal: null,
      outerAbort: null,
      subtitleController: null,
      subtitleEpoch: 0,
      recoveryTask: null,
      liveTimelineOffset: null,
      liveRefreshStarted: false,
      lastRawTimestamp: { audio: null, video: null },
      trackTimelineOffset: { audio: null, video: null },
      authorityVersions: {
        generation: 0,
        selection: 0,
        subtitle: 0,
        audio: 0,
        controls: 0,
      },
      invocations: new Map(),
      audioNodes: new Set(),
      gain: null,
      nextAudioTime: 0,
      audioEnded: false,
      basePresentationTime: 0,
      lastVideoTimestamp: null,
      terminalError: false,
      disposed: false,
    };
  }

  private replaceOperation(
    outerSignal: AbortSignal | undefined,
    invocation?: InvocationAuthority,
  ): Operation {
    const old = this.operation;
    const operation = this.createOperation(old.generation + 1);
    this.operation = operation;
    if (invocation) this.transferInvocation(invocation, operation);
    this.abortOperation(old);
    if (outerSignal) {
      if (outerSignal.aborted) {
        operation.controller.abort(outerSignal.reason);
        throw abortError();
      }
      const capturedController = operation.controller;
      const onAbort = (): void => {
        capturedController.abort(outerSignal.reason);
      };
      operation.outerSignal = outerSignal;
      operation.outerAbort = onAbort;
      outerSignal.addEventListener('abort', onAbort, { once: true });
    }
    if (invocation) this.ensureInvocationCurrent(invocation);
    return operation;
  }

  private abortOperation(
    operation: Operation,
    invocationReason: unknown = abortError(),
  ): void {
    if (operation.disposed) return;
    operation.disposed = true;
    // Abort public invocations first: their linked parent abort is generic and
    // AbortSignal.reason cannot be replaced once it has been observed.
    for (const invocation of [...operation.invocations.values()])
      invocation.controller.abort(invocationReason);
    operation.invocations.clear();
    operation.controller.abort(abortError());
    operation.subtitleController?.abort(abortError());
    if (operation.outerSignal && operation.outerAbort)
      operation.outerSignal.removeEventListener('abort', operation.outerAbort);
    operation.outerSignal = null;
    operation.outerAbort = null;
    for (const timer of operation.timers) clearInterval(timer);
    operation.timers.clear();
    for (const input of operation.inputs) this.disposeInput(input);
    operation.inputs.clear();
    for (const decoder of operation.videoDecoders) {
      try {
        if (decoder.state !== 'closed') decoder.close();
      } catch {
        // Continue releasing the rest of the exact operation.
      }
    }
    operation.videoDecoders.clear();
    for (const controller of operation.videoDecoderControllers) controller.close();
    operation.videoDecoderControllers.clear();
    for (const queue of operation.videoQueues) queue.close();
    operation.videoQueues.clear();
    for (const frame of operation.videoFrames) frame.close();
    operation.videoFrames.clear();
    for (const decoder of operation.mp2Decoders) {
      try {
        decoder.forceTerminate();
      } catch {
        // Finish sibling cleanup. The active MP2 task retains retry ownership.
      }
    }
    operation.mp2Decoders.clear();
    operation.pipeline = null;
    for (const node of operation.audioNodes) {
      try {
        node.stop();
      } catch {
        // Audio node already ended.
      }
      try {
        node.disconnect();
      } catch {
        // Audio node already disconnected.
      }
    }
    operation.audioNodes.clear();
    if (operation.gain) {
      try {
        operation.gain.disconnect();
      } catch {
        // Gain already disconnected.
      }
      operation.gain = null;
    }
    operation.nextAudioTime = 0;
    operation.lastVideoTimestamp = null;
    if (operation === this.operation) {
      this.state.diagnostics.videoQueueDepth = 0;
      this.state.diagnostics.audioQueueSeconds = 0;
    }
  }

  private async drainOperation(operation: Operation): Promise<void> {
    const tasks = [...operation.tasks];
    if (tasks.length === 0) return;
    await this.withCleanupDeadline(Promise.allSettled(tasks).then(() => undefined));
  }

  private async awaitOperation<T>(
    operation: Operation,
    dependency: Promise<T> | (() => Promise<T>),
  ): Promise<T> {
    if (operation.controller.signal.aborted) {
      if (typeof dependency !== 'function') void dependency.catch(() => undefined);
      throw abortError();
    }
    const promise = typeof dependency === 'function' ? dependency() : dependency;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        operation.controller.signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = (): void => {
        finish(() => {
          reject(abortError());
        });
      };
      operation.controller.signal.addEventListener('abort', onAbort, { once: true });
      if (operation.controller.signal.aborted) onAbort();
      void promise.then(
        (value) => {
          finish(() => {
            resolve(value);
          });
        },
        (error: unknown) => {
          finish(() => {
            reject(error instanceof Error ? error : new Error('Operation failed'));
          });
        },
      );
    });
  }

  private async disposeMp2Decoder(decoder: Mp2Decoder): Promise<void> {
    const disposal = decoder.dispose();
    void disposal.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        disposal,
        new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => {
            try {
              decoder.forceTerminate();
              resolve();
            } catch (error) {
              reject(
                error instanceof Error ? error : new Error('MP2 termination failed'),
              );
            }
          }, CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async withCleanupDeadline(promise: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private registerInput(operation: Operation, input: DisposableInput): void {
    if (!this.isCurrent(operation) || operation.disposed) {
      this.disposeInput(input);
      throw abortError();
    }
    operation.inputs.add(input);
  }

  private disposeInput(input: DisposableInput): void {
    const object = input as object;
    if (this.disposedInputs.has(object)) return;
    this.disposedInputs.add(object);
    try {
      input.dispose();
    } catch {
      // Disposal is terminal and must not prevent sibling resource cleanup.
    }
  }

  private trackTask<T>(operation: Operation, task: Promise<T>): Promise<T> {
    operation.tasks.add(task);
    void task
      .finally(() => {
        operation.tasks.delete(task);
      })
      .catch(() => undefined);
    return task;
  }

  private commandDomain(command: PlayerCommand): InvocationDomain {
    if (command.type === 'select-quality' || command.type === 'select-audio-track')
      return 'selection';
    if (command.type === 'select-subtitle-track' || command.type === 'extract-subtitles')
      return 'subtitle';
    if (
      command.type === 'set-volume' ||
      command.type === 'set-muted' ||
      command.type === 'set-rotation' ||
      command.type === 'set-aspect-mode'
    )
      return 'controls';
    return 'generation';
  }

  private createInvocation(
    operation: Operation,
    domain: InvocationDomain = 'generation',
    linkToOperation = true,
  ): InvocationAuthority {
    operation.invocations
      .get(domain)
      ?.controller.abort(abortError('Superseded invocation'));
    operation.authorityVersions[domain]++;
    const invocation: InvocationAuthority = {
      id: ++this.nextInvocationId,
      domain,
      operation,
      version: operation.authorityVersions[domain],
      controller: new AbortController(),
      operationAbort: null,
    };
    operation.invocations.set(domain, invocation);
    if (linkToOperation) this.linkInvocationToOperation(invocation);
    return invocation;
  }

  private transferInvocation(
    invocation: InvocationAuthority,
    operation: Operation,
  ): void {
    const previousOperation = invocation.operation;
    if (previousOperation.invocations.get(invocation.domain) === invocation)
      previousOperation.invocations.delete(invocation.domain);
    if (invocation.operationAbort)
      previousOperation.controller.signal.removeEventListener(
        'abort',
        invocation.operationAbort,
      );
    operation.invocations
      .get(invocation.domain)
      ?.controller.abort(abortError('Superseded invocation'));
    operation.authorityVersions[invocation.domain]++;
    invocation.operation = operation;
    invocation.version = operation.authorityVersions[invocation.domain];
    operation.invocations.set(invocation.domain, invocation);
    this.linkInvocationToOperation(invocation);
  }

  private linkInvocationToOperation(invocation: InvocationAuthority): void {
    const operation = invocation.operation;
    const onAbort = (): void => {
      invocation.controller.abort(operation.controller.signal.reason ?? abortError());
    };
    invocation.operationAbort = onAbort;
    if (operation.controller.signal.aborted) onAbort();
    else operation.controller.signal.addEventListener('abort', onAbort, { once: true });
  }

  private releaseInvocation(invocation: InvocationAuthority): void {
    const operation = invocation.operation;
    if (operation.invocations.get(invocation.domain) === invocation)
      operation.invocations.delete(invocation.domain);
    if (invocation.operationAbort) {
      operation.controller.signal.removeEventListener('abort', invocation.operationAbort);
      invocation.operationAbort = null;
    }
  }

  private isInvocationAuthoritative(invocation: InvocationAuthority): boolean {
    return (
      invocation.operation === this.operation &&
      invocation.version === invocation.operation.authorityVersions[invocation.domain] &&
      !this.destroyed
    );
  }

  private ensureInvocationCurrent(invocation: InvocationAuthority): void {
    if (
      !this.isInvocationAuthoritative(invocation) ||
      !this.isCurrent(invocation.operation) ||
      invocation.controller.signal.aborted
    )
      throw abortError('Stale player invocation');
  }

  private ensureInvocationLease(invocation: InvocationAuthority): void {
    if (!this.isInvocationAuthoritative(invocation))
      throw this.staleInvocationFault(invocation);
  }

  private staleInvocationFault(invocation: InvocationAuthority): EngineFault {
    return new EngineFault('STALE_OPERATION', 'Player invocation was superseded', {
      safeCause: `invocation=${String(invocation.id)}`,
    });
  }

  private ensureCurrent(operation: Operation): void {
    if (!this.isCurrent(operation)) throw abortError('Stale player operation');
  }

  private isCurrent(operation: Operation): boolean {
    return (
      operation === this.operation &&
      !operation.disposed &&
      !operation.controller.signal.aborted &&
      !operation.terminalError &&
      !this.destroyed
    );
  }

  private ensureSubtitleCurrent(
    operation: Operation,
    epoch: number,
    trackId: string | null,
  ): void {
    this.ensureCurrent(operation);
    if (
      operation.subtitleEpoch !== epoch ||
      this.state.selectedSubtitleTrackId !== trackId ||
      operation.subtitleController?.signal.aborted
    )
      throw abortError('Stale subtitle selection');
  }

  private isCancellation(error: unknown, operation: Operation): boolean {
    return (
      operation !== this.operation ||
      operation.disposed ||
      operation.terminalError ||
      operation.controller.signal.aborted ||
      this.destroyed ||
      isAbortError(error)
    );
  }

  private boundaryFault(
    error: unknown,
    fallbackCode: PlayerError['code'],
    fallbackMessage: string,
  ): EngineFault {
    if (isAbortError(error))
      return new EngineFault('STALE_OPERATION', 'Player operation was superseded');
    return engineFault(error, fallbackCode, fallbackMessage);
  }

  private assertAlive(): void {
    if (this.destroyed)
      throw new EngineFault('ENGINE_DESTROYED', 'Player engine is destroyed');
  }

  private assertOperationAcceptsCommands(): void {
    if (
      this.state.phase === 'error' ||
      this.operation.terminalError ||
      this.operation.disposed ||
      this.operation.controller.signal.aborted
    )
      throw new EngineFault(
        'STALE_OPERATION',
        'A fresh load is required after terminal playback failure',
      );
  }

  private startupTimeoutFor(session: PlaybackSession): number {
    if (session.route.startsWith('compatibility') || session.route === 'transmux-flv')
      return this.policy.startupTimeoutMs.compatibility;
    return session.route === 'direct'
      ? this.policy.startupTimeoutMs.direct
      : this.policy.startupTimeoutMs.provider;
  }

  private async withInvocationDeadline<T>(
    invocation: InvocationAuthority,
    deadlineAt: number,
    message: string,
    abortOwnedOperation: boolean | (() => boolean),
    work: () => Promise<T>,
  ): Promise<T> {
    const timeoutMs = Math.max(0, deadlineAt - this.services.now());
    let removeAbort: (() => void) | undefined;
    const timeoutFault = new EngineFault('NETWORK_TIMEOUT', message, {
      retryable: true,
      safeCause: `deadlineMs=${String(timeoutMs)}`,
    });
    if (invocation.controller.signal.aborted)
      throw invocation.controller.signal.reason instanceof Error
        ? invocation.controller.signal.reason
        : abortError();
    const dependency = work();
    void dependency.catch(() => undefined);
    const aborted = new Promise<T>((_, reject) => {
      const onAbort = (): void => {
        reject(
          invocation.controller.signal.reason instanceof Error
            ? invocation.controller.signal.reason
            : abortError(),
        );
      };
      removeAbort = (): void => {
        invocation.controller.signal.removeEventListener('abort', onAbort);
      };
      invocation.controller.signal.addEventListener('abort', onAbort, { once: true });
      if (invocation.controller.signal.aborted) onAbort();
    });
    const timer = setTimeout(() => {
      if (!this.isInvocationAuthoritative(invocation)) {
        invocation.controller.abort(this.staleInvocationFault(invocation));
        return;
      }
      invocation.controller.abort(timeoutFault);
      if (
        typeof abortOwnedOperation === 'function'
          ? abortOwnedOperation()
          : abortOwnedOperation
      )
        this.abortOperation(invocation.operation);
    }, timeoutMs);
    try {
      return await Promise.race([dependency, aborted]);
    } finally {
      clearTimeout(timer);
      removeAbort?.();
    }
  }

  private async handlePublicFailure(
    error: unknown,
    stage: string,
    operation: Operation,
  ): Promise<void> {
    if (this.isCancellation(error, operation)) return;
    const fault = engineFault(
      error,
      stage.includes('seek') ? 'DEMUX_FAILED' : 'DEMUX_FAILED',
      `Playback ${stage} failed`,
    );
    await this.fail(fault, operation);
  }

  private fail(fault: EngineFault, operation: Operation): Promise<void> {
    if (operation !== this.operation || this.destroyed || operation.terminalError)
      return Promise.resolve();
    operation.terminalError = true;
    const sessionId = this.session?.id ?? null;
    const error: PlayerError = {
      code: fault.code,
      message: safePublicText(fault.message),
      fatal: fault.fatal,
      retryable: fault.retryable,
      generation: operation.generation,
      cause: fault.safeCause,
    };
    const diagnostic = {
      at: isoNow(),
      sessionId,
      category: 'error' as const,
      name: safePublicText(fault.code),
      values: {
        fatal: fault.fatal,
        retryable: fault.retryable,
        cause: safePublicText(fault.safeCause ?? ''),
      },
    };
    // Revoke A before any resource callback can reenter. Cleanup below touches only
    // resources tagged to A; publication resumes only while A still owns state.
    const stillOwnsTerminal = (): boolean =>
      operation === this.operation && !this.destroyed;
    this.abortOperation(operation, fault);
    if (!stillOwnsTerminal()) return Promise.resolve();
    this.state.phase = 'error';
    this.state.diagnostics.lastError = error;
    this.emit({ type: 'error', error });
    if (stillOwnsTerminal()) this.emitState();
    try {
      const report = this.services.reportDiagnostic(diagnostic);
      void report.catch(() => undefined);
    } catch {
      // Diagnostics are detached and cannot compromise terminal cleanup.
    }
    return Promise.resolve();
  }

  private emit(event: PlayerEvent): void {
    if (this.destroyed && event.type !== 'state') return;
    for (const listener of [...this.listeners]) listener(event);
  }

  private emitState(): void {
    this.state.generation = this.operation.generation;
    this.state.diagnostics.generation = this.operation.generation;
    this.emit({ type: 'state', snapshot: this.getSnapshot() });
  }

  private reportDetached(
    category: 'lifecycle' | 'route' | 'decode' | 'clock' | 'recovery' | 'error',
    name: string,
    values: Record<string, boolean | number | string | null>,
    operation: Operation,
  ): void {
    if (!this.isCurrent(operation)) return;
    const safeValues = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        typeof value === 'string' ? safePublicText(value) : value,
      ]),
    );
    const event = {
      at: isoNow(),
      sessionId: this.session?.id ?? null,
      category,
      name: safePublicText(name),
      values: safeValues,
    };
    try {
      const report = this.services.reportDiagnostic(event);
      void report.catch(() => undefined);
    } catch {
      // Detached diagnostics never control playback.
    }
  }

  private presentationNow(): number {
    return this.operation.pipeline?.audioTrack && isAudioContextRunning(this.audioContext)
      ? this.audioContext.currentTime
      : this.services.now() / 1000;
  }

  private playheadAudioTime(): number | undefined {
    const context = this.audioContext;
    if (!context) return undefined;
    // A running AudioContext also advances through silence. Do not seek past
    // unreceived media when the stream's bounded audio queue has run dry.
    return this.operation.pipeline?.audioTrack &&
      !this.operation.audioEnded &&
      this.clock.isAudioAnchored
      ? Math.min(context.currentTime, this.operation.nextAudioTime)
      : context.currentTime;
  }

  private clampToSeekWindow(position: number): number {
    const low = this.state.seekableStartSeconds ?? 0;
    const high =
      this.state.seekableEndSeconds ??
      this.state.durationSeconds ??
      Math.max(low, position);
    return clamp(position, low, Math.max(low, high));
  }

  private initialSnapshot(): PlayerSnapshot {
    return {
      phase: 'idle',
      generation: this.operation.generation,
      sessionId: null,
      isLive: false,
      durationSeconds: null,
      positionSeconds: 0,
      seekableStartSeconds: null,
      seekableEndSeconds: null,
      playbackRate: 1,
      volume: 1,
      muted: false,
      audioUnlocked: this.audioContext?.state === 'running',
      rotationDegrees: 0,
      aspectMode: 'fit',
      qualities: [],
      selectedQualityId: null,
      audioTracks: [],
      selectedAudioTrackId: null,
      subtitleTracks: [],
      selectedSubtitleTrackId: null,
      activeSubtitleCues: [],
      diagnostics: {
        generation: this.operation.generation,
        route: null,
        streamKind: null,
        videoCodec: null,
        audioCodec: null,
        codedWidth: null,
        codedHeight: null,
        renderedFrames: 0,
        droppedFrames: 0,
        videoQueueDepth: 0,
        audioQueueSeconds: 0,
        audioContextState: audioContextState(this.audioContext),
        signedAvOffsetMs: 0,
        measuredAvDriftMs: null,
        stallCount: 0,
        retryCount: 0,
        hardRecoveryCount: 0,
        routeDemotionCount: 0,
        lastProgressAt: null,
        lastError: null,
      },
    };
  }
}

export function createPlayerEngine(options: PlayerEngineOptions): PlayerEngine {
  return new CanvasPlayerEngine(options);
}
