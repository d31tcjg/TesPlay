import type { Connection, MediaItem } from './types';

/** The single Channels DVR folder holding every recording, newest first (server: `channels:recordings`). */
export const RECORDINGS_FOLDER_ID = 'channels:recordings';
export const RECORDINGS_PAGE_SIZE = 60;
/** Start the next page while this many pixels of the list remain below the viewport. */
export const LOAD_MORE_MARGIN = 800;

/** A recording row; `recordedAt` and `channel` are only sent by `channels:recordings`. */
export type RecordingItem = MediaItem & { recordedAt?: string; channel?: string };
export type RecordingsPage = { items: RecordingItem[]; hasMore?: boolean };

export const recordingsFolder = (c: Pick<Connection, 'id' | 'name'>): MediaItem => ({
  id: RECORDINGS_FOLDER_ID, title: 'Recordings', type: 'folder', source: c.name, connectionId: c.id, contentKind: 'series',
});

export const isRecordingsFolder = (c: Pick<Connection, 'type'>, parent?: Pick<MediaItem, 'id'>): boolean =>
  c.type === 'channels' && parent?.id === RECORDINGS_FOLDER_ID;

/** Append a page, dropping rows already shown (a recording finishing mid-scroll shifts later pages by one). */
export function mergePage(existing: RecordingItem[], incoming: RecordingItem[]): RecordingItem[] {
  const seen = new Set(existing.map(i => i.id));
  const added = incoming.filter(i => !seen.has(i.id) && seen.add(i.id));
  return added.length ? [...existing, ...added] : existing;
}

/** True when the list end is near, a next page exists and nothing is in flight or failed. */
export function shouldLoadMore(s: { hasMore: boolean; loading: boolean; failed: boolean; distanceToEnd: number; margin?: number }): boolean {
  return s.hasMore && !s.loading && !s.failed && s.distanceToEnd <= (s.margin ?? LOAD_MORE_MARGIN);
}

/** "Tue Nov 4 · 10:00 PM". Returns '' for a missing or invalid date. */
export function formatRecordedAt(iso: string | undefined, options: { locale?: string; timeZone?: string } = {}): string {
  const date = iso ? new Date(iso) : undefined;
  if (!date || Number.isNaN(date.getTime())) return '';
  const { locale, timeZone } = options;
  const day = date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone });
  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone });
  return `${day} · ${time}`;
}

/** "1h 35m", "45m"; '' when unknown. */
export function formatDuration(seconds: number | undefined): string {
  const total = Math.round(Number(seconds) || 0);
  if (total <= 0) return '';
  const minutes = Math.max(1, Math.round(total / 60)), h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** Resume progress as a 0-100 percentage, or undefined when there is nothing to resume. */
export function resumePercent(item: RecordingItem, libraryPercent?: number): number | undefined {
  const fromDvr = item.resumeSeconds && item.duration ? item.resumeSeconds / item.duration * 100 : undefined;
  const value = fromDvr ?? libraryPercent;
  return value !== undefined && value > 0 ? Math.min(100, value) : undefined;
}

export type RecordingRow = { title: string; subtitle: string; when: string; channel: string; duration: string; progress?: number; watched: boolean; meta: string };
export function recordingRow(item: RecordingItem, options: { locale?: string; timeZone?: string; libraryPercent?: number } = {}): RecordingRow {
  const progress = resumePercent(item, options.libraryPercent);
  const watched = !!item.watched || (progress ?? 0) >= 97;
  const when = formatRecordedAt(item.recordedAt || item.addedAt, options), channel = item.channel || '';
  const duration = formatDuration(item.duration);
  return {
    title: item.title, subtitle: item.type === 'episode' ? item.subtitle || '' : '', when, channel, duration,
    progress: watched ? undefined : progress, watched,
    meta: [when, channel, duration].filter(Boolean).join(' · '),
  };
}
