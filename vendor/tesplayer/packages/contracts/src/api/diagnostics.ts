import { z } from 'zod';

import { IdSchema, TimestampSchema } from '../common.js';

import { ClientCapabilitiesSchema } from '../media.js';

import { PlayerDiagnosticsSchema } from '../player.js';

import { jsonByteLength } from './serialization.js';

const diagnosticScalar = z.union([
  z.string().max(512),
  z.number(),
  z.boolean(),
  z.null(),
]);
export const DiagnosticEventSchema = z
  .object({
    id: IdSchema.optional(),
    at: TimestampSchema,
    sessionId: IdSchema.nullable(),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    category: z.enum([
      'lifecycle',
      'route',
      'network',
      'decode',
      'clock',
      'recovery',
      'error',
    ]),
    name: z.string().min(1).max(128),
    values: z
      .record(z.string().min(1).max(128), diagnosticScalar)
      .refine(
        (value) => Object.keys(value).length <= 64,
        'At most 64 values are allowed',
      ),
  })
  .strict();

const diagnosticSnapshotBase = z
  .object({
    id: IdSchema.optional(),
    capturedAt: TimestampSchema,
    capabilities: ClientCapabilitiesSchema,
    player: PlayerDiagnosticsSchema.nullable(),
  })
  .strict();

export const DiagnosticSnapshotSchema = diagnosticSnapshotBase.refine(
  (value) => jsonByteLength(value) <= 262_144,
  { message: 'Diagnostic snapshot exceeds 256 KiB' },
);

export const DiagnosticSnapshotInputSchema = diagnosticSnapshotBase
  .omit({ id: true })
  .refine((value) => jsonByteLength(value) <= 262_144, {
    message: 'Diagnostic snapshot exceeds 256 KiB',
  });

export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;

export type DiagnosticSnapshot = z.infer<typeof DiagnosticSnapshotSchema>;
