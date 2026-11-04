import { z } from 'zod';

import {
  HttpUrlSchema,
  IdSchema,
  NonEmptyTextSchema,
  RelativeApiUrlSchema,
  SECURITY_LIMITS,
  SafeOriginSchema,
  TimestampSchema,
  utf8ByteLength,
} from '../common.js';

import {
  ExternalSubtitleInputSchema,
  YouTubeVideoIdSchema,
  YouTubeVideoUrlSchema,
} from '../media.js';

const noCrLf = (value: string) => !/[\r\n]/u.test(value);

export const SourceCredentialKindSchema = z.enum(['basic', 'bearer', 'cookie']);

const credentialScope = { scopeOrigin: SafeOriginSchema };
export const SourceCredentialInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('basic'),
      ...credentialScope,
      username: z.string().min(1).max(256).refine(noCrLf),
      password: z.string().min(1).max(2048).refine(noCrLf),
    })
    .strict(),
  z
    .object({
      kind: z.literal('bearer'),
      ...credentialScope,
      token: z.string().min(1).max(4096).refine(noCrLf),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cookie'),
      ...credentialScope,
      cookie: z.string().min(1).max(8192).refine(noCrLf),
    })
    .strict(),
]);

export const SourceCredentialFlagsSchema = z
  .object({
    basic: z.boolean(),
    bearer: z.boolean(),
    cookie: z.boolean(),
  })
  .strict();

const directSourceLocator = z
  .object({
    kind: z.literal('direct'),
    primaryUrl: HttpUrlSchema,
    audioUrl: HttpUrlSchema.nullable().optional(),
    externalSubtitles: z.array(ExternalSubtitleInputSchema).max(16).optional(),
  })
  .strict();
const m3uSourceLocator = z
  .object({ kind: z.literal('m3u'), playlistUrl: HttpUrlSchema })
  .strict();
const youtubeUrlLocator = z
  .object({ kind: z.literal('youtube'), url: YouTubeVideoUrlSchema })
  .strict();
const youtubeIdLocator = z
  .object({ kind: z.literal('youtube'), videoId: YouTubeVideoIdSchema })
  .strict();

export const SourceLocatorInputSchema = z.union([
  directSourceLocator,
  m3uSourceLocator,
  youtubeUrlLocator,
  youtubeIdLocator,
]);

export const MediaSourceSchema = z
  .object({
    id: IdSchema,
    name: NonEmptyTextSchema,
    kind: z.enum(['direct', 'm3u', 'youtube']),
    displayOrigin: SafeOriginSchema.nullable(),
    credentialFlags: SourceCredentialFlagsSchema,
    enabled: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const CreateMediaSourceSchema = z
  .object({
    name: NonEmptyTextSchema,
    locator: SourceLocatorInputSchema,
    credentials: z.array(SourceCredentialInputSchema).max(8).default([]),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.locator.kind === 'youtube' && value.credentials.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['credentials'],
        message:
          'YouTube resolver credentials are administrator-only and not accepted here',
      });
    }
  });

export const UpdateMediaSourceSchema = z
  .object({
    name: NonEmptyTextSchema.optional(),
    locator: SourceLocatorInputSchema.optional(),
    credentials: z.array(SourceCredentialInputSchema).max(8).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  })
  .superRefine((value, context) => {
    if (value.locator?.kind === 'youtube' && (value.credentials?.length ?? 0) > 0) {
      context.addIssue({
        code: 'custom',
        path: ['credentials'],
        message:
          'YouTube resolver credentials are administrator-only and not accepted here',
      });
    }
  });

export const LibraryItemSchema = z
  .object({
    id: IdSchema,
    sourceId: IdSchema,
    title: NonEmptyTextSchema,
    group: z.string().max(512).nullable(),
    artworkUrl: RelativeApiUrlSchema.nullable(),
    playInput: z.object({ kind: z.literal('library-item'), itemId: IdSchema }).strict(),
    isLive: z.boolean().nullable(),
    favorite: z.boolean(),
    lastPlayedAt: TimestampSchema.nullable(),
    resumePositionSeconds: z.number().nonnegative().nullable(),
    durationSeconds: z.number().positive().nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const ProgressSchema = z
  .object({
    itemId: IdSchema,
    playbackSessionId: IdSchema,
    writerSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    positionSeconds: z.number().nonnegative(),
    durationSeconds: z.number().positive().nullable(),
    completed: z.boolean(),
    updatedAt: TimestampSchema,
  })
  .strict();

export const HistoryEntrySchema = z
  .object({
    id: IdSchema,
    itemId: IdSchema,
    sourceId: IdSchema,
    startedAt: TimestampSchema,
    endedAt: TimestampSchema.nullable(),
    finalPositionSeconds: z.number().nonnegative(),
    route: z.string().min(1).max(64),
  })
  .strict();

export const XtreamServerUrlSchema = HttpUrlSchema.refine(
  (value) => {
    try {
      const url = new URL(value);
      return !/[?#\\\s]/u.test(value) && url.search === '' && url.hash === '';
    } catch {
      return false;
    }
  },
  { message: 'Use an HTTP(S) server base without credentials, query or fragment' },
);

const xtreamAccountPart = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.includes('/') &&
      !value.includes('\\') &&
      !value.includes('%') &&
      !Array.from(value).some(
        (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
      ) &&
      value !== '.' &&
      value !== '..',
    {
      message:
        'Account values cannot contain path separators, percent escapes or controls',
    },
  );
export const XtreamImportRequestSchema = z
  .object({
    kind: z.literal('xtream'),
    sourceName: NonEmptyTextSchema,
    serverUrl: XtreamServerUrlSchema,
    username: xtreamAccountPart,
    password: xtreamAccountPart,
    output: z.enum(['ts', 'm3u8']),
    replaceSourceId: IdSchema.nullable(),
  })
  .strict();

export const ImportRequestSchema = z.discriminatedUnion('kind', [
  XtreamImportRequestSchema,
  z
    .object({
      kind: z.literal('m3u-content'),
      sourceName: NonEmptyTextSchema,
      content: z
        .string()
        .min(1)
        .refine((value) => utf8ByteLength(value) <= SECURITY_LIMITS.m3uImportBytes, {
          message: 'M3U import exceeds the UTF-8 byte limit',
        }),
      replaceSourceId: IdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('m3u-url'),
      sourceName: NonEmptyTextSchema,
      url: HttpUrlSchema,
      credentials: z.array(SourceCredentialInputSchema).max(8).default([]),
      replaceSourceId: IdSchema.nullable(),
    })
    .strict(),
]);

export const ImportResultSchema = z
  .object({
    sourceId: IdSchema,
    imported: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    warnings: z.array(z.string().max(1024)).max(1000),
  })
  .strict();

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export type LibraryItem = z.infer<typeof LibraryItemSchema>;

export type MediaSource = z.infer<typeof MediaSourceSchema>;

export type Progress = z.infer<typeof ProgressSchema>;

export type SourceCredentialInput = z.infer<typeof SourceCredentialInputSchema>;
