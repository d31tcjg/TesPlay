import { Plus } from 'lucide-react';
import { services } from './catalog';
import { YouTubeLogo } from './components';

export default function ConnectionServices({ preview, onSignIn, onAdd, canUseLocal=true }: {
  preview: boolean;
  onSignIn: () => void;
  onAdd: (type: string) => void;
  canUseLocal?:boolean;
}) {
  return (
    <div className="connection-grid">
      {services.filter(service=>service.id!=='local'||canUseLocal).map((s) => (
        <article className="connection-card" key={s.id}>
          <div className="connection-card-top">
            <div
              className={`service-mark ${s.id}`}
              style={{ color: s.color }}
            >
              {s.id === "youtube" ? <YouTubeLogo/> : s.letters}
            </div>
            <span className="type-label">
              {s.id === "crunchyroll"
                ? "Unavailable in player"
                : s.id === "local"
                  ? "On your server"
                  : "Personal connection"}
            </span>
          </div>
          <h2>{s.name}</h2>
          <p>{s.description}</p>
          {s.id === "crunchyroll" ? (
            <p className="form-help">
              In-app playback is not available from this provider. No
              connection can be added yet.
            </p>
          ) : (
            <button
              className="button ghost"
              onClick={() =>
                preview
                  ? onSignIn()
                  : onAdd(s.id)
              }
            >
              <Plus size={17} />
              Connect {s.name}
            </button>
          )}
        </article>
      ))}
    </div>
  );
}
