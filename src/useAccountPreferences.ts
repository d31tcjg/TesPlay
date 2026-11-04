import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { api } from './api';
import { AccountPreferencesController, defaultAccountPreferences } from './account-preferences';
import type { PreferencesSnapshot } from './account-preferences';
import type { Preferences } from './types';

export default function useAccountPreferences({ userId, canWrite, onError }: {
  userId?: string; canWrite: boolean; onError: (reason: unknown) => void;
}) {
  const [snapshot, setSnapshot] = useState<PreferencesSnapshot>({ preferences: defaultAccountPreferences, ready: false, busy: !!userId });
  const [loadedAccount, setLoadedAccount] = useState<string | undefined>();
  const controller = useMemo(() => new AccountPreferencesController({
    request: api, publish: setSnapshot, onError, storage: () => localStorage,
  }), [onError]);
  useLayoutEffect(() => {
    setLoadedAccount(userId);
    const context = controller.activate(userId, canWrite);
    return () => controller.deactivate(context);
  }, [controller, userId, canWrite]);
  useEffect(() => { void controller.load(); }, [controller, userId, canWrite]);
  const reloadPreferences = useCallback(() => controller.load(), [controller]);
  const updatePreferences = useCallback((value: Partial<Preferences>) => controller.update(value), [controller]);
  const current = loadedAccount === userId ? snapshot : { preferences: defaultAccountPreferences, ready: false, busy: !!userId };
  return { ...current, reloadPreferences, updatePreferences };
}
