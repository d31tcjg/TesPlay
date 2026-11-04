import { httpError } from './security.js';

export const contentKinds = ['movie', 'series', 'live', 'video', 'audio'];
export const mediaKind = item => item.contentKind || (item.type === 'episode' ? 'series' : item.type);
export function allows(access, item) {
  if (!access) return true;
  const kind = mediaKind(item);
  if (kind !== 'folder' && !access.kinds.includes(kind)) return false;
  if (access.sections && (!item.sectionId || !access.sections.includes(String(item.sectionId)))) return false;
  const category=item.accessCategory||item.category;
  if (access.categories && (!category || !access.categories.includes(category))) return false;
  return true;
}
export function assertAllowed(access, item) {
  if (!allows(access, item)) throw httpError(403, 'This title or library is not shared with your account.');
}
export function validateGrants(input, connections) {
  if (!Array.isArray(input) || input.length > 100) throw httpError(400, 'Choose the connections to share.');
  const ids = new Set();
  return input.map(value => {
    const c = connections.find(c => c.id === value?.connectionId);
    if (!c || ids.has(c.id)) throw httpError(400, 'Choose each available connection once.');
    ids.add(c.id);
    if (!Array.isArray(value.kinds) || !value.kinds.length || value.kinds.some(k => !contentKinds.includes(k))) throw httpError(400, 'Choose the content types this account can watch.');
    const supportedKinds={youtube:['video'],m3u:['live'],xtream:['movie','series','live'],plex:['movie','series','audio'],stremio:['movie','series'],drive:['video','audio'],local:['video','audio']}[c.type]||[];
    if(value.kinds.some(k=>!supportedKinds.includes(k))) throw httpError(400,'Choose content types supported by this connection.');
    const restriction = (field, supported) => {
      if (value[field] == null) return null;
      if (!supported || !Array.isArray(value[field]) || !value[field].length || value[field].length > 500 || value[field].some(id => typeof id !== 'string' || !id || id.length > 200)) throw httpError(400, 'Choose at least one allowed library or category.');
      return [...new Set(value[field])];
    };
    return { connectionId: c.id, kinds: [...new Set(value.kinds)], sections: restriction('sections', c.type === 'plex'), categories: restriction('categories', ['xtream', 'm3u'].includes(c.type)) };
  });
}
