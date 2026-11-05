import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Pool by origin AND the validated DNS address. A later DNS answer cannot
// reuse a socket to an address that the current request did not authorize.
class PinnedHttpAgent extends http.Agent { getName(options) { return `${super.getName(options)}:${options.validatedAddress}`; } }
class PinnedHttpsAgent extends https.Agent { getName(options) { return `${super.getName(options)}:${options.validatedAddress}`; } }
const poolOptions={keepAlive:true,maxSockets:12,maxFreeSockets:4,timeout:45000};
const httpPool=new PinnedHttpAgent(poolOptions),httpsPool=new PinnedHttpsAgent(poolOptions);

export function providerError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
function redirectedHeaders(headers, from, to) {
  if (new URL(from).origin === new URL(to).origin) return { ...headers };
  return Object.fromEntries(Object.entries(headers || {}).filter(([key]) =>
    ["user-agent", "accept", "accept-encoding", "range"].includes(key.toLowerCase()),
  ));
}
const hostnameOf = (u) => u.hostname.replace(/^\[|\]$/g, "").toLowerCase();

// Treat IPv4-mapped IPv6 exactly like IPv4, including hexadecimal notation.
export function addressClass(address) {
  let a = address.toLowerCase().split("%")[0];
  if (isIP(a) === 6) a = new URL(`http://[${a}]`).hostname.slice(1, -1);
  if (a.startsWith("::ffff:")) {
    const tail = a.slice(7);
    if (tail.includes(".")) a = tail;
    else {
      const parts = tail.split(":");
      if (parts.length === 2) {
        const n = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16);
        a = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
      }
    }
  }
  if (isIP(a) === 4) {
    if (a === "100.100.100.200" || a === "168.63.129.16") return "blocked";
    const [x, y] = a.split(".").map(Number);
    if (x === 0 || x === 127 || (x === 169 && y === 254) || x >= 224)
      return "blocked";
    if (
      x === 10 ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 100 && y >= 64 && y <= 127)
    )
      return "private";
    return "public";
  }
  if (isIP(a) === 6) {
    if (
      a === "::" ||
      a === "::1" ||
      /^(fe[89ab]|ff)/.test(a) ||
      a.startsWith("2001:db8:") ||
      a.startsWith("2002:") ||
      a.startsWith("64:ff9b:") ||
      a.startsWith("::")
    )
      return "blocked";
    if (/^f[cd]/.test(a)) return "private";
    return "public";
  }
  return "blocked";
}

export function validateRemoteUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw providerError("Enter a valid HTTP or HTTPS address.");
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw providerError(
      "Only HTTP(S) addresses without embedded login details are supported.",
    );
  const host = hostnameOf(u);
  if (
    !host ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal") ||
    host === "instance-data" ||
    host.endsWith(".localhost") ||
    host === "localhost"
  )
    throw providerError("That network destination is not allowed.");
  if (isIP(host) && addressClass(host) === "blocked")
    throw providerError("That network destination is not allowed.");
  u.hash = "";
  return u;
}

