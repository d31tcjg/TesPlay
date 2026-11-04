import type { Preferences } from './types';

export const defaultAccountPreferences = { autoPlayNext: true, hideYouTubeShorts: false };
export const legacyYouTubeShortsKey = 'tesplay.youtube.showShorts.v1';
export const legacyYouTubeShortsOwnerKey = 'tesplay.youtube.showShorts.migrationOwner.v1';
export type PreferencesSnapshot = { preferences: Preferences; ready: boolean; busy: boolean };
type AccountContext = { userId: string; canWrite: boolean; abort: AbortController };
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Dependencies = {
  request: <T>(path: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<T>;
  publish: (snapshot: PreferencesSnapshot) => void;
  onError: (reason: unknown) => void;
  storage: () => PreferenceStorage;
};

/** Account ownership and request order apply equally to reads and setting changes. */
export class AccountPreferencesController {
  private context: AccountContext | null = null;
  private version = 0;
  private writing: AccountContext | null = null;
  private snapshot: PreferencesSnapshot = { preferences: defaultAccountPreferences, ready: false, busy: false };

  constructor(private readonly dependencies: Dependencies) {}

  activate(userId?: string, canWrite = true) {
    this.context?.abort.abort();
    this.version++;
    this.context = userId ? { userId, canWrite, abort: new AbortController() } : null;
    this.snapshot = { preferences: defaultAccountPreferences, ready: false, busy: !!userId };
    this.dependencies.publish(this.snapshot);
    return this.context;
  }

  deactivate(context: AccountContext | null) {
    context?.abort.abort();
    if (this.context === context) {
      this.context = null;
      this.version++;
    }
  }

  private current(context: AccountContext, version: number) {
    return this.context === context && this.version === version && !context.abort.signal.aborted;
  }

  private legacyChoice(context: AccountContext) {
    try {
      const storage = this.dependencies.storage();
      const value = storage.getItem(legacyYouTubeShortsKey);
      if (value !== 'false' && value !== 'true') return undefined;
      const owner = storage.getItem(legacyYouTubeShortsOwnerKey);
      if (owner && owner !== context.userId) return undefined;
      // Keep an interrupted or failed import tied to its original account.
      if (!owner) storage.setItem(legacyYouTubeShortsOwnerKey, context.userId);
      return value === 'false';
    } catch { return undefined; }
  }

  private retireLegacyChoice(context: AccountContext) {
    try {
      const storage = this.dependencies.storage();
      const owner = storage.getItem(legacyYouTubeShortsOwnerKey);
      if (owner && owner !== context.userId) return;
      storage.removeItem(legacyYouTubeShortsKey);
      storage.removeItem(legacyYouTubeShortsOwnerKey);
    }
    catch { /* Account preferences still work when browser storage is unavailable. */ }
  }

  async load() {
    const context = this.context;
    if (!context || this.writing === context) return;
    const version = ++this.version;
    this.snapshot = { ...this.snapshot, busy: true };
    this.dependencies.publish(this.snapshot);
    try {
      let result = await this.dependencies.request<{ preferences: Preferences }>('/settings', undefined, undefined, context.abort.signal);
      if (!this.current(context, version)) return;
      const legacy = context.canWrite ? this.legacyChoice(context) : undefined;
      if (result.preferences.hideYouTubeShorts === undefined && legacy !== undefined) {
        // The server initializes only an unset value; a choice saved on another
        // browser between this GET and PATCH remains authoritative.
        result = await this.dependencies.request('/settings', {
          preferences: { hideYouTubeShorts: legacy }, initializeYouTubeShorts: true,
        }, 'PATCH', context.abort.signal);
        if (!this.current(context, version)) return;
      }
      if (context.canWrite && result.preferences.hideYouTubeShorts !== undefined) this.retireLegacyChoice(context);
      this.snapshot = { preferences: { ...defaultAccountPreferences, ...result.preferences }, ready: true, busy: false };
      this.dependencies.publish(this.snapshot);
    } catch (reason) {
      if (!this.current(context, version)) return;
      this.snapshot = { ...this.snapshot, busy: false };
      this.dependencies.publish(this.snapshot);
      this.dependencies.onError(reason);
    }
  }

  async update(preferences: Partial<Preferences>) {
    const context = this.context;
    if (!context?.canWrite || this.writing === context) return;
    const version = ++this.version;
    this.writing = context;
    this.snapshot = { ...this.snapshot, busy: true };
    this.dependencies.publish(this.snapshot);
    try {
      const result = await this.dependencies.request<{ preferences: Preferences }>('/settings', { preferences }, 'PATCH', context.abort.signal);
      if (!this.current(context, version)) return;
      if (result.preferences.hideYouTubeShorts !== undefined) this.retireLegacyChoice(context);
      this.snapshot = { preferences: { ...defaultAccountPreferences, ...result.preferences }, ready: true, busy: false };
      this.dependencies.publish(this.snapshot);
    } catch (reason) {
      if (!this.current(context, version)) return;
      this.snapshot = { ...this.snapshot, busy: false };
      this.dependencies.publish(this.snapshot);
      this.dependencies.onError(reason);
    } finally {
      if (this.writing === context) this.writing = null;
    }
  }
}
