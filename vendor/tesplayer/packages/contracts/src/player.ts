import { z } from 'zod';

import { ApiErrorCodeSchema, IdSchema, TimestampSchema } from './common.js';
import {
  CompatibilityModeSchema,
  MediaTrackSchema,
  PlaybackRouteSchema,
  PlaybackSessionSchema,
  QualityRenditionSchema,
  StreamKindSchema,
  SubtitleTrackSchema,
} from './media.js';
import type { ClientCapabilities, CompatibilityMode, PlaybackSession } from './media.js';

export const PlayerPhaseSchema = z.enum([
  'idle',
  'loading',
  'ready',
  'playing',
  'paused',
  'seeking',
  'stalled',
  'ended',
  'stopped',
  'error',
  'destroyed',
]);

export const PlayerErrorSchema = z.object({
  code: ApiErrorCodeSchema.or(
    z.enum([
      'DECODE_FAILED',
      'DEMUX_FAILED',
      'AUDIO_LOCKED',
      'NETWORK_TIMEOUT',
      'HLS_MANIFEST_INVALID',
      'HLS_KEY_FAILED',
      'PROTECTION_UNSUPPORTED',
      'RECOVERY_EXHAUSTED',
      'STALE_OPERATION',
      'ENGINE_DESTROYED',
    ]),
  ),
  message: z.string().min(1).max(1024),
  fatal: z.boolean(),
  retryable: z.boolean(),
  generation: z.number().int().nonnegative(),
  cause: z.string().max(1024).nullable(),
});

export const PlayerPolicySchema = z.object({
  directProbeTimeoutMs: z.number().int().min(250).max(10_000),
  startupTimeoutMs: z.object({
    direct: z.number().int().min(1000).max(120_000),
    provider: z.number().int().min(1000).max(120_000),
    compatibility: z.number().int().min(1000).max(300_000),
  }),
  progressTimeoutMs: z.number().int().min(1000).max(120_000),
  stallCheckIntervalMs: z.number().int().min(250).max(10_000),
  softStallMs: z.number().int().min(1000).max(120_000),
  hardStallMs: z.number().int().min(2000).max(300_000),
  maxHardRecoveries: z.number().int().min(0).max(10),
  maxRouteDemotions: z.number().int().min(0).max(10),
  segmentAttempts: z.number().int().min(1).max(10),
  segmentRetryBaseMs: z.number().int().min(50).max(10_000),
  decodeLookaheadMs: z.number().int().min(100).max(30_000),
  lateFrameDropMs: z.number().int().min(0).max(5000),
  severeLateFrameMs: z.number().int().min(1).max(10_000),
  ptsDiscontinuityMs: z.number().int().min(100).max(60_000),
  maxSignedAvOffsetMs: z.number().int().min(0).max(500),
  liveEdgeTargetDurations: z.number().min(1).max(10),
  maxPlaylistEntries: z.number().int().min(10).max(1000),
  maxSegmentKeys: z.number().int().min(50).max(10_000),
  maxBufferedBytes: z.number().int().min(1_048_576).max(536_870_912),
  maxVideoFrames: z.number().int().min(2).max(240),
  maxAudioSeconds: z.number().min(0.25).max(60),
});

export const DEFAULT_PLAYER_POLICY: z.infer<typeof PlayerPolicySchema> = {
  directProbeTimeoutMs: 1500,
  startupTimeoutMs: { direct: 12_000, provider: 10_000, compatibility: 30_000 },
  progressTimeoutMs: 8000,
  stallCheckIntervalMs: 2000,
  softStallMs: 20_000,
  hardStallMs: 40_000,
  maxHardRecoveries: 3,
  maxRouteDemotions: 2,
  segmentAttempts: 3,
  segmentRetryBaseMs: 500,
  decodeLookaheadMs: 2000,
  lateFrameDropMs: 120,
  severeLateFrameMs: 500,
  ptsDiscontinuityMs: 5000,
  maxSignedAvOffsetMs: 500,
  liveEdgeTargetDurations: 2,
  maxPlaylistEntries: 50,
  maxSegmentKeys: 500,
  maxBufferedBytes: 67_108_864,
  maxVideoFrames: 12,
  maxAudioSeconds: 8,
};

