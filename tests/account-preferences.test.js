import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/account-preferences.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { AccountPreferencesController, legacyYouTubeShortsKey, legacyYouTubeShortsOwnerKey } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(request, initialStorage = []) {
  const saved = new Map(initialStorage), snapshots = [], errors = [];
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  const controller = new AccountPreferencesController({ request, publish: value => snapshots.push(value), onError: reason => errors.push(reason), storage: () => storage });
  return { controller, saved, snapshots, errors, latest: () => snapshots.at(-1) };
}
const settings = (hideYouTubeShorts, autoPlayNext = true) => ({ preferences: { autoPlayNext, ...(hideYouTubeShorts === undefined ? {} : { hideYouTubeShorts }) } });

test('old reads cannot cross an A to B to A account switch even if requests ignore abort', async () => {
  const requests = [];
  const f = fixture((path, body, method, signal) => {
    const result = deferred(); requests.push({ ...result, signal }); return result.promise;
  });
  f.controller.activate('A'); const oldA = f.controller.load();
  f.controller.activate('B'); const oldB = f.controller.load();
  f.controller.activate('A'); const newA = f.controller.load();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, true);
  requests[2].resolve(settings(true)); await newA;
  requests[0].resolve(settings(false)); requests[1].reject(new Error('old account failed'));
  await Promise.all([oldA, oldB]);
  assert.equal(f.latest().preferences.hideYouTubeShorts, true);
  assert.equal(f.latest().ready, true);
  assert.deepEqual(f.errors, []);
});

test('a pending refresh cannot overwrite a newer save and refresh during a save is skipped', async () => {
  const read = deferred(), write = deferred(); let calls = 0;
  const f = fixture((path, body) => { calls++; return body ? write.promise : read.promise; });
  f.controller.activate('account'); const loading = f.controller.load();
  const saving = f.controller.update({ hideYouTubeShorts: true });
  await f.controller.load(); assert.equal(calls, 2);
  write.resolve(settings(true, false)); await saving;
  read.resolve(settings(false, true)); await loading;
  assert.deepEqual(f.latest(), { preferences: { autoPlayNext: false, hideYouTubeShorts: true }, ready: true, busy: false });
});

test('failed saves retain the confirmed choice and allow a later retry', async () => {
  let fail = true;
  const f = fixture(async (path, body) => {
    if (!body) return settings(false);
    if (fail) throw new Error('save failed');
    return settings(body.preferences.hideYouTubeShorts);
  });
  f.controller.activate('account'); await f.controller.load();
  await f.controller.update({ hideYouTubeShorts: true });
  assert.equal(f.latest().preferences.hideYouTubeShorts, false);
  assert.equal(f.latest().busy, false); assert.equal(f.errors.length, 1);
  fail = false; await f.controller.update({ hideYouTubeShorts: true });
  assert.equal(f.latest().preferences.hideYouTubeShorts, true);
});

test('a delayed save from a previous account does not publish or toast into the new account', async () => {
  const oldSave = deferred();
  const f = fixture(async (path, body) => body ? oldSave.promise : settings(false));
  f.controller.activate('A'); await f.controller.load();
  const saving = f.controller.update({ hideYouTubeShorts: true });
  f.controller.activate('B'); await f.controller.load();
  oldSave.reject(new Error('A failed')); await saving;
  assert.equal(f.latest().preferences.hideYouTubeShorts, false);
  assert.deepEqual(f.errors, []);
});

test('legacy import initializes only unset preferences and trusts a concurrent saved false choice', async () => {
  const writes = [];
  const f = fixture(async (path, body) => {
    if (!body) return settings(undefined, false);
    writes.push(body); return settings(false, false);
  }, [[legacyYouTubeShortsKey, 'false']]);
  f.controller.activate('account'); await f.controller.load();
  assert.deepEqual(writes, [{ preferences: { hideYouTubeShorts: true }, initializeYouTubeShorts: true }]);
  assert.deepEqual(f.latest().preferences, { autoPlayNext: false, hideYouTubeShorts: false });
  assert.equal(f.saved.size, 0);
});

test('failed legacy import stays owned by the first account and retries only for that account', async () => {
  let fail = true; const writes = [];
  const f = fixture(async (path, body) => {
    if (!body) return settings(undefined);
    writes.push(body);
    if (fail) throw new Error('migration failed');
    return settings(body.preferences.hideYouTubeShorts);
  }, [[legacyYouTubeShortsKey, 'false']]);
  f.controller.activate('A'); await f.controller.load();
  assert.equal(f.latest().ready, false);
  assert.equal(f.saved.get(legacyYouTubeShortsKey), 'false');
  assert.equal(f.saved.get(legacyYouTubeShortsOwnerKey), 'A');
  f.controller.activate('B'); await f.controller.load();
  assert.equal(writes.length, 1); assert.equal(f.latest().preferences.hideYouTubeShorts, false);
  fail = false; f.controller.activate('A'); await f.controller.load();
  assert.equal(writes.length, 2); assert.equal(f.latest().preferences.hideYouTubeShorts, true);
  assert.equal(f.saved.size, 0);
});

test('remote sessions read account choices but do not migrate, retire browser data or write', async () => {
  const calls = [];
  const f = fixture(async (path, body) => { calls.push(body); return settings(true); }, [[legacyYouTubeShortsKey, 'true']]);
  f.controller.activate('account', false); await f.controller.load();
  await f.controller.update({ hideYouTubeShorts: false });
  assert.deepEqual(calls, [undefined]);
  assert.equal(f.latest().preferences.hideYouTubeShorts, true);
  assert.equal(f.saved.get(legacyYouTubeShortsKey), 'true');
});

test('saved account choices work with unavailable browser storage and preserve explicit false', async () => {
  const snapshots = [];
  const controller = new AccountPreferencesController({
    request: async (path, body) => settings(body ? body.preferences.hideYouTubeShorts : false),
    publish: value => snapshots.push(value), onError: assert.fail,
    storage: () => { throw new Error('storage denied'); },
  });
  controller.activate('account'); await controller.load();
  assert.equal(snapshots.at(-1).preferences.hideYouTubeShorts, false);
  assert.equal(snapshots.at(-1).ready, true);
  await controller.update({ hideYouTubeShorts: true });
  assert.equal(snapshots.at(-1).preferences.hideYouTubeShorts, true);
});
