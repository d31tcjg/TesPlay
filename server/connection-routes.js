import { cleanText, httpError } from "./security.js";
import { validateLoadedCategories } from './iptv-selection.js';

const supportedConnections = [
  "channels",
  "xtream",
  "m3u",
  "plex",
  "drive",
  "local",
  "youtube",
  "stremio",
];
const editablePublicConfigFields = new Set([
  "clientId",
  "folderId",
  "rootPath",
  "output",
  "transcode",
  "maxBitrate",
  "maxQuality",
  "authMode",
]);

export function validateConnection(value, existing) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw httpError(400, "Connection details are required.");
  const type = existing?.type ?? value.type;
  if (!supportedConnections.includes(type))
    throw httpError(400, "This connection type is not supported.");
  if (existing && value.type && value.type !== existing.type)
    throw httpError(400, "Connection types cannot be changed.");
  const name =
    value.name === undefined && existing
      ? existing.name
      : cleanText(value.name || type, "Connection name", 80);
  const config = value.config ?? (existing ? undefined : {});
  if (
    config !== undefined &&
    (!config || typeof config !== "object" || Array.isArray(config))
  )
    throw httpError(400, "Connection settings must be a JSON object.");
  const merged = { ...(existing?.config ?? {}), ...(config ?? {}) };
  if (type === 'channels' && merged.maxQuality !== undefined &&
      !['original', '8000-1080', '4000-720', '2000-720', '1000-576'].includes(merged.maxQuality))
    throw httpError(400, 'Choose a supported Channels max streaming quality.');
  validateLoadedCategories(type, merged.loadedCategories);
  const { content, ...otherSettings } = merged;
  if (type === "m3u" && content !== undefined) {
    if (
      typeof content !== "string" ||
      Buffer.byteLength(content, "utf8") > 20 * 1024 * 1024
    )
      throw httpError(400, "Choose a playlist no larger than 20 MB.");
    if (Buffer.byteLength(JSON.stringify(merged), "utf8") > 21 * 1024 * 1024)
      throw httpError(
        400,
        "The encoded playlist settings are larger than 21 MB.",
      );
    if (Buffer.byteLength(JSON.stringify(otherSettings), "utf8") > 24_000)
      throw httpError(
        400,
        "Other connection settings must be smaller than 24 KB.",
      );
  } else if (Buffer.byteLength(JSON.stringify(merged), "utf8") > (type === 'stremio' ? 512_000 : 24_000))
    throw httpError(400, `Connection settings must be smaller than ${type === 'stremio' ? '512' : '24'} KB.`);
  return { type, name, ...(config === undefined ? {} : { config }) };
}

export function createConnectionContext(store) {
  function getManagedConnection(req, id) {
    const c = store.visibleConnection(req.user.id, id);
    if (c.shared) throw httpError(403, 'Only the connection owner can manage this shared connection.');
    return c;
  }
  return {
    getManagedConnection,
    getConnection(req, id) {
      return store.visibleConnection(req.user.id, id);
    },
    listConnections(req) {
      return store.visibleConnections(req.user.id, true);
    },
    saveConnection(req, value, { allowShared = false } = {}) {
      if(value.type==='local' && req.user.role!=='owner')throw httpError(403,'Only the server owner can connect folders on the server.');
      const existing = value.id
        ? (allowShared ? store.visibleConnection(req.user.id, value.id) : getManagedConnection(req, value.id))
        : null;
      return store.saveConnection(existing?.ownerId || req.user.id, {
        ...validateConnection(value, existing),
        ...(value.id ? { id: value.id } : {}),
      });
    },
  };
}

export function registerConnectionRoutes(app, { store, ctx, requireOwner }) {
  app.get("/api/connections", (req, res) =>
    res.json({ connections: store.visibleConnections(req.user.id) }),
  );
  app.get("/api/connections/:id/config", requireOwner, (req, res) => {
    const { config, ...connection } = ctx.getManagedConnection(req, req.params.id);
    res.json({
      connection,
      config: Object.fromEntries(
        Object.entries(config).filter(
          ([key, value]) =>
            editablePublicConfigFields.has(key) &&
            ["string", "boolean", "number"].includes(typeof value),
        ),
      ),
      configuredFields: Object.keys(config).filter(
        (key) => config[key] !== "" && config[key] != null,
      ),
    });
  });
  app.use('/api/connections', (req, _res, next) => {
    if (['POST', 'PUT'].includes(req.method)) {
      const existing = req.method === 'PUT' && /^\/[A-Za-z0-9-]+$/.test(req.path) ? ctx.getConnection(req, req.path.slice(1)) : null;
      if ((existing?.type || req.body?.type) === 'stremio' && Object.keys(req.body?.config || {}).length)
        return next(httpError(400, 'Use Stremio settings to manage this connection and its addons.'));
    }
    next();
  });
  app.post("/api/connections", requireOwner, (req, res) =>
    res.status(201).json({ connection: ctx.saveConnection(req, req.body) }),
  );
  app.put("/api/connections/:id", requireOwner, (req, res) => {
    const existing = ctx.getManagedConnection(req, req.params.id);
    // Saved passwords, URLs containing credentials, and OAuth tokens are never
    // returned to the form. Leaving their edit fields blank preserves them.
    const config = req.body?.config;
    const safeUpdate =
      config && typeof config === "object" && !Array.isArray(config)
        ? Object.fromEntries(
            Object.entries(config).filter(
              ([key, value]) =>
                editablePublicConfigFields.has(key) ||
                !(typeof value === "string" && value.trim() === ""),
            ),
          )
        : config;
    if (
      ["drive", "youtube"].includes(existing.type) &&
      safeUpdate &&
      typeof safeUpdate === "object" &&
      ["clientId", "clientSecret"].some(
        (field) =>
          Object.hasOwn(safeUpdate, field) &&
          safeUpdate[field] !== existing.config[field],
      )
    ) {
      // Google tokens belong to the issuing OAuth client. A user editing that
      // client must authorize it again; ordinary internal token refreshes are
      // unaffected because they do not go through this settings route.
      safeUpdate.accessToken = null;
      safeUpdate.refreshToken = null;
      safeUpdate.expiresAt = 0;
    }
    res.json({
      connection: ctx.saveConnection(req, {
        ...req.body,
        ...(config !== undefined ? { config: safeUpdate } : {}),
        id: req.params.id,
      }),
    });
  });
  app.delete("/api/connections/:id", requireOwner, (req, res) => {
    ctx.getManagedConnection(req, req.params.id);
    store.deleteConnection(req.user.id, req.params.id);
    res.json({ ok: true });
  });
}
