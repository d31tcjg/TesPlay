import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/index.js";
import { createStore } from "../server/store.js";
import {
  createQrChallenges,
  QR_COOKIE,
  QR_LIFETIME_MS,
} from "../server/qr-auth.js";
import { randomToken, validateMediaItem } from "../server/security.js";

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "tesplay-qr-"));
  const instance = await createApp({
    dataDir,
    setupToken: "private-setup-token",
    registerProviders: false,
    quiet: true,
    ...options,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  function client() {
    const cookies = new Map();
    return {
      cookies,
      async request(path, body, { method = "POST", headers = {} } = {}) {
        const response = await fetch(base + path, {
          method,
          headers: {
            cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
            ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
            ...headers,
          },
          ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
        });
        for (const header of response.headers.getSetCookie()) {
          const pair = header.split(";", 1)[0];
          const index = pair.indexOf("=");
          const name = pair.slice(0, index);
          const value = pair.slice(index + 1);
          if (value) cookies.set(name, value);
          else cookies.delete(name);
        }
        return {
          status: response.status,
          data: await response.json(),
          headers: response.headers,
        };
      },
    };
  }
  t.after(async () => {
    instance.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { ...instance, dataDir, client };
}

const ownerDetails = {
  name: "Owner",
  email: "owner@example.com",
  password: "a sufficiently long password",
  setupToken: "private-setup-token",
};

test("rear-screen approval connects the approving phone to exactly that screen with one QR", async t => {
  const f=await fixture(t),screen=f.client(),phone=f.client(),existing=f.client();
  await phone.request('/api/auth/setup',ownerDetails);
  await existing.request('/api/auth/login',{email:ownerDetails.email,password:ownerDetails.password});
  const otherRoom=(await existing.request('/api/remote/screen')).data.roomId;
  const challenge=(await screen.request('/api/auth/qr/init',{remoteScreen:true})).data;
  const token=new URLSearchParams(new URL(challenge.verificationUrl).hash.slice(1)).get('token');
  const details=await phone.request('/api/auth/qr/details',{id:challenge.id,token});
  assert.equal(details.data.remoteScreen,true);
  await phone.request('/api/auth/qr/approve',{id:challenge.id,token});
  assert.equal((await phone.request('/api/auth/status',null,{method:'GET'})).data.deviceMode,'browser');
  const approved=await screen.request('/api/auth/qr/poll',{id:challenge.id});
  assert.equal(approved.status,200);assert.equal(approved.data.auth.deviceMode,'screen');
  const room=(await screen.request('/api/remote/screen')).data.roomId;
  assert.notEqual(room,otherRoom);
  const phoneAuth=(await phone.request('/api/auth/status',null,{method:'GET'})).data;
  assert.equal(phoneAuth.deviceMode,'remote');assert.equal(phoneAuth.remoteRoomId,room);
  assert.equal(phoneAuth.activeProfileId,approved.data.auth.activeProfileId);
  assert.equal((await screen.request('/api/remote/state?roomId='+room,null,{method:'GET'})).data.paired,true);
});

test("revoking the approving phone before QR redemption does not authorize a replacement phone session", async t => {
  const f=await fixture(t),screen=f.client(),phone=f.client();
  await phone.request('/api/auth/setup',ownerDetails);
  const challenge=(await screen.request('/api/auth/qr/init',{remoteScreen:true})).data;
  const token=new URLSearchParams(new URL(challenge.verificationUrl).hash.slice(1)).get('token');
  await phone.request('/api/auth/qr/approve',{id:challenge.id,token});
  await phone.request('/api/auth/logout');
  await phone.request('/api/auth/login',{email:ownerDetails.email,password:ownerDetails.password});
  const approved=await screen.request('/api/auth/qr/poll',{id:challenge.id});
  assert.equal(approved.status,200);
  assert.equal((await phone.request('/api/auth/status',null,{method:'GET'})).data.deviceMode,'browser');
  const room=(await screen.request('/api/remote/screen')).data.roomId;
  assert.equal((await screen.request('/api/remote/state?roomId='+room,null,{method:'GET'})).data.paired,false);
});

test("QR approval requires phone authentication, explicit approval and the original screen cookie", async (t) => {
  const f = await fixture(t, {
    production: true,
    publicUrl: "https://tesplay.example.com",
  });
  const screen = f.client();
  const phone = f.client();
  const stranger = f.client();
  const initial = await screen.request("/api/auth/qr/init");
  assert.equal(initial.status, 201);
  const { id, code, verificationUrl } = initial.data;
  const url = new URL(verificationUrl);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  assert.equal(url.origin, "https://tesplay.example.com");
  assert.equal(url.searchParams.get("approve"), id);
  assert.equal(url.searchParams.has("token"), false);
  assert.match(code, /^\d{6}$/);
  assert.ok(token.length >= 32);
  assert.notEqual(screen.cookies.get(QR_COOKIE), token);
  assert.match(initial.headers.get("set-cookie"), /HttpOnly/);
  assert.match(initial.headers.get("set-cookie"), /SameSite=Strict/);
  assert.match(initial.headers.get("set-cookie"), /Secure/);
  assert.equal(
    (await phone.request("/api/auth/qr/details", { id, token })).status,
    401,
  );
  assert.equal(
    (await phone.request("/api/auth/qr/approve", { id, token })).status,
    401,
  );
  assert.equal(
    (await stranger.request("/api/auth/qr/poll", { id, token })).status,
    403,
  );
  // The approval token cannot substitute for the private browser binding.
  stranger.cookies.set(QR_COOKIE, token);
  assert.equal(
    (await stranger.request("/api/auth/qr/poll", { id })).status,
    403,
  );
  const setup = await phone.request("/api/auth/setup", ownerDetails);
  assert.equal(setup.status, 201);
  const details = await phone.request("/api/auth/qr/details", { id, token });
  assert.equal(details.status, 200);
  assert.equal(details.data.code, code);
  assert.deepEqual((await screen.request("/api/auth/qr/poll", { id })).data, {
    status: "pending",
  });
  assert.equal(
    (await screen.request("/api/auth/status", null, { method: "GET" })).data
      .user,
    null,
  );
  assert.equal(
    (
      await phone.request(
        "/api/auth/qr/approve",
        { id, token },
        {
          headers: { Origin: "https://attacker.example" },
        },
      )
    ).status,
    403,
  );
  assert.equal(
    (await phone.request("/api/auth/qr/approve", { id, token: randomToken() }))
      .status,
    403,
  );
  assert.equal(
    (await phone.request("/api/auth/qr/approve", { id, token })).status,
    200,
  );
  assert.equal(
    (await phone.request("/api/auth/qr/approve", { id, token })).status,
    409,
  );
  assert.equal((await phone.request("/api/auth/qr/poll", { id })).status, 403);
  const signedIn = await screen.request("/api/auth/qr/poll", { id });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.data.status, "approved");
  assert.equal(signedIn.data.auth.user.id, setup.data.user.id);
  assert.equal(signedIn.data.auth.profiles.length, 1);
  assert.ok(screen.cookies.get("aperture_session"));
  assert.notEqual(
    screen.cookies.get("aperture_session"),
    phone.cookies.get("aperture_session"),
  );
  assert.equal(screen.cookies.has(QR_COOKIE), false);
  assert.equal((await screen.request("/api/auth/qr/poll", { id })).status, 410);
  assert.equal(
    (await phone.request("/api/auth/qr/approve", { id, token })).status,
    410,
  );
});

test("QR challenges expire, cancel, replace and redeem at most once with bounded memory", () => {
  let now = 1000;
  const challenges = createQrChallenges({ now: () => now, capacity: 2 });
  const browser = randomToken();
  let challenge = challenges.create(browser);
  assert.throws(() => challenges.cancel(challenge.id, randomToken()), {
    status: 403,
  });
  const replacement = challenges.create(browser, browser);
  assert.throws(() => challenges.details(challenge.id, challenge.token), {
    status: 410,
  });
  challenges.cancel(replacement.id, browser);
  assert.throws(() => challenges.poll(replacement.id, browser), {
    status: 410,
  });
  challenge = challenges.create(browser);
  challenges.approve(challenge.id, challenge.token, "account");
  now += QR_LIFETIME_MS;
  assert.throws(() => challenges.poll(challenge.id, browser), { status: 410 });
  assert.throws(
    () => challenges.approve(challenge.id, challenge.token, "account"),
    { status: 410 },
  );
  challenge = challenges.create(browser);
  challenges.approve(challenge.id, challenge.token, "account");
  assert.deepEqual(challenges.poll(challenge.id, browser), {
    status: "approved",
    userId: "account",
  });
  assert.throws(() => challenges.poll(challenge.id, browser), { status: 410 });
  challenges.create(browser);
  challenges.create(randomToken());
  assert.throws(() => challenges.create(randomToken()), { status: 429 });
  challenges.close();
  assert.doesNotThrow(() => challenges.create(browser));
});

test("QR creation is rate limited and cancellation requires the initiating browser", async (t) => {
  const f = await fixture(t);
  const screen = f.client();
  const stranger = f.client();
  const { data } = await screen.request(
    "/api/auth/qr/init",
    {},
    {
      headers: { Origin: "http://127.0.0.1:5173" },
    },
  );
  assert.equal(new URL(data.verificationUrl).origin, "http://127.0.0.1:5173");
  assert.equal(
    (await stranger.request("/api/auth/qr/cancel", { id: data.id })).status,
    403,
  );
  assert.equal(
    (await screen.request("/api/auth/qr/cancel", { id: data.id })).status,
    200,
  );
  assert.equal(screen.cookies.has(QR_COOKIE), false);
  for (let index = 1; index < 20; index++)
    assert.equal((await screen.request("/api/auth/qr/init")).status, 201);
  assert.equal((await screen.request("/api/auth/qr/init")).status, 429);
});

test("account autoplay preference defaults on, validates input and survives restart", async (t) => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal(
    (
      await client.request(
        "/api/settings",
        { preferences: { autoPlayNext: false } },
        { method: "PATCH" },
      )
    ).status,
    401,
  );
  const { data: auth } = await client.request("/api/auth/setup", ownerDetails);
  assert.deepEqual(
    (await client.request("/api/settings", null, { method: "GET" })).data
      .preferences,
    { autoPlayNext: true },
  );
  for (const preferences of [
    null,
    [],
    {},
    { autoPlayNext: "false" },
    { autoPlayNext: false, unknown: true },
  ])
    assert.equal(
      (
        await client.request(
          "/api/settings",
          { preferences },
          { method: "PATCH" },
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await client.request(
        "/api/settings",
        { preferences: { autoPlayNext: false } },
        {
          method: "PATCH",
          headers: { Origin: "https://attacker.example" },
        },
      )
    ).status,
    403,
  );
  const changed = await client.request(
    "/api/settings",
    { preferences: { autoPlayNext: false } },
    { method: "PATCH" },
  );
  assert.deepEqual(changed.data.preferences, { autoPlayNext: false });
  // A second store represents a subsequent server process reading the saved DB.
  const reopened = createStore({ dataDir: f.dataDir });
  assert.deepEqual(reopened.preferences(auth.user.id), { autoPlayNext: false });
  reopened.close();
});

test("connection editing never returns credentials and blank secret inputs preserve encrypted values", async (t) => {
  const f = await fixture(t);
  const owner = f.client();
  const stranger = f.client();
  const auth = await owner.request("/api/auth/setup", ownerDetails);
  const config = {
    apiKey: "private-key",
    clientId: "public-client-id",
    clientSecret: "private-client-secret",
    refreshToken: "private-refresh-token",
    accessToken: "private-access-token",
    url: "https://example.com/?password=private-password",
    username: "private-username",
    password: "private-password",
    authMode: "oauth",
  };
  const created = await owner.request("/api/connections", {
    type: "youtube",
    name: "My YouTube",
    config,
  });
  const id = created.data.connection.id;
  const path = `/api/connections/${id}/config`;
  assert.equal(
    (await stranger.request(path, null, { method: "GET" })).status,
    401,
  );
  const details = await owner.request(path, null, { method: "GET" });
  assert.deepEqual(details.data.config, {
    clientId: "public-client-id",
    authMode: "oauth",
  });
  assert.equal(JSON.stringify(details.data).includes("private-"), false);
  assert.equal(details.data.connection.authMode, "oauth");
  assert.equal(details.data.connection.oauthAuthorized, true);
  for (const field of Object.keys(config))
    assert.ok(details.data.configuredFields.includes(field));
  assert.equal(
    (
      await owner.request(
        `/api/connections/${id}`,
        {
          config: {
            apiKey: "",
            username: " ",
            password: "",
            url: "",
            refreshToken: "",
            clientSecret: "",
            authMode: "apiKey",
          },
        },
        { method: "PUT" },
      )
    ).status,
    200,
  );
  const stored = f.store.getConnection(auth.data.user.id, id).config;
  assert.deepEqual(stored, { ...config, authMode: "apiKey" });
  assert.equal(
    f.store.db
      .prepare("SELECT encrypted_config FROM connections WHERE id=?")
      .get(id)
      .encrypted_config.includes("private-"),
    false,
  );
  const updated = await owner.request(
    `/api/connections/${id}`,
    { config: { apiKey: "new-private-key" } },
    { method: "PUT" },
  );
  assert.equal(updated.status, 200);
  assert.equal(updated.data.connection.authMode, "apiKey");
  assert.equal(
    f.store.getConnection(auth.data.user.id, id).config.apiKey,
    "new-private-key",
  );
});

test("saved episode metadata remains available for continuing a series", () => {
  const episode = {
    id: "episode-4",
    title: "Episode four",
    source: "Plex",
    type: "episode",
    seriesId: "series-1",
    seasonNumber: 0,
    episodeNumber: 4,
  };
  assert.deepEqual(validateMediaItem(episode), episode);
  for (const seasonNumber of [-1, 0.5, "1", 1_000_001])
    assert.throws(() => validateMediaItem({ ...episode, seasonNumber }), {
      status: 400,
    });
});

test("editing a Google OAuth client clears its tokens while blank secrets and internal refreshes preserve authorization", async (t) => {
  const f = await fixture(t);
  const client = f.client();
  const auth = await client.request("/api/auth/setup", ownerDetails);
  for (const type of ["drive", "youtube"]) {
    const created = await client.request("/api/connections", {
      type,
      name: type,
      config: {
        clientId: "first-client",
        clientSecret: "first-secret",
        authMode: "oauth",
        accessToken: "first-access-token",
        refreshToken: "first-refresh-token",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    const id = created.data.connection.id;
    let changed = await client.request(
      `/api/connections/${id}`,
      {
        config: { clientId: "second-client" },
      },
      { method: "PUT" },
    );
    assert.equal(changed.status, 200);
    let config = f.store.getConnection(auth.data.user.id, id).config;
    assert.equal(config.clientId, "second-client");
    assert.equal(config.accessToken, null);
    assert.equal(config.refreshToken, null);
    assert.equal(config.expiresAt, 0);
    f.store.saveConnection(auth.data.user.id, {
      id,
      config: {
        accessToken: "refreshed-access-token",
        refreshToken: "refreshed-refresh-token",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    changed = await client.request(
      `/api/connections/${id}`,
      {
        config: { clientId: "second-client", clientSecret: "" },
      },
      { method: "PUT" },
    );
    assert.equal(changed.status, 200);
    config = f.store.getConnection(auth.data.user.id, id).config;
    assert.equal(config.clientSecret, "first-secret");
    assert.equal(config.refreshToken, "refreshed-refresh-token");
    assert.equal(config.accessToken, "refreshed-access-token");
    changed = await client.request(
      `/api/connections/${id}`,
      {
        config: { clientSecret: "second-secret" },
      },
      { method: "PUT" },
    );
    assert.equal(changed.status, 200);
    config = f.store.getConnection(auth.data.user.id, id).config;
    assert.equal(config.clientSecret, "second-secret");
    assert.equal(config.accessToken, null);
    assert.equal(config.refreshToken, null);
    assert.equal(config.expiresAt, 0);
  }
});
