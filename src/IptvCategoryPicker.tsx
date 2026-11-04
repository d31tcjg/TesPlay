import { useDeferredValue, useState } from 'react';
import { Film, Radio, Search, Tv } from 'lucide-react';

export type IptvCategory = { id: string; name: string; kind: string };
export type IptvSelection = string[] | null;
const kinds = [['live', 'Live TV', Radio], ['movie', 'Movies', Film], ['series', 'TV shows', Tv]] as const;

export default function IptvCategoryPicker({ categories, type, value, onChange, disabled = false }: {
  categories: IptvCategory[]; type: string; value: IptvSelection;
  onChange: (value:IptvSelection) => void; disabled?: boolean;
}) {
  const [kind, setKind] = useState('live'), [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim().toLowerCase());
  const selected = value ?? categories.map(c => c.id), selectedSet = new Set(selected);
  const visible = categories.filter(c => c.kind === kind && (!query || c.name.toLowerCase().includes(query)));
  function toggle(id:string) {
    onChange(selectedSet.has(id) ? selected.filter(value => value !== id) : [...selected, id]);
  }
  function selectVisible(enabled:boolean) {
    const ids = new Set(visible.map(c => c.id));
    onChange(enabled ? [...new Set([...selected, ...ids])] : selected.filter(id => !ids.has(id)));
  }
  return <div className="iptv-category-picker">
    <label className="iptv-all-toggle"><input type="checkbox" checked={value === null} disabled={disabled}
      onChange={e => onChange(e.target.checked ? null : categories.map(c => c.id))}/><span>Load all categories, including new ones</span></label>
    <div className="iptv-picker-tabs" role="group" aria-label="Content type">
      {kinds.filter(([id]) => type !== 'm3u' || id === 'live').map(([id, title, Icon]) => <button type="button" key={id}
        className={`button ghost ${kind === id ? 'selected' : ''}`} aria-pressed={kind === id} disabled={disabled}
        onClick={() => { setKind(id); setSearch(''); }}>
        <Icon size={17}/>{title}<small>{categories.filter(c => c.kind === id && selectedSet.has(c.id)).length}/{categories.filter(c => c.kind === id).length}</small>
      </button>)}
    </div>
    <div className="inline-search iptv-picker-search"><Search size={18}/><input type="search" value={search} disabled={disabled} aria-label="Search IPTV categories" placeholder="Search categories…" onChange={e => setSearch(e.target.value)}/></div>
    <div className="iptv-picker-tools"><span>{visible.length} categories</span><div>
      <button type="button" className="text-button" disabled={disabled || !visible.length} onClick={() => selectVisible(true)}>Select visible</button>
      <button type="button" className="text-button" disabled={disabled || !visible.length} onClick={() => selectVisible(false)}>Clear visible</button>
    </div></div>
    <div className="iptv-category-list">{visible.map(c => <label key={c.id} className={`iptv-category-option ${selectedSet.has(c.id) ? 'selected' : ''}`}>
      <input type="checkbox" checked={selectedSet.has(c.id)} disabled={disabled} onChange={() => toggle(c.id)}/><span>{c.name}</span>
    </label>)}{!visible.length && <p className="form-help">{query ? 'No categories match your search.' : 'This provider has no categories for this content type.'}</p>}</div>
    <p className="iptv-selection-status" role="status">{value === null ? 'All categories enabled' : `${selected.length} categories selected`}{value !== null && !selected.length && ' · No content will load'}</p>
  </div>;
}
