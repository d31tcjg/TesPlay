import { initializeStoreSchema } from "./store-schema.js";
import { installBrowserSessions } from './browser-sessions.js';
import { validatePlayerPreferences, defaultPlayerPreferences } from './player-preferences.js';
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { allows } from "./access.js";
import { categoryLoaded, isIptv } from './iptv-selection.js';
import {
  loadEncryptionKey,
  encryptJSON,
  decryptJSON,
  hashToken,
  httpError,
  SESSION_LIFETIME_MS,
} from "./security.js";

const publicUser = (user) =>
  user ? { id: user.id, name: user.name, username: user.username, email: user.email, role: user.role || "owner", disabled: Boolean(user.disabled), canManageConnections:!user.disabled } : null;
const publicProfile = (profile) => ({
  id: profile.id,
  name: profile.name,
  color: profile.color,
});
const descriptions = {
  xtream: "Live TV, movies & series",
  m3u: "Your IPTV playlist",
  plex: "Your personal media server",
  drive: "Your Google Drive library",
  local: "Local & mounted network files",
  stremio: 'Your Stremio addons, movies & series',
  youtube: "YouTube videos & channels",
};
const itemKey = (item) =>
  `${item.connectionId ?? "public"}:${item.type}:${item.id}`;

export function createStore({ dataDir = resolve("data"), encryptionKey } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const key = loadEncryptionKey(dataDir, encryptionKey);
  const dbPath = resolve(dataDir, "aperture.sqlite");
  const db = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  initializeStoreSchema(db, { itemKey });
  const writePlayerPreferences = (profileId, value) => db.prepare(
    'INSERT INTO profile_player_preferences (profile_id,subtitle_language,subtitles_enabled,audio_language,quality_id) VALUES (?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET subtitle_language=excluded.subtitle_language,subtitles_enabled=excluded.subtitles_enabled,audio_language=excluded.audio_language,quality_id=excluded.quality_id',
  ).run(profileId, value.subtitleLanguage, Number(value.subtitlesEnabled), value.audioLanguage, value.qualityId);
  const browsers = installBrowserSessions(db);

  function profiles(userId) {
    return db
      .prepare("SELECT * FROM profiles WHERE user_id=? ORDER BY created_at,id")
      .all(userId)
      .map(publicProfile);
  }
  function setupRequired() {
    return !db.prepare("SELECT id FROM users LIMIT 1").get();
  }
  function createOwner({ name, email, username, passwordHash, playbackDefaults = defaultPlayerPreferences }) {
    const defaults = validatePlayerPreferences(playbackDefaults);
    if (!setupRequired())
      throw httpError(
        409,
        "This server already has an owner. Sign in instead.",
      );
    const id = randomUUID();
    const profileId = randomUUID();
    const timestamp = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!setupRequired())
        throw httpError(
          409,
          "This server already has an owner. Sign in instead.",
        );
      db.prepare(
        "INSERT INTO users (id,name,username,email,password_hash,created_at) VALUES (?,?,?,?,?,?)",
      ).run(id, name, username || email.split("@")[0], email || null, passwordHash, timestamp);
      db.prepare(
        "INSERT INTO profiles (id,user_id,name,color,created_at) VALUES (?,?,?,?,?)",
      ).run(profileId, id, name, "#d6ff5f", timestamp);
      writePlayerPreferences(profileId, defaults);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(id));
  }
  function createSession(userId, token, options = {}) {
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    const profile = profiles(userId)[0];
    const session = {
      id: randomUUID(),
      profileId: options.profileId || profile?.id || null,
      userId,
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
    };
    db.prepare(
      "INSERT INTO sessions (id,token_hash,user_id,profile_id,expires_at) VALUES (?,?,?,?,?)",
    ).run(
      session.id,
      hashToken(token),
      userId,
      session.profileId,
      session.expiresAt,
    );
    browsers.recordBrowser(session.id, options);
    return { ...session, scope: options.scope || "full", deviceMode: options.scope === "remote" ? "remote" : "browser", remoteRoomId: options.roomId || null };
  }
  function getSession(token) {
    if (typeof token !== "string" || token.length < 32 || token.length > 128)
      return null;
    const row = db
      .prepare(
        "SELECT s.id AS session_id,s.profile_id,s.expires_at,s.scope AS session_scope,s.device_mode,s.remote_room_id,s.parent_session_id,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0",
      )
      .get(hashToken(token), Date.now());
    if (!row) return null;
    const screen = row.remote_room_id ? browsers.screenById(row.remote_room_id) : null;
    if (row.session_scope === 'remote' && (!screen || screen.user_id !== row.id || screen.host_session_id !== row.parent_session_id)) return null;
    let profileId = screen && row.device_mode === 'remote' ? screen.profile_id : row.profile_id;
    if (!profileId) {
      profileId = profiles(row.id)[0]?.id ?? null;
      db.prepare("UPDATE sessions SET profile_id=? WHERE id=?").run(
        profileId,
        row.session_id,
      );
    }
    return {
      user: publicUser(row),
      session: {
        id: row.session_id,
        userId: row.id,
        profileId,
        expiresAt: row.expires_at,
        scope: row.session_scope,
        deviceMode: row.device_mode,
        remoteRoomId: screen?.id || null,
      },
    };
  }
  function publicConnection(row) {
    let authorization = {};
    if (isIptv(row)) {
      const config = decryptJSON(row.encrypted_config, key, `${row.user_id}:${row.id}`);
      if (Object.hasOwn(config, 'loadedCategories')) authorization.loadedCategories = config.loadedCategories;
    }
    if (row.type === "youtube") {
      const config = decryptJSON(
        row.encrypted_config,
        key,
        `${row.user_id}:${row.id}`,
      );
      authorization = {
        authMode:
          config.authMode === "apiKey" || config.authMode === "oauth"
            ? config.authMode
            : config.refreshToken
              ? "oauth"
              : "apiKey",
        oauthAuthorized: Boolean(config.refreshToken),
      };
    }
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      createdAt: row.created_at,
      configured: true,
      summary: descriptions[row.type] ?? "Connected media source",
      ...authorization,
    };
  }
  function getConnection(userId, id) {
    const row = db
      .prepare("SELECT * FROM connections WHERE id=? AND user_id=?")
      .get(String(id), userId);
    if (!row) throw httpError(404, "That connection was not found.");
    return {
      ...publicConnection(row),
      config: decryptJSON(
        row.encrypted_config,
        key,
        `${row.user_id}:${row.id}`,
      ),
    };
  }
  function listConnections(userId, decrypted = false) {
    const rows = db
      .prepare(
        "SELECT * FROM connections WHERE user_id=? ORDER BY created_at,id",
      )
      .all(userId);
    return rows.map((row) =>
      decrypted ? getConnection(userId, row.id) : publicConnection(row),
    );
  }
  function saveConnection(userId, value) {
    const existing = value.id ? getConnection(userId, value.id) : null;
    const id = existing?.id ?? randomUUID();
    const config = existing
      ? { ...existing.config, ...(value.config ?? {}) }
      : value.config;
    const type = existing?.type ?? value.type;
    const name = value.name ?? existing?.name ?? type;
    const encrypted = encryptJSON(config, key, `${userId}:${id}`);
    if (existing)
      db.prepare(
        "UPDATE connections SET name=?,encrypted_config=? WHERE id=? AND user_id=?",
      ).run(name, encrypted, id, userId);
    else
      db.prepare(
        "INSERT INTO connections (id,user_id,type,name,encrypted_config,created_at) VALUES (?,?,?,?,?,?)",
      ).run(id, userId, type, name, encrypted, new Date().toISOString());
    return publicConnection(
      db
        .prepare("SELECT * FROM connections WHERE id=? AND user_id=?")
        .get(id, userId),
    );
  }
  function favorites(profileId) {
    return db
      .prepare(
        "SELECT item FROM favorites WHERE profile_id=? ORDER BY created_at DESC",
      )
      .all(profileId)
      .map((row) => JSON.parse(row.item));
  }
  function visibleConnection(userId, id) {
    const user = db.prepare('SELECT role,disabled,independent FROM users WHERE id=?').get(userId);
    if (!user || user.disabled) throw httpError(403, 'This account is unavailable.');
    if (db.prepare('SELECT id FROM connections WHERE id=? AND user_id=?').get(String(id),userId))
      return { ...getConnection(userId,id), ownerId: userId };
    if (user.role === 'owner' || user.independent) throw httpError(404,'That connection was not found.');
    const row = db.prepare('SELECT c.user_id,g.access FROM connection_grants g JOIN connections c ON c.id=g.connection_id WHERE g.user_id=? AND c.id=?').get(userId,String(id));
    if (!row) throw httpError(403,'This connection is not shared with your account.');
    return { ...getConnection(row.user_id,id), ownerId: row.user_id, shared: true, access: JSON.parse(row.access) };
  }
  function visibleConnections(userId, decrypted=false) {
    const user = db.prepare('SELECT role,independent FROM users WHERE id=?').get(userId);
    if (user?.role === 'owner' || user?.independent) return listConnections(userId,decrypted);
    const shared = db.prepare('SELECT connection_id FROM connection_grants WHERE user_id=? ORDER BY rowid').all(userId).map(row => {
      const c=visibleConnection(userId,row.connection_id);
      if (decrypted) return c;
      const {config,ownerId,...publicValue}=c; return publicValue;
    });
    return [...listConnections(userId,decrypted), ...shared];
  }
  function visibleItem(userId, item) {
    // Old saved demo entries are not part of a connected library.
    if (!item.connectionId && item.source?.toLowerCase() === 'open cinema') return false;
    try { if (!item.connectionId) return Boolean(db.prepare("SELECT id FROM users WHERE id=? AND (role='owner' OR independent=1)").get(userId)); const c=visibleConnection(userId,item.connectionId); return categoryLoaded(c,item) && allows(c.access,item); }
    catch { return false; }
  }
  function queue(profileId) { return db.prepare('SELECT item FROM watch_queue WHERE profile_id=? ORDER BY position,rowid').all(profileId).map(r=>JSON.parse(r.item)); }
  function stars(profileId) { return db.prepare('SELECT metadata FROM profile_stars WHERE profile_id=? ORDER BY rowid').all(profileId).map(r=>JSON.parse(r.metadata)); }
  return {
    db,
    visibleConnection, visibleConnections, visibleItem, stars, queue,
    listAccounts() { return db.prepare("SELECT * FROM users ORDER BY created_at,id").all().map(u=>({...publicUser(u), grants: db.prepare("SELECT access FROM connection_grants WHERE user_id=?").all(u.id).map(r=>JSON.parse(r.access))})); },
    createMember({name,email,username,passwordHash,grants,independent=false,playbackDefaults=defaultPlayerPreferences}) {
      const defaults=validatePlayerPreferences(playbackDefaults);
      username = username || email.split("@")[0];
      if (db.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").get(username)) throw httpError(409,"An account already uses this username.");
      if (email && db.prepare("SELECT id FROM users WHERE email=?").get(email)) throw httpError(409,"An account already uses this email address.");
      const id=randomUUID(), profileId=randomUUID(), stamp=new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO users (id,role,name,username,email,password_hash,created_at,independent) VALUES (?,'member',?,?,?,?,?,?)").run(id,name,username,email || null,passwordHash,stamp,Number(independent));
        db.prepare("INSERT INTO profiles (id,user_id,name,color,created_at) VALUES (?,?,?,?,?)").run(profileId,id,name,"#658a73",stamp);
        writePlayerPreferences(profileId,defaults);
        for(const g of grants) db.prepare("INSERT INTO connection_grants VALUES (?,?,?)").run(id,g.connectionId,JSON.stringify(g));
        db.exec("COMMIT");
      } catch(e) { db.exec("ROLLBACK"); throw e; }
      return publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(id));
    },
    updateMember(id,{name,disabled,grants,passwordHash}) {
      const user=db.prepare("SELECT * FROM users WHERE id=? AND role='member'").get(id);
      if (!user) throw httpError(404,"That member account was not found.");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE users SET name=?,disabled=?,password_hash=? WHERE id=?").run(name??user.name,disabled===undefined?user.disabled:Number(disabled),passwordHash??user.password_hash,id);
        if (grants) { db.prepare("DELETE FROM connection_grants WHERE user_id=?").run(id); for(const g of grants) db.prepare("INSERT INTO connection_grants VALUES (?,?,?)").run(id,g.connectionId,JSON.stringify(g)); }
        if (passwordHash || disabled) db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
        db.exec("COMMIT");
      } catch(e) {db.exec("ROLLBACK");throw e;}
    },
    deleteMember(id) { if(!db.prepare("SELECT id FROM users WHERE id=? AND role='member'").get(id)) throw httpError(404,"That member account was not found."); db.prepare("DELETE FROM users WHERE id=?").run(id); },
    toggleStar(profileId,value) {
      const params=[profileId,value.connectionId,value.kind,value.id];
      if(db.prepare("SELECT item_id FROM profile_stars WHERE profile_id=? AND connection_id=? AND kind=? AND item_id=?").get(...params)) db.prepare("DELETE FROM profile_stars WHERE profile_id=? AND connection_id=? AND kind=? AND item_id=?").run(...params);
      else { if(stars(profileId).length>=500) throw httpError(400,"You can star up to 500 channels and categories."); db.prepare("INSERT INTO profile_stars VALUES (?,?,?,?,?)").run(...params,JSON.stringify(value)); }
      return stars(profileId);
    },
    updateQueue(profileId,action,item) {
      const key=item?itemKey(item):"";
      if(action==="clear") db.prepare("DELETE FROM watch_queue WHERE profile_id=?").run(profileId);
      else if(action==="remove") db.prepare("DELETE FROM watch_queue WHERE profile_id=? AND item_key=?").run(profileId,key);
      else if(action==="add") { if(queue(profileId).length>=100) throw httpError(400,"Your playlist can hold up to 100 videos."); db.prepare("INSERT OR IGNORE INTO watch_queue VALUES (?,?,?,COALESCE((SELECT MAX(position)+1 FROM watch_queue WHERE profile_id=?),0))").run(profileId,key,JSON.stringify(item),profileId); }
      else throw httpError(400,"Choose a playlist action.");
      return queue(profileId);
    },
    ...browsers,
    setupRequired,
    createOwner,
    createSession,
    getSession,
    profiles,
    getConnection,
    listConnections,
    saveConnection,
    close() {
      db.close();
    },
    readProviderCatalog(connectionId, resource, fingerprint) {
      const row = db.prepare('SELECT fingerprint,encrypted_value FROM provider_catalog_cache WHERE connection_id=? AND resource=?').get(connectionId, resource);
      if (!row || row.fingerprint !== fingerprint) return undefined;
      try { return decryptJSON(row.encrypted_value, key, `provider-catalog:v1:${connectionId}:${resource}`); }
      catch { return undefined; }
    },
    writeProviderCatalog(connectionId, resource, fingerprint, value) {
      const encrypted = encryptJSON(value, key, `provider-catalog:v1:${connectionId}:${resource}`);
      db.prepare('INSERT INTO provider_catalog_cache(connection_id,resource,fingerprint,encrypted_value,stored_at) VALUES(?,?,?,?,?) ON CONFLICT(connection_id,resource) DO UPDATE SET fingerprint=excluded.fingerprint,encrypted_value=excluded.encrypted_value,stored_at=excluded.stored_at').run(connectionId, resource, fingerprint, encrypted, Date.now());
      db.prepare("DELETE FROM provider_catalog_cache WHERE connection_id=? AND resource IN (SELECT resource FROM provider_catalog_cache WHERE connection_id=? AND resource LIKE 'series:%' ORDER BY stored_at DESC LIMIT -1 OFFSET 128)").run(connectionId,connectionId);
    },
    sealMedia(value) {
      const sealed = Buffer.from(
        encryptJSON(value, key, "media-resource:v1"),
        "base64",
      ).toString("base64url");
      if (sealed.length > 20_000)
        throw httpError(400, "The media reference is too large.");
      return sealed;
    },
    openMedia(token) {
      if (
        typeof token !== "string" ||
        token.length > 20_000 ||
        !/^[A-Za-z0-9_-]+$/.test(token)
      )
        throw httpError(404, "That media reference was not found.");
      try {
        return decryptJSON(
          Buffer.from(token, "base64url").toString("base64"),
          key,
          "media-resource:v1",
        );
      } catch {
        throw httpError(404, "That media reference was not found.");
      }
    },
    findUser(email) {
      return db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE").get(email,email);
    },
    findUserById(id) {
      return publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(id));
    },
    preferences(userId) {
      const row = db
        .prepare(
          "SELECT auto_play_next,hide_youtube_shorts FROM user_preferences WHERE user_id=?",
        )
        .get(userId);
      return {
        autoPlayNext: row ? Boolean(row.auto_play_next) : true,
        ...(row?.hide_youtube_shorts != null
          ? { hideYouTubeShorts: Boolean(row.hide_youtube_shorts) }
          : {}),
      };
    },
    savePreferences(userId, value, { initializeYouTubeShorts = false } = {}) {
      const fields =
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.keys(value)
          : [];
      if (
        !fields.length ||
        fields.some(
          (field) =>
            !["autoPlayNext", "hideYouTubeShorts"].includes(field) ||
            typeof value[field] !== "boolean",
        ) ||
        typeof initializeYouTubeShorts !== "boolean" ||
        (initializeYouTubeShorts &&
          (fields.length !== 1 || fields[0] !== "hideYouTubeShorts"))
      )
        throw httpError(400, "Choose valid account preferences.");
      if (initializeYouTubeShorts) {
        // A browser's legacy choice can initialize an unset account only. The
        // conditional write prevents another browser's saved choice being lost.
        db.prepare(
          "INSERT INTO user_preferences (user_id,auto_play_next,hide_youtube_shorts) VALUES (?,1,?) ON CONFLICT(user_id) DO UPDATE SET hide_youtube_shorts=excluded.hide_youtube_shorts WHERE user_preferences.hide_youtube_shorts IS NULL",
        ).run(userId, Number(value.hideYouTubeShorts));
      } else {
        const autoPlayNext = Object.hasOwn(value, "autoPlayNext")
          ? Number(value.autoPlayNext)
          : null;
        const hideYouTubeShorts = Object.hasOwn(value, "hideYouTubeShorts")
          ? Number(value.hideYouTubeShorts)
          : null;
        db.prepare(
          "INSERT INTO user_preferences (user_id,auto_play_next,hide_youtube_shorts) VALUES (?,COALESCE(?,1),?) ON CONFLICT(user_id) DO UPDATE SET auto_play_next=COALESCE(?,user_preferences.auto_play_next),hide_youtube_shorts=COALESCE(excluded.hide_youtube_shorts,user_preferences.hide_youtube_shorts)",
        ).run(userId, autoPlayNext, hideYouTubeShorts, autoPlayNext);
      }
      return this.preferences(userId);
    },
    playerPreferences(userId, profileId) {
      if (!db.prepare("SELECT id FROM profiles WHERE id=? AND user_id=?").get(profileId,userId)) throw httpError(404,"That profile was not found.");
      const row=db.prepare("SELECT * FROM profile_player_preferences WHERE profile_id=?").get(profileId);
      return { subtitleLanguage:row?.subtitle_language || null, subtitlesEnabled:Boolean(row?.subtitles_enabled), audioLanguage:row?.audio_language || null, qualityId:row?.quality_id || 'auto' };
    },
    savePlayerPreferences(userId, profileId, value) {
      const saved=validatePlayerPreferences(value,this.playerPreferences(userId,profileId));
      writePlayerPreferences(profileId,saved);
      return this.playerPreferences(userId,profileId);
    },
    deleteSession(id) {
      db.prepare("DELETE FROM sessions WHERE parent_session_id=?").run(id);
      db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    },
    createProfile(userId, name, color) {
      if (profiles(userId).length >= 8)
        throw httpError(400, "You can create up to eight profiles.");
      const id = randomUUID();
      db.prepare(
        "INSERT INTO profiles (id,user_id,name,color,created_at) VALUES (?,?,?,?,?)",
      ).run(id, userId, name, color, new Date().toISOString());
      return id;
    },
    selectProfile(userId, sessionId, id) {
      if (
        !db
          .prepare("SELECT id FROM profiles WHERE id=? AND user_id=?")
          .get(id, userId)
      )
        throw httpError(404, "That profile was not found.");
      db.prepare(
        "UPDATE sessions SET profile_id=?,remote_room_id=NULL,device_mode='browser' WHERE id=? AND user_id=?",
      ).run(id, sessionId, userId);
    },
    deleteProfile(userId, id) {
      if (
        !db
          .prepare("SELECT id FROM profiles WHERE id=? AND user_id=?")
          .get(id, userId)
      )
        throw httpError(404, "That profile was not found.");
      if (profiles(userId).length <= 1)
        throw httpError(400, "Keep at least one profile.");
      db.prepare("DELETE FROM profiles WHERE id=? AND user_id=?").run(
        id,
        userId,
      );
    },
    deleteConnection(userId, id) {
      getConnection(userId, id);
      db.prepare("DELETE FROM connections WHERE id=? AND user_id=?").run(
        id,
        userId,
      );
      for (const table of ["favorites", "progress"])
        db.prepare(
          `DELETE FROM ${table} WHERE profile_id IN (SELECT id FROM profiles WHERE user_id=?) AND json_extract(item,'$.connectionId')=?`,
        ).run(userId, id);
    },
    libraryState(profileId) {
      return {
        favorites: favorites(profileId),
        progress: db
          .prepare(
            "SELECT item,seconds,duration,updated_at FROM progress WHERE profile_id=? ORDER BY updated_at DESC LIMIT 500",
          )
          .all(profileId)
          .map((row) => ({
            item: JSON.parse(row.item),
            seconds: row.seconds,
            duration: row.duration,
            updatedAt: row.updated_at,
          })),
      };
    },
    toggleFavorite(profileId, item) {
      const key = itemKey(item);
      if (
        db
          .prepare(
            "SELECT item_key FROM favorites WHERE profile_id=? AND item_key=?",
          )
          .get(profileId, key)
      )
        db.prepare(
          "DELETE FROM favorites WHERE profile_id=? AND item_key=?",
        ).run(profileId, key);
      else {
        if (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM favorites WHERE profile_id=?",
            )
            .get(profileId).count >= 500
        )
          throw httpError(400, "Your list can contain up to 500 titles.");
        db.prepare(
          "INSERT INTO favorites (profile_id,item_key,item,created_at) VALUES (?,?,?,?)",
        ).run(profileId, key, JSON.stringify(item), new Date().toISOString());
      }
      return favorites(profileId);
    },
    saveProgress(profileId, item, seconds, duration) {
      db.prepare(
        "INSERT INTO progress (profile_id,item_key,item,seconds,duration,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(profile_id,item_key) DO UPDATE SET item=excluded.item,seconds=excluded.seconds,duration=excluded.duration,updated_at=excluded.updated_at",
      ).run(
        profileId,
        itemKey(item),
        JSON.stringify(item),
        seconds,
        duration,
        new Date().toISOString(),
      );
      db.prepare(
        "DELETE FROM progress WHERE profile_id=? AND item_key NOT IN (SELECT item_key FROM progress WHERE profile_id=? ORDER BY updated_at DESC LIMIT 500)",
      ).run(profileId, profileId);
    },
  };
}
