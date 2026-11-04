import { Modal } from './components';
import type { Connection } from './types';

export default function RemoveConnectionDialog({ deleting, busy, error, onClose, onConfirm }: {
  deleting: Connection;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Modal
      title={`Remove ${deleting.name}?`}
      onClose={onClose}
    >
      <p>
        This removes the saved connection and its credentials from TesPlay.
        Your provider’s library stays with the provider.
      </p>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button className="button ghost" onClick={onClose}>
          Keep connection
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={onConfirm}
        >
          Remove connection
        </button>
      </div>
    </Modal>
  );
}
