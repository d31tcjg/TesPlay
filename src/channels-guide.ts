import type { Connection, MediaItem } from './types';

/** Pure helpers for the Channels DVR guide grid and On now list (no DOM, no React). */
export type GuideAiring = {
  start: number; end: number; title: string; episodeTitle?: string; summary?: string; image?: string;
  season?: number; episode?: number; isNew?: boolean; isLive?: boolean; genres?: string[]; seriesId?: string;
};
export type GuideNext = { start: number; end: number; title: string; episodeTitle?: string };
export type GuideChannel = {
  id: string; number: string; name: string; callSign?: string; logo?: string; hd?: boolean; source?: string;
  airings: GuideAiring[]; next?: GuideNext;
};
export type GuideResponse = { start: number; end: number; channels: GuideChannel[] };
export type GuideFilter = { source: string; favorites: boolean; query: string };

export const PX_PER_MINUTE = 6;
export const ROW_HEIGHT = 72;
export const OVERSCAN_ROWS = 6;
export const CHANNEL_COLUMN = 168;
export const WINDOW_HOURS = 3;
export const MAX_AHEAD_HOURS = 24;
export const NARROW_BREAKPOINT = 700;
export const LOAD_AHEAD_SECONDS = 3600;

/** Phones and portrait layouts get the On now list instead of the grid. */
export const isNarrowLayout = (width: number): boolean => width < NARROW_BREAKPOINT;

/** Horizontal position (px, inside the time area) of an instant, relative to the grid origin. */
export const timeToX = (time: number, origin: number): number => (time - origin) / 60 * PX_PER_MINUTE;
export const xToTime = (x: number, origin: number): number => origin + x / PX_PER_MINUTE * 60;
export const nowLineX = (now: number, origin: number): number => timeToX(now, origin);
export const gridWidth = (origin: number, end: number): number => Math.max(0, timeToX(end, origin));

/** Left/width of a program cell. Partial overlap with the grid window is clipped, never negative. */
export function cellLayout(airing: Pick<GuideAiring, 'start' | 'end'>, origin: number, windowEnd: number): { left: number; width: number } {
  const left = timeToX(Math.max(airing.start, origin), origin);
  const right = timeToX(Math.min(airing.end, windowEnd), origin);
  return { left, width: Math.max(0, right - left) };
}

export const isCurrent = (a: Pick<GuideAiring, 'start' | 'end'>, now: number): boolean => a.start <= now && now < a.end;
export const airingProgress = (a: Pick<GuideAiring, 'start' | 'end'>, now: number): number =>
  a.end > a.start ? Math.min(100, Math.max(0, (now - a.start) / (a.end - a.start) * 100)) : 0;

/** Virtualized row window: only visible rows plus overscan are rendered. `end` is exclusive. */
export function visibleRows(scrollTop: number, viewportHeight: number, total: number, rowHeight = ROW_HEIGHT, overscan = OVERSCAN_ROWS): { start: number; end: number; offset: number } {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0, offset: 0 };
  const top = Math.max(0, scrollTop);
  const first = Math.min(total - 1, Math.floor(top / rowHeight));
  const last = Math.min(total, Math.ceil((top + Math.max(0, viewportHeight)) / rowHeight));
  const start = Math.max(0, first - overscan), end = Math.min(total, Math.max(first + 1, last) + overscan);
  return { start, end, offset: start * rowHeight };
}

/** Load the next window once the viewport's right edge comes within `LOAD_AHEAD_SECONDS` of the loaded end. */
export function needsNextWindow(scrollLeft: number, viewportWidth: number, origin: number, loadedEnd: number, now: number, maxAheadHours = MAX_AHEAD_HOURS): boolean {
  if (loadedEnd >= now + maxAheadHours * 3600) return false;
  const visibleRight = xToTime(scrollLeft + viewportWidth, origin);
  return loadedEnd - visibleRight <= LOAD_AHEAD_SECONDS;
}
/** The next window continues exactly where the loaded range ends and never passes the 24 h ceiling. */
export const nextWindow = (loadedEnd: number, now: number, maxAheadHours = MAX_AHEAD_HOURS): { start: number; hours: number } | undefined => {
  const limit = now + maxAheadHours * 3600;
  if (loadedEnd >= limit) return undefined;
  return { start: loadedEnd, hours: Math.max(1, Math.min(WINDOW_HOURS, Math.ceil((limit - loadedEnd) / 3600))) };
};

