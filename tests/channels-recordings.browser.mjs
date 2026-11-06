// Run: node tests/channels-recordings.browser.mjs [screenshot-dir]
// Real catalog route (registerProviderRoutes) + real React components in Chrome, fed by the synthetic fake-DVR data
// (scripts/fake-channels-dvr.mjs, ~370 recordings, shuffled created_at). No network, credentials, real DVR or playback.
process.env.FAKE_CHANNELS_HOST = '192.0.2.10'; process.env.FAKE_CHANNELS_PORT = '8089';
import express from 'express';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerProviderRoutes } from '../server/providers.js';
// Dynamic import: the fake DVR reads its origin from the environment above when first evaluated.
const { episodes, movies, png, hash } = await import('../scripts/fake-channels-dvr.mjs');

const out = resolve(process.argv[2] || 'docs/screenshots/channels-recordings');
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'recordings-chrome-'));

// ---- API: the real provider routes with the fake DVR as the injected remote ----
const c = { id: 'c1', name: 'Synthetic DVR', type: 'channels', config: { url: 'http://192.0.2.10:8089' } };
const app = express();
app.use((req, _res, next) => { req.user = { id: 'owner' }; req.profile = 'p1'; req.session = { id: 'session' }; next(); });
app.get('/api/media/:token', (req, res) => { res.type('png').send(png(hash(req.params.token), 320, 180)); });
const ctx = { getProfileId: () => 'p1', getConnection: () => c, canAccess: () => true, assertAccess: () => {}, saveConnection: () => ({}), getManagedConnection: () => c };
registerProviderRoutes(app, ctx, { remoteData: async input => {
  const p = new URL(input).pathname;
  if (p === '/api/v1/episodes') return structuredClone(episodes);
  if (p === '/api/v1/movies') return structuredClone(movies);
  return [];
} });
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
const api = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