/** Resolve and pin the address used by the socket; every redirect is checked again. */
export async function requestRemote(input, options = {}, depth = 0) {
  options.signal?.throwIfAborted();
  const u = validateRemoteUrl(input);
  const host = hostnameOf(u);
  let addresses;
  try {
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true });
  } catch {
    options.signal?.throwIfAborted();
    throw providerError("The provider address could not be resolved. Check its current address with the provider.", 502);
  }
  if (!addresses.length)
    throw providerError("The provider address could not be resolved.", 502);
  const privateAllowed = (options.allowedPrivateHosts || []).includes(host);
  if (
    addresses.some(
      (a) =>
        addressClass(a.address) === "blocked" ||
        (addressClass(a.address) === "private" && !privateAllowed),
    )
  )
    throw providerError(
      "The provider resolves to a restricted network destination.",
    );
  const selected = addresses[0];
  options.signal?.throwIfAborted();
  const headers = {
    "User-Agent": "TesPlay/0.2",
    "Accept-Encoding": "identity",
    ...options.headers,
  };
  const response = await new Promise((resolve, reject) => {
    const request = (u.protocol === "https:" ? https : http).request(
      u,
      {
        method: options.method || "GET",
        headers,
        agent: u.protocol === "https:" ? httpsPool : httpPool,
        validatedAddress: selected.address,
        lookup: (_host, opts, cb) =>
          opts.all
            ? cb(null, [selected])
            : cb(null, selected.address, selected.family),
        timeout: options.timeout || 25000,
        signal: options.signal,
      },
      resolve,
    );
    request.once("error", () =>
      reject(
        providerError(
          "Cannot reach the provider. Check its address and network access.",
          502,
        ),
      ),
    );
    request.once("timeout", () => request.destroy());
    if (options.onSocket) request.once("socket", options.onSocket);
    if (options.body) request.write(options.body);
    request.end();
  });
  if (
    [301, 302, 303, 307, 308].includes(response.statusCode) &&
    response.headers.location
  ) {
    response.resume();
    if (depth >= 5)
      throw providerError("The provider returned too many redirects.", 502);
    const next = validateRemoteUrl(new URL(response.headers.location, u));
    const forwardedHeaders = redirectedHeaders(headers, u, next);
    // Never replay an OAuth POST body to another origin.
    if (options.body && next.origin !== u.origin)
      throw providerError("Unexpected authentication redirect.", 502);
    return requestRemote(
      next,
      {
        ...options,
        headers: forwardedHeaders,
        ...(response.statusCode === 303
          ? { method: "GET", body: undefined }
          : {}),
      },
      depth + 1,
    );
  }
  response.finalUrl = u.toString();
  return response;
}

export async function readBody(stream, max = 16 * 1024 * 1024) {
  const parts = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) {
      stream.destroy();
      throw providerError("The provider response is too large.", 502);
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

export async function remoteData(url, options = {}) {
  const response = await requestRemote(url, options);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    let oauthCode;
    if (options.oauthToken) {
      // OAuth errors need an actionable classification, never Google's raw body,
      // which may contain client credentials or other private provider details.
      try {
        const data = JSON.parse(await readBody(response, 16 * 1024));
        if (['invalid_grant', 'invalid_client'].includes(data.error)) oauthCode = data.error;
      } catch { response.destroy(); }
    } else response.resume();
    throw Object.assign(providerError(
      `Provider returned HTTP ${response.statusCode}. Check the connection and permissions.`,
      response.statusCode === 401 || response.statusCode === 403 ? 400 : 502,
    ), { oauthCode });
  }
  const body = await readBody(response, options.maxBytes);
  if (options.text) return body;
  try {
    return JSON.parse(body);
  } catch {
    throw providerError("The provider returned an invalid response.", 502);
  }
}

export async function containedPath(root, relative = "") {
  if (typeof root !== "string" || !path.isAbsolute(root))
    throw providerError("Set an absolute local media folder on the server.");
  if (
    typeof relative !== "string" ||
    relative.includes("\0") ||
    path.isAbsolute(relative)
  )
    throw providerError("Invalid media path.");
  const realRoot = await realpath(root).catch(() => {
    throw providerError("The media folder is not mounted or is unavailable.");
  });
  const resolved = await realpath(path.resolve(realRoot, relative)).catch(
    () => {
      throw providerError("Media was not found.", 404);
    },
  );
  if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep))
    throw providerError("Media path is outside the configured folder.", 403);
  return resolved;
}

export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2]) || size < 1) return false;
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1]
    ? m[2]
      ? Math.min(Number(m[2]), size - 1)
      : size - 1
    : size - 1;
  if (
    ![start, end].every(Number.isSafeInteger) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return false;
  return { start, end };
}

export function rewriteHls(text, base, register) {
  let sequence = Number(text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] || 0);
  let segment = false;
  const resolve = (uri, metadata) => register(new URL(uri, base).toString(), metadata);
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (!line.startsWith("#")) {
        const metadata = segment && Number.isSafeInteger(sequence) ? { sequence: sequence++ } : undefined;
        segment = false;
        return resolve(line.trim(), metadata);
      }
      if (line.startsWith('#EXTINF:')) segment = true;
      return line.replace(
        /URI="([^"]+)"/g,
        (_, uri) => `URI="${resolve(uri)}"`,
      );
    })
    .join("\n");
}