/** Scroll position that puts "now" close to the left edge (just after the sticky channel column). */
export const scrollForNow = (now: number, origin: number, lead = 24): number => Math.max(0, nowLineX(now, origin) - lead);

const same = (a: GuideAiring, b: GuideAiring) => a.start === b.start && a.end === b.end;
/** Add a newly loaded window. Channels keep their order; duplicated airings at window seams are dropped. */
export function mergeGuide(current: GuideResponse | undefined, incoming: GuideResponse): GuideResponse {
  if (!current) return incoming;
  const byId = new Map(incoming.channels.map(c => [c.id, c]));
  const seen = new Set<string>();
  const merged = current.channels.map(channel => {
    seen.add(channel.id);
    const extra = byId.get(channel.id)?.airings || [];
    const airings = [...channel.airings];
    for (const a of extra) if (!airings.some(x => same(x, a))) airings.push(a);
    return { ...channel, airings: airings.sort((a, b) => a.start - b.start) };
  });
  for (const channel of incoming.channels) if (!seen.has(channel.id)) merged.push(channel);
  return { start: Math.min(current.start, incoming.start), end: Math.max(current.end, incoming.end), channels: merged };
}

export const channelSources = (channels: GuideChannel[]): string[] =>
  [...new Set(channels.map(c => c.source).filter((s): s is string => !!s))].sort((a, b) => a.localeCompare(b));

/** The v1 live MediaItem for a channel, so playback, resume and heartbeat behave exactly as before. */
export function liveItem(connection: Pick<Connection, 'id' | 'name'>, channel: Pick<GuideChannel, 'id' | 'number' | 'name' | 'logo' | 'hd' | 'source'>): MediaItem {
  return {
    id: channel.id, connectionId: connection.id, type: 'live', providerType: 'channels', source: connection.name,
    title: `${channel.number} ${channel.name}`, poster: channel.logo, category: channel.source,
    subtitle: channel.hd ? 'HD' : undefined,
  };
}

export const channelFavorite = (favorites: MediaItem[] | undefined, connectionId: string, channelId: string): boolean =>
  !!favorites?.some(i => i.connectionId === connectionId && i.type === 'live' && i.id === channelId);

/** Source chip, Favorites chip, then a text search over number, name and the current program. */
export function filterChannels(channels: GuideChannel[], filter: GuideFilter, favoriteIds: ReadonlySet<string>, now: number): GuideChannel[] {
  const q = filter.query.trim().toLowerCase();
  return channels.filter(c => {
    if (filter.source && c.source !== filter.source) return false;
    if (filter.favorites && !favoriteIds.has(c.id)) return false;
    if (!q) return true;
    const current = c.airings.find(a => isCurrent(a, now)) || c.airings[0];
    return `${c.number} ${c.name} ${c.callSign || ''} ${current?.title || ''}`.toLowerCase().includes(q);
  });
}

export function formatClock(time: number, locale?: string): string {
  return new Date(time * 1000).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}
export const formatRange = (a: Pick<GuideAiring, 'start' | 'end'>, locale?: string): string => `${formatClock(a.start, locale)} – ${formatClock(a.end, locale)}`;
export const episodeLabel = (a: Pick<GuideAiring, 'season' | 'episode' | 'episodeTitle'>): string => {
  const code = a.season !== undefined && a.episode !== undefined ? `S${a.season} E${a.episode}` : a.episode !== undefined ? `E${a.episode}` : '';
  return [code, a.episodeTitle].filter(Boolean).join(' · ');
};

/** Half-hour tick times covering [origin, end]. */
export function timeTicks(origin: number, end: number): number[] {
  const ticks: number[] = [];
  for (let t = Math.ceil(origin / 1800) * 1800; t < end; t += 1800) ticks.push(t);
  return ticks;
}
