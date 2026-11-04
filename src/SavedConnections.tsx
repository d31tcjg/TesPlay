import { ArrowUpRight, ListFilter, Pencil, Server, Trash2, Users } from 'lucide-react';
import { services } from './catalog';
import { YouTubeLogo } from './components';
import type { Connection } from './types';

export default function SavedConnections({ connections, busy, onTest, onEdit, onCategories, onPlexOptions, onBrowse, onDelete }: {
  connections: Connection[];
  busy: boolean;
  onTest: (connection: Connection) => Promise<void>;
  onEdit: (connection: Connection) => Promise<void>;
  onCategories: (connection: Connection) => void;
  onPlexOptions: (connection: Connection, mode: 'servers' | 'profiles') => Promise<void>;
  onBrowse: (connection: Connection) => void;
  onDelete: (connection: Connection) => void;
}) {
  return <>
    {!!connections.length && (
      <div className="saved-connections">
        {connections.map((c) => (
          <div className="saved-connection" key={c.id}>
            <div className={`service-mark ${c.type}`}>
              {c.type === "youtube" ? <YouTubeLogo/> : services.find((s) => s.id === c.type)?.letters || "TV"}
            </div>
            <div className="connection-title">
              <h3>{c.name}</h3>
              <p>{c.shared && 'Shared with you · '}{['xtream','m3u'].includes(c.type) && Array.isArray(c.loadedCategories) ? `${c.loadedCategories.length} categories loaded · IPTV bundle` : c.summary || c.type}</p>
            </div>
            <div className="connection-actions">
              {!c.shared && <>
              <button
                className="button small ghost"
                disabled={busy}
                onClick={() =>
                  onTest(c)
                }
              >
                Test
              </button>
              <button
                className="icon-button"
                disabled={busy}
                aria-label={`Edit ${c.name}`}
                onClick={() => onEdit(c)}
              >
                <Pencil size={18} />
              </button>
              {['xtream','m3u'].includes(c.type) && <button className="icon-button" disabled={busy}
                aria-label={`Choose categories for ${c.name}`} title="Choose categories" onClick={() => onCategories(c)}><ListFilter size={18}/></button>}
              {(c.type === "drive" ||
                (c.type === "youtube" &&
                  c.authMode ===
                    "oauth")) && (
                <a
                  className="button small ghost"
                  href={`/api/${c.type}/auth?connectionId=${encodeURIComponent(c.id)}`}
                >
                  {c.type === "youtube"
                    ? c.oauthAuthorized
                      ? "Reconnect Google"
                      : "Connect Google account"
                    : "Authorize Google Drive"}{" "}
                  <ArrowUpRight size={15} />
                </a>
              )}
              {c.type === "plex" && (
                <>
                  <button
                    className="icon-button"
                    aria-label={`Choose server for ${c.name}`}
                    onClick={() => onPlexOptions(c, "servers")}
                  >
                    <Server size={19} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Choose Plex profile for ${c.name}`}
                    onClick={() => onPlexOptions(c, "profiles")}
                  >
                    <Users size={19} />
                  </button>
                </>
              )}
              </>}
              <button className="button small" onClick={() => onBrowse(c)}>
                Browse
              </button>
              {!c.shared && <button
                className="icon-button danger"
                aria-label={`Remove ${c.name}`}
                onClick={() => onDelete(c)}
              >
                <Trash2 size={18} />
              </button>}
            </div>
          </div>
        ))}
      </div>
    )}
  </>;
}
