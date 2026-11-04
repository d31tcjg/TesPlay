import { useEffect, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { api, errorMessage } from './api';
import { Busy, Modal } from './components';
import IptvCategoryPicker from './IptvCategoryPicker';
import type { IptvCategory, IptvSelection } from './IptvCategoryPicker';
import { invalidateHomePreview } from './home-library';
import type { Connection } from './types';

export default function IptvCategoryDialog({ connection, onClose, onSaved }: {
  connection: Connection; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [categories, setCategories] = useState<IptvCategory[]>([]), [selection, setSelection] = useState<IptvSelection>([]);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [ready, setReady] = useState(false);
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setReady(false); setError('');
    api<{ categories:IptvCategory[]; loadedCategories:IptvSelection }>(
      `/connections/${connection.id}/categories${refresh ? '?refresh=1' : ''}`, undefined, undefined, controller.signal,
    ).then(r => {
      if (controller.signal.aborted) return;
      setReady(true); setCategories(r.categories); setSelection(r.loadedCategories);
    }).catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [connection.id, refresh]);
  async function save() {
    setSaving(true); setError('');
    try {
      await api(`/connections/${connection.id}`, { config: { loadedCategories: selection } }, 'PUT');
      invalidateHomePreview(connection.id); await onSaved(); onClose();
    } catch (e) { setError(errorMessage(e)); }
    finally { setSaving(false); }
  }
  return <Modal title="Choose IPTV categories" onClose={() => { if (!saving) onClose(); }} className="iptv-category-dialog">
    <p className="form-help">{connection.name} · Only selected categories will appear in your IPTV library.</p>
    {connection.type === 'm3u' && <p className="form-help">Your playlist is downloaded as one file; only selected groups appear in your library.</p>}
    {error && <div className="form-error" role="alert">{error}</div>}
    {loading ? <Busy label="Loading category names…"/> : ready ? <>
      <IptvCategoryPicker categories={categories} type={connection.type} value={selection} onChange={setSelection} disabled={saving}/>
      <div className="iptv-picker-footer"><button type="button" className="button primary" disabled={saving} onClick={save}><Check size={17}/>{saving ? 'Saving…' : 'Save categories'}</button></div>
    </> : null}
    <button type="button" className="text-button iptv-picker-retry" disabled={loading || saving} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14}/>Reload category names</button>
  </Modal>;
}
