import { useLayoutEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { X } from "lucide-react";

export const REMOTE_DRAWER_ID = "remote-playback-controls";

/** A nonmodal drawer keeps navigation available while the library is inert. */
export default function RemoteDrawer({
  open,
  onClose,
  trigger,
  children,
}: {
  open: boolean;
  onClose: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const backdrop = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useLayoutEffect(() => {
    if (open) close.current?.focus({ preventScroll: true });
    else if (wasOpen.current) {
      const focused = document.activeElement;
      if (
        focused === document.body ||
        focused === backdrop.current ||
        panel.current?.contains(focused)
      )
        trigger.current?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open, trigger]);

  return (
    <>
      <button
        ref={backdrop}
        type="button"
        className="remote-drawer-backdrop"
        aria-label="Dismiss remote"
        aria-hidden={!open}
        inert={!open}
        onClick={onClose}
      />
      <aside
        ref={panel}
        id={REMOTE_DRAWER_ID}
        className="remote-drawer"
        aria-label="Remote controls"
        aria-hidden={!open}
        inert={!open}
      >
        <header className="remote-drawer-heading">
          <h2>Remote</h2>
          <button
            ref={close}
            type="button"
            aria-label="Close remote"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="remote-drawer-body">{children}</div>
      </aside>
    </>
  );
}
