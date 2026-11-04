import { randomToken, httpError } from './security.js';

export function browserLabel(value = '') {
  const ua = String(value).slice(0, 1000);
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const device = /Tesla/i.test(ua) ? 'Tesla' : /iPad/i.test(ua) ? 'iPad' : /iPhone/i.test(ua) ? 'iPhone' : /Android/i.test(ua) ? 'Android' : /Macintosh/i.test(ua) ? 'Mac' : /Windows/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : 'Unknown device';
  return { browser, device, name: `${browser} on ${device}` };
}

export function installBrowserSessions(db) {
  const fields = { browser_name: "TEXT NOT NULL DEFAULT 'Browser'", device_name: "TEXT NOT NULL DEFAULT 'Unknown device'", authorized_at: 'INTEGER NOT NULL DEFAULT 0', last_seen: 'INTEGER NOT NULL DEFAULT 0', scope: "TEXT NOT NULL DEFAULT 'full'", device_mode: "TEXT NOT NULL DEFAULT 'browser'", remote_room_id: 'TEXT', parent_session_id: 'TEXT' };
  const existing = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(x => x.name));
  for (const [name, definition] of Object.entries(fields)) if (!existing.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
  db.exec(`CREATE TABLE IF NOT EXISTS remote_screens (
    id TEXT PRIMARY KEY, host_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL, joined INTEGER NOT NULL DEFAULT 0
  )`);
  const sessionById = id => typeof id !== 'string' ? null : db.prepare('SELECT * FROM sessions WHERE id=? AND expires_at>?').get(id, Date.now());
  const screenById = id => typeof id !== 'string' ? null : db.prepare(`SELECT r.*, s.expires_at, s.browser_name, s.device_name FROM remote_screens r JOIN sessions s ON s.id=r.host_session_id JOIN users u ON u.id=r.user_id WHERE r.id=? AND s.expires_at>? AND u.disabled=0 AND s.scope='full' AND s.device_mode='screen' AND s.profile_id=r.profile_id`).get(id, Date.now());
  return {
    sessionById,
    screenById,
    recordBrowser(id, options = {}) {
      const label = browserLabel(options.userAgent);
      db.prepare('UPDATE sessions SET browser_name=?,device_name=?,authorized_at=?,last_seen=?,scope=?,device_mode=?,remote_room_id=?,parent_session_id=? WHERE id=?').run(label.browser, label.device, Date.now(), Date.now(), options.scope || 'full', options.scope === 'remote' ? 'remote' : 'browser', options.roomId || null, options.parentSessionId || null, id);
    },
    touchBrowser(id, userAgent) {
      const row = sessionById(id);
      if (!row) return;
      if (!row.last_seen || Date.now() - row.last_seen >= 60000) db.prepare('UPDATE sessions SET last_seen=? WHERE id=?').run(Date.now(), id);
      if (row.device_name === 'Unknown device' && userAgent) {
        const label = browserLabel(userAgent);
        db.prepare('UPDATE sessions SET browser_name=?,device_name=? WHERE id=?').run(label.browser, label.device, id);
      }
    },
    listBrowsers(userId, currentId) {
      return db.prepare('SELECT s.*,p.name AS profile_name FROM sessions s LEFT JOIN profiles p ON p.id=s.profile_id WHERE s.user_id=? AND s.expires_at>? ORDER BY s.last_seen DESC,s.id').all(userId, Date.now()).filter(row => row.scope !== 'remote' || screenById(row.remote_room_id)).map(row => ({id:row.id,name:`${row.browser_name} on ${row.device_name}`,browser:row.browser_name,device:row.device_name,role:row.device_mode,scope:row.scope,current:row.id===currentId,profile:row.profile_name || '',authorizedAt:row.authorized_at ? new Date(row.authorized_at).toISOString() : null,lastSeen:row.last_seen ? new Date(row.last_seen).toISOString() : null,expiresAt:new Date(row.expires_at).toISOString(),screen:row.remote_room_id ? (() => {const s=screenById(row.remote_room_id);return s ? `${s.browser_name} on ${s.device_name}` : null;})() : null}));
    },
    deleteBrowser(userId, id) {
      const row = sessionById(id);
      if (!row || row.user_id !== userId) throw httpError(404, 'This browser authorization was not found.');
      this.deleteSession(id);
    },
    ensureScreen(req) {
      let screen = db.prepare('SELECT * FROM remote_screens WHERE host_session_id=?').get(req.session.id);
      if (screen && screen.profile_id !== req.session.profileId) {
        db.prepare('DELETE FROM sessions WHERE scope=\'remote\' AND remote_room_id=?').run(screen.id);
        db.prepare('DELETE FROM remote_screens WHERE id=?').run(screen.id);
        screen = null;
      }
      if (!screen) {
        screen = {id:randomToken(24),host_session_id:req.session.id,user_id:req.user.id,profile_id:req.session.profileId,created_at:Date.now(),joined:0};
        db.prepare('INSERT INTO remote_screens(id,host_session_id,user_id,profile_id,created_at) VALUES(?,?,?,?,?)').run(screen.id,screen.host_session_id,screen.user_id,screen.profile_id,screen.created_at);
      }
      db.prepare("UPDATE sessions SET device_mode='screen',remote_room_id=NULL WHERE id=?").run(req.session.id);
      return screenById(screen.id);
    },
    listScreens(userId) { return db.prepare('SELECT id FROM remote_screens WHERE user_id=?').all(userId).map(row=>screenById(row.id)).filter(Boolean); },
    joinScreen(id) { db.prepare('UPDATE remote_screens SET joined=1 WHERE id=?').run(id); },
    screenHasRemote(id) {
      return Boolean(db.prepare("SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.remote_room_id=? AND s.device_mode='remote' AND s.expires_at>? AND u.disabled=0 LIMIT 1").get(id,Date.now()));
    },
    disconnectScreen(req) {
      const screen=db.prepare('SELECT * FROM remote_screens WHERE host_session_id=?').get(req.session.id);
      if (!screen) throw httpError(404,'This screen is unavailable.');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("DELETE FROM sessions WHERE scope='remote' AND remote_room_id=?").run(screen.id);
        db.prepare("UPDATE sessions SET device_mode='browser',remote_room_id=NULL WHERE remote_room_id=?").run(screen.id);
        db.prepare('DELETE FROM remote_screens WHERE id=?').run(screen.id);
        db.exec('COMMIT');
      } catch(error) {db.exec('ROLLBACK');throw error;}
      return screen.id;
    },
    setRemoteBrowser(req, screen) {
      if (screen.user_id !== req.user.id || screen.host_session_id === req.session.id) throw httpError(404, 'Choose another screen from your account.');
      db.prepare("UPDATE sessions SET device_mode='remote',remote_room_id=? WHERE id=?").run(screen.id,req.session.id);
    },
    disconnectRemote(req) { db.prepare("UPDATE sessions SET device_mode='browser',remote_room_id=NULL WHERE id=?").run(req.session.id); },
  };
}
