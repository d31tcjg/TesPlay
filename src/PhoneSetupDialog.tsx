import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Modal } from './components';
import QrCode, { isLocalOnlyUrl } from './QrCode';

export default function PhoneSetupDialog({ phoneLink, onRefresh, onClose, onError }: {
  phoneLink: string;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => { void onRefresh().catch(() => {}); }, 4000);
    return () => window.clearInterval(timer);
  }, [onRefresh]);
  return (
    <Modal
      title="Set up on your phone"
      onClose={onClose}
    >
      <p>
        Scan to open your TesPlay connection settings. Sign in with the same
        account on your phone.
      </p>
      <QrCode
        value={phoneLink}
        label="Scan to manage your TesPlay connections on your phone"
      />
      <ol className="phone-setup-steps">
        <li>Sign in on your phone.</li>
        <li>Add or edit your provider connections and API keys.</li>
        <li>Return here — your saved connections refresh automatically.</li>
      </ol>
      {isLocalOnlyUrl(phoneLink) && (
        <div className="qr-local-notice">
          This computer-only preview cannot be reached from your phone.
          Configure the server with your reachable HTTPS address before
          using phone setup.
        </div>
      )}
      <p className="form-help">
        Google authorization must be started and completed on the same
        device. Open the connection settings on your phone first.
      </p>
      <a href={phoneLink} className="qr-link">
        {phoneLink}
      </a>
      <button
        className="button ghost full"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(phoneLink);
            setCopied(true);
          } catch {
            onError("Copy the link above to open it on your phone.");
          }
        }}
      >
        {copied ? <Check size={18} /> : <Copy size={18} />}
        {copied ? "Link copied" : "Copy setup link"}
      </button>
      <button
        className="button primary full phone-setup-done"
        onClick={() => {
          void onRefresh();
          onClose();
        }}
      >
        Done
      </button>
    </Modal>
  );
}
