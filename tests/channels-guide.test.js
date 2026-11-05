import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';
import {registerProviderRoutes} from '../server/providers.js';
import {registerConnectionRoutes, validateConnection} from '../server/connection-routes.js';
import {allows, assertAllowed} from '../server/access.js';
import {createApp} from '../server/index.js';

// Synthetic data only: reserved 192.0.2.x host, invented titles, a frozen clock.
const NOW = 1800001000, ALIGNED = 1800000000, HOST = 'http://192.0.2.10:8089';

const airing = (channel, time, duration, extra = {}) => ({
  Channel: channel, Time: time, Duration: duration, Title: `Show ${channel}-${time}`, ProgramID: `PRIVATE-${channel}`,
  Raw: {secret: 'raw-blob'}, FullSummary: 'full summary body', SearchScore: 9, Genres: ['A', 'B', 'C', 'D'], Tags: [], ...extra,
});
const row = (number, airings, extra = {}) => ({
  Channel: {ChannelID: `id-${number}`, Number: number, Name: `Chan ${number}`, CallSign: `CS${number}`, DeviceID: 'dev', Hidden: false,
    Image: `http://192.0.2.10:8089/img/${number}.png`, Station: 'station-private', ...extra}, Airings: airings,
});
const channelMeta = [
  {number: '215', name: 'Cable', hd: false, source_name: 'Cable'},
  {number: '9.1', name: 'Local', hd: true, source_name: 'Antenna'},
  {number: '36.1', name: 'News', hd: true, source_name: 'Antenna'},
  {number: '7', name: 'Hidden by meta', hidden: true, source_name: 'Antenna'},
];
const baseGuide = () => [
  row('215', [airing('215', ALIGNED + 7200, 3600), airing('215', ALIGNED - 3600, 1800), airing('215', ALIGNED + 900, 3600, {Tags: ['New', 'Live'], SeasonNumber: 2, EpisodeNumber: 4, SeriesID: 'S1', Image: 'http://192.0.2.10:8089/a.png', Summary: 'x'.repeat(900)})]),
  row('9.1', [airing('9.1', ALIGNED, 1800, {Image: 'http://192.0.2.10:8089/b.png'}), airing('9.1', ALIGNED + 1800, 1800, {Image: 'http://192.0.2.10:8089/c.png'}),
    airing('9.1', ALIGNED + 3 * 3600, 1800)]),
  row('36.1', [airing('36.1', ALIGNED, 7200)]),
  row('7', [airing('7', ALIGNED, 3600)]),
  row('8', [airing('8', ALIGNED, 3600)], {Hidden: true}),
  row('../x', [airing('x', ALIGNED, 3600)]),
];

async function listen(t, app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, {guide = baseGuide(), now = [], access, extra = {}} = {}) {
  const calls = [], c = {id: 'c1', name: 'Synthetic DVR', type: 'channels', config: {url: HOST}, access};
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {req.user = {id: req.headers['x-viewer'] || 'owner'}; req.session = {id: 's'}; next();});
  const ctx = {
    getProfileId: () => 'p1',
    getConnection: (_req, id) => {if (id !== c.id) throw Object.assign(new Error('Missing'), {status: 404}); return c;},
    canAccess: (_req, conn, item) => allows(conn.access, item),
    assertAccess: (req, conn, item) => {assertAllowed(conn.access, item); req.mediaAccess = item;},
    saveConnection: (_req, value) => {Object.assign(c, validateConnection(value)); return {id: c.id};},
    getManagedConnection: () => c,
  };
  registerConnectionRoutes(app, {store: {visibleConnections: () => []}, ctx, requireOwner: (_req, _res, next) => next()});
  const data = {'/api/v1/channels': channelMeta, '/devices/ANY/guide/now': now, ...extra};
  registerProviderRoutes(app, ctx, {now: () => NOW * 1000, remoteData: async (input, options = {}) => {
    const u = new URL(input); calls.push({path: u.pathname + u.search, method: options.method || 'GET'});
    assert.equal(u.origin, HOST); assert.deepEqual(options.allowedPrivateHosts, ['192.0.2.10']);
    if (u.pathname === '/devices/ANY/guide') return structuredClone(guide);
    if (data[u.pathname] instanceof Error) throw data[u.pathname];
    if (u.pathname in data) return structuredClone(data[u.pathname]);
    throw new Error(`Unexpected synthetic request ${u.pathname}`);
  }});
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({error: err.message}));
  const base = await listen(t, app);
  const raw = path => fetch(`${base}/api/channels/c1/${path}`);
  return {c, calls, base, raw, get: async path => {const r = await raw(path); assert.equal(r.status, 200, await r.clone().text()); return r.json();},
    guideCalls: () => calls.filter(x => x.path.startsWith('/devices/ANY/guide'))};
}