// Use the first Channels-authored variant, not a fabricated live/VOD query.
// Filter raw query components so unrelated encoding, order and duplicates survive.
function capChannelsMaster(text, {cap, width, height}) {
  const lines = text.split(/\r?\n/), output = [];
  let selected = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) continue;
    if (!line.startsWith('#EXT-X-STREAM-INF:')) { output.push(line); continue; }
    const uri = lines[++i]?.trim();
    if (!uri || uri.startsWith('#')) throw providerError('Channels DVR returned an invalid variant.', 502);
    if (selected) continue;
    selected = true;
    const variant = new URL(uri, 'https://playlist.invalid/');
    const controlled = new Set(['resolution', 'bitrate', 'abitrate', 'achannels']);
    const query = variant.search.slice(1).split('&').filter(part =>
      !controlled.has(new URLSearchParams(part).keys().next().value));
    query.push(`resolution=${height}`, `bitrate=${Math.max(300, Math.floor(cap * 0.85) - 2 * 128)}`, 'abitrate=128');
    // Keep relative paths relative; the normal HLS rewriter resolves them later.
    const rewrittenUri = uri.split(/[?#]/)[0] + '?' + query.filter(Boolean).join('&');
    let info = line.replace(/([:,])BANDWIDTH=[^,]*/, `$1BANDWIDTH=${cap * 1000}`)
      .replace(/([:,])RESOLUTION=[^,]*/, `$1RESOLUTION=${width}x${height}`)
      .replace(/,AVERAGE-BANDWIDTH=[^,]*/g, '');
    if (!/[:,]BANDWIDTH=/.test(info)) info += `,BANDWIDTH=${cap * 1000}`;
    if (!/[:,]RESOLUTION=/.test(info)) info += `,RESOLUTION=${width}x${height}`;
    output.push(info, rewrittenUri);
  }
  if (!selected) throw providerError('Channels DVR did not return a quality variant.', 502);
  return output.join('\n');
}

export function subtitleToVtt(text) {
  if (text.trimStart().startsWith("WEBVTT")) return text;
  return (
    "WEBVTT\n\n" +
    text.replace(/^\uFEFF/, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
  );
}

export const mediaTypes = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".vtt": "text/vtt",
  ".srt": "application/x-subrip",
};

