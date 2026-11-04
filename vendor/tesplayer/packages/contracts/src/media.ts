import { z } from 'zod';

import {
  BoundedJsonObjectSchema,
  HttpUrlSchema,
  IdSchema,
  LanguageCodeSchema,
  NonEmptyTextSchema,
  RelativeApiUrlSchema,
  TimestampSchema,
} from './common.js';

export const VideoCodecSchema = z.enum(['avc', 'hevc', 'vp8', 'vp9', 'av1', 'prores']);
export const AudioCodecSchema = z.enum([
  'aac',
  'opus',
  'mp3',
  'mp2',
  'vorbis',
  'flac',
  'ac3',
  'eac3',
  'dts',
  'pcm',
]);
export const ContainerSchema = z.enum([
  'mp4',
  'quicktime',
  'matroska',
  'webm',
  'mpeg-ts',
  'hls',
  'flv',
  'ogg',
  'mp3',
  'wave',
  'adts',
  'flac',
  'unknown',
]);
export const StreamKindSchema = z.enum([
  'direct-file',
  'dual-input',
  'hls-live-ts',
  'hls-vod-ts',
  'hls-fmp4',
  'continuous-ts',
  'growing-fmp4',
  'flv',
]);
export const ProtectionSchema = z.enum([
  'clear',
  'hls-aes-128',
  'sample-aes',
  'sample-aes-ctr',
  'eme-drm',
  'unknown',
]);
export const PlaybackRouteSchema = z.enum([
  'direct',
  'secure-proxy',
  'compatibility-audio',
  'compatibility-full',
  'transmux-flv',
]);

// Opaque digest of the broker-pinned canonical target, strong ETag, and
// finite object length. It intentionally reveals none of those inputs.
export const MediaRepresentationIdSchema = z.string().regex(/^mr1_[A-Za-z0-9_-]{43}$/u);

// An immutable selector within one published playback generation. Video/audio
// numbers are Mediabunny's per-type one-based order. Subtitle numbers are
// FFmpeg's per-type one-based stream order (including unsupported streams), so
// an explicit subtitle selector maps to `-map 0:s:(trackNumber - 1)`.
export const PlaybackTrackSelectorSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('endpoint'),
        resourceId: z.string().min(1).max(256),
        role: z.enum(['muxed', 'video', 'audio', 'manifest', 'subtitle']).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('file-track'),
        resourceId: z.string().min(1).max(256),
        trackKind: z.enum(['video', 'audio', 'subtitle']),
        trackNumber: z.number().int().min(1).max(128),
        representation: z.enum([
          'mediabunny-track-number-per-type-v1',
          'ffmpeg-subtitle-index-per-type-v1',
        ]),
        representationId: MediaRepresentationIdSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.kind !== 'file-track') return;
    const expected =
      value.trackKind === 'subtitle'
        ? 'ffmpeg-subtitle-index-per-type-v1'
        : 'mediabunny-track-number-per-type-v1';
    if (value.representation !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['representation'],
        message: `Expected ${expected} for ${value.trackKind} tracks`,
      });
    }
  });
export const CompatibilityModeSchema = z.enum([
  'none',
  'audio-only',
  'full',
  'flv-remux',
  'subtitle-extract',
]);

export const MediaTrackSchema = z.object({
  id: z.string().min(1).max(256),
  kind: z.enum(['video', 'audio', 'subtitle']),
  codec: z.string().min(1).max(128),
  language: LanguageCodeSchema.nullable(),
  label: z.string().min(1).max(256).nullable(),
  default: z.boolean(),
  forced: z.boolean().default(false),
  channels: z.number().int().positive().max(32).nullable().optional(),
  sampleRate: z.number().int().positive().max(768_000).nullable().optional(),
  width: z.number().int().positive().max(16_384).nullable().optional(),
  height: z.number().int().positive().max(16_384).nullable().optional(),
  frameRate: z.number().positive().max(1000).nullable().optional(),
  bitrate: z.number().int().nonnegative().nullable().optional(),
  selector: PlaybackTrackSelectorSchema.optional(),
});

export const QualityRenditionSchema = z.object({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(128),
  width: z.number().int().positive().max(16_384).nullable(),
  height: z.number().int().positive().max(16_384).nullable(),
  bandwidth: z.number().int().nonnegative().nullable(),
  averageBandwidth: z.number().int().nonnegative().nullable(),
  videoCodec: z.string().min(1).max(128).nullable(),
  audioCodec: z.string().min(1).max(128).nullable(),
  frameRate: z.number().positive().max(1000).nullable(),
  selector: PlaybackTrackSelectorSchema.optional(),
});

