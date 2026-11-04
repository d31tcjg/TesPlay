import { lazy, Suspense, useEffect, useState } from "react";
const StremioConnectionDialog = lazy(() => import("./StremioConnectionDialog"));
import type { FormEvent } from "react";
import { ArrowUpRight, Cable, Plus, Smartphone } from 'lucide-react';
import { api, errorMessage } from "./api";
import { Busy } from "./components";
import type { Connection } from "./types";
import ConnectionEditor from './ConnectionEditor';
import type { ConnectionFormOptions } from './ConnectionEditor';
import ConnectionServices from './ConnectionServices';
import SavedConnections from './SavedConnections';
import { PlexServerDialog, PlexProfileDialog } from './PlexConnectionDialogs';
import type { PlexPin, PlexServer, PlexProfile } from './plex-connection';
import PhoneSetupDialog from './PhoneSetupDialog';
import RemoveConnectionDialog from './RemoveConnectionDialog';
import IptvCategoryDialog from './IptvCategoryDialog';
export default function Connections({
  connections,
  onRefresh,
  onBrowse,
  initialType,
  onInitialUsed,
  preview,
  onSignIn,
  embedded = false,
}: {
  connections: Connection[];
  onRefresh: () => Promise<void>;
  onBrowse: (c: Connection) => void;
  initialType?: string;
  onInitialUsed: () => void;
  preview: boolean;
  onSignIn: () => void;
  embedded?: boolean;
}) {
  const [adding, setAdding] = useState<string | null>(initialType || null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [deleting, setDeleting] = useState<Connection | null>(null);
  const [plexPin, setPlexPin] = useState<PlexPin | null>(null),
    [plexConnection, setPlexConnection] = useState<Connection | null>(null),
    [servers, setServers] = useState<PlexServer[] | null>(null),
    [profiles, setProfiles] = useState<PlexProfile[] | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [categoryConnection, setCategoryConnection] = useState<Connection | null>(null);
  const [editConfig, setEditConfig] = useState<Record<string, string>>({});
  const [configuredFields, setConfiguredFields] = useState<string[]>([]);
  const [phoneSetup, setPhoneSetup] = useState(false);
  const [publicUrl, setPublicUrl] = useState(location.origin);
  const [capabilities,setCapabilities]=useState({googleConfigured:false,canUseLocal:false});
  useEffect(() => {
    if (preview) return;
    let dead = false;
    api<typeof capabilities>('/connection-capabilities').then(value=>{if(!dead)setCapabilities(value);}).catch(()=>{});
    api<{ publicUrl?: string }>("/settings")
      .then((s) => {
        if (!dead && s.publicUrl) setPublicUrl(s.publicUrl.replace(/\/$/, ""));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [preview]);
  const phoneLink = `${publicUrl}/?view=connections&phone=1`;
  function beginAdd(type: string) {
    setEditing(null);
    setEditConfig({});
    setConfiguredFields([]);
    setNotice('');
    setError('');
    setAdding(type);
  }
  async function editConnection(c: Connection) {
    if (c.type === "stremio") { setEditing(c); setAdding("stremio"); return; }
    await run(async () => {
      const r = await api<{
        connection: Connection;
        config: Record<string, string>;
        configuredFields: string[];
      }>(`/connections/${c.id}/config`);
      setEditing(r.connection);
      setEditConfig(r.config);
      setConfiguredFields(r.configuredFields);
      setAdding(c.type);
    });
  }
  function close() {
    setAdding(null);
    setEditing(null);
    setEditConfig({});
    setConfiguredFields([]);
    setPlexPin(null);
    setError("");
    onInitialUsed();
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>, { playlist, youtubeMode, loadedCategories }: ConnectionFormOptions) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    await run(async () => {
      const { name, ...config } = f;
      if (adding === "m3u" && playlist) config.content = playlist;
      if (adding === "youtube") config.authMode = youtubeMode;
      const newIptv = !editing && ['xtream', 'm3u'].includes(adding || '');
      if (newIptv && loadedCategories === undefined) throw new Error('Load and choose IPTV categories before saving.');
      const r = await api<{ connection: Connection }>(
        editing ? `/connections/${editing.id}` : "/connections",
        {
          type: adding,
          name,
          config: { ...config, ...(newIptv ? { loadedCategories } : {}) },
        },
        editing ? "PUT" : "POST",
      );
      await onRefresh();
      setNotice(
        newIptv ? `${r.connection.name} saved with your chosen categories.` : `${r.connection.name} saved. Test the connection to check access.`,
      );
      close();
    });
  }
  async function startPlex() {
    await run(async () => {
      setPlexPin(await api("/plex/pin", {}));
    });
  }
  async function startGoogle() {
    if(!adding)return;
    await run(async()=>{
      const result=await api<{connection:Connection}>(editing?`/connections/${editing.id}`:'/connections',{type:adding,name:editing?.name || (adding==='drive'?'Google Drive':'YouTube'),config:adding==='youtube'?{authMode:'oauth'}:{}},editing?'PUT':'POST');
      await onRefresh();location.assign(`/api/${adding}/auth?connectionId=${encodeURIComponent(result.connection.id)}`);
    });
  }
  async function checkPlex() {
    if (!plexPin) return;
    await run(async () => {
      const r = await api<{
        pending?: boolean;
        connection?: Connection;
        servers?: PlexServer[];
      }>("/plex/pin/check", { id: plexPin.id, code: plexPin.code });
      if (r.pending) {
        setNotice(
          "Plex is waiting for authorization. Open the link and approve, then check again.",
        );
        return;
      }
      if (r.connection) {
        setPlexConnection(r.connection);
        setServers(r.servers || []);
        setPlexPin(null);
        setAdding(null);
        await onRefresh();
        onInitialUsed();
      }
    });
  }
  async function plexOptions(c: Connection, mode: "servers" | "profiles") {
    await run(async () => {
      setPlexConnection(c);
      if (mode === "servers") {
        const r = await api<{
          servers: PlexServer[];
        }>(`/plex/${c.id}/servers`);
        setServers(r.servers);
      } else {
        const r = await api<{
          profiles: PlexProfile[];
        }>(`/plex/${c.id}/profiles`);
        setProfiles(r.profiles);
      }
    });
  }
  return (
    <section className="page-section">
      {!embedded && <div className="page-heading">
        <div>
          <span className="eyebrow">ALL YOUR WORLDS, TOGETHER</span>
          <h1>Your connections</h1>
          <p>
            Your API keys and provider accounts, saved securely with your
            TesPlay account.
          </p>
        </div>
        <span className="count-pill">
          <Cable size={16} />
          {connections.length} connected
        </span>
      </div>}
      {preview && (
        <div className="notice">
          <span>Sign in to save connections securely on your server.</span>
          <button className="text-button" onClick={onSignIn}>
            Sign in <ArrowUpRight size={16} />
          </button>
        </div>
      )}
      {!preview && (
        <div className="phone-setup-notice">
          <div>
            <h3>Set it up on your phone</h3>
            <p>
              Scan once to add provider URLs, passwords and API keys with your
              phone’s keyboard. Connections appear on this screen automatically.
            </p>
          </div>
          <button
            className="button ghost"
            onClick={() => setPhoneSetup(true)}
          >
            <Smartphone size={19} /> Set up with QR
          </button>
        </div>
      )}
      {error && !adding && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {connections.some(c => ['xtream','m3u'].includes(c.type)) && <div className="iptv-bundle-notice"><span>All IPTV connections appear together in one library.</span><button className="button ghost small" onClick={() => beginAdd('xtream')}><Plus size={16}/>Add IPTV connection</button></div>}
      <SavedConnections connections={connections} busy={busy} onBrowse={onBrowse} onEdit={editConnection} onCategories={setCategoryConnection}
        onDelete={setDeleting} onPlexOptions={plexOptions} onTest={c => run(async () => {
          const result = await api<{ message: string }>(`/connections/${c.id}/test`, {});
          setNotice(result.message);
        })}/>
      <ConnectionServices preview={preview} onSignIn={onSignIn} onAdd={beginAdd} canUseLocal={capabilities.canUseLocal}/>
      {categoryConnection && <IptvCategoryDialog key={categoryConnection.id} connection={categoryConnection} onClose={() => setCategoryConnection(null)} onSaved={onRefresh}/>}
      {adding === "stremio" && <Suspense fallback={<Busy label="Opening Stremio…"/>}><StremioConnectionDialog connection={editing} preview={preview} onClose={close} onSignIn={onSignIn} onChanged={onRefresh}/></Suspense>}
      {adding && adding !== "stremio" && <ConnectionEditor key={`${editing?.id || 'new'}:${adding}`} adding={adding} editing={editing} editConfig={editConfig} configuredFields={configuredFields}
        preview={preview} busy={busy} error={error} notice={notice} publicUrl={publicUrl} plexPin={plexPin}
        managedGoogle={capabilities.googleConfigured||!capabilities.canUseLocal} googleConfigured={capabilities.googleConfigured} startGoogle={startGoogle}
        onClose={close} onSignIn={onSignIn} onPhoneSetup={() => setPhoneSetup(true)} onTypeChange={setAdding}
        onSubmit={submit} startPlex={startPlex} checkPlex={checkPlex}/>}
      {servers && plexConnection && <PlexServerDialog servers={servers} busy={busy} error={error} onClose={() => setServers(null)}
        onSelect={server => run(async () => {
          await api(`/plex/${plexConnection.id}/server`, { id: server.id, url: server.url });
          setServers(null);
          await onRefresh();
          setNotice("Plex server selected. Choose the people icon to select a Plex Home profile.");
        })}/>}
      {profiles && plexConnection && <PlexProfileDialog profiles={profiles} busy={busy} error={error} onClose={() => setProfiles(null)}
        onSelect={(profile, pin) => run(async () => {
          await api(`/plex/${plexConnection.id}/profile`, { id: profile.id, pin: pin || undefined });
          setProfiles(null);
          setNotice(`Watching as ${profile.name} on Plex.`);
        })}/>}
      {deleting && <RemoveConnectionDialog deleting={deleting} busy={busy} error={error} onClose={() => setDeleting(null)}
        onConfirm={() => run(async () => {
          await api(`/connections/${deleting.id}`, {}, 'DELETE');
          setDeleting(null);
          await onRefresh();
        })}/>}
      {phoneSetup && <PhoneSetupDialog phoneLink={phoneLink} onRefresh={onRefresh} onClose={() => setPhoneSetup(false)} onError={setError}/>}
      {busy && !adding && !servers && !profiles && (
        <Busy label="Checking connection" />
      )}
    </section>
  );
}
