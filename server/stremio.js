import { createHash, randomUUID } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { remoteData, requestRemote, validateRemoteUrl, providerError } from './media.js';
import { plainText } from './text.js';

const CINEMETA = 'https://v3-cinemeta.strem.io/manifest.json';
const MAX_ADDONS = 32;
const text = (value, max = 300) => plainText(typeof value === 'string' ? value : '').slice(0, max);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\x00-\x1f]/.test(value);
const list = value => Array.isArray(value) ? value : [];

export function stremioManifestUrl(value) {
  if (typeof value !== 'string' || value.length > 8000) throw providerError('Paste a configured Stremio addon link.');
  const url = validateRemoteUrl(value.trim().replace(/^stremio:\/\//i, 'https://'));
  if (url.protocol !== 'https:') throw providerError('Stremio addon links must use HTTPS.');
  if (!url.pathname.endsWith('/manifest.json')) throw providerError('Use the addon install link ending in /manifest.json. Configure the addon first if it needs an account.');
  return url.toString();
}

export function stremioManifest(value) {
  if (!value || !validId(value.id) || !text(value.name) || !Array.isArray(value.resources) || !Array.isArray(value.types))
    throw providerError('This link did not return a valid Stremio addon.');
  const strings = values => list(values).filter(validId).slice(0, 32);
  const resources = value.resources.slice(0, 12).flatMap(resource => {
    if (typeof resource === 'string') return ['catalog', 'meta', 'stream', 'subtitles'].includes(resource) ? [resource] : [];
    if (!resource || !['catalog', 'meta', 'stream', 'subtitles'].includes(resource.name)) return [];
    return [{ name: resource.name, types: strings(resource.types), ...(resource.idPrefixes ? { idPrefixes: strings(resource.idPrefixes) } : {}) }];
  });
  const catalogs = list(value.catalogs).slice(0, 32).filter(c => c && ['movie', 'series'].includes(c.type) && validId(c.id)).map(c => ({
    id: c.id, type: c.type, name: text(c.name || value.name, 100),
    extra: (Array.isArray(c.extra) ? c.extra : list(c.extraSupported).map(name => ({name,isRequired:list(c.extraRequired).includes(name)})))
      .slice(0, 12).filter(e => e && validId(e.name)).map(e => ({ name: e.name, isRequired: e.isRequired === true, options: strings(e.options) })),
  }));
  return { id: value.id, name: text(value.name, 100), description: text(value.description, 400), resources, types: strings(value.types),
    ...(value.idPrefixes ? { idPrefixes: strings(value.idPrefixes) } : {}), catalogs,
    configurable: value.behaviorHints?.configurable === true, configurationRequired: value.behaviorHints?.configurationRequired === true };
}

export function stremioSupports(addon, resource, type, id) {
  if (!addon.enabled) return false;
  return addon.manifest.resources.some(r => {
    const spec = typeof r === 'string' ? { name: r, types: addon.manifest.types, idPrefixes: addon.manifest.idPrefixes } : r;
    return spec.name === resource && spec.types.includes(type) && (!spec.idPrefixes || spec.idPrefixes.some(prefix => id.startsWith(prefix)));
  });
}

export function stremioIdentity(type, metaId, videoId = null) {
  return encode([type, metaId, videoId]);
}
function identity(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 3000 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const [type, metaId, videoId] = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (!['movie', 'series'].includes(type) || !validId(metaId) || videoId !== null && !validId(videoId)) throw new Error();
    return { type, metaId, videoId: videoId || metaId };
  } catch { throw providerError('Choose a title from your Stremio library.'); }
}
function resourceUrl(addon, resource, type, id, extras = {}) {
  const base = new URL(addon.url);
  base.pathname = base.pathname.slice(0, -'manifest.json'.length) + [resource, type, id].map(encodeURIComponent).join('/') +
    (Object.keys(extras).length ? '/' + Object.entries(extras).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '') + '.json';
  return base.toString();
}
async function pool(values, action, concurrency = 4) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) { const i = next++; try { results[i] = { value: await action(values[i], i) }; } catch { results[i] = { failed: true }; } }
  }));
  return results;
}