export const SubtitleTrackSchema = z.object({
  id: z.string().min(1).max(256),
  resourceId: z.string().min(1).max(256).optional(),
  label: z.string().min(1).max(256),
  language: LanguageCodeSchema.nullable(),
  format: z.enum(['webvtt', 'srt', 'ttml', 'ass', 'mov_text', 'unknown']),
  origin: z.enum(['external', 'demuxed', 'server-extracted', 'hls-rendition']),
  deliveryFormat: z.enum(['webvtt', 'hls-webvtt']),
  url: RelativeApiUrlSchema,
  default: z.boolean(),
  forced: z.boolean(),
  // Catalogue-only demuxed tracks retain this selector after extraction, so
  // every selection stays bound to the exact immutable file representation.
  selector: PlaybackTrackSelectorSchema.optional(),
});

export const ExternalSubtitleInputSchema = z
  .object({
    url: HttpUrlSchema,
    format: z.enum(['webvtt', 'srt']),
    label: z.string().trim().min(1).max(256),
    language: LanguageCodeSchema.nullable(),
    default: z.boolean().default(false),
    forced: z.boolean().default(false),
  })
  .strict();

export const YouTubeVideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/u);
export const YouTubeVideoUrlSchema = HttpUrlSchema.refine(
  (value) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hash !== '') return false;
    if (url.hostname === 'www.youtube.com') {
      return (
        url.pathname === '/watch' &&
        url.searchParams.size === 1 &&
        YouTubeVideoIdSchema.safeParse(url.searchParams.get('v')).success
      );
    }
    return (
      url.hostname === 'youtu.be' &&
      url.search === '' &&
      YouTubeVideoIdSchema.safeParse(url.pathname.slice(1)).success &&
      url.pathname.split('/').length === 2
    );
  },
  {
    message:
      'Expected an exact canonical https://www.youtube.com/watch?v=<id> or https://youtu.be/<id> URL',
  },
);

const directUrlInput = z
  .object({
    kind: z.literal('direct-url'),
    url: HttpUrlSchema,
    externalSubtitles: z.array(ExternalSubtitleInputSchema).max(16).optional(),
  })
  .strict();
const directDualUrlInput = z
  .object({
    kind: z.literal('direct-dual-url'),
    videoUrl: HttpUrlSchema,
    audioUrl: HttpUrlSchema,
    externalSubtitles: z.array(ExternalSubtitleInputSchema).max(16).optional(),
  })
  .strict();
const youtubeUrlInput = z
  .object({ kind: z.literal('youtube'), url: YouTubeVideoUrlSchema })
  .strict();
const youtubeIdInput = z
  .object({ kind: z.literal('youtube'), videoId: YouTubeVideoIdSchema })
  .strict();
const libraryItemInput = z
  .object({ kind: z.literal('library-item'), itemId: IdSchema })
  .strict();

export const ProviderInputSchema = z.union([
  directUrlInput,
  directDualUrlInput,
  youtubeUrlInput,
  youtubeIdInput,
  libraryItemInput,
]);

export const ProviderRestrictionSchema = z.object({
  code: z.enum([
    'authentication-required',
    'age-restricted',
    'geo-restricted',
    'drm-protected',
    'paid-or-members-only',
    'provider-rate-limited',
    'provider-changed',
    'unavailable',
    'unsupported-provider',
  ]),
  message: z.string().min(1).max(1024),
  retryable: z.boolean(),
});

export const ResolvedMediaResourceSchema = z.object({
  id: z.string().min(1).max(256),
  role: z.enum(['muxed', 'video', 'audio', 'manifest', 'subtitle']),
  mimeType: z.string().min(1).max(256).nullable(),
  container: ContainerSchema,
  codecs: z.array(z.string().min(1).max(128)).max(16),
  contentLength: z.number().int().nonnegative().nullable(),
  rangeSupported: z.boolean().nullable(),
});

export const ResolvedSourceSchema = z.object({
  id: IdSchema,
  provider: z.enum(['direct', 'm3u', 'youtube']),
  title: NonEmptyTextSchema,
  streamKind: StreamKindSchema,
  isLive: z.boolean(),
  protection: ProtectionSchema,
  // Catalogue entries include resolver alternatives and separate caption files.
  // Active playback endpoints and broker byte/admission quotas stay independently bounded.
  resources: z.array(ResolvedMediaResourceSchema).min(1).max(32),
  expiresAt: TimestampSchema.nullable(),
  restrictions: z.array(ProviderRestrictionSchema).max(16),
  headersRequired: z.boolean(),
});

