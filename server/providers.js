import { plainText, mediaDate } from "./text.js";
import { registerStremioRoutes } from './stremio.js';
import { createYouTubeResolver } from "./youtube.js";
import { registerYouTubeBrowser } from "./youtube-browser.js";
import { registerPlexLibrary } from "./plex-library.js";
import { createProviderCache } from "./provider-cache.js";
import { categoryLoaded } from './iptv-selection.js';
import { validateConnection } from './connection-routes.js';
import { createGoogleAuth } from "./google-auth.js";
import { rateLimit } from "express-rate-limit";
import { randomBytes, createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import {
  createMediaService,
  remoteData,
  validateRemoteUrl,
  containedPath,
  mediaTypes,
  providerError,
} from "./media.js";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  processEntities: false,
});
const array = (value) =>
  value == null ? [] : Array.isArray(value) ? value : [value];
const idPattern = /^[A-Za-z0-9_-]{1,200}$/;
const numeric = (input) => {
  if (!/^\d{1,20}$/.test(String(input)))
    throw providerError("Invalid media identifier.");
  return String(input);
};
const opaque = (text) => Buffer.from(text).toString("base64url");
const decode = (text) => {
  if (
    typeof text !== "string" ||
    text.length > 5000 ||
    !/^[A-Za-z0-9_-]*$/.test(text)
  )
    throw providerError("Invalid media identifier.");
  return Buffer.from(text, "base64url").toString("utf8");
};
const cleanText = plainText;
const privateHosts = (url) => [
  validateRemoteUrl(url).hostname.replace(/^\[|\]$/g, ""),
];
const pageData = (query) => ({
  page: Math.min(10000, Math.max(1, Number.parseInt(query.page, 10) || 1)),
  limit: Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 60)),
  q: String(query.q || "")
    .trim()
    .slice(0, 200),
  category: String(query.category || ""),
});
export function paginate(items, query = {}) {
  const { page, limit, q, category } = pageData(query);
  const filtered = items.filter(
    (item) =>
      (!q || item.title.toLowerCase().includes(q.toLowerCase())) &&
      (!category || item.category === category),
  );
  if(query.sort === "recent") filtered.sort((a,b)=>(Date.parse(b.publishedAt || b.addedAt || "")||0)-(Date.parse(a.publishedAt || a.addedAt || "")||0));
  return {
    items: filtered.slice((page - 1) * limit, page * limit),
    hasMore: filtered.length > page * limit,
  };
}

