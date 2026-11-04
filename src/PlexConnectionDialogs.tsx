import { useState } from 'react';
import { ArrowUpRight, Server, Users } from 'lucide-react';
import { Modal } from './components';
import type { PlexProfile, PlexServer } from './plex-connection';

export function PlexServerDialog({ servers, busy, error, onClose, onSelect }: {
  servers: PlexServer[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSelect: (server: PlexServer) => Promise<void>;
}) {
  return (
    <Modal title="Choose your Plex server" onClose={onClose}>
      {error && <div className="form-error">{error}</div>}
      {servers.length ? (
        servers.map((s) => (
          <button
            className="selection-row"
            disabled={busy}
            key={`${s.id}:${s.url}`}
            onClick={() => onSelect(s)}
          >
            <Server />
            <span>
              {s.name}
              <small>{s.url}</small>
            </span>
            <ArrowUpRight size={18} />
          </button>
        ))
      ) : (
        <p>
          No accessible servers were returned. Add the server URL and token
          manually.
        </p>
      )}
    </Modal>
  );
}

export function PlexProfileDialog({ profiles, busy, error, onClose, onSelect }: {
  profiles: PlexProfile[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSelect: (profile: PlexProfile, pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState('');
  return (
    <Modal
      title="Who’s watching on Plex?"
      onClose={onClose}
    >
      <p className="form-help">
        This Plex identity will be saved for your current TesPlay profile.
      </p>
      {error && <div className="form-error">{error}</div>}
      <label>
        Plex Home PIN (if required)
        <input
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="Enter protected profile PIN"
        />
      </label>
      {profiles.map((p) => (
        <button
          className="selection-row"
          disabled={busy}
          key={p.id}
          onClick={() => onSelect(p, pin)}
        >
          <Users />
          <span>
            {p.name}
            <small>{p.protected ? "PIN protected" : "Plex Home"}</small>
          </span>
          <ArrowUpRight size={18} />
        </button>
      ))}
    </Modal>
  );
}
