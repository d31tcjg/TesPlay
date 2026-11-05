import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, ArrowUpRight, Check, ChevronLeft, LoaderCircle, RefreshCw, Smartphone } from 'lucide-react';
import { services } from './catalog';
import { Busy, Modal } from './components';
import { api, errorMessage } from './api';
import IptvCategoryPicker from './IptvCategoryPicker';
import type { IptvCategory, IptvSelection } from './IptvCategoryPicker';
import QrCode from './QrCode';
import { connectionFields as fieldsFor, youtubeAuthMode } from './connection-fields';
import type { YouTubeAuthMode } from './connection-fields';
import type { Connection } from './types';
import type { PlexPin } from './plex-connection';

export type ConnectionFormOptions = { playlist: string; youtubeMode: YouTubeAuthMode; loadedCategories?:IptvSelection };

export default function ConnectionEditor({ adding, editing, editConfig, configuredFields, preview, busy, error, notice, publicUrl, plexPin, managedGoogle=false,googleConfigured=false,startGoogle,
  onClose: close, onSignIn, onPhoneSetup, onTypeChange, onSubmit, startPlex, checkPlex }: {
  adding: string;
  editing: Connection | null;
  editConfig: Record<string, string>;
  configuredFields: string[];
  preview: boolean;
  busy: boolean;
  error: string;
  notice: string;
  publicUrl: string;
  plexPin: PlexPin | null;
  managedGoogle?:boolean;
  googleConfigured?:boolean;
  startGoogle?:()=>Promise<void>;
  onClose: () => void;
  onSignIn: () => void;
  onPhoneSetup: () => void;
  onTypeChange: (type: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>, options: ConnectionFormOptions) => Promise<void>;
  startPlex: () => Promise<void>;
  checkPlex: () => Promise<void>;
}) {
  const [playlist, setPlaylist] = useState('');
  const [showPlexAdvanced,setShowPlexAdvanced]=useState(false);
  const [youtubeMode, setYoutubeMode] = useState<YouTubeAuthMode>(() => editing ? youtubeAuthMode(editConfig, configuredFields) : 'apiKey');
  const connectionFields = fieldsFor(adding, youtubeMode);
  const newIptv = !editing && ['xtream', 'm3u'].includes(adding);
  const formRef = useRef<HTMLFormElement>(null), categoryRequest = useRef<AbortController | null>(null);
  const [categories, setCategories] = useState<IptvCategory[]>([]), [selection, setSelection] = useState<IptvSelection>([]);
  const [categoriesReady, setCategoriesReady] = useState(false), [categoriesLoading, setCategoriesLoading] = useState(false), [categoriesError, setCategoriesError] = useState('');
  const [categoryStep, setCategoryStep] = useState(false);
  useEffect(() => () => categoryRequest.current?.abort(), []);
  function invalidateCategories() {
    categoryRequest.current?.abort(); categoryRequest.current = null;
    setCategoriesReady(false); setCategoriesLoading(false); setCategoriesError(''); setCategories([]); setSelection([]);
  }
  async function loadCategories() {
    const form = formRef.current;
    if (!form || !form.reportValidity()) return;
    const previous = categoriesReady ? selection : [];
    invalidateCategories();
    setCategoryStep(true);
    const { name, ...config } = Object.fromEntries(new FormData(form));
    if (adding === 'm3u' && playlist.trim()) config.content = playlist;
    const controller = new AbortController(); categoryRequest.current = controller;
    setCategoriesLoading(true);
    try {
      const result = await api<{categories:IptvCategory[]}>('/connections/categories/preview', {type:adding,name,config}, undefined, controller.signal);
      if (categoryRequest.current !== controller || controller.signal.aborted) return;
      setCategories(result.categories); setSelection(previous === null ? null : previous.filter(id => result.categories.some(c => c.id === id))); setCategoriesReady(true);
    } catch (e) {
      if (categoryRequest.current === controller && !controller.signal.aborted) setCategoriesError(errorMessage(e));
    } finally {
      if (categoryRequest.current === controller) { categoryRequest.current = null; setCategoriesLoading(false); }
    }
  }
  function submitForm(event:FormEvent<HTMLFormElement>) {
    if (newIptv && !categoryStep) {
      event.preventDefault();
      if (categoriesReady) setCategoryStep(true); else void loadCategories();
      return;
    }
    if (newIptv && !categoriesReady) { event.preventDefault(); return; }
    void onSubmit(event, {playlist, youtubeMode, ...(newIptv ? {loadedCategories:selection} : {})});
  }
  return (
    <Modal
      title={newIptv && categoryStep ? 'Choose IPTV categories' : `${editing ? "Edit" : "Connect"} ${adding === "m3u" ? "M3U playlist" : services.find((s) => s.id === adding)?.name || adding}`}
      onClose={close}
      className={newIptv ? 'iptv-setup-dialog' : ''}
    >
      {preview ? (
        <>
          <p>Sign in to save this connection.</p>
          <button className="button primary" onClick={onSignIn}>
            Sign in
          </button>
        </>
      ) : (
        <>
          {newIptv && <div className="iptv-setup-progress" aria-label={`Step ${categoryStep ? 2 : 1} of 2`}>
            <span className={!categoryStep ? 'current' : ''}>1 · Connection details</span><ArrowRight size={14}/><span className={categoryStep ? 'current' : ''}>2 · Categories</span>
          </div>}
          {!categoryStep && new URLSearchParams(location.search).get("phone") !== "1" && (
            <button
              className="button ghost full"
              onClick={() => {
                close();
                onPhoneSetup();
              }}
            >
              <Smartphone size={18} /> Enter details on my phone
            </button>
          )}
          {!categoryStep && !editing && adding === "xtream" && (
            <div className="segmented">
              <button className="selected" type="button">
                Xtream Codes
              </button>
              <button onClick={() => onTypeChange("m3u")}>M3U playlist</button>
            </div>
          )}
          {!categoryStep && !editing && adding === "m3u" && (
            <button
              className="text-button"
              onClick={() => onTypeChange("xtream")}
            >
              <ChevronLeft size={16} /> Use Xtream Codes
            </button>
          )}
          {!editing && adding === "plex" && (
            <div className="plex-signin">
              <p>Connect securely with your Plex account.</p>
              {plexPin ? (
                <>
                  <QrCode
                    value={plexPin.url}
                    label="Scan to authorize your Plex account"
                  />
                  <p className="form-help">
                    Scan with your phone, approve on Plex, then check the
                    connection here.
                  </p>
                  <a
                    className="button primary full"
                    href={plexPin.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Authorize on Plex <ArrowUpRight size={17} />
                  </a>
                  <div className="pair-code">{plexPin.code}</div>
                  <button
                    className="button ghost full"
                    disabled={busy}
                    onClick={checkPlex}
                  >
                    I’ve authorized — check connection
                  </button>
                </>
              ) : (
                <button
                  className="button primary full"
                  disabled={busy}
                  onClick={startPlex}
                >
                  Sign in with Plex <ArrowUpRight size={17} />
                </button>
              )}
              <button className="text-button" type="button" onClick={()=>setShowPlexAdvanced(value=>!value)}>{showPlexAdvanced?'Hide advanced settings':'Use advanced server settings'}</button>
              {!showPlexAdvanced&&error&&<p className="form-error" role="alert">{error}</p>}
              {!showPlexAdvanced&&notice&&<p className="form-help" role="status">{notice}</p>}
            </div>
          )}
          {managedGoogle&&['drive','youtube'].includes(adding)&&<div className="plex-signin"><p>{adding==='drive'?'Connect your Google account to browse your videos.':'Connect your Google account for subscriptions and playlists.'}</p><button className="button primary full" disabled={busy||!googleConfigured} onClick={()=>void startGoogle?.()}>Sign in with Google <ArrowUpRight size={17}/></button>{!googleConfigured&&<p className="form-help">Google sign-in is not configured on this server yet.</p>}{error&&<p className="form-error" role="alert">{error}</p>}</div>}
          {!managedGoogle&&adding === "youtube" && (
            <div className="segmented connection-mode">
              <button
                type="button"
                className={youtubeMode === "apiKey" ? "selected" : ""}
                onClick={() => setYoutubeMode("apiKey")}
              >
                API key
              </button>
              <button
                type="button"
                className={youtubeMode === "oauth" ? "selected" : ""}
                onClick={() => setYoutubeMode("oauth")}
              >
                Google sign-in
              </button>
            </div>
          )}
          {!managedGoogle&&(adding === "drive" ||
            (adding === "youtube" && youtubeMode === "oauth")) && (
            <p className="form-help">
              Create a web OAuth client in Google Cloud and enable the{" "}
              {adding === "drive" ? "Drive" : "YouTube Data"} API. Add{" "}
              <code>
                {publicUrl}/api/{adding}/callback
              </code>{" "}
              as a redirect URL. Save here, then authorize your Google
              account. Authorization is remembered until you revoke access
              or the provider requires it again.
              {adding === "youtube" && " Google sign-in unlocks your subscriptions, playlists and channel feed. An API key can only browse public videos. YouTube does not expose account watch history or Home recommendations through this API."}
            </p>
          )}
          {adding === "local" && (
            <p className="form-help">
              Mount your SMB share on the server first. For Docker, make it
              available inside the container at <code>/media</code>. The app
              can only browse the selected folder.
            </p>
          )}
          {!categoryStep && adding === "xtream" && (
            <p className="form-help">
              Add as many IPTV accounts as you like. They share one library.
              Choose your categories in the next step.
            </p>
          )}
          {editing && (
            <p className="form-help">
              Saved credentials stay hidden. Leave a saved field empty to
              keep its current value.
            </p>
          )}
          {!(managedGoogle&&['drive','youtube'].includes(adding))&&!(adding==='plex'&&!editing&&!showPlexAdvanced)&&<form ref={formRef} onSubmit={submitForm} key={`${editing?.id || "new"}:${adding}`} onChange={event => {
            if (newIptv && event.target instanceof HTMLInputElement && event.target.name && event.target.name !== 'name') invalidateCategories();
          }}>
            <div className="connection-details-fields" hidden={categoryStep}>
            <label>
              Connection name
              <input
                name="name"
                defaultValue={editing?.name || ""}
                required
                placeholder={`My ${adding === "m3u" ? "playlist" : services.find((s) => s.id === adding)?.name || "library"}`}
                maxLength={80}
              />
            </label>
            {connectionFields.map((f) => (
              <label key={f.key}>
                {f.label}
                <input
                  name={f.key}
                  type={f.secret ? "password" : "text"}
                  defaultValue={editConfig[f.key] || ""}
                  required={
                    !f.optional && !configuredFields.includes(f.key) && !(adding==='m3u' && f.key==='url' && playlist.trim())
                  }
                  placeholder={
                    configuredFields.includes(f.key) && !editConfig[f.key]
                      ? "Saved — leave blank to keep"
                      : f.placeholder
                  }
                  aria-describedby={adding === 'channels' && f.key === 'url' ? 'channels-url-help' : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="none"
                />
                {adding === 'channels' && f.key === 'url' && (
                  <small id="channels-url-help" className="form-help">
                    Use the DVR’s local network address (for example http://192.168.1.20:8089)
                    or a hostname reachable from the TesPlay server, not just this device.
                    A reachable public or reverse-proxy URL can still reject DVR API access (403).
                    Test the connection after saving to check access.
                  </small>
                )}
                {configuredFields.includes(f.key) && (
                  <small className="connection-credential-note">
                    Already saved to your account
                  </small>
                )}
              </label>
            ))}
            {adding === "m3u" && (
              <label>Or paste your M3U playlist
                <textarea aria-label="M3U playlist text" rows={6} value={playlist} maxLength={20*1024*1024} placeholder={'#EXTM3U\n#EXTINF:-1,Channel name\nhttps://…'} onChange={e=>{setPlaylist(e.target.value);if(newIptv)invalidateCategories();}}/>
                <small>Use a playlist URL above or paste its contents. No access to this device’s files is needed.</small>
              </label>
            )}
            </div>
            {newIptv && categoryStep && <section aria-label="Category selection">
              <p className="form-help">Choose what to include. Use the filter icon beside Edit to change your categories later.</p>
              {adding === 'm3u' && <p className="form-help">The playlist downloads as one file; only the selected groups appear in your library.</p>}
              {categoriesError && <div className="form-error" role="alert">{categoriesError}</div>}
              {categoriesLoading && <Busy label="Loading category names…"/>}
              {categoriesReady && <IptvCategoryPicker categories={categories} type={adding} value={selection} onChange={setSelection} disabled={busy}/>}
              <button type="button" className="text-button iptv-picker-retry" disabled={busy || categoriesLoading} onClick={() => void loadCategories()}><RefreshCw size={14}/>{categoriesReady ? 'Reload category names' : 'Try again'}</button>
            </section>}
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <div className="form-help" role="status">
                {notice}
              </div>
            )}
            <div className={newIptv && categoryStep ? 'iptv-setup-actions' : ''}>
            {newIptv && categoryStep && <button type="button" className="button ghost" disabled={busy} onClick={() => { categoryRequest.current?.abort(); categoryRequest.current = null; setCategoriesLoading(false); setCategoryStep(false); }}><ChevronLeft size={18}/>Back</button>}
            <button type="submit" className="button primary full" disabled={busy || newIptv && categoryStep && !categoriesReady}>
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                newIptv && !categoryStep ? <ArrowRight size={18}/> : <Check size={18} />
              )}
              {newIptv && !categoryStep ? 'Next: choose categories' : 'Save connection'}
            </button>
            </div>
          </form>}
        </>
      )}
    </Modal>
  );
}
