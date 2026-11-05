import {tesPlayFetch} from './api';
import type {Playback} from './types';

export function startPlexPlaybackHeartbeat(playback: Playback, signal: AbortSignal, isActive: () => boolean) {
  if (signal.aborted || !['plex','channels'].includes(playback.provider || '') || playback.type !== 'hls' ||
      !/^\/api\/media\/m_[A-Za-z0-9_-]+$/.test(playback.url)) return;
  let pending = false;
  const ping = async () => {
    if (pending || signal.aborted || !isActive()) return;
    pending = true;
    try {
      await tesPlayFetch(`${playback.url}/heartbeat`, {method: 'POST', credentials: 'same-origin', signal});
    } catch {
      // A transient keepalive failure must not interrupt buffered playback.
      // The normal media request/recovery path handles an expired session.
    } finally {pending = false;}
  };
  const timer = window.setInterval(() => void ping(), playback.provider === 'channels' ? 5000 : 15000);
  signal.addEventListener('abort', () => window.clearInterval(timer), {once: true});
  void ping();
}
