import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/index.js";
import { createStore } from '../server/store.js';
import {
  encryptJSON,
  decryptJSON,
  hashPassword,
  verifyPassword,
  hashToken,
} from "../server/security.js";

const password = "correct horse battery staple";
const item = {
  id: "film-1",
  title: "Test film",
  type: "movie",
  source: "Personal media",
  playbackUrl: "https://example.com/movie.mp4",
};

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "aperture-core-"));
  const instance = await createApp({
    dataDir,
    setupToken: "private-one-time-test-token",
    registerProviders: false,
    quiet: true,
    ...options,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  async function request(
    path,
    { method = "GET", body, headers = {}, noCookie = false } = {},
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(noCookie ? {} : { cookie }),
        ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  }
  async function setup() {
    return request("/api/auth/setup", {
      method: "POST",
      body: {
        name: "Riv",
        email: "owner@example.com",
        password,
        setupToken: "private-one-time-test-token",
      },
    });
  }
  t.after(async () => {
    instance.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { ...instance, dataDir, base, request, setup, cookie: () => cookie };
}

test("account settings accept partial boolean choices and reject invalid updates without changing saved values", async t => {
  const f = await fixture(t);
  const patch = body => f.request("/api/settings", {method: "PATCH", body});
  assert.equal((await patch({preferences: {hideYouTubeShorts: true}})).status, 401);
  await f.setup();
  const initial = (await f.request("/api/settings")).data;
  assert.deepEqual(initial.preferences, {autoPlayNext: true});
  for (const [preferences, expected] of [
    [{hideYouTubeShorts: true}, {autoPlayNext: true, hideYouTubeShorts: true}],
    [{autoPlayNext: false}, {autoPlayNext: false, hideYouTubeShorts: true}],
    [{hideYouTubeShorts: false}, {autoPlayNext: false, hideYouTubeShorts: false}],
    [{autoPlayNext: true, hideYouTubeShorts: true}, {autoPlayNext: true, hideYouTubeShorts: true}],
  ]) {
    const response = await patch({preferences});
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, {...initial, preferences: expected});
  }
  const saved = (await f.request("/api/settings")).data;
  const invalid = [
    {}, {preferences: null}, {preferences: []}, {preferences: {}},
    {preferences: {autoPlayNext: 1}}, {preferences: {hideYouTubeShorts: "false"}},
    {preferences: {hideYouTubeShorts: null}},
    {preferences: {hideYouTubeShorts: true, unknown: true}},
    {preferences: {hideYouTubeShorts: true}, unknown: true},
    ...[false, null, "true", 1].map(initializeYouTubeShorts => ({preferences: {hideYouTubeShorts: true}, initializeYouTubeShorts})),
    {preferences: {autoPlayNext: true}, initializeYouTubeShorts: true},
    {preferences: {autoPlayNext: true, hideYouTubeShorts: false}, initializeYouTubeShorts: true},
  ];
  for (const body of invalid) {
    assert.equal((await patch(body)).status, 400, JSON.stringify(body));
    assert.deepEqual((await f.request("/api/settings")).data, saved);
  }
  assert.equal((await f.request("/api/settings", {
    method: "PATCH", body: {preferences: {hideYouTubeShorts: false}},
    headers: {origin: "https://untrusted.example"},
  })).status, 403);
  assert.deepEqual((await f.request("/api/settings")).data, saved);
});

test("legacy Shorts initialization confirms one saved choice across competing browsers and preserves explicit false", async t => {
  const f = await fixture(t);
  await f.setup();
  const initialize = hideYouTubeShorts => f.request("/api/settings", {
    method: "PATCH", body: {preferences: {hideYouTubeShorts}, initializeYouTubeShorts: true},
  });
  const results = await Promise.all([initialize(true), initialize(false)]);
  for (const result of results) assert.equal(result.status, 200);
  assert.deepEqual(results[0].data.preferences, results[1].data.preferences);
  assert.equal(typeof results[0].data.preferences.hideYouTubeShorts, "boolean");
  assert.equal(results[0].data.preferences.autoPlayNext, true);
  await f.request("/api/settings", {method: "PATCH", body: {preferences: {autoPlayNext: false, hideYouTubeShorts: false}}});
  assert.deepEqual((await initialize(true)).data.preferences, {autoPlayNext: false, hideYouTubeShorts: false});
  assert.deepEqual((await f.request("/api/settings")).data.preferences, {autoPlayNext: false, hideYouTubeShorts: false});
});

test("opt-in screen checks record only display readings and reject invalid or cross-site reports", async t => {
  const reports = [];
  const {request} = await fixture(t, {onScreenCheck: report => reports.push(report)});
  const body = {userAgent:"QtCarBrowser",width:837,height:523,pixelRatio:1.53,viewportWidth:837,viewportHeight:500,cookie:"private",url:"private",accountId:"private"};
  const response = await request("/api/screen-check", {method:"POST",body});
  assert.equal(response.status,200);
  assert.equal(reports.length,1);
  assert.equal(reports[0].id,response.data.id);
  assert.equal(reports[0].width,837);
  assert.equal(reports[0].pixelRatio,1.53);
  for (const field of ["cookie","url","accountId"]) assert.equal(field in reports[0],false);
  for (const change of [{pixelRatio:0},{width:"1280"},{height:-1},{userAgent:"x".repeat(1025)}]) {
    assert.equal((await request("/api/screen-check", {method:"POST",body:{...body,...change}})).status,400);
  }
  assert.equal((await request("/api/screen-check", {method:"POST",body,headers:{origin:"https://untrusted.example"}})).status,403);
  assert.equal(reports.length,1);
});

test("password derivation and encryption reject incorrect credentials and tampering", async () => {
  const hashed = await hashPassword(password);
  assert.notEqual(hashed, password);
  assert.equal(await verifyPassword(password, hashed), true);
  assert.equal(await verifyPassword("wrong password", hashed), false);
  assert.equal(await verifyPassword(password, "malformed"), false);
  const key = Buffer.alloc(32, 7);
  const encrypted = encryptJSON(
    { token: "secret-value" },
    key,
    "owner:connection",
  );
  assert.deepEqual(decryptJSON(encrypted, key, "owner:connection"), {
    token: "secret-value",
  });
  assert.throws(() => decryptJSON(encrypted, key, "another-owner:connection"));
  const changed = Buffer.from(encrypted, "base64");
  changed[changed.length - 1] ^= 1;
  assert.throws(() =>
    decryptJSON(changed.toString("base64"), key, "owner:connection"),
  );
});

test("setup is token protected, single owner only, and sessions are opaque and revocable", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/health")).status, 200);
  assert.equal((await f.request("/api/auth/status")).data.setupRequired, true);
  assert.equal((await f.request("/api/connections")).status, 401);
  const wrongToken = await f.request("/api/auth/setup", {
    method: "POST",
    body: {
      name: "Riv",
      email: "owner@example.com",
      password,
      setupToken: "wrong",
    },
  });
  assert.equal(wrongToken.status, 403);
  const signedIn = await f.setup();
  assert.equal(signedIn.status, 201);
  assert.equal(signedIn.data.profiles.length, 1);
  assert.equal(signedIn.data.user.email, "owner@example.com");
  assert.match(signedIn.headers.get("set-cookie"), /HttpOnly/);
  assert.match(signedIn.headers.get("set-cookie"), /SameSite=Lax/);
  const sessionToken = f.cookie().split("=")[1];
  const storedSession = f.store.db
    .prepare("SELECT token_hash FROM sessions")
    .get();
  assert.equal(storedSession.token_hash, hashToken(sessionToken));
  assert.notEqual(storedSession.token_hash, sessionToken);
  assert.equal((await f.setup()).status, 409);
  assert.equal(
    (await f.request("/api/auth/logout", { method: "POST" })).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/connections", {
        headers: { cookie: `aperture_session=${sessionToken}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        method: "POST",
        body: { email: "owner@example.com", password: "wrong" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        method: "POST",
        body: { email: "OWNER@example.com", password },
      })
    ).status,
    200,
  );
});

test("cross-origin JSON and form mutations fail; HTTPS produces secure cookies", async (t) => {
  const f = await fixture(t, {
    production: true,
    publicUrl: "https://media.example.com",
  });
  const setup = await f.setup();
  assert.match(setup.headers.get("set-cookie"), /Secure/);
  const denied = await f.request("/api/profiles", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
    body: { name: "bad" },
  });
  assert.equal(denied.status, 403);
  assert.equal(
    (
      await f.request("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: { name: "bad" },
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await f.request("/api/profiles", {
        method: "POST",
        headers: { origin: "https://media.example.com" },
        body: { name: "Good" },
      })
    ).status,
    201,
  );
  assert.equal((await f.request("/api/profiles")).data.profiles.length, 2);
});

test("credentials remain encrypted and connection writes preserve existing secrets", async (t) => {
  const f = await fixture(t);
  const signedIn = await f.setup();
  const result = await f.request("/api/connections", {
    method: "POST",
    body: {
      type: "xtream",
      name: "Home IPTV",
      config: {
        url: "https://media.example.com",
        username: "private-user",
        password: "super-private-password",
      },
    },
  });
  assert.equal(result.status, 201);
  const connection = result.data.connection;
  assert.equal(connection.config, undefined);
  assert.equal(
    JSON.stringify(result.data).includes("super-private-password"),
    false,
  );
  const encrypted = f.store.db
    .prepare("SELECT encrypted_config FROM connections WHERE id=?")
    .get(connection.id).encrypted_config;
  assert.equal(encrypted.includes("super-private-password"), false);
  assert.equal(
    f.store.getConnection(signedIn.data.user.id, connection.id).config.password,
    "super-private-password",
  );
  assert.throws(() => f.store.getConnection("other-account", connection.id), {
    status: 404,
  });
  const updated = await f.request(`/api/connections/${connection.id}`, {
    method: "PUT",
    body: { name: "Renamed", config: { username: "updated-user" } },
  });
  assert.equal(updated.status, 200);
  assert.equal(
    f.store.getConnection(signedIn.data.user.id, connection.id).config.password,
    "super-private-password",
  );
  assert.equal(
    f.store.getConnection(signedIn.data.user.id, connection.id).config.username,
    "updated-user",
  );
  assert.equal(
    (
      await f.request("/api/connections", {
        method: "POST",
        body: { type: "unknown", config: {} },
      })
    ).status,
    400,
  );
  const key = await readFile(join(f.dataDir, "encryption.key"));
  assert.equal(key.length, 32);
});

test("favorites and continue watching are isolated by profile and survive switching", async (t) => {
  const f = await fixture(t);
  const initial = await f.setup();
  const firstProfile = initial.data.activeProfileId;
  assert.equal(
    (
      await f.request("/api/library/favorites", {
        method: "POST",
        body: { item },
      })
    ).data.favorites.length,
    1,
  );
  assert.equal(
    (
      await f.request("/api/library/progress", {
        method: "POST",
        body: { item, seconds: 123, duration: 900 },
      })
    ).status,
    200,
  );
  const created = await f.request("/api/profiles", {
    method: "POST",
    body: { name: "Passenger", color: "#aabbcc" },
  });
  const secondProfile = created.data.profiles.find(
    (profile) => profile.id !== firstProfile,
  ).id;
  await f.request(`/api/profiles/${secondProfile}/select`, { method: "POST" });
  assert.deepEqual((await f.request("/api/library/state")).data, {
    favorites: [],
    progress: [],
    stars: [],
    queue: [],
  });
  assert.equal(
    (
      await f.request("/api/library/progress", {
        method: "POST",
        body: { item, seconds: 130, duration: 900, profileId: firstProfile },
      })
    ).status,
    409,
  );
  assert.deepEqual((await f.request("/api/library/state")).data, {
    favorites: [],
    progress: [],
    stars: [],
    queue: [],
  });
  await f.request(`/api/profiles/${firstProfile}/select`, { method: "POST" });
  const state = (await f.request("/api/library/state")).data;
  assert.equal(state.favorites[0].id, item.id);
  assert.equal(state.progress[0].seconds, 123);
  assert.equal(
    (
      await f.request("/api/library/progress", {
        method: "POST",
        body: { item, seconds: 1000, duration: 90 },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/library/favorites", {
        method: "POST",
        body: { item: { ...item, playbackUrl: "javascript:alert(1)" } },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/library/favorites", {
        method: "POST",
        body: { item: { ...item, connectionId: "someone-elses-connection" } },
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.request(`/api/profiles/${firstProfile}`, { method: "DELETE" }))
      .status,
    200,
  );
  assert.equal(
    (await f.request("/api/auth/status")).data.activeProfileId,
    secondProfile,
  );
  assert.equal(
    (await f.request(`/api/profiles/${secondProfile}`, { method: "DELETE" }))
      .status,
    400,
  );
});

test("phone pairing is account authenticated, single use, and validates remote commands", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request("/api/remote/pair", { method: "POST" })).status,
    401,
  );
  await f.setup();
  const pair = (await f.request("/api/remote/pair", { method: "POST" })).data;
  assert.match(pair.code, /^\d{6}$/);
  assert.equal(
    (
      await f.request("/api/remote/command", {
        method: "POST",
        body: { roomId: pair.roomId, command: "play" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request("/api/remote/join", {
        method: "POST",
        body: { code: "000000" },
      })
    ).status,
    404,
  );
  const joined = await f.request("/api/remote/join", {
    method: "POST",
    body: { code: pair.code },
  });
  assert.equal(joined.data.roomId, pair.roomId);
  assert.equal(
    (
      await f.request("/api/remote/join", {
        method: "POST",
        body: { code: pair.code },
      })
    ).status,
    404,
  );
  const controller = new AbortController();
  const response = await fetch(
    `${f.base}/api/remote/events?roomId=${pair.roomId}`,
    { headers: { cookie: f.cookie() }, signal: controller.signal },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /event: ready/);
  assert.equal(
    (
      await f.request("/api/remote/command", {
        method: "POST",
        body: { roomId: pair.roomId, command: "volume", value: 5 },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/remote/command", {
        method: "POST",
        body: { roomId: pair.roomId, command: "volume", value: 0.5 },
      })
    ).status,
    200,
  );
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /data:/);
  assert.match(event, /"value":0.5/);
  controller.abort();
  await reader.cancel().catch(() => {});
});

test("saved account, session, credentials and profile progress survive a server restart", async (t) => {
  const { createStore } = await import("../server/store.js");
  const dataDir = await mkdtemp(join(tmpdir(), "aperture-restart-"));
  let store = createStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const owner = store.createOwner({
    name: "Owner",
    email: "owner@example.com",
    passwordHash: await hashPassword(password),
  });
  const token = "long-session-token-for-persistence-testing";
  const session = store.createSession(owner.id, token);
  const connection = store.saveConnection(owner.id, {
    type: "plex",
    name: "My Plex",
    config: { token: "persistent-private-token" },
  });
  store.saveProgress(session.profileId, item, 120, 900);
  const artwork = {
    userId: owner.id,
    profileId: session.profileId,
    url: "https://provider.example/art",
    headers: { Authorization: "Bearer private-secret" },
  };
  const sealedArtwork = store.sealMedia(artwork);
  assert.equal(sealedArtwork.includes("private-secret"), false);
  assert.throws(() => store.openMedia("invalid-reference"), { status: 404 });
  store.close();
  store = createStore({ dataDir });
  assert.equal(store.setupRequired(), false);
  assert.deepEqual(store.openMedia(sealedArtwork), artwork);
  assert.equal(store.getSession(token).user.id, owner.id);
  assert.equal(
    store.getConnection(owner.id, connection.id).config.token,
    "persistent-private-token",
  );
  assert.equal(store.libraryState(session.profileId).progress[0].seconds, 120);
  store.db.prepare("UPDATE sessions SET expires_at=0").run();
  assert.equal(store.getSession(token), null);
});

test("M3U imports accept large playlists while enforcing content and ordinary settings limits", async (t) => {
  const f = await fixture(t);
  const signedIn = await f.setup();
  const playlist =
    "#EXTM3U\n" +
    Array.from(
      { length: 2000 },
      (_, n) => `#EXTINF:-1,Channel ${n}\nhttps://streams.example/${n}.m3u8\n`,
    ).join("");
  assert.ok(Buffer.byteLength(playlist) > 64 * 1024);
  const saved = await f.request("/api/connections", {
    method: "POST",
    body: {
      type: "m3u",
      name: "Large playlist",
      config: { content: playlist },
    },
  });
  assert.equal(saved.status, 201);
  assert.equal(
    f.store.getConnection(signedIn.data.user.id, saved.data.connection.id)
      .config.content,
    playlist,
  );
  const excessive = "x".repeat(20 * 1024 * 1024 + 1);
  assert.equal(
    (
      await f.request("/api/connections", {
        method: "POST",
        body: { type: "m3u", config: { content: excessive } },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/connections", {
        method: "POST",
        body: { type: "plex", config: { content: playlist } },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/connections", {
        method: "POST",
        body: {
          type: "m3u",
          config: { content: "#EXTM3U", other: "x".repeat(24001) },
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/connections", {
        method: "POST",
        noCookie: true,
        body: { type: "m3u", config: { content: playlist } },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/profiles", {
        method: "POST",
        body: { name: "x".repeat(70 * 1024) },
      })
    ).status,
    413,
  );
});

test("blank setup token configuration generates a secret and never permits tokenless setup", async (t) => {
  const priorSetupToken = process.env.SETUP_TOKEN;
  t.after(() => {
    if (priorSetupToken === undefined) delete process.env.SETUP_TOKEN;
    else process.env.SETUP_TOKEN = priorSetupToken;
  });
  let previousGenerated;
  for (const [environment, option] of [
    ["", undefined],
    ["   ", " \t "],
  ]) {
    process.env.SETUP_TOKEN = environment;
    const f = await fixture(t, { setupToken: option, encryptionKey: "" });
    assert.match(f.setupToken, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(f.setupToken, previousGenerated);
    previousGenerated = f.setupToken;
    const details = { name: "Owner", email: "owner@example.com", password };
    assert.equal(
      (await f.request("/api/auth/setup", { method: "POST", body: details }))
        .status,
      403,
    );
    assert.equal(
      (
        await f.request("/api/auth/setup", {
          method: "POST",
          body: { ...details, setupToken: "" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request("/api/auth/setup", {
          method: "POST",
          body: { ...details, setupToken: "   " },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request("/api/auth/setup", {
          method: "POST",
          body: { ...details, setupToken: f.setupToken },
        })
      ).status,
      201,
    );
    assert.equal(
      (await readFile(join(f.dataDir, "encryption.key"))).length,
      32,
    );
  }
});

test("production serves SPA entry and assets beneath hidden ancestors with canvas-compatible CSP and referrer policy", async (t) => {
  const hiddenDir = await mkdtemp(join(tmpdir(), ".aperture-static-"));
  const distDir = join(hiddenDir, "dist");
  await mkdir(join(distDir, "assets"), { recursive: true });
  await writeFile(
    join(distDir, "index.html"),
    "<!doctype html><main>Aperture static smoke</main>",
  );
  await writeFile(
    join(distDir, "assets", "entry.js"),
    "window.aperture = true;",
  );
  t.after(() => rm(hiddenDir, { recursive: true, force: true }));
  const f = await fixture(t, { production: true, distDir });
  for (const route of ["/", "/your-library"]) {
    const response = await fetch(f.base + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.equal(
      response.headers.get("referrer-policy"),
      "strict-origin-when-cross-origin",
    );
    assert.match(
      response.headers.get("content-security-policy"),
      /script-src 'self' blob: 'wasm-unsafe-eval' https:\/\/static\.cloudflareinsights\.com 'nonce-[^']+';/,
    );
    assert.match(response.headers.get('content-security-policy'), /frame-src 'none'/);
    assert.match(await response.text(), /Aperture static smoke/);
  }
  const asset = await fetch(f.base + "/assets/entry.js");
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "window.aperture = true;");
});

test('Cinema telemetry belongs to the paired screen and only exposes display fields', async t => {
  const f=await fixture(t); await f.setup(); const hostCookie=f.cookie();
  const pair=(await f.request('/api/remote/pair',{method:'POST'})).data;
  await f.request('/api/auth/login',{method:'POST',noCookie:true,body:{email:'owner@example.com',password}});
  assert.notEqual(f.cookie(),hostCookie);
  assert.equal((await f.request('/api/remote/join',{method:'POST',body:{code:pair.code}})).status,200);
  const controller=new AbortController();
  const screen=await fetch(`${f.base}/api/remote/events?roomId=${pair.roomId}`,{headers:{cookie:hostCookie},signal:controller.signal});
  const reader=screen.body.getReader();await reader.read();
  const state={phase:'playing',positionSeconds:37,durationSeconds:900,seekableStartSeconds:0,seekableEndSeconds:900,volume:0.6,playbackRate:1,muted:false,isLive:false,needsAudioUnlock:false,fullscreen:false,subtitlesAvailable:true,subtitlesEnabled:false};
  const body={roomId:pair.roomId,item,state};
  assert.equal((await f.request('/api/remote/state',{method:'POST',body})).status,403);
  assert.equal((await f.request('/api/remote/state',{method:'POST',body,headers:{cookie:hostCookie}})).status,200);
  const status=await f.request(`/api/remote/state?roomId=${pair.roomId}`);
  assert.equal(status.data.online,true);assert.equal(status.data.state.positionSeconds,37);
  assert.equal(status.data.state.item.title,item.title);assert.equal('playbackUrl' in status.data.state.item,false);
  assert.equal(status.headers.get('cache-control'),'no-store');
  assert.equal((await f.request('/api/remote/state',{method:'POST',body:{...body,state:{...state,fullscreenLocked:true}},headers:{cookie:hostCookie}})).status,200);
  assert.equal((await f.request(`/api/remote/state?roomId=${pair.roomId}`)).data.state.fullscreenLocked,true);
  assert.equal((await f.request('/api/remote/state',{method:'POST',body:{...body,state:{...state,fullscreenLocked:'yes'}},headers:{cookie:hostCookie}})).status,400);
  assert.equal((await f.request('/api/remote/state',{method:'POST',body:{...body,state:{...state,volume:2}},headers:{cookie:hostCookie}})).status,400);
  assert.equal((await f.request('/api/remote/state',{method:'POST',body:{...body,state:{...state,playbackRate:0}},headers:{cookie:hostCookie}})).status,400);
  assert.equal((await f.request(`/api/remote/state?roomId=${pair.roomId}`,{noCookie:true})).status,401);
  const forbiddenEvents=await f.request(`/api/remote/events?roomId=${pair.roomId}`);assert.equal(forbiddenEvents.status,403);
  for(const [command,value] of [['seek-to',45],['mute',1],['rate',1.5],['captions',undefined],['queue-changed',undefined]]){
    assert.equal((await f.request('/api/remote/command',{method:'POST',body:{roomId:pair.roomId,command,value}})).status,200);
    const event=new TextDecoder().decode((await reader.read()).value);assert.match(event,new RegExp(`"command":"${command}"`));
  }
  for(const [command,value] of [['seek-to',-1],['mute',2],['rate',3]])assert.equal((await f.request('/api/remote/command',{method:'POST',body:{roomId:pair.roomId,command,value}})).status,400);
  controller.abort();await reader.cancel().catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal((await f.request(`/api/remote/state?roomId=${pair.roomId}`)).data.online,false);
  assert.equal((await f.request('/api/remote/command',{method:'POST',body:{roomId:pair.roomId,command:'play'}})).status,409);
});

test('Cinema queue accepts playable owned titles and rejects folders or unowned connections',async t=>{
  const f=await fixture(t);await f.setup();
  assert.equal((await f.request('/api/library/queue',{method:'POST',body:{action:'add',item}})).status,200);
  const library=(await f.request('/api/library/state')).data;assert.equal(library.queue[0].title,item.title);
  assert.equal((await f.request('/api/library/queue',{method:'POST',body:{action:'add',item:{...item,type:'folder'}}})).status,400);
  assert.equal((await f.request('/api/library/queue',{method:'POST',body:{action:'add',item:{...item,connectionId:'not-owned'}}})).status,404);
  assert.equal((await f.request('/api/library/queue',{method:'POST',body:{action:'remove',item}})).data.queue.length,0);
});

test('signup validates and saves playback defaults, and settings updates preserve other choices across restarts', async t => {
  const f=await fixture(t);
  const body={name:'Viewer',username:'viewer',password,setupToken:'private-one-time-test-token'};
  assert.equal((await f.request('/api/auth/setup',{method:'POST',body:{...body,playbackDefaults:{audioLanguage:'invalid language'}}})).status,400);
  assert.equal((await f.request('/api/auth/status')).data.setupRequired,true);
  const defaults={audioLanguage:'nl',subtitleLanguage:'en',subtitlesEnabled:true,qualityId:'720p'};
  const created=await f.request('/api/auth/setup',{method:'POST',body:{...body,playbackDefaults:defaults}});
  assert.equal(created.status,201);
  assert.deepEqual((await f.request('/api/player/preferences')).data,defaults);
  assert.equal((await f.request('/api/player/preferences',{method:'PATCH',body:{qualityId:'1080p'}})).status,200);
  assert.equal((await f.request('/api/player/preferences',{method:'PATCH',body:{subtitleLanguage:'nl',subtitlesEnabled:false}})).status,200);
  const expected={...defaults,qualityId:'1080p',subtitleLanguage:'nl',subtitlesEnabled:false};
  assert.deepEqual((await f.request('/api/player/preferences')).data,expected);
  for(const invalid of [{},{qualityId:'4k'},{audioLanguage:12},{subtitlesEnabled:'true'},{subtitleLanguage:'bad language'},{unknown:true},[]])
    assert.equal((await f.request('/api/player/preferences',{method:'PATCH',body:invalid})).status,400);
  const reopened=createStore({dataDir:f.dataDir});
  try { assert.deepEqual(reopened.playerPreferences(created.data.user.id,created.data.activeProfileId),expected); }
  finally { reopened.close(); }
});
