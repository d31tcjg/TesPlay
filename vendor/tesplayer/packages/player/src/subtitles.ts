import type { PlayerSubtitleCue } from '@canvas-stream-player/contracts';

import { EngineFault } from './errors.js';
import { validateHlsPlaylist, type HlsSegmentMetadata } from './hls.js';

export const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
export const MAX_SUBTITLE_CUES = 10_000;
export const MAX_SUBTITLE_TEXT_BYTES = 8192;
export const MAX_SUBTITLE_ID_BYTES = 256;
export const MAX_SUBTITLE_SEGMENT_IDENTITIES = 500;
const MAX_ACTIVE_CUES = 32;
const MPEG_TS_WRAP = 2 ** 33;

export interface SubtitleTimelineState {
  epoch: number;
  discontinuitySequence: number | null;
  lastUnwrappedMpegTs: number | null;
}

export interface SubtitleLoadOptions {
  readonly credentials?: RequestCredentials;
  readonly fetchFn?: typeof fetch;
  readonly maxBytes?: number;
  readonly maxPlaylistEntries?: number;
  readonly maxSegmentKeys?: number;
  readonly seenSegments?: Set<string>;
  readonly timelineState?: SubtitleTimelineState;
  readonly maxRetainedSegmentIdentities?: number;
  readonly windowOverlapSegments?: number;
}

export interface SubtitleLoadResult {
  readonly cues: PlayerSubtitleCue[];
  readonly live: boolean;
  readonly refreshMs: number | null;
  readonly seenSegments: Set<string>;
  readonly timelineEpoch?: number;
  readonly windowStartSeconds?: number | null;
  readonly windowEndSeconds?: number | null;
}

interface TimestampMap {
  readonly localSeconds: number;
  readonly mpegTs: number;
}