test('guide aligns to the half hour, clamps hours/start, sorts numerically and drops hidden or invalid channels', async t => {
  const f = await fixture(t);
  const g = await f.get('guide?start=' + (NOW - 5));
  assert.equal(g.start, ALIGNED); assert.equal(g.end, ALIGNED + 3 * 3600);
  assert.deepEqual(g.channels.map(x => x.id), ['live:9.1', 'live:36.1', 'live:215']);
  assert.match(f.guideCalls()[0].path, new RegExp(`time=${ALIGNED}&duration=10800$`));
  const wide = await f.get('guide?hours=99&start=' + (NOW - 999999));
  assert.equal(wide.end - wide.start, 6 * 3600); assert.equal(wide.start, Math.floor((NOW - 7200) / 1800) * 1800);
  assert.equal((await f.get('guide?hours=0')).end - (await f.get('guide?hours=0')).start, 3600);
  const future = await f.get('guide?start=' + (NOW + 99 * 86400));
  assert.equal(future.start, Math.floor((NOW + 7 * 86400) / 1800) * 1800);
  assert.equal((await f.get('guide?hours=junk')).end - ALIGNED, 3 * 3600, 'default of 3 hours');
});

test('guide keeps only overlapping airings, sorted, with source/hd joins and trimmed fields', async t => {
  const f = await fixture(t);
  const text = JSON.stringify(await f.get('guide'));
  const g = JSON.parse(text);
  const cable = g.channels.find(x => x.number === '215'), local = g.channels.find(x => x.number === '9.1');
  assert.deepEqual(cable.airings.map(a => a.start), [ALIGNED + 900, ALIGNED + 7200], 'ended airing is dropped, others sorted');
  assert.equal(local.airings.length, 2, 'airing after the window is dropped');
  assert.equal(local.source, 'Antenna'); assert.equal(local.hd, true); assert.equal(cable.hd, undefined); assert.equal(cable.source, 'Cable');
  assert.equal(local.callSign, 'CS9.1');
  const a = cable.airings[0];
  assert.equal(a.end, ALIGNED + 900 + 3600); assert.equal(a.isNew, true); assert.equal(a.isLive, true);
  assert.equal(a.season, 2); assert.equal(a.episode, 4); assert.equal(a.seriesId, 'S1');
  assert.equal(a.summary.length, 400); assert.equal(a.genres.length, 3);
  for (const forbidden of ['Raw', 'raw-blob', 'FullSummary', 'full summary body', 'ProgramID', 'PRIVATE-', 'Station', 'station-private', 'SearchScore', '192.0.2', '8089', '"path"', 'Image'])
    assert.ok(!text.includes(forbidden), `response leaked ${forbidden}`);
});