export function parseM3U(text, baseUrl) {
  const entries = [];
  let info = null;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      const attributes = Object.fromEntries(
        [...line.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
      );
      const comma = line.match(/,(?=(?:[^"\n]*"[^"\n]*")*[^"\n]*$)/);
      info = {
        title: cleanText(
          comma
            ? line.slice(comma.index + 1)
            : attributes["tvg-name"] || "Untitled channel",
        ),
        logo: attributes["tvg-logo"],
        category: attributes["group-title"] || "",
        epgId: attributes["tvg-id"] || "",
      };
    } else if (line && !line.startsWith("#")) {
      try {
        const url = validateRemoteUrl(new URL(line, baseUrl)).toString();
        entries.push({
          ...info,
          title: info?.title || `Channel ${entries.length + 1}`,
          id: createHash("sha256").update(url).digest("hex").slice(0, 32),
          url,
        });
      } catch {
        /* Skip unsupported schemes instead of turning them into proxy requests. */
      }
      info = null;
    }
  }
  return entries;
}

const episodeOrder = (a, b) =>
  (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) ||
  (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0) ||
  a.id.localeCompare(b.id, undefined, { numeric: true });
const episodeNumber = (value, fallback) => {
  const n = Number(value);
  return value !== undefined &&
    value !== null &&
    value !== "" &&
    Number.isSafeInteger(n) &&
    n >= 0
    ? n
    : fallback;
};

export function parseXtreamEpisodes(data, connectionId) {
  const seriesId = numeric(data.series_id || data.info?.series_id || "0");
  const items = Object.entries(data.episodes || {}).flatMap(
    ([season, episodes]) =>
      array(episodes).flatMap((episode, index) => {
        if (!episode || !/^\d{1,20}$/.test(String(episode.id))) return [];
        const seasonNumber = episodeNumber(
          episode.season,
          episodeNumber(season, 0),
        );
        const number = episodeNumber(episode.episode_num, index + 1);
        const extension = /^[a-z0-9]{1,8}$/i.test(
          episode.container_extension || "",
        )
          ? episode.container_extension
          : "mp4";
        return [
          {
            id: `${seriesId}:${numeric(episode.id)}:${extension}`,
            connectionId,
            seriesId,
            seasonNumber,
            episodeNumber: number,
            title: cleanText(episode.title || `Episode ${number}`),
            type: "episode",
            source: "IPTV",
            subtitle: cleanText(data.info?.name),
            description: cleanText(episode.info?.plot),
            duration: Number(episode.info?.duration_secs) || undefined,
            category: `Season ${seasonNumber}`,
            poster: episode.info?.movie_image || data.info?.cover,
          },
        ];
      }),
  );
  return [...new Map(items.map((item) => [item.id, item])).values()].sort(
    episodeOrder,
  );
}

export function registerProviderRoutes(app, ctx, dependencies = {}) {
  const fetchData = dependencies.remoteData || remoteData;
  const media = ctx.media || createMediaService(ctx);
  registerStremioRoutes(app, { ...ctx, media }, dependencies);
  const resolveYouTube = dependencies.resolveYouTube || createYouTubeResolver();
  const { cached, cacheKey, catalogCached } = createProviderCache(ctx);
  const pins = new Map();
  const route = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);
  const connection = (req, id, type) => {
    const c = ctx.getConnection(req, String(id || ""));
    if (type && c.type !== type)
      throw providerError("Incorrect connection type.");
    return c;
  };
  const permitted = (req,c,value) => categoryLoaded(c,value) && (ctx.canAccess ? ctx.canAccess(req,c,value) : true);
  const ensure = (req,c,value) => { if (!categoryLoaded(c,value)) throw providerError('This category is not loaded. Enable it in IPTV settings.',403); if(ctx.assertAccess) ctx.assertAccess(req,c,value); };
  const saveConfig = (req, c, config) => {
    // A token refresh must not overwrite settings edited during the request.
    const current = ctx.getConnection(req, c.id);
    return ctx.saveConnection(req, {
      id: c.id,
      type: c.type,
      name: current.name,
      config: { ...current.config, ...config },
    }, { allowShared: true });
  };
  const art = (req, c, url, headers = {}) => {
    if (!url) return undefined;
    try {
      const u = validateRemoteUrl(url);
      return media.register(req, c, {
        kind: "artwork",
        url: u.toString(),
        headers:
          c.config.url && new URL(c.config.url).origin === u.origin
            ? headers
            : {},
        allowedPrivateHosts: c.config.url ? privateHosts(c.config.url) : [],
      });
    } catch {
      return undefined;
    }
  };
  const itemBase = (c, data) => ({
    connectionId: c.id,
    source: c.type === "youtube" ? "YouTube" : c.name,
    providerType: c.type,
    ...data,
  });
  async function xtream(c, action, params = {}) {
    const u = validateRemoteUrl(c.config.url);
    u.pathname = u.pathname.replace(
      /\/?(?:player_api\.php)?$/,
      "/player_api.php",
    );
    u.search = new URLSearchParams({
      username: c.config.username || "",
      password: c.config.password || "",
      ...(action ? { action } : {}),
      ...params,
    }).toString();
    const result = await fetchData(u, {
      allowedPrivateHosts: privateHosts(c.config.url),
    });
    if (result?.user_info && String(result.user_info.auth) !== "1")
      throw providerError("The IPTV provider rejected these credentials.");
    return result;
  }
  async function channelsRequest(c, pathname, options = {}) {
    const url = new URL(pathname, validateRemoteUrl(c.config.url));
    return fetchData(url, { ...options, allowedPrivateHosts: privateHosts(c.config.url) });
  }
  const channelsNumber = /^\d{1,5}(\.\d{1,3})?$/;
  const channelsFileId = /^\d{1,10}$/;
  const channelsFolders = [
    ['channels:live', 'Live TV', 'live'],
    ['channels:shows', 'TV Shows', 'series'],
    ['channels:movies', 'Movies', 'movie'],
  ];
  const channelsRevisions = new Map();
  function channelsList(c, pathname, force = false) {
    // Unlike manually refreshed IPTV catalogs, DVR recordings change frequently.
    const key = `${cacheKey(c)}:channels:${pathname}`;
    if (force) {
      channelsRevisions.set(key, (channelsRevisions.get(key) || 0) + 1);
      if (channelsRevisions.size > 300) channelsRevisions.delete(channelsRevisions.keys().next().value);
    }
    return cached(`${key}:${channelsRevisions.get(key) || 0}`,
      async () => {
        const data = await channelsRequest(c, pathname);
        if (!Array.isArray(data)) throw providerError('Channels DVR returned an invalid catalog.', 502);
        return data;
      }, 30);
  }
  function channelsShowId(id) {
    // Show IDs are opaque, but cannot be URL path separators or dot segments.
    if (typeof id !== 'string' || !id.length || id.length > 200 || /[\x00-\x1f\x7f/\\]/.test(id) || ['.', '..'].includes(id))
      throw providerError('Invalid Channels DVR show identifier.');
    return encodeURIComponent(id);
  }
  const channelsTime = value => Number.isFinite(Number(value)) ? Number(value) : Date.parse(value) || 0;
  function channelsRecording(req, c, x, movie = false, showId = x.show_id) {
    return itemBase(c, {
      id:`${movie ? 'movie' : 'file'}:${x.id}`, type:movie ? 'movie' : 'episode',
      contentKind:movie ? 'movie' : 'series', title:cleanText(x.episode_title || x.title),
      ...(!movie && showId != null ? {seriesId:`show:${showId}`} : {}),
      seasonNumber:episodeNumber(x.season_number, undefined), episodeNumber:episodeNumber(x.episode_number, undefined),
      description:cleanText(x.summary), year:String(x.release_year || ''),
      duration:Math.max(0, Number(x.duration) || 0), resumeSeconds:Math.max(0, Number(x.playback_time) || 0),
      watched:!!(x.watched || x.completed), poster:art(req, c, x.image_url), backdrop:art(req, c, x.thumbnail_url),
      addedAt:mediaDate(x.created_at),
    });
  }
  async function channelsEpisodes(req, c, showId, force = false) {
    ensure(req, c, {type:'series'});
    const raw = await channelsList(c, `/api/v1/shows/${channelsShowId(showId)}/episodes`, force);
    return raw.filter(x => !x.cancelled && channelsFileId.test(String(x.id)))
      .sort((a,b) => {
        const numbered = [a,b].every(x => episodeNumber(x.season_number, undefined) !== undefined && episodeNumber(x.episode_number, undefined) !== undefined);
        return (numbered ? Number(a.season_number)-Number(b.season_number) || Number(a.episode_number)-Number(b.episode_number) : channelsTime(b.created_at)-channelsTime(a.created_at)) || String(a.id).localeCompare(String(b.id), undefined, {numeric:true});
      }).map(x => channelsRecording(req, c, x, false, showId)).filter(x => permitted(req, c, x));
  }
  async function channelsFile(c, id, movie = false) {
    if (!channelsFileId.test(id)) throw providerError('Invalid Channels DVR recording identifier.');
    const raw = await channelsList(c, movie ? '/api/v1/movies' : '/api/v1/episodes');
    const file = raw.find(x => String(x.id) === id && !x.cancelled);
    if (!file) throw providerError('Channels DVR recording not found.', 404);
    return file;
  }
  async function channelsCatalog(req, c, parent, force) {
    if (!parent) return channelsFolders.filter(([, , type]) => permitted(req, c, { type }))
      .map(([id, title, contentKind]) => itemBase(c, { id, title, contentKind, type: 'folder' }));
    if (parent === 'channels:live') {
      ensure(req, c, {type:'live'});
      const [channels, logos] = await Promise.all([
        channelsList(c, '/api/v1/channels', force), channelsList(c, '/devices/ANY/channels', force),
      ]);
      const byNumber = new Map(logos.map(x => [String(x.GuideNumber), x]));
      return channels.filter(x => !x.hidden && channelsNumber.test(String(x.number)))
        .sort((a,b) => String(a.number).localeCompare(String(b.number), undefined, {numeric:true}))
        .map(x => itemBase(c, {
          id:`live:${x.number}`, title:cleanText(`${x.number} ${x.name}`), type:'live',
          category:cleanText(x.source_name), subtitle:x.hd ? 'HD' : undefined,
          poster:art(req, c, byNumber.get(String(x.number))?.Logo),
        })).filter(x => permitted(req, c, x));
    }
    if (parent === 'channels:shows') {
      ensure(req, c, {type:'series'});
      return (await channelsList(c, '/api/v1/shows', force))
        .sort((a,b) => channelsTime(b.last_recorded_at)-channelsTime(a.last_recorded_at))
        .map(x => {
          const id = String(x.id); channelsShowId(id);
          return itemBase(c, {id:`show:${id}`, title:cleanText(x.name), type:'series',
            description:cleanText(x.summary), poster:art(req,c,x.image_url), year:String(x.release_year || ''),
            unwatchedCount:Math.max(0, Number(x.number_unwatched) || 0),
            subtitle:`${Math.max(0, Number(x.number_unwatched) || 0)} unwatched`,
          });
        }).filter(x => permitted(req,c,x));
    }
    if (parent.startsWith('show:')) return channelsEpisodes(req, c, parent.slice(5), force);
    if (parent === 'channels:recent') {
      // Cross-show "Recently recorded": newest finished, unwatched episodes and movies.
      const [episodes, movies] = await Promise.all([
        channelsList(c, '/api/v1/episodes', force), channelsList(c, '/api/v1/movies', force).catch(() => []),
      ]);
      const usable = x => !x.cancelled && !x.corrupted && !x.watched && x.processed !== false && channelsFileId.test(String(x.id));
      return [...episodes.filter(usable).map(x => [x, false]), ...movies.filter(usable).map(x => [x, true])]
        .sort(([a], [b]) => channelsTime(b.created_at)-channelsTime(a.created_at))
        .map(([x, movie]) => {
          const item = channelsRecording(req, c, x, movie);
          if (!movie) item.subtitle = cleanText(x.title);
          return item;
        }).filter(x => permitted(req, c, x)).slice(0, 60);
    }
    if (parent === 'channels:movies') {
      ensure(req, c, {type:'movie'});
      return (await channelsList(c, '/api/v1/movies', force))
        .filter(x => !x.cancelled && channelsFileId.test(String(x.id)))
        .map(x => channelsRecording(req,c,x,true)).filter(x => permitted(req,c,x));
    }
    throw providerError('Invalid Channels DVR folder.');
  }
  // ---- Channels DVR guide (v2) ----
  const guideNow = () => Math.floor((dependencies.now ? dependencies.now() : Date.now()) / 1000);
  const guideCache = new Map();
  const GUIDE_TTL = 60, GUIDE_ART_BUDGET = 400;
  function guideFetch(c, start, hours, path) {
    const key = `${cacheKey(c)}:${path ? 'now' : `${start}:${hours}`}`;
    const hit = guideCache.get(key);
    if (hit && hit.expires > guideNow()) return hit.promise;
    const promise = channelsRequest(c, path || `/devices/ANY/guide?time=${start}&duration=${hours * 3600}`).then(data => {
      if (!Array.isArray(data)) throw providerError('Channels DVR returned an invalid guide.', 502);
      return data;
    });
    guideCache.set(key, { promise, expires: guideNow() + GUIDE_TTL, start, hours, prefix: cacheKey(c) });
    if (guideCache.size > 12) guideCache.delete(guideCache.keys().next().value);
    promise.catch(() => { if (guideCache.get(key)?.promise === promise) guideCache.delete(key); });
    return promise;
  }
  /** A live (unexpired) already-requested window covering `time`, or undefined. Never fetches. */
  function guidePeek(c, time) {
    const prefix = cacheKey(c);
    for (const entry of guideCache.values())
      if (entry.prefix === prefix && entry.hours && entry.expires > guideNow() && entry.start <= time && time < entry.start + entry.hours * 3600) return entry.promise;
  }
  const guideInt = (value, fallback) => { const n = Number.parseInt(value, 10); return Number.isFinite(n) ? n : fallback; };
  function guideWindow(query) {
    const now = guideNow();
    const hours = Math.min(6, Math.max(1, guideInt(query.hours, 3)));
    const wanted = Math.min(now + 7 * 86400, Math.max(now - 2 * 3600, guideInt(query.start, now)));
    return { hours, start: Math.floor(wanted / 1800) * 1800 };
  }
  const guideMeta = async (c, force = false) => {
    // HD/source/hidden metadata is best-effort: the guide stays usable without it.
    const rows = await channelsList(c, '/api/v1/channels', force).catch(() => []);
    return new Map(rows.map(x => [String(x.number), x]));
  };
  function guideAiring(req, c, a, { image = false, long = false } = {}) {
    const start = Number(a.Time), end = start + Number(a.Duration);
    const tags = Array.isArray(a.Tags) ? a.Tags : [];
    const text = long ? (a.FullSummary || a.Summary) : a.Summary;
    const genres = (Array.isArray(a.Genres) ? a.Genres : []).slice(0, 3).map(cleanText).filter(Boolean);
    return {
      start, end, title: cleanText(a.Title), episodeTitle: cleanText(a.EpisodeTitle) || undefined,
      summary: cleanText(text).slice(0, long ? 1500 : 400) || undefined,
      image: image ? art(req, c, a.Image) : undefined,
      season: episodeNumber(a.SeasonNumber, undefined), episode: episodeNumber(a.EpisodeNumber, undefined),
      isNew: tags.includes('New'), isLive: tags.includes('Live'),
      genres: genres.length ? genres : undefined, seriesId: a.SeriesID ? String(a.SeriesID).slice(0, 100) : undefined,
    };
  }
  async function guideChannels(req, c, rows, { start, end, now, mode }) {
    ensure(req, c, { type: 'live' });
    const meta = await guideMeta(c);
    const needLogos = rows.some(r => !r?.Channel?.Image);
    const logos = needLogos ? new Map((await channelsList(c, '/devices/ANY/channels').catch(() => [])).map(x => [String(x.GuideNumber), x.Logo])) : new Map();
    let budget = GUIDE_ART_BUDGET;
    const seen = new Set();
    const channels = rows.filter(r => r && r.Channel && channelsNumber.test(String(r.Channel.Number)) && !r.Channel.Hidden
      && !meta.get(String(r.Channel.Number))?.hidden && !seen.has(String(r.Channel.Number)) && seen.add(String(r.Channel.Number)))
      .sort((a, b) => String(a.Channel.Number).localeCompare(String(b.Channel.Number), undefined, { numeric: true }))
      .flatMap(r => {
        const number = String(r.Channel.Number), m = meta.get(number);
        const item = { id: `live:${number}`, type: 'live', category: cleanText(m?.source_name) };
        if (!permitted(req, c, item)) return [];
        const airings = (Array.isArray(r.Airings) ? r.Airings : [])
          .filter(a => a && Number.isFinite(Number(a.Time)) && Number(a.Duration) > 0 && Number(a.Time) + Number(a.Duration) > start && Number(a.Time) < end)
          .sort((a, b) => Number(a.Time) - Number(b.Time));
        const logo = budget > 0 ? (budget--, art(req, c, r.Channel.Image || logos.get(number))) : undefined;
        return [{ r, number, m, airings, logo }];
      }).map(({ r, number, m, airings, logo }) => {
        const out = airings.map(a => {
          const onNow = mode === 'now' || (Number(a.Time) <= now && now < Number(a.Time) + Number(a.Duration));
          const image = onNow && budget > 0;
          if (image) budget--;
          return guideAiring(req, c, a, { image });
        });
        return { id: `live:${number}`, number, name: cleanText(r.Channel.Name), callSign: cleanText(r.Channel.CallSign) || undefined,
          logo, hd: m?.hd ? true : undefined, source: cleanText(m?.source_name) || undefined, airings: out };
      });
    return channels;
  }
  app.get('/api/channels/:connectionId/guide', route(async (req, res) => {
    const c = connection(req, req.params.connectionId, 'channels');
    ensure(req, c, { type: 'live' });
    const { start, hours } = guideWindow(req.query), end = start + hours * 3600;
    const rows = await guideFetch(c, start, hours);
    res.json({ start, end, channels: await guideChannels(req, c, rows, { start, end, now: guideNow(), mode: 'guide' }) });
  }));
  app.get('/api/channels/:connectionId/now', route(async (req, res) => {
    const c = connection(req, req.params.connectionId, 'channels');
    ensure(req, c, { type: 'live' });
    const now = guideNow();
    const rows = await guideFetch(c, 0, 0, '/devices/ANY/guide/now');
    const channels = await guideChannels(req, c, rows, { start: -Infinity, end: Infinity, now, mode: 'now' });
    const window = guidePeek(c, now);
    if (window) {
      // Only use a window that is already cached: "next" must not cost another upstream request.
      const upstream = new Map((await window).filter(r => r?.Channel).map(r => [String(r.Channel.Number), r.Airings || []]));
      for (const channel of channels) {
        const current = channel.airings[0], after = (upstream.get(channel.number) || [])
          .filter(a => Number(a.Time) >= (current ? current.end : now)).sort((a, b) => Number(a.Time) - Number(b.Time))[0];
        if (after) channel.next = { start: Number(after.Time), end: Number(after.Time) + Number(after.Duration), title: cleanText(after.Title), episodeTitle: cleanText(after.EpisodeTitle) || undefined };
      }
    }
    res.json({ start: now, end: now, channels });
  }));
  app.get('/api/channels/:connectionId/airing', route(async (req, res) => {
    const c = connection(req, req.params.connectionId, 'channels');
    ensure(req, c, { type: 'live' });
    const number = String(req.query.channel || ''), timeText = String(req.query.time || '');
    if (!channelsNumber.test(number)) throw providerError('Invalid Channels DVR channel.');
    if (!/^\d{1,12}$/.test(timeText)) throw providerError('Invalid guide time.');
    const time = Number(timeText);
    const rows = await (guidePeek(c, time) || guideFetch(c, Math.floor(time / 1800) * 1800, 1));
    const row = rows.find(r => String(r?.Channel?.Number) === number);
    const airing = (row?.Airings || []).find(a => Number(a.Time) <= time && time < Number(a.Time) + Number(a.Duration));
    const meta = (await guideMeta(c)).get(number);
    if (!row || !airing || row.Channel.Hidden || meta?.hidden) throw providerError('Channels DVR airing not found.', 404);
    if (!permitted(req, c, { id: `live:${number}`, type: 'live', category: cleanText(meta?.source_name) })) throw providerError('Channels DVR airing not found.', 404);
    res.json({ channel: { id: `live:${number}`, number, name: cleanText(row.Channel.Name) }, airing: guideAiring(req, c, airing, { image: true, long: true }) });
  }));
  async function readPlaylist(c) {
    return parseM3U(
      c.config.content || (await fetchData(c.config.url, {
        text: true,
        allowedPrivateHosts: privateHosts(c.config.url),
        maxBytes: 32 * 1024 * 1024,
      })),
      c.config.url || 'https://playlist.invalid/',
    );
  }
  async function playlist(c, force = false) {
    return catalogCached(c, 'playlist', () => readPlaylist(c), force);
  }
  const xtreamActions = { movie: 'get_vod_streams', series: 'get_series', live: 'get_live_streams' };
  async function xtreamCatalog(c, kind, force = false) {
    const action = xtreamActions[kind];
    const selected = c.config.loadedCategories;
    if (!Array.isArray(selected)) return array(await catalogCached(c, action, () => xtream(c, action), force));
    const ids = selected.filter(id => id.startsWith(`${kind}:`));
    // Limit simultaneous requests for providers with large category lists.
    const result = [];
    for (let i = 0; i < ids.length; i += 4) {
      const batches = await Promise.all(ids.slice(i, i + 4).map(id =>
        catalogCached(c, `${action}:${id}`, () => xtream(c, action, { category_id: id.split(':')[1] }), force)));
      result.push(...batches.flatMap(array));
    }
    return [...new Map(result.filter(x => selected.includes(`${kind}:${x?.category_id ?? ''}`))
      .map(x => [String(x.series_id ?? x.stream_id), x])).values()];
  }
  async function iptvCategories(c, kinds, force = false, draft = false) {
    const read = (resource, get) => draft ? get() : catalogCached(c, resource, get, force);
    if (c.type === 'm3u') return [...new Set((await (draft ? readPlaylist(c) : playlist(c, force))).map(x => x.category || '__ungrouped__'))]
      .map(id => ({ id, name: id === '__ungrouped__' ? 'Uncategorized' : id, kind: 'live' }));
    return (await Promise.all(kinds.map(async kind => {
      const raw = await read(`categories:${kind}`, () => xtream(c,
        { movie: 'get_vod_categories', series: 'get_series_categories', live: 'get_live_categories' }[kind]));
      return array(raw).filter(x => x?.category_id != null).map(x => ({
        id: `${kind}:${x.category_id}`, name: cleanText(x.category_name), kind,
      }));
    }))).flat();
  }
  const plexHeaders = (c, token) => ({
    Accept: "application/json",
    "X-Plex-Product": "TesPlay",
    "X-Plex-Version": "0.1.0",
    "X-Plex-Client-Identifier":
      c?.config?.clientIdentifier || `aperture-${c?.id || "pairing"}`,
    ...(token ? { "X-Plex-Token": token } : {}),
  });
  function plexToken(req, c) {
    const profile = c.config.profileTokens?.[ctx.getProfileId(req)];
    if (profile?.token) return profile.token;
    if (
      c.config.ownerProfileId &&
      c.config.ownerProfileId !== ctx.getProfileId(req) && !c.shared
    )
      throw providerError(
        "Choose a Plex Home profile for this TesPlay profile first.",
      );
    if (!c.config.token) throw providerError("Sign in to Plex first.");
    return c.config.token;
  }
  async function plexRequest(c, pathname, token, options = {}) {
    const url = pathname.startsWith("https://plex.tv/")
      ? new URL(pathname)
      : new URL(pathname, c.config.url);
    const body = await fetchData(url, {
      text: true,
      headers: plexHeaders(c, token),
      allowedPrivateHosts: privateHosts(url),
      ...options,
    });
    if (!body) return {};
    try {
      return JSON.parse(body);
    } catch {
      try {
        return xml.parse(body);
      } catch {
        throw providerError("Plex returned an invalid response.", 502);
      }
    }
  }
  async function plexResources(c, token) {
    const data = await plexRequest(
      c,
      "https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1",
      token,
    );
    return array(data)
      .filter((s) => String(s.provides).split(",").includes("server"))
      .map((s) => ({
        ...s,
        connections: array(s.connections)
          .filter((x) => {
            try {
              validateRemoteUrl(x.uri);
              return true;
            } catch {
              return false;
            }
          })
          .sort(
            (a, b) =>
              Number(b.local) - Number(a.local) ||
              Number(a.relay) - Number(b.relay) ||
              Number(b.protocol === "https") - Number(a.protocol === "https"),
          ),
      }));
  }
  const publicServers = (servers) =>
    servers.flatMap((s) =>
      s.connections.map((x) => ({
        id: s.clientIdentifier,
        name: s.name,
        url: x.uri,
        local: !!x.local,
      })),
    );
  const googleAuth = createGoogleAuth({ fetchData, saveConfig, getConnection: (req, id) => ctx.getConnection(req, id) });
  const googleToken = googleAuth.token;
  const driveToken = googleToken;
  async function youtubeRequest(req, c, pathname, params) {
    const u = new URL(`https://www.googleapis.com/youtube/v3/${pathname}`);
    const oauth =
      c.config.authMode === "oauth" ||
      (c.config.authMode !== "apiKey" &&
        !!(c.config.refreshToken || c.config.accessToken));
    if (!oauth && !c.config.apiKey)
      throw providerError(
        "Connect YouTube with Google or save an API key in settings.",
      );
    u.search = new URLSearchParams({
      ...params,
      ...(!oauth ? { key: c.config.apiKey } : {}),
    });
    return fetchData(
      u,
      oauth
        ? {
            headers: { Authorization: `Bearer ${await googleToken(req, c)}` },
          }
        : {},
    );
  }
  async function ensureXtream(req,c,kind,id) {
    if(!c.access && !Array.isArray(c.config.loadedCategories)) { const value={type:kind};ensure(req,c,value);return value; }
    const items=await xtreamCatalog(c,kind);
    const x=array(items).find(x=>String(x.series_id??x.stream_id)===String(id));
    if(!x) throw providerError('This title is not available.',404);
    const value={type:kind,category:`${kind}:${x.category_id??''}`};ensure(req,c,value);return value;
  }
  const plexAccess = x => ({type:['show','season','episode'].includes(x.type)?'series':['track','album','artist'].includes(x.type)?'audio':'movie',sectionId:String(x.librarySectionID||'')});
  async function xtreamEpisodes(req, c, seriesId, force = false) {
    const access=await ensureXtream(req,c,"series",seriesId);
    const data = await catalogCached(
      c, `series:${numeric(seriesId)}`,
      () => xtream(c, "get_series_info", { series_id: numeric(seriesId) }), force,
    );
    return parseXtreamEpisodes({ ...data, series_id: seriesId }, c.id).map(
      (item) => ({
        ...item,
        source: c.name,
        providerType: c.type, contentKind:"series", accessCategory:access?.category,
        poster: art(req, c, item.poster),
      }),
    );
  }
  function plexItem(req, c, x, token, root = false) {
    const poster = x.type === "episode" ? x.grandparentThumb || x.parentThumb || x.thumb : x.thumb;
    const folder =
      root ||
      ["show", "season", "artist", "album"].includes(x.type) ||
      (x.childCount != null && !x.Media);
    const key = root
      ? `/library/sections/${numeric(x.key)}/all`
      : folder
        ? `/library/metadata/${numeric(x.ratingKey)}/children`
        : numeric(x.ratingKey);
    return itemBase(c, {
      id: folder ? opaque(key) : key,
      title: cleanText(x.title),
      contentKind: root ? ({show:"series",movie:"movie",artist:"audio"}[x.type]||"movie") : plexAccess(x).type,
      sectionId: String(root ? x.key : x.librarySectionID || ""),
      artwork: root || ["artist","album","track"].includes(x.type) ? "logo" : "poster",
      resumeSeconds: Math.max(0, Number(x.viewOffset || 0) / 1000),
      watched: ["show","season"].includes(x.type) ? Number(x.leafCount)>0 && Number(x.viewedLeafCount)>=Number(x.leafCount) : Number(x.viewCount||0)>0,
      type: root ? "folder" : x.type === "show" ? "series" : folder
        ? "folder"
        : x.type === "track"
          ? "audio"
          : x.type === "episode"
            ? "episode"
            : "movie",
      poster: art(
        req,
        c,
        poster ? new URL(poster, c.config.url).toString() : null,
        plexHeaders(c, token),
      ),
      backdrop: art(
        req,
        c,
        x.art ? new URL(x.art, c.config.url).toString() : null,
        plexHeaders(c, token),
      ),
      description: cleanText(x.summary),
      year: String(x.year || ""),
      duration: Number(x.duration) / 1000 || undefined,
      addedAt: mediaDate(x.addedAt),
      subtitle: cleanText(x.grandparentTitle),
      ...(x.type === "season" ? {seriesId:String(x.parentRatingKey || '')} : {}),
      ...(x.type === "episode"
        ? {
            seriesId: x.grandparentRatingKey
              ? String(x.grandparentRatingKey)
              : undefined,
            seasonNumber: episodeNumber(x.parentIndex, 0),
            episodeNumber: episodeNumber(x.index, 0),
          }
        : {}),
    });
  }
  async function plexSeriesEpisodes(req, c, seriesId, token, sectionId = '') {
    const items = new Map();
    const size = 200;
    // Traverse server pagination, independently of the currently visible catalog page.
    for (let page = 0; page < 100; page++) {
      const container =
        (
          await plexRequest(
            c,
            `/library/metadata/${numeric(seriesId)}/allLeaves?X-Plex-Container-Start=${page * size}&X-Plex-Container-Size=${size}`,
            token,
          )
        ).MediaContainer || {};
      const entries = array(container.Metadata || container.Video);
      const before = items.size;
      for (const entry of entries) {
        if (entry.type !== "episode") continue;
        const item = plexItem(
          req,
          c,
          { ...entry, grandparentRatingKey: seriesId, librarySectionID:entry.librarySectionID || container.librarySectionID || sectionId },
          token,
        );
        items.set(item.id, item);
      }
      const total = Number(container.totalSize);
      if (
        Number.isFinite(total)
          ? page * size + entries.length >= total
          : entries.length < size
      )
        return [...items.values()].sort(episodeOrder);
      if (!entries.length || items.size === before)
        throw providerError(
          "Plex did not return the remaining episodes. Try again later.",
          502,
        );
    }
    throw providerError(
      "This Plex series is too large to determine the next episode safely.",
      502,
    );
  }
  async function driveFile(c, id, token) {
    if (!idPattern.test(id)) throw providerError("Invalid Drive identifier.");
    const u = new URL(`https://www.googleapis.com/drive/v3/files/${id}`);
    u.search = new URLSearchParams({
      fields:
        "id,name,mimeType,parents,thumbnailLink,capabilities(canDownload)",
      supportsAllDrives: "true",
    });
    return fetchData(u, { headers: { Authorization: `Bearer ${token}` } });
  }
  async function checkDriveRoot(c, id, token) {
    if (!c.config.folderId || id === c.config.folderId) return;
    let ancestors = [id];
    const seen = new Set();
    for (let depth = 0; ancestors.length && depth < 40; depth++) {
      const next = [];
      for (const candidate of ancestors.slice(0, 10)) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const f = await driveFile(c, candidate, token);
        if (array(f.parents).includes(c.config.folderId)) return;
        next.push(...array(f.parents));
      }
      ancestors = next;
    }
    throw providerError(
      "This Drive item is outside the configured folder.",
      403,
    );
  }

  registerPlexLibrary(app,{ctx,connection,request:plexRequest,token:plexToken,item:plexItem,route,art});
  registerYouTubeBrowser(app, { connection, request: youtubeRequest, route, art, cached, cacheKey,
    library: (req) => ctx.libraryState ? ctx.libraryState(req) : { progress: [] },
    stars: (req) => ctx.stars ? ctx.stars(req) : [],
  });
  if (!ctx.media) {
    app.get(["/api/media/:token", "/api/v1/media/:token"], media.handler);
    app.post('/api/media/:token/heartbeat', media.heartbeatHandler);
    app.delete(["/api/media/:token", "/api/v1/media/:token"], media.releaseHandler);
  }
  async function youtubePlayback(req, videoId, c = null) {
    const controller = new AbortController();
    req.res.once("close", () => { if (!req.res.writableEnded) controller.abort(); });
    const resolved = await resolveYouTube(videoId, controller.signal);
    const register = (resource) => media.register(req, c, {
      url: resource.url, headers: resource.headers, kind: resource.hls ? "hls" : "video",
    });
    return {
      url: register(resolved.video),
      ...(resolved.audio ? { audioUrl: register(resolved.audio) } : {}),
      type: resolved.video.hls ? "hls" : "video",
      isLive: resolved.isLive,
      streamKind: resolved.audio ? "dual-input" : "direct-file",
      provider: "youtube",
    };
  }
  const youtubeLimit = rateLimit({ windowMs: 60000, limit: 10, keyGenerator: (req) => req.user.id, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many YouTube requests. Try again in a minute." } });
  app.get("/api/youtube/resolve/:videoId", youtubeLimit, route(async (req, res) => {
    res.json(await youtubePlayback(req, req.params.videoId));
  }));

  app.post(
    "/api/connections/:id/test",
    route(async (req, res) => {
      const c = connection(req, req.params.id);
      if (c.type === "xtream") {
        const data = await xtream(c);
        if (!data.user_info)
          throw providerError(
            "This does not appear to be an Xtream Codes endpoint.",
          );
      } else if (c.type === "channels") {
        const refused = () => providerError("Channels DVR refused this address. Use the server's local network address, for example http://192.168.1.20:8089.", 400);
        let status;
        try {
          status = await channelsRequest(c, '/status');
        } catch (error) {
          // 401/403 (remote-access proxies) and HTML pages mean the address is not the DVR's own API.
          if (error?.status === 400 || /invalid response/i.test(String(error?.message))) throw refused();
          throw providerError('Channels DVR could not be reached or returned an invalid status response.', 502);
        }
        if (typeof status === 'string' && /^\s*</.test(status)) throw refused();
        if (!status || typeof status !== 'object' || Array.isArray(status))
          throw providerError('Channels DVR could not be reached or returned an invalid status response.', 502);
      } else if (c.type === "m3u") {
        if (!(await playlist(c)).length)
          throw providerError(
            "The playlist contains no supported HTTP streams.",
          );
      } else if (c.type === "plex")
        await plexRequest(c, "/library/sections", plexToken(req, c));
      else if (c.type === "drive")
        await driveFile(
          c,
          c.config.folderId || "root",
          await driveToken(req, c),
        );
      else if (c.type === "local") {
        const dir = await containedPath(c.config.rootPath);
        if (!(await stat(dir)).isDirectory())
          throw providerError("Choose a folder, not a file.");
      } else if (c.type === "youtube") {
        await youtubeRequest(req, c, "videos", {
          part: "id",
          chart: "mostPopular",
          maxResults: "1",
        });
      } else throw providerError("Unsupported connection type.");
      res.json({ ok: true, message: `${c.name} is connected.` });
    }),
  );

  app.post('/api/connections/categories/preview', route(async (req, res) => {
    const c = validateConnection(req.body);
    if (!['xtream', 'm3u'].includes(c.type)) throw providerError('Choose an IPTV connection.', 400);
    const config = c.config;
    if (c.type === 'xtream' && ['url', 'username', 'password'].some(key => typeof config[key] !== 'string' || !config[key].trim()))
      throw providerError('Enter the provider URL, username and password first.', 400);
    if (c.type === 'm3u' && ![config.url, config.content].some(value => typeof value === 'string' && value.trim()))
      throw providerError('Enter a playlist URL or paste a playlist first.', 400);
    // Unsaved credentials and playlist data stay in this request, outside catalog persistence.
    try {
      res.json({ categories: await iptvCategories(c, ['live', 'movie', 'series'], false, true) });
    } catch (error) {
      // Cloudflare replaces gateway responses with HTML, hiding the provider's
      // explanation. A failed draft is a setup error, not a TesPlay outage.
      if ([502, 503, 504].includes(error.status))
        throw Object.assign(providerError(`Could not load IPTV categories. ${error.message}`, 422), { code: 'IPTV_PROVIDER_UNAVAILABLE' });
      throw error;
    }
  }));

  app.get(
    '/api/connections/:id/categories',
    route(async (req, res) => {
      const c = connection(req, req.params.id);
      if (!['xtream', 'm3u'].includes(c.type)) throw providerError('Choose an IPTV connection.', 400);
      res.json({ categories: await iptvCategories(c, ['live', 'movie', 'series'], req.query.refresh === '1'),
        loadedCategories: c.config.loadedCategories ?? null });
    }),
  );

  app.get(
    "/api/catalog",
    route(async (req, res) => {
      const c = connection(req, req.query.connectionId);
      const p = pageData(req.query);
      const kind = String(req.query.kind || "all");
      const parent = String(req.query.parentId || "");
      const force = req.query.refresh === "1";
      if (c.type === 'channels') {
        const items = await channelsCatalog(req, c, parent, force);
        return res.json({ ...paginate(items, req.query),
          categories:[...new Set(items.map(x => x.category).filter(Boolean))].map(name => ({id:name,name})) });
      }
      if (c.type === "xtream") {
        if (parent) {
          const items = await xtreamEpisodes(req, c, parent, force);
          return res.json({
            ...paginate(items, req.query),
            categories: [...new Set(items.map((item) => item.category))].map(
              (name) => ({ id: name, name }),
            ),
          });
        }
        const kinds = kind === "all" ? ["movie", "series", "live"].filter(k=>!c.access || c.access.kinds.includes(k)) : [kind];
        if(kind!=="all" && c.access && !c.access.kinds.includes(kind)) throw providerError("This content type is not shared with your account.",403);
        if (kinds.some((k) => !["movie", "series", "live"].includes(k)))
          throw providerError("Unsupported IPTV catalog.");
        const batches = await Promise.all(
          kinds.map(async (k) => {
            const raw = await xtreamCatalog(c, k, force);
            return array(raw)
              .filter((x) => x && (x.stream_id != null || x.series_id != null) && permitted(req,c,{type:k,category:`${k}:${x.category_id??""}`}))
              .map((x) =>
                itemBase(c, {
                  id: String(x.series_id || x.stream_id),
                  title: cleanText(x.name),
                  addedAt: mediaDate(x.added || x.last_modified),
                  type: k,
                  poster: x.stream_icon || x.cover,
                  description: cleanText(x.plot),
                  year: String(x.year || x.releaseDate?.slice(0, 4) || ""),
                  category: `${k}:${String(x.category_id ?? "")}`,
                }),
              );
          }),
        );
        const category =
          p.category && !p.category.includes(":") && kinds.length === 1
            ? `${kinds[0]}:${p.category}`
            : p.category;
        const catalogItems = batches.flat().filter(item => !category || item.category === category);
        // Home previews should show the most recent titles whose provider supplied
        // valid artwork. Keep the complete catalog and an empty-artwork fallback.
        const withArtwork = req.query.artwork === 'prefer' && kinds.every(k => k !== 'live')
          ? catalogItems.filter(item => {
              if (!item.poster) return false;
              try { validateRemoteUrl(item.poster); return true; } catch { return false; }
            }) : [];
        const paged = paginate(withArtwork.length ? withArtwork : catalogItems, { ...req.query, category });
        paged.items = paged.items.map((item) => ({
          ...item,
          poster: art(req, c, item.poster),
        }));
        const categories = (
          await Promise.all(
            kinds.map(async (k) => {
              const raw = await catalogCached(c, `categories:${k}`, () =>
                xtream(
                  c,
                  {
                    movie: "get_vod_categories",
                    series: "get_series_categories",
                    live: "get_live_categories",
                  }[k],
                ), force,
              ).catch(() => []);
              return array(raw)
                .filter((x) => x?.category_id != null)
                .map((x) => ({
                  id: `${k}:${String(x.category_id)}`,
                  label: cleanText(x.category_name),
                  name: `${kinds.length > 1 ? { movie: "Movies · ", series: "Series · ", live: "Live TV · " }[k] : ""}${cleanText(x.category_name)}`,
                }));
            }),
          )
        ).flat();
        const categoryLabels = new Map(
          categories.map((entry) => [entry.id, entry.label]),
        );
        paged.items = paged.items.map((item) => ({
          ...item,
          categoryLabel:
            categoryLabels.get(item.category) ||
            { movie: "Movies", series: "Series", live: "Live TV" }[item.type],
        }));
        return res.json({
          ...paged,
          categories: [
            ...new Map(
              categories.filter(x=>(!Array.isArray(c.config.loadedCategories) || c.config.loadedCategories.includes(x.id)) && (!c.access?.categories || c.access.categories.includes(x.id))).map(({ id, name }) => [id, { id, name }]),
            ).values(),
          ],
        });
      }
      if (c.type === "m3u") {
        const entries = (await playlist(c, force)).filter(x=>permitted(req,c,{type:"live",category:x.category || '__ungrouped__'}));
        const paged = paginate(
          entries.map((x) =>
            itemBase(c, {
              id: x.id,
              title: x.title,
              category: x.category || '__ungrouped__',
              type: "live",
              poster: x.logo,
            }),
          ),
          req.query,
        );
        paged.items = paged.items.map((x) => ({
          ...x,
          poster: art(req, c, x.poster),
        }));
        return res.json({
          ...paged,
          categories: [
            ...new Set(entries.map((x) => x.category || '__ungrouped__')),
          ].map((x) => ({ id: x, name: x === '__ungrouped__' ? 'Uncategorized' : x })),
        });
      }
      if (c.type === "plex") {
        const token = plexToken(req, c);
        let pathname;
        if (!parent) pathname = "/library/sections";
        else {
          const decoded = decode(parent);
          if (
            !/^\/library\/(?:sections\/\d+\/all|metadata\/\d+\/children)$/.test(
              decoded,
            )
          )
            throw providerError("Invalid Plex folder.");
          pathname = decoded;
        }
        let sectionId='', contentKind='movie';
        sectionId=/^\/library\/sections\/(\d+)/.exec(pathname)?.[1] || '';
        if(parent && c.access) {
          const section=/^\/library\/sections\/(\d+)/.exec(pathname);
          if(section) {
            sectionId=section[1];
            const roots=(await plexRequest(c,'/library/sections',token)).MediaContainer||{};
            const root=array(roots.Directory).find(x=>String(x.key)===sectionId);
            if(!root) throw providerError('Plex library not found.',404);
            contentKind=plexAccess(root).type;
          } else {
            const id=/^\/library\/metadata\/(\d+)/.exec(pathname)?.[1];
            const metadata=(await plexRequest(c,`/library/metadata/${id}`,token)).MediaContainer||{};
            const current=array(metadata.Metadata||metadata.Directory)[0];
            if(!current) throw providerError('Plex folder not found.',404);
            ({sectionId,type:contentKind}=plexAccess(current));
          }
          ensure(req,c,{type:contentKind,sectionId});
        }
        const u = new URL(pathname, c.config.url);
        u.searchParams.set(
          "X-Plex-Container-Start",
          String((p.page - 1) * p.limit),
        );
        u.searchParams.set("X-Plex-Container-Size", String(p.limit));
        if (p.q && parent) u.searchParams.set("title", p.q);
        if(kind==="episode" && parent && /^\/library\/sections\//.test(pathname)) u.searchParams.set("type","4");
        if(req.query.sort === "recent" && parent && /^\/library\/sections\//.test(pathname)) {
          u.searchParams.set("sort","addedAt:desc");
          if(kind === "episode")u.searchParams.set("type","4");
        }
        const container =
          (await plexRequest(c, u.pathname + u.search, token)).MediaContainer ||
          {};
        const entries = [
          ...array(container.Directory),
          ...array(container.Metadata),
          ...array(container.Video),
          ...array(container.Track),
        ];
        const items = entries
          .filter(x=>parent || permitted(req,c,{...plexAccess(x),sectionId:String(x.key)}))
          .map((x) => plexItem(req, c, {...x,librarySectionID:x.librarySectionID||sectionId}, token, !parent))
          .filter(
            (x) =>
              !p.q ||
              parent ||
              x.title.toLowerCase().includes(p.q.toLowerCase()),
          );
        return res.json({
          items: items.slice(0, p.limit),
          hasMore: Number(container.totalSize || 0) > p.page * p.limit,
        });
      }
      if (c.type === "local") {
        if(req.query.recursive==='1' && p.q) {
          const matches=[];const pending=[''];let scanned=0;
          while(pending.length) {
            if(req.res.destroyed)return;
            const relative=pending.shift();const dir=await containedPath(c.config.rootPath,relative);
            for(const entry of await readdir(dir,{withFileTypes:true})) {
              if(entry.name.startsWith('.') || entry.isSymbolicLink())continue;
              if(++scanned>100000)throw providerError('This library is too large to search at once. Search within a folder.',422);
              const name=path.join(relative,entry.name);
              if(entry.isDirectory()){pending.push(name);continue;}
              const mime=mediaTypes[path.extname(entry.name).toLowerCase()];
              if(!entry.isFile() || !mime || /\.(srt|vtt)$/i.test(entry.name) || !entry.name.toLowerCase().includes(p.q.toLowerCase()))continue;
              const item=itemBase(c,{id:opaque(name),title:entry.name,type:mime.startsWith('audio')?'audio':'video'});
              if(permitted(req,c,item))matches.push(item);
            }
          }
          return res.json(paginate(matches,req.query));
        }
        const relative = parent ? decode(parent) : "";
        const dir = await containedPath(c.config.rootPath, relative);
        const entries = await readdir(dir, { withFileTypes: true });
        const items = entries
          .filter(
            (x) =>
              !x.name.startsWith(".") &&
              (x.isDirectory() ||
                (x.isFile() &&
                  mediaTypes[path.extname(x.name).toLowerCase()] &&
                  !/\.(srt|vtt)$/i.test(x.name))),
          )
          .map((x) =>
            itemBase(c, {
              id: opaque(path.join(relative, x.name)),
              title: x.name,
              addedAt: x.createdTime,
              type: x.isDirectory()
                ? "folder"
                : mediaTypes[path.extname(x.name).toLowerCase()].startsWith(
                      "audio",
                    )
                  ? "audio"
                  : "video",
            }),
          )
          .sort(
            (a, b) =>
              Number(b.type === "folder") - Number(a.type === "folder") ||
              a.title.localeCompare(b.title),
          );
        if(req.query.sort === "recent") await Promise.all(items.filter(i=>i.type!=="folder").map(async item=>{item.addedAt=(await stat(await containedPath(c.config.rootPath,decode(item.id)))).mtime.toISOString();}));
        return res.json(paginate(items.filter(i=>permitted(req,c,i)), req.query));
      }
      if (c.type === "drive") {
        const token = await driveToken(req, c);
        const folder = parent || c.config.folderId || "root";
        if (!idPattern.test(folder))
          throw providerError("Invalid Drive folder.");
        await checkDriveRoot(c, folder, token);
        const query = [
          ...(req.query.recursive==='1'&&p.q?[]:[`'${folder}' in parents`]),
          "trashed = false",
          "(mimeType contains 'video/' or mimeType contains 'audio/' or mimeType = 'application/vnd.google-apps.folder')",
        ];
        if (p.q)
          query.push(
            `name contains '${p.q.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`,
          );
        const u = new URL("https://www.googleapis.com/drive/v3/files");
        u.search = new URLSearchParams({
          q: query.join(" and "),
          pageSize: String(p.limit),
          fields:
            "nextPageToken,files(id,name,mimeType,thumbnailLink,videoMediaMetadata,createdTime)",
          orderBy: req.query.sort === "recent" ? "createdTime desc" : "folder,name",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          ...(req.query.pageToken
            ? { pageToken: String(req.query.pageToken) }
            : {}),
        });
        const data = await fetchData(u, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if(req.query.recursive==='1'&&p.q&&c.config.folderId) {
          const permittedFiles=await Promise.all(array(data.files).map(async file=>{try{await checkDriveRoot(c,file.id,token);return file;}catch(error){if(error.status===403)return null;throw error;}}));
          data.files=permittedFiles.filter(Boolean);
        }
        return res.json({
          items: array(data.files).filter(x=>permitted(req,c,{type:x.mimeType==="application/vnd.google-apps.folder"?"folder":x.mimeType.startsWith("audio/")?"audio":"video"})).map((x) =>
            itemBase(c, {
              id: x.id,
              title: x.name,
              addedAt: x.createdTime,
              type:
                x.mimeType === "application/vnd.google-apps.folder"
                  ? "folder"
                  : x.mimeType.startsWith("audio/")
                    ? "audio"
                    : "video",
              poster: x.thumbnailLink
                ? `/api/drive/artwork/${c.id}/${x.id}`
                : undefined,
              duration:
                Number(x.videoMediaMetadata?.durationMillis) / 1000 ||
                undefined,
            }),
          ),
          hasMore: !!data.nextPageToken,
          nextPageToken: data.nextPageToken,
        });
      }
      if (c.type === "youtube") {
        const data = await youtubeRequest(req, c, "search", {
          part: "snippet",
          type: "video",
          videoEmbeddable: "true",
          maxResults: String(Math.min(p.limit, 50)),
          q: p.q || "travel film 4k",
          ...(req.query.pageToken
            ? { pageToken: String(req.query.pageToken) }
            : {}),
        });
        return res.json({
          items: array(data.items).map((x) =>
            itemBase(c, {
              id: x.id.videoId,
              title: cleanText(x.snippet.title),
              type: "video",
              poster: art(req, c, x.snippet.thumbnails?.high?.url),
              description: cleanText(x.snippet.description),
              subtitle: x.snippet.channelTitle,
            }),
          ),
          hasMore: !!data.nextPageToken,
          nextPageToken: data.nextPageToken,
        });
      }
      throw providerError("Unsupported library.");
    }),
  );

  async function seriesEpisodes(req, c, id, kind) {
    if (c.type === 'channels') {
      ensure(req, c, {type:'series'});
      if (kind === 'series' && id.startsWith('show:')) return channelsEpisodes(req, c, id.slice(5));
      if (!id.startsWith('file:')) throw providerError('Choose a Channels DVR episode.');
      const file = await channelsFile(c, id.slice(5));
      return channelsEpisodes(req, c, String(file.show_id));
    }
    if (c.type === "xtream") {
      const seriesId = kind === 'series' ? numeric(id) : /^(\d+):\d+:[a-zA-Z0-9]{1,8}$/.exec(id)?.[1];
      if (!seriesId) throw providerError("Invalid series or episode.");
      return xtreamEpisodes(req, c, seriesId);
    }
    if (c.type !== "plex") return [];
    const token = plexToken(req, c);
    let metadataId = id;
    if (kind === 'series' || kind === 'folder') {
      const path = decode(id);
      metadataId = /^\/library\/metadata\/(\d+)\/children$/.exec(path)?.[1];
      if (!metadataId) throw providerError("Choose a Plex series.");
    }
    const data = (await plexRequest(c, `/library/metadata/${numeric(metadataId)}`, token)).MediaContainer || {};
    const current = array(data.Metadata || data.Video || data.Directory)[0];
    if (!current) throw providerError("This series is unavailable.", 404);
    ensure(req, c, plexAccess(current));
    let seriesId = current.type === 'show' ? current.ratingKey : current.type === 'season' ? current.parentRatingKey : current.grandparentRatingKey;
    if (!seriesId && current.type === 'episode' && current.parentRatingKey) {
      const season = (await plexRequest(c, `/library/metadata/${numeric(current.parentRatingKey)}`, token)).MediaContainer || {};
      seriesId = array(season.Metadata || season.Directory)[0]?.parentRatingKey;
    }
    if (!seriesId) throw providerError("Plex did not identify this episode's series.", 502);
    return (await plexSeriesEpisodes(req, c, seriesId, token, current.librarySectionID)).filter(item => permitted(req,c,item));
  }
  app.get(['/api/episodes', '/api/episodes/next'], route(async (req, res) => {
    const c = connection(req, req.query.connectionId), id = String(req.query.itemId || '');
    const items = await seriesEpisodes(req, c, id, String(req.query.kind || 'episode'));
    const index = items.findIndex(item => item.id === id || c.type === 'xtream' && item.id.split(':').slice(0,2).join(':') === id.split(':').slice(0,2).join(':'));
    if (req.path.endsWith('/next')) {
      if (items.length && index < 0) throw providerError("Episode is no longer available in this series.", 404);
      return res.json({item: items[index + 1] || null});
    }
    res.json({items, next: index >= 0 ? items[index + 1] || null : null, previous: index > 0 ? items[index - 1] : null});
  }));

  const plexAudio = part => array(part?.Stream).filter(x => Number(x.streamType) === 2 && /^\d{1,20}$/.test(String(x.id))).map(x => ({
    id: `plex-audio-${numeric(x.id)}`, label: cleanText(x.displayTitle || x.language || x.codec || 'Audio'), language: x.languageCode, codec: x.codec || 'aac', selected: Number(x.selected) === 1,
  }));
  const plexSubtitles = part => array(part?.Stream).filter(x => Number(x.streamType) === 3 && /^\/library\/streams\//.test(x.key || '') && ['srt','webvtt','vtt'].includes(x.codec));
  const plexQualities = [{id:'auto',label:'Auto / original'}, {id:'1080p',label:'1080p · 8 Mbps'}, {id:'720p',label:'720p · 4 Mbps'}, {id:'480p',label:'480p · 2 Mbps'}];
  app.get('/api/playback/options', route(async (req,res) => {
    const c = connection(req, req.query.connectionId), id = String(req.query.itemId || '');
    if (c.type !== 'plex') {
      if (c.type === 'xtream') await ensureXtream(req,c,req.query.kind === 'episode' ? 'series' : String(req.query.kind), req.query.kind === 'episode' ? id.split(':')[0] : id);
      return res.json({audio:[],subtitles:[],qualities:[]});
    }
    const data = (await plexRequest(c, `/library/metadata/${numeric(id)}`, plexToken(req,c))).MediaContainer || {};
    const meta = array(data.Metadata || data.Video || data.Track)[0];
    if (!meta) throw providerError('This Plex title is unavailable.',404);
    ensure(req,c,plexAccess(meta));
    const part = array(array(meta.Media)[0]?.Part)[0];
    res.json({item:plexItem(req,c,meta,plexToken(req,c)),audio:plexAudio(part),subtitles:plexSubtitles(part).map(x => ({id:`plex-subtitle-${numeric(x.id)}`,label:cleanText(x.displayTitle || x.language || 'Subtitles'),language:x.languageCode})),qualities:meta.type === 'track' ? [] : plexQualities});
  }));

  ctx.syncChannelsProgress = async (req, item, seconds, duration, state) => {
    if (!item.connectionId) return;
    const c = connection(req, item.connectionId);
    if (c.type !== 'channels' || item.id.startsWith('live:')) return;
    const match = /^(file|movie):(\d{1,10})$/.exec(item.id);
    if (!match) throw providerError('Invalid Channels DVR recording identifier.');
    ensure(req, c, {type:match[1] === 'movie' ? 'movie' : 'series'});
    await channelsFile(c, match[2], match[1] === 'movie');
    const base = `/dvr/files/${match[2]}`;
    await channelsRequest(c, `${base}/playback_time/${Math.floor(seconds)}`, {method:'PUT', text:true});
    if (state === 'stopped' && duration > 0 && seconds / duration >= .97)
      await channelsRequest(c, `${base}/watch`, {method:'PUT', text:true});
  };

  ctx.syncPlexProgress = async (req, item, seconds, duration, state) => {
    if (!item.connectionId) return;
    const c = connection(req, item.connectionId);
    if (c.type !== 'plex') return;
    const id = numeric(item.id), token = plexToken(req,c);
    const data = (await plexRequest(c, `/library/metadata/${id}`, token)).MediaContainer || {};
    const meta = array(data.Metadata || data.Video || data.Track)[0];
    if (!meta) throw providerError('This Plex title is unavailable.',404);
    ensure(req,c,plexAccess(meta));
    const actualDuration = Math.max(0, Number(meta.duration) || duration * 1000);
    const position = Math.min(actualDuration || seconds * 1000, Math.round(seconds * 1000));
    const params = new URLSearchParams({ratingKey:id,key:`/library/metadata/${id}`,state:['playing','paused','stopped'].includes(state)?state:'stopped',time:String(position),duration:String(actualDuration)});
    await plexRequest(c, `/:/timeline?${params}`, token, {method:'POST',headers:{...plexHeaders(c,token),'X-Plex-Session-Identifier':createHash('sha256').update(`${req.session.id}:${id}`).digest('hex')}});
    if (actualDuration > 0 && position / actualDuration >= .97 && state === 'stopped') await plexRequest(c, `/:/scrobble?${new URLSearchParams({key:id,identifier:'com.plexapp.plugins.library'})}`, token, {method:'PUT'});
  };

  app.get(
    "/api/playback",
    route(async (req, res) => {
      const c = connection(req, req.query.connectionId);
      const id = String(req.query.itemId || "");
      const kind = String(req.query.kind || "movie");
      if (c.type === 'channels') {
        let sessionPath, resumeSeconds;
        const live = /^live:(\d{1,5}(?:\.\d{1,3})?)$/.exec(id);
        const recording = /^(file|movie):(\d{1,10})$/.exec(id);
        if (live) {
          ensure(req, c, {type:'live'});
          sessionPath = `/devices/ANY/channels/${live[1]}/hls`;
        } else if (recording) {
          ensure(req, c, {type:recording[1] === 'movie' ? 'movie' : 'series'});
          const file = await channelsFile(c, recording[2], recording[1] === 'movie');
          resumeSeconds = Math.max(0, Number(file.playback_time) || 0);
          sessionPath = `/dvr/files/${recording[2]}/hls`;
        } else throw providerError('Invalid Channels DVR playback identifier.');
        return res.json({
          url:media.register(req, c, {
            kind:'hls', url:new URL(`${sessionPath}/master.m3u8`, validateRemoteUrl(c.config.url)).toString(),
            channelsSessionPath:sessionPath, allowedPrivateHosts:privateHosts(c.config.url),
          }),
          type:'hls', provider:'channels', isLive:!!live, streamKind:'direct-file',
          ...(recording ? {resumeSeconds} : {}),
        });
      }
      if (c.type === "xtream") {
        let category, extension, streamId;
        if (kind === "live") {
          await ensureXtream(req,c,"live",id);
          category = "live";
          streamId = numeric(id);
          extension = c.config.output === "ts" ? "ts" : "m3u8";
        } else if (kind === "episode") {
          const match = /^(\d+):(\d+):([a-zA-Z0-9]{1,8})$/.exec(id);
          if (!match) throw providerError("Invalid episode.");
          await ensureXtream(req,c,"series",match[1]);
          const data = await xtream(c, "get_series_info", {
            series_id: match[1],
          });
          const episode = Object.values(data.episodes || {})
            .flatMap(array)
            .find((x) => String(x.id) === match[2]);
          if (!episode) throw providerError("Episode not found.", 404);
          category = "series";
          streamId = match[2];
          extension = String(episode.container_extension || "mp4");
        } else if (kind === "movie") {
          await ensureXtream(req,c,"movie",id);
          const data = await xtream(c, "get_vod_info", { vod_id: numeric(id) });
          if (!data.movie_data) throw providerError("Movie not found.", 404);
          category = "movie";
          streamId = numeric(id);
          extension = String(data.movie_data.container_extension || "mp4");
        } else throw providerError("Select an episode before playing.");
        if (!/^[a-zA-Z0-9]{1,8}$/.test(extension))
          throw providerError("Invalid stream format.");
        const u = validateRemoteUrl(c.config.url);
        u.pathname =
          u.pathname.replace(/\/?(?:player_api\.php)?$/, "/") +
          `${category}/${encodeURIComponent(c.config.username)}/${encodeURIComponent(c.config.password)}/${streamId}.${extension}`;
        u.search = "";
        const type = extension === "m3u8" ? "hls" : "video";
        return res.json({
          url: media.register(req, c, {
            url: u.toString(),
            allowedPrivateHosts: privateHosts(c.config.url),
            kind: type,
          }),
          type,
          streamKind: extension === "ts" ? "continuous-ts" : "direct-file",
        });
      }
      if (c.type === "m3u") {
        const entry = (await playlist(c)).find((x) => x.id === id);
        if (!entry) throw providerError("Channel not found.", 404);
        ensure(req,c,{type:"live",category:entry.category || '__ungrouped__'});
        const type = /\.m3u8(?:\?|$)/i.test(entry.url) ? "hls" : "video";
        return res.json({
          url: media.register(req, c, {
            url: entry.url,
            allowedPrivateHosts: c.config.url ? privateHosts(c.config.url) : [],
          }),
          type,
          streamKind: /\.ts(?:\?|$)/i.test(entry.url) ? "continuous-ts" : "direct-file",
        });
      }
      if (c.type === "local") {
        const relative = decode(id);
        const file = await containedPath(c.config.rootPath, relative);
        const type = mediaTypes[path.extname(file).toLowerCase()];
        if (
          !type ||
          !(await stat(file)).isFile() ||
          type.startsWith("text/") ||
          type.includes("subrip")
        )
          throw providerError("Unsupported media file.");
        ensure(req,c,{type:type.startsWith("audio")?"audio":"video"});
        const subtitles = [];
        const entries = await readdir(path.dirname(file));
        const stem = path.basename(file, path.extname(file));
        for (const name of entries
          .filter(
            (x) =>
              x === `${stem}.vtt` ||
              (x.startsWith(`${stem}.`) && x.endsWith(".vtt")),
          )
          .slice(0, 10))
          subtitles.push({
            label: name,
            url: media.register(req, c, {
              root: c.config.rootPath,
              relative: path.join(path.dirname(relative), name),
            }),
            language: "en",
          });
        return res.json({
          url: media.register(req, c, { root: c.config.rootPath, relative }),
          type: type.startsWith("audio") ? "audio" : "video",
          subtitles,
        });
      }
      if (c.type === "drive") {
        const token = await driveToken(req, c);
        await checkDriveRoot(c, id, token);
        const file = await driveFile(c, id, token);
        if (
          !/^(video|audio)\//.test(file.mimeType) ||
          file.capabilities?.canDownload === false
        )
          throw providerError("This Drive file cannot be streamed.");
        ensure(req,c,{type:file.mimeType.startsWith("audio")?"audio":"video"});
        return res.json({
          url: media.register(req, c, {
            url: `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
            getHeaders: async (request, current) => ({
              Authorization: `Bearer ${await driveToken(request, current)}`,
            }),
          }),
          type: file.mimeType.startsWith("audio") ? "audio" : "video",
        });
      }
      if (c.type === "youtube") {
        if (!/^[a-zA-Z0-9_-]{11}$/.test(id))
          throw providerError("Invalid YouTube video.");
        ensure(req,c,{type:"video"});
        return res.json(await youtubePlayback(req, id, c));
      }
      if (c.type === "plex") {
        numeric(id);
        const token = plexToken(req, c);
        const container =
          (await plexRequest(c, `/library/metadata/${id}`, token))
            .MediaContainer || {};
        const meta = array(
          container.Metadata || container.Video || container.Track,
        )[0];
        if(meta) ensure(req,c,plexAccess(meta));
        const format = array(meta?.Media)[0];
        const part = array(format?.Part)[0];
        if (!part?.key)
          throw providerError("Plex returned no playable media.", 404);
        const audioTracks = plexAudio(part);
        const audioTrackId = req.query.audioTrackId ? String(req.query.audioTrackId) : undefined;
        if (audioTrackId && !audioTracks.some(x => x.id === audioTrackId)) throw providerError('This audio track is unavailable.');
        const qualityId = String(req.query.qualityId || 'auto');
        if (!plexQualities.some(x => x.id === qualityId)) throw providerError('This quality is unavailable.');
        // Plex owns the selected stream for transcoded output; pin the chosen
        // audio before asking it to create the HLS session.
        if (audioTrackId) await plexRequest(c, `/library/parts/${numeric(part.id)}?${new URLSearchParams({audioStreamID:audioTrackId.slice(11),allParts:'0'})}`, token, {method:'PUT'});
        const quality = {'1080p':['1920x1080',8000], '720p':['1280x720',4000], '480p':['854x480',2000]}[qualityId];
        const headers = plexHeaders(c, token);
        const compatible =
          ["mp4", "m4v", "mkv", "webm", "mp3", "aac", "m4a", "flac", "ogg"].includes(
            format.container,
          ) &&
          (!format.videoCodec ||
            ["h264", "vp8", "vp9", "av1"].includes(format.videoCodec)) &&
          (!format.audioCodec ||
            ["aac", "mp3", "opus", "vorbis", "flac"].includes(
              format.audioCodec,
            ));
        const transcode =
          req.query.transcode === "1" ||
          c.config.transcode === true ||
          !!audioTrackId || !!quality || !compatible;
        let url, type, plexSessionId;
        if (transcode) {
          plexSessionId = randomBytes(12).toString('hex');
          const u = new URL(
            "/video/:/transcode/universal/start.m3u8",
            c.config.url,
          );
          u.search = new URLSearchParams({
            path: `/library/metadata/${id}`,
            mediaIndex: "0",
            partIndex: "0",
            protocol: "hls",
            directPlay: "0",
            // Auto can remux an already compatible H.264 video. Explicit
            // compatibility reencodes both tracks rather than copying codecs.
            directStream: quality || req.query.transcode === "1" || c.config.transcode === true || format.videoCodec !== "h264" ? "0" : "1",
            videoCodec: "h264",
            audioCodec: "aac",
            maxVideoBitrate: String(
              Math.min(
                20000,
                Math.max(1000, quality?.[1] || Number(c.config.maxBitrate) || 8000),
              ),
            ),
            videoResolution: quality?.[0] || "1920x1080",
            subtitles: "none",
            session: plexSessionId,
            "X-Plex-Platform": "Chrome",
            "X-Plex-Product": "TesPlay",
            "X-Plex-Client-Identifier":
              c.config.clientIdentifier || `aperture-${c.id}`,
          });
          url = u.toString();
          type = "hls";
        } else {
          if (!/^\/library\/parts\//.test(part.key))
            throw providerError("Unexpected Plex media path.");
          url = new URL(part.key, c.config.url).toString();
          type = meta.type === "track" ? "audio" : "video";
        }
        const subtitles = array(part.Stream)
          .filter(
            (x) =>
              Number(x.streamType) === 3 &&
              /^\/library\/streams\//.test(x.key || "") &&
              ["srt", "webvtt", "vtt"].includes(x.codec),
          )
          .map((x) => ({
            ...(/^\d{1,20}$/.test(String(x.id)) ? {id:`plex-subtitle-${x.id}`} : {}),
            label: x.displayTitle || x.language || "Subtitles",
            language: x.languageCode || "en",
            url: media.register(req, c, {
              url: new URL(x.key, c.config.url).toString(),
              headers,
              allowedPrivateHosts: privateHosts(c.config.url),
              kind: "subtitle",
            }),
          }));
        return res.json({
          url: media.register(req, c, {
            url,
            plexSessionId,
            headers,
            allowedPrivateHosts: privateHosts(c.config.url),
            kind: type,
          }),
          type,
          subtitles,
          provider: "plex",
          resumeSeconds: Number(meta.viewOffset || 0) / 1000,
          audioTracks, selectedAudioTrackId: audioTrackId || audioTracks.find(x=>x.selected)?.id || audioTracks[0]?.id,
          ...(transcode
            ? {
                message:
                  "Plex is converting this title for browser playback. Server transcoding capability is required.",
              }
            : {}),
        });
      }
      throw providerError("Unsupported playback source.");
    }),
  );

  app.get(
    "/api/epg",
    route(async (req, res) => {
      const c = connection(req, req.query.connectionId, "xtream");
      await ensureXtream(req,c,"live",req.query.itemId);
      const data = await xtream(c, "get_short_epg", {
        stream_id: numeric(req.query.itemId),
        limit: "30",
      });
      const decodeText = (s) => {
        try {
          return cleanText(
            Buffer.from(String(s || ""), "base64").toString("utf8"),
          );
        } catch {
          return cleanText(s);
        }
      };
      res.json({
        programs: array(data.epg_listings).map((x) => ({
          title: decodeText(x.title),
          description: decodeText(x.description),
          start: x.start_timestamp
            ? new Date(Number(x.start_timestamp) * 1000).toISOString()
            : x.start,
          end: x.stop_timestamp
            ? new Date(Number(x.stop_timestamp) * 1000).toISOString()
            : x.end,
        })),
      });
    }),
  );

  app.post(
    "/api/plex/pin",
    route(async (req, res) => {
      for (const [id, pin] of pins)
        if (pin.expires < Date.now()) pins.delete(id);
      const clientIdentifier = randomBytes(16).toString("hex");
      const c = { config: { clientIdentifier } };
      const pin = await plexRequest(c, "https://plex.tv/api/v2/pins", null, {
        method: "POST",
        headers: {
          ...plexHeaders(c),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "strong=true",
      });
      pins.set(String(pin.id), {
        userId: req.user.id,
        sessionId: req.session.id,
        profileId: ctx.getProfileId(req),
        code: pin.code,
        clientIdentifier,
        expires: Date.now() + 10 * 60000,
      });
      const params = new URLSearchParams({
        clientID: clientIdentifier,
        code: pin.code,
        "context[device][product]": "TesPlay",
      });
      res.json({
        id: pin.id,
        code: pin.code,
        url: `https://app.plex.tv/auth#?${params}`,
      });
    }),
  );
  app.post(
    "/api/plex/pin/check",
    route(async (req, res) => {
      const id = String(req.body.id);
      const pending = pins.get(id);
      if (
        !pending ||
        pending.userId !== req.user.id ||
        pending.sessionId !== req.session.id ||
        pending.code !== req.body.code ||
        pending.expires < Date.now()
      )
        throw providerError("Plex sign-in expired. Start again.");
      const c = { config: { clientIdentifier: pending.clientIdentifier } };
      const pin = await plexRequest(
        c,
        `https://plex.tv/api/v2/pins/${numeric(id)}?code=${encodeURIComponent(pending.code)}`,
      );
      if (!pin.authToken) return res.json({ pending: true });
      const servers = await plexResources(c, pin.authToken);
      const selected = servers.find((s) => s.connections.length);
      const server = selected?.connections[0];
      const saved = ctx.saveConnection(req, {
        type: "plex",
        name: "Plex",
        config: {
          clientIdentifier: pending.clientIdentifier,
          userToken: pin.authToken,
          token: selected?.accessToken || pin.authToken,
          url: server?.uri || "",
          serverId: selected?.clientIdentifier || "",
          ownerProfileId: pending.profileId,
          profileTokens: {
            [pending.profileId]: {
              token: selected?.accessToken || pin.authToken,
              userToken: pin.authToken,
              name: "Owner",
            },
          },
        },
      });
      pins.delete(id);
      res.json({ connection: saved, servers: publicServers(servers) });
    }),
  );
  app.get(
    "/api/plex/:connectionId/servers",
    route(async (req, res) => {
      const c = connection(req, req.params.connectionId, "plex");
      res.json({
        servers: publicServers(
          await plexResources(
            c,
            c.config.profileTokens?.[ctx.getProfileId(req)]?.userToken ||
              c.config.userToken ||
              plexToken(req, c),
          ),
        ),
      });
    }),
  );
  app.post(
    "/api/plex/:connectionId/server",
    route(async (req, res) => {
      const c = connection(req, req.params.connectionId, "plex");
      const profileId = ctx.getProfileId(req);
      const userToken =
        c.config.profileTokens?.[profileId]?.userToken ||
        c.config.userToken ||
        plexToken(req, c);
      const servers = await plexResources(c, userToken);
      const server = servers.find((s) => s.clientIdentifier === req.body.id);
      const endpoint = server?.connections.find(
        (x) => !req.body.url || x.uri === req.body.url,
      );
      if (!server || !endpoint)
        throw providerError("Choose a server returned by Plex.");
      const profiles = {};
      for (const [key, value] of Object.entries(c.config.profileTokens || {})) {
        if (key === profileId)
          profiles[key] = { ...value, token: server.accessToken, userToken };
      }
      saveConfig(req, c, {
        url: endpoint.uri,
        serverId: server.clientIdentifier,
        token: server.accessToken,
        ownerProfileId: profileId,
        profileTokens: profiles,
      });
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/plex/:connectionId/profiles",
    route(async (req, res) => {
      const c = connection(req, req.params.connectionId, "plex");
      const token = c.config.userToken || c.config.token;
      const data = await plexRequest(
        c,
        "https://plex.tv/api/home/users",
        token,
      );
      const users = array(data.MediaContainer?.User || data.users || data.User);
      res.json({
        profiles: users.map((x) => ({
          id: String(x.id),
          name: x.title || x.username,
          thumb: art(req, c, x.thumb),
          protected:
            x.protected === true ||
            x.protected === 1 ||
            x.protected === "1" ||
            x.protected === "true",
        })),
      });
    }),
  );
  app.post(
    "/api/plex/:connectionId/profile",
    route(async (req, res) => {
      const c = connection(req, req.params.connectionId, "plex");
      const id = numeric(req.body.id);
      const pin = String(req.body.pin || "");
      if (pin && !/^\d{4}$/.test(pin))
        throw providerError("Enter the four-digit Plex PIN.");
      const switched = await plexRequest(
        c,
        `https://plex.tv/api/home/users/${id}/switch`,
        c.config.userToken || c.config.token,
        {
          method: "POST",
          headers: {
            ...plexHeaders(c, c.config.userToken || c.config.token),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(pin ? { pin } : {}).toString(),
        },
      );
      const user = switched.user || switched.User || switched;
      const userToken = user.authToken || user.authenticationToken;
      if (!userToken)
        throw providerError(
          "Plex did not authorize that profile. Check its PIN.",
        );
      const servers = await plexResources(c, userToken);
      const serverId =
        c.config.serverId ||
        (await plexRequest(c, "/identity", c.config.token)).MediaContainer
          ?.machineIdentifier;
      const server = servers.find((x) => x.clientIdentifier === serverId);
      if (!server?.accessToken)
        throw providerError(
          "This Plex profile does not have access to the selected server.",
          403,
        );
      saveConfig(req, c, {
        serverId,
        profileTokens: {
          ...(c.config.profileTokens || {}),
          [ctx.getProfileId(req)]: {
            token: server.accessToken,
            userToken,
            userId: id,
            name: user.title || user.username,
          },
        },
      });
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/drive/artwork/:connectionId/:itemId",
    route(async (req, res) => {
      const c = connection(req, req.params.connectionId, "drive");
      const token = await driveToken(req, c);
      const id = req.params.itemId;
      await checkDriveRoot(c, id, token);
      const file = await driveFile(c, id, token);
      ensure(req,c,{type:file.mimeType?.startsWith("audio/")?"audio":file.mimeType==="application/vnd.google-apps.folder"?"folder":"video"});
      if (!file.thumbnailLink)
        throw providerError("This Drive item has no thumbnail.", 404);
      const url = art(req, c, file.thumbnailLink);
      if (!url) throw providerError("Thumbnail is unavailable.", 404);
      res.redirect(url);
    }),
  );
  googleAuth.registerRoutes(app, { connection, route });

  app.get(
    "/api/radio",
    route(async (req, res) => {
      const q = String(req.query.q || "").slice(0, 100);
      const u = new URL(
        q
          ? "https://de1.api.radio-browser.info/json/stations/search"
          : "https://de1.api.radio-browser.info/json/stations/topvote/60",
      );
      if (q)
        u.search = new URLSearchParams({
          name: q,
          limit: "60",
          hidebroken: "true",
          order: "votes",
          reverse: "true",
        });
      const data = await cached(`radio:${q}`, () => fetchData(u), 300);
      const items = array(data)
        .slice(0, 60)
        .flatMap((x) => {
          try {
            validateRemoteUrl(x.url_resolved || x.url);
            return [
              {
                id: x.stationuuid,
                title: cleanText(x.name),
                type: "audio",
                source: "Radio",
                subtitle: [x.country, x.codec].filter(Boolean).join(" · "),
                poster: art(req, { config: {} }, x.favicon),
                playbackUrl: `/api/radio/stream/${x.stationuuid}`,
                category: x.tags,
              },
            ];
          } catch {
            return [];
          }
        });
      res.json({ items });
    }),
  );
  app.get(
    ["/api/radio/stream/:stationId", "/api/radio/playback/:stationId"],
    route(async (req, res) => {
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          req.params.stationId,
        )
      )
        throw providerError("Invalid radio station.");
      const data = await cached(
        `station:${req.params.stationId}`,
        () =>
          fetchData(
            `https://de1.api.radio-browser.info/json/stations/byuuid/${req.params.stationId}`,
          ),
        300,
      );
      const station = array(data)[0];
      if (!station)
        throw providerError("This radio station is no longer available.", 404);
      const url = validateRemoteUrl(station.url_resolved || station.url);
      const mediaUrl = media.register(req, null, { url: url.toString() });
      if (req.path.startsWith('/api/radio/playback/')) return res.json({ url: mediaUrl, type: 'audio', isLive: true });
      res.redirect(mediaUrl);
    }),
  );
}