export const PlayerLoadRequestSchema = z.object({
  session: PlaybackSessionSchema,
  resumePositionSeconds: z.number().nonnegative().nullable(),
  autoplay: z.boolean(),
  startAtLiveEdge: z.boolean(),
  preferredQualityId: z.string().min(1).max(256).nullable(),
  preferredAudioTrackId: z.string().min(1).max(256).nullable(),
  preferredSubtitleTrackId: z.string().min(1).max(256).nullable(),
  signedAvOffsetMs: z.number().int().min(-500).max(500),
});

export const PlayerDiagnosticsSchema = z.object({
  generation: z.number().int().nonnegative(),
  route: PlaybackRouteSchema.nullable(),
  streamKind: StreamKindSchema.nullable(),
  videoCodec: z.string().max(128).nullable(),
  audioCodec: z.string().max(128).nullable(),
  codedWidth: z.number().int().nonnegative().nullable(),
  codedHeight: z.number().int().nonnegative().nullable(),
  renderedFrames: z.number().int().nonnegative(),
  droppedFrames: z.number().int().nonnegative(),
  videoQueueDepth: z.number().int().nonnegative(),
  audioQueueSeconds: z.number().nonnegative(),
  audioContextState: z.enum(['unavailable', 'suspended', 'running', 'closed']),
  signedAvOffsetMs: z.number().int(),
  measuredAvDriftMs: z.number().nullable(),
  stallCount: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  hardRecoveryCount: z.number().int().nonnegative(),
  routeDemotionCount: z.number().int().nonnegative(),
  lastProgressAt: TimestampSchema.nullable(),
  lastError: PlayerErrorSchema.nullable(),
});

export const PlayerSubtitleCueSchema = z
  .object({
    id: z.string().min(1).max(256),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().nonnegative(),
    text: z.string().max(8192),
  })
  .refine((cue) => cue.endSeconds > cue.startSeconds, {
    message: 'Subtitle cue end must follow start',
  });

export const PlayerAspectModeSchema = z.enum(['fit', 'fill']);

export const PlayerSnapshotSchema = z.object({
  phase: PlayerPhaseSchema,
  generation: z.number().int().nonnegative(),
  sessionId: IdSchema.nullable(),
  isLive: z.boolean(),
  durationSeconds: z.number().nonnegative().nullable(),
  positionSeconds: z.number().nonnegative(),
  seekableStartSeconds: z.number().nonnegative().nullable(),
  seekableEndSeconds: z.number().nonnegative().nullable(),
  playbackRate: z.number().min(0.25).max(4),
  volume: z.number().min(0).max(1),
  muted: z.boolean(),
  audioUnlocked: z.boolean(),
  rotationDegrees: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  // Older snapshots omit this field; consumers interpret absence as fit.
  aspectMode: PlayerAspectModeSchema.optional(),
  qualities: z.array(QualityRenditionSchema),
  selectedQualityId: z.string().nullable(),
  audioTracks: z.array(MediaTrackSchema),
  selectedAudioTrackId: z.string().nullable(),
  subtitleTracks: z.array(SubtitleTrackSchema),
  selectedSubtitleTrackId: z.string().nullable(),
  activeSubtitleCues: z.array(PlayerSubtitleCueSchema).max(32).default([]),
  diagnostics: PlayerDiagnosticsSchema,
});