test('artwork is registered only for logos and airings that are on now', async t => {
  const f = await fixture(t);
  const g = await f.get('guide');
  const local = g.channels.find(x => x.number === '9.1'), cable = g.channels.find(x => x.number === '215');
  assert.ok(g.channels.every(x => /^\/api\/media\//.test(x.logo)));
  assert.match(local.airings[0].image, /^\/api\/media\//, 'current airing has artwork');
  assert.equal(local.airings[1].image, undefined, 'upcoming airing has none');
  assert.equal(cable.airings[1].image, undefined);
});

test('art budget caps descriptors per response', async t => {
  const many = Array.from({length: 450}, (_, i) => row(String(1000 + i), [airing(String(1000 + i), ALIGNED, 3600, {Image: 'http://192.0.2.10:8089/z.png'})]));
  const f = await fixture(t, {guide: many});
  const g = await f.get('guide');
  const images = g.channels.flatMap(x => [x.logo, ...x.airings.map(a => a.image)]).filter(Boolean);
  assert.equal(g.channels.length, 450); assert.ok(images.length <= 400, `got ${images.length}`);
});

test('now returns at most one airing per channel, with next only from a cached guide window', async t => {
  const nowRows = [row('9.1', [airing('9.1', ALIGNED, 1800, {Image: 'http://192.0.2.10:8089/b.png'})]), row('215', []), row('36.1', [airing('36.1', ALIGNED, 7200)])];
  const f = await fixture(t, {now: nowRows});
  const bare = await f.get('now');
  assert.deepEqual(bare.channels.map(x => x.id), ['live:9.1', 'live:36.1', 'live:215']);
  assert.ok(bare.channels.every(x => x.airings.length <= 1 && x.next === undefined));
  assert.match(bare.channels[0].airings[0].image, /^\/api\/media\//);
  await f.get('guide');
  const warm = await f.get('now');
  assert.equal(warm.channels.find(x => x.number === '9.1').next.title, 'Show 9.1-' + (ALIGNED + 1800));
  assert.equal(warm.channels.find(x => x.number === '215').next.title, 'Show 215-' + (ALIGNED + 7200), 'channel without a current airing still gets next');
  assert.ok(!JSON.stringify(warm).includes('ProgramID'));
  assert.equal(f.guideCalls().length, 2, 'now + one guide window; next never costs a request');
});

test('airing clamps lookup time inclusively before cache lookup and window alignment', async t => {
  const lower = NOW - 2 * 3600, upper = NOW + 7 * 86400;
  for (const [input, expected] of [[lower - 1, lower], [-1, lower], [upper + 1, upper], [999999999999, upper],
    [lower, lower], [upper, upper], [NOW + 123, NOW + 123]]) {
    // A one-second program proves the lookup uses the exact clamped second, not the aligned fetch time.
    const f = await fixture(t, {guide: [row('9.1', [airing('9.1', expected, 1)])]});
    const result = await f.get(`airing?channel=9.1&time=${input}`);
    assert.equal(result.airing.start, expected, String(input));
    assert.equal(f.guideCalls()[0].path, `/devices/ANY/guide?time=${Math.floor(expected / 1800) * 1800}&duration=3600`);
  }
  const f = await fixture(t, {guide: [row('9.1', [airing('9.1', lower, 1), airing('9.1', lower - 1, 1)])]});
  await f.get(`guide?start=${lower}`);
  assert.equal((await f.get(`airing?channel=9.1&time=${lower - 1}`)).airing.start, lower, 'cached lookup is also clamped');
  assert.equal(f.guideCalls().length, 1);
});

test('airing defaults missing and malformed times to the frozen current second', async t => {
  const f = await fixture(t, {guide: [row('9.1', [airing('9.1', NOW, 1)])]});
  for (const query of ['', '&time=', '&time=abc', '&time=1.5', '&time=1e9', '&time=Infinity',
    '&time=1800001000junk', '&time=1&time=2', '&time[x]=1', '&time=999999999999999999999999999999']) {
    assert.equal((await f.get('airing?channel=9.1' + query)).airing.start, NOW, query);
  }
});

test('airing looks up one airing with long summary and artwork; bad channels are 400 and misses are 404', async t => {
  const f = await fixture(t, {guide: [row('9.1', [airing('9.1', ALIGNED, 1800, {Summary: 'short', FullSummary: 'F'.repeat(2000), Image: 'http://192.0.2.10:8089/b.png'})])]});
  const r = await f.get(`airing?channel=9.1&time=${ALIGNED + 60}`);
  assert.equal(r.channel.id, 'live:9.1'); assert.equal(r.airing.start, ALIGNED); assert.equal(r.airing.summary.length, 1500);
  assert.match(r.airing.image, /^\/api\/media\//);
  assert.match(f.guideCalls()[0].path, new RegExp(`time=${ALIGNED}&duration=3600$`), 'fetches a one hour window');
  for (const q of ['channel=../x&time=1', 'time=5'])
    assert.equal((await f.raw('airing?' + q)).status, 400, q);
  assert.equal((await f.raw(`airing?channel=9.1&time=${ALIGNED + 4000}`)).status, 404);
  assert.equal((await f.raw(`airing?channel=500&time=${ALIGNED}`)).status, 404);
});

test('guide, now and airing reuse upstream responses for 60 seconds', async t => {
  const f = await fixture(t);
  await f.get('guide'); await f.get('guide'); await f.get(`airing?channel=9.1&time=${ALIGNED + 10}`);
  assert.equal(f.guideCalls().length, 1, 'airing is served from the cached window');
  await f.get('now'); await f.get('now');
  assert.equal(f.guideCalls().length, 2);
});

test('non-channels and unknown connections are rejected; live grants are required', async t => {
  const f = await fixture(t);
  f.c.type = 'xtream'; assert.equal((await f.raw('guide')).status, 400);
  f.c.type = 'channels'; f.c.access = {kinds: ['series']};
  for (const p of ['guide', 'now', `airing?channel=9.1&time=${ALIGNED}`]) assert.equal((await f.raw(p)).status, 403, p);
  f.c.access = {kinds: ['live']};
  assert.equal((await f.raw('guide')).status, 200);
});

test('connection test explains 403 and HTML responses', async t => {
  const probe = f => fetch(`${f.base}/api/connections/c1/test`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  const friendly = /refused this address.*local network address.*http:\/\/192\.168\.1\.20:8089/;
  const failures = [
    '<!doctype html><html></html>', // an HTML page, as a string
    Object.assign(new Error('Provider returned HTTP 403. Check the connection and permissions.'), {status: 400}), // 401/403 mapping
    Object.assign(new Error('The provider returned an invalid response.'), {status: 502}), // HTML that fails JSON.parse
  ];
  for (const failure of failures) {
    const r = await probe(await fixture(t, {extra: {'/status': failure}}));
    assert.equal(r.status, 400); assert.match((await r.json()).error, friendly);
  }
  const ok = await probe(await fixture(t, {extra: {'/status': {features: {}}}}));
  assert.equal(ok.status, 200);
  const down = await probe(await fixture(t, {extra: {'/status': Object.assign(new Error('Provider returned HTTP 500.'), {status: 502})}}));
  assert.equal(down.status, 502);
});

// Full-stack: household grants and QR remote scope through the real app.
async function stack(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tesplay-guide-'));
  const instance = await createApp({dataDir, setupToken: 'fixture-owner-setup', quiet: true, providerDependencies: {
    now: () => NOW * 1000,
    remoteData: async input => {
      const u = new URL(input);
      if (u.pathname === '/devices/ANY/guide') return baseGuide();
      if (u.pathname === '/devices/ANY/guide/now') return [];
      if (u.pathname === '/api/v1/channels') return channelMeta;
      if (u.pathname === '/devices/ANY/channels') return [];
      throw new Error('Unexpected synthetic request ' + u.pathname);
    }}});
  const server = instance.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const client = () => {let cookie = ''; return async (path, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + path, {method, headers: {cookie, ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
    const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return {status: response.status, data: await response.json().catch(() => ({}))};
  };};
  const password = 'test password for guide', owner = client();
  await owner('/api/auth/setup', {name: 'Owner', email: 'owner@tesplay.test', password, setupToken: 'fixture-owner-setup'});
  const connection = instance.store.saveConnection(instance.store.findUser('owner@tesplay.test').id, {type: 'channels', name: 'Synthetic DVR', config: {url: HOST}});
  t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r)); instance.close(); await rm(dataDir, {recursive: true, force: true});});
  const member = async kinds => {
    const created = await owner('/api/accounts', {name: 'Passenger', email: `p${kinds.join('')}@tesplay.test`, password,
      grants: [{connectionId: connection.id, kinds, sections: null, categories: null}]});
    assert.equal(created.status, 201);
    const request = client(); assert.equal((await request('/api/auth/login', {email: `p${kinds.join('')}@tesplay.test`, password})).status, 200);
    return request;
  };
  return {owner, connection, member, client};
}

test('household accounts without a live grant get 403; with one they read the guide', async t => {
  const f = await stack(t), id = f.connection.id;
  const series = await f.member(['series']);
  for (const p of ['guide', 'now', `airing?channel=9.1&time=${ALIGNED}`]) assert.equal((await series(`/api/channels/${id}/${p}`)).status, 403, p);
  const live = await f.member(['live']);
  assert.equal((await live(`/api/channels/${id}/guide`)).status, 200);
});

test('a QR remote can GET guide, now and airing but nothing else new', async t => {
  const f = await stack(t), id = f.connection.id;
  const pairing = (await f.owner('/api/remote/pair', {})).data, phone = f.client();
  assert.equal((await phone('/api/auth/remote/redeem', {code: pairing.code, token: pairing.token})).status, 200);
  assert.equal((await phone(`/api/channels/${id}/guide`)).status, 200);
  assert.equal((await phone(`/api/channels/${id}/now`)).status, 200);
  assert.equal((await phone(`/api/channels/${id}/airing?channel=9.1&time=${ALIGNED}`)).status, 200);
  assert.equal((await phone(`/api/channels/${id}/guide`, {})).status, 403, 'POST is not allowed');
  assert.equal((await phone(`/api/channels/${id}/other`)).status, 403);
  assert.equal((await phone(`/api/channels/${id}/guide/extra`)).status, 403);
});

test('recently recorded merges new unwatched episodes and movies newest first without private fields', async t => {
  const episodes = [
    {id: '1', show_id: 'S', title: 'Show S', episode_title: 'Old', created_at: 1000, path: '/private/1.ts'},
    {id: '2', show_id: 'S', title: 'Show S', episode_title: 'New', created_at: 5000, playback_time: 30, duration: 100},
    {id: '3', show_id: 'S', title: 'Show S', episode_title: 'Seen', created_at: 6000, watched: true},
    {id: '4', show_id: 'S', title: 'Show S', episode_title: 'Bad', created_at: 7000, corrupted: true},
    {id: '5', show_id: 'S', title: 'Show S', episode_title: 'Gone', created_at: 8000, cancelled: true},
    {id: '6', show_id: 'S', title: 'Show S', episode_title: 'Still recording', created_at: 9000, processed: false},
  ];
  const movies = [{id: '9', title: 'Synthetic Film', created_at: 3000, release_year: 2020, path: '/private/film.ts'}];
  const f = await fixture(t, {extra: {'/api/v1/episodes': episodes, '/api/v1/movies': movies}});
  const r = await fetch(`${f.base}/api/catalog?connectionId=c1&parentId=channels:recent&limit=12`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.items.map(x => x.id), ['file:2', 'movie:9', 'file:1']);
  assert.equal(body.items[0].subtitle, 'Show S'); assert.equal(body.items[0].resumeSeconds, 30); assert.equal(body.items[0].seriesId, 'show:S');
  const text = JSON.stringify(body);
  assert.ok(!text.includes('/private/') && !text.includes('192.0.2'));
  f.c.access = {kinds: ['movie']};
  const movieOnly = await (await fetch(`${f.base}/api/catalog?connectionId=c1&parentId=channels:recent`)).json();
  assert.deepEqual(movieOnly.items.map(x => x.id), ['movie:9'], 'household kind grants filter the mixed list');
});
