import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.js";

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "tesplay-library-identity-"));
  let store = createStore({ dataDir });
  const owner = store.createOwner({
    name: "Owner",
    email: "owner@example.com",
    passwordHash: "unused-test-hash",
  });
  const profileId = store.profiles(owner.id)[0].id;
  const connectionId = store.saveConnection(owner.id, {
    type: "xtream",
    name: "IPTV",
    config: { url: "https://provider.example" },
  }).id;
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    profileId,
    connectionId,
    restart() {
      store.close();
      store = createStore({ dataDir });
    },
  };
}

test("Xtream movie, live channel and series with the same ID keep separate favorites and progress", async (t) => {
  const f = await fixture(t);
  const items = ["movie", "live", "series"].map((type) => ({
    id: "1",
    type,
    title: `${type} one`,
    source: "IPTV",
    connectionId: f.connectionId,
  }));
  for (const [index, item] of items.entries()) {
    f.store.toggleFavorite(f.profileId, item);
    f.store.saveProgress(f.profileId, item, 10 + index, 100);
  }
  assert.equal(f.store.libraryState(f.profileId).favorites.length, 3);
  assert.equal(f.store.libraryState(f.profileId).progress.length, 3);
  f.store.saveProgress(f.profileId, items[0], 50, 100);
  assert.deepEqual(
    Object.fromEntries(
      f.store
        .libraryState(f.profileId)
        .progress.map((p) => [p.item.type, p.seconds]),
    ),
    { movie: 50, live: 11, series: 12 },
  );
  f.store.toggleFavorite(f.profileId, items[0]);
  assert.deepEqual(
    f.store
      .libraryState(f.profileId)
      .favorites.map((p) => p.type)
      .sort(),
    ["live", "series"],
  );
  f.restart();
  assert.equal(f.store.libraryState(f.profileId).progress.length, 3);
  assert.deepEqual(
    f.store
      .libraryState(f.profileId)
      .favorites.map((p) => p.type)
      .sort(),
    ["live", "series"],
  );
});

test("legacy keys migrate atomically, preserving distinct identities and the newest duplicate progress across restarts", async (t) => {
  const f = await fixture(t);
  const movie = {
    id: "1",
    type: "movie",
    title: "Original film title",
    source: "IPTV",
    connectionId: f.connectionId,
  };
  const latest = { ...movie, title: "Updated film title" };
  const collision = { ...movie, id: "movie:1", title: "Another film" };
  const live = { ...movie, type: "live", title: "Live channel one" };
  const entries = [
    {
      key: `${f.connectionId}:1`,
      item: movie,
      seconds: 20,
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    // This legacy key equals the first film's target key, but is a different ID.
    {
      key: `${f.connectionId}:movie:1`,
      item: collision,
      seconds: 40,
      timestamp: "2026-01-02T00:00:00.000Z",
    },
    {
      key: `${f.connectionId}:live:1`,
      item: live,
      seconds: 12,
      timestamp: "2026-01-03T00:00:00.000Z",
    },
    {
      key: `${f.connectionId}:legacy-alias:1`,
      item: latest,
      seconds: 80,
      timestamp: "2026-01-04T00:00:00.000Z",
    },
  ];
  for (const entry of entries) {
    f.store.db
      .prepare(
        "INSERT INTO favorites (profile_id,item_key,item,created_at) VALUES (?,?,?,?)",
      )
      .run(f.profileId, entry.key, JSON.stringify(entry.item), entry.timestamp);
    f.store.db
      .prepare(
        "INSERT INTO progress (profile_id,item_key,item,seconds,duration,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        f.profileId,
        entry.key,
        JSON.stringify(entry.item),
        entry.seconds,
        100,
        entry.timestamp,
      );
  }
  f.store.db.exec("PRAGMA user_version=0");
  f.restart();
  let state = f.store.libraryState(f.profileId);
  assert.equal(state.favorites.length, 3);
  assert.equal(state.progress.length, 3);
  assert.deepEqual(
    Object.fromEntries(
      state.progress.map((p) => [
        `${p.item.type}:${p.item.id}`,
        [p.seconds, p.item.title],
      ]),
    ),
    {
      "movie:1": [80, "Updated film title"],
      "movie:movie:1": [40, "Another film"],
      "live:1": [12, "Live channel one"],
    },
  );
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 1);
  f.store.toggleFavorite(f.profileId, latest);
  assert.equal(f.store.libraryState(f.profileId).favorites.length, 2);
  f.store.saveProgress(f.profileId, latest, 90, 100);
  f.restart();
  state = f.store.libraryState(f.profileId);
  assert.equal(state.favorites.length, 2);
  assert.equal(state.progress.length, 3);
  assert.equal(
    state.progress.find((p) => p.item.type === "movie" && p.item.id === "1")
      .seconds,
    90,
  );
});
