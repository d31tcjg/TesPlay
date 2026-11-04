import { EngineFault } from './errors.js';

export const MAX_HLS_PLAYLIST_BYTES = 2 * 1024 * 1024;
export const MAX_HLS_PLAYLIST_DEPTH = 6;
export const MAX_HLS_VOD_SEGMENTS = 20_000;
export const MAX_HLS_VARIANTS = 100;

export type HlsResourceKind = 'variant' | 'rendition' | 'segment' | 'map' | 'key';
export type HlsResourceTag =
  | 'stream-inf'
  | 'i-frame-stream-inf'
  | 'media'
  | 'session-data'
  | 'segment'
  | 'part'
  | 'preload-hint'
  | 'rendition-report'
  | 'map'
  | 'key'
  | 'session-key';

export interface HlsEncryptionState {
  readonly method: 'AES-128';
  readonly keyUri: string;
  readonly iv: string | null;
  readonly keyFormat: 'identity';
}

export interface HlsByteRange {
  readonly length: number;
  readonly offset: number;
}

export interface HlsResourceReference {
  readonly uri: string;
  readonly kind: HlsResourceKind;
  readonly tag?: HlsResourceTag;
  readonly sequence?: number;
  readonly partIndex?: number;
  readonly discontinuitySequence?: number;
  readonly encryption?: HlsEncryptionState | null;
  readonly byteRange?: HlsByteRange;
}

export interface HlsSegmentMetadata {
  readonly uri: string;
  readonly sequence: number;
  readonly duration: number | null;
  readonly discontinuitySequence: number;
  readonly partIndex: number | null;
  readonly encryption: HlsEncryptionState | null;
  readonly byteRange: HlsByteRange | null;
}

export interface HlsPlaylistBudgetSnapshot {
  readonly resources: number;
  readonly segments: number;
  readonly keyUris: ReadonlySet<string>;
}

export interface HlsPlaylistBudgetState {
  playlists: number;
  resources: number;
  segments: number;
  readonly keyUris: Set<string>;
  /** Active snapshots keyed by a stable caller-owned playlist identity. */
  playlistSnapshots?: Map<string, HlsPlaylistBudgetSnapshot>;
  /** Monotonic successful/failed validation work charged before parsing. */
  validationAttempts?: number;
  validatedBytes?: number;
}

export interface HlsValidationLimits {
  readonly maxSegments?: number;
  readonly maxVariants?: number;
  readonly maxPlaylists?: number;
  readonly maxResources?: number;
  readonly maxActiveSegments?: number;
  readonly maxValidationAttempts?: number;
  readonly maxTotalPlaylistBytes?: number;
  readonly state?: HlsPlaylistBudgetState;
  /** Stable across live refreshes; do not derive this from changing manifest text. */
  readonly playlistIdentity?: string;
  /** Active identities no longer referenced by the caller's current graph. */
  readonly retirePlaylistIdentities?: readonly string[];
}

export interface HlsPlaylistSummary {
  readonly master: boolean;
  readonly endList: boolean;
  readonly targetDuration: number | null;
  readonly mediaSequence: number;
  readonly discontinuitySequence: number;
  readonly segmentCount: number;
  readonly variants: readonly {
    uri: string;
    bandwidth: number | null;
    height: number | null;
  }[];
  readonly resources: readonly HlsResourceReference[];
  readonly segments: readonly HlsSegmentMetadata[];
  readonly keyUris: readonly string[];
  /** Aggregate: at least one declaration/segment in this playlist uses AES-128. */
  readonly protection: 'clear' | 'aes-128';
  /** Key state that applies after the final media-playlist declaration. */
  readonly activeProtection: HlsEncryptionState | null;
  readonly support: {
    readonly playlistResources: number;
    readonly generationPlaylists: number | null;
    readonly generationResources: number | null;
    readonly generationSegments: number | null;
    readonly generationValidationAttempts: number | null;
    readonly generationValidatedBytes: number | null;
    readonly maxPlaylistDepth: number;
  };
}

interface ParsedAttributeList {
  readonly values: Map<string, string>;
}

function invalid(message: string): never {
  throw new EngineFault('HLS_MANIFEST_INVALID', message);
}

