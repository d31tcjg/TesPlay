import { PlaybackSessionSchema, type PlaybackSession, type PlayerEngineServices, type QualityRendition, type MediaTrack, type SubtitleTrack } from '@canvas-stream-player/contracts';
import { MAX_HLS_PLAYLIST_BYTES, readBoundedText } from '@canvas-stream-player/player';
import type { MediaItem, Playback } from './types';
import { discoverAudioTracks, playbackPath } from './playback-selection';
import { defaultPlayerPreferences, preferredLanguageTrack, preferredQuality } from './player-preferences';
import { api, tesPlayFetch, AccessSessionExpiredError } from './api';

const attributes = (line: string) => Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)].map((m) => [m[1], m[2] ?? m[3]]));
export class TesPlaySourceError extends Error {}
const readableUrl = (raw: string, base = location.href) => {
  const url = new URL(raw, base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('This media address is unsupported.');
  return url;
};
async function playlist(raw: string, signal: AbortSignal) {
  const url = readableUrl(raw);
  let response: Response;
  try { response = await tesPlayFetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), credentials: url.origin === location.origin ? 'same-origin' : 'omit', referrerPolicy: 'no-referrer' }); }
  catch (error) { if (signal.aborted) throw error; if (error instanceof AccessSessionExpiredError) throw new TesPlaySourceError(error.message); throw new TesPlaySourceError('The stream playlist could not be reached. Check the provider connection and reopen this title.'); }
  if (!response.ok) throw new TesPlaySourceError(`The stream playlist could not load (HTTP ${response.status}). Reopen the title or check its connection.`);
  const text = await readBoundedText(response, MAX_HLS_PLAYLIST_BYTES, "Stream playlist");
  if (!text.trimStart().startsWith('#EXTM3U')) throw new TesPlaySourceError('The source did not return a valid stream playlist. Sign in again if your session expired, then reopen this title.');
  return { text, base: response.url || url.href };
}

