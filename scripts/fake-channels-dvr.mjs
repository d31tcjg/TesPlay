#!/usr/bin/env node
// Dev-only synthetic Channels DVR for visual checks. Binds to 127.0.0.1, serves invented data only,
// makes no outbound requests, and plays no media.
//   node scripts/fake-channels-dvr.mjs [port]   (default 8189)
import http from 'node:http';

const port = Number(process.argv[2] || process.env.FAKE_CHANNELS_PORT || 8189);
const sources = ['Antenna', 'Cable Lineup', 'Sports Pack'];
const words = ['Harbor', 'Midnight', 'Copper', 'Willow', 'Signal', 'Lantern', 'Summit', 'Orchard', 'Velvet', 'Drift', 'Ember', 'Atlas'];
const nouns = ['News', 'Mysteries', 'Kitchen', 'Rangers', 'Nights', 'Garden', 'Detectives', 'Report', 'Roadshow', 'Classics', 'Academy', 'Live'];
const hash = (...parts) => [...parts.join(':')].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
const pick = (list, seed) => list[seed % list.length];

const channels = Array.from({ length: 40 }, (_, i) => {
  const source = sources[i % 3];
  const number = source === 'Antenna' ? `${4 + i}.${1 + (i % 3)}` : source === 'Cable Lineup' ? String(200 + i * 3) : String(500 + i);
  return { id: `ch${i}`, number, name: `${pick(words, hash('n', i))} ${['TV', 'Network', 'Channel', 'Plus'][i % 4]}`, hd: i % 2 === 0,
    hidden: false, source_id: `src${i % 3}`, source_name: source };
});
channels.push({ id: 'hidden', number: '999', name: 'Hidden Test', hd: false, hidden: true, source_id: 'src0', source_name: 'Antenna' });
const byNumber = new Map(channels.map(c => [c.number, c]));
const sortKey = n => n.split('.').map(Number);
channels.sort((a, b) => { const [x, y] = [sortKey(a.number), sortKey(b.number)]; return x[0] - y[0] || (x[1] || 0) - (y[1] || 0); });

const svg = (label, color, w = 320, h = 180) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="52%" fill="#fff" font-family="sans-serif" font-size="${Math.round(h / 5)}" font-weight="700" text-anchor="middle">${label.replace(/[<&>]/g, '')}</text></svg>`;
const color = seed => `hsl(${seed % 360} 38% 32%)`;
const origin = `http://127.0.0.1:${port}`;

function programs(channel, from, to) {
  // Deterministic programme grid: lengths of 30/60/90 min, anchored to a day boundary so windows line up.
  const day = Math.floor(from / 86400) * 86400 - 86400;
  const list = [];
  let t = day;
  for (let n = 0; t < to; n++) {
    const seed = hash(channel.number, n);
    const minutes = [30, 60, 30, 90, 60][seed % 5];
    const start = t, end = t + minutes * 60;
    t = end;
    if (end <= from) continue;
    const title = `${pick(words, seed)} ${pick(nouns, seed >> 3)}`;
    list.push({
      Channel: channel.number, Time: start, Duration: minutes * 60, Title: title, EpisodeTitle: seed % 3 ? `Episode ${seed % 40 + 1}: ${pick(words, seed >> 5)}` : undefined,
      Summary: `A synthetic ${minutes}-minute programme about ${pick(words, seed >> 2).toLowerCase()} and ${pick(nouns, seed >> 6).toLowerCase()}. ` + 'Invented text for layout checks. '.repeat(1 + seed % 3),
      FullSummary: 'Long invented description. '.repeat(30), Image: `${origin}/img/p${seed % 50}.svg`,
      Genres: [pick(['Drama', 'News', 'Comedy', 'Sports', 'Kids'], seed >> 4)], Categories: [], Tags: [...(seed % 7 === 0 ? ['New'] : []), ...(seed % 11 === 0 ? ['Live'] : []), 'HD 1080i'],
      SeriesID: `SH${seed % 90}`, ProgramID: `PR${seed}`, SeasonNumber: seed % 3 ? 1 + seed % 5 : undefined, EpisodeNumber: seed % 3 ? 1 + seed % 20 : undefined, Raw: { synthetic: true },
    });
  }
  return list;
}
const channelObject = c => ({ ChannelID: c.id, Number: c.number, Name: c.name, CallSign: c.name.replace(/\W/g, '').slice(0, 5).toUpperCase(), DeviceID: 'FAKE', Hidden: c.hidden, Image: `${origin}/img/c${hash(c.number) % 40}.svg`, Station: 'synthetic' });