// Expected order, computed independently of the server code.
const usable = x => !x.cancelled && !x.corrupted && x.processed !== false;
const expected = [...episodes.filter(usable).map(x => ({ id: x.id, t: x.created_at, title: x.episode_title || x.title })), ...movies.filter(usable).map(x => ({ id: x.id, t: x.created_at, title: x.title }))]
  .sort((a, b) => b.t - a.t || Number(b.id) - Number(a.id));

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0] + 'tests/fixtures/channels-recordings.html';
const chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
const results = [], failures = [];
let ws;
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) { port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then(s => s.split('\n')[0]).catch(() => null); if (!port) await delay(100); }
  if (!port) throw new Error('Chrome did not start');
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
  const send = async (method, params = {}) => {
    const response = await new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result;
  };
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const waitFor = async (expression, label) => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(100); } throw new Error(`Timed out: ${label}`); };
  const shot = async name => { const s = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const rows = `[...document.querySelectorAll('.cr-row')].map(r => ({ title: r.querySelector('.cr-title').textContent, at: r.querySelector('time')?.dateTime, sub: r.querySelector('.cr-subtitle')?.textContent || '' }))`;
  const toEnd = `document.querySelector('.cr-sentinel').scrollIntoView({ block: 'end' })`;
  const loadAllPages = async (label, want) => {
    await evaluate(toEnd); await waitFor(`document.querySelectorAll('.cr-row').length >= ${want}`, `${label} page 2`);
    await delay(200);
  };
  const verifyOrder = (label, got, count) => {
    check(got.length >= count, `${label}: ${got.length} rows, wanted at least ${count}`);
    const bad = got.findIndex((r, i) => r.title !== expected[i]?.title);
    check(bad < 0, `${label}: row titles follow newest-first order (first difference at ${bad}: got "${got[bad]?.title}", expected "${expected[bad]?.title}")`);
    const times = got.map(r => Date.parse(r.at));
    check(times.every((t, i) => i === 0 || t <= times[i - 1]), `${label}: recorded times are descending`);
    check(Math.abs(times[0] - expected[0].t) < 1000, `${label}: first row is the newest recording`);
  };

  for (const [width, height] of [[1920, 1200], [1280, 720], [390, 844]]) {
    const label = `${width}x${height}`, phone = width < 700, r = { viewport: label };
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: phone });
    await send('Page.navigate', { url: base });
    await waitFor(`document.querySelectorAll('.cr-row').length > 0`, `${label} first page`);
    await delay(500);
    const first = await evaluate(rows);
    r.firstPage = first.length;
    check(first.length === 60, `${label}: first page has 60 rows (got ${first.length})`);
    verifyOrder(`${label} page 1`, first, 60);
    check(await evaluate(`document.querySelectorAll('.cr-thumb img').length > 30`), `${label}: thumbnails load as images`);
    check(await evaluate(`!document.querySelector('.pagination')`), `${label}: no page buttons`);
    check(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), `${label}: no horizontal overflow`);
    check(await evaluate(`!!document.querySelector('.cr-row .cr-progress') && !!document.querySelector('.cr-row .cr-check') && !!document.querySelector('.cr-row .cr-channel') && !!document.querySelector('.cr-row .cr-subtitle')`), `${label}: rows show progress, watched check, channel and show subtitle`);
    await shot(`${label}-recordings-top`);
    await loadAllPages(label, 61);
    await evaluate(`window.scrollTo(0, 0)`); await evaluate(`document.querySelectorAll('.cr-row')[${phone ? 64 : 66}].scrollIntoView({ block: 'center' })`); await delay(300);
    const after = await evaluate(rows);
    r.afterScroll = after.length;
    verifyOrder(`${label} after page 2`, after, 61);
    check(new Set(after.map(x => x.title + x.at)).size >= after.length - 5, `${label}: no repeated rows after page 2`);
    await shot(`${label}-recordings-after-page-2`);
    // Keep scrolling: the whole list arrives, still in order, and loading stops at the end.
    for (let i = 0; i < 12; i++) { await evaluate(toEnd); await delay(250); }
    const all = await evaluate(rows);
    r.total = all.length;
    check(all.length === expected.length, `${label}: all ${expected.length} recordings load (got ${all.length})`);
    verifyOrder(`${label} complete`, all, expected.length);
    results.push(r);
  }

  // Phone Remote: the Recordings chip opens the list directly (not the folder picker).
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: base + '?mode=remote' });
  await waitFor(`!![...document.querySelectorAll('.cg-chip')].find(b => b.textContent === 'Recordings')`, 'phone chips');
  await evaluate(`[...document.querySelectorAll('.cg-chip')].find(b => b.textContent === 'Recordings').click()`);
  await waitFor(`document.querySelectorAll('.cr-row').length > 0`, 'phone recordings');
  await delay(500);
  const phone = await evaluate(`({ rows: document.querySelectorAll('.cr-row').length, folderCards: document.querySelectorAll('.media-card').length, overflow: document.documentElement.scrollWidth > innerWidth, pressed: [...document.querySelectorAll('.cg-chip')].find(b => b.textContent === 'Recordings').getAttribute('aria-pressed') })`);
  check(phone.rows === 60 && phone.folderCards === 0 && !phone.overflow && phone.pressed === 'true', `phone chip opens the list directly: ${JSON.stringify(phone)}`);
  verifyOrder('phone chip', await evaluate(rows), 60);
  await shot('390x844-recordings-chip');
  await evaluate(`document.querySelector('.remote-library').scrollTop = 0`);
  results.push({ phoneChip: phone });

  await writeFile(join(out, 'results.json'), JSON.stringify({ expectedTotal: expected.length, results, failures }, null, 2));
  console.log(JSON.stringify({ expectedTotal: expected.length, results, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  ws?.close(); chrome.kill();
  await new Promise(r => chrome.exitCode !== null ? r() : chrome.once('exit', r));
  await server.close(); api.close(); await rm(profile, { recursive: true, force: true });
}
