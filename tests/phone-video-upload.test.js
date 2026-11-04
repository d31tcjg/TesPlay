import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function moduleUrl(path, replacements = {}) {
  let code = ts.transpileModule(
    readFileSync(new URL(path, import.meta.url), "utf8"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    },
  ).outputText;
  for (const [name, url] of Object.entries(replacements))
    code = code.replaceAll(`"${name}"`, `"${url}"`);
  return "data:text/javascript;base64," + Buffer.from(code).toString("base64");
}
const { uploadPhoneVideo, linkRemoteVideo } = await import(
  moduleUrl("../src/remote-media.ts", {
    "./api": moduleUrl("../src/api.ts"),
    "../shared/video-formats.json": new URL("../shared/video-formats.json", import.meta.url).href,
  })
);
function browser(t, fetch) {
  const previousFetch = globalThis.fetch,
    previousLocation = globalThis.location;
  globalThis.location = {
    href: "https://tesplay.test/",
    origin: "https://tesplay.test",
  };
  globalThis.fetch = fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  });
}

test("phone upload sends bounded chunks with Access headers and finalizes before returning a playable item", async (t) => {
  const file = new File([new Uint8Array(5 * 1024 * 1024)], "phone.MOV", {
    type: "video/quicktime",
  });
  const requests = [],
    progress = [],
    item = {
      id: "remote-video",
      title: "phone.MOV",
      type: "video",
      source: "Phone video",
    };
  browser(t, async (input, init) => {
    const url = new URL(input, location.href);
    requests.push({ url, init });
    assert.equal(
      new Headers(init.headers).get("X-Requested-With"),
      "XMLHttpRequest",
    );
    assert.equal(init.redirect, "manual");
    if (init.method === "PUT")
      return Response.json({
        received: Number(url.searchParams.get("offset")) + init.body.size,
      });
    return Response.json(
      url.pathname.endsWith("/complete")
        ? { item }
        : { uploadId: "remote-video", chunkBytes: 4 * 1024 * 1024 },
    );
  });
  assert.deepEqual(
    await uploadPhoneVideo(
      file,
      "room",
      new AbortController().signal,
      (value) => progress.push(value),
    ),
    item,
  );
  assert.deepEqual(progress, [0, 4 * 1024 * 1024, file.size]);
  assert.deepEqual(
    requests
      .filter((request) => request.init.method === "PUT")
      .map((request) => request.init.body.size),
    [4 * 1024 * 1024, 1024 * 1024],
  );
  assert.ok(requests.at(-1).url.pathname.endsWith("/complete"));
});

test("canceling a transfer removes its temporary upload and never finalizes it", async (t) => {
  const controller = new AbortController(),
    requests = [];
  browser(t, async (input, init) => {
    requests.push({ input, init });
    if (init.method === "PUT") {
      controller.abort();
      throw controller.signal.reason;
    }
    if (init.method === "DELETE") {
      assert.equal(init.body, "{}");
      assert.equal(init.signal, undefined);
      return Response.json({ ok: true });
    }
    return Response.json({
      uploadId: "remote-video",
      chunkBytes: 4 * 1024 * 1024,
    });
  });
  await assert.rejects(
    uploadPhoneVideo(
      new File(["video"], "video.mp4"),
      "room",
      controller.signal,
      () => {},
    ),
    { name: "AbortError" },
  );
  assert.deepEqual(
    requests.map((request) => request.init.method),
    ["POST", "PUT", "DELETE"],
  );
});

test("failed chunks are removed and unsupported or oversized phone files fail before any transfer", async (t) => {
  const methods = [];
  browser(t, async (_input, init) => {
    methods.push(init.method);
    return init.method === "PUT"
      ? Response.json({ error: "Storage is unavailable" }, { status: 507 })
      : Response.json(
          init.method === "POST"
            ? { uploadId: "remote-video", chunkBytes: 4 * 1024 * 1024 }
            : { ok: true },
        );
  });
  await assert.rejects(
    uploadPhoneVideo(
      new File(["video"], "video.mp4"),
      "room",
      new AbortController().signal,
      () => {},
    ),
    /Storage is unavailable/,
  );
  assert.deepEqual(methods, ["POST", "PUT", "DELETE"]);
  methods.length = 0;
  for (const file of [
    new File(["page"], "page.html"),
    new File([], "empty.mp4"),
    { name: "huge.mp4", size: 2 * 1024 * 1024 * 1024 },
  ])
    await assert.rejects(
      uploadPhoneVideo(file, "room", new AbortController().signal, () => {}),
    );
  assert.deepEqual(methods, []);
});

test("AVI uploads and converted links wait for preparation before returning a playable item", async (t) => {
  const paths = [], messages = [], item = { id: "remote-converted", title: "Video", type: "video", source: "Phone video" };
  browser(t, async (input, init) => {
    const path = new URL(input, location.href).pathname;
    paths.push(path);
    if (init.method === "PUT") return Response.json({ received: init.body.size });
    if (path.endsWith("/status")) return Response.json({ status: "ready", item });
    if (path.endsWith("/complete") || path.endsWith("/link")) return Response.json({ item, preparing: true }, { status: 202 });
    return Response.json({ uploadId: item.id, chunkBytes: 4 * 1024 * 1024 });
  });
  assert.deepEqual(await uploadPhoneVideo(new File(["video"], "phone.avi"), "room", new AbortController().signal, () => {}, { compatibility: true, onPreparing: (message) => messages.push(message) }), item);
  assert.ok(paths.at(-1).endsWith("/status"));
  assert.deepEqual(await linkRemoteVideo({ roomId: "room", url: "https://media.test/video.wmv" }, new AbortController().signal, (message) => messages.push(message)), item);
  assert.equal(messages.length, 2);
});

test("canceling video preparation removes the pending link and failed preparation does not return a playable item", async (t) => {
  const controller = new AbortController(), methods = [];
  browser(t, async (_input, init) => {
    methods.push(init.method);
    if (init.method === "DELETE") return Response.json({ ok: true });
    if (init.method === "GET") return Response.json({ status: "failed", message: "Video is damaged" });
    return Response.json({ preparing: true, item: { id: "remote-converted" } }, { status: 202 });
  });
  await assert.rejects(linkRemoteVideo({ roomId: "room", url: "https://media.test/video.avi" }, controller.signal, () => controller.abort()), { name: "AbortError" });
  assert.deepEqual(methods, ["POST", "DELETE"]);
  methods.length = 0;
  await assert.rejects(linkRemoteVideo({ roomId: "room", url: "https://media.test/video.avi" }, new AbortController().signal, () => {}), /Video is damaged/);
  assert.deepEqual(methods, ["POST", "GET", "DELETE"]);
});
