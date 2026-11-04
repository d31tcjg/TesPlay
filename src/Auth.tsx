import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowRight,
  LockKeyhole,
  LoaderCircle,
  Eye,
  EyeOff,
  Smartphone,
  Keyboard,
  RefreshCw,
} from "lucide-react";
import { api, errorMessage } from "./api";
import { Brand } from "./components";
import type { Auth } from "./types";
import PlaybackDefaultsFields from './PlaybackDefaultsFields';
import { defaultPlayerPreferences } from './player-preferences';
import QrCode, { isLocalOnlyUrl } from "./QrCode";
import "./auth.css";
export default function AuthScreen({
  auth,
  onAuth,
}: {
  auth: Auth;
  onAuth: (a: Auth) => void;
}) {
  const approvalPending = new URLSearchParams(location.search).has("approve");
  const [playbackDefaults, setPlaybackDefaults] = useState(defaultPlayerPreferences);
  const [manual, setManual] = useState(() => {
    const params = new URLSearchParams(location.search);
    return (
      approvalPending ||
      params.get("phone") === "1" ||
      /^\d{6}$/.test(params.get("remote") || "")
    );
  });
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [show, setShow] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      onAuth(
        await api<Auth>(
          auth.setupRequired ? "/auth/setup" : "/auth/login",
          { ...Object.fromEntries(f), ...(auth.setupRequired ? { playbackDefaults } : {}) },
        ),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={`auth-screen ${manual ? "" : "auth-qr"} ${approvalPending || new URLSearchParams(location.search).get("phone") === "1" ? "auth-phone" : ""}`}
    >
      <header className="auth-header">
        <Brand />
        <span>Personal media, together</span>
      </header>
      <main className="auth-main">
        <div className="auth-intro">
          <span className="eyebrow">Made for the Tesla browser</span>
          <h1>Your collection.<br />On the big screen.</h1>
          <p>Your films, shows and live channels, together in your Tesla. Sign in once and keep your libraries close.</p>
          <div className="auth-library-strip" aria-label="Supported libraries"><span>Plex</span><span>IPTV</span><span>YouTube</span><span>Drive</span><span>Stremio</span></div>
          <div className="auth-caption"><span className="auth-caption-line" /><span>Pick a story. Press play.</span></div>
        </div>
        <div className="auth-card">
          <span className="small-caps">Your account</span>
          <h2>
            {auth.setupRequired
              ? "Create the owner account"
              : "Sign in to TesPlay"}
          </h2>
          <p>
            {auth.setupRequired
              ? "Create the owner account for your personal cinema."
              : "Sign in to your library and saved connections."}
          </p>
          {!manual && (
            <QrLogin onAuth={onAuth} setupRequired={auth.setupRequired} />
          )}
          {manual && (
            <form onSubmit={submit}>
              {auth.setupRequired && (
                <label>
                  Your name
                  <input
                    name="name"
                    autoComplete="name"
                    required
                    placeholder="First name"
                    maxLength={60}
                  />
                </label>
              )}
              <label>
                Username
                <input
                  name="username"
                  autoComplete="username"
                  type="text"
                  required
                  placeholder={auth.setupRequired ? "Choose a username" : "Username or existing email"}
                />
              </label>
              <label>
                Password
                <div className="password-wrap">
                  <input
                    name="password"
                    type={show ? "text" : "password"}
                    autoComplete={
                      auth.setupRequired ? "new-password" : "current-password"
                    }
                    minLength={auth.setupRequired ? 12 : 1}
                    required
                    placeholder={
                      auth.setupRequired
                        ? "At least 12 characters"
                        : "Your password"
                    }
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={show ? "Hide password" : "Show password"}
                    onClick={() => setShow(!show)}
                  >
                    {show ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </label>
              {auth.setupRequired && (
                <label>
                  Server setup code
                  <input
                    name="setupToken"
                    type="password"
                    required
                    placeholder="Code shown when the server starts"
                  />
                  <small>
                    Find this one-time code in your server’s startup output.
                  </small>
                </label>
              )}
              {auth.setupRequired && <PlaybackDefaultsFields value={playbackDefaults} onChange={setPlaybackDefaults} disabled={busy} />}
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              <button className="button primary full" disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={19} /> : null}
                {auth.setupRequired ? "Create your account" : "Sign in"}
                <ArrowRight size={18} />
              </button>
            </form>
          )}
          {!approvalPending && (
            <button
              className="text-button qr-auth-mode"
              onClick={() => {
                setManual(!manual);
                setError("");
              }}
            >
              {manual ? <Smartphone size={18} /> : <Keyboard size={18} />}
              {manual
                ? "Sign in with your phone"
                : auth.setupRequired
                  ? "Create account on this device"
                  : "Use username and password"}
            </button>
          )}
          <div className="privacy-note">
            <LockKeyhole size={14} /> Your connected accounts stay private
          </div>
        </div>
      </main>
      <footer className="auth-footer">
        <span>Your libraries. Your screen.</span>
        <span>Independent · Self-hosted</span>
      </footer>
    </div>
  );
}

