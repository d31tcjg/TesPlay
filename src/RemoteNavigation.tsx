import { useRef } from "react";
import type { RefObject } from "react";
import { ListVideo, Monitor, Search } from "lucide-react";
import { useGlassNavigation } from "./navigation/glass-navigation";
import "./navigation/glass.css";
import { REMOTE_DRAWER_ID } from "./RemoteDrawer";

export type RemoteTab = "remote" | "browse" | "queue";

const destinations = [
  { id: "remote", label: "Remote", Icon: Monitor },
  { id: "browse", label: "Browse", Icon: Search },
  { id: "queue", label: "Queue", Icon: ListVideo },
] as const;

export default function RemoteNavigation({
  current,
  queuedCount,
  remoteOpen,
  remoteTrigger,
  onSelect,
}: {
  current: RemoteTab;
  queuedCount: number;
  remoteOpen: boolean;
  remoteTrigger: RefObject<HTMLButtonElement | null>;
  onSelect: (tab: RemoteTab) => void;
}) {
  const root = useRef<HTMLElement>(null);
  useGlassNavigation(root, current, false, true);

  return (
    <nav
      ref={root}
      className="cinema-nav glass-navigation glass-bar glass-dock"
      aria-label="Remote navigation"
      data-glass-current={current}
    >
      {destinations.map(({ id, label, Icon }) => (
        <button
          type="button"
          key={id}
          ref={id === "remote" ? remoteTrigger : undefined}
          className="navigation-icon"
          data-navigation-key={id}
          data-glass-active={current === id}
          aria-current={id !== "remote" && current === id ? "page" : undefined}
          aria-pressed={id === "remote" ? remoteOpen : undefined}
          aria-expanded={id === "remote" ? remoteOpen : undefined}
          aria-controls={id === "remote" ? REMOTE_DRAWER_ID : undefined}
          onClick={() => onSelect(id)}
        >
          <Icon aria-hidden="true" />
          <span className="navigation-label">
            {label}
            {id === "queue" && queuedCount > 0 ? ` · ${queuedCount}` : ""}
          </span>
        </button>
      ))}
    </nav>
  );
}
