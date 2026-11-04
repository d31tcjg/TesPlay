import { plainText } from "./text.js";
import { providerError } from './media.js';
const rows = value => Array.isArray(value) ? value : [];
const text = plainText;
const channelId = value => { if (!/^UC[A-Za-z0-9_-]{22}$/.test(String(value))) throw providerError('Invalid YouTube channel.'); return String(value); };
const playlistId = value => { if (!/^[A-Za-z0-9_-]{10,100}$/.test(String(value))) throw providerError('Invalid YouTube playlist.'); return String(value); };
const pageToken = req => {
  const token = String(req.query.pageToken || '');
  if (token.length > 2048 || /[\r\n]/.test(token)) throw providerError('Invalid YouTube page.');
  return token ? { pageToken: token } : {};
};
export function youtubeDuration(value) {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(value || ''));
  if (!match) return undefined;
  const seconds = Number(match[1]||0)*86400+Number(match[2]||0)*3600+Number(match[3]||0)*60+Number(match[4]||0);
  return seconds>0 && seconds<=604800 ? seconds : undefined;
}
export function registerYouTubeBrowser(app, { connection, request, route, art, cached, cacheKey, library, stars = () => [] }) {
  const personal = c => {
    if (!(c.config.authMode === 'oauth' || (c.config.authMode !== 'apiKey' && c.config.refreshToken)) || !(c.config.accessToken || c.config.refreshToken))
      throw providerError('Connect your Google account in YouTube settings to see subscriptions, playlists and personal suggestions. An API key only supports public browsing.', 409);
  };
  const video = (req, c, x) => {
    const snippet = x.snippet || {};
    const id = x.contentDetails?.videoId || snippet.resourceId?.videoId || x.id?.videoId || x.id;
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(id)) || ['Private video', 'Deleted video'].includes(snippet.title)) return null;
    return { id, connectionId: c.id, source: 'YouTube', providerType: 'youtube', type: 'video', title: text(snippet.title), description: text(snippet.description),
      poster: art(req, c, snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url), subtitle: text(snippet.videoOwnerChannelTitle || snippet.channelTitle), categoryLabel: text(snippet.videoOwnerChannelTitle || snippet.channelTitle),
      channelId: snippet.videoOwnerChannelId || snippet.channelId, publishedAt: x.contentDetails?.videoPublishedAt || snippet.publishedAt };
  };
  const withDurations = async (req,c,items) => {
    if (!items.length) return items;
    try {
      const ids=items.map(i=>i.id).sort().join(',');
      const data=await cached(cacheKey(c)+':durations:'+ids,()=>request(req,c,'videos',{part:'contentDetails',id:ids}),300);
      const durations=new Map(rows(data.items).map(x=>[x.id,youtubeDuration(x.contentDetails?.duration)]));
      return items.map(item=>({...item,...(durations.get(item.id)?{duration:durations.get(item.id)}:{})}));
    } catch { return items; } // Unknown duration remains visible when filtering.
  };
  const videos = async (req, c, id, token = {}) => {
    const data = await request(req, c, 'playlistItems', { part: 'snippet,contentDetails', playlistId: playlistId(id), maxResults: '50', ...token });
    return { items: await withDurations(req,c,rows(data.items).map(x => video(req, c, x)).filter(Boolean)), nextPageToken: data.nextPageToken || null };
  };
  const subscriptions = async (req, c, token = {}) => {
    personal(c);
    const data = await request(req, c, 'subscriptions', { part: 'snippet,contentDetails', mine: 'true', order: 'alphabetical', maxResults: '50', ...token });
    return { channels: rows(data.items).filter(x => /^UC[A-Za-z0-9_-]{22}$/.test(x.snippet?.resourceId?.channelId)).map(x => ({
      id: x.snippet.resourceId.channelId, title: text(x.snippet.title), description: text(x.snippet.description), thumbnail: art(req, c, x.snippet.thumbnails?.medium?.url || x.snippet.thumbnails?.default?.url), videoCount: x.contentDetails?.totalItemCount || 0,
    })), nextPageToken: data.nextPageToken || null, total: Number(data.pageInfo?.totalResults) || 0 };
  };
  const root = '/api/youtube/:connectionId';
  app.get(root + '/subscriptions', route(async (req, res) => {
    const c = connection(req, req.params.connectionId, 'youtube');
    res.json(await subscriptions(req, c, pageToken(req)));
  }));
  app.get(root + '/channel/:channelId/videos', route(async (req, res) => {
    const c = connection(req, req.params.connectionId, 'youtube');
    const id = channelId(req.params.channelId);
    const data = await cached(cacheKey(c) + ':channel:' + id, () => request(req, c, 'channels', { part: 'contentDetails', id }), 300);
    const uploads = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) throw providerError('This channel has no available uploads.', 404);
    res.json(await videos(req, c, uploads, pageToken(req)));
  }));
  app.get(root + '/playlists', route(async (req, res) => {
    const c = connection(req, req.params.connectionId, 'youtube'); personal(c);
    const data = await request(req, c, 'playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: '50', ...pageToken(req) });
    res.json({ playlists: rows(data.items).map(x => ({ id: x.id, title: text(x.snippet?.title), thumbnail: art(req, c, x.snippet?.thumbnails?.medium?.url), videoCount: x.contentDetails?.itemCount || 0 })), nextPageToken: data.nextPageToken || null });
  }));
  app.get(root + '/playlist/:playlistId/videos', route(async (req, res) => {
    const c = connection(req, req.params.connectionId, 'youtube');
    res.json(await videos(req, c, req.params.playlistId, pageToken(req)));
  }));
  app.get(root + '/search', route(async (req, res) => {
    const c = connection(req, req.params.connectionId, 'youtube');
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (!q) return res.json({ items: [], nextPageToken: null });
    const [data, matches] = await Promise.all([
      request(req, c, 'search', { part: 'snippet', type: 'video', maxResults: '50', q, ...pageToken(req) }),
      req.query.pageToken ? Promise.resolve({items:[]}) : cached(cacheKey(c)+':search-channels:'+q,()=>request(req,c,'search',{part:'snippet',type:'channel',maxResults:'12',q}),120),
    ]);
    res.json({items:await withDurations(req,c,rows(data.items).map(x=>video(req,c,x)).filter(Boolean)),channels:rows(matches.items).filter(x=>/^UC[A-Za-z0-9_-]{22}$/.test(String(x.id?.channelId))).map(x=>({id:x.id.channelId,title:text(x.snippet?.title),thumbnail:art(req,c,x.snippet?.thumbnails?.medium?.url || x.snippet?.thumbnails?.default?.url)})),nextPageToken:data.nextPageToken||null});
  }));
  app.get(root + '/feed', route(async (req, res) => {
    const c = connection(req, req.params.connectionId, 'youtube'); personal(c);
    if(!stars(req).some(s=>s.connectionId===c.id && s.kind==='channel')) return res.json({items:[],channelRows:[],nextOffset:null,totalChannels:0,basis:'starred-subscriptions'});
    // Fetch all subscription pages, with explicit work bounds and a short cache.
    // Cache upstream metadata; register artwork per request/profile afterward.
    const channels = await cached(cacheKey(c) + ':subscriptions:all', async () => {
      const all = []; let token = {};
      for (let page = 0; page < 100; page++) {
        const data = await request(req, c, 'subscriptions', { part: 'snippet', mine: 'true', order: 'unread', maxResults: '50', ...token });
        all.push(...rows(data.items).map(x => x.snippet?.resourceId?.channelId).filter(id => /^UC[A-Za-z0-9_-]{22}$/.test(id)));
        if (!data.nextPageToken) return [...new Set(all)];
        token = { pageToken: data.nextPageToken };
      }
      throw providerError('Your subscription list is too large for one feed refresh. Browse all channels from Subscriptions instead.', 422);
    }, 300);
    const starred = stars(req).filter(s=>s.connectionId===c.id && s.kind==='channel');
    const history = library(req).progress;
    const watched = new Set(history.filter(x => x.item.connectionId === c.id).map(x => x.item.id));
    const interests = new Map();
    for (const { item } of history) if (item.connectionId === c.id && item.channelId) interests.set(item.channelId, (interests.get(item.channelId) || 0) + 1);
    const ordered = starred.map(s=>s.id).filter(id=>channels.includes(id));
    const offset = Number(req.query.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > ordered.length) throw providerError('Invalid feed page.');
    const selected = ordered.slice(offset, offset + 8);
    const results = await Promise.allSettled(selected.map(async id => {
      const data = await cached(cacheKey(c) + ':uploads:' + id, async () => {
        const channel = await request(req, c, 'channels', { part: 'contentDetails', id });
        const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        return uploads ? request(req, c, 'playlistItems', { part: 'snippet,contentDetails', playlistId: uploads, maxResults: '8' }) : { items: [] };
      }, 300);
      return withDurations(req,c,rows(data.items).map(x => video(req, c, x)).filter(Boolean));
    }));
    const channelRows = results.flatMap((r,index)=>r.status==='fulfilled'?[{id:selected[index],title:starred.find(s=>s.id===selected[index])?.title||r.value[0]?.subtitle||'Channel',items:r.value}]:[]);
    const items = [...new Map(results.flatMap(r => r.status === 'fulfilled' ? r.value : []).map(x => [x.id, x])).values()]
      .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
    if (results.length && results.every(r => r.status === 'rejected')) throw providerError('Your subscription videos could not load. Check Google authorization and API quota, then retry.', 502);
    res.json({ items, channelRows, nextOffset: offset + selected.length < ordered.length ? offset + selected.length : null, totalChannels: ordered.length, partial: results.some(r => r.status === 'rejected'), basis: 'starred-subscriptions' });
  }));
}
