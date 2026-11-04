import { itemKey } from './types';
import type { MediaItem, PlaybackOptions, PlaybackSettings, PlayerPreferences } from './types';
import { defaultPlaybackSettings } from './player-preferences';

export const detailsDiscoveryTimeoutMs = 12_000;
const emptyOptions: PlaybackOptions = { audio: [], subtitles: [], qualities: [] };

export type DetailsState = {
  selected: MediaItem | null;
  selectionId: number;
  status: 'idle' | 'pending' | 'complete' | 'failed';
  options: PlaybackOptions;
  profileSettings: PlaybackSettings;
  edits: PlaybackSettings;
  error: string;
};
export type DetailsIdentity = { key: string; selectionId: number };
type DetailsAction =
  | { type: 'select'; item: MediaItem | null }
  | { type: 'select-initial'; item: MediaItem | null }
  | { type: 'start'; identity: DetailsIdentity }
  | { type: 'resolved'; identity: DetailsIdentity; options: PlaybackOptions; preferences: PlayerPreferences }
  | { type: 'failed'; identity: DetailsIdentity; error: string }
  | { type: 'edit'; patch: PlaybackSettings };

export function createDetailsState(selected: MediaItem | null): DetailsState {
  return { selected, selectionId: 0, status: selected ? 'pending' : 'idle', options: emptyOptions, profileSettings: {}, edits: {}, error: '' };
}

export function detailsReducer(state: DetailsState, action: DetailsAction): DetailsState {
  if (action.type === 'edit') return { ...state, edits: { ...state.edits, ...action.patch } };
  if (action.type === 'select' || action.type === 'select-initial') {
    if (action.type === 'select-initial' && state.selected) return state;
    if (state.selected && action.item && itemKey(state.selected) === itemKey(action.item)) return state;
    return { ...createDetailsState(action.item), selectionId: state.selectionId + 1 };
  }
  if (!state.selected || action.identity.selectionId !== state.selectionId || action.identity.key !== itemKey(state.selected)) return state;
  if (action.type === 'start') return { ...state, status: 'pending', options: emptyOptions, profileSettings: {}, error: '' };
  if (state.status !== 'pending') return state;
  if (action.type === 'failed') return { ...state, status: 'failed', error: action.error };
  const defaults = defaultPlaybackSettings(action.options, action.preferences);
  const profileSettings: PlaybackSettings = {
    ...(action.options.audio.length ? { audioTrackId: defaults.audioTrackId } : {}),
    ...(action.options.subtitles.length ? { subtitleTrackId: defaults.subtitleTrackId } : {}),
    ...(action.options.qualities.length ? { qualityId: defaults.qualityId } : {}),
  };
  return { ...state, status: 'complete', options: action.options, profileSettings };
}

/** Unset choices let the player resolve profile defaults while optional discovery is pending or unavailable. */
export function detailsPlaybackSettings(state: DetailsState): PlaybackSettings {
  return { ...state.profileSettings, ...state.edits };
}

export function detailsCanPlay(state: DetailsState, unavailable = false): boolean {
  return !!state.selected && !unavailable && !state.selected.unavailable && !['folder', 'series'].includes(state.selected.type);
}

type DiscoveryCallbacks<T> = { onResult: (result: T) => void; onError: (reason: unknown) => void };
type DiscoverySchedule = (callback: () => void, delayMs: number) => () => void;
const scheduleDiscovery: DiscoverySchedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/** Finishes independently of an unresponsive dependency and aborts temporary resources on every exit path. */
export function startDetailsDiscovery<T>(
  discover: (signal: AbortSignal) => Promise<T>,
  callbacks: DiscoveryCallbacks<T>,
  { timeoutMs = detailsDiscoveryTimeoutMs, schedule = scheduleDiscovery }: { timeoutMs?: number; schedule?: DiscoverySchedule } = {},
): () => void {
  const controller = new AbortController();
  let finished = false;
  let cancelDeadline = () => {};
  const finish = (publish?: () => void, reason?: unknown) => {
    if (finished) return;
    finished = true;
    cancelDeadline();
    controller.abort(reason);
    publish?.();
  };
  cancelDeadline = schedule(() => {
    const reason = new DOMException('Track discovery took too long.', 'TimeoutError');
    finish(() => callbacks.onError(reason), reason);
  }, timeoutMs);
  void Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return discover(controller.signal);
  }).then(
    result => finish(() => callbacks.onResult(result)),
    reason => finish(() => callbacks.onError(reason), reason),
  );
  return () => finish();
}