export function createMediaService(ctx) {
  const resources = new Map();
  const channelsSession = item => item.kind === 'hls' &&
    /^\/(devices\/ANY\/channels\/\d{1,5}(\.\d{1,3})?|dvr\/files\/\d{1,10})\/hls$/.test(item.channelsSessionPath || '');
  const socketOwners = new WeakMap();
  const watchedSockets = new WeakSet();
  const unavailableArtwork = (res) => res.status(200)
    .set("Cache-Control", "private, max-age=300")
    .set("X-TesPlay-Artwork", "unavailable")
    .type("image/svg+xml")
    .send('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720" viewBox="0 0 480 720"><rect width="480" height="720" fill="#17202b"/><g transform="translate(192 312)" fill="none" stroke="#64758a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="12" width="88" height="72" rx="10"/><path d="M36 12v72m24-72v72M4 36h32m24 0h32M4 60h32m24 0h32"/></g></svg>');
  function identity(connection, profileId) {
    if (connection?.type === 'channels') return createHash('sha256').update(connection.config.url || '').digest('hex');
    if (connection?.type === 'stremio') return createHash('sha256').update(JSON.stringify([connection.config.authKey || '', (connection.config.addons || []).map(a => [a.key, a.url, a.enabled])])).digest('hex');
    if (connection?.type !== "plex") return null;
    return createHash("sha256")
      .update(
        JSON.stringify([
          connection.config.url,
          connection.config.profileTokens?.[profileId]?.token ||
            connection.config.token ||
            "",
          connection.config.ownerProfileId || "",
        ]),
      )
      .digest("hex");
  }
  function register(req, connection, resource) {
    const now = Date.now();
    if (resources.size >= 20000)
      for (const [k, v] of resources) {
        if (v.expires < now || resources.size >= 18000) resources.delete(k);
        else break;
      }
    const profileId = ctx.getProfileId(req);
    const record = {
      ...resource,
      access: resource.access || req.mediaAccess,
      userId: req.user.id,
      profileId,
      connectionId: connection?.id,
      identity: identity(connection, profileId),
      expires: now + 12 * 3600000,
    };
    // Artwork is referenced by saved library items. An authenticated, encrypted
    // descriptor survives a server restart without writing credentials in those items.
    if (resource.kind === "artwork" && ctx.sealMedia)
      return `/api/media/a_${ctx.sealMedia({ ...record, expires: null })}`;
    // Keep playback tickets separate from the reserved a_ artwork descriptors.
    const id = `m_${randomBytes(24).toString("base64url")}`;
    resources.set(id, record);
    return `/api/media/${id}`;
  }
  function authorizedResource(req) {
    let item;
    try {
      item =
        req.params.token.startsWith("a_") &&
        ctx.openMedia &&
        req.params.token.length < 12000
          ? ctx.openMedia(req.params.token.slice(2))
          : resources.get(req.params.token);
    } catch {
      /* Invalid encrypted descriptors behave like unknown links. */
    }
    if (
      !item ||
      (item.expires && item.expires < Date.now()) ||
      item.userId !== req.user.id ||
      item.profileId !== ctx.getProfileId(req)
    )
      throw providerError(
        "This media link expired. Open the title again.",
        404,
      );
    if(req.session?.scope === 'remote' && item.kind !== 'artwork')
      throw providerError('This browser is authorized as a remote only.',403);
    if (item.remoteRoomId) ctx.authorizeRemoteMedia(req, item);
    const connection = item.connectionId
      ? ctx.getConnection(req, item.connectionId)
      : null;
    if(connection && item.access && ctx.assertAccess) ctx.assertAccess(req,connection,item.access);
    if (item.identity !== identity(connection, ctx.getProfileId(req)))
      throw providerError(
        connection?.type === 'channels' ? 'Your Channels DVR connection changed. Open the title again.' : connection?.type === 'stremio' ? 'Your Stremio connection changed. Open the title again.' : "The selected Plex profile changed. Open the title again.",
        404,
      );
    return {item, connection};
  }
  async function heartbeatHandler(req, res, next) {
    const controller = new AbortController();
    res.once('close', () => {if (!res.writableFinished) controller.abort();});
    try {
      const {item, connection} = authorizedResource(req);
      const channels = connection?.type === 'channels' && channelsSession(item);
      if (!channels && (connection?.type !== 'plex' || item.kind !== 'hls' || !/^[a-f0-9]{24}$/.test(item.plexSessionId || '')))
        throw providerError('This media does not have a Plex transcode session.', 400);
      const url = new URL(channels ? item.channelsSessionPath : '/video/:/transcode/universal/ping', validateRemoteUrl(connection.config.url));
      if (!channels) url.searchParams.set('session', item.plexSessionId);
      item.controllers ??= new Set();
      item.controllers.add(controller);
      res.once('close', () => item.controllers.delete(controller));
      try {
        const response = await requestRemote(url.toString(), {
          headers: item.headers,
          allowedPrivateHosts: channels ? [hostnameOf(validateRemoteUrl(connection.config.url))] : item.allowedPrivateHosts,
          method: channels ? 'PUT' : 'GET', timeout: 10000, signal: controller.signal,
        });
        response.resume();
        if (response.statusCode < 200 || response.statusCode >= 300) throw new Error();
      } catch {
        throw providerError(`${channels ? 'Channels DVR' : 'Plex'} could not keep this stream active.`, 502);
      }
      item.expires = Date.now() + 12 * 3600000;
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ok: true});
    } catch (error) {next(error);}
  }
  async function handler(req, res, next) {
    const controller = new AbortController();
    let item;
    // A viewer can leave while DNS, connection setup or response headers are
    // still pending. Cancel the provider request from the start, including HLS.
    res.once("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const authorized = authorizedResource(req);
      item = authorized.item;
      const connection = authorized.connection;
      item.controllers ??= new Set();
      item.controllers.add(controller);
      res.once("close", () => item.controllers.delete(controller));
      item.expires = Date.now() + 12 * 3600000;
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Adapter inspection and decoder startup read the same playlist back to
      // back. Some live providers require the first segment to be requested
      // before accepting another playlist read. Share that initial snapshot;
      // the short lifetime remains below the normal live refresh interval.
      if (item.manifest && item.manifest.expires > Date.now())
        return res.type("application/vnd.apple.mpegurl").send(item.manifest.text);
      if (item.hlsText) {
        item.children ??= new Map();
        const rewritten = rewriteHls(item.hlsText, "https://playlist.invalid/", (url) => {
          const previous = item.children.get(url);
          if (previous && resources.has(previous.slice('/api/media/'.length))) return previous;
          const child = register(req, connection, {
            url,
            remoteRoomId: item.remoteRoomId,
            remoteHostSessionId: item.remoteHostSessionId,
            remoteMediaId: item.remoteMediaId,
          });
          item.children.set(url, child);
          return child;
        });
        return res.type("application/vnd.apple.mpegurl").send(rewritten);
      }
      if (item.root) {
        const filename = await containedPath(item.root, item.relative);
        const info = await stat(filename);
        if (!info.isFile()) throw providerError("Media file not found.", 404);
        const range = parseRange(req.headers.range, info.size);
        res.setHeader('X-Csp-Representation-Id', 'mr1_' + createHash('sha256').update(`tesplay-file-v1\0${req.params.token}\0${info.size}\0${info.mtimeMs}\0${info.ino}`).digest('base64url'));
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader(
          "Content-Type",
          mediaTypes[path.extname(filename).toLowerCase()] ||
            "application/octet-stream",
        );
        if (range === false)
          return res
            .status(416)
            .set("Content-Range", `bytes */${info.size}`)
            .end();
        if (range)
          res
            .status(206)
            .set(
              "Content-Range",
              `bytes ${range.start}-${range.end}/${info.size}`,
            );
        res.setHeader(
          "Content-Length",
          range ? range.end - range.start + 1 : info.size,
        );
        if (req.method === "HEAD") return res.end();
        const stream = createReadStream(filename, range || {});
        res.once("close", () => stream.destroy());
        stream.once("error", () => res.destroy());
        stream.pipe(res);
        return;
      }
      const currentHeaders = item.getHeaders
        ? await item.getHeaders(req, connection)
        : item.headers;
      const headers = {
        ...currentHeaders,
        // Rewritten manifests have different byte positions from the provider's
        // document. Read the complete bounded playlist even during a probe.
        ...(req.headers.range && item.kind !== "hls" ? { Range: req.headers.range } : {}),
      };
      const retainSocket = (socket) => {
        // A pooled transport can serve many resources. Transfer ownership
        // instead of adding a close listener and retaining every past segment.
        const previous = socketOwners.get(socket);
        if (previous !== item) previous?.sockets?.delete(socket);
        item.sockets ??= new Set();
        item.sockets.add(socket);
        socketOwners.set(socket, item);
        if (!watchedSockets.has(socket)) {
          watchedSockets.add(socket);
          socket.once("close", () => socketOwners.get(socket)?.sockets?.delete(socket));
        }
      };
      let upstream = await requestRemote(item.url, {
        headers,
        allowedPrivateHosts: item.allowedPrivateHosts,
        timeout: 45000,
        signal: controller.signal,
        onSocket: retainSocket,
      });
      // Xtream can briefly reject a segment while registering a fresh HLS
      // viewer. Retry only authenticated playlist children, within a bounded
      // startup budget; never retry a denied catalog or unrelated media URL.
      for (let attempt = 0; item.hlsChild && connection?.type === 'xtream' &&
           [403, 408, 429, 502, 503, 504].includes(upstream.statusCode) && attempt < 2; attempt++) {
        upstream.resume();
        const parent = resources.get(item.parentToken);
        if (attempt === 0 && upstream.statusCode === 403 && parent?.entryUrl) {
          const renewed = await requestRemote(parent.entryUrl, {
            headers: parent.entryHeaders, allowedPrivateHosts: parent.allowedPrivateHosts,
            timeout: 45000, signal: controller.signal, onSocket: retainSocket,
          });
          if (renewed.statusCode >= 200 && renewed.statusCode < 300) {
            const text = await readBody(renewed, 2 * 1024 * 1024);
            if (text.trimStart().startsWith('#EXTM3U')) {
              let replacement;
              rewriteHls(text, renewed.finalUrl, (url, metadata) => {
                if (metadata && metadata.sequence === item.hlsSequence)
                  replacement = validateRemoteUrl(url);
                return url;
              });
              // Providers can encrypt filenames with the viewer's token. Use
              // HLS sequence identity to retain the exact timeline on renewal.
              if (replacement) {
                const refreshedHeaders = redirectedHeaders(parent.entryHeaders, parent.entryUrl, renewed.finalUrl);
                item.url = replacement.toString();
                item.headers = replacement.origin === new URL(renewed.finalUrl).origin ? refreshedHeaders : {};
                parent.url = renewed.finalUrl;
                parent.headers = refreshedHeaders;
                parent.manifest = undefined;
              }
            }
          } else renewed.resume();
        }
        await delay(250 * 2 ** attempt, undefined, { signal: controller.signal });
        upstream = await requestRemote(item.url, {
          headers: { ...item.headers, ...(req.headers.range ? { Range: req.headers.range } : {}) }, allowedPrivateHosts: item.allowedPrivateHosts,
          timeout: 45000, signal: controller.signal, onSocket: retainSocket,
        });
      }
      const contentType = String(
        upstream.headers["content-type"] || "application/octet-stream",
      );
      if (upstream.statusCode >= 400) {
        upstream.resume();
        if (item.kind === "artwork") return unavailableArtwork(res);
        return res.status(upstream.statusCode === 416 ? 416 : 502).json({
          error: `Media provider returned HTTP ${upstream.statusCode}.`,
        });
      }
      const hls =
        /mpegurl/i.test(contentType) ||
        /\.m3u8(?:\?|$)/i.test(upstream.finalUrl) ||
        item.kind === "hls";
      if (hls) {
        let manifest = await readBody(upstream, 2 * 1024 * 1024);
        let manifestOrigin = item.url, sourceHeaders = currentHeaders;
        // A provider can retire its redirect token while the channel is warming
        // up. Renew through the original authenticated entry once, rather than
        // handing the decoder an HTML error or restarting every normal refresh.
        if (!manifest.trimStart().startsWith("#EXTM3U") && item.entryUrl) {
          manifestOrigin = item.entryUrl;
          sourceHeaders = item.entryHeaders;
          upstream = await requestRemote(manifestOrigin, {
            headers: sourceHeaders, allowedPrivateHosts: item.allowedPrivateHosts,
            timeout: 45000, signal: controller.signal,
            onSocket: retainSocket,
          });
          if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
            upstream.resume();
            throw providerError("The live playlist could not be renewed.", 502);
          }
          manifest = await readBody(upstream, 2 * 1024 * 1024);
        }
        if (!manifest.trimStart().startsWith("#EXTM3U"))
          throw providerError(
            "The provider did not return an HLS playlist.",
            502,
          );
        // Xtream start URLs can create a new HLS session on every GET. Follow
        // the validated redirect once, then refresh that same rolling playlist.
        // Preserve the redirect's credential boundary on subsequent requests.
        const manifestHeaders = redirectedHeaders(sourceHeaders, manifestOrigin, upstream.finalUrl);
        if (connection?.type === 'xtream' && upstream.finalUrl !== item.url &&
            (!item.getHeaders || new URL(upstream.finalUrl).origin === new URL(item.url).origin)) {
          item.entryUrl ??= item.url;
          item.entryHeaders ??= currentHeaders;
          item.headers = manifestHeaders;
          item.url = upstream.finalUrl;
        }
        // A playlist may be fetched several times while probing and seeking.
        // Keep its child URLs stable so byte ranges and engine resource ownership
        // refer to the same media, without accumulating a new set on every read.
        if (item.channelsQuality && connection?.type === 'channels' && channelsSession(item))
          manifest = capChannelsMaster(manifest, item.channelsQuality);
        item.children ??= new Map();
        const rewritten = rewriteHls(manifest, upstream.finalUrl, (url, metadata) => {
          if (item.channelsBoundary && connection?.type === 'channels') {
            const childUrl = validateRemoteUrl(url);
            if (childUrl.origin !== validateRemoteUrl(connection.config.url).origin ||
                !childUrl.pathname.startsWith(item.channelsBoundary + '/'))
              throw providerError('Channels DVR returned a media URL outside this session.', 502);
          }
          const previous = item.children.get(url);
          if (previous && resources.has(previous.slice('/api/media/'.length))) return previous;
          const child = register(req, connection, {
            url,
            remoteRoomId: item.remoteRoomId,
            remoteHostSessionId: item.remoteHostSessionId,
            remoteMediaId: item.remoteMediaId,
            hlsChild: true,
            ...(item.channelsBoundary ? {channelsBoundary:item.channelsBoundary} : {}),
            parentToken: req.params.token,
            hlsSequence: manifest.includes('#EXT-X-BYTERANGE:') ? undefined : metadata?.sequence,
            allowedPrivateHosts: item.allowedPrivateHosts,
            headers: new URL(url).origin === new URL(upstream.finalUrl).origin ? manifestHeaders : {},
          });
          item.children.set(url, child);
          // Bound rolling live playlists independently of VOD manifest size.
          if (item.children.size > 20000) item.children.delete(item.children.keys().next().value);
          return child;
        });
        item.manifest = { text: rewritten, expires: Date.now() + 1000 };
        return res.type("application/vnd.apple.mpegurl").send(rewritten);
      }
      if (item.kind === "subtitle")
        return res
          .type("text/vtt")
          .send(subtitleToVtt(await readBody(upstream, 2 * 1024 * 1024)));
      // Only media/artwork/text subtitles can be served through the authenticated proxy.
      if (
        !/^(?:video\/|audio\/|image\/(?:png|jpeg|jpg|webp|gif|avif)(?:;|$)|application\/(?:octet-stream|x-subrip|mp4)(?:;|$)|text\/(?:vtt|plain)(?:;|$))/i.test(
          contentType,
        )
      ) {
        upstream.destroy();
        throw providerError(
          "The provider returned an unsupported media response.",
          502,
        );
      }
      const totalMatch = /^bytes \d+-\d+\/(\d+)$/.exec(String(upstream.headers['content-range'] || ''));
      const total = totalMatch?.[1] || (upstream.statusCode === 200 ? upstream.headers['content-length'] : undefined);
      // Providers may issue a fresh signed redirect for every range request.
      // Bind track selection to the owned source and file validators, rather
      // than its temporary transport URL, so probing and playback agree.
      if (total && /^\d+$/.test(String(total))) res.setHeader('X-Csp-Representation-Id', 'mr1_' + createHash('sha256').update(`tesplay-proxy-v1\0${req.params.token}\0${item.url}\0${total}\0${upstream.headers.etag || ''}\0${upstream.headers['last-modified'] || ''}`).digest('base64url'));
      res.status(upstream.statusCode).setHeader("Content-Type", contentType);
      for (const name of ["content-length", "content-range", "accept-ranges"])
        if (upstream.headers[name]) res.setHeader(name, upstream.headers[name]);
      if (req.method === "HEAD") {
        upstream.destroy();
        return res.end();
      }
      res.once("close", () => upstream.destroy());
      upstream.once("error", () => res.destroy());
      upstream.pipe(res);
    } catch (error) {
      if (item?.kind === "artwork" && error.status === 502 && !controller.signal.aborted && !res.headersSent)
        return unavailableArtwork(res);
      next(error);
    }
  }
  function releaseHandler(req, res, next) {
    try {
      const item = resources.get(req.params.token);
      if (!item) return res.json({ released: true });
      if (item.userId !== req.user.id || item.profileId !== ctx.getProfileId(req))
        throw providerError("This stream belongs to another viewer.", 403);
      const idle = new Set([httpPool, httpsPool].flatMap(pool => Object.values(pool.freeSockets).flat()));
      const pending = [req.params.token], visited = new Set();
      while (pending.length) {
        const id = pending.pop();
        if (visited.has(id)) continue;
        visited.add(id);
        const resource = resources.get(id);
        if (!resource || resource.userId !== req.user.id || resource.profileId !== item.profileId) continue;
        for (const child of resource.children?.values() || []) pending.push(child.slice('/api/media/'.length));
        for (const active of resource.controllers || []) active.abort();
        // Close only this stream's idle transports. A pooled socket currently
        // being used by another viewer must remain connected.
        for (const socket of resource.sockets || [])
          if (idle.has(socket) && socketOwners.get(socket) === resource) socket.destroy();
        if (channelsSession(resource)) {
          // Never delay local teardown on a dropped DVR or a busy tuner.
          void (async () => {
            try {
              const connection = ctx.getConnection(req, resource.connectionId);
              if (connection.type !== 'channels' || resource.identity !== identity(connection, resource.profileId)) return;
              const base = validateRemoteUrl(connection.config.url);
              const response = await requestRemote(new URL(resource.channelsSessionPath, base), {
                method:'DELETE', timeout:3000, allowedPrivateHosts:[hostnameOf(base)],
                signal:AbortSignal.timeout(3000),
              });
              response.resume();
            } catch { /* Best-effort tuner release, including deleted connections. */ }
          })();
        }
        resources.delete(id);
      }
      res.json({ released: true });
    } catch (error) { next(error); }
  }
  return { register, handler, heartbeatHandler, releaseHandler };
}
