import type { PlayerSnapshot } from "@canvas-stream-player/contracts";
import type { MediaItem } from "./types";

export type RemotePlayback = Pick<
  PlayerSnapshot,
  | "phase"
  | "positionSeconds"
  | "durationSeconds"
  | "seekableStartSeconds"
  | "seekableEndSeconds"
  | "volume"
  | "muted"
  | "isLive"
  | "playbackRate"
> & {
  needsAudioUnlock: boolean;
  fullscreen: boolean;
  fullscreenLocked?: boolean;
  subtitlesAvailable: boolean;
  subtitlesEnabled: boolean;
};
export type RemoteState = RemotePlayback & {
  item: Pick<
    MediaItem,
    | "id"
    | "title"
    | "type"
    | "source"
    | "poster"
    | "backdrop"
    | "year"
    | "connectionId"
  > | null;
};
export const idleRemotePlayback: RemotePlayback = {
  phase: "idle",
  positionSeconds: 0,
  durationSeconds: null,
  seekableStartSeconds: null,
  seekableEndSeconds: null,
  volume: 1,
  muted: false,
  isLive: false,
  playbackRate: 1,
  needsAudioUnlock: false,
  fullscreen: false,
  fullscreenLocked: false,
  subtitlesAvailable: false,
  subtitlesEnabled: false,
};
export function remotePlayback(
  snapshot: PlayerSnapshot | null,
  fullscreen: boolean,
  localCaptions: boolean,
  localAvailable: boolean,
  fullscreenLocked = false,
): RemotePlayback {
  if (!snapshot) return { ...idleRemotePlayback, phase: "loading", fullscreen, fullscreenLocked };
  return {
    phase: snapshot.phase,
    positionSeconds: snapshot.positionSeconds,
    durationSeconds: snapshot.durationSeconds,
    seekableStartSeconds: snapshot.seekableStartSeconds,
    seekableEndSeconds: snapshot.seekableEndSeconds,
    volume: snapshot.volume,
    muted: snapshot.muted,
    isLive: snapshot.isLive,
    playbackRate: snapshot.playbackRate,
    needsAudioUnlock:
      snapshot.audioTracks.length > 0 && !snapshot.audioUnlocked,
    fullscreen,
    fullscreenLocked,
    subtitlesAvailable: snapshot.subtitleTracks.length > 0 || localAvailable,
    subtitlesEnabled: !!snapshot.selectedSubtitleTrackId || localCaptions,
  };
}