function subtitleInvalid(message: string): never {
  throw new EngineFault('HLS_MANIFEST_INVALID', message);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseWebVttTimestamp(value: string): number | null {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/u.exec(value);
  if (!match) return null;
  const hoursText = match[1];
  const minutesText = match[2];
  const secondsText = match[3];
  const millisecondsText = match[4];
  if (!minutesText || !secondsText || !millisecondsText) return null;
  const hours = hoursText ? Number(hoursText) : 0;
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  const milliseconds = Number(millisecondsText);
  if (
    ![hours, minutes, seconds, milliseconds].every(Number.isSafeInteger) ||
    minutes >= 60 ||
    seconds >= 60
  )
    return null;
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function parseSrtTimestamp(value: string): number | null {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/u.exec(value);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (minutes >= 60 || seconds >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

/** WebVTT timestamp parser retained for compatibility with existing callers. */
export function parseTimestamp(value: string): number | null {
  return parseWebVttTimestamp(value.trim());
}

function stripControlCharacters(value: string): string {
  const characters: string[] = [];
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 10 || (code >= 32 && code !== 127)) characters.push(character);
  }
  return characters.join('');
}

function plainText(input: string, role: 'identifier' | 'text'): string {
  const withoutTags = input
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
    .replace(/&nbsp;/gu, ' ');
  const result = stripControlCharacters(withoutTags).trim();
  const limit = role === 'identifier' ? MAX_SUBTITLE_ID_BYTES : MAX_SUBTITLE_TEXT_BYTES;
  if (utf8Length(result) > limit)
    subtitleInvalid(`Subtitle cue ${role} exceeds byte limit`);
  return result;
}

function parseTimestampMap(text: string): TimestampMap | null {
  const lines = text.split('\n');
  const matches = lines.filter((line) => line.startsWith('X-TIMESTAMP-MAP='));
  if (matches.length > 1) subtitleInvalid('Duplicate WebVTT timestamp map');
  const line = matches[0];
  if (!line) return null;
  const payload = line.slice('X-TIMESTAMP-MAP='.length);
  const fields = payload.split(',');
  if (fields.length !== 2) subtitleInvalid('Invalid WebVTT timestamp map');
  const values = new Map<string, string>();
  for (const field of fields) {
    const separator = field.indexOf(':');
    if (separator <= 0) subtitleInvalid('Invalid WebVTT timestamp map');
    const name = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (values.has(name)) subtitleInvalid('Duplicate WebVTT timestamp map field');
    values.set(name, value);
  }
  const local = values.get('LOCAL');
  const mpeg = values.get('MPEGTS');
  const localSeconds = local === undefined ? null : parseWebVttTimestamp(local);
  if (localSeconds === null || mpeg === undefined || !/^(?:0|[1-9]\d*)$/u.test(mpeg))
    subtitleInvalid('Invalid WebVTT timestamp map');
  const mpegTs = Number(mpeg);
  if (!Number.isSafeInteger(mpegTs) || mpegTs < 0 || mpegTs >= MPEG_TS_WRAP)
    subtitleInvalid('Invalid WebVTT timestamp map');
  return { localSeconds, mpegTs };
}

function timestampMapOffset(
  map: TimestampMap | null,
  timeline: SubtitleTimelineState | undefined,
  discontinuitySequence: number | undefined,
): number {
  if (timeline) {
    if (
      !Number.isSafeInteger(timeline.epoch) ||
      timeline.epoch < 0 ||
      (timeline.discontinuitySequence !== null &&
        (!Number.isSafeInteger(timeline.discontinuitySequence) ||
          timeline.discontinuitySequence < 0)) ||
      (timeline.lastUnwrappedMpegTs !== null &&
        !Number.isSafeInteger(timeline.lastUnwrappedMpegTs))
    )
      subtitleInvalid('Invalid subtitle timeline state');
    if (
      discontinuitySequence !== undefined &&
      timeline.discontinuitySequence !== discontinuitySequence
    ) {
      if (timeline.discontinuitySequence !== null) timeline.epoch++;
      timeline.discontinuitySequence = discontinuitySequence;
      timeline.lastUnwrappedMpegTs = null;
    }
  }
  if (!map) return 0;
  let unwrapped = map.mpegTs;
  if (timeline) {
    if (timeline.lastUnwrappedMpegTs !== null) {
      const wraps = Math.round(
        (timeline.lastUnwrappedMpegTs - map.mpegTs) / MPEG_TS_WRAP,
      );
      unwrapped = map.mpegTs + wraps * MPEG_TS_WRAP;
      if (unwrapped < timeline.lastUnwrappedMpegTs - MPEG_TS_WRAP / 2)
        unwrapped += MPEG_TS_WRAP;
    }
    timeline.lastUnwrappedMpegTs = unwrapped;
  }
  return unwrapped / 90_000 - map.localSeconds;
}

function validPercentage(value: string): boolean {
  if (!/^(?:0|[1-9]\d?)(?:\.\d+)?%$|^100(?:\.0+)?%$/u.test(value)) return false;
  const number = Number(value.slice(0, -1));
  return Number.isFinite(number) && number >= 0 && number <= 100;
}

function validateCueSettings(value: string): void {
  if (!value) return;
  const seen = new Set<string>();
  for (const setting of value.split(/[ \t]+/u)) {
    const match = /^(vertical|line|position|size|align):(.+)$/u.exec(setting);
    const name = match?.[1];
    const field = match?.[2];
    if (!name || !field || seen.has(name)) subtitleInvalid('Invalid WebVTT cue settings');
    seen.add(name);
    if (name === 'vertical' && !/^(?:rl|lr)$/u.test(field))
      subtitleInvalid('Invalid WebVTT cue settings');
    if (name === 'line') {
      const [position, alignment, extra] = field.split(',');
      if (
        !position ||
        extra !== undefined ||
        (alignment !== undefined && !/^(?:start|center|end)$/u.test(alignment)) ||
        (position !== 'auto' && !/^-?\d+$/u.test(position) && !validPercentage(position))
      )
        subtitleInvalid('Invalid WebVTT cue settings');
    }
    if (name === 'position') {
      const [position, alignment, extra] = field.split(',');
      if (
        !position ||
        !validPercentage(position) ||
        extra !== undefined ||
        (alignment !== undefined &&
          !/^(?:line-left|center|line-right|auto)$/u.test(alignment))
      )
        subtitleInvalid('Invalid WebVTT cue settings');
    }
    if (name === 'size' && !validPercentage(field))
      subtitleInvalid('Invalid WebVTT cue settings');
    if (name === 'align' && !/^(?:start|center|end|left|right)$/u.test(field))
      subtitleInvalid('Invalid WebVTT cue settings');
  }
}

function appendCue(cues: PlayerSubtitleCue[], cue: PlayerSubtitleCue): void {
  cues.push(cue);
  if (cues.length > MAX_SUBTITLE_CUES)
    subtitleInvalid('Subtitle document exceeds cue limit');
}

function finalCueIdentifier(value: string): string {
  if (utf8Length(value) > MAX_SUBTITLE_ID_BYTES)
    subtitleInvalid('Subtitle cue identifier exceeds byte limit');
  return value;
}

function parseWebVtt(
  normalized: string,
  offsetSeconds: number,
  timeline: SubtitleTimelineState | undefined,
  discontinuitySequence: number | undefined,
): PlayerSubtitleCue[] {
  const blocks = normalized.split(/\n{2,}/u);
  const header = blocks.shift();
  if (!header) subtitleInvalid('WebVTT header is missing');
  const headerLines = header.split('\n');
  const signature = headerLines.shift();
  if (!signature || !/^WEBVTT(?:[ \t].*)?$/u.test(signature) || signature.includes('-->'))
    subtitleInvalid('Invalid WebVTT header');
  if (headerLines.some((line) => line.includes('-->')))
    subtitleInvalid('Invalid WebVTT header metadata');
  const map = parseTimestampMap(headerLines.join('\n'));
  const workingTimeline = timeline ? { ...timeline } : undefined;
  const appliedOffset =
    offsetSeconds + timestampMapOffset(map, workingTimeline, discontinuitySequence);
  if (!Number.isFinite(appliedOffset)) subtitleInvalid('Invalid WebVTT timestamp offset');
  const cues: PlayerSubtitleCue[] = [];
  let serial = 0;
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n').map((line) => line.trimEnd());
    const first = lines[0];
    if (!first) continue;
    if (/^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$)/u.test(first)) continue;
    const timingIndex = first.includes('-->') ? 0 : 1;
    const timingLine = lines[timingIndex];
    if (!timingLine || lines.slice(timingIndex + 1).length === 0)
      subtitleInvalid('Malformed WebVTT cue block');
    const match = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+(.*))?$/u.exec(timingLine);
    if (!match?.[1] || !match[2]) subtitleInvalid('Malformed WebVTT cue timing');
    validateCueSettings(match[3] ?? '');
    const parsedStart = parseWebVttTimestamp(match[1]);
    const parsedEnd = parseWebVttTimestamp(match[2]);
    if (parsedStart === null || parsedEnd === null || parsedEnd <= parsedStart)
      subtitleInvalid('Invalid WebVTT cue range');
    const text = plainText(lines.slice(timingIndex + 1).join('\n'), 'text');
    if (!text) subtitleInvalid('WebVTT cue text is empty');
    const identifier = timingIndex === 1 ? plainText(first, 'identifier') : '';
    const start = parsedStart + appliedOffset;
    const end = parsedEnd + appliedOffset;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)
      subtitleInvalid('Invalid WebVTT mapped cue range');
    const epochPrefix = workingTimeline ? `e${String(workingTimeline.epoch)}-` : '';
    const cueId = finalCueIdentifier(
      `${epochPrefix}${identifier || `webvtt-${String(serial++)}`}`,
    );
    appendCue(cues, {
      id: cueId,
      startSeconds: start,
      endSeconds: end,
      text,
    });
  }
  if (timeline && workingTimeline) Object.assign(timeline, workingTimeline);
  return cues.sort(
    (left, right) =>
      left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds,
  );
}

