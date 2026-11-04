import { itemKey } from './types';
import type { Connection, Library, MediaItem } from './types';

const shortKinds = new Set(['short', 'shorts', 'reel', 'reels']);

function knownDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function measuredDurations(progress: Library['progress']): ReadonlyMap<string, number> {
  const durations = new Map<string, number>();
  for (const entry of progress) {
    if (knownDuration(entry.duration)) durations.set(itemKey(entry.item), entry.duration);
  }
  return durations;
}

function withMeasuredDuration(item: MediaItem, durations: ReadonlyMap<string, number>): MediaItem {
  if (knownDuration(item.duration)) return item;
  const duration = durations.get(itemKey(item));
  return duration === undefined ? item : { ...item, duration };
}

function visibilityWithProgress(hide: boolean, connections: Connection[], progress: Library['progress']) {
  const durations = measuredDurations(hide ? progress : []);
  return (item: MediaItem) => youtubeItemVisible(withMeasuredDuration(item, durations), hide, connections);
}

function youtubeShortsUrl(item: MediaItem): boolean {
  for (const value of [item.playbackUrl, item.externalUrl]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(url.hostname.toLowerCase())
        && /^\/shorts\/[^/]+\/?$/i.test(url.pathname)) return true;
    } catch { /* Relative media endpoints and absent URLs do not identify Shorts. */ }
  }
  return false;
}

/** Discovery visibility; explicit playback and saved library data remain independent. */
export function youtubeItemVisible(item: MediaItem, hide: boolean, connections: Connection[] = []): boolean {
  if (!hide || item.type !== 'video') return true;
  const shortsUrl = youtubeShortsUrl(item);
  const youtube = shortsUrl || item.providerType?.toLowerCase() === 'youtube' || item.source?.toLowerCase() === 'youtube'
    || connections.some(connection => connection.id === item.connectionId && connection.type === 'youtube');
  if (!youtube) return true;
  if (shortsUrl || shortKinds.has(item.contentKind?.trim().toLowerCase() || '')) return false;
  // Unknown length stays visible. A short ordinary upload also matches this heuristic.
  return !(knownDuration(item.duration) && item.duration <= 180);
}

export function filterYouTubeItems(items: MediaItem[], hide: boolean, connections: Connection[] = [], progress: Library['progress'] = []): MediaItem[] {
  return hide ? items.filter(visibilityWithProgress(hide, connections, progress)) : items;
}

export function filterYouTubeShelves<T extends { items: MediaItem[] }>(shelves: T[], hide: boolean, connections: Connection[] = [], progress: Library['progress'] = []): T[] {
  const visible = visibilityWithProgress(hide, connections, progress);
  return shelves.map(shelf => ({ ...shelf, items: hide ? shelf.items.filter(visible) : shelf.items }))
    .filter(shelf => shelf.items.length > 0);
}

export function filterLibraryForYouTubeVisibility(library: Library, hide: boolean, connections: Connection[] = []): Library {
  if (!hide) return library;
  const visible = visibilityWithProgress(hide, connections, library.progress);
  return {
    ...library,
    favorites: library.favorites.filter(visible),
    ...(library.queue ? { queue: library.queue.filter(visible) } : {}),
    ...(library.plexWatchlist ? { plexWatchlist: library.plexWatchlist.filter(visible) } : {}),
    progress: library.progress.filter(entry => visible(entry.item)),
  };
}

export function visibleQueueNeighbors(queue: MediaItem[], current: MediaItem, hide: boolean, connections: Connection[] = [], progress: Library['progress'] = []): {
  inQueue: boolean;
  previous?: MediaItem;
  next?: MediaItem;
} {
  const index = queue.findIndex(item => itemKey(item) === itemKey(current));
  if (index < 0) return { inQueue: false };
  const visible = visibilityWithProgress(hide, connections, progress);
  let previous: MediaItem | undefined;
  let next: MediaItem | undefined;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (visible(queue[cursor])) { previous = queue[cursor]; break; }
  }
  for (let cursor = index + 1; cursor < queue.length; cursor++) {
    if (visible(queue[cursor])) { next = queue[cursor]; break; }
  }
  return { inQueue: true, previous, next };
}