/** A host-side contract adapter over TesPlay's existing authenticated media URLs. */
export async function createTesPlayAdapter(playback: Playback, item: MediaItem, signal: AbortSignal, plexCompatibility = false) {
  const ownedMedia = new Set<string>();
  const release = () => {
    for (const path of ownedMedia) void api(path, {}, 'DELETE', undefined, true).catch(() => {});
    ownedMedia.clear();
  };
  signal.addEventListener('abort', release, { once: true });
  const id = crypto.randomUUID();
  const resolutionId = crypto.randomUUID();
  let current: PlaybackSession;
  let compatible = plexCompatibility;
  let root = playback;
  let selectedAudio = playback.settings?.audioTrackId || playback.selectedAudioTrackId;
  const selectedQuality = playback.settings?.qualityId || 'auto';
  let fileTracks: MediaTrack[] | undefined;
  let representationId:string|undefined;
  async function prepare(p: Playback, qualityId = 'auto', operationSignal = signal, audioId = selectedAudio, useDefaults = false): Promise<PlaybackSession> {
    for (const raw of [p.url, p.audioUrl, ...(p.subtitles || []).map(track => track.url)]) {
      if (!raw) continue;
      const url = readableUrl(raw);
      if (url.origin === location.origin && /^\/api\/(?:v1\/)?media\/[A-Za-z0-9_-]+$/.test(url.pathname))
        ownedMedia.add(url.pathname.slice(4));
    }
    if (signal.aborted) { release(); signal.throwIfAborted(); }
    let url = readableUrl(p.url).href;
    let audio: string | undefined = p.audioUrl ? readableUrl(p.audioUrl).href : undefined;
    let kind: PlaybackSession['streamKind'] = p.streamKind || 'direct-file';
    let live = p.isLive ?? item.type === 'live';
    let protection: PlaybackSession['protection'] = 'clear';
    let qualities: QualityRendition[] = [];
    let tracks: MediaTrack[] = [];
    const subtitles:SubtitleTrack[] = (p.subtitles || []).map((s,i)=>({id:s.id || `subtitle-${i}`,label:s.label,language:s.language || null,format:'webvtt',origin:'external',deliveryFormat:'webvtt',url:s.url.replace(/^\/api\/media\//,'/api/v1/media/'),default:false,forced:false}));
    if (p.type === 'hls') {
      let inspected = await playlist(url, operationSignal);
      const lines = inspected.text.split(/\r?\n/);
      const masterBase = inspected.base;
      const variants: { id: string; url: string; audio?: string; audioGroup?:string; quality: QualityRendition }[] = [];
      for(const [index,a] of lines.filter(line=>line.startsWith('#EXT-X-MEDIA:')).map(attributes).filter(a=>a.TYPE==='SUBTITLES' && a.URI).slice(0,128).entries()) {
        const subtitleUrl=readableUrl(a.URI,masterBase);
        if(subtitleUrl.origin!==location.origin || !/^\/api\/(?:v1\/)?media\/[A-Za-z0-9_-]+$/.test(subtitleUrl.pathname))continue;
        subtitles.push({id:`hls-subtitle-${index}`,label:a.NAME || a.LANGUAGE || `Subtitles ${index+1}`,language:a.LANGUAGE || null,format:'webvtt',origin:'hls-rendition',deliveryFormat:'hls-webvtt',url:subtitleUrl.pathname.replace(/^\/api\/media\//,'/api/v1/media/'),default:a.DEFAULT==='YES',forced:a.FORCED==='YES'});
      }
      const audioRenditions = lines.filter(line=>line.startsWith('#EXT-X-MEDIA:')).map(attributes).filter(a=>a.TYPE==='AUDIO' && a.URI).slice(0,128);
      tracks = audioRenditions.map((a,index)=>({id:`hls-audio-${a.LANGUAGE||'und'}-${encodeURIComponent(a.NAME||String(index))}`,kind:'audio' as const,codec:'aac',language:a.LANGUAGE || null,label:a.NAME || a.LANGUAGE || `Audio ${index+1}`,default:a.DEFAULT==='YES',forced:false,selector:{kind:'endpoint' as const,resourceId:'sound',role:'audio' as const}}));
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
        const attr = attributes(lines[i]);
        const child = lines.slice(i + 1).find((line) => line.trim() && !line.startsWith('#'));
        if (!child) continue;
        const [width, height] = (attr.RESOLUTION || '').split('x').map(Number);
        const audioLine = lines.find((line) => line.startsWith('#EXT-X-MEDIA:') && attributes(line).TYPE === 'AUDIO' && attributes(line)['GROUP-ID'] === attr.AUDIO && attributes(line).URI);
        variants.push({
          audioGroup: attr.AUDIO, id: `quality-${variants.length}`, url: readableUrl(child.trim(), inspected.base).href,
          ...(audioLine ? { audio: readableUrl(attributes(audioLine).URI, inspected.base).href } : {}),
          quality: { id: `quality-${variants.length}`, label: height ? `${height}p` : `Stream ${variants.length + 1}`, width: width || null, height: height || null, bandwidth: Number(attr.BANDWIDTH) || null, averageBandwidth: Number(attr['AVERAGE-BANDWIDTH']) || null, videoCodec: null, audioCodec: null, frameRate: Number(attr['FRAME-RATE']) || null, selector: { kind: 'endpoint', resourceId: 'picture', role: 'manifest' } },
        });
      }
      let audioGroup:string|undefined;
      if (variants.length) {
        if (useDefaults && p.provider !== 'plex' && p.settings?.qualityId === undefined) qualityId = preferredQuality(variants.map(variant => variant.quality), playback.defaults?.qualityId || 'auto');
        // Auto is a stable policy choice, rather than a bandwidth-based ABR claim.
        const automatic = [...variants].sort((a, b) => (b.quality.height || 0) - (a.quality.height || 0)).find((v) => (v.quality.height || 0) <= 1080) || variants[0];
        const selected = qualityId === 'auto' ? automatic : variants.find((v) => v.id === qualityId);
        if (!selected) throw new Error('This quality is no longer available.');
        qualities = [{ ...automatic.quality, id: 'auto', label: 'Auto' }, ...variants.map((v) => v.quality)];
        url = selected.url;
        audioGroup = selected.audioGroup;
        audio = selected.audio || audio;
        inspected = await playlist(url, operationSignal);
      }
      if (audioRenditions.length) {
        if (useDefaults && p.settings?.audioTrackId === undefined) audioId = preferredLanguageTrack(tracks, playback.defaults?.audioLanguage || null)?.id || audioId;
        const available=audioRenditions.filter(a=>!audioGroup || a['GROUP-ID']===audioGroup);
        const requested=audioRenditions[tracks.findIndex(t=>t.id===audioId)];
        const selected=available.includes(requested)?requested:available.find(a=>requested && a.LANGUAGE===requested.LANGUAGE)||available.find(a=>a.DEFAULT==='YES')||available[0];
        if(selected){audio=readableUrl(selected.URI,masterBase).href;audioId=tracks[audioRenditions.indexOf(selected)].id;}
        tracks=tracks.filter((_,index)=>available.includes(audioRenditions[index]));
      }
      // Bound nested master chains and inspect the actual media playlist.
      for (let depth = 0; inspected.text.includes('#EXT-X-STREAM-INF:') && depth < 3; depth++) {
        const child = inspected.text.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('#'));
        if (!child) throw new Error('The stream playlist has no playable rendition.');
        url = readableUrl(child.trim(), inspected.base).href;
        inspected = await playlist(url, operationSignal);
      }
      if (inspected.text.includes('#EXT-X-STREAM-INF:')) throw new Error('The stream playlist is nested too deeply.');
      live = !inspected.text.includes('#EXT-X-ENDLIST');
      kind = inspected.text.includes('#EXT-X-MAP:') ? 'hls-fmp4' : live ? 'hls-live-ts' : 'hls-vod-ts';
      if (/METHOD=AES-128(?:,|\s|$)/.test(inspected.text)) protection = 'hls-aes-128';
      if (/METHOD=SAMPLE-AES/.test(inspected.text)) throw new Error('This stream uses unsupported protected playback.');
    }
    if (p.audioTracks?.length && (p.type === 'hls' || kind !== 'direct-file')) {
      tracks = p.audioTracks.map(t=>({id:t.id,kind:'audio' as const,codec:t.codec || 'aac',language:t.language || null,label:t.label,default:t.id===(p.selectedAudioTrackId || audioId),forced:false,selector:{kind:'endpoint' as const,resourceId:audio?'sound':'picture'}}));
      audioId = p.selectedAudioTrackId || audioId;
    } else if (p.type !== 'hls' && kind === 'direct-file') {
      if(!fileTracks){const catalogue=await discoverAudioTracks(audio || url,audio?'sound':'picture',operationSignal).catch(reason=>{operationSignal.throwIfAborted();if(reason instanceof AccessSessionExpiredError)throw reason;return {tracks:[],representationId:null};});fileTracks=catalogue.tracks.map((track,index)=>({...track,id:p.provider==='plex'?p.audioTracks?.[index]?.id || track.id:track.id,label:p.provider==='plex'?p.audioTracks?.[index]?.label || track.label:track.label}));representationId=catalogue.representationId || undefined;}
      tracks = fileTracks;
      if(p.provider==='plex')audioId=fileTracks.find(track=>track.default)?.id || fileTracks[0]?.id;
    } else if (!tracks.length) tracks = [{id:'default-audio',kind:'audio',codec:'aac',language:null,label:'Default audio',default:true,forced:false,selector:{kind:'endpoint',resourceId:audio?'sound':'picture'}}];
    if (useDefaults && p.provider !== 'plex' && p.settings?.audioTrackId === undefined) audioId = preferredLanguageTrack(tracks, (playback.defaults || defaultPlayerPreferences).audioLanguage)?.id || audioId;
    const expiresAt = new Date(Date.now() + 12 * 3600000).toISOString();
    const endpoint = (raw: string, role: 'muxed' | 'video' | 'manifest' | 'audio', resourceId: string) => ({ resourceId, role, accessUrl: raw, route: readableUrl(raw).origin === location.origin ? 'secure-proxy' as const : 'direct' as const, mimeType: role === 'manifest' ? 'application/vnd.apple.mpegurl' : null, rangeSupported: kind !== 'continuous-ts', expiresAt, ...(p.type!=='hls' && fileTracks?.some(t=>t.selector?.kind==='file-track' && t.selector.resourceId===resourceId) ? {representation:'mediabunny-track-number-per-type-v1' as const,representationId} : {}) });
    const picture = endpoint(url, p.type === 'hls' ? 'manifest' : audio ? 'video' : 'muxed', 'picture');
    return PlaybackSessionSchema.parse({
      id, resolutionId, generationId: crypto.randomUUID(), state: 'ready', route: picture.route, streamKind: kind, isLive: live, protection, createdAt: new Date().toISOString(), expiresAt,
      endpoints: [picture, ...(audio ? [endpoint(audio, 'audio', 'sound')] : [])], tracks, qualities, selectedAudioTrackId: tracks.some(t=>t.id===audioId)?audioId:tracks.find(t=>t.default)?.id || tracks[0]?.id || null,
      selectedQualityId: qualities.length ? qualityId : null,
      subtitles, restriction: null,
    });
  }
  const checkGeneration = (sessionId: string, generation?: string) => {
    if (sessionId !== current.id || generation !== current.generationId) throw new Error('This playback operation is out of date.');
  };
  current = await prepare(playback,playback.provider==='plex'?'auto':selectedQuality,signal,selectedAudio,true);
  selectedAudio=current.selectedAudioTrackId || undefined;
  const services: PlayerEngineServices = {
    now: () => performance.now(),
    reportDiagnostic: async () => { /* Diagnostics are available through the engine snapshot; never log source credentials. */ },
    requestSelection: async (sessionId, selection, operationSignal) => {
      checkGeneration(sessionId, selection.expectedGenerationId);
      const audioId=selection.audioTrackId || current.selectedAudioTrackId || selectedAudio;
      const qualityId=selection.qualityId || current.selectedQualityId || 'auto';
      let nextRoot=root;
      let replacement: PlaybackSession;
      if (root.provider === 'plex' && selection.audioTrackId && item.connectionId) {
        const p = await api<Playback>(playbackPath(item,{...root.settings,audioTrackId:audioId,compatibility:compatible}),undefined,undefined,operationSignal);
        p.settings = {...root.settings,audioTrackId:audioId};
        replacement = await prepare(p,qualityId,operationSignal,audioId);
        nextRoot = p;
      } else replacement = await prepare(root,qualityId,operationSignal,audioId);
      operationSignal.throwIfAborted();
      checkGeneration(sessionId, selection.expectedGenerationId);
      selectedAudio=replacement.selectedAudioTrackId || undefined;
      root=nextRoot;current = replacement;
      return replacement;
    },
    requestRouteDemotion: async (sessionId, _reason, operationSignal, generation) => {
      checkGeneration(sessionId,generation);
      if(root.provider!=='plex' || !item.connectionId) throw new Error('This source does not support refreshing its playback route.');
      const replacement=await api<Playback>(playbackPath(item,{...root.settings,audioTrackId:selectedAudio?.startsWith('plex-audio-')?selectedAudio:root.settings?.audioTrackId,compatibility:compatible}),undefined,undefined,operationSignal);
      replacement.settings={...root.settings};
      fileTracks=undefined;representationId=undefined;
      const session=await prepare(replacement,'auto',operationSignal);
      operationSignal.throwIfAborted();checkGeneration(sessionId,generation);
      root=replacement;current=session;return session;
    },
    requestCompatibility: async (sessionId, mode, _reason, operationSignal, _seek, generation) => {
      checkGeneration(sessionId, generation);
      if (!item.connectionId || root.provider !== 'plex' || compatible || mode === 'subtitle-extract') throw new Error('This source needs a supported codec. Plex titles can use Plex compatibility mode.');
      const replacement = await api<Playback>(playbackPath(item,{...root.settings,audioTrackId:selectedAudio?.startsWith('plex-audio-')?selectedAudio:root.settings?.audioTrackId,compatibility:true}), undefined, undefined, operationSignal);
      replacement.settings={...root.settings,compatibility:true};
      const session = await prepare(replacement, 'auto', operationSignal);
      operationSignal.throwIfAborted();
      checkGeneration(sessionId, generation);
      compatible = true;
      root = replacement;
      current = session;
      return session;
    },
  };
  return { session: current, services };
}
