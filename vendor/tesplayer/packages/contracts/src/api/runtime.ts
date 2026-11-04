import { z } from 'zod';

import { CONTRACT_FREEZE_VERSION, SECURITY_LIMITS, SafeOriginSchema } from '../common.js';

import { PairingModeSchema } from './auth.js';

export const RuntimeConfigSchema = z
  .object({
    apiVersion: z.literal('v1'),
    contractVersion: z.literal(CONTRACT_FREEZE_VERSION),
    configuredOrigin: SafeOriginSchema,
    pairingEnabled: z.boolean(),
    pairingMode: PairingModeSchema,
    compatibilityEnabled: z.boolean(),
    youtubeResolverEnabled: z.boolean(),
    resolverCookieConfigured: z.boolean(),
    trustedDirectOriginCount: z.number().int().min(0).max(1024),
    maxPlaybackSessionsPerOwner: z
      .number()
      .int()
      .min(1)
      .max(SECURITY_LIMITS.playbackSessionsPerOwner),
    maxCompatibilitySessionsPerOwner: z
      .number()
      .int()
      .min(1)
      .max(SECURITY_LIMITS.ffmpegJobsPerOwner),
    maxCompatibilitySessionsTotal: z
      .number()
      .int()
      .min(1)
      .max(SECURITY_LIMITS.ffmpegJobsTotal),
    diagnosticsRetentionDays: z.number().int().min(0).max(30),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.pairingEnabled !== (value.pairingMode !== 'disabled')) {
      context.addIssue({
        code: 'custom',
        path: ['pairingEnabled'],
        message: 'Pairing mode mismatch',
      });
    }
    if (
      value.pairingMode === 'same-device-loopback' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(value.configuredOrigin).hostname,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['configuredOrigin'],
        message: 'Same-device mode requires a loopback configured origin',
      });
    }
    if (
      value.pairingMode === 'cross-device-https' &&
      new URL(value.configuredOrigin).protocol !== 'https:'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['configuredOrigin'],
        message: 'Cross-device pairing requires HTTPS',
      });
    }
  });