function parseSrt(normalized: string, offsetSeconds: number): PlayerSubtitleCue[] {
  const blocks = normalized.split(/\n{2,}/u);
  const cues: PlayerSubtitleCue[] = [];
  let previousSequence = 0;
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n').map((line) => line.trimEnd());
    const sequenceText = lines[0];
    const timingLine = lines[1];
    if (
      !sequenceText ||
      !/^[1-9]\d*$/u.test(sequenceText) ||
      !timingLine ||
      lines.length < 3
    )
      subtitleInvalid('Malformed SRT cue block');
    const sequence = Number(sequenceText);
    if (!Number.isSafeInteger(sequence) || sequence <= previousSequence)
      subtitleInvalid('Invalid SRT cue sequence');
    previousSequence = sequence;
    const match =
      /^(\d{2}:\d{2}:\d{2},\d{3})[ \t]+-->[ \t]+(\d{2}:\d{2}:\d{2},\d{3})$/u.exec(
        timingLine,
      );
    if (!match?.[1] || !match[2]) subtitleInvalid('Malformed SRT cue timing');
    const parsedStart = parseSrtTimestamp(match[1]);
    const parsedEnd = parseSrtTimestamp(match[2]);
    if (parsedStart === null || parsedEnd === null || parsedEnd <= parsedStart)
      subtitleInvalid('Invalid SRT cue range');
    const text = plainText(lines.slice(2).join('\n'), 'text');
    if (!text) subtitleInvalid('SRT cue text is empty');
    const start = parsedStart + offsetSeconds;
    const end = parsedEnd + offsetSeconds;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)
      subtitleInvalid('Invalid SRT mapped cue range');
    appendCue(cues, {
      id: `srt-${sequenceText}`,
      startSeconds: start,
      endSeconds: end,
      text,
    });
  }
  return cues.sort(
    (left, right) =>
      left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds,
  );
}

