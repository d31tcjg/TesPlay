import { randomInt } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { randomToken, httpError, hashToken, constantTimeEqual } from "./security.js";
import { registerRemoteMediaRoutes } from "./remote-media.js";

const PAIR_LIFETIME = 5 * 60 * 1000;

export function registerRemoteRoutes(
  app,
  { enabled = true, store, getProfileId, validateRemoteItem, requireAuth, startRemoteSession, authStatus, dataDir, media, mediaDependencies },
) {
  const rooms = new Map();
  const codes = new Map();
  let remoteMedia;
  const pairLimit = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => req.user.id,
    message: { error: "Too many pairing attempts. Try again in a minute." },
  });
  const commandLimit = rateLimit({
    windowMs: 10_000,
    limit: 100,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => req.user.id,
    message: { error: "Slow down remote commands for a moment." },
  });
  const stateLimit = rateLimit({
    windowMs: 10_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => req.user.id,
  });

  function removeRoom(room) {
    remoteMedia?.discardRoom(room.id);
    for (const [code, challenge] of codes) if (challenge.roomId === room.id) codes.delete(code);
    rooms.delete(room.id);
    for (const client of room.clients) client.res.end();
    room.clients.clear();
  }
  function prune() {
    for (const room of rooms.values())
      if (!store.screenById(room.id)) removeRoom(room);
    for (const [code, challenge] of codes) if (challenge.expiresAt < Date.now()) codes.delete(code);
  }
  function requireEnabled(req, res, next) {
    return enabled
      ? next()
      : next(httpError(404, "Phone remote is disabled on this server."));
  }
  function hydrate(screen) {
    if (!screen) return null;
    let room = rooms.get(screen.id);
    if (!room) { room = { id:screen.id, userId:screen.user_id, profileId:screen.profile_id, hostSessionId:screen.host_session_id, createdAt:screen.created_at, expiresAt:screen.expires_at, joined:Boolean(screen.joined), clients:new Set(), state:null, stateUpdatedAt:0 }; rooms.set(room.id,room); }
    return room;
  }
  function findRoom(req, id) {
    prune();
    const room = hydrate(store.screenById(id));
    if (!room || room.userId !== req.user.id || room.profileId !== getProfileId(req) || req.session.scope === 'remote' && req.session.remoteRoomId !== room.id)
      throw httpError(404, 'This remote session is unavailable. Use the same account and profile as the screen, then connect again.');
    return room;
  }
  const full = (req,_res,next) => req.session.scope === 'remote' ? next(httpError(403,'This browser is authorized as a remote only.')) : next();
  function join(room) {room.joined=true;store.joinScreen(room.id);for(const client of room.clients)client.res.write(`event: paired\ndata: ${JSON.stringify({roomId:room.id})}\n\n`);}

  // QR redemption is intentionally available before the application's login gate.
  const redeemLimit = rateLimit({windowMs:60000,limit:10,standardHeaders:'draft-8',legacyHeaders:false});
  app.post('/api/auth/remote/redeem', requireEnabled, redeemLimit, (req,res) => {
    prune(); const code=String(req.body?.code || ''),token=req.body?.token;
    const challenge=codes.get(code), screen=challenge && store.screenById(challenge.roomId);
    if (!screen || typeof token !== 'string' || token.length < 32 || token.length > 128 || !constantTimeEqual(hashToken(token),challenge.tokenHash)) throw httpError(410,'This remote QR has expired or was already used. Open a new QR on the screen.');
    startRemoteSession(req,res,screen);
    codes.delete(code);
    const room=hydrate(screen);join(room);
    res.json({...authStatus(req),roomId:room.id});
  });
  app.use('/api/remote', requireAuth);
  remoteMedia = registerRemoteMediaRoutes(app, { dataDir, media, findRoom, requireEnabled, dependencies: mediaDependencies });
  app.post('/api/remote/screen',requireEnabled,full,(req,res)=>{const room=hydrate(store.ensureScreen(req));res.json({roomId:room.id});});
  app.post('/api/remote/screen/disconnect',requireEnabled,full,(req,res)=>{
    const room=findRoom(req,req.body?.roomId);
    if(room.hostSessionId!==req.session.id)throw httpError(403,'Only this screen can disconnect its remotes.');
    store.disconnectScreen(req);removeRoom(room);
    const replacement=hydrate(store.ensureScreen(req));
    res.json({roomId:replacement.id});
  });
  app.get('/api/remote/screens',requireEnabled,full,(req,res)=>res.json({screens:store.listScreens(req.user.id).filter(s=>s.host_session_id!==req.session.id).map(s=>{const r=rooms.get(s.id);return{id:s.id,name:`${s.browser_name} on ${s.device_name}`,online:Boolean(r?.clients.size),profileId:s.profile_id};})}));
  app.post('/api/remote/connect',requireEnabled,full,(req,res)=>{
    const screen=store.screenById(req.body?.screenId);
    if (!screen || screen.user_id!==req.user.id || screen.host_session_id===req.session.id) throw httpError(404,'This screen is unavailable.');
    store.setRemoteBrowser(req,screen);const room=hydrate(screen);join(room);
    req.session.profileId=screen.profile_id;req.session.deviceMode='remote';req.session.remoteRoomId=screen.id;
    res.json({...authStatus(req),roomId:room.id});
  });
  app.post('/api/remote/disconnect',requireEnabled,full,(req,res)=>{store.disconnectRemote(req);req.session=store.getSession(req.cookies.aperture_session).session;res.json(authStatus(req));});
  app.post('/api/remote/pair',requireEnabled,full,pairLimit,(req,res)=>{
    prune();const room=hydrate(store.ensureScreen(req));
    for(const [key,challenge] of codes)if(challenge.roomId===room.id)codes.delete(key);
    let code;do{code=String(randomInt(100000,1000000));}while(codes.has(code));
    const token=randomToken(),expiresAt=Date.now()+PAIR_LIFETIME;
    codes.set(code,{roomId:room.id,tokenHash:hashToken(token),expiresAt});
    res.json({code,token,roomId:room.id,expiresAt:new Date(expiresAt).toISOString()});
  });
  // Manual codes remain an account-authenticated fallback.
  app.post('/api/remote/join',requireEnabled,full,pairLimit,(req,res)=>{
    prune();const code=String(req.body?.code??'').replace(/\s/g,''),challenge=codes.get(code);
    const room=findRoom(req,challenge?.roomId);codes.delete(code);if(room.hostSessionId!==req.session.id){store.setRemoteBrowser(req,store.screenById(room.id));req.session.deviceMode='remote';req.session.remoteRoomId=room.id;}join(room);res.json({...authStatus(req),roomId:room.id});
  });

  app.get("/api/remote/events", requireEnabled, (req, res) => {
    const room = findRoom(req, req.query.roomId);
    if (room.hostSessionId !== req.session.id || req.session.scope === "remote")
      throw httpError(
        403,
        "Only the paired screen receives playback commands.",
      );
    if (room.clients.size >= 4)
      throw httpError(429, "Too many devices are connected to this remote.");
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const client = {
      res,
      sessionId: req.session.id,
      sessionToken: req.cookies.aperture_session,
    };
    room.clients.add(client);
    res.write(
      `event: ready\ndata: ${JSON.stringify({ roomId: room.id, paired: store.screenHasRemote(room.id) })}\n\n`,
    );
    const heartbeat = setInterval(() => {
      if (
        room.expiresAt < Date.now() ||
        !store.getSession(client.sessionToken) ||
        store.getSession(client.sessionToken)?.session.profileId !==
          room.profileId
      )
        return res.end();
      res.write(": heartbeat\n\n");
    }, 25_000);
    heartbeat.unref();
    res.on("close", () => {
      clearInterval(heartbeat);
      room.clients.delete(client);
    });
  });

  app.post("/api/remote/command", requireEnabled, commandLimit, (req, res) => {
    const room = findRoom(req, req.body?.roomId);
    if (!room.joined)
      throw httpError(409, "Pair a phone before sending remote commands.");
    const { command, value } = req.body;
    if (
      ![
        "play",
        "pause",
        "seek",
        "seek-to",
        "volume",
        "mute",
        "captions",
        "rate",
        "fullscreen",
        "load",
        "queue-changed",
      ].includes(command)
    )
      throw httpError(400, "Unknown remote command.");
    if (
      command === "seek" &&
      (!Number.isFinite(value) || value < -3600 || value > 3600)
    )
      throw httpError(
        400,
        "Seek must be a relative offset between -3600 and 3600 seconds.",
      );
    if (
      command === "volume" &&
      (!Number.isFinite(value) || value < 0 || value > 1)
    )
      throw httpError(400, "Volume must be between zero and one.");
    if (
      command === "seek-to" &&
      (!Number.isFinite(value) || value < 0 || value > 604800)
    )
      throw httpError(400, "Choose a valid playback position.");
    if (command === "mute" && ![0, 1].includes(value))
      throw httpError(400, "Choose whether sound is muted.");
    if (
      command === "rate" &&
      ![0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(value)
    )
      throw httpError(400, "Choose a supported playback speed.");
    if (!room.clients.size)
      throw httpError(
        409,
        "Your screen is offline. Open TesPlay there; your remote will reconnect automatically.",
      );
    const item = command === "load" ? validateRemoteItem(req) : undefined;
    if (item && ["series", "folder"].includes(item.type))
      throw httpError(
        400,
        "Choose a playable title, rather than a library folder.",
      );
    const sourceId = req.body?.settings?.sourceId;
    if (sourceId !== undefined && (typeof sourceId !== 'string' || !/^(auto|[a-f0-9]{32})$/.test(sourceId))) throw httpError(400, 'Choose a valid playback source.');
    const event = {
      command,
      ...(item && sourceId ? {settings:{sourceId}} : {}),
      ...(item ? { item } : {}),
      ...(["seek", "seek-to", "volume", "mute", "rate"].includes(command)
        ? { value }
        : {}),
    };
    for (const client of room.clients)
      client.res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.json({ ok: true });
  });

  // Only the paired screen may publish telemetry; phones receive an allowlist
  // of display metadata, never media addresses or provider credentials.
  app.post("/api/remote/state", requireEnabled, stateLimit, (req, res) => {
    const room = findRoom(req, req.body?.roomId);
    if (room.hostSessionId !== req.session.id || req.session.scope === "remote")
      throw httpError(403, "Only the paired screen can update playback state.");
    const state = req.body?.state;
    if (
      !state ||
      ![
        "idle",
        "loading",
        "ready",
        "playing",
        "paused",
        "seeking",
        "stalled",
        "ended",
        "stopped",
        "error",
        "destroyed",
      ].includes(state.phase)
    )
      throw httpError(400, "Choose a valid playback state.");
    const clean = { phase: state.phase };
    for (const key of [
      "positionSeconds",
      "durationSeconds",
      "seekableStartSeconds",
      "seekableEndSeconds",
      "volume",
      "playbackRate",
    ]) {
      const value = state[key];
      const max = key === "volume" ? 1 : key === "playbackRate" ? 4 : 604800;
      if (
        value === null &&
        [
          "durationSeconds",
          "seekableStartSeconds",
          "seekableEndSeconds",
        ].includes(key)
      )
        clean[key] = null;
      else if (
        !Number.isFinite(value) ||
        value < (key === "playbackRate" ? 0.25 : 0) ||
        value > max
      )
        throw httpError(400, "Playback state contains an invalid value.");
      else clean[key] = value;
    }
    for (const key of [
      "muted",
      "isLive",
      "needsAudioUnlock",
      "fullscreen",
      "subtitlesAvailable",
      "subtitlesEnabled",
    ]) {
      if (typeof state[key] !== "boolean")
        throw httpError(400, "Playback state contains an invalid flag.");
      clean[key] = state[key];
    }
    let item = null;
    if(state.fullscreenLocked!==undefined && typeof state.fullscreenLocked!=="boolean")
      throw httpError(400,"Playback state contains an invalid flag.");
    clean.fullscreenLocked=state.fullscreenLocked===true;
    if (req.body.item) {
      const validated = validateRemoteItem(req);
      item = Object.fromEntries(
        [
          "id",
          "connectionId",
          "title",
          "type",
          "source",
          "poster",
          "backdrop",
          "year",
          "providerType",
        ]
          .filter((key) => validated[key] !== undefined)
          .map((key) => [key, validated[key]]),
      );
    }
    room.state = { ...clean, item };
    room.stateUpdatedAt = Date.now();
    res.json({ ok: true });
  });
  app.get("/api/remote/state", requireEnabled, (req, res) => {
    const room = findRoom(req, req.query.roomId);
    res
      .set("Cache-Control", "no-store")
      .json({
        state: room.state,
        paired: store.screenHasRemote(room.id),
        online:
          room.clients.size > 0 && Date.now() - room.stateUpdatedAt < 12000,
      });
  });

  return {
    validateMediaItem: (req, item) => remoteMedia.validateItem(req, item),
    authorizeMedia: (req, resource) => remoteMedia.authorize(req, resource),
    close() {
      remoteMedia.close();
      for (const room of [...rooms.values()]) removeRoom(room);
    },
    closeSession(sessionId) {
      for (const room of [...rooms.values()]) {
        if (room.hostSessionId === sessionId) {removeRoom(room);continue;}
        for (const client of [...room.clients]) if (client.sessionId === sessionId) client.res.end();
      }
    },
  };
}
