// Schema setup preserves the existing SQL, migration markers and transaction
// boundaries. Item identity comes from the live store so migrations use the same keys.

function migrateTypedLibraryKeys(db, itemKey) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("PRAGMA user_version").get().user_version < 1) {
      for (const table of ["favorites", "progress"]) {
        const timestamp = table === "favorites" ? "created_at" : "updated_at";
        const rows = db
          .prepare(`SELECT * FROM ${table} ORDER BY ${timestamp},rowid`)
          .all();
        const migrated = new Map();
        for (const row of rows) {
          row.item_key = itemKey(JSON.parse(row.item));
          // If rows represent the same item under different keys, retain its
          // newest metadata and watch position.
          migrated.set(JSON.stringify([row.profile_id, row.item_key]), row);
        }
        // A full rewrite within the transaction also handles old keys that
        // happen to equal another item's new key without temporary collisions.
        db.exec(`DELETE FROM ${table}`);
        const columns =
          table === "favorites"
            ? ["profile_id", "item_key", "item", "created_at"]
            : [
                "profile_id",
                "item_key",
                "item",
                "seconds",
                "duration",
                "updated_at",
              ];
        const insert = db.prepare(
          `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        );
        for (const row of migrated.values())
          insert.run(...columns.map((column) => row[column]));
      }
      db.exec("PRAGMA user_version=1");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createBaseSchema(db) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','member')), disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)), name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS profiles_user ON profiles(user_id);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT UNIQUE NOT NULL, token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS user_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, auto_play_next INTEGER NOT NULL DEFAULT 1 CHECK(auto_play_next IN (0,1)), hide_youtube_shorts INTEGER CHECK(hide_youtube_shorts IN (0,1)));
    CREATE TABLE IF NOT EXISTS profile_player_preferences (profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE, subtitle_language TEXT, subtitles_enabled INTEGER NOT NULL DEFAULT 0 CHECK(subtitles_enabled IN (0,1)), audio_language TEXT, quality_id TEXT NOT NULL DEFAULT 'auto' CHECK(quality_id IN ('auto','1080p','720p','480p')));
    CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, name TEXT NOT NULL, encrypted_config TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS connections_user ON connections(user_id);
    CREATE TABLE IF NOT EXISTS provider_catalog_cache (connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, resource TEXT NOT NULL, fingerprint TEXT NOT NULL, encrypted_value TEXT NOT NULL, stored_at INTEGER NOT NULL, PRIMARY KEY(connection_id,resource));
    CREATE TABLE IF NOT EXISTS favorites (profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, item_key TEXT NOT NULL, item TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(profile_id,item_key));
    CREATE TABLE IF NOT EXISTS progress (profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, item_key TEXT NOT NULL, item TEXT NOT NULL, seconds REAL NOT NULL, duration REAL NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(profile_id,item_key));
  `);
}

function migrateLegacyUsers(db) {
  // Rebuild the legacy singleton table without changing IDs or its dependent rows.
  if (
    !db
      .prepare("PRAGMA table_info(users)")
      .all()
      .some((c) => c.name === "role")
  ) {
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE users_new (id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','member')), disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)), name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO users_new (id,name,email,password_hash,created_at) SELECT id,name,email,password_hash,created_at FROM users;
        DROP TABLE users; ALTER TABLE users_new RENAME TO users; COMMIT;`);
    } catch (e) {
      db.exec("ROLLBACK");
      db.close();
      throw e;
    }
    db.exec("PRAGMA foreign_keys=ON");
  }
  // Keep old email logins working while new accounts use usernames only.
  if (
    !db
      .prepare("PRAGMA table_info(users)")
      .all()
      .some((c) => c.name === "username")
  ) {
    const users = db
      .prepare("SELECT * FROM users ORDER BY created_at,id")
      .all();
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    try {
      db.exec(
        `CREATE TABLE users_username (id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','member')), disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)), name TEXT NOT NULL, username TEXT NOT NULL COLLATE NOCASE UNIQUE, email TEXT UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);`,
      );
      const used = new Set();
      for (const user of users) {
        const base = (
          user.email
            .split("@")[0]
            .toLowerCase()
            .replace(/[^a-z0-9._-]/g, "")
            .slice(0, 30) || "user"
        ).padEnd(3, "_");
        let username = base,
          suffix = 1;
        while (used.has(username)) username = `${base}${suffix++}`;
        used.add(username);
        db.prepare("INSERT INTO users_username VALUES (?,?,?,?,?,?,?,?)").run(
          user.id,
          user.role,
          user.disabled,
          user.name,
          username,
          user.email,
          user.password_hash,
          user.created_at,
        );
      }
      db.exec(
        "DROP TABLE users; ALTER TABLE users_username RENAME TO users; COMMIT",
      );
    } catch (e) {
      db.exec("ROLLBACK");
      db.close();
      throw e;
    }
    db.exec("PRAGMA foreign_keys=ON");
  }
}

function createSharedLibrarySchema(db) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS single_owner ON users(role) WHERE role='owner';
    CREATE TABLE IF NOT EXISTS connection_grants (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, access TEXT NOT NULL, PRIMARY KEY(user_id,connection_id));
    CREATE TABLE IF NOT EXISTS profile_stars (profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, kind TEXT NOT NULL, item_id TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(profile_id,connection_id,kind,item_id));
    CREATE TABLE IF NOT EXISTS watch_queue (profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, item_key TEXT NOT NULL, item TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(profile_id,item_key));
  `);
}

function migrateSavedLibraries(db, itemKey) {
  try {
    migrateTypedLibraryKeys(db, itemKey);
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)",
    );
    if (
      !db
        .prepare(
          "SELECT name FROM schema_migrations WHERE name='youtube-watch-playlist'",
        )
        .get()
    ) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const rows = db
          .prepare(
            "SELECT f.* FROM favorites f JOIN connections c ON json_extract(f.item,'$.connectionId')=c.id WHERE c.type='youtube' ORDER BY f.created_at,f.rowid",
          )
          .all();
        for (const row of rows) {
          db.prepare(
            "INSERT OR IGNORE INTO watch_queue VALUES (?,?,?,COALESCE((SELECT MAX(position)+1 FROM watch_queue WHERE profile_id=?),0))",
          ).run(row.profile_id, row.item_key, row.item, row.profile_id);
          db.prepare(
            "DELETE FROM favorites WHERE profile_id=? AND item_key=?",
          ).run(row.profile_id, row.item_key);
        }
        db.prepare(
          "INSERT INTO schema_migrations VALUES ('youtube-watch-playlist')",
        ).run();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }
}

function migratePlayerPreferences(db) {
  const playerColumns = new Set(
    db
      .prepare("PRAGMA table_info(profile_player_preferences)")
      .all()
      .map((column) => column.name),
  );
  if (!playerColumns.has("audio_language"))
    db.exec(
      "ALTER TABLE profile_player_preferences ADD COLUMN audio_language TEXT",
    );
  if (!playerColumns.has("quality_id"))
    db.exec(
      "ALTER TABLE profile_player_preferences ADD COLUMN quality_id TEXT NOT NULL DEFAULT 'auto' CHECK(quality_id IN ('auto','1080p','720p','480p'))",
    );
}

function migrateAccountPreferences(db) {
  if (
    !db
      .prepare("PRAGMA table_info(user_preferences)")
      .all()
      .some((column) => column.name === "hide_youtube_shorts")
  )
    db.exec(
      "ALTER TABLE user_preferences ADD COLUMN hide_youtube_shorts INTEGER CHECK(hide_youtube_shorts IN (0,1))",
    );
}

export function initializeStoreSchema(db, { itemKey }) {
  createBaseSchema(db);
  migrateLegacyUsers(db);
  if(!db.prepare('PRAGMA table_info(users)').all().some(column=>column.name==='independent'))
    db.exec('ALTER TABLE users ADD COLUMN independent INTEGER NOT NULL DEFAULT 0 CHECK(independent IN (0,1))');
  createSharedLibrarySchema(db);
  migrateSavedLibraries(db, itemKey);
  migratePlayerPreferences(db);
  migrateAccountPreferences(db);
}
