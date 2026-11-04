import type { PlaybackOptions, PlaybackSettings, PlayerPreferences } from './types';

export const defaultPlayerPreferences: PlayerPreferences = { audioLanguage: null, subtitleLanguage: null, subtitlesEnabled: false, qualityId: 'auto' };
export const playbackLanguages = [['en', 'English'], ['nl', 'Dutch'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['tr', 'Turkish'], ['pl', 'Polish'], ['ar', 'Arabic']] as const;
export const playbackQualities = [['auto', 'Auto / original'], ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p']] as const;

export function normalizeLanguage(value?: string | null) {
  const code = value?.toLowerCase().split('-')[0] || '';
  return ({ eng: 'en', nld: 'nl', dut: 'nl', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it', por: 'pt', tur: 'tr', pol: 'pl', ara: 'ar' } as Record<string, string>)[code] || code;
}

type LanguageChoice = { id: string; language?: string | null; selected?: boolean; default?: boolean };
export function preferredLanguageTrack<T extends LanguageChoice>(tracks: T[], language: string | null) {
  if (!language) return undefined;
  const matches = tracks.filter(track => normalizeLanguage(track.language) === normalizeLanguage(language));
  return matches.find(track => track.selected || track.default) || matches[0];
}

export function preferredSubtitleTrack<T extends LanguageChoice>(tracks: T[], preferences: PlayerPreferences) {
  if (!preferences.subtitlesEnabled) return undefined;
  return preferences.subtitleLanguage ? preferredLanguageTrack(tracks, preferences.subtitleLanguage) : tracks.find(track => track.default) || tracks[0];
}

export function preferredQuality(choices: { id: string; label?: string | null; height?: number | null }[], preferred: PlayerPreferences['qualityId']) {
  if (preferred === 'auto') return 'auto';
  const exact = choices.find(choice => choice.id === preferred);
  if (exact) return exact.id;
  const target = Number.parseInt(preferred, 10);
  const heights = choices.filter(choice => choice.id !== 'auto').map(choice => ({ id: choice.id, height: choice.height || Number(/(\d{3,4})p/i.exec(choice.label || '')?.[1]) || 0 })).filter(choice => choice.height > 0).sort((a, b) => b.height - a.height);
  return heights.find(choice => choice.height <= target)?.id || heights.at(-1)?.id || 'auto';
}

export function defaultPlaybackSettings(options: PlaybackOptions, preferences: PlayerPreferences): PlaybackSettings {
  return {
    audioTrackId: preferredLanguageTrack(options.audio, preferences.audioLanguage)?.id || 'default',
    subtitleTrackId: preferredSubtitleTrack(options.subtitles, preferences)?.id || 'off',
    qualityId: preferredQuality(options.qualities, preferences.qualityId),
  };
}
