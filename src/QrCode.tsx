import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import "./qr.css";

/** QR content is rendered on this device, never sent to a QR service. */
export default function QrCode({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(false);
    import("qrcode")
      .then(async (qr) => {
        if (cancelled || !canvas.current) return;
        await qr.toCanvas(canvas.current, value, {
          width: 248,
          margin: 4,
          errorCorrectionLevel: "M",
          color: { dark: "#101013", light: "#ffffff" },
        });
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);
  return (
    <div className="qr-art" role="img" aria-label={label}>
      <canvas
        ref={canvas}
        aria-hidden="true"
        style={{ visibility: ready ? "visible" : "hidden" }}
      />
      {!ready && (
        <span className="qr-placeholder">
          {error ? (
            "QR unavailable. Use the link below."
          ) : (
            <LoaderCircle className="spin" />
          )}
        </span>
      )}
    </div>
  );
}

export function isLocalOnlyUrl(value: string) {
  try {
    const host = new URL(value).hostname;
    return (
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]" ||
      host.startsWith("127.")
    );
  } catch {
    return true;
  }
}
