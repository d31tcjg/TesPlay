import type { Connection, MediaItem } from './types';
import type { CatalogResult, LibraryShelf } from './library-browser';

export const isIptv = (c: Connection) => ['xtream', 'm3u'].includes(c.type);
export const supportsIptvKind = (c: Connection, kind: string) => isIptv(c) &&
  (c.type !== 'm3u' || kind === 'live') && (!c.access || c.access.kinds.includes(kind)) &&
  (!Array.isArray(c.loadedCategories) || c.loadedCategories.some(id => c.type === 'm3u' || id.startsWith(`${kind}:`)));

/** Bundle presentation only: real provider IDs stay on every playable item. */
export function bundleIptvShelves(shelves: LibraryShelf[]): LibraryShelf[] {
  const result: LibraryShelf[] = [];
  for (const shelf of shelves) {
    if (!isIptv(shelf.connection)) { result.push(shelf); continue; }
    const bundle = result.find(row => row.id === `iptv:${shelf.kind}`);
    if (bundle) bundle.items.push(...shelf.items);
    else result.push({ ...shelf, id: `iptv:${shelf.kind}`, title: 'IPTV', items: [...shelf.items] });
  }
  return result;
}

export type IptvCategory = { name: string; sources: { connectionId: string; id: string }[] };
export function bundleIptvCategories(results: Record<string, CatalogResult>): IptvCategory[] {
  const groups = new Map<string, IptvCategory>();
  for (const [connectionId, result] of Object.entries(results)) for (const category of result.categories || []) {
    const key = category.name.trim().toLowerCase();
    const group = groups.get(key) || { name: category.name, sources: [] };
    group.sources.push({ connectionId, id: category.id }); groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function bundleIptvItems(results: Record<string, CatalogResult>): MediaItem[] {
  return Object.values(results).flatMap(result => result.items).sort((a,b) => a.title.localeCompare(b.title));
}
