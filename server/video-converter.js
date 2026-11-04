import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, rm } from "node:fs/promises";
import { httpError } from "./security.js";

const execute = promisify(execFile);
// File-only input and explicit demuxers prevent an uploaded playlist from
// making network requests or opening arbitrary referenced files.
const inputOptions = [
  "-protocol_whitelist", "file",
  "-format_whitelist", "mov,matroska,webm,avi,asf,flv,mpeg,mpegts,ogg,rm,mxf",
];

export function createVideoConverter({
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
  ffprobe = process.env.FFPROBE_PATH || "ffprobe",
  run = execute,
} = {}) {
  let active = 0;
  async function inspect(filename, signal) {
    const { stdout } = await run(ffprobe, [
      "-v", "error", ...inputOptions,
      "-show_entries", "stream=codec_type:format=duration", "-of", "json",
      filename,
    ], { signal, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
    return JSON.parse(stdout);
  }
  return async function convert({ input, output, maxBytes, signal }) {
    signal.throwIfAborted();
    if (active >= 2)
      throw httpError(429, "Two videos are already being prepared. Try again shortly.");
    if (maxBytes < 128 * 1024)
      throw httpError(413, "Temporary video storage is full. Remove another video and try again.");
    active++;
    try {
      const source = await inspect(input, signal);
      const duration = Number(source.format?.duration);
      if (!source.streams?.some((stream) => stream.codec_type === "video") ||
          !Number.isFinite(duration) || duration <= 0)
        throw httpError(422, "This file does not contain a readable video.");
      if (duration > 4 * 3600)
        throw httpError(413, "Browser conversion supports videos up to four hours long.");
      await run(ffmpeg, [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        ...inputOptions, "-threads", "2", "-i", input,
        "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-filter_threads", "1", "-vf",
        "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        "-c:v", "libx264", "-threads", "2", "-preset", "veryfast",
        "-crf", "23", "-pix_fmt", "yuv420p", "-r", "30",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        "-movflags", "+faststart", "-fs", String(maxBytes - 64 * 1024),
        "-f", "mp4", output,
      ], { signal, timeout: 30 * 60_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
      const size = (await stat(output)).size;
      const prepared = await inspect(output, signal);
      const outputDuration = Number(prepared.format?.duration);
      if (size > maxBytes || !Number.isFinite(outputDuration) ||
          outputDuration < duration - Math.max(0.5, duration * 0.01))
        throw httpError(413, "The converted video exceeds temporary storage. Remove other videos or choose a smaller file.");
      return { size };
    } catch (error) {
      await rm(output, { force: true });
      if (signal.aborted) throw signal.reason;
      if (error.status) throw error;
      if (error.code === "ENOENT")
        throw httpError(503, "Video conversion is unavailable. Install FFmpeg and FFprobe on the server.");
      throw httpError(422, "This video could not be converted. It may be damaged, protected or use an unsupported codec.");
    } finally {
      active--;
    }
  };
}