export const ClientCodecCapabilitySchema = z.object({
  codec: z.string().min(1).max(128),
  supported: z.boolean(),
  smooth: z.boolean().nullable(),
  powerEfficient: z.boolean().nullable(),
  testedConfig: BoundedJsonObjectSchema,
  error: z.string().max(512).nullable(),
});

export const ClientCapabilitiesSchema = z.object({
  measuredAt: TimestampSchema,
  synthetic: z.boolean(),
  userAgent: z.string().min(1).max(1024),
  platform: z.string().max(256),
  screen: z.object({
    width: z.number().int().positive().max(32_768),
    height: z.number().int().positive().max(32_768),
    colorDepth: z.number().int().positive().max(128),
    devicePixelRatio: z.number().positive().max(16),
  }),
  touchPoints: z.number().int().nonnegative().max(100),
  hardwareConcurrency: z.number().int().positive().max(1024).nullable(),
  webglRenderer: z.string().max(512).nullable(),
  canvas2d: z.boolean(),
  webAudio: z.boolean(),
  audioContextState: z.enum(['unsupported', 'suspended', 'running', 'closed']),
  webCodecs: z.object({ videoDecoder: z.boolean(), audioDecoder: z.boolean() }),
  mediaSession: z.boolean(),
  fullscreen: z.boolean(),
  codecs: z.array(ClientCodecCapabilitySchema).max(128),
});

export const PlaybackEndpointSchema = z
  .object({
    resourceId: z.string().min(1).max(256),
    role: z.enum(['muxed', 'video', 'audio', 'manifest', 'subtitle']),
    accessUrl: z.union([HttpUrlSchema, RelativeApiUrlSchema]),
    route: PlaybackRouteSchema,
    mimeType: z.string().min(1).max(256).nullable(),
    rangeSupported: z.boolean(),
    expiresAt: TimestampSchema,
    // Endpoint inventory is currently produced by Mediabunny. Subtitle FFmpeg
    // indexing lives on the subtitle selector and shares only representationId.
    representation: z.literal('mediabunny-track-number-per-type-v1').optional(),
    representationId: MediaRepresentationIdSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.representation === undefined) !== (value.representationId === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['representationId'],
        message: 'Representation kind and identifier must be published together',
      });
    }
  });

export const PlaybackSessionSchema = z.object({
  id: IdSchema,
  resolutionId: IdSchema,
  state: z.enum(['preparing', 'ready', 'failed', 'closing', 'closed']),
  route: PlaybackRouteSchema,
  streamKind: StreamKindSchema,
  isLive: z.boolean(),
  protection: ProtectionSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  endpoints: z.array(PlaybackEndpointSchema).min(1).max(16),
  tracks: z.array(MediaTrackSchema).max(128),
  qualities: z.array(QualityRenditionSchema).max(64),
  subtitles: z.array(SubtitleTrackSchema).max(128),
  restriction: ProviderRestrictionSchema.nullable(),
  generationId: IdSchema.optional(),
  selectedQualityId: z.string().min(1).max(256).nullable().optional(),
  selectedAudioTrackId: z.string().min(1).max(256).nullable().optional(),
  selectedSubtitleTrackId: z.string().min(1).max(256).nullable().optional(),
});

export type AudioCodec = z.infer<typeof AudioCodecSchema>;
export type ClientCapabilities = z.infer<typeof ClientCapabilitiesSchema>;
export type CompatibilityMode = z.infer<typeof CompatibilityModeSchema>;
export type Container = z.infer<typeof ContainerSchema>;
export type ExternalSubtitleInput = z.infer<typeof ExternalSubtitleInputSchema>;
export type MediaRepresentationId = z.infer<typeof MediaRepresentationIdSchema>;
export type MediaTrack = z.infer<typeof MediaTrackSchema>;
export type PlaybackRoute = z.infer<typeof PlaybackRouteSchema>;
export type PlaybackTrackSelector = z.infer<typeof PlaybackTrackSelectorSchema>;
export type PlaybackSession = z.infer<typeof PlaybackSessionSchema>;
export type Protection = z.infer<typeof ProtectionSchema>;
export type ProviderInput = z.infer<typeof ProviderInputSchema>;
export type QualityRendition = z.infer<typeof QualityRenditionSchema>;
export type ResolvedSource = z.infer<typeof ResolvedSourceSchema>;
export type StreamKind = z.infer<typeof StreamKindSchema>;
export type SubtitleTrack = z.infer<typeof SubtitleTrackSchema>;
export type VideoCodec = z.infer<typeof VideoCodecSchema>;
