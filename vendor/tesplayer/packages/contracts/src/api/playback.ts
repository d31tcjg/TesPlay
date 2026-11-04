import { z } from 'zod';

import { IdSchema, RelativeApiUrlSchema, TimestampSchema } from '../common.js';

import {
  ClientCapabilitiesSchema,
  CompatibilityModeSchema,
  ProviderInputSchema,
  ProviderRestrictionSchema,
  ResolvedSourceSchema,
} from '../media.js';

export const ResolutionRequestSchema = z
  .object({
    input: ProviderInputSchema,
    maxHeight: z.number().int().min(144).max(4320).nullable(),
    preferredAudioLanguage: z.string().min(2).max(35).nullable(),
  })
  .strict();

export const ResolutionResponseSchema = z
  .object({
    source: ResolvedSourceSchema.nullable(),
    restriction: ProviderRestrictionSchema.nullable(),
  })
  .strict();

export const PlaybackCreateRequestSchema = z
  .object({
    resolutionId: IdSchema,
    capabilities: ClientCapabilitiesSchema,
    preferredRoute: z.enum(['auto', 'direct', 'proxy', 'compatibility']).default('auto'),
    maxHeight: z.number().int().min(144).max(4320).nullable(),
  })
  .strict();

export const PlaybackSelectionSchema = z
  .object({
    expectedGenerationId: IdSchema,
    qualityId: z.string().min(1).max(256).optional(),
    audioTrackId: z.string().min(1).max(256).optional(),
    subtitleTrackId: z.string().min(1).max(256).nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.qualityId !== undefined ||
      value.audioTrackId !== undefined ||
      value.subtitleTrackId !== undefined,
    { message: 'At least one selection is required' },
  );

export const RouteDemotionRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(512),
    expectedGenerationId: IdSchema,
  })
  .strict();

export const CompatibilitySessionSchema = z
  .object({
    id: IdSchema,
    playbackSessionId: IdSchema,
    mode: CompatibilityModeSchema.exclude(['none']),
    state: z.enum([
      'queued',
      'starting',
      'running',
      'ready',
      'failed',
      'cancelled',
      'expired',
    ]),
    outputUrl: RelativeApiUrlSchema.nullable(),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    failure: z.string().max(1024).nullable(),
  })
  .strict();

export const PlaybackSettingsSchema = z
  .object({
    signedAvOffsetMs: z.number().int().min(-500).max(500),
    defaultMaxHeight: z.number().int().min(144).max(4320).nullable(),
    autoplay: z.boolean(),
    resumePlayback: z.boolean(),
    preferredAudioLanguage: z.string().min(2).max(35).nullable(),
    preferredSubtitleLanguage: z.string().min(2).max(35).nullable().optional(),
    subtitlesEnabled: z.boolean().optional(),
    telemetryRetentionDays: z.number().int().min(0).max(30),
  })
  .strict();

export type CompatibilitySession = z.infer<typeof CompatibilitySessionSchema>;

export type PlaybackSettings = z.infer<typeof PlaybackSettingsSchema>;

export type ResolutionRequest = z.infer<typeof ResolutionRequestSchema>;