type QrChallenge = {
  id: string;
  code: string;
  verificationUrl: string;
  expiresAt: number;
};
let qrInitialization: Promise<QrChallenge> | null = null;
function initializeQr() {
  // A quick switch between QR and password views must not race binding cookies.
  if (qrInitialization) return qrInitialization;
  const promise = api<QrChallenge>("/auth/qr/init", {});
  qrInitialization = promise;
  const clear = () => {
    if (qrInitialization === promise) qrInitialization = null;
  };
  void promise.then(clear, clear);
  return promise;
}
function QrLogin({
  onAuth,
  setupRequired,
}: {
  onAuth: (auth: Auth) => void;
  setupRequired: boolean;
}) {
  const [challenge, setChallenge] = useState<QrChallenge | null>(null);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [generation, setGeneration] = useState(0);
  const refreshing = useRef(false);
  const pending = useRef<{
    generation: number;
    promise: Promise<QrChallenge>;
  } | null>(null);
  useEffect(() => {
    let dead = false;
    setChallenge(null);
    setError("");
    setExpired(false);
    // Reuse initialization across React's development effect replay.
    if (!pending.current || pending.current.generation !== generation)
      pending.current = {
        generation,
        promise: initializeQr(),
      };
    pending.current.promise
      .then((value) => {
        if (!dead) {
          setChallenge(value);
          refreshing.current = false;
        }
      })
      .catch((e) => {
        if (!dead) {
          setError(errorMessage(e));
          refreshing.current = false;
        }
      });
    return () => {
      dead = true;
    };
  }, [generation]);
  useEffect(() => {
    if (!challenge) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (dead || !challenge) return;
      if (Date.now() >= challenge.expiresAt) {
        setExpired(true);
        return;
      }
      try {
        const result = await api<{ status: string; auth?: Auth }>(
          "/auth/qr/poll",
          { id: challenge.id },
        );
        if (dead) return;
        if (result.status === "approved" && result.auth) {
          onAuth(result.auth);
          return;
        }
        timer = setTimeout(poll, 2500);
      } catch (e) {
        if (!dead) setError(errorMessage(e));
      }
    }
    timer = setTimeout(poll, 2500);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [challenge, onAuth]);
  return (
    <div className="qr-login">
      <h3>Sign in with your phone</h3>
      <p>
        {setupRequired
          ? "Create your owner account on your phone, then approve this screen."
          : "Scan with your phone’s camera. Sign in there, then approve this screen."}
      </p>
      {challenge && !expired && !error && (
        <>
          <QrCode
            value={challenge.verificationUrl}
            label="Scan to sign in to TesPlay on this screen"
          />
          <span className="form-help">Match this code on your phone</span>
          <div className="pair-code">{challenge.code}</div>
          <p className="form-help">
            Waiting for your approval · expires at{" "}
            {new Date(challenge.expiresAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
          <a
            className="text-button"
            href={challenge.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open phone sign-in link
          </a>
          {isLocalOnlyUrl(challenge.verificationUrl) && (
            <div className="qr-local-notice">
              This preview address is only available on this computer. Phone
              sign-in needs TesPlay’s reachable HTTPS address configured on the
              server.
            </div>
          )}
        </>
      )}
      {!challenge && !error && <LoaderCircle className="spin" size={28} />}
      {expired && (
        <p className="form-error" role="alert">
          This code expired. Get a new one to sign in.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {(error || expired) && (
        <button
          className="button ghost full"
          onClick={async () => {
            if (refreshing.current) return;
            refreshing.current = true;
            if (challenge)
              await api("/auth/qr/cancel", { id: challenge.id }).catch(
                () => {},
              );
            setGeneration((g) => g + 1);
          }}
        >
          <RefreshCw size={18} /> Get a new QR code
        </button>
      )}
    </div>
  );
}