function parseAttributes(source: string, role: string): ParsedAttributeList {
  const values = new Map<string, string>();
  let cursor = 0;
  while (cursor < source.length) {
    const nameMatch = /^[A-Z0-9-]+/u.exec(source.slice(cursor));
    const name = nameMatch?.[0];
    if (!name) invalid(`Invalid ${role} attribute name`);
    cursor += name.length;
    if (source[cursor] !== '=') invalid(`Invalid ${role} attribute assignment`);
    cursor++;
    let value: string;
    if (source[cursor] === '"') {
      cursor++;
      const closing = source.indexOf('"', cursor);
      if (closing < 0) invalid(`Unterminated ${role} quoted string`);
      value = source.slice(cursor, closing);
      if (/[\r\n]/u.test(value)) invalid(`Invalid ${role} quoted string`);
      cursor = closing + 1;
    } else {
      const comma = source.indexOf(',', cursor);
      const end = comma < 0 ? source.length : comma;
      value = source.slice(cursor, end);
      if (!value || /[\s"]|=/u.test(value)) invalid(`Invalid ${role} attribute value`);
      cursor = end;
    }
    if (values.has(name)) invalid(`Duplicate ${role} attribute`);
    values.set(name, value);
    if (cursor === source.length) break;
    if (source[cursor] !== ',' || cursor + 1 >= source.length)
      invalid(`Invalid ${role} attribute separator`);
    cursor++;
  }
  if (values.size === 0) invalid(`Missing ${role} attributes`);
  return { values };
}

function attributeList(line: string, role: string): Map<string, string> {
  const colon = line.indexOf(':');
  if (colon < 0) invalid(`Missing ${role} attribute list`);
  return parseAttributes(line.slice(colon + 1), role).values;
}

function requiredAttribute(
  values: Map<string, string>,
  name: string,
  role: string,
): string {
  const value = values.get(name);
  if (!value) invalid(`${role} is missing ${name}`);
  return value;
}

function decimalInteger(value: string, role: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) invalid(`Invalid ${role}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) invalid(`Invalid ${role}`);
  return number;
}

function decimalNumber(value: string, role: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) invalid(`Invalid ${role}`);
  const number = Number(value);
  if (!Number.isFinite(number)) invalid(`Invalid ${role}`);
  return number;
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined || !/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function parseIv(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^0[xX]([0-9A-Fa-f]{1,32})$/u.exec(value);
  const digits = match?.[1];
  if (!digits) invalid('HLS AES-128 declaration has an invalid IV');
  return `0x${digits.toUpperCase().padStart(32, '0')}`;
}

function rejectUnaccountedUriAttributes(
  values: ReadonlyMap<string, string>,
  allowed: ReadonlySet<string>,
  role: string,
): void {
  for (const name of values.keys()) {
    if (/(?:^|-)URI$/u.test(name) && !allowed.has(name))
      invalid(`Unsupported URI-bearing ${role} attribute`);
  }
}

interface ParsedByteRange {
  readonly length: number;
  readonly offset: number | null;
}

function parseByteRange(value: string, role: string): ParsedByteRange {
  const match = /^(0|[1-9]\d*)(?:@(0|[1-9]\d*))?$/u.exec(value);
  const lengthText = match?.[1];
  if (!lengthText) invalid(`Invalid ${role}`);
  const length = Number(lengthText);
  const offsetText = match[2];
  const offset = offsetText === undefined ? null : Number(offsetText);
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    (offset !== null && (!Number.isSafeInteger(offset) || offset < 0))
  )
    invalid(`Invalid ${role}`);
  return { length, offset };
}

function parseKey(
  line: string,
  session: boolean,
): { readonly encryption: HlsEncryptionState | null; readonly uri: string | null } {
  const role = session ? 'HLS session key' : 'HLS key';
  const values = attributeList(line, role);
  rejectUnaccountedUriAttributes(values, new Set(['URI']), role);
  const method = requiredAttribute(values, 'METHOD', role);
  if (method === 'NONE') {
    if (session)
      throw new EngineFault(
        'PROTECTION_UNSUPPORTED',
        'Unsupported HLS session protection mode',
      );
    if (values.size !== 1) invalid('HLS METHOD=NONE must not include key attributes');
    return { encryption: null, uri: null };
  }
  const keyFormat = values.get('KEYFORMAT') ?? 'identity';
  if (method !== 'AES-128' || keyFormat !== 'identity')
    throw new EngineFault('PROTECTION_UNSUPPORTED', 'Unsupported HLS protection mode');
  const uri = requiredAttribute(values, 'URI', role);
  const versions = values.get('KEYFORMATVERSIONS');
  if (versions !== undefined && versions !== '1')
    throw new EngineFault('PROTECTION_UNSUPPORTED', 'Unsupported HLS protection mode');
  return {
    encryption: {
      method: 'AES-128',
      keyUri: uri,
      iv: parseIv(values.get('IV')),
      keyFormat: 'identity',
    },
    uri,
  };
}

function rejectUnknownUriTag(line: string): void {
  if (!line.startsWith('#EXT')) return;
  const colon = line.indexOf(':');
  if (colon < 0) return;
  const payload = line.slice(colon + 1);
  if (/(?:^|,)[A-Z0-9-]*URI\s*=/u.test(payload))
    invalid('Unsupported URI-bearing HLS tag');
}

export function validateHlsPlaylist(
  text: string,
  maxEntries = MAX_HLS_VOD_SEGMENTS + MAX_HLS_VARIANTS,
  maxSegmentKeys = 500,
  limits: HlsValidationLimits = {},
): HlsPlaylistSummary {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
    invalid('Invalid HLS resource entry limit');
  if (!Number.isSafeInteger(maxSegmentKeys) || maxSegmentKeys < 1)
    invalid('Invalid HLS key identity limit');
  const textBytes = new TextEncoder().encode(text).byteLength;
  if (textBytes > MAX_HLS_PLAYLIST_BYTES) invalid('HLS playlist exceeds byte limit');

  const maxSegments = limits.maxSegments ?? MAX_HLS_VOD_SEGMENTS;
  const maxVariants = limits.maxVariants ?? MAX_HLS_VARIANTS;
  const maxPlaylists = limits.maxPlaylists ?? 32;
  const maxResources = limits.maxResources ?? maxEntries;
  const maxActiveSegments = limits.maxActiveSegments ?? maxSegments;
  for (const [value, role] of [
    [maxSegments, 'segment'],
    [maxVariants, 'variant'],
    [maxPlaylists, 'playlist generation'],
    [maxResources, 'generation resource'],
    [maxActiveSegments, 'active segment'],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) invalid(`Invalid HLS ${role} limit`);
  }
  if (
    limits.maxValidationAttempts !== undefined &&
    (!Number.isSafeInteger(limits.maxValidationAttempts) ||
      limits.maxValidationAttempts < 1)
  )
    invalid('Invalid HLS validation work limit');
  if (
    limits.maxTotalPlaylistBytes !== undefined &&
    (!Number.isSafeInteger(limits.maxTotalPlaylistBytes) ||
      limits.maxTotalPlaylistBytes < 1)
  )
    invalid('Invalid HLS validation byte limit');

  const state = limits.state;
  const playlistIdentity = limits.playlistIdentity;
  if (
    playlistIdentity !== undefined &&
    (!playlistIdentity || playlistIdentity.length > 1024)
  )
    invalid('Invalid HLS playlist identity');
  if (playlistIdentity !== undefined && !state)
    invalid('HLS playlist identity requires budget state');
  if (state?.playlistSnapshots && playlistIdentity === undefined)
    invalid('HLS playlist identity is required for snapshot accounting');
  const retirePlaylistIdentities = limits.retirePlaylistIdentities ?? [];
  if (retirePlaylistIdentities.length > 0 && (playlistIdentity === undefined || !state))
    invalid('HLS playlist retirement requires snapshot accounting');
  if (retirePlaylistIdentities.length > maxPlaylists)
    invalid('HLS playlist retirement limit exceeded');
  for (const identity of retirePlaylistIdentities) {
    if (!identity || identity.length > 1024) invalid('Invalid HLS playlist identity');
  }
  if (state) {
    if (
      !Number.isSafeInteger(state.playlists) ||
      state.playlists < 0 ||
      !Number.isSafeInteger(state.resources) ||
      state.resources < 0 ||
      !Number.isSafeInteger(state.segments) ||
      state.segments < 0 ||
      !Number.isSafeInteger(state.validationAttempts ?? 0) ||
      (state.validationAttempts ?? 0) < 0 ||
      !Number.isSafeInteger(state.validatedBytes ?? 0) ||
      (state.validatedBytes ?? 0) < 0
    )
      invalid('Invalid HLS budget state');
    const validationAttempts = (state.validationAttempts ?? 0) + 1;
    const validatedBytes = (state.validatedBytes ?? 0) + textBytes;
    if (
      !Number.isSafeInteger(validationAttempts) ||
      validationAttempts > (limits.maxValidationAttempts ?? Number.MAX_SAFE_INTEGER)
    )
      invalid('HLS validation work limit exceeded');
    if (
      !Number.isSafeInteger(validatedBytes) ||
      validatedBytes > (limits.maxTotalPlaylistBytes ?? Number.MAX_SAFE_INTEGER)
    )
      invalid('HLS validation byte limit exceeded');
    // Attempt work is monotonic. Active snapshots below are committed only after
    // the complete playlist has parsed and all active limits have passed.
    state.validationAttempts = validationAttempts;
    state.validatedBytes = validatedBytes;
  }

  const lines = text
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0] !== '#EXTM3U') invalid('Invalid HLS playlist header');

  const variants: { uri: string; bandwidth: number | null; height: number | null }[] = [];
  const resources: HlsResourceReference[] = [];
  const segments: HlsSegmentMetadata[] = [];
  const keyUris = new Set<string>();
  let targetDuration: number | null = null;
  let mediaSequence = 0;
  let discontinuitySequence = 0;
  let currentDiscontinuity = 0;
  let currentKey: HlsEncryptionState | null = null;
  let containsEncryptedMedia = false;
  let expectSegment: { duration: number; byteRange: ParsedByteRange | null } | null =
    null;
  let previousByteRange: { uri: string; end: number } | null = null;
  let previousMapByteRange: { uri: string; end: number } | null = null;
  let partIndex = 0;
  let completeSegmentCount = 0;
  let nonSegmentResourceCount = 0;

  const addResource = (reference: HlsResourceReference): void => {
    if (!reference.uri || reference.uri.startsWith('#'))
      invalid('HLS resource is missing URI');
    resources.push(reference);
    if (reference.kind !== 'segment') {
      nonSegmentResourceCount++;
      if (nonSegmentResourceCount > maxEntries)
        invalid('HLS playlist resource entry limit exceeded');
    }
  };

  const addKey = (uri: string, tag: 'key' | 'session-key' | 'preload-hint'): void => {
    keyUris.add(uri);
    if (keyUris.size > maxSegmentKeys) invalid('HLS key identity limit exceeded');
    addResource({ uri, kind: 'key', tag });
  };

  const addSegment = (
    uri: string,
    duration: number | null,
    tag: 'segment' | 'part' | 'preload-hint',
    currentPartIndex: number | null,
    byteRange: HlsByteRange | null,
  ): void => {
    const sequence = mediaSequence + completeSegmentCount;
    const encryption = currentKey;
    segments.push({
      uri,
      sequence,
      duration,
      discontinuitySequence: currentDiscontinuity,
      partIndex: currentPartIndex,
      encryption,
      byteRange,
    });
    if (currentPartIndex === null) {
      completeSegmentCount++;
      if (completeSegmentCount > maxSegments) invalid('HLS segment limit exceeded');
    }
    if (encryption) containsEncryptedMedia = true;
    addResource({
      uri,
      kind: 'segment',
      tag,
      sequence,
      ...(currentPartIndex === null ? {} : { partIndex: currentPartIndex }),
      discontinuitySequence: currentDiscontinuity,
      encryption,
      ...(byteRange ? { byteRange } : {}),
    });
  };

  const requireNoPendingSegment = (): void => {
    if (expectSegment) invalid('HLS segment is missing URI');
  };

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;
    if (!line.startsWith('#')) {
      if (!expectSegment) invalid('Unexpected HLS URI line');
      const pendingRange = expectSegment.byteRange;
      let byteRange: HlsByteRange | null = null;
      if (pendingRange) {
        const offset: number | null =
          pendingRange.offset ??
          (previousByteRange?.uri === line ? previousByteRange.end : null);
        if (offset === null) invalid('HLS byte range has no valid previous range');
        const end: number = offset + pendingRange.length;
        if (!Number.isSafeInteger(end)) invalid('Invalid HLS segment byte range');
        byteRange = { length: pendingRange.length, offset };
        previousByteRange = { uri: line, end };
      } else {
        previousByteRange = null;
      }
      addSegment(line, expectSegment.duration, 'segment', null, byteRange);
      expectSegment = null;
      partIndex = 0;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const key = parseKey(line, false);
      currentKey = key.encryption;
      if (key.encryption) containsEncryptedMedia = true;
      if (key.uri) addKey(key.uri, 'key');
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      requireNoPendingSegment();
      const key = parseKey(line, true);
      if (key.encryption) containsEncryptedMedia = true;
      if (key.uri) addKey(key.uri, 'session-key');
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      requireNoPendingSegment();
      const values = attributeList(line, 'HLS variant');
      rejectUnaccountedUriAttributes(values, new Set(), 'HLS variant');
      requiredAttribute(values, 'BANDWIDTH', 'HLS variant');
      const uri = lines[index + 1];
      if (!uri || uri.startsWith('#')) invalid('HLS variant is missing URI');
      index++;
      const resolution = values.get('RESOLUTION');
      let height: number | null = null;
      if (resolution !== undefined) {
        const match = /^(\d+)x(\d+)$/u.exec(resolution);
        if (!match?.[2]) invalid('Invalid HLS variant resolution');
        height = decimalInteger(match[2], 'HLS variant resolution');
      }
      const bandwidthText = values.get('BANDWIDTH');
      const bandwidth = numberOrNull(bandwidthText);
      if (bandwidthText !== undefined && bandwidth === null)
        invalid('Invalid HLS variant bandwidth');
      variants.push({ uri, bandwidth, height });
      if (variants.length > maxVariants) invalid('HLS variant limit exceeded');
      addResource({ uri, kind: 'variant', tag: 'stream-inf' });
    } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      requireNoPendingSegment();
      const values = attributeList(line, 'HLS I-frame variant');
      rejectUnaccountedUriAttributes(values, new Set(['URI']), 'HLS I-frame variant');
      const uri = requiredAttribute(values, 'URI', 'HLS I-frame variant');
      const bandwidthText = requiredAttribute(values, 'BANDWIDTH', 'HLS I-frame variant');
      const bandwidth = numberOrNull(bandwidthText);
      if (bandwidth === null) invalid('Invalid HLS I-frame variant bandwidth');
      variants.push({
        uri,
        bandwidth,
        height: null,
      });
      if (variants.length > maxVariants) invalid('HLS variant limit exceeded');
      addResource({ uri, kind: 'variant', tag: 'i-frame-stream-inf' });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      requireNoPendingSegment();
      const values = attributeList(line, 'HLS rendition');
      rejectUnaccountedUriAttributes(values, new Set(['URI']), 'HLS rendition');
      const type = requiredAttribute(values, 'TYPE', 'HLS rendition');
      requiredAttribute(values, 'GROUP-ID', 'HLS rendition');
      requiredAttribute(values, 'NAME', 'HLS rendition');
      const uri = values.get('URI');
      if (type === 'CLOSED-CAPTIONS' && uri !== undefined)
        invalid('HLS closed-captions rendition must not include URI');
      if (uri) addResource({ uri, kind: 'rendition', tag: 'media' });
    } else if (line.startsWith('#EXT-X-SESSION-DATA:')) {
      requireNoPendingSegment();
      const values = attributeList(line, 'HLS session data');
      rejectUnaccountedUriAttributes(values, new Set(['URI']), 'HLS session data');
      requiredAttribute(values, 'DATA-ID', 'HLS session data');
      const uri = values.get('URI');
      const value = values.get('VALUE');
      if ((uri === undefined) === (value === undefined))
        invalid('HLS session data requires exactly one of URI or VALUE');
      if (uri) addResource({ uri, kind: 'rendition', tag: 'session-data' });
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const values = attributeList(line, 'HLS initialization map');
      rejectUnaccountedUriAttributes(values, new Set(['URI']), 'HLS initialization map');
      const uri = requiredAttribute(values, 'URI', 'HLS initialization map');
      const rangeText = values.get('BYTERANGE');
      let byteRange: HlsByteRange | undefined;
      if (rangeText !== undefined) {
        const parsed = parseByteRange(rangeText, 'HLS initialization map byte range');
        const offset: number | null =
          parsed.offset ??
          (previousMapByteRange?.uri === uri ? previousMapByteRange.end : null);
        if (offset === null) invalid('HLS map byte range has no valid previous range');
        const end: number = offset + parsed.length;
        if (!Number.isSafeInteger(end))
          invalid('Invalid HLS initialization map byte range');
        byteRange = { length: parsed.length, offset };
        previousMapByteRange = { uri, end };
      } else {
        previousMapByteRange = null;
      }
      if (currentKey?.iv === null)
        invalid('Encrypted HLS initialization map requires an IV');
      addResource({
        uri,
        kind: 'map',
        tag: 'map',
        encryption: currentKey,
        ...(byteRange ? { byteRange } : {}),
      });
    } else if (line.startsWith('#EXT-X-PART:')) {
      requireNoPendingSegment();
      const values = attributeList(line, 'HLS partial segment');
      rejectUnaccountedUriAttributes(values, new Set(['URI']), 'HLS partial segment');
      const uri = requiredAttribute(values, 'URI', 'HLS partial segment');
      const duration = decimalNumber(
        requiredAttribute(values, 'DURATION', 'HLS partial segment'),
        'HLS partial segment duration',
      );
      if (duration <= 0) invalid('Invalid HLS partial segment duration');
      addSegment(uri, duration, 'part', partIndex++, null);
    } else if (line.startsWith('#EXT-X-PRELOAD-HINT:')) {
      requireNoPendingSegment();
      const values = attributeList(line, 'HLS preload hint');
      rejectUnaccountedUriAttributes(values, new Set(['URI']), 'HLS preload hint');
      const type = requiredAttribute(values, 'TYPE', 'HLS preload hint');
      const uri = requiredAttribute(values, 'URI', 'HLS preload hint');
      if (type === 'PART') addSegment(uri, null, 'preload-hint', partIndex, null);
      else if (type === 'MAP') {
        if (currentKey?.iv === null)
          invalid('Encrypted HLS initialization map requires an IV');
        addResource({ uri, kind: 'map', tag: 'preload-hint', encryption: currentKey });
      } else if (type === 'KEY') addKey(uri, 'preload-hint');
      else invalid('Unsupported HLS preload hint type');
    } else if (line.startsWith('#EXT-X-RENDITION-REPORT:')) {
      requireNoPendingSegment();
      const values = attributeList(line, 'HLS rendition report');
      rejectUnaccountedUriAttributes(values, new Set(['URI']), 'HLS rendition report');
      const uri = requiredAttribute(values, 'URI', 'HLS rendition report');
      addResource({ uri, kind: 'rendition', tag: 'rendition-report' });
    } else if (
      line.startsWith('#EXT-X-CONTENT-STEERING:') ||
      line.startsWith('#EXT-X-IMAGE-STREAM-INF:')
    ) {
      invalid('Unsupported URI-bearing HLS tag');
    } else if (line.startsWith('#EXTINF:')) {
      requireNoPendingSegment();
      const payload = line.slice(line.indexOf(':') + 1);
      const durationText = payload.split(',', 1)[0];
      if (durationText === undefined) invalid('Invalid HLS segment duration');
      const duration = decimalNumber(durationText, 'HLS segment duration');
      if (duration <= 0) invalid('Invalid HLS segment duration');
      expectSegment = { duration, byteRange: null };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      if (!expectSegment || expectSegment.byteRange)
        invalid('Unexpected or duplicate HLS segment byte range');
      expectSegment.byteRange = parseByteRange(
        line.slice(line.indexOf(':') + 1),
        'HLS segment byte range',
      );
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      requireNoPendingSegment();
      targetDuration = decimalInteger(
        line.slice(line.indexOf(':') + 1),
        'HLS target duration',
      );
      if (targetDuration <= 0) invalid('Invalid HLS target duration');
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      requireNoPendingSegment();
      mediaSequence = decimalInteger(
        line.slice(line.indexOf(':') + 1),
        'HLS media sequence',
      );
    } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
      requireNoPendingSegment();
      discontinuitySequence = decimalInteger(
        line.slice(line.indexOf(':') + 1),
        'HLS discontinuity sequence',
      );
      currentDiscontinuity = discontinuitySequence;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      currentDiscontinuity++;
      if (!Number.isSafeInteger(currentDiscontinuity))
        invalid('Invalid HLS discontinuity sequence');
      partIndex = 0;
    } else {
      rejectUnknownUriTag(line);
    }
  }
  if (expectSegment) invalid('HLS segment is missing URI');

  if (state) {
    let nextPlaylists: number;
    let nextResources: number;
    let nextSegments: number;
    let nextKeyUris: Set<string>;
    if (playlistIdentity !== undefined) {
      if (
        state.playlistSnapshots === undefined &&
        (state.playlists !== 0 ||
          state.resources !== 0 ||
          state.segments !== 0 ||
          state.keyUris.size !== 0)
      )
        invalid('Cannot mix legacy and snapshot HLS budget accounting');
      const snapshots = new Map(state.playlistSnapshots ?? []);
      for (const identity of retirePlaylistIdentities) snapshots.delete(identity);
      snapshots.set(playlistIdentity, {
        resources: resources.length,
        segments: completeSegmentCount,
        keyUris: new Set(keyUris),
      });
      nextPlaylists = snapshots.size;
      nextResources = 0;
      nextSegments = 0;
      nextKeyUris = new Set<string>();
      for (const snapshot of snapshots.values()) {
        if (
          !Number.isSafeInteger(snapshot.resources) ||
          snapshot.resources < 0 ||
          !Number.isSafeInteger(snapshot.segments) ||
          snapshot.segments < 0
        )
          invalid('Invalid HLS playlist snapshot');
        nextResources += snapshot.resources;
        nextSegments += snapshot.segments;
        for (const uri of snapshot.keyUris) nextKeyUris.add(uri);
      }
      if (
        !Number.isSafeInteger(nextResources) ||
        !Number.isSafeInteger(nextSegments) ||
        nextPlaylists > maxPlaylists ||
        nextResources > maxResources ||
        nextSegments > maxActiveSegments ||
        nextKeyUris.size > maxSegmentKeys
      )
        invalid('HLS active snapshot limit exceeded');
      state.playlistSnapshots = snapshots;
    } else {
      nextPlaylists = state.playlists + 1;
      nextResources = state.resources + resources.length;
      nextSegments = state.segments + completeSegmentCount;
      nextKeyUris = new Set([...state.keyUris, ...keyUris]);
      if (
        !Number.isSafeInteger(nextPlaylists) ||
        !Number.isSafeInteger(nextResources) ||
        !Number.isSafeInteger(nextSegments) ||
        nextPlaylists > maxPlaylists ||
        nextResources > maxResources ||
        nextSegments > maxActiveSegments ||
        nextKeyUris.size > maxSegmentKeys
      )
        invalid('HLS generation limit exceeded');
    }
    state.playlists = nextPlaylists;
    state.resources = nextResources;
    state.segments = nextSegments;
    state.keyUris.clear();
    for (const uri of nextKeyUris) state.keyUris.add(uri);
  }

  return {
    master: variants.length > 0,
    endList: lines.includes('#EXT-X-ENDLIST'),
    targetDuration,
    mediaSequence,
    discontinuitySequence,
    segmentCount: segments.filter((item) => item.partIndex === null).length,
    variants,
    resources,
    segments,
    keyUris: [...keyUris],
    protection: containsEncryptedMedia ? 'aes-128' : 'clear',
    activeProtection: currentKey,
    support: {
      playlistResources: resources.length,
      generationPlaylists: state?.playlists ?? null,
      generationResources: state?.resources ?? null,
      generationSegments: state?.segments ?? null,
      generationValidationAttempts: state?.validationAttempts ?? null,
      generationValidatedBytes: state?.validatedBytes ?? null,
      maxPlaylistDepth: MAX_HLS_PLAYLIST_DEPTH,
    },
  };
}

export function selectHlsVariant(
  variants: HlsPlaylistSummary['variants'],
  preferredHeight: number | null,
  maxHeight: number | null,
): number {
  if (variants.length === 0) return -1;
  const candidates = variants
    .map((variant, index) => ({ ...variant, index }))
    .filter(
      (variant) =>
        maxHeight === null || variant.height === null || variant.height <= maxHeight,
    );
  const pool = candidates.length
    ? candidates
    : variants.map((variant, index) => ({ ...variant, index }));
  const first = pool[0];
  if (!first) return -1;
  if (preferredHeight !== null)
    return pool.reduce((best, item) =>
      Math.abs((item.height ?? 0) - preferredHeight) <
      Math.abs((best.height ?? 0) - preferredHeight)
        ? item
        : best,
    ).index;
  return pool.reduce((best, item) =>
    (item.bandwidth ?? 0) > (best.bandwidth ?? 0) ? item : best,
  ).index;
}
