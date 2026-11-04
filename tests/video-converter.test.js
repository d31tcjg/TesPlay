import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoConverter } from "../server/video-converter.js";

const run = promisify(execFile);

test("real legacy containers and phone codecs convert to complete, seekable H.264/AAC MP4", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tesplay-converter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const convert = createVideoConverter();
  for (const [extension, video, audio, options = []] of [
    ["avi", "mpeg4", "mp3"],
    ["wmv", "wmv2", "wmav2"],
    ["flv", "flv1", "mp3"],
    ["mpg", "mpeg2video", "mp2"],
    ["3gp", "h263", "aac"],
    ["ogv", "libvpx", "vorbis", ["-strict", "-2", "-ac", "2"]],
    ["mov", "prores_ks", "pcm_s16le", ["-profile:v", "0", "-pix_fmt", "yuv422p10le"]],
    ["mkv", "mpeg4", "ac3"],
    ["ts", "mpeg2video", "mp2"],
  ]) {
    await t.test(extension, async () => {
      const input = join(directory, `source.${extension}`);
      const output = join(directory, `${extension}-browser.mp4`);
      await run("ffmpeg", [
        "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x96:rate=12",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", "2", "-c:v", video, "-c:a", audio, ...options, "-y", input,
      ], { timeout: 15_000 });
      const result = await convert({ input, output, maxBytes: 8 * 1024 * 1024, signal: new AbortController().signal });
      assert.equal(result.size, (await stat(output)).size);
      const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]);
      const info = JSON.parse(stdout);
      assert.equal(info.streams[0].codec_name, "h264");
      assert.equal(info.streams[0].pix_fmt, "yuv420p");
      assert.equal(info.streams[1].codec_name, "aac");
      assert.ok(Number(info.format.duration) >= 1.9);
      // Decode from the middle, proving the converted file retains seekable video.
      await run("ffmpeg", ["-v", "error", "-ss", "1", "-i", output, "-frames:v", "1", "-f", "null", "-"], { timeout: 15_000 });
    });
  }
});

test("conversion refuses disguised playlists, damaged videos, undersized output budgets and absent tooling", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tesplay-converter-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "disguised.avi"), output = join(directory, "browser.mp4");
  await writeFile(input, "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://127.0.0.1/private.ts\n");
  const parameters = { input, output, maxBytes: 1024 * 1024, signal: new AbortController().signal };
  await assert.rejects(createVideoConverter()(parameters), { status: 422 });
  await assert.rejects(stat(output), { code: "ENOENT" });
  await writeFile(input, "not a readable video");
  await assert.rejects(createVideoConverter()(parameters), { status: 422 });
  await assert.rejects(createVideoConverter()({ ...parameters, maxBytes: 100 }), { status: 413 });
  await assert.rejects(createVideoConverter({ ffprobe: join(directory, "missing-tool") })(parameters), { status: 503 });
});

test("conversion bounds concurrent work and propagates cancellation without retaining output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tesplay-converter-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const convert = createVideoConverter({ run: (_binary, _args, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) });
  const jobs = controllers.slice(0, 2).map((controller, i) => convert({ input: join(directory, `input-${i}.avi`), output: join(directory, `browser-${i}.mp4`), maxBytes: 1024 * 1024, signal: controller.signal }));
  await assert.rejects(convert({ input: join(directory, "third.avi"), output: join(directory, "third.mp4"), maxBytes: 1024 * 1024, signal: controllers[2].signal }), { status: 429 });
  const settled = Promise.allSettled(jobs);
  controllers[0].abort();
  controllers[1].abort();
  for (const result of await settled) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.name, "AbortError");
  }
});
