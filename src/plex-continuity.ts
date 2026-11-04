import type { Library, MediaItem } from './types';
import { itemKey } from './types';
export type PlexContinuity = {progress:Library['progress'];watchlist:MediaItem[];notes?:string[]};
export function mergePlexContinuity(local:Library,results:PlexContinuity[]):Library {
  const progress=new Map(local.progress.map(p=>[itemKey(p.item),p]));
  for(const result of results)for(const p of result.progress){const saved=progress.get(itemKey(p.item));if(!saved||p.updatedAt>=saved.updatedAt)progress.set(itemKey(p.item),p);}
  return {...local,progress:[...progress.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),plexWatchlist:[...new Map(results.flatMap(r=>r.watchlist).map(i=>[itemKey(i),i])).values()],plexNotes:[...new Set(results.flatMap(r=>r.notes||[]))]};
}
