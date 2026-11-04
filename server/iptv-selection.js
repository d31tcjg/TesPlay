import { httpError } from './security.js';

export const isIptv = c => ['xtream', 'm3u'].includes(c.type);
export function validateLoadedCategories(type, value) {
  if (value === undefined) return;
  if (!['xtream', 'm3u'].includes(type) || value !== null && (
    !Array.isArray(value) || value.length > 1000 || value.some(id =>
      typeof id !== 'string' || !id || id.length > 200 ||
      type === 'xtream' && !/^(live|movie|series):\d+$/.test(id))
  )) throw httpError(400, 'Choose valid IPTV categories.');
}
export function categoryLoaded(c, item) {
  if (!isIptv(c) || !Array.isArray(c.config?.loadedCategories)) return true;
  const category = item.accessCategory || item.category || (c.type === 'm3u' ? '__ungrouped__' : '');
  return c.config.loadedCategories.includes(category);
}