function requestHeaders(stream) {
  const output = {};
  for (const [key, value] of Object.entries(stream.behaviorHints?.proxyHeaders?.request || {})) {
    if (!['user-agent', 'referer', 'origin', 'authorization', 'cookie', 'accept'].includes(key.toLowerCase()) || typeof value !== 'string' || value.length > 8000 || /[\r\n\0]/.test(value)) continue;
    output[key] = value;
  }
  return output;
}
export function stremioStreamReason(stream) {
  if (stream.drm || stream.licenseUrl) return 'This source requires DRM playback.';
  if (stream.url) {
    try { validateRemoteUrl(stream.url); return ''; } catch { return 'This source does not provide a supported HTTP video link.'; }
  }
  if (stream.infoHash) return 'This is a torrent source. Use an addon configured to return a direct streaming link.';
  if (stream.ytId) return 'Use the YouTube connection for this source.';
  if (stream.externalUrl) return 'This source opens another website and cannot play in TesPlay.';
  return 'This source does not provide a supported video link.';
}

export function registerStremioRoutes(app, ctx, dependencies = {}) {
  const fetchData = dependencies.remoteData || remoteData;
  const remoteRequest = dependencies.requestRemote || requestRemote;
  const now = dependencies.now || Date.now;
  const links = new Map(), cache = new Map();
  const preferredGroups = new Map();
  const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const manage = (req, res, next) => ctx.requireConnectionManager ? ctx.requireConnectionManager(req, res, next) :
    req.session?.scope !== 'remote' && (req.user?.role === 'owner' || req.user?.canManageConnections) ? next() : next(providerError('This account cannot manage connections.', 403));
  const limit = rateLimit({ windowMs: 60000, limit: 60, keyGenerator: req => req.user.id, standardHeaders: 'draft-8', legacyHeaders: false });
  const get = (req, id) => {
    const c = ctx.getConnection(req, String(id || ''));
    if (c.type !== 'stremio') throw providerError('Choose a Stremio connection.');
    return c;
  };
  const managed = (req, id) => {
    const c = get(req, id);
    if (c.shared) throw providerError('Only the connection owner can manage this shared connection.', 403);
    return c;
  };
  const save = (req, c, config, name = c?.name || 'Stremio') => ctx.saveConnection(req, { ...(c ? { id: c.id } : {}), type: 'stremio', name, config: { ...c?.config, ...config } });
  const fingerprint = c => hash(JSON.stringify(c.config));
  const cached = async (key, read, seconds = 60, force = false) => {
    const previous = cache.get(key);
    if (!force && previous?.expires > now()) return previous.promise;
    if (cache.size >= 300) cache.delete(cache.keys().next().value);
    const record = { expires: now() + seconds * 1000, promise: Promise.resolve().then(read) };
    cache.set(key, record);
    try {
      const value = await record.promise;
      if (cache.get(key) === record) {
        const seen = new WeakSet();
        record.bytes = Buffer.byteLength(JSON.stringify(value, (_key, item) => {
          if (item && typeof item === 'object') { if (seen.has(item)) return null; seen.add(item); }
          return item;
        }));
        let total = [...cache.values()].reduce((sum, entry) => sum + (entry.bytes || 0), 0);
        for (const [oldKey, entry] of cache) {
          if (total <= 16 * 1024 * 1024) break;
          cache.delete(oldKey); total -= entry.bytes || 0;
        }
      }
      return value;
    } catch (error) { if (cache.get(key) === record) cache.delete(key); throw error; }
  };
  const fetchAddon = (url, options = {}) => fetchData(url, { timeout: 8000, signal: AbortSignal.timeout(10000), maxBytes: 2 * 1024 * 1024, ...options });
  async function api(method, body) {
    const response = await fetchData(`https://api.strem.io/api/${method}`, { method: 'POST', timeout: 12000, signal: AbortSignal.timeout(15000), maxBytes: 2 * 1024 * 1024,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.error || !response.result) throw providerError('Stremio could not access this account. Reconnect your Stremio account.', 502);
    return response.result;
  }
  const publicAddon = addon => ({ key: addon.key, name: addon.manifest.name, description: addon.manifest.description, enabled: addon.enabled,
    showCatalogs: addon.showCatalogs, catalogCount: addon.manifest.catalogs.length,
    resources: [...new Set(addon.manifest.resources.map(r => typeof r === 'string' ? r : r.name))],
    configurable: addon.manifest.configurable, custom: addon.origin === 'custom' });
  const publicSettings = c => ({ connection: { id: c.id, type: c.type, name: c.name }, linked: Boolean(c.config.authKey), addons: list(c.config.addons).map(publicAddon) });
  async function addonFromUrl(url, existing, origin = 'custom') {
    const normalized = stremioManifestUrl(url), manifest = stremioManifest(await fetchAddon(normalized));
    return { key: existing?.key || randomUUID(), url: normalized, manifest, enabled: existing?.enabled ?? true, showCatalogs: existing?.showCatalogs ?? true, origin };
  }
  async function installed(authKey, existing = [], ignored = []) {
    const result = await api('addonCollectionGet', { authKey, update: true });
    if (!Array.isArray(result.addons) || result.addons.length > MAX_ADDONS) throw providerError('Stremio returned too many addons. Use up to 32 addons in TesPlay.');
    const seen = new Set(), addons = [];
    for (const descriptor of result.addons) {
      try {
        const url = stremioManifestUrl(descriptor.transportUrl);
        if (seen.has(url)) continue;
        seen.add(url);
        if (ignored.includes(hash(url))) continue;
        const override = existing.find(a => a.accountUrl === url);
        if (override) { addons.push(override); continue; }
        const previous = existing.find(a => a.url === url);
        addons.push({ key: previous?.key || randomUUID(), url, manifest: stremioManifest(descriptor.manifest), enabled: previous?.enabled ?? true, showCatalogs: previous?.showCatalogs ?? true, origin: previous?.origin || 'account' });
      } catch { /* Unsupported legacy transports do not prevent importing the remaining addons. */ }
    }
    if (!addons.some(a => a.manifest.id === 'com.linvo.cinemeta') && !ignored.includes(hash(CINEMETA))) addons.unshift(await addonFromUrl(CINEMETA, existing.find(a => a.url === CINEMETA), 'account'));
    for (const addon of existing) if (addon.origin === 'custom' && !seen.has(addon.url) && !addons.some(a => a.key === addon.key)) addons.push(addon);
    if (addons.length > MAX_ADDONS) throw providerError('Use up to 32 addons in TesPlay. Remove an addon before importing more.');
    return addons;
  }

  app.post('/api/stremio/link', manage, limit, route(async (req, res) => {
    const c = req.body?.connectionId ? managed(req, req.body.connectionId) : null;
    for (const [id, item] of links) if (item.expires < now() || item.sessionId === req.session.id) links.delete(id);
    if (links.size >= 100) throw providerError('Account linking is busy. Try again shortly.', 429);
    const response = await fetchData('https://link.stremio.com/api/create?type=Create', { timeout: 10000, signal: AbortSignal.timeout(12000), maxBytes: 64000 });
    const result = response.result || response;
    if (!validId(result.code) || !result.link) throw providerError('Stremio sign-in is unavailable. Try again shortly.', 502);
    const url = new URL(result.link);
    if (url.origin !== 'https://link.stremio.com') throw providerError('Stremio returned an unexpected sign-in address.', 502);
    const id = randomUUID(), expires = now() + 5 * 60000;
    links.set(id, { code: result.code, sessionId: req.session.id, userId: req.user.id, connectionId: c?.id, expires, nextPoll: 0 });
    res.json({ id, url: url.toString(), code: result.code, expiresAt: new Date(expires).toISOString() });
  }));
  app.post('/api/stremio/link/check', manage, route(async (req, res) => {
    const link = links.get(req.body?.id);
    if (!link || link.sessionId !== req.session.id || link.userId !== req.user.id || link.expires < now()) throw providerError('This sign-in has expired. Start again.', 410);
    if (link.completed) return res.json(link.completed);
    if (link.pending || link.nextPoll > now()) return res.json({ pending: true });
    link.pending = true; link.nextPoll = now() + 3000;
    try {
      const response = await fetchData(`https://link.stremio.com/api/read?type=Read&code=${encodeURIComponent(link.code)}`, { timeout: 10000, signal: AbortSignal.timeout(12000), maxBytes: 64000 });
      const result = response.result || response;
      if (!result.authKey) return res.json({ pending: true });
      if (typeof result.authKey !== 'string' || result.authKey.length > 4096) throw providerError('Stremio returned an invalid session.', 502);
      const c = link.connectionId ? managed(req, link.connectionId) : null;
      const addons = await installed(result.authKey, c?.config.addons || [], c?.config.ignoredAddons || []);
      if (link.expires < now() || links.get(req.body.id) !== link) throw providerError('This sign-in expired. Start again.', 410);
      if (c && fingerprint(managed(req, c.id)) !== fingerprint(c)) throw providerError('Your connection changed during sign-in. Start again.', 409);
      const connection = save(req, c, { authKey: result.authKey, addons });
      link.completed = { connection }; link.code = '';
      res.json(link.completed);
    } finally { link.pending = false; }
  }));
  app.delete('/api/stremio/link/:id', manage, (req, res) => {
    const link = links.get(req.params.id);
    if (link?.sessionId === req.session.id) links.delete(req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/stremio/:id/settings', manage, (req, res) => res.json(publicSettings(managed(req, req.params.id))));
  app.post('/api/stremio/:id/sync', manage, limit, route(async (req, res) => {
    const c = managed(req, req.params.id);
    if (!c.config.authKey) throw providerError('Connect your Stremio account to import its addons.');
    const addons = await installed(c.config.authKey, c.config.addons, c.config.ignoredAddons || []);
    const current = managed(req, c.id);
    if (fingerprint(current) !== fingerprint(c)) throw providerError('Your addons changed during import. Try importing again.', 409);
    save(req, current, { addons }); res.json(publicSettings(managed(req, c.id)));
  }));
  app.post('/api/stremio/addon', manage, limit, route(async (req, res) => {
    const c = req.body?.connectionId ? managed(req, req.body.connectionId) : null;
    const addon = await addonFromUrl(req.body?.url);
    const current = c ? managed(req, c.id) : null;
    const addons = list(current?.config.addons);
    if (addons.some(a => a.url === addon.url)) throw providerError('This addon is already connected.');
    if (addons.length >= MAX_ADDONS) throw providerError('Use up to 32 addons in TesPlay.');
    const defaults = !c && addon.manifest.id !== 'com.linvo.cinemeta' ? [await addonFromUrl(CINEMETA)] : [];
    if (current && fingerprint(managed(req, current.id)) !== fingerprint(current)) throw providerError('Your addons changed. Try adding the link again.', 409);
    const connection = save(req, current, { addons: [...addons, ...defaults, addon] });
    res.status(201).json({ connection, ...publicSettings(managed(req, connection.id)) });
  }));
  app.patch('/api/stremio/:id/addons/:key', manage, limit, route(async (req, res) => {
    const c = managed(req, req.params.id), original = list(c.config.addons).find(a => a.key === req.params.key);
    if (!original) throw providerError('This addon is no longer connected.', 404);
    for (const field of ['enabled', 'showCatalogs']) if (req.body?.[field] !== undefined && typeof req.body[field] !== 'boolean') throw providerError('Choose whether to use this addon.');
    const replacement = req.body?.url ? await addonFromUrl(req.body.url, original) : original;
    const current = managed(req, c.id);
    if (fingerprint(current) !== fingerprint(c)) throw providerError('Your addons changed. Reopen the addon settings.', 409);
    const addon = { ...replacement, ...(req.body?.url && (original.origin === 'account' || original.accountUrl) ? {accountUrl:original.accountUrl || original.url} : {}), ...(typeof req.body?.enabled === 'boolean' ? { enabled: req.body.enabled } : {}), ...(typeof req.body?.showCatalogs === 'boolean' ? { showCatalogs: req.body.showCatalogs } : {}) };
    if (current.config.addons.some(a => a.key !== original.key && a.url === addon.url)) throw providerError('This addon is already connected.');
    save(req, current, { addons: current.config.addons.map(a => a.key === original.key ? addon : a) });
    res.json(publicSettings(managed(req, c.id)));
  }));
  app.delete('/api/stremio/:id/addons/:key', manage, limit, (req, res) => {
    const c = managed(req, req.params.id);
    const removed = list(c.config.addons).find(a => a.key === req.params.key);
    const ignoredAddons = [...new Set([...list(c.config.ignoredAddons), ...(removed ? [hash(removed.accountUrl || removed.url)] : [])])].slice(-100);
    save(req, c, { addons: list(c.config.addons).filter(a => a.key !== req.params.key), ignoredAddons }); res.json(publicSettings(managed(req, c.id)));
  });
  app.get('/api/stremio/:id/addons/:key/configure', manage, (req, res) => {
    const addon = list(managed(req, req.params.id).config.addons).find(a => a.key === req.params.key);
    if (!addon || !addon.manifest.configurable) throw providerError('This addon has no configuration page.', 404);
    const url = new URL(addon.url); url.pathname = url.pathname.slice(0, -'manifest.json'.length) + 'configure';
    res.set('Referrer-Policy', 'no-referrer').redirect(url.toString());
  });

  function catalogs(c, kind = 'all') {
    return list(c.config.addons).filter(a => a.enabled && a.showCatalogs).flatMap(addon => addon.manifest.catalogs.flatMap(catalog => {
      if (kind !== 'all' && catalog.type !== kind || c.access && !c.access.kinds.includes(catalog.type)) return [];
      return [{ id: hash(`${addon.key}:${catalog.type}:${catalog.id}`), name: `${addon.manifest.name} · ${catalog.name}`, type: catalog.type, addon, catalog }];
    }));
  }
  const allowed = (req, c, type) => ctx.assertAccess?.(req, c, { type, contentKind: type });
  const artwork = (req, c, url) => {
    if (typeof url !== 'string') return undefined;
    try { return ctx.media.register(req, c, { kind: 'artwork', url: validateRemoteUrl(url).toString() }); } catch { return undefined; }
  };
  function mediaItem(req, c, meta, video) {
    const type = meta.type === 'series' ? 'series' : 'movie';
    const minutes = /^(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?$/i.exec(String(video?.runtime || meta.runtime || '').trim());
    const duration = minutes ? Number(minutes[1]) * 60 : 0;
    return { id: stremioIdentity(type, meta.id, video?.id || null), connectionId: c.id, providerType: 'stremio', source: c.name,
      title: text(video?.title || meta.name), type: video ? 'episode' : type, contentKind: type,
      description: text(video?.overview || meta.description, 6000), poster: artwork(req, c, video?.thumbnail || meta.poster), backdrop: artwork(req, c, meta.background),
      year: text(meta.releaseInfo, 30), publishedAt: typeof (video?.released || meta.released) === 'string' ? (video?.released || meta.released) : undefined,
      ...(duration > 0 && duration <= 604800 ? { duration } : {}),
      ...(video ? { seriesId: stremioIdentity('series', meta.id), seasonNumber: Number.isSafeInteger(video.season) && video.season >= 0 ? video.season : 0, episodeNumber: Number.isSafeInteger(video.episode) && video.episode >= 0 ? video.episode : undefined, subtitle: text(meta.name) } : {}) };
  }
  async function metadata(c, type, id) {
    return cached(`${fingerprint(c)}:meta:${type}:${id}`, async () => {
      const addons = list(c.config.addons).filter(a => stremioSupports(a, 'meta', type, id));
      const signal = AbortSignal.timeout(10000);
      const results = await pool(addons, async addon => {
        const data = await fetchAddon(resourceUrl(addon, 'meta', type, id), { signal });
        if (data.meta?.id !== id || data.meta.type !== type) throw providerError('Title details unavailable.');
        return data.meta;
      });
      const result = results.find(r => r.value);
      if (result) return result.value;
      throw providerError('No enabled addon could find details for this title. Enable its metadata addon in Stremio settings.', 404);
    }, 300);
  }
  async function episodes(req, c, raw) {
    const id = identity(raw); allowed(req, c, id.type);
    if (id.type !== 'series') return [];
    const meta = await metadata(c, id.type, id.metaId);
    return list(meta.videos).slice(0, 5000).filter(v => v && validId(v.id)).map(v => mediaItem(req, c, meta, v)).sort((a, b) => a.seasonNumber - b.seasonNumber || (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
  }
  app.get('/api/stremio/:id/catalogs', route(async (req, res) => {
    const c = get(req, req.params.id);
    res.json({ catalogs: catalogs(c, req.query.kind).filter(entry => req.query.search === '1' ? entry.catalog.extra.some(e => e.name === 'search') : entry.catalog.extra.every(e => !e.isRequired))
      .map(({ addon, catalog, ...value }) => value) });
  }));
  app.post('/api/connections/:id/test', route(async (req, res, next) => {
    const c = ctx.getConnection(req, req.params.id); if (c.type !== 'stremio') return next();
    const enabled = list(c.config.addons).filter(a => a.enabled);
    if (!enabled.length) throw providerError('Enable at least one addon in Stremio settings.');
    const signal = AbortSignal.timeout(10000);
    const results = await pool(enabled, a => fetchAddon(a.url, { signal }));
    if (results.every(r => r.failed)) throw providerError('Your enabled addons could not be reached. Check their links and configuration.', 502);
    res.json({ ok: true, message: `${c.name} is connected. ${results.filter(r => !r.failed).length} of ${enabled.length} enabled addons responded.` });
  }));
  app.get('/api/catalog', route(async (req, res, next) => {
    const c = ctx.getConnection(req, req.query.connectionId); if (c.type !== 'stremio') return next();
    const kind = String(req.query.kind || 'all'), q = String(req.query.q || '').trim().slice(0, 200), parent = String(req.query.parentId || '');
    if (parent) return res.json({ items: await episodes(req, c, parent), hasMore: false });
    const available = catalogs(c, kind), category = String(req.query.category || '');
    const page = Math.min(100, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 60));
    const matching = available.filter(entry => (!category || category === entry.id) &&
      (!q || entry.catalog.extra.some(e => e.name === 'search')) && entry.catalog.extra.every(e => !e.isRequired || e.name === 'search' && q));
    const selected = matching.slice(0, q ? 16 : 1);
    const signal = AbortSignal.timeout(10000);
    const results = await pool(selected, async entry => {
      allowed(req, c, entry.type);
      const extra = { ...(q ? { search: q } : {}), ...(entry.catalog.extra.some(e => e.name === 'skip') ? { skip: String((page - 1) * limit) } : {}) };
      if (page > 1 && !entry.catalog.extra.some(e => e.name === 'skip')) return { items: [], hasMore: false };
      const data = await cached(`${fingerprint(c)}:catalog:${entry.id}:${JSON.stringify(extra)}`, () => fetchAddon(resourceUrl(entry.addon, 'catalog', entry.type, entry.catalog.id, extra), { signal }), 120, req.query.refresh === '1');
      const metas = list(data.metas).filter(m => m && validId(m.id) && m.type === entry.type);
      return { items: metas.slice(0, limit).map(m => mediaItem(req, c, m)), hasMore: metas.length >= limit && entry.catalog.extra.some(e => e.name === 'skip') };
    });
    if (results.length && results.every(r => r.failed)) throw providerError('Your Stremio catalogs could not load. Check the enabled addons.', 502);
    const items = [...new Map(results.flatMap(r => r.value?.items || []).map(i => [i.id, i])).values()];
    res.json({ items: items.slice(0, limit), categories: available.map(e => ({ id: e.id, name: e.name })),
      hasMore: results.some(r => r.value?.hasMore), partial: results.some(r => r.failed) || Boolean(q && matching.length > selected.length) });
  }));
  app.get(['/api/episodes', '/api/episodes/next'], route(async (req, res, next) => {
    const c = ctx.getConnection(req, req.query.connectionId); if (c.type !== 'stremio') return next();
    const items = await episodes(req, c, req.query.itemId), index = items.findIndex(i => i.id === req.query.itemId);
    if (req.path.endsWith('/next')) return res.json({ item: index >= 0 ? items[index + 1] || null : null });
    res.json({ items, next: index >= 0 ? items[index + 1] || null : null, previous: index > 0 ? items[index - 1] : null });
  }));
  async function streams(req, c, raw) {
    const id = identity(raw); allowed(req, c, id.type);
    return cached(`${fingerprint(c)}:streams:${raw}`, async () => {
      const addons = list(c.config.addons).filter(a => stremioSupports(a, 'stream', id.type, id.videoId));
      const signal = AbortSignal.timeout(10000);
      const results = await pool(addons, async addon => {
        const data = await fetchAddon(resourceUrl(addon, 'stream', id.type, id.videoId), { signal });
        return list(data.streams).slice(0, 100).filter(s => s && typeof s === 'object').map((stream, index) => ({ stream, addon,
          id: hash(`${addon.key}:${index}:${stream.url || stream.infoHash || stream.externalUrl || ''}`),
          label: text(stream.name || addon.manifest.name, 100), description: text(stream.description || stream.title, 500),
          reason: stremioStreamReason(stream) }));
      });
      return { values: results.flatMap(r => r.value || []).slice(0, 300), partial: results.some(r => r.failed), hasAddons: Boolean(addons.length) };
    }, 45, req.query.refresh === '1');
  }
  app.get('/api/playback/options', route(async (req, res, next) => {
    const c = ctx.getConnection(req, req.query.connectionId); if (c.type !== 'stremio') return next();
    const id = identity(req.query.itemId); allowed(req, c, id.type);
    const [result, meta] = await Promise.all([streams(req, c, req.query.itemId), metadata(c, id.type, id.metaId).catch(() => null)]);
    const video = meta && id.type === 'series' ? list(meta.videos).find(v => v?.id === id.videoId) : null;
    res.json({ ...(meta && (id.type === 'movie' || video) ? { item: mediaItem(req, c, meta, video) } : {}), audio: [], subtitles: [], qualities: [], sources: result.values.map(s => ({ id: s.id, label: s.label, description: s.description, addon: s.addon.manifest.name, unavailable: Boolean(s.reason), unavailableReason: s.reason })),
      note: result.partial ? 'Some addons could not respond. You can use another source or try again.' : !result.hasAddons ? 'Enable a stream addon, or paste a configured addon link in Connections.' : !result.values.length ? 'Your enabled addons found no sources for this title.' : '' });
  }));
  app.get('/api/playback', route(async (req, res, next) => {
    const c = ctx.getConnection(req, req.query.connectionId); if (c.type !== 'stremio') return next();
    const raw = String(req.query.itemId || ''), id = identity(raw), result = await streams(req, c, raw);
    const preferenceKey = `${req.user.id}:${ctx.getProfileId(req)}:${c.id}:${fingerprint(c)}`;
    const preferred = preferredGroups.get(preferenceKey);
    const selected = req.query.sourceId && req.query.sourceId !== 'auto' ? result.values.find(s => s.id === req.query.sourceId) :
      (preferred?.expires > now() ? result.values.find(s => !s.reason && s.addon.key === preferred.addon && s.stream.behaviorHints?.bingeGroup === preferred.group) : null) || result.values.find(s => !s.reason);
    if (!selected) throw providerError(req.query.sourceId ? 'This source expired. Reopen the title and choose a source again.' : result.values[0]?.reason || 'No playable sources were found. Check your stream addons in Connections.');
    if (selected.reason) throw providerError(selected.reason);
    if (typeof selected.stream.behaviorHints?.bingeGroup === 'string') {
      if (preferredGroups.size >= 200) preferredGroups.delete(preferredGroups.keys().next().value);
      preferredGroups.set(preferenceKey, { addon: selected.addon.key, group: selected.stream.behaviorHints.bingeGroup.slice(0, 500), expires: now() + 12 * 3600000 });
    }
    const stream = selected.stream, headers = requestHeaders(stream);
    let hls = /\.m3u8(?:[?#]|$)/i.test(stream.url) || Object.entries(stream.behaviorHints?.proxyHeaders?.response || {}).some(([key,value])=>key.toLowerCase()==='content-type' && /mpegurl/i.test(String(value)));
    if (!hls && !/\.(mp4|m4v|mkv|mov|webm|ts)(?:[?#]|$)/i.test(stream.url)) {
      try {
        const probe = await remoteRequest(stream.url, {method:'HEAD',headers,timeout:5000});
        hls = /mpegurl/i.test(String(probe.headers['content-type'] || '')) || /\.m3u8(?:[?#]|$)/i.test(probe.finalUrl || '');
        probe.resume();
      } catch { /* The player can still try the original direct-file source if HEAD is unavailable. */ }
    }
    const url = ctx.media.register(req, c, { url: stream.url, headers, kind: hls ? 'hls' : 'video', access: { type: id.type, contentKind: id.type } });
    const subtitleAddons = list(c.config.addons).filter(a => stremioSupports(a, 'subtitles', id.type, id.videoId));
    const extras = Object.fromEntries(['videoHash', 'videoSize', 'filename'].flatMap(key => {
      const value = stream.behaviorHints?.[key]; return ['string', 'number'].includes(typeof value) ? [[key, String(value).slice(0, 500)]] : [];
    }));
    const subtitleSignal = AbortSignal.timeout(5000);
    const subtitleResults = await pool(subtitleAddons, async addon => list((await fetchAddon(resourceUrl(addon, 'subtitles', id.type, id.videoId, extras), { signal: subtitleSignal })).subtitles));
    const subtitles = [...list(stream.subtitles), ...subtitleResults.flatMap(r => r.value || [])].slice(0, 100).flatMap(s => {
      try {
        if (typeof s.url !== 'string' || !/\.(srt|vtt)(?:[?#]|$)/i.test(s.url)) return [];
        const target = validateRemoteUrl(s.url).toString();
        return [{ id: hash(target), label: text(s.lang || 'Subtitles', 50), language: text(s.lang, 20), url: ctx.media.register(req, c, { url: target, kind: 'subtitle', access: { type: id.type, contentKind: id.type } }) }];
      } catch { return []; }
    });
    res.json({ provider: 'stremio', url, type: hls ? 'hls' : 'video', streamKind: 'direct-file', subtitles, sourceId: selected.id, message: selected.addon.manifest.name });
  }));
}
