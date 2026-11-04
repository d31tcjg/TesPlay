import { z } from 'zod';

export const CONTRACT_FREEZE_VERSION = '2026-09-29.1' as const;

export const SECURITY_LIMITS = {
  redirectHopsPerResource: 5,
  urlBytes: 8_192,
  responseHeaderBytes: 65_536,
  m3uImportBytes: 5_242_880,
  hlsPlaylistBytes: 2_097_152,
  subtitleBytes: 10_485_760,
  mediaSegmentOrInitBytes: 67_108_864,
  directOrContinuousGenerationBytes: 17_179_869_184,
  rangeSpanBytes: 16_777_216,
  playlistDepth: 6,
  playlistsPerGeneration: 32,
  variantsPerMaster: 100,
  channelsPerImport: 5_000,
  vodSegmentsPerPlaylist: 20_000,
  liveSegmentIdentities: 500,
  playbackSessionsPerOwner: 4,
  ffmpegJobsPerOwner: 1,
  ffmpegJobsTotal: 2,
  pairingLifetimeSeconds: 300,
  playbackCapabilityIdleSeconds: 900,
  playbackCapabilityAbsoluteSeconds: 14_400,
  resolverDeadlineMs: 45_000,
  ffmpegStartupDeadlineMs: 30_000,
  ffmpegOutputIdleDeadlineMs: 60_000,
  ffmpegAbsoluteDeadlineMs: 14_400_000,
  processTerminationGraceMs: 5_000,
} as const;

export const IdSchema = z.uuid();
export const TimestampSchema = z.iso.datetime({ offset: true });
export const NonEmptyTextSchema = z.string().trim().min(1).max(512);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const Base64UrlSha256Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const OpaqueSecretTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43,512}$/u);
export const LanguageCodeSchema = z.string().trim().min(2).max(35);

const malformedPercentEncoding = /%(?![0-9A-Fa-f]{2})/u;
export const utf8ByteLength = (value: string) =>
  new TextEncoder().encode(value).byteLength;
const hasForbiddenUrlCharacters = (value: string) =>
  value.includes('\\') ||
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });

export const HttpUrlSchema = z
  .string()
  .min(1)
  .max(SECURITY_LIMITS.urlBytes)
  .refine((value) => utf8ByteLength(value) <= SECURITY_LIMITS.urlBytes, {
    message: 'URL exceeds the UTF-8 byte limit',
  })
  .refine(
    (value) => {
      if (hasForbiddenUrlCharacters(value) || malformedPercentEncoding.test(value)) {
        return false;
      }
      try {
        const url = new URL(value);
        return (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.hostname !== '' &&
          url.username === '' &&
          url.password === '' &&
          url.hash === ''
        );
      } catch {
        return false;
      }
    },
    {
      message:
        'Only absolute HTTP(S) URLs without user info, fragments, controls, or malformed escapes are accepted',
    },
  );

export const SafeOriginSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.username === '' &&
          url.password === '' &&
          url.pathname === '/' &&
          url.search === '' &&
          url.hash === '' &&
          value === url.origin
        );
      } catch {
        return false;
      }
    },
    {
      message:
        'Expected a canonical HTTP(S) origin without path, query, fragment, or user info',
    },
  );

export const RelativeApiUrlSchema = z
  .string()
  .startsWith('/api/v1/')
  .max(2048)
  .refine((value) => !value.includes('?') && !value.includes('#'), {
    message: 'Owned API URLs must not contain a query or fragment',
  });

export const PasswordSchema = z
  .string()
  .refine((value) => Array.from(value).length >= 12, {
    message: 'Password must contain at least 12 Unicode code points',
  })
  .refine((value) => utf8ByteLength(value) <= 1024, {
    message: 'Password must be at most 1024 UTF-8 bytes',
  });

export const BooleanQuerySchema = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
]);

function boundedJson(value: unknown, maxDepth: number, maxNodes: number): boolean {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) return false;
    if (
      candidate === null ||
      typeof candidate === 'string' ||
      typeof candidate === 'boolean' ||
      (typeof candidate === 'number' && Number.isFinite(candidate))
    ) {
      return true;
    }
    if (Array.isArray(candidate)) {
      return candidate.length <= 128 && candidate.every((item) => visit(item, depth + 1));
    }
    if (typeof candidate === 'object') {
      const entries = Object.entries(candidate as Record<string, unknown>);
      return (
        entries.length <= 64 &&
        entries.every(([key, item]) => key.length <= 128 && visit(item, depth + 1))
      );
    }
    return false;
  };
  return visit(value, 0);
}

export const BoundedJsonObjectSchema = z
  .record(z.string().max(128), z.unknown())
  .superRefine((value, context) => {
    if (!boundedJson(value, 6, 512)) {
      context.addIssue({
        code: 'custom',
        message: 'JSON object exceeds depth or node bounds',
      });
      return;
    }
    try {
      if (utf8ByteLength(JSON.stringify(value)) > 32_768) {
        context.addIssue({ code: 'custom', message: 'JSON object exceeds 32 KiB' });
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'JSON object must be serializable' });
    }
  });

export const ApiErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'CSRF_REJECTED',
  'SETUP_LOCKED',
  'SOURCE_BLOCKED',
  'SOURCE_UNREACHABLE',
  'PROVIDER_RESTRICTED',
  'DRM_UNSUPPORTED',
  'CODEC_UNSUPPORTED',
  'RESOURCE_LIMIT',
  'SESSION_EXPIRED',
  'UPSTREAM_RANGE_UNSUPPORTED',
  'UNSUPPORTED_PROTECTION',
  'CANCELLED',
  'INTERNAL',
]);

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1).max(1024),
    requestId: z.string().min(8).max(128),
    retryable: z.boolean(),
    retryAfterMs: z.number().int().positive().max(86_400_000).optional(),
    details: BoundedJsonObjectSchema.optional(),
  }),
});

export const EmptyResponseSchema = z.object({ ok: z.literal(true) });

export const PaginationQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const PageInfoSchema = z.object({
  nextCursor: z.string().min(1).max(512).nullable(),
  hasMore: z.boolean(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;
export type PageInfo = z.infer<typeof PageInfoSchema>;
