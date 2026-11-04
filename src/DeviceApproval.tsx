import { useEffect, useState } from "react";
import { Check, LoaderCircle, Monitor, ShieldCheck } from "lucide-react";
import { api, errorMessage } from "./api";
import { Brand } from "./components";
import type { Auth } from "./types";
import "./qr.css";

export default function DeviceApproval({
  id,
  token,
  onDone,
  onRemoteConnected,
}: {
  id: string;
  token: string;
  onDone: () => void;
  onRemoteConnected?: (auth: Auth) => void;
}) {
  const [details, setDetails] = useState<{
    code: string;
    expiresAt: number;
    remoteScreen?: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let dead = false;
    setDetails(null);
    setError("");
    if (!id || !token) {
      setError(
        "This sign-in link is incomplete. Scan a fresh QR code on your screen.",
      );
      return;
    }
    api<{ code: string; expiresAt: number; remoteScreen?: boolean }>("/auth/qr/details", { id, token })
      .then((value) => {
        if (!dead) setDetails(value);
      })
      .catch((e) => {
        if (!dead) setError(errorMessage(e));
      });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      dead = true;
      window.clearInterval(timer);
    };
  }, [id, token]);
  useEffect(() => {
    if (!approved || !details?.remoteScreen || !onRemoteConnected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 120_000;
    const poll = async () => {
      try {
        const auth = await api<Auth>("/auth/status", undefined, undefined, controller.signal);
        if (controller.signal.aborted) return;
        if (auth.deviceMode === "remote" && auth.remoteRoomId) {
          onRemoteConnected(auth);
          return;
        }
        if (Date.now() >= deadline) {
          setError("The screen has not connected yet. Scan a fresh QR code on that screen.");
          return;
        }
        timer = setTimeout(poll, 1500);
      } catch (reason) {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [approved, details?.remoteScreen, onRemoteConnected]);
  const expired = details && now >= details.expiresAt;
  return (
    <div className="device-approval-page">
      <Brand />
      <main className="auth-card device-approval-card">
        {approved ? (
          <>
            <Check size={40} className="approval-icon" />
            <h1>{details?.remoteScreen ? "Connecting your remote…" : "Sign-in approved."}</h1>
            <p>
              {details?.remoteScreen ? "Your screen will sign in, then your phone remote opens automatically." : "Your screen will sign in automatically. You can return to it or manage your TesPlay settings here."}
            </p>
            {details?.remoteScreen && !error && <LoaderCircle className="spin" />}
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="button primary full" onClick={onDone}>
              {details?.remoteScreen ? "Return to TesPlay" : "Continue on this device"}
            </button>
          </>
        ) : (
          <>
            <Monitor size={38} className="approval-icon" />
            <h1>{details?.remoteScreen ? "Connect your rear screen" : "Sign in your screen"}</h1>
            <p>
              Approve only if you just scanned the QR code on a screen you
              trust. Check that its code matches.
            </p>
            {details && (
              <div
                className="pair-code"
                aria-label={`Confirmation code ${details.code}`}
              >
                {details.code}
              </div>
            )}
            {!details && !error && <LoaderCircle className="spin" />}
            {expired && (
              <div className="form-error" role="alert">
                This code expired. Create a new QR code on your screen and scan
                it again.
              </div>
            )}
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <button
              className="button primary full"
              disabled={busy || !details || !!expired}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api("/auth/qr/approve", { id, token });
                  setApproved(true);
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? (
                <LoaderCircle size={19} className="spin" />
              ) : (
                <ShieldCheck size={19} />
              )}{" "}
              {details?.remoteScreen ? "Approve and open remote" : "Approve sign-in"}
            </button>
            <button className="button ghost full" onClick={onDone}>
              Cancel
            </button>
          </>
        )}
      </main>
    </div>
  );
}
