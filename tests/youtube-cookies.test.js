import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, statSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createYouTubeResolver, YOUTUBE_GATED_MESSAGES as M } from '../server/youtube.js';

const id = 'JApE9dxTiLk';
const SENTINEL = 'SENTINEL_COOKIE_VALUE_9f3a7c';
const STDERR_SENTINEL = 'SENTINEL_STDERR_TEXT_41bd';
const good = () => ({ stdout: JSON.stringify({ info: { id, url: 'https://test.googlevideo.com/video', vcodec: 'avc1', acodec: 'mp4a' } }) });
const gatedErr = (text) => Object.assign(new Error(`Command failed ${SENTINEL}`), { stderr: `ERROR: [youtube] ${id}: ${text} ${STDERR_SENTINEL} cookie` });
const cookieDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yt-cookie-test-'));
  const file = path.join(dir, 'cookies.txt');
  writeFileSync(file, `# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\t${SENTINEL}\n`);
  return { dir, file };
};
const tmpEntries = () => new Set(readdirSyncSafe());
import { readdirSync } from 'node:fs';
function readdirSyncSafe() { return readdirSync(tmpdir()).filter((n) => n.startsWith('tesplay-yt-')); }

const GATED = {
  members: ['Join this channel to get access to members-only content like this video', 'This video is available to this channel\'s members on level: Gold (or any higher level)', 'members on level: X'],
  age: ['Sign in to confirm your age. This video may be inappropriate for some users.', 'This video is age-restricted'],
  private: ['Private video. Sign in if you\'ve been granted access to this video'],
};
const botText = ['Sign in to confirm you\'re not a bot', 'Sign in to confirm you’re not a bot'];

function silence(t) {
  const logs = [];
  for (const m of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, m, (...a) => logs.push(a.join(' ')));
  return logs;
}
function build(responses, options = {}) {
  const calls = [];
  const run = async (_bin, args, opts) => {
    const call = { args: [...args], opts };
    const i = calls.length;
    const response = responses[Math.min(i, responses.length - 1)];
    if (typeof response === 'function') await response(call, i);
    calls.push(call);
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? good() : response;
  };
  return { calls, resolve: createYouTubeResolver({ enabled: true, resolverUrl: '', run, ...options }) };
}
const noCookieArgs = (args) => !args.includes('--cookies');
const assertClean = (value, ...forbidden) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const f of [SENTINEL, STDERR_SENTINEL, ...forbidden]) assert.ok(!text.toLowerCase().includes(f.toLowerCase()), `leaked ${f}`);
};

test('feature off: exactly one run with today\'s args and no cookie flag', async (t) => {
  silence(t);
  const { calls, resolve } = build([good()]);
  await resolve(id);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 2), ['--ignore-config', '--no-playlist']);
  assert.equal(calls[0].args.at(-2), '--');
  assert.equal(calls[0].args.at(-1), `https://www.youtube.com/watch?v=${id}`);
  assert.ok(noCookieArgs(calls[0].args));
  assert.equal(calls[0].args.length, 20);
});

test('gated failure with cookies feature off yields the fixed 403 needs-cookies message', async (t) => {
  silence(t);
  const { calls, resolve } = build([gatedErr(GATED.members[0])]);
  await assert.rejects(resolve(id), (e) => e.status === 403 && e.message === M.membersNoCookies);
  assert.equal(calls.length, 1);
});

test('cookies configured but anonymous attempt succeeds: one run, no --cookies', async (t) => {
  silence(t);
  const { file, dir } = cookieDir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { calls, resolve } = build([good()], { cookiesFile: file });
  await resolve(id);
  assert.equal(calls.length, 1);
  assert.ok(noCookieArgs(calls[0].args));
});

