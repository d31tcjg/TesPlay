import { z } from 'zod';

import {
  HttpUrlSchema,
  IdSchema,
  NonEmptyTextSchema,
  OpaqueSecretTokenSchema,
  SECURITY_LIMITS,
  TimestampSchema,
} from '../common.js';

import {
  CompatibilityModeSchema,
  ProviderRestrictionSchema,
  YouTubeVideoIdSchema,
  YouTubeVideoUrlSchema,
} from '../media.js';

import { SourceCredentialInputSchema } from './sources.js';

export const CapabilityAudienceSchema = z.enum([
  'browser-media',
  'api-broker-control',
  'worker-broker-input',
  'api-worker-control',
  'api-resolver-control',
  'resolver-egress',
]);

export const InternalCapabilitySchema = z
  .object({
    audience: CapabilityAudienceSchema,
    token: OpaqueSecretTokenSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

export const CancellationReasonSchema = z.enum([
  'client-disconnected',
  'playback-closed',
  'session-revoked',
  'device-revoked',
  'password-changed',
  'source-deleted',
  'credential-rotated',
  'expired',
  'service-shutdown',
  'operator-requested',
  'superseded',
]);

export const CancellationRequestSchema = z
  .object({ reason: CancellationReasonSchema, requestedAt: TimestampSchema })
  .strict();

export const JobStateSchema = z.enum([
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);

export const BrokerResourceKindSchema = z.enum([
  'm3u-import',
  'media',
  'manifest',
  'segment',
  'init-map',
  'aes-key',
  'subtitle',
  'artwork',
  'resolver-media',
]);

export const PlaybackResourceBindingSchema = z
  .object({
    ownerId: IdSchema,
    deviceId: IdSchema,
    loginSessionId: IdSchema,
    sourceId: IdSchema,
    playbackSessionId: IdSchema,
    playbackGenerationId: IdSchema,
  })
  .strict();

export const WorkerBrokerBindingSchema = z
  .object({
    jobId: IdSchema,
    rootResourceId: OpaqueSecretTokenSchema,
    capability: InternalCapabilitySchema.refine(
      (value) => value.audience === 'worker-broker-input',
      'Expected worker-broker-input capability',
    ),
  })
  .strict();

export const BrokerResourceRegistrationSchema = z
  .object({
    resourceId: OpaqueSecretTokenSchema,
    rootResourceId: OpaqueSecretTokenSchema,
    ownerId: IdSchema,
    deviceId: IdSchema,
    loginSessionId: IdSchema,
    sourceId: IdSchema,
    playbackSessionId: IdSchema,
    playbackGenerationId: IdSchema,
    kind: BrokerResourceKindSchema,
    upstreamUrl: HttpUrlSchema,
    credentials: z.array(SourceCredentialInputSchema).max(8),
    allowedMethods: z
      .array(z.enum(['GET', 'HEAD']))
      .min(1)
      .max(2)
      .refine((methods) => new Set(methods).size === methods.length, {
        message: 'Allowed methods must be unique',
      }),
    workerBinding: WorkerBrokerBindingSchema.nullable(),
    parentResourceId: z.null(),
    nestingDepth: z.literal(0),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(SECURITY_LIMITS.directOrContinuousGenerationBytes),
    remainingGenerationBytes: z
      .number()
      .int()
      .positive()
      .max(SECURITY_LIMITS.directOrContinuousGenerationBytes),
    expiresAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.kind === 'm3u-import' &&
      (value.workerBinding !== null ||
        value.maxResponseBytes > SECURITY_LIMITS.m3uImportBytes)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'M3U imports are bounded control-only resources',
      });
    }
    if (value.rootResourceId !== value.resourceId) {
      context.addIssue({
        code: 'custom',
        path: ['rootResourceId'],
        message: 'API registration creates a root resource only',
      });
    }
    if (value.workerBinding?.rootResourceId !== undefined) {
      if (value.workerBinding.rootResourceId !== value.resourceId) {
        context.addIssue({
          code: 'custom',
          path: ['workerBinding', 'rootResourceId'],
          message: 'Worker binding must name the registered root resource',
        });
      }
      if (
        Date.parse(value.workerBinding.capability.expiresAt) > Date.parse(value.expiresAt)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['workerBinding', 'capability', 'expiresAt'],
          message: 'Worker capability cannot outlive its broker resource',
        });
      }
    }
  });

