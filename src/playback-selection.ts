import { ALL_FORMATS, Input, UrlSource } from 'mediabunny';
import type { MediaTrack } from '@canvas-stream-player/contracts';
import { AccessSessionExpiredError, api, tesPlayFetch, youtubeId } from './api';
import type { MediaItem, Playback, PlaybackSettings, PlaybackOptions, PlayerPreferences } from './types';
import { defaultPlayerPreferences, preferredLanguageTrack } from './player-preferences';

export function playbackPath(item: MediaItem, settings: PlaybackSettings = {}) {
  const params = new URLSearchParams({connectionId:item.connectionId || '',itemId:item.id,kind:item.type});
  if (settings.compatibility) params.set('transcode','1');
  if (settings.audioTrackId && settings.audioTrackId !== 'default') params.set('audioTrackId',settings.audioTrackId);
  if (settings.qualityId) params.set('qualityId',settings.qualityId);
  if (settings.sourceId) params.set('sourceId', settings.sourceId);
  return `/playback?${params}`;
}
export async function resolvePlayback(item: MediaItem, settings: PlaybackSettings, signal: AbortSignal, defaults?: PlayerPreferences): Promise<Playback> {
  const preferences = defaults || await api<PlayerPreferences>('/player/preferences',undefined,undefined,signal).catch(() => { signal.throwIfAborted(); return defaultPlayerPreferences; });
  const effective = { ...settings };
  if (item.providerType === 'plex' && !item.playbackUrl) {
    if (effective.qualityId === undefined) effective.qualityId = item.type === 'audio' ? 'auto' : preferences.qualityId;
    if (effective.audioTrackId === undefined && preferences.audioLanguage) {
      const options = await api<PlaybackOptions>(`/playback/options?${new URLSearchParams({connectionId:item.connectionId || '',itemId:item.id,kind:item.type})}`,undefined,undefined,signal).catch(() => { signal.throwIfAborted(); return {audio:[]}; });
      effective.audioTrackId = preferredLanguageTrack(options.audio,preferences.audioLanguage)?.id;
    }
  }
  let playback: Playback;
  if (!item.playbackUrl) playback = await api<Playback>(playbackPath(item,effective),undefined,undefined,signal);
  else {
    const id = youtubeId(item.playbackUrl);
    const resolver = /^\/api\/remote\/media\/remote-[a-f0-9-]+\/playback$/.test(item.playbackUrl) ? item.playbackUrl.slice(4) : item.playbackUrl.startsWith('/api/radio/stream/') ? item.playbackUrl.slice(4).replace('/radio/stream/','/radio/playback/') : id ? `/youtube/resolve/${id}` : item.playbackUrl.startsWith('/api/youtube/resolve/') ? item.playbackUrl.slice(4) : null;
    playback = resolver ? await api<Playback>(resolver,undefined,undefined,signal) : {url:item.playbackUrl,type:item.type==='audio'?'audio':/\.m3u8(?:[?#]|$)/i.test(item.playbackUrl)?'hls':'video',...(/\.ts(?:[?#]|$)/i.test(item.playbackUrl)?{streamKind:'continuous-ts' as const}:{})};
  }
  return {...playback,settings:effective,defaults:preferences};
}
const base64Url = (bytes:Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function representation(response:Response, proxied:boolean):Promise<string|null> {
  if(proxied) {const value=response.headers.get('x-csp-representation-id');return value && /^mr1_[A-Za-z0-9_-]{43}$/.test(value)?value:null;}
  const etag=response.headers.get('etag'),range=/^bytes \d+-\d+\/(\d+)$/.exec(response.headers.get('content-range')||'');
  const total=range?.[1] || response.headers.get('content-length');
  if(!etag || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag) || !total || !/^\d+$/.test(total) || !response.url)return null;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`canvas-stream-player-media-representation-v1\0${response.url}\0${etag}\0${Number(total)}`));
  return `mr1_${base64Url(new Uint8Array(digest))}`;
}
/** Read container metadata, without creating decoders or starting playback. */
export async function discoverAudioTracks(url: string, resourceId: string, signal: AbortSignal): Promise<{tracks:MediaTrack[];representationId:string|null}> {
  signal.throwIfAborted();
  const proxied=new URL(url,location.href).origin===location.origin;
  let representationId:string|null=null;
  const probe = new AbortController();
  let input: Input | undefined;
  let disposed = false, active = true, retries = 0;
  let rejectStopped!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const dispose = () => { if (input && !disposed) { disposed = true; input.dispose(); } };
  const stop = (reason: unknown) => {
    if (!active || probe.signal.aborted) return;
    probe.abort(reason);
    // Aborting fetch alone does not cancel Mediabunny's reads and retry loops.
    dispose();
    rejectStopped(reason);
  };
  const abort = () => stop(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(() => stop(new DOMException('Audio track discovery timed out.', 'TimeoutError')), 10000);
  try {
    input = new Input({formats:ALL_FORMATS,source:new UrlSource(url,{
      fetchFn:async(resource,init)=>{
        const requestSignal=AbortSignal.any([probe.signal,...(init?.signal?[init.signal]:[])]);
        requestSignal.throwIfAborted();
        const response=await tesPlayFetch(resource,{...init,signal:requestSignal});
        try {
          requestSignal.throwIfAborted();
          const observed=await representation(response,proxied);
          requestSignal.throwIfAborted();
          if(representationId && observed!==representationId){
            const reason=new Error('The file changed while reading its audio tracks.');
            stop(reason);
            throw reason;
          }
          representationId=observed;
          return response;
        } catch (reason) { void response.body?.cancel().catch(()=>undefined); throw reason; }
      },
      getRetryDelay:(_attempts,error)=>{
        if (probe.signal.aborted || error instanceof AccessSessionExpiredError || error instanceof DOMException && error.name==='AbortError' || retries>=2) return null;
        // Body-read resumes reset Mediabunny's attempt count, so bound the whole probe.
        return ++retries * 0.25;
      },
      handleUnhandledError:stop,
      requestInit:{credentials:proxied?'same-origin':'omit'},maxCacheSize:4*1024*1024,
    })});
    const discover = async (sourceInput: Input) => {
      const tracks = await sourceInput.getAudioTracks();
      if(!representationId)return {tracks:[],representationId:null};
      const pinned=representationId;
      const catalogue=await Promise.all(tracks.slice(0,128).map(async (track,index) => {
        const [codec,language,name,disposition] = await Promise.all([track.getCodec(),track.getLanguageCode(),track.getName(),track.getDisposition()]);
        return {id:`file-audio-${track.number}`,kind:'audio' as const,codec:codec || 'unknown',language:language==='und'?null:language,label:name || (language && language!=='und'?language:`Audio ${index+1}`),default:disposition.default,forced:false,selector:{kind:'file-track' as const,resourceId,trackKind:'audio' as const,trackNumber:track.number,representation:'mediabunny-track-number-per-type-v1' as const,representationId:pinned}};
      }));
      return {tracks:catalogue,representationId:pinned};
    };
    return await Promise.race([discover(input), stopped]);
  } catch (reason) { probe.signal.throwIfAborted(); throw reason; }
  finally {
    active = false;
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    dispose();
  }
}