export function parseSubtitles(
  text: string,
  format: 'webvtt' | 'srt',
  offsetSeconds = 0,
  timeline?: SubtitleTimelineState,
  discontinuitySequence?: number,
): PlayerSubtitleCue[] {
  if (!Number.isFinite(offsetSeconds))
    subtitleInvalid('Invalid subtitle timestamp offset');
  if (utf8Length(text) > MAX_SUBTITLE_BYTES)
    subtitleInvalid('Subtitle file exceeds byte limit');
  const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  return format === 'webvtt'
    ? parseWebVtt(normalized, offsetSeconds, timeline, discontinuitySequence)
    : parseSrt(normalized, offsetSeconds);
}

export function activeCuesAt(
  cues: readonly PlayerSubtitleCue[],
  positionSeconds: number,
): PlayerSubtitleCue[] {
  const active: PlayerSubtitleCue[] = [];
  for (const cue of cues) {
    if (cue.startSeconds > positionSeconds) break;
    if (cue.endSeconds > positionSeconds) active.push(cue);
    if (active.length === MAX_ACTIVE_CUES) break;
  }
  return active;
}

export function mergeSubtitleWindowCues(
  retained: readonly PlayerSubtitleCue[],
  incoming: readonly PlayerSubtitleCue[],
  windowStartSeconds: number | null,
  maxCues = MAX_SUBTITLE_CUES,
): PlayerSubtitleCue[] {
  const cues = new Map<string, PlayerSubtitleCue>();
  for (const cue of [...retained, ...incoming]) {
    if (windowStartSeconds !== null && cue.endSeconds <= windowStartSeconds) continue;
    cues.set(`${cue.id}:${String(cue.startSeconds)}:${String(cue.endSeconds)}`, cue);
  }
  return [...cues.values()]
    .sort(
      (left, right) =>
        left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds,
    )
    .slice(-maxCues);
}

