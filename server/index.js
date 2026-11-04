import express from "express";
import {retainUiAssets} from "./ui-assets.js";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createStore } from "./store.js";
import { assertAllowed } from "./access.js";
import { createAuthContext } from "./auth-context.js";
import { registerAuthRoutes, registerSessionRoutes } from "./auth-routes.js";
import { createConnectionContext, registerConnectionRoutes } from "./connection-routes.js";
import { categoryLoaded } from './iptv-selection.js';
import { createLibraryContext, registerLibraryRoutes } from "./library-routes.js";
import { registerProfileRoutes } from "./profile-routes.js";
import { registerAccountRoutes } from "./account-routes.js";
import { registerRemoteRoutes } from "./remote.js";
import { createMediaService } from "./media.js";
import { registerQrAuthRoutes } from "./qr-auth.js";
import { registerScreenCheckRoutes } from "./screen-check.js";
import {
  SESSION_COOKIE,
  cookieOptions,
  csrfProtection,
  httpError,
  randomToken,
} from "./security.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function createApp(options = {}) {
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  const publicUrl = (options.publicUrl ?? process.env.PUBLIC_URL ?? "").replace(
    /\/$/,
    "",
  );
  if (publicUrl) {
    const parsed = new URL(publicUrl);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error(
        "PUBLIC_URL must be an HTTP(S) origin, for example https://media.example.com.",
      );
  }
  const store = createStore({
    dataDir:
      options.dataDir ?? process.env.DATA_DIR ?? resolve(rootDir, "data"),
    encryptionKey: options.encryptionKey ?? process.env.ENCRYPTION_KEY,
  });
  const configuredSetupToken =
    (typeof options.setupToken === "string" ? options.setupToken.trim() : "") ||
    process.env.SETUP_TOKEN?.trim();
  const setupToken = configuredSetupToken || randomToken(24);
  const remoteEnabled =
    options.remoteEnabled ?? process.env.REMOTE_ENABLED !== "false";
  const app = express();
  const auth = createAuthContext(store, { publicUrl });
  const { authStatus, startSession, requireAuth, requireOwner, getProfileId } = auth;
  app.disable("x-powered-by");
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY;
  if (trustProxy)
    app.set(
      "trust proxy",
      /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy,
    );
  app.use((_req, res, next) => {
    if (production) res.locals.cspNonce = randomToken(18);
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: production
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: [
                "'self'",
                "blob:",
                "'wasm-unsafe-eval'",
                "https://static.cloudflareinsights.com",
                (_req, res) => `'nonce-${res.locals.cspNonce}'`,
              ],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", "data:", "https:", "http:"],
              fontSrc: ["'self'", "data:"],
              mediaSrc: ["'self'", "blob:", "https:", "http:"],
              connectSrc: ["'self'", "https:", "http:"],
              frameSrc: ["'none'"],
              workerSrc: ["'self'", "blob:"],
              childSrc: ["'self'", "blob:"],
              objectSrc: ["'none'"],
              upgradeInsecureRequests: publicUrl.startsWith("https:")
                ? []
                : null,
            },
          }
        : false,
      strictTransportSecurity:
        production && publicUrl.startsWith("https:") ? undefined : false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );
  app.use(cookieParser());
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", (req, res, next) => {
    const authenticated = store.getSession(req.cookies[SESSION_COOKIE]);
    req.user = authenticated?.user ?? null;
    req.session = authenticated?.session ?? null;
    if (req.session) store.touchBrowser(req.session.id,req.headers["user-agent"]);
    next();
  });
  app.use("/api", csrfProtection({ publicUrl, production }));
  // Large playlist uploads are parsed only after authentication; ordinary APIs keep a small body limit.
  const connectionWriteLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => req.user.id,
    skip: (req) => !["POST", "PUT", "DELETE"].includes(req.method),
    message: { error: "Too many connection changes. Try again in a minute." },
  });
  app.use(
    "/api/connections",
    requireAuth,
    connectionWriteLimit,
    express.json({ limit: "21mb", strict: true }),
  );
  app.use(express.json({ limit: "64kb", strict: true }));
  const connections = createConnectionContext(store);
  let remote;
  const library = createLibraryContext(store, { getProfileId, getConnection: connections.getConnection,
    validateTransientItem: (req, item) => remote.validateMediaItem(req, item),
  });
  const { visibleLibrary, ownedItem } = library;
  const ctx = {
    ...connections,
    db: store.db,
    requireAuth,
    getProfileId,
    libraryState: (req) => visibleLibrary(req),
    stars: library.stars,
    assertAccess(req,c,value) { if (!categoryLoaded(c,value)) throw httpError(403,'This category is not loaded. Enable it in IPTV settings.'); assertAllowed(c.access,value); req.mediaAccess=value; },
    canAccess(req,c,value) { try { if (!categoryLoaded(c,value)) return false; assertAllowed(c.access,value); return true; } catch { return false; } },
    readProviderCatalog: (...args) => store.readProviderCatalog(...args),
    writeProviderCatalog: (...args) => store.writeProviderCatalog(...args),
    sealMedia: (value) => store.sealMedia(value),
    openMedia: (token) => store.openMedia(token),
  };
  ctx.authorizeRemoteMedia = (req, resource) => remote.authorizeMedia(req, resource);
  ctx.media = createMediaService(ctx);
  app.get("/api/health", (req, res) => res.json({ ok: true }));
  registerScreenCheckRoutes(app, { onReport: options.onScreenCheck });
  await registerAuthRoutes(app, { store, setupToken, authStatus, startSession });
  const qrAuth = registerQrAuthRoutes(app, {
    publicUrl,
    remoteEnabled,
    requireAuth: (req,res,next) => requireAuth(req,res,(error) => error ? next(error) : req.session.scope === "remote" ? next(httpError(403,"This browser is authorized as a remote only.")) : next()),
    startSession,
    authStatus,
    store,
  });
  remote = registerRemoteRoutes(app, { enabled: remoteEnabled, store, getProfileId, validateRemoteItem: ownedItem, requireAuth, authStatus,
    media: ctx.media, dataDir: options.dataDir ?? process.env.DATA_DIR ?? resolve(rootDir, "data"),
    mediaDependencies: options.remoteMediaDependencies,
    startRemoteSession(req,res,screen) {
      if (req.session?.id === screen.host_session_id) throw httpError(409,'Open this remote link on another browser.');
      if (req.session?.scope === 'full' && req.user?.id === screen.user_id) {
        store.setRemoteBrowser(req,screen);
        req.session.deviceMode='remote';req.session.remoteRoomId=screen.id;req.session.profileId=screen.profile_id;
        return;
      }
      if(req.session)store.deleteSession(req.session.id);
      const token=randomToken();
      req.session=store.createSession(screen.user_id,token,{userAgent:req.headers['user-agent'],scope:'remote',profileId:screen.profile_id,roomId:screen.id,parentSessionId:screen.host_session_id});
      req.user=store.findUserById(screen.user_id);res.cookie(SESSION_COOKIE,token,cookieOptions(req,publicUrl));
    }
  });
  app.use("/api", requireAuth);
  app.use('/api',(req,_res,next)=>{
    if (req.session.scope !== 'remote') return next();
    const allowedGet = req.method === 'GET' && (['/connections','/catalog','/episodes','/playback/options','/library/state','/settings','/player/preferences'].includes(req.path) || /^\/media\//.test(req.path) || /^\/plex\/[^/]+\/(sections|hubs|list|continuity)$/.test(req.path) || /^\/stremio\/[^/]+\/catalogs$/.test(req.path) || /^\/youtube\/[^/]+\/(feed|subscriptions|playlists|search|channel\/[^/]+\/videos|playlist\/[^/]+\/videos)$/.test(req.path));
    const allowedPost = req.method === 'POST' && ['/auth/logout','/library/favorites','/library/stars','/library/queue'].includes(req.path);
    return allowedGet || allowedPost ? next() : next(httpError(403,'This browser is authorized as a remote only.'));
  });
  app.get(["/api/media/:token", "/api/v1/media/:token"], ctx.media.handler);
  app.post('/api/media/:token/heartbeat', ctx.media.heartbeatHandler);
  app.delete(["/api/media/:token", "/api/v1/media/:token"], ctx.media.releaseHandler);
  // Registrars share the gates above; keep authentication and remote scope
  // checks ahead of every account, profile, library and connection route.
  registerSessionRoutes(app, { store, remote, publicUrl });
  registerProfileRoutes(app, { store, getProfileId, authStatus });
  const requireConnectionManager=(req,res,next)=>req.session.scope!=='remote' && req.user.canManageConnections?next():next(httpError(403,'This account cannot manage connections.'));
  ctx.requireConnectionManager = requireConnectionManager;
  registerConnectionRoutes(app, { store, ctx, requireOwner:requireConnectionManager });
  registerLibraryRoutes(app, { store, ctx, getProfileId, visibleLibrary, ownedItem });
  registerAccountRoutes(app, { store, requireOwner, qrAuth });
  // Provider authorization/settings belong to each connection's owner. Token refreshes inside
  // authenticated browsing still update the original encrypted connector.
  app.use('/api/plex',(req,res,next)=>{
    const pathname=req.originalUrl.split('?')[0];
    if(req.method!=='GET' || !/\/(sections|hubs|list|watchlist|continuity)$/.test(pathname)) return requireConnectionManager(req,res,next);
    next();
  });
  const requireManagedConnection = (req,_res,next) => {
    try { ctx.getManagedConnection(req,req.params.connectionId || req.params.id); next(); }
    catch(error) { next(error); }
  };
  app.use(['/api/plex/:connectionId/servers','/api/plex/:connectionId/server','/api/plex/:connectionId/profiles','/api/plex/:connectionId/profile'],requireManagedConnection);
  app.use(['/api/drive/auth','/api/drive/callback','/api/youtube/auth','/api/youtube/callback'],requireConnectionManager);
  app.post('/api/connections/:id/test',requireConnectionManager,requireManagedConnection,(req,res,next)=>next());
  app.get('/api/connections/:id/categories',requireConnectionManager,requireManagedConnection,(req,res,next)=>next());
  app.post('/api/connections/categories/preview',requireConnectionManager,(req,res,next)=>next());
  app.use(['/api/radio','/api/youtube/resolve'],requireConnectionManager);
  app.get('/api/connection-capabilities',(req,res)=>res.json({googleConfigured:Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),canUseLocal:req.user.role==='owner'}));
  function settings(req) {
    return {
      serverName: process.env.SERVER_NAME || "TesPlay",
      version: "0.1.0",
      publicUrl,
      remoteEnabled,
      preferences: store.preferences(req.user.id),
    };
  }
  app.get("/api/settings", (req, res) => res.json(settings(req)));
  app.patch("/api/settings", (req, res) => {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some(
        (key) => !["preferences", "initializeYouTubeShorts"].includes(key),
      ) ||
      (Object.hasOwn(req.body, "initializeYouTubeShorts") &&
        req.body.initializeYouTubeShorts !== true)
    )
      throw httpError(400, "Choose valid account preferences.");
    store.savePreferences(req.user.id, req.body.preferences, {
      initializeYouTubeShorts: req.body.initializeYouTubeShorts === true,
    });
    res.json(settings(req));
  });
  if (options.registerProviders !== false) {
    const { registerProviderRoutes } = await import("./providers.js");
    await registerProviderRoutes(app, ctx, options.providerDependencies);
  }
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "That API endpoint does not exist." }),
  );
  const distDir = options.distDir ?? resolve(rootDir, "dist");
  if (existsSync(resolve(distDir, "index.html"))) {
    const shell = readFileSync(resolve(distDir, "index.html"), "utf8");
    const serveShell = (_req, res) => {
      res.set("Cache-Control", "no-store");
      res.type("html").send(production ? shell.replace(/<script\b/g, `<script nonce="${res.locals.cspNonce}"`) : shell);
    };
    app.get(["/", "/index.html"], serveShell);
    app.use(
      express.static(distDir, { index: false, maxAge: production ? "1h" : 0 }),
    );
    if(production) {
      const assetCache=resolve(options.dataDir??process.env.DATA_DIR??resolve(rootDir,"data"),"ui-assets");
      const assets=resolve(distDir,"assets");
      if(existsSync(assets))retainUiAssets(assets,assetCache);
      app.use("/assets",express.static(assetCache,{index:false,maxAge:"1h"}));
    }
    app.use("/assets",(req,res)=>res.sendStatus(404));
    app.get("/{*path}", serveShell);
  } else {
    app.get("/", (req, res) =>
      res
        .type("text")
        .send(
          "TesPlay server is running. Start the development app on port 5173, or run npm run build.",
        ),
    );
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status =
      error.type === "entity.parse.failed"
        ? 400
        : error.type === "entity.too.large"
          ? 413
          : Number.isInteger(error.status) &&
              error.status >= 400 &&
              error.status <= 599
            ? error.status
            : 500;
    const message =
      status === 500
        ? "The server could not complete this request."
        : error.type === "entity.parse.failed"
          ? "The request body is not valid JSON."
          : error.type === "entity.too.large"
            ? "This request is too large."
            : error.message;
    // Provider errors can contain credentials in request URLs. Never echo stack traces or URLs.
    if (status === 500 && !options.quiet)
      console.error("TesPlay request failed:", error.name ?? "Error");
    res.status(status).json({ error: message, ...(error.code?{code:error.code}:{}) });
  });
  return {
    app,
    store,
    setupToken,
    ctx,
    close() {
      qrAuth.close();
      remote.close();
      store.close();
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 4174);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be a number between 1 and 65535.");
  const instance = await createApp();
  const server = instance.app.listen(
    port,
    process.env.HOST || "127.0.0.1",
    () => {
      console.log(
        `TesPlay is ready on http://${process.env.HOST || "127.0.0.1"}:${port}`,
      );
      if (instance.store.setupRequired())
        console.log(
          `First-time setup token: ${instance.setupToken}\nKeep this token private. It is only valid until the owner account is created.`,
        );
    },
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      server.close(() => {
        instance.close();
        process.exit(0);
      });
      server.closeAllConnections();
    });
}