const nowMs = Date.now();
const shows = Array.from({ length: 14 }, (_, i) => ({ id: i % 5 === 0 ? `Show ${i}` : String(100 + i), name: `${pick(words, hash('s', i))} ${pick(nouns, hash('t', i))}`,
  summary: `Synthetic recorded show number ${i}.`, image_url: `${origin}/img/s${i}.svg`, release_year: 2015 + (i % 9), genres: ['Drama'], categories: [],
  episode_count: 4 + i % 5, number_unwatched: i % 4, favorited: false, last_recorded_at: nowMs - i * 3600e3 * 7, created_at: nowMs - 9e9, updated_at: nowMs }));
let fileId = 1000;
const episodes = shows.flatMap((show, si) => Array.from({ length: show.episode_count }, (_, e) => ({
  id: String(fileId++), show_id: show.id, title: show.name, episode_title: `${pick(words, hash(si, e))} ${pick(nouns, hash(e, si))}`, season_number: 1 + (e > 3 ? 1 : 0), episode_number: 1 + e % 4,
  summary: 'Invented recording summary.', image_url: `${origin}/img/e${(si + e) % 20}.svg`, thumbnail_url: `${origin}/img/e${(si + e) % 20}.svg`, duration: 1800 + (e % 3) * 900,
  playback_time: e === 1 ? 600 : 0, watched: e === 0 && si % 2 === 0, completed: false, processed: true, cancelled: false, corrupted: false, delayed: false, original_air_date: '2024-01-01',
  channel: '9.1', genres: ['Drama'], tags: [], created_at: nowMs - (si * 6 + e) * 3600e3 - 600e3, path: '/synthetic/never/forwarded.ts',
})));
const movies = Array.from({ length: 8 }, (_, i) => ({ id: String(fileId++), title: `${pick(words, hash('m', i))} ${pick(nouns, hash('o', i))}: The Film`, release_year: 1998 + i * 3,
  summary: 'An invented movie.', image_url: `${origin}/img/m${i}.svg`, thumbnail_url: `${origin}/img/m${i}.svg`, duration: 6000 + i * 300, playback_time: 0, watched: false, processed: true,
  cancelled: false, corrupted: false, content_rating: 'PG', created_at: nowMs - i * 5 * 3600e3, genres: ['Drama'], path: '/synthetic/never/film.ts' }));

const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const url = new URL(req.url, origin), p = url.pathname;
  let m;
  if (p === '/status') return json(res, { version: 'fake', features: { dvr: true } });
  if (p === '/api/v1/channels') return json(res, channels);
  if (p === '/devices/ANY/channels') return json(res, channels.map(c => ({ GuideNumber: c.number, GuideName: c.name, Logo: `${origin}/img/c${hash(c.number) % 40}.svg`, HD: c.hd, Hidden: c.hidden })));
  if (p === '/devices/ANY/guide') {
    const time = Number(url.searchParams.get('time')) || Math.floor(Date.now() / 1000), duration = Math.min(Number(url.searchParams.get('duration')) || 10800, 86400);
    return json(res, channels.filter(c => !c.hidden).map(c => ({ Channel: channelObject(c), Airings: programs(c, time, time + duration) })));
  }
  if (p === '/devices/ANY/guide/now') {
    const now = Math.floor(Date.now() / 1000);
    return json(res, channels.filter(c => !c.hidden).map(c => ({ Channel: channelObject(c), Airings: programs(c, now, now + 1).filter(a => a.Time <= now && now < a.Time + a.Duration).slice(0, 1) })));
  }
  if (p === '/api/v1/shows') return json(res, shows);
  if ((m = p.match(/^\/api\/v1\/shows\/(.+)\/episodes$/))) return json(res, episodes.filter(e => e.show_id === decodeURIComponent(m[1])));
  if (p === '/api/v1/episodes') return json(res, episodes);
  if (p === '/api/v1/movies') return json(res, movies);
  if ((m = p.match(/^\/img\/([a-z])(\d+)\.svg$/))) {
    const label = { c: byNumber.size ? 'CH' : '', p: 'Show', s: 'Series', e: 'Ep', m: 'Film' }[m[1]] || 'IMG';
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' });
    return res.end(m[1] === 'c' ? svg(`${label} ${m[2]}`, color(hash(m[0])), 160, 160) : svg(`${label} ${m[2]}`, color(hash(m[0]))));
  }
  res.writeHead(404); res.end('Not found');
}).listen(port, '127.0.0.1', () => console.log(`Fake Channels DVR (synthetic data) on ${origin}`));
