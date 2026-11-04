import { createHash } from "node:crypto";

export function createProviderCache(
  persistence = {},
  { now = Date.now } = {},
) {
  const cache = new Map();
  function remember(key, record) {
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    cache.set(key, record);
  }
  async function cached(key, get, seconds = 60) {
    if (cache.get(key)?.expires > now()) return cache.get(key).value;
    const value = await get();
    remember(key, { value, expires: now() + seconds * 1000 });
    return value;
  }
  const cacheKey = (c) =>
    `${c.id}:${createHash("sha256").update(JSON.stringify(c.config)).digest("hex")}`;
  const catalogFlights = new Map();
  // Catalogs remain usable until the user explicitly refreshes or changes the
  // connection. Persist raw data; access filtering and image authorization still
  // run for each request, so cached catalogs cannot bypass household grants.
  async function catalogCached(c, resource, get, force = false) {
    const fingerprint = cacheKey(c),
      key = `${fingerprint}:${resource}`;
    if (!force) {
      const existing =
        cache.get(key)?.catalog ??
        persistence.readProviderCatalog?.(c.id, resource, fingerprint);
      if (existing !== undefined) {
        remember(key, { catalog: existing });
        return existing;
      }
    }
    if (catalogFlights.has(key)) return catalogFlights.get(key);
    const flight = (async () => {
      const value = await get();
      persistence.writeProviderCatalog?.(c.id, resource, fingerprint, value);
      remember(key, { catalog: value });
      return value;
    })();
    catalogFlights.set(key, flight);
    try {
      return await flight;
    } finally {
      catalogFlights.delete(key);
    }
  }
  return { cached, cacheKey, catalogCached };
}
