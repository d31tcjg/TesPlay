import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createApp } from "../server/index.js";
import {
  MAX_PHONE_VIDEO_BYTES,
  UPLOAD_CHUNK_BYTES,
} from "../server/remote-media.js";

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "tesplay-remote-media-"));
  const instance = await createApp({
    dataDir,
    setupToken: "test-remote-video-setup",
    quiet: true,
    registerProviders: false,
    ...options,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controllers = [];
  function browser() {
    let cookie = "";
    return {
      async fetch(
        path,
        {
          body,
          method = body === undefined ? "GET" : "POST",
          raw,
          headers = {},
          signal,
        } = {},
      ) {
        const response = await fetch(base + path, {
          method,
          signal,
          headers: {
            cookie,
            ...(raw
              ? { "Content-Type": "application/octet-stream" }
              : !["GET", "HEAD"].includes(method)
                ? { "Content-Type": "application/json" }
                : {}),
            ...headers,
          },
          body:
            raw ||
            (["GET", "HEAD"].includes(method)
              ? undefined
              : JSON.stringify(body || {})),
        });
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) cookie = setCookie.split(";")[0];
        return response;
      },
      async request(path, options) {
        const response = await this.fetch(path, options);
        return { status: response.status, data: await response.json() };
      },
    };
  }
  const screen = browser();
  async function pair(host = screen) {
    const challenge = await host.request("/api/remote/pair", { body: {} });
    assert.equal(challenge.status, 200);
    const { code, token, roomId } = challenge.data;
    const phone = browser();
    assert.equal(
      (
        await phone.request("/api/auth/remote/redeem", {
          body: { code, token },
        })
      ).status,
      200,
    );
    const controller = new AbortController();
    controllers.push(controller);
    const events = await host.fetch(`/api/remote/events?roomId=${roomId}`, {
      signal: controller.signal,
    });
    const reader = events.body.getReader();
    await reader.read();
    return { phone, roomId, reader, controller };
  }
  t.after(async () => {
    controllers.forEach((controller) => controller.abort());
    instance.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const setup = await screen.request("/api/auth/setup", {
    body: {
      username: "owner",
      name: "Owner",
      password: "test remote password long enough",
      setupToken: "test-remote-video-setup",
    },
  });
  assert.equal(setup.status, 201);
  return { ...instance, screen, browser, pair, dataDir };
}
const upload = (phone, roomId, name = "phone.mp4", size = 10) =>
  phone.request("/api/remote/media/upload", { body: { roomId, name, size } });
const chunk = (phone, roomId, id, offset, raw) =>
  phone.request(
    `/api/remote/media/upload/${id}?roomId=${roomId}&offset=${offset}`,
    { method: "PUT", raw },
  );
const complete = (phone, roomId, id) =>
  phone.request(`/api/remote/media/upload/${id}/complete`, {
    body: { roomId },
  });
async function prepared(phone, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await phone.request(`/api/remote/media/${id}/status`);
    if (response.data.status !== "preparing") return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Video preparation did not finish");
}

test("phone files transfer in ordered chunks and only their paired screen can resolve and seek them", async (t) => {
  const f = await fixture(t),
    { phone, roomId, reader } = await f.pair();
  assert.equal((await upload(f.browser(), roomId)).status, 401);
  assert.equal((await upload(phone, roomId, "page.html")).status, 400);
  assert.equal((await upload(phone, roomId, "empty.mp4", 0)).status, 413);
  assert.equal(
    (await upload(phone, roomId, "huge.mp4", MAX_PHONE_VIDEO_BYTES + 1)).status,
    413,
  );
  assert.equal(
    (
      await phone.request("/api/remote/media/upload", {
        headers: { Origin: "https://untrusted.test" },
        body: { roomId, name: "phone.mp4", size: 10 },
      })
    ).status,
    403,
  );
  const started = await upload(phone, roomId, "../clip.mp4");
  assert.equal(started.status, 200);
  assert.equal(started.data.chunkBytes, UPLOAD_CHUNK_BYTES);
  const id = started.data.uploadId;
  const pending = (await phone.request(`/api/remote/media?roomId=${roomId}`))
    .data.items;
  assert.equal(pending[0].unavailable, true);
  assert.equal(
    (
      await phone.request(
        `/api/remote/media/upload/${id}?roomId=${roomId}&offset=0`,
        {
          method: "PUT",
          raw: Buffer.from("12345"),
          headers: { Origin: "https://untrusted.test" },
        },
      )
    ).status,
    403,
  );
  assert.equal((await complete(phone, roomId, id)).status, 409);
  assert.equal(
    (await chunk(phone, roomId, id, 1, Buffer.from("12345"))).status,
    409,
  );
  assert.deepEqual(
    (await chunk(phone, roomId, id, 0, Buffer.from("12345"))).data,
    { received: 5 },
  );
  assert.equal(
    (await chunk(phone, roomId, id, 5, Buffer.from("toolong"))).status,
    400,
  );
  assert.deepEqual(
    (await chunk(phone, roomId, id, 5, Buffer.from("67890"))).data,
    { received: 10 },
  );
  const finished = await complete(phone, roomId, id);
  assert.equal(finished.status, 200);
  const item = finished.data.item;
  assert.equal((await phone.request(item.playbackUrl)).status, 403);
  const impostor = f.browser();
  await impostor.request("/api/auth/login", {
    body: { username: "owner", password: "test remote password long enough" },
  });
  assert.equal((await impostor.request(item.playbackUrl)).status, 403);
  assert.equal(
    (
      await phone.request("/api/remote/command", {
        body: {
          roomId,
          command: "load",
          item: {
            ...item,
            title: "forged",
            playbackUrl: "https://bad.test/video.mp4",
          },
        },
      })
    ).status,
    200,
  );
  const command = new TextDecoder().decode((await reader.read()).value);
  assert.match(command, /clip\.mp4/);
  assert.ok(!command.includes("bad.test"));
  const playback = await f.screen.request(item.playbackUrl);
  assert.equal(playback.status, 200);
  assert.equal(playback.data.type, "video");
  const ranged = await f.screen.fetch(playback.data.url, {
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(ranged.headers.get("content-type"), "video/mp4");
  assert.equal(await ranged.text(), "3456");
  assert.match(ranged.headers.get("x-csp-representation-id"), /^mr1_/);
  const head = await f.screen.fetch(playback.data.url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(
    (
      await f.screen.fetch(playback.data.url, {
        headers: { Range: "bytes=20-30" },
      })
    ).status,
    416,
  );
  assert.equal((await phone.request(playback.data.url)).status, 403);
  assert.equal(
    (await phone.request(playback.data.url, { method: "DELETE" })).status,
    403,
  );
  assert.equal(
    (
      await f.screen.request("/api/library/progress", {
        body: { item, seconds: 1, duration: 10 },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.screen.request("/api/library/state")).data.progress.length,
    0,
  );
  assert.equal(
    (await f.screen.request("/api/library/favorites", { body: { item } }))
      .status,
    400,
  );
  assert.equal(
    (await phone.request(`/api/remote/media/${id}`, { method: "DELETE" }))
      .status,
    200,
  );
  assert.equal((await f.screen.request(playback.data.url)).status, 404);
  assert.deepEqual(await readdir(join(f.dataDir, "remote-media")), []);
});

test("uploads enforce chunk and storage limits before reserving extra files", async (t) => {
  const f = await fixture(t),
    { phone, roomId } = await f.pair();
  const first = (await upload(phone, roomId, "big.mp4", MAX_PHONE_VIDEO_BYTES))
    .data.uploadId;
  const second = (
    await upload(phone, roomId, "big2.mp4", MAX_PHONE_VIDEO_BYTES)
  ).data.uploadId;
  assert.equal((await upload(phone, roomId)).status, 413);
  assert.equal(
    (await chunk(phone, roomId, first, 0, Buffer.alloc(UPLOAD_CHUNK_BYTES + 1)))
      .status,
    413,
  );
  assert.equal(
    (await phone.request(`/api/remote/media/${second}`, { method: "DELETE" }))
      .status,
    200,
  );
  assert.equal((await upload(phone, roomId)).status, 200);
  assert.equal(
    (await chunk(phone, roomId, first, 0, Buffer.from("a"))).status,
    200,
  );
});

test("pairing isolation, disabled remotes and screen disconnect prevent access to temporary sources", async (t) => {
  const f = await fixture(t),
    first = await f.pair();
  const id = (await upload(first.phone, first.roomId)).data.uploadId;
  await chunk(first.phone, first.roomId, id, 0, Buffer.from("1234567890"));
  const { item } = (await complete(first.phone, first.roomId, id)).data;
  const playback = (await f.screen.request(item.playbackUrl)).data;
  const otherScreen = f.browser();
  await otherScreen.request("/api/auth/login", {
    body: { username: "owner", password: "test remote password long enough" },
  });
  const other = await f.pair(otherScreen);
  assert.equal(
    (
      await other.phone.request("/api/remote/command", {
        body: { roomId: other.roomId, command: "load", item },
      })
    ).status,
    404,
  );
  assert.equal(
    (await other.phone.request(`/api/remote/media/${id}`, { method: "DELETE" }))
      .status,
    404,
  );
  assert.equal(
    (
      await f.screen.request("/api/remote/screen/disconnect", {
        body: { roomId: first.roomId },
      })
    ).status,
    200,
  );
  assert.equal((await f.screen.request(playback.url)).status, 404);
  assert.deepEqual(await readdir(join(f.dataDir, "remote-media")), []);
  const disabled = await fixture(t, { remoteEnabled: false });
  assert.equal((await upload(disabled.screen, "missing")).status, 404);
});

test("direct links infer file, extensionless HLS and MPEG-TS sources and reject webpage responses", async (t) => {
  let contentType = "video/mp4",
    body = "video bytes",
    clock = Date.now();
  const calls = [];
  const f = await fixture(t, {
    remoteMediaDependencies: {
      now: () => clock,
      requestRemote: async (url, options) => {
        calls.push({ url, options });
        const stream = Readable.from([Buffer.from(body)]);
        stream.headers = { "content-type": contentType };
        stream.statusCode = 206;
        stream.finalUrl = url;
        return stream;
      },
    },
  });
  const { phone, roomId } = await f.pair();
  const link = (
    url = "https://media.test/signed?token=private",
    title = "My linked video",
  ) =>
    phone.request("/api/remote/media/link", { body: { roomId, url, title } });
  assert.equal((await link("file:///etc/passwd")).status, 400);
  assert.equal((await link("http://127.0.0.1/private")).status, 400);
  const file = await link();
  assert.equal(file.status, 200);
  assert.ok(!JSON.stringify(file.data).includes("private"));
  assert.equal(calls[0].options.headers.Range, "bytes=0-2047");
  assert.equal(
    (await f.screen.request(file.data.item.playbackUrl)).data.type,
    "video",
  );
  contentType = "application/octet-stream";
  body = "#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n";
  const hls = await link();
  assert.equal(
    (await f.screen.request(hls.data.item.playbackUrl)).data.type,
    "hls",
  );
  contentType = "video/mp2t";
  body = "ts bytes";
  const ts = await link();
  assert.equal(
    (await f.screen.request(ts.data.item.playbackUrl)).data.streamKind,
    "continuous-ts",
  );
  contentType = "text/html";
  body = "<html>Video page</html>";
  assert.equal((await link()).status, 400);
  contentType = "application/octet-stream";
  assert.equal((await link()).status, 400);
  assert.equal(
    (await phone.request(`/api/remote/media?roomId=${roomId}`)).data.items
      .length,
    3,
  );
  clock += 13 * 3600_000;
  assert.equal(
    (await f.screen.request(file.data.item.playbackUrl)).status,
    404,
  );
  assert.equal(
    (await phone.request(`/api/remote/media?roomId=${roomId}`)).data.items
      .length,
    0,
  );
});

test("direct links use the network destination restrictions including DNS resolution", async (t) => {
  const f = await fixture(t),
    { phone, roomId } = await f.pair();
  for (const url of [
    "http://10.0.0.1/private",
    "http://metadata.google.internal/private",
    "http://localhost/private",
    "http://[::ffff:127.0.0.1]/private",
  ]) {
    assert.equal(
      (await phone.request("/api/remote/media/link", { body: { roomId, url } }))
        .status,
      400,
    );
  }
});

test("a member screen can play its guest phone video without granting access to owner libraries", async (t) => {
  const f = await fixture(t);
  const created = await f.screen.request("/api/accounts", {
    body: {
      username: "member",
      name: "Member",
      password: "temporary member password long enough",
      grants: [],
    },
  });
  assert.equal(created.status, 201);
  const memberScreen = f.browser();
  assert.equal(
    (
      await memberScreen.request("/api/auth/login", {
        body: {
          username: "member",
          password: "temporary member password long enough",
        },
      })
    ).status,
    200,
  );
  const { phone, roomId } = await f.pair(memberScreen);
  const id = (await upload(phone, roomId)).data.uploadId;
  await chunk(phone, roomId, id, 0, Buffer.from("1234567890"));
  const { item } = (await complete(phone, roomId, id)).data;
  assert.equal(
    (
      await phone.request("/api/remote/command", {
        body: { roomId, command: "load", item },
      })
    ).status,
    200,
  );
  const playback = await memberScreen.request(item.playbackUrl);
  assert.equal(playback.status, 200);
  assert.equal(
    await (await memberScreen.fetch(playback.data.url)).text(),
    "1234567890",
  );
  assert.equal((await f.screen.request(item.playbackUrl)).status, 404);
  assert.equal((await phone.request("/api/accounts")).status, 403);
});

test("popular legacy uploads prepare automatically, keep screen-only access and replace originals with seekable MP4 files", async (t) => {
  const converted = [];
  const f = await fixture(t, { remoteMediaDependencies: {
    convertVideo: async (options) => {
      converted.push(options);
      assert.equal(await readFile(options.input, "utf8"), "original");
      await writeFile(options.output, "browser compatible video");
      return { size: 24 };
    },
  } });
  const { phone, roomId } = await f.pair();
  for (const extension of ["AVI", "divx", "wmv", "asf", "flv", "f4v", "mpg", "mpeg", "mpe", "vob", "3gp", "3g2", "ogv", "rm", "rmvb", "mxf"]) {
    const started = await upload(phone, roomId, `clip.${extension}`, 8);
    assert.equal(started.status, 200);
    const id = started.data.uploadId;
    await chunk(phone, roomId, id, 0, Buffer.from("original"));
    const finished = await complete(phone, roomId, id);
    assert.equal(finished.status, 202);
    assert.equal(finished.data.preparing, true);
    const ready = await prepared(phone, id);
    assert.equal(ready.data.status, "ready");
    const playback = (await f.screen.request(ready.data.item.playbackUrl)).data;
    const ranged = await f.screen.fetch(playback.url, { headers: { Range: "bytes=8-17" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-type"), "video/mp4");
    assert.equal(await ranged.text(), "compatible");
    assert.equal((await phone.request(playback.url)).status, 403);
    assert.deepEqual(await readdir(join(f.dataDir, "remote-media")), [`${id}-browser.mp4`]);
    await phone.request(`/api/remote/media/${id}`, { method: "DELETE" });
    assert.deepEqual(await readdir(join(f.dataDir, "remote-media")), []);
  }
  assert.equal(converted.length, 16);
});

test("MOV and other directly supported files can request browser conversion explicitly", async (t) => {
  let conversions = 0;
  const f = await fixture(t, { remoteMediaDependencies: {
    convertVideo: async ({ output }) => {
      conversions++;
      await writeFile(output, "prepared");
      return { size: 8 };
    },
  } });
  const { phone, roomId } = await f.pair();
  const started = await phone.request("/api/remote/media/upload", { body: { roomId, name: "phone.MOV", size: 8, compatibility: true } });
  const id = started.data.uploadId;
  await chunk(phone, roomId, id, 0, Buffer.from("original"));
  await complete(phone, roomId, id);
  assert.equal((await prepared(phone, id)).data.status, "ready");
  assert.equal(conversions, 1);
});

test("extensionless AVI links are safely downloaded for conversion and never expose upstream URLs", async (t) => {
  const bytes = Buffer.from("RIFF0000AVI original"), calls = [];
  const f = await fixture(t, { remoteMediaDependencies: {
    requestRemote: async (url, options) => {
      calls.push({ url, options });
      const stream = Readable.from([bytes]);
      stream.statusCode = options.headers?.Range ? 206 : 200;
      stream.headers = { "content-type": "application/octet-stream", "content-length": String(bytes.length) };
      stream.finalUrl = url;
      return stream;
    },
    convertVideo: async ({ input, output }) => {
      assert.deepEqual(await readFile(input), bytes);
      await writeFile(output, "prepared");
      return { size: 8 };
    },
  } });
  const { phone, roomId } = await f.pair();
  const response = await phone.request("/api/remote/media/link", { body: { roomId, url: "https://media.test/signed?private-token=hidden" } });
  assert.equal(response.status, 202);
  assert.ok(!JSON.stringify(response.data).includes("private-token"));
  const id = response.data.item.id, ready = await prepared(phone, id);
  assert.equal(ready.data.status, "ready");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Range, "bytes=0-2047");
  assert.equal(calls[1].options.headers, undefined);
  const playback = (await f.screen.request(ready.data.item.playbackUrl)).data;
  assert.equal(await (await f.screen.fetch(playback.url)).text(), "prepared");
  assert.equal(calls.length, 2);
});

test("removing or disconnecting a preparing video cancels conversion and removes its temporary files", async (t) => {
  let conversionSignal;
  const f = await fixture(t, { remoteMediaDependencies: {
    convertVideo: async ({ output, signal }) => {
      conversionSignal = signal;
      await writeFile(output, "partial");
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  } });
  const { phone, roomId } = await f.pair();
  for (const disconnect of [false, true]) {
    const id = (await upload(phone, roomId, "clip.avi", 8)).data.uploadId;
    await chunk(phone, roomId, id, 0, Buffer.from("original"));
    await complete(phone, roomId, id);
    assert.equal((await f.screen.request(`/api/remote/media/${id}/playback`)).status, 409);
    assert.equal((await f.browser().request(`/api/remote/media/${id}/status`)).status, 401);
    assert.equal((await phone.request(`/api/remote/media/${id}/status`)).data.status, "preparing");
    await (disconnect
      ? f.screen.request("/api/remote/screen/disconnect", { body: { roomId } })
      : phone.request(`/api/remote/media/${id}`, { method: "DELETE" }));
    assert.equal(conversionSignal.aborted, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await readdir(join(f.dataDir, "remote-media")), []);
  }
});

test("failed conversion and oversized linked files release storage and report a useful error", async (t) => {
  let conversions = 0;
  const f = await fixture(t, { remoteMediaDependencies: {
    convertVideo: async () => { conversions++; throw Object.assign(new Error("This video cannot be decoded"), { status: 422 }); },
    requestRemote: async (url, options) => {
      const stream = Readable.from([Buffer.from("AVI")]);
      stream.statusCode = options.headers?.Range ? 206 : 200;
      stream.headers = { "content-type": "video/x-msvideo", "content-length": String(MAX_PHONE_VIDEO_BYTES + 1) };
      stream.finalUrl = url;
      return stream;
    },
  } });
  const { phone, roomId } = await f.pair();
  const id = (await upload(phone, roomId, "clip.avi", 8)).data.uploadId;
  await chunk(phone, roomId, id, 0, Buffer.from("original"));
  await complete(phone, roomId, id);
  assert.equal((await prepared(phone, id)).data.message, "This video cannot be decoded");
  const linked = await phone.request("/api/remote/media/link", { body: { roomId, url: "https://media.test/large.avi" } });
  const failed = await prepared(phone, linked.data.item.id);
  assert.equal(failed.data.status, "failed");
  assert.match(failed.data.message, /too large/);
  assert.equal(conversions, 1);
  assert.deepEqual(await readdir(join(f.dataDir, "remote-media")), []);
  assert.equal((await upload(phone, roomId, "one.mp4", MAX_PHONE_VIDEO_BYTES)).status, 200);
  assert.equal((await upload(phone, roomId, "two.mp4", MAX_PHONE_VIDEO_BYTES)).status, 200);
});

test("uploaded M3U8 playlists rewrite absolute URLs for the paired screen and reject relative or local references", async (t) => {
  const f = await fixture(t), { phone, roomId } = await f.pair();
  const manifest = Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="https://media.test/init.mp4"\n#EXTINF:2,\nhttps://media.test/segment.ts\n#EXT-X-ENDLIST\n');
  const id = (await upload(phone, roomId, "stream.m3u8", manifest.length)).data.uploadId;
  await chunk(phone, roomId, id, 0, manifest);
  const finished = await complete(phone, roomId, id);
  assert.equal(finished.status, 200);
  const playback = (await f.screen.request(finished.data.item.playbackUrl)).data;
  assert.equal(playback.type, "hls");
  const response = await f.screen.fetch(playback.url);
  assert.match(response.headers.get("content-type"), /mpegurl/);
  const text = await response.text();
  assert.ok(!text.includes("media.test"));
  const child = text.match(/URI="([^"]+)"/)[1];
  assert.match(child, /^\/api\/media\//);
  assert.equal((await phone.request(child)).status, 403);
  assert.equal(await (await f.screen.fetch(playback.url)).text(), text);
  for (const reference of ["segment.ts", "file:///etc/passwd", "data:video/mp4,123"]) {
    const bad = Buffer.from(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${reference}\n#EXT-X-ENDLIST\n`);
    const badId = (await upload(phone, roomId, "bad.m3u8", bad.length)).data.uploadId;
    await chunk(phone, roomId, badId, 0, bad);
    assert.equal((await complete(phone, roomId, badId)).status, 400);
  }
  assert.equal((await upload(phone, roomId, "large.m3u8", 2 * 1024 * 1024 + 1)).status, 413);
});
