import { httpError } from './security.js';

export const defaultPlayerPreferences = Object.freeze({
  audioLanguage: null,
  subtitleLanguage: null,
  subtitlesEnabled: false,
  qualityId: 'auto',
});

export function validatePlayerPreferences(value, previous = defaultPlayerPreferences) {
  const fields = Object.keys(defaultPlayerPreferences);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).some(key => !fields.includes(key)))
    throw httpError(400, 'Choose valid playback defaults.');
  const result = { ...previous, ...value };
  const validLanguage = language => language === null || typeof language === 'string' && language.length <= 35 && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language);
  if (!validLanguage(result.audioLanguage) || !validLanguage(result.subtitleLanguage) || typeof result.subtitlesEnabled !== 'boolean' || !['auto', '1080p', '720p', '480p'].includes(result.qualityId))
    throw httpError(400, 'Choose valid audio, subtitle and quality defaults.');
  return result;
}
