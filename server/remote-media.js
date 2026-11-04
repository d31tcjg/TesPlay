import express from "express";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { httpError, cleanText } from "./security.js";
import { requestRemote, validateRemoteUrl } from "./media.js";
import { createVideoConverter } from "./video-converter.js";
import formats from "../shared/video-formats.json" with { type: "json" };

export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_PHONE_VIDEO_BYTES = 1024 * 1024 * 1024;
const MAX_STORED_BYTES = 2 * MAX_PHONE_VIDEO_BYTES;
const VIDEO_EXTENSIONS = new Set([...formats.direct, ...formats.convert, ...formats.playlists]);
const PLAYLIST_BYTES = 2 * 1024 * 1024;
const LIFETIME = 12 * 3600_000;

/** Temporary sources belong to a pairing and are playable only by its screen. */
export function registerRemoteMediaRoutes(
  app,
  { dataDir, media, findRoom, requireEnabled, dependencies = {} },
) {
  const directory = join(dataDir, "remote-media");
  // Descriptors are ephemeral. Clear interrupted uploads from the previous run.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const records = new Map();
  const remoteRequest = dependencies.requestRemote || requestRemote;
  const convert = dependencies.convertVideo || createVideoConverter();
  const now = dependencies.now || Date.now;
  function removeFiles(record) {
    for (const filename of [record.filename, record.conversionFilename])
      if (filename) rmSync(filename, { force: true });
  }
  function discard(record) {
    records.delete(record.id);
    record.controller?.abort();
    removeFiles(record);
  }
  function prune() {
    for (const record of records.values())
      if (record.expires < now()) discard(record);
  }
  const timer = setInterval(prune, 60_000);
  timer.unref();
  const createLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => req.user.id,
    message: { error: "Too many new videos. Try again in a minute." },
  });
  function paired(req, id) {
    const room = findRoom(req, id);
    if (!room.joined)
      throw httpError(409, "Connect your phone to a screen first.");
    return room;
  }
  function available(req, _res, next) {
    try {
      const room = paired(req, req.body?.roomId || req.query.roomId);
      if (!room.clients.size)
        throw httpError(
          409,
          "Your screen is offline. Open TesPlay there and try again.",
        );
      req.remoteRoom = room;
      prune();
      next();
    } catch (error) {
      next(error);
    }
  }
  function getRecord(req, id, { screen = false, complete = false } = {}) {
    prune();
    const record = records.get(id);
    if (!record)
      throw httpError(
        404,
        "This video expired. Choose it again on your phone.",
      );
    const room = paired(req, record.roomId);
    if (
      screen &&
      (req.session.scope === "remote" || req.session.id !== room.hostSessionId)
    )
      throw httpError(403, "Only the paired screen can play this video.");
    if (
      !screen &&
      req.session.id !== record.creatorSessionId &&
      req.session.id !== room.hostSessionId
    )
      throw httpError(403, "This video belongs to another remote.");
    if (complete && !record.complete)
      throw httpError(409, record.error || (record.preparing ? "Wait for this video to finish preparing." : "Wait for the video upload to finish."));
    return record;
  }
  const storedBytes = () => [...records.values()].reduce((total, record) => total + record.reservedBytes, 0);
  function reserve(record, bytes) {
    if (storedBytes() - record.reservedBytes + bytes > MAX_STORED_BYTES)
      throw httpError(413, "Temporary video storage is full. Remove another video and try again.");
    record.reservedBytes = bytes;
  }
  function publicItem(record) {
    return {
      ...record.item,
      ...(!record.complete ? {
        unavailable: true,
        unavailableReason: record.error || (record.preparing ? record.phase : "Incomplete upload · Remove to free space"),
      } : {}),
    };
  }
  function prepare(record, req) {
    record.preparing = true;
    record.phase = record.filename ? "Converting video for your browser…" : "Downloading video for conversion…";
    record.controller = new AbortController();
    const signal = record.controller.signal;
    void (async () => {
      try {
        if (!record.filename) {
          const maxInputBytes = Math.min(MAX_PHONE_VIDEO_BYTES, MAX_STORED_BYTES - storedBytes());
          if (maxInputBytes < 128 * 1024)
            throw httpError(413, "Temporary video storage is full. Remove another video and try again.");
          reserve(record, maxInputBytes);
          record.filename = join(directory, `${record.id}.input`);
          const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(3 * 60_000)]);
          const response = await remoteRequest(record.url, { signal: downloadSignal });
          try {
            downloadSignal.throwIfAborted();
            if (response.statusCode !== 200)
              throw httpError(502, "The full video could not be opened for conversion. Check its link and expiry.");
            const length = Number(response.headers["content-length"]);
            if (Number.isFinite(length) && length > maxInputBytes)
              throw httpError(413, "This linked video is too large for temporary storage (up to 1 GB). Remove other videos or use a smaller file.");
            let received = 0;
            await pipeline(response, new Transform({
              transform(chunk, _encoding, callback) {
                received += chunk.length;
                callback(received > maxInputBytes ? httpError(413, "This linked video exceeds temporary storage (up to 1 GB).") : null, chunk);
              },
            }), createWriteStream(record.filename, { flags: "wx", mode: 0o600 }), { signal: downloadSignal });
            record.size = received;
            reserve(record, received);
          } finally {
            response.destroy();
          }
        }
        signal.throwIfAborted();
        record.phase = "Converting video for your browser…";
        const maxBytes = Math.min(MAX_PHONE_VIDEO_BYTES, MAX_STORED_BYTES - storedBytes());
        reserve(record, record.size + maxBytes);
        record.conversionFilename = join(directory, `${record.id}-browser.mp4`);
        const result = await convert({ input: record.filename, output: record.conversionFilename, maxBytes, signal });
        signal.throwIfAborted();
        if (!Number.isSafeInteger(result.size) || result.size < 1 || result.size > maxBytes)
          throw httpError(413, "The converted video exceeds temporary storage.");
        if (!records.has(record.id)) throw httpError(410, "The screen disconnected while preparing this video.");
        paired(req, record.roomId);
        rmSync(record.filename, { force: true });
        record.filename = record.conversionFilename;
        record.conversionFilename = undefined;
        record.kind = "video";
        record.complete = true;
        reserve(record, result.size);
        record.expires = now() + LIFETIME;
      } catch (error) {
        removeFiles(record);
        record.reservedBytes = 0;
        record.error = error.status ? error.message : "This video could not be prepared. Try again or choose another file.";
      } finally {
        record.preparing = false;
        if (!records.has(record.id)) removeFiles(record);
      }
    })();
  }
  function create(req, title, source, size = 0) {
    const room = req.remoteRoom;
    if (
      [...records.values()].filter((record) => record.roomId === room.id)
        .length >= 8
    )
      throw httpError(
        409,
        "This remote has eight temporary videos. Remove one or reconnect your screen.",
      );
    if (
      storedBytes() + size > MAX_STORED_BYTES
    )
      throw httpError(
        413,
        "Temporary video storage is full. Remove an uploaded video and try again.",
      );
    const id = `remote-${randomUUID()}`;
    const item = {
      id,
      title,
      type: "video",
      source,
      providerType: "remote-media",
      playbackUrl: `/api/remote/media/${id}/playback`,
    };
    const record = {
      id,
      item,
      roomId: room.id,
      hostSessionId: room.hostSessionId,
      creatorSessionId: req.session.id,
      size,
      reservedBytes: size,
      received: 0,
      complete: false,
      writing: false,
      expires: now() + 3600_000,
    };
    records.set(id, record);
    return record;
  }
  app.get("/api/remote/media", requireEnabled, (req, res) => {
    const room = paired(req, req.query.roomId);
    prune();
    res.json({
      items: [...records.values()]
        .filter(
          (record) =>
            record.roomId === room.id &&
            (record.creatorSessionId === req.session.id ||
              room.hostSessionId === req.session.id),
        )
        .map(publicItem),
      maxBytes: MAX_PHONE_VIDEO_BYTES,
    });
  });
  app.post(
    "/api/remote/media/upload",
    requireEnabled,
    createLimit,
    available,
    (req, res) => {
      const name = cleanText(req.body?.name, "Video name", 300);
      const extension = extname(name).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(extension))
        throw httpError(
          400,
          "Choose a video such as MP4, MOV, MKV, WebM, AVI, WMV, FLV, MPEG, 3GP or an HLS playlist.",
        );
      const size = req.body?.size;
      if (
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > MAX_PHONE_VIDEO_BYTES
      )
        throw httpError(413, "Choose a video between 1 byte and 1 GB.");
      if (req.body.compatibility !== undefined && typeof req.body.compatibility !== "boolean")
        throw httpError(400, "Choose a valid browser conversion option.");
      if (formats.playlists.includes(extension) && size > PLAYLIST_BYTES)
        throw httpError(413, "HLS playlists can be up to 2 MB. Paste the hosted playlist link instead.");
      const record = create(req, name, "Phone video", size);
      record.convert = req.body.compatibility === true || formats.convert.includes(extension);
      record.filename = join(directory, record.id + extension);
      try {
        writeFileSync(record.filename, "", { flag: "wx", mode: 0o600 });
      } catch (error) {
        discard(record);
        throw error;
      }
      res.json({ uploadId: record.id, chunkBytes: UPLOAD_CHUNK_BYTES });
    },
  );
  app.put(
    "/api/remote/media/upload/:id",
    requireEnabled,
    available,
    (req, _res, next) => {
      try {
        getRecord(req, req.params.id);
        next();
      } catch (error) {
        next(error);
      }
    },
    express.raw({
      type: "application/octet-stream",
      limit: UPLOAD_CHUNK_BYTES,
    }),
    async (req, res) => {
      const record = getRecord(req, req.params.id);
      if (req.query.roomId !== record.roomId)
        throw httpError(404, "This upload belongs to another screen.");
      if (record.complete || record.writing)
        throw httpError(409, "This upload is already complete or busy.");
      const offset = Number(req.query.offset);
      if (!Number.isSafeInteger(offset) || offset !== record.received)
        throw httpError(
          409,
          "The upload position changed. Select the video again.",
        );
      if (
        !Buffer.isBuffer(req.body) ||
        !req.body.length ||
        record.received + req.body.length > record.size
      )
        throw httpError(400, "This video chunk has an invalid size.");
      record.writing = true;
      let file;
      try {
        file = await open(record.filename, "r+");
        let written = 0;
        while (written < req.body.length) {
          const result = await file.write(
            req.body,
            written,
            req.body.length - written,
            offset + written,
          );
          if (!result.bytesWritten)
            throw new Error("Video storage could not be written.");
          written += result.bytesWritten;
        }
        if (!records.has(record.id))
          throw httpError(410, "This remote was disconnected during upload.");
        paired(req, record.roomId);
        record.received += written;
        record.expires = now() + 3600_000;
      } finally {
        await file?.close();
        record.writing = false;
      }
      res.json({ received: record.received });
    },
  );
  app.post(
    "/api/remote/media/upload/:id/complete",
    requireEnabled,
    available,
    async (req, res) => {
      const record = getRecord(req, req.params.id);
      if (req.body.roomId !== record.roomId)
        throw httpError(404, "This upload belongs to another screen.");
      if (record.writing || record.received !== record.size)
        throw httpError(409, "Wait for the entire video to upload.");
      if (record.preparing) return res.status(202).json({ item: publicItem(record), preparing: true });
      if (record.complete) return res.json({ item: record.item });
      if (record.error) throw httpError(422, record.error);
      if (formats.playlists.includes(extname(record.filename))) {
        const manifest = (await readFile(record.filename, "utf8")).trimStart();
        if (!manifest.startsWith("#EXTM3U") || !manifest.includes("#EXT-X-"))
          throw httpError(400, "Choose an HLS video playlist (.m3u8), or paste a direct video link.");
        const uris = manifest.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#"))
          .concat([...manifest.matchAll(/URI="([^"]+)"/g)].map((match) => match[1]));
        if (!uris.length) throw httpError(400, "This HLS playlist does not contain any video links.");
        if (uris.length > 10000) throw httpError(400, "This uploaded HLS playlist has too many media links. Paste its hosted URL instead.");
        for (const uri of uris) {
          if (!/^https?:\/\//i.test(uri.trim()))
            throw httpError(400, "Uploaded HLS playlists need full HTTP(S) media links. For relative segments, paste the hosted .m3u8 URL instead.");
          validateRemoteUrl(uri.trim());
        }
        record.manifest = manifest;
        record.kind = "hls";
      } else if (record.convert) {
        prepare(record, req);
        return res.status(202).json({ item: publicItem(record), preparing: true });
      }
      record.complete = true;
      record.expires = now() + LIFETIME;
      res.json({ item: record.item });
    },
  );
  app.post(
    "/api/remote/media/link",
    requireEnabled,
    createLimit,
    available,
    async (req, res) => {
      if (typeof req.body?.url !== "string" || req.body.url.length > 3000)
        throw httpError(400, "Paste a direct HTTP or HTTPS video link.");
      const url = validateRemoteUrl(req.body.url.trim());
      if (req.body.compatibility !== undefined && typeof req.body.compatibility !== "boolean")
        throw httpError(400, "Choose a valid browser conversion option.");
      const controller = new AbortController();
      res.once("close", () => {
        if (!res.writableFinished) controller.abort();
      });
      const upstream = await remoteRequest(url.href, {
        headers: { Range: "bytes=0-2047" },
        signal: controller.signal,
      });
      let kind, convertVideo = req.body.compatibility === true;
      try {
        if (![200, 206].includes(upstream.statusCode))
          throw httpError(
            502,
            "The video link could not be opened. Check the link and its expiry.",
          );
        const contentType = String(upstream.headers["content-type"] || "");
        if (/text\/html|application\/(?:json|xml|xhtml)/i.test(contentType))
          throw httpError(
            400,
            "This is a webpage. Paste a direct video file or HLS playlist link.",
          );
        let prefix = "", bytes = Buffer.alloc(0);
        for await (const chunk of upstream) {
          bytes = chunk;
          prefix = chunk.toString("utf8", 0, 512).trimStart();
          break;
        }
        kind =
          /mpegurl/i.test(contentType) ||
          /\.m3u8$/i.test(new URL(upstream.finalUrl || url.href).pathname) ||
          prefix.startsWith("#EXTM3U")
            ? "hls"
            : /mp2t/i.test(contentType) ||
                /\.(?:ts|mts|m2ts)$/i.test(url.pathname)
              ? "ts"
              : "video";
        if (prefix.startsWith("<"))
          throw httpError(
            400,
            "This link returned a webpage. Paste a direct video link.",
          );
        convertVideo ||= formats.convert.includes(extname(new URL(upstream.finalUrl || url.href).pathname).toLowerCase()) ||
          /(?:x-msvideo|\/avi|x-ms-wmv|x-ms-asf|x-flv|video\/mpeg(?:;|$)|3gpp|video\/ogg|realvideo|\/mxf)/i.test(contentType) ||
          (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "AVI ") ||
          bytes.toString("ascii", 0, 3) === "FLV";
      } finally {
        upstream.destroy();
      }
      controller.signal.throwIfAborted();
      // Pairing and capacity can change while the remote URL is being checked.
      req.remoteRoom = paired(req, req.remoteRoom.id);
      const title = cleanText(
        req.body.title || "Linked video",
        "Video title",
        300,
      );
      const record = create(req, title, "Video link");
      record.url = url.href;
      record.kind = kind;
      if (convertVideo && kind !== "hls") {
        prepare(record, req);
        return res.status(202).json({ item: publicItem(record), preparing: true });
      }
      record.complete = true;
      record.expires = now() + LIFETIME;
      res.json({ item: record.item });
    },
  );
  app.get("/api/remote/media/:id/status", requireEnabled, (req, res) => {
    const record = getRecord(req, req.params.id);
    res.json({ item: publicItem(record), status: record.error ? "failed" : record.complete ? "ready" : record.preparing ? "preparing" : "uploading", message: record.error || record.phase });
  });
  app.get("/api/remote/media/:id/playback", requireEnabled, (req, res) => {
    const record = getRecord(req, req.params.id, {
      screen: true,
      complete: true,
    });
    const resource = {
      remoteRoomId: record.roomId,
      remoteHostSessionId: record.hostSessionId,
      remoteMediaId: record.id,
      ...(record.manifest
        ? { hlsText: record.manifest, kind: "hls" }
        : record.filename
        ? { root: directory, relative: record.filename.slice(directory.length + 1) }
        : {
            url: record.url,
            ...(record.kind === "hls" ? { kind: "hls" } : {}),
          }),
    };
    record.expires = now() + LIFETIME;
    res.json({
      url: media.register(req, null, resource),
      type: record.kind === "hls" ? "hls" : "video",
      ...(record.kind === "ts" ? { streamKind: "continuous-ts" } : {}),
    });
  });
  app.delete("/api/remote/media/:id", requireEnabled, (req, res) => {
    const record = getRecord(req, req.params.id);
    if (record.writing)
      throw httpError(
        409,
        "Wait for the current video chunk to finish, then remove it.",
      );
    discard(record);
    res.json({ ok: true });
  });
  return {
    validateItem(req, item) {
      const record = getRecord(req, item.id, { complete: true });
      if (req.body?.roomId && req.body.roomId !== record.roomId)
        throw httpError(404, "This video belongs to another screen.");
      return record.item;
    },
    authorize(req, resource) {
      getRecord(req, resource.remoteMediaId, { screen: true, complete: true });
      const room = paired(req, resource.remoteRoomId);
      if (
        req.session.scope === "remote" ||
        req.session.id !== resource.remoteHostSessionId ||
        room.hostSessionId !== req.session.id
      )
        throw httpError(403, "Only the paired screen can play this video.");
    },
    discardRoom(roomId) {
      for (const record of records.values())
        if (record.roomId === roomId) discard(record);
    },
    close() {
      clearInterval(timer);
      for (const record of records.values()) discard(record);
    },
  };
}