function requestStreamCancellation(
  cancel: (reason: string) => Promise<void>,
  reason: string,
): void {
  try {
    // Cleanup is best effort. A hostile stream may never settle cancellation,
    // so rejection and lock release must not wait for confirmation.
    void cancel(reason).catch(() => undefined);
  } catch {
    // A synchronous cleanup failure cannot replace the typed read failure.
  }
}

export async function readBoundedText(
  response: Response,
  maxBytes: number,
  role: string,
): Promise<string> {
  const body = response.body;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    if (body)
      requestStreamCancellation((reason) => body.cancel(reason), 'invalid byte limit');
    throw new EngineFault('HLS_MANIFEST_INVALID', `${role} has invalid byte limit`);
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && !/^\d+$/u.test(declared)) {
    if (body)
      requestStreamCancellation(
        (reason) => body.cancel(reason),
        'invalid content length',
      );
    throw new EngineFault('DEMUX_FAILED', `${role} has invalid content length`);
  }
  const declaredLength = declared === null ? 0 : Number(declared);
  if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
    if (body)
      requestStreamCancellation((reason) => body.cancel(reason), 'declared byte limit');
    throw new EngineFault('HLS_MANIFEST_INVALID', `${role} exceeds byte limit`);
  }
  if (!body)
    throw new EngineFault('DEMUX_FAILED', `${role} response body is unavailable`);
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decodeChunk = (chunk?: Uint8Array, stream = false): string => {
    try {
      return decoder.decode(chunk, { stream });
    } catch (error) {
      throw new EngineFault('HLS_MANIFEST_INVALID', `${role} is not valid UTF-8`, {
        cause: error,
      });
    }
  };
  let total = 0;
  let text = '';
  let cancellationRequested = false;
  const requestReaderCancellation = (reason: string): void => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    requestStreamCancellation((requestReason) => reader.cancel(requestReason), reason);
  };
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = item.value;
      if (total + chunk.byteLength > maxBytes) {
        requestReaderCancellation('byte limit');
        throw new EngineFault('HLS_MANIFEST_INVALID', `${role} exceeds byte limit`);
      }
      total += chunk.byteLength;
      text += decodeChunk(chunk, true);
    }
    text += decodeChunk();
    return text;
  } catch (error) {
    requestReaderCancellation('subtitle read failed');
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function fetchSubtitleText(
  url: string,
  signal: AbortSignal,
  options: SubtitleLoadOptions,
): Promise<string> {
  const response = await (options.fetchFn ?? fetch)(url, {
    credentials: options.credentials ?? 'same-origin',
    referrerPolicy: 'no-referrer',
    signal,
    headers: { Accept: 'application/vnd.apple.mpegurl, text/vtt, text/plain;q=0.9' },
  });
  if (!response.ok) {
    const body = response.body;
    if (body)
      requestStreamCancellation((reason) => body.cancel(reason), 'subtitle HTTP failure');
    throw new EngineFault('DEMUX_FAILED', 'Subtitle resource request failed', {
      retryable: response.status >= 500,
      safeCause: `status=${String(response.status)}`,
    });
  }
  return readBoundedText(
    response,
    options.maxBytes ?? MAX_SUBTITLE_BYTES,
    'Subtitle resource',
  );
}

function segmentIdentity(segment: HlsSegmentMetadata, absoluteUrl: string): string {
  return `${String(segment.sequence)}:${String(segment.discontinuitySequence)}:${absoluteUrl}`;
}

function reapSeenSegments(
  seen: Set<string>,
  segments: readonly HlsSegmentMetadata[],
  identities: ReadonlySet<string>,
  overlap: number,
  maximum: number,
): void {
  const firstSequence = segments[0]?.sequence ?? 0;
  const minimum = Math.max(0, firstSequence - overlap);
  for (const identity of seen) {
    const sequence = Number(identity.slice(0, identity.indexOf(':')));
    if (!Number.isSafeInteger(sequence) || sequence < minimum) seen.delete(identity);
  }
  for (const identity of identities) seen.add(identity);
  if (seen.size > maximum) {
    const ordered = [...seen].sort((left, right) => {
      const leftSequence = Number(left.slice(0, left.indexOf(':')));
      const rightSequence = Number(right.slice(0, right.indexOf(':')));
      return rightSequence - leftSequence;
    });
    seen.clear();
    for (const identity of ordered.slice(0, maximum)) seen.add(identity);
  }
}

export async function loadSubtitleResource(
  url: string,
  format: 'webvtt' | 'srt',
  signal: AbortSignal,
  options: SubtitleLoadOptions = {},
): Promise<SubtitleLoadResult> {
  const seen = options.seenSegments ?? new Set<string>();
  const text = await fetchSubtitleText(url, signal, options);
  if (
    !text
      .replace(/^\uFEFF/u, '')
      .trimStart()
      .startsWith('#EXTM3U')
  ) {
    return {
      cues: parseSubtitles(text, format, 0, options.timelineState),
      live: false,
      refreshMs: null,
      seenSegments: seen,
      ...(options.timelineState ? { timelineEpoch: options.timelineState.epoch } : {}),
      windowStartSeconds: null,
      windowEndSeconds: null,
    };
  }
  if (format !== 'webvtt') subtitleInvalid('Segmented subtitles must be WebVTT');
  const summary = validateHlsPlaylist(
    text,
    options.maxPlaylistEntries,
    options.maxSegmentKeys,
  );
  const base = new URL(url);
  const segments = summary.segments.filter((segment) => segment.partIndex === null);
  const identities = new Set(
    segments.map((segment) => segmentIdentity(segment, new URL(segment.uri, base).href)),
  );
  const maximum = options.maxRetainedSegmentIdentities ?? MAX_SUBTITLE_SEGMENT_IDENTITIES;
  const overlap = options.windowOverlapSegments ?? 32;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    !Number.isSafeInteger(overlap) ||
    overlap < 0
  )
    subtitleInvalid('Invalid subtitle window limit');
  if (segments.length > maximum)
    subtitleInvalid('Subtitle segment window exceeds identity limit');

  const cues: PlayerSubtitleCue[] = [];
  for (const segment of segments) {
    const segmentUrl = new URL(segment.uri, base).href;
    const identity = segmentIdentity(segment, segmentUrl);
    if (seen.has(identity)) continue;
    const segmentText = await fetchSubtitleText(segmentUrl, signal, options);
    const parsedCues = parseSubtitles(
      segmentText,
      'webvtt',
      0,
      options.timelineState,
      segment.discontinuitySequence,
    );
    seen.add(identity);
    cues.push(...parsedCues);
    if (cues.length > MAX_SUBTITLE_CUES) cues.splice(0, cues.length - MAX_SUBTITLE_CUES);
  }
  reapSeenSegments(seen, segments, identities, overlap, maximum);
  const sorted = cues.sort(
    (left, right) =>
      left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds,
  );
  return {
    cues: sorted.slice(-MAX_SUBTITLE_CUES),
    live: !summary.endList,
    refreshMs:
      summary.targetDuration === null
        ? null
        : Math.max(1000, summary.targetDuration * 1000),
    seenSegments: seen,
    ...(options.timelineState ? { timelineEpoch: options.timelineState.epoch } : {}),
    windowStartSeconds: sorted[0]?.startSeconds ?? null,
    windowEndSeconds: sorted.at(-1)?.endSeconds ?? null,
  };
}

export async function loadSubtitleCues(
  url: string,
  format: 'webvtt' | 'srt',
  signal: AbortSignal,
): Promise<PlayerSubtitleCue[]> {
  return (await loadSubtitleResource(url, format, signal)).cues;
}
