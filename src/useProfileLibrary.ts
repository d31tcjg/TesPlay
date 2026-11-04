import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { blankLibrary, createLibraryIdentity, ProfileLibrary } from './profile-library';
import type { Connection } from './types';

export default function useProfileLibrary({ userId, profileId, connections, onToast }: {
  userId?: string | null;
  profileId?: string | null;
  connections: Connection[];
  onToast: (message: string) => void;
}) {
  const connectionsRef = useRef(connections);
  const toastRef = useRef(onToast);
  const [controller] = useState(() => new ProfileLibrary({
    request: api,
    connections: () => connectionsRef.current,
    onToast: message => toastRef.current(message),
  }));
  const user = userId || null;
  const profile = profileId || null;
  const [storedIdentity, setIdentity] = useState(() => createLibraryIdentity(user, profile));
  let identity = storedIdentity;
  if (identity.userId !== user || identity.profileId !== profile) {
    // React owns this state transition and rolls it back if the render is abandoned.
    identity = createLibraryIdentity(user, profile, identity);
    setIdentity(identity);
  }
  useLayoutEffect(() => {
    connectionsRef.current = connections;
    toastRef.current = onToast;
    controller.setIdentity(identity);
  }, [controller, identity, connections, onToast]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return {
    library: snapshot.identity === identity ? snapshot.value : blankLibrary,
    libraryIdentity: identity,
    loadLibrary: controller.load,
    favorite: controller.favorite,
    star: controller.star,
    updateQueue: controller.updateQueue,
    saveLibraryProgress: controller.saveProgress,
  };
}