export const PlayerCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play') }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('seek'), positionSeconds: z.number().nonnegative() }),
  z.object({ type: z.literal('set-volume'), volume: z.number().min(0).max(1) }),
  z.object({ type: z.literal('set-muted'), muted: z.boolean() }),
  z.object({ type: z.literal('set-rate'), rate: z.number().min(0.25).max(4) }),
  z.object({
    type: z.literal('set-av-offset'),
    signedAvOffsetMs: z.number().int().min(-500).max(500),
  }),
  z.object({ type: z.literal('select-quality'), qualityId: z.string().min(1).max(256) }),
  z.object({
    type: z.literal('select-audio-track'),
    trackId: z.string().min(1).max(256),
  }),
  z.object({
    type: z.literal('select-subtitle-track'),
    trackId: z.string().min(1).max(256).nullable(),
  }),
  z.object({ type: z.literal('extract-subtitles') }),
  z.object({
    type: z.literal('set-rotation'),
    degrees: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  }),
  z.object({ type: z.literal('set-aspect-mode'), mode: PlayerAspectModeSchema }),
  z.object({
    type: z.literal('recover'),
    hard: z.boolean(),
    reason: z.string().max(512),
  }),
]);

export const PlayerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), snapshot: PlayerSnapshotSchema }),
  z.object({ type: z.literal('error'), error: PlayerErrorSchema }),
  z.object({ type: z.literal('ended'), sessionId: IdSchema }),
  z.object({ type: z.literal('audio-unlock-required') }),
  z.object({
    type: z.literal('compatibility-requested'),
    mode: CompatibilityModeSchema,
    reason: z.string().min(1).max(512),
    generation: z.number().int().nonnegative(),
  }),
]);

export interface PlayerEngine {
  readonly capabilities: ClientCapabilities;
  getSnapshot(): PlayerSnapshot;
  load(request: PlayerLoadRequest, signal?: AbortSignal): Promise<void>;
  dispatch(command: PlayerCommand): Promise<void>;
  unlockAudio(): Promise<void>;
  subscribe(listener: (event: PlayerEvent) => void): () => void;
  destroy(): Promise<void>;
}

export interface PlayerEngineServices {
  requestCompatibility(
    sessionId: string,
    mode: CompatibilityMode,
    reason: string,
    signal: AbortSignal,
    seekSeconds?: number,
    expectedGenerationId?: string,
    subtitleTrackId?: string,
  ): Promise<PlaybackSession>;
  requestRouteDemotion?(
    sessionId: string,
    reason: string,
    signal: AbortSignal,
    expectedGenerationId?: string,
  ): Promise<PlaybackSession>;
  requestSelection?(
    sessionId: string,
    selection: {
      expectedGenerationId: string;
      qualityId?: string;
      audioTrackId?: string;
      subtitleTrackId?: string | null;
    },
    signal: AbortSignal,
  ): Promise<PlaybackSession>;
  reportDiagnostic(event: PlayerDiagnosticEvent): Promise<void>;
  now(): number;
}

export interface PlayerEngineFactory {
  create(options: {
    canvas: HTMLCanvasElement;
    audioContext?: AudioContext;
    policy?: PlayerPolicy;
    services: PlayerEngineServices;
    capabilities: ClientCapabilities;
  }): PlayerEngine;
}

export interface PlayerDiagnosticEvent {
  at: string;
  sessionId: string | null;
  category: 'lifecycle' | 'route' | 'decode' | 'clock' | 'recovery' | 'error';
  name: string;
  values: Record<string, boolean | number | string | null>;
}

export type PlayerAspectMode = z.infer<typeof PlayerAspectModeSchema>;
export type PlayerCommand = z.infer<typeof PlayerCommandSchema>;
export type PlayerDiagnostics = z.infer<typeof PlayerDiagnosticsSchema>;
export type PlayerError = z.infer<typeof PlayerErrorSchema>;
export type PlayerEvent = z.infer<typeof PlayerEventSchema>;
export type PlayerLoadRequest = z.infer<typeof PlayerLoadRequestSchema>;
export type PlayerPhase = z.infer<typeof PlayerPhaseSchema>;
export type PlayerPolicy = z.infer<typeof PlayerPolicySchema>;
export type PlayerSnapshot = z.infer<typeof PlayerSnapshotSchema>;
export type PlayerSubtitleCue = z.infer<typeof PlayerSubtitleCueSchema>;