test('members-only failure retries once with a private 0600 copy that is removed afterwards', async (t) => {
  const logs = silence(t);
  const { file, dir } = cookieDir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = tmpEntries();
  let seen;
  const { calls, resolve } = build([gatedErr(GATED.members[0]), (call) => {
    const i = call.args.indexOf('--cookies');
    const copy = call.args[i + 1];
    seen = { copy, exists: existsSync(copy), mode: statSync(copy).mode & 0o777, body: readFileSync(copy, 'utf8'), dirMode: statSync(path.dirname(copy)).mode & 0o777, beforeSeparator: i < call.args.indexOf('--') };
  }], { cookiesFile: file });
  const result = await resolve(id);
  assert.ok(result.video.url);
  assert.equal(calls.length, 2);
  assert.ok(noCookieArgs(calls[0].args));
  assert.ok(seen.exists); assert.equal(seen.mode, 0o600); assert.equal(seen.dirMode, 0o700);
  assert.ok(seen.beforeSeparator);
  assert.ok(seen.body.includes(SENTINEL));
  assert.notEqual(seen.copy, file);
  assert.ok(!seen.copy.startsWith(dir));
  assert.ok(!existsSync(path.dirname(seen.copy)));
  assert.deepEqual(tmpEntries(), before);
  assert.ok(existsSync(file), 'mounted source is untouched');
  assert.equal(readFileSync(file, 'utf8').includes(SENTINEL), true);
  assertClean(logs.join('\n'), file);
});

test('temp copy is removed when the retry fails, errors unexpectedly, or aborts', async (t) => {
  silence(t);
  const { file, dir } = cookieDir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = tmpEntries();
  for (const second of [gatedErr(GATED.members[0]), new Error('boom'), Object.assign(new Error('aborted'), { name: 'AbortError' })]) {
    const { resolve } = build([gatedErr(GATED.members[0]), second], { cookiesFile: file });
    await assert.rejects(resolve(id));
    assert.deepEqual(tmpEntries(), before);
  }
  const controller = new AbortController();
  const { resolve } = build([gatedErr(GATED.members[0]), (call) => { controller.abort(new Error('client left')); throw new Error('aborted'); }], { cookiesFile: file });
  await assert.rejects(resolve(id, controller.signal), /client left/);
  assert.deepEqual(tmpEntries(), before);
});

test('every gated pattern retries with cookies; refusal after retry is the fixed refresh message', async (t) => {
  silence(t);
  const { file, dir } = cookieDir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [kind, texts] of Object.entries({ ...GATED, bot: botText })) for (const text of texts) {
    const { calls, resolve } = build([gatedErr(text), good()], { cookiesFile: file });
    await resolve(id);
    assert.equal(calls.length, 2, `${kind}: ${text}`);
    assert.ok(calls[1].args.includes('--cookies'));
    const still = build([gatedErr(text)], { cookiesFile: file });
    if (kind === 'bot') await assert.rejects(still.resolve(id), { status: 403 });
    else await assert.rejects(still.resolve(id), (e) => e.status === 403 && e.message === (kind === 'members' ? M.membersRefused : M.signInRefused));
    assert.equal(still.calls.length, 2);
  }
});

test('no-cookie messages per kind; bot check without cookies stays today\'s 502', async (t) => {
  silence(t);
  for (const [kind, texts] of Object.entries(GATED)) {
    const { resolve } = build([gatedErr(texts[0])]);
    await assert.rejects(resolve(id), (e) => e.status === 403 && e.message === (kind === 'members' ? M.membersNoCookies : M.signInNoCookies));
  }
  const { calls, resolve } = build([gatedErr(botText[0])]);
  await assert.rejects(resolve(id), (e) => e.status === 502 && /could not prepare this video/.test(e.message));
  assert.equal(calls.length, 1);
});

test('non-gated failures never retry with cookies and stay a 502', async (t) => {
  silence(t);
  const { file, dir } = cookieDir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const err of [gatedErr('Video unavailable'), gatedErr('HTTP Error 429'), new Error('timeout'), Object.assign(new Error('x'), { stderr: 'ERROR: unable to download' })]) {
    const { calls, resolve } = build([err], { cookiesFile: file });
    await assert.rejects(resolve(id), (e) => e.status === 502);
    assert.equal(calls.length, 1);
  }
});

