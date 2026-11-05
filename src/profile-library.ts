import { errorMessage } from './api';
import { mergePlexContinuity, type PlexContinuity } from './plex-continuity';
import { itemKey } from './types';
import type { Connection, Library, MediaItem, Starred } from './types';

export const blankLibrary: Library = { favorites: [], progress: [] };

type AccountSession = { readonly userId: string | null };
export type LibraryIdentity = {
  readonly userId: string | null;
  readonly profileId: string | null;
  readonly accountSession: AccountSession;
};
type Snapshot = { identity: LibraryIdentity; value: Library };
type Request = <T>(path: string, body?: unknown, method?: string, signal?: AbortSignal, keepalive?: boolean) => Promise<T>;
type Dependencies = {
  request: Request;
  connections: () => Connection[];
  onToast: (message: string) => void;
  now?: () => string;
};

/** Pure identity preparation: abandoned renders never change the active request context. */
export function createLibraryIdentity(userId: string | null, profileId: string | null, previous?: LibraryIdentity): LibraryIdentity {
  if (previous?.userId === userId && previous.profileId === profileId) return previous;
  return {
    userId,
    profileId,
    accountSession: previous?.userId === userId ? previous.accountSession : { userId },
  };
}

/** Keeps asynchronous library results attached to the account/profile that requested them. */
export class ProfileLibrary {
  private identity = createLibraryIdentity(null, null);
  private snapshot: Snapshot = { identity: this.identity, value: blankLibrary };
  private listeners = new Set<() => void>();
  private loadRequest = 0;
  private progressRequests = new Map<AccountSession, Map<string, Promise<void>>>();

  constructor(private readonly dependencies: Dependencies) {}

  setIdentity(identity: LibraryIdentity): void {
    this.identity = identity;
  }

  isCurrent = (identity: LibraryIdentity) => identity === this.identity;
  private isCurrentAccount(identity: LibraryIdentity): boolean {
    return identity.accountSession === this.identity.accountSession;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private get library(): Library {
    return this.isCurrent(this.snapshot.identity) ? this.snapshot.value : blankLibrary;
  }

  private update(identity: LibraryIdentity, change: Library | ((library: Library) => Library)): void {
    if (!this.isCurrent(identity)) return;
    this.snapshot = { identity, value: typeof change === 'function' ? change(this.library) : change };
    this.listeners.forEach(listener => listener());
  }

  private notify(identity: LibraryIdentity, message: string): void {
    if (this.isCurrent(identity)) this.dependencies.onToast(message);
  }

  load = async (): Promise<void> => {
    const identity = this.identity;
    const request = ++this.loadRequest;
    const current = () => this.isCurrent(identity) && request === this.loadRequest;
    const local = await this.dependencies.request<Library>('/library/state');
    if (!current()) return;
    this.update(identity, local);
    const plex = this.dependencies.connections().filter(connection => connection.type === 'plex');
    if (!plex.length) return;
    const results = await Promise.allSettled(plex.map(connection =>
      this.dependencies.request<PlexContinuity>(`/plex/${connection.id}/continuity`),
    ));
    if (!current()) return;
    const successful = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    if (results.some(result => result.status === 'rejected')) {
      successful.push({ progress: [], watchlist: [], notes: ['Plex continuity could not refresh. Check the connection and linked Plex Home profile.'] });
    }
    this.update(identity, library => mergePlexContinuity(library, successful));
  };

  star = async (value: Starred): Promise<void> => {
    const identity = this.identity;
    try {
      const result = await this.dependencies.request<{ stars: Starred[] }>('/library/stars', {
        ...value, profileId: identity.profileId,
      });
      this.update(identity, library => ({ ...library, stars: result.stars }));
    } catch (reason) {
      this.notify(identity, errorMessage(reason));
    }
  };

  updateQueue = async (action: 'add' | 'remove' | 'clear', item?: MediaItem): Promise<void> => {
    const identity = this.identity;
    const result = await this.dependencies.request<{ queue: MediaItem[] }>('/library/queue', {
      action, profileId: identity.profileId, ...(item ? { item } : {}),
    });
    this.update(identity, library => ({ ...library, queue: result.queue }));
  };

  favorite = async (item: MediaItem): Promise<void> => {
    const identity = this.identity;
    if (this.dependencies.connections().some(connection => connection.id === item.connectionId && connection.type === 'youtube')) {
      const queued = (this.library.queue || []).some(value => itemKey(value) === itemKey(item));
      try {
        await this.updateQueue(queued ? 'remove' : 'add', item);
        this.notify(identity, queued ? 'Removed from Watch playlist' : 'Added to Watch playlist');
      } catch (reason) {
        this.notify(identity, errorMessage(reason));
      }
      return;
    }
    if (!identity.userId) {
      this.notify(identity, 'Sign in to save your personal watchlist.');
      return;
    }
    try {
      const result = await this.dependencies.request<{ favorites: MediaItem[] }>('/library/favorites', {
        item, profileId: identity.profileId,
      });
      this.update(identity, library => ({ ...library, favorites: result.favorites }));
      this.notify(identity, result.favorites.some(value => itemKey(value) === itemKey(item)) ? 'Added to My list' : 'Removed from My list');
    } catch (reason) {
      this.notify(identity, errorMessage(reason));
    }
  };

  saveProgress = (identity: LibraryIdentity, item: MediaItem, seconds: number, duration: number, state: 'playing' | 'paused' | 'stopped' = 'stopped'): Promise<void> => {
    if (!identity.userId || !this.isCurrentAccount(identity)) return Promise.resolve();
    let requests = this.progressRequests.get(identity.accountSession);
    if (!requests) {
      requests = new Map();
      this.progressRequests.set(identity.accountSession, requests);
    }
    const key = JSON.stringify([identity.profileId, itemKey(item)]);
    const previous = requests.get(key) || Promise.resolve();
    // Finish ordered checkpoints for their original profile, even after a profile switch.
    // A new account session never inherits queued writes from an earlier login.
    const pending = previous.catch(() => {}).then(async () => {
      if (!this.isCurrentAccount(identity)) return;
      const result = await this.dependencies.request<{ plexSyncError?: string; channelsSyncError?: string; connectionSyncError?: string }>('/library/progress', {
        item, seconds, duration, state, profileId: identity.profileId,
      }, undefined, undefined, true);
      if (!this.isCurrent(identity)) return;
      // One toast: separate notifications would overwrite each other in the UI.
      const syncErrors = [...new Set([result.connectionSyncError, result.plexSyncError, result.channelsSyncError].filter(Boolean))];
      if (syncErrors.length) this.notify(identity, syncErrors.join(' '));
      this.update(identity, library => ({
        ...library,
        progress: [
          { item, seconds, duration, updatedAt: this.dependencies.now?.() || new Date().toISOString() },
          ...library.progress.filter(progress => itemKey(progress.item) !== itemKey(item)),
        ],
      }));
    }).catch(reason => {
      this.notify(identity, `Watch progress could not be saved: ${errorMessage(reason)}`);
    }).finally(() => {
      if (requests.get(key) === pending) requests.delete(key);
      if (!requests.size) this.progressRequests.delete(identity.accountSession);
    });
    requests.set(key, pending);
    return pending;
  };
}