export const BrokerResourceRegistrationResultSchema = z
  .object({
    registered: z.literal(true),
    playbackSessionId: IdSchema,
    playbackGenerationId: IdSchema,
    expiresAt: TimestampSchema,
    workerBinding: z
      .object({
        jobId: IdSchema,
        capabilityExpiresAt: TimestampSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

export const BrokerFetchControlSchema = z
  .object({
    expectedBinding: PlaybackResourceBindingSchema,
    method: z.enum(['GET', 'HEAD']),
    range: z.string().max(256).nullable(),
  })
  .strict();

export const WorkerOutputFetchControlSchema = BrokerFetchControlSchema;

export const BrokerResourceCloneSchema = z
  .object({
    expectedBinding: PlaybackResourceBindingSchema,
    newResourceId: OpaqueSecretTokenSchema,
    newBinding: PlaybackResourceBindingSchema,
    workerBinding: WorkerBrokerBindingSchema.nullable(),
    remainingGenerationBytes: z
      .number()
      .int()
      .positive()
      .max(SECURITY_LIMITS.directOrContinuousGenerationBytes),
    expiresAt: TimestampSchema,
  })
  .strict();

export const CompatibilityWorkerJobRequestSchema = z
  .object({
    jobId: IdSchema,
    ownerId: IdSchema,
    deviceId: IdSchema,
    loginSessionId: IdSchema,
    sourceId: IdSchema,
    playbackSessionId: IdSchema,
    playbackGenerationId: IdSchema,
    mode: CompatibilityModeSchema.exclude(['none']),
    seekSeconds: z.number().nonnegative().optional(),
    subtitleTrackId: z.string().min(1).max(256).optional(),
    inputs: z
      .array(
        z
          .object({
            resourceId: OpaqueSecretTokenSchema,
            role: z.enum(['muxed', 'video', 'audio', 'subtitle']),
            capability: InternalCapabilitySchema.refine(
              (value) => value.audience === 'worker-broker-input',
              'Expected worker-broker-input capability',
            ),
            videoTrackNumber: z.number().int().min(1).max(128).optional(),
            audioTrackNumber: z.number().int().min(1).max(128).optional(),
            subtitleTrackNumber: z.number().int().min(1).max(128).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    output: z
      .object({
        container: z.enum(['mpeg-ts', 'fmp4', 'hls', 'webvtt']),
        videoCodec: z.enum(['copy', 'avc']).nullable(),
        audioCodec: z.enum(['copy', 'aac']).nullable(),
        maxHeight: z.number().int().min(144).max(4320).nullable(),
      })
      .strict(),
    budgets: z
      .object({
        startupMs: z
          .number()
          .int()
          .min(1000)
          .max(SECURITY_LIMITS.ffmpegStartupDeadlineMs),
        outputIdleMs: z
          .number()
          .int()
          .min(1000)
          .max(SECURITY_LIMITS.ffmpegOutputIdleDeadlineMs),
        absoluteMs: z
          .number()
          .int()
          .min(1000)
          .max(SECURITY_LIMITS.ffmpegAbsoluteDeadlineMs),
        inputBytes: z.number().int().positive().max(2_147_483_648),
        outputBytes: z.number().int().positive().max(2_147_483_648),
        temporaryBytes: z.number().int().positive().max(2_147_483_648),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.mode === 'subtitle-extract') !== (value.subtitleTrackId !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['subtitleTrackId'],
        message: 'An exact subtitle track is required only for subtitle extraction',
      });
    }
    if (value.mode === 'subtitle-extract') {
      const selectedInputs = value.inputs.filter(
        (input) => input.subtitleTrackNumber !== undefined,
      );
      if (selectedInputs.length !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['inputs'],
          message: 'Subtitle extraction requires one exact mapped input',
        });
      }
    }
  });

export const WorkerJobStatusSchema = z
  .object({
    jobId: IdSchema,
    ownerId: IdSchema,
    deviceId: IdSchema,
    loginSessionId: IdSchema,
    sourceId: IdSchema,
    playbackSessionId: IdSchema,
    playbackGenerationId: IdSchema,
    subtitleTrackId: z.string().min(1).max(256).nullable().optional(),
    state: JobStateSchema,
    outputId: OpaqueSecretTokenSchema.nullable(),
    outputMimeType: z.string().max(256).nullable(),
    outputExpiresAt: TimestampSchema.nullable(),
    failureCode: z.string().max(128).nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .refine(
    (value) =>
      [value.outputId, value.outputMimeType, value.outputExpiresAt].every(
        (field) => field === null,
      ) ||
      [value.outputId, value.outputMimeType, value.outputExpiresAt].every(
        (field) => field !== null,
      ),
    { message: 'Worker output identity, type, and expiry must appear together' },
  );

export const ResolverJobRequestSchema = z
  .object({
    jobId: IdSchema,
    input: z.union([
      z.object({ videoId: YouTubeVideoIdSchema }).strict(),
      z.object({ url: YouTubeVideoUrlSchema }).strict(),
    ]),
    deadlineMs: z.number().int().min(1000).max(SECURITY_LIMITS.resolverDeadlineMs),
    capability: InternalCapabilitySchema.refine(
      (value) => value.audience === 'api-resolver-control',
      'Expected api-resolver-control capability',
    ),
  })
  .strict();

export const ResolverJobStatusSchema = z
  .object({
    jobId: IdSchema,
    state: JobStateSchema,
    result: z
      .object({
        title: NonEmptyTextSchema,
        expiresAt: TimestampSchema,
        resources: z
          .array(
            z
              .object({
                role: z.enum(['muxed', 'video', 'audio', 'subtitle']),
                upstreamUrl: HttpUrlSchema,
                mimeType: z.string().max(256).nullable(),
                formatId: z.string().min(1).max(128).nullable(),
                videoCodec: z.string().min(1).max(128).nullable(),
                audioCodec: z.string().min(1).max(128).nullable(),
                language: z.string().min(1).max(35).nullable(),
                label: z.string().min(1).max(256).nullable(),
                width: z.number().int().positive().max(16_384).nullable(),
                height: z.number().int().positive().max(16_384).nullable(),
                frameRate: z.number().positive().max(1000).nullable(),
                bitrate: z.number().int().nonnegative().nullable(),
              })
              .strict(),
          )
          .min(1)
          .max(16),
        protection: z.enum(['clear', 'eme-drm']),
      })
      .strict()
      .nullable(),
    restriction: ProviderRestrictionSchema.nullable(),
    failureCode: z.string().max(128).nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export type BrokerResourceClone = z.infer<typeof BrokerResourceCloneSchema>;

export type BrokerResourceRegistration = z.infer<typeof BrokerResourceRegistrationSchema>;

export type CancellationReason = z.infer<typeof CancellationReasonSchema>;

export type CompatibilityWorkerJobRequest = z.infer<
  typeof CompatibilityWorkerJobRequestSchema
>;
