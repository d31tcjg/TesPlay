import { itemKey } from './types';
import type { MediaItem } from './types';

export type EpisodeCatalog = {
  items: MediaItem[];
  next?: MediaItem | null;
  previous?: MediaItem | null;
};

export function episodesPath(item: MediaItem): string {
  return `/episodes?${new URLSearchParams({
    connectionId: item.connectionId || '', itemId: item.id, kind: item.type,
  })}`;
}

export function episodeSeasons(items: MediaItem[]): number[] {
  return [...new Set(items.map(item => item.seasonNumber ?? 0))].sort((a, b) => a - b);
}

export function episodesForSeason(items: MediaItem[], season: number): MediaItem[] {
  return items.filter(item => (item.seasonNumber ?? 0) === season)
    .sort((a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
}

/** Shared selection rules; the screen popover and phone rail keep their own presentation. */
export function episodePicker(items: MediaItem[], current?: MediaItem, browsedSeason: number | null = null) {
  const seasons = episodeSeasons(items);
  const selected = current && items.find(item => itemKey(item) === itemKey(current));
  const shown = selected || items[0];
  const currentSeason = shown?.seasonNumber ?? seasons[0] ?? 0;
  const currentEpisode = shown?.episodeNumber ?? 1;
  const season = browsedSeason !== null && seasons.includes(browsedSeason) ? browsedSeason : currentSeason;
  return { seasons, selected, currentSeason, currentEpisode, season, episodes: episodesForSeason(items, season) };
}
