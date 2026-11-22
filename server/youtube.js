import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, constants, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { providerError, validateRemoteUrl } from './media.js';
const execute = promisify(execFile);
// Full metadata can include millions of fragment entries for long videos. Print
// only the selected stream fields, retaining all inputs used by validation below.
const streamTemplate = '{"info":%(.{id,is_live,live_status,has_drm,url,vcodec,acodec,protocol,http_headers})j,"formats":%(requested_formats.:.{url,vcodec,acodec,protocol,http_headers,has_drm})j}';

// Fixed, client-safe messages for account-gated videos. Nothing from yt-dlp stderr is ever relayed.
const GATED_PATTERNS = [
  ['members', /members on level|available to this channel['’]s members|join this channel/i],
  ['age', /sign in to confirm your age|age-restricted/i],
  ['private', /private video/i],
  ['bot', /sign in to confirm you['’]re not a bot/i],
];
export const YOUTUBE_GATED_MESSAGES = Object.freeze({
  membersNoCookies: 'This is a members-only YouTube video. TesPlay needs your YouTube account cookies on the server to play it.',
  membersRefused: "YouTube refused this members-only video for your account. Check your channel membership, or refresh TesPlay's YouTube cookies.",
  signInNoCookies: 'Sign-in required: this YouTube video is age-restricted or private. TesPlay needs your YouTube account cookies on the server to play it.',
  signInRefused: "YouTube refused this video for your account (sign-in required). Check your account access, or refresh TesPlay's YouTube cookies.",
});
const GATED_WHITELIST = new Set(Object.values(YOUTUBE_GATED_MESSAGES));
const GENERIC_PREPARE_ERROR = 'YouTube could not prepare this video. Try another video or update the resolver.';
const gatedKind = (error) => GATED_PATTERNS.find(([, pattern]) => pattern.test(`${error?.stderr ?? ''}`))?.[0] ?? null;
const gatedError = (kind, retried) => kind === 'members'
  ? providerError(retried ? YOUTUBE_GATED_MESSAGES.membersRefused : YOUTUBE_GATED_MESSAGES.membersNoCookies, 403)
  : providerError(retried ? YOUTUBE_GATED_MESSAGES.signInRefused : YOUTUBE_GATED_MESSAGES.signInNoCookies, 403);

export function validateYouTubeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(value)) throw providerError('Enter a valid YouTube video ID.', 400);
  return value;
}
export function normalizeYouTube(info, expectedId) {
  if (!info || info.id !== expectedId || info.has_drm || ['is_upcoming', 'post_live'].includes(info.live_status)) throw providerError('This YouTube video is not available for TesPlayer playback.', 422);
  const selected = Array.isArray(info.requested_formats) ? info.requested_formats : [info];
  const endpoint = (format) => {
    const url = validateRemoteUrl(format?.url);
    if (url.protocol !== 'https:' || !/(?:^|\.)(?:googlevideo\.com|youtube\.com)$/.test(url.hostname) || format.has_drm) throw providerError('YouTube did not return a supported media stream.', 422);
    const headers = {};
    for (const [name, value] of Object.entries(format.http_headers || info.http_headers || {})) if (['user-agent', 'referer', 'origin'].includes(name.toLowerCase()) && typeof value === 'string' && value.length <= 2048 && !/[\r\n]/.test(value)) headers[name] = value;
    return { url: url.href, headers, hls: /m3u8/.test(format.protocol || '') || /\.m3u8(?:\?|$)/.test(url.href) };
  };
  const video = selected.find((format) => format.vcodec && format.vcodec !== 'none');
  if (!video) throw providerError('YouTube did not return a playable video stream.', 422);
  const sound = selected.find((format) => format !== video && format.vcodec === 'none' && (format.acodec !== 'none'));
  return { video: endpoint(video), audio: sound ? endpoint(sound) : null, isLive: info.is_live === true };
}

/** Resolve metadata and stream URLs only; no video files or account cookies are downloaded. */
export function createYouTubeResolver({ binary = process.env.YT_DLP_PATH || 'yt-dlp', run = execute, enabled = process.env.YOUTUBE_ENABLED === 'true', resolverUrl = process.env.YOUTUBE_RESOLVER_URL || '', maxHeight = process.env.YOUTUBE_MAX_HEIGHT, cookiesFile = process.env.YOUTUBE_COOKIES_FILE || '' } = {}) {
  if (maxHeight === undefined) maxHeight = 1080;
  else if (![360, 480, 720, 1080, '360', '480', '720', '1080'].includes(maxHeight)) {
    console.warn('Invalid YOUTUBE_MAX_HEIGHT; expected 360, 480, 720 or 1080. Falling back to 1080.');
    maxHeight = 1080;
  }
  let active = 0;
  return async (input, signal) => {
    const id = validateYouTubeId(input);
    if (resolverUrl) {
      try {
        const response = await fetch(new URL(`/resolve/${id}`, resolverUrl), { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(95000)]) : AbortSignal.timeout(95000) });
        if (response.status === 403) {
          const message = await response.json().then((body) => body?.error, () => null);
          const known = GATED_WHITELIST.has(message);
          throw providerError(known ? message : GENERIC_PREPARE_ERROR, known ? 403 : 502);
        }
        if (!response.ok) throw providerError(response.status === 429 ? 'YouTube is preparing another video. Try again in a moment.' : 'YouTube could not prepare this video. Try another video or update the resolver.', response.status === 429 ? 429 : 502);
        const resolved = await response.json();
        // Revalidate the internal resolver response before issuing any media proxy URLs.
        return normalizeYouTube({ id, is_live: resolved.isLive, requested_formats: [
          { ...resolved.video, http_headers: resolved.video?.headers, protocol: resolved.video?.hls ? 'm3u8_native' : 'https', vcodec: 'avc1', acodec: resolved.audio ? 'none' : 'mp4a' },
          ...(resolved.audio ? [{ ...resolved.audio, http_headers: resolved.audio.headers, acodec: 'mp4a', vcodec: 'none' }] : []),
        ] }, id);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error.status) throw error;
        throw providerError('YouTube playback is disabled or its resolver is unavailable. Start the optional youtube Docker profile.', 503);
      }
    }
    if (!enabled) throw providerError('YouTube playback is disabled on this server. Enable the optional youtube Docker profile or set YOUTUBE_ENABLED=true for a native installation.', 503);
    if (active >= 2) throw providerError('YouTube is preparing another video. Try again in a moment.', 429);
    active++;
    try {
      const args = [
        '--ignore-config', '--no-playlist', '--skip-download', '--print', streamTemplate, '--no-warnings', '--no-progress', '--no-cache-dir',
        '--socket-timeout', '15', '--retries', '1', '--extractor-retries', '1', '--js-runtimes', `node:${process.execPath}`,
        '-f', `bv[protocol^=m3u8][height<=${maxHeight}][vcodec^=avc1]+ba[protocol^=m3u8]/bv*[height<=${maxHeight}][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=${maxHeight}][ext=mp4]`,
        '--', `https://www.youtube.com/watch?v=${id}`,
      ];
      const invoke = (argv) => run(binary, argv, { timeout: 90000, maxBuffer: 8 * 1024 * 1024, signal, windowsHide: true });
      let stdout;
      try {
        ({ stdout } = await invoke(args));
      } catch (first) {
        const kind = signal?.aborted ? null : gatedKind(first);
        if (!kind) throw first;
        // Anonymous attempt was account-gated: retry once with a private copy of the cookies, if usable.
        const unavailable = () => (kind === 'bot' ? first : gatedError(kind, false));
        if (!cookiesFile) throw unavailable();
        const dir = await mkdtemp(path.join(tmpdir(), 'tesplay-yt-')).catch(() => null);
        if (!dir) throw unavailable();
        try {
          const copy = path.join(dir, 'cookies.txt');
          try {
            await access(cookiesFile, constants.R_OK);
            await copyFile(cookiesFile, copy);
            await chmod(copy, 0o600);
          } catch { throw unavailable(); }
          const retryArgs = [...args];
          retryArgs.splice(retryArgs.indexOf('--'), 0, '--cookies', copy);
          try {
            ({ stdout } = await invoke(retryArgs));
          } catch (second) {
            const secondKind = signal?.aborted ? null : gatedKind(second);
            if (secondKind) throw gatedError(secondKind, true);
            throw second;
          }
        } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
      }
      const compact = JSON.parse(stdout);
      return normalizeYouTube({ ...compact.info, requested_formats: compact.formats }, id);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error.status) throw error;
      if (error.code === 'ENOENT') throw providerError('YouTube playback needs yt-dlp installed on the TesPlay server.', 503);
      throw providerError('YouTube could not prepare this video. It may be restricted, unavailable, or require a resolver update. Try another video.', 502);
    } finally { active--; }
  };
}