test('missing or unreadable cookies file: no retry and the fixed needs-cookies 403', async (t) => {
  silence(t);
  const { file, dir } = cookieDir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = path.join(dir, 'nope.txt');
  const targets = [missing];
  if (process.getuid?.() !== 0) { chmodSync(file, 0o000); targets.push(file); }
  const before = tmpEntries();
  for (const cookiesFile of targets) {
    const { calls, resolve } = build([gatedErr(GATED.members[0])], { cookiesFile });
    await assert.rejects(resolve(id), (e) => e.status === 403 && e.message === M.membersNoCookies);
    assert.equal(calls.length, 1);
    assert.deepEqual(tmpEntries(), before);
  }
  chmodSync(file, 0o600);
});

test('cookie contents, path and stderr never reach logs, errors or responses', async (t) => {
  const logs = silence(t);
  const { file, dir } = cookieDir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outcomes = [];
  for (const cookiesFile of [file, '', path.join(dir, 'missing.txt')]) for (const text of [...GATED.members, ...GATED.age, ...botText, 'unrelated failure']) {
    const { resolve } = build([gatedErr(text), gatedErr(text)], { cookiesFile });
    outcomes.push(await resolve(id).then(() => 'ok', (e) => ({ message: e.message, status: e.status, name: e.name, keys: Object.keys(e), cause: e.cause })));
  }
  assertClean(outcomes, file, dir, 'Command failed');
  assertClean(logs.join('\n'), file, dir);
  const okRun = build([gatedErr(GATED.members[0]), good()], { cookiesFile: file });
  assertClean(await okRun.resolve(id), file, dir);
});

test('resolver-URL branch relays only whitelisted 403 messages; others become a generic 502', async (t) => {
  silence(t);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const respond = (status, body) => { globalThis.fetch = async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); };
  const resolve = createYouTubeResolver({ resolverUrl: 'http://youtube:4180' });
  for (const message of Object.values(M)) {
    respond(403, { error: message });
    await assert.rejects(resolve(id), (e) => e.status === 403 && e.message === message);
  }
  for (const body of [{ error: `Secret ${SENTINEL} /run/secrets/youtube/cookies.txt` }, 'not json', { nope: 1 }, { error: M.membersNoCookies + ' extra' }]) {
    respond(403, body);
    await assert.rejects(resolve(id), (e) => e.status === 502 && !e.message.includes(SENTINEL) && !e.message.includes('secrets'));
  }
  respond(429, { error: 'x' });
  await assert.rejects(resolve(id), { status: 429 });
  respond(502, { error: M.membersNoCookies });
  await assert.rejects(resolve(id), (e) => e.status === 502 && e.message !== M.membersNoCookies);
});

test('homelab overlay mounts cookies read-only into youtube only; app block and base compose unchanged; secrets ignored', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const overlay = read('deploy/homelab/compose.homelab.yaml');
  const youtube = overlay.match(/^  youtube:\n[\s\S]*?(?=\n\S|\n  \w|(?![\s\S]))/m)?.[0] ?? '';
  assert.match(youtube, /^      YOUTUBE_COOKIES_FILE: \/run\/secrets\/youtube\/cookies\.txt$/m);
  assert.match(youtube, /^    volumes:\n      - \.\/secrets\/youtube:\/run\/secrets\/youtube:ro$/m);
  const originalApp = '  app:\n    ports: !reset []\n    networks:\n      macvlan_lan:\n        ipv4_address: 10.42.90.44\n        gw_priority: 100\n      default: {}\n';
  const app = overlay.match(/^  app:\n[\s\S]*?(?=\n  \w|\nnetworks:)/m)?.[0];
  assert.equal(app, originalApp);
  assert.ok(!app.includes('secrets'));
  assert.ok(!/YOUTUBE_COOKIES_FILE|secrets\/youtube/.test(read('compose.yaml')));
  const ignore = read('.gitignore').split('\n').map((l) => l.trim());
  assert.ok(ignore.includes('secrets/'), 'secrets/ is gitignored, covering secrets/youtube/cookies.txt');
});
