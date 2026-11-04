import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { Modal } from './components';

export default function PlaybackOptionField({ label, accessibleLabel, icon, choices, value, disabled, onChange }: {
  label: string;
  accessibleLabel: string;
  icon: ReactNode;
  choices: { id: string; label: string }[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = choices.find(choice => choice.id === value);
  function closeChooser() {
    setExpanded(false);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }
  return <>
    <label className="media-details-desktop-option">{label}
      <select aria-label={accessibleLabel} disabled={disabled} value={value} onChange={event => onChange(event.target.value)}>
        {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select>
    </label>
    <button ref={trigger} type="button" className="media-details-option-row" disabled={disabled} aria-haspopup="dialog"
      aria-label={`${accessibleLabel}: ${selected?.label || 'Source default'}. Change ${label.toLowerCase()}`}
      onClick={() => setExpanded(true)}>
      {icon}<span className="media-details-option-label">{label}</span>
      <strong>{selected?.label || 'Source default'}</strong><ChevronRight size={15} aria-hidden="true" />
    </button>
    {expanded && <Modal title={`Choose ${label.toLowerCase()}`} className="media-details-choice-modal" onClose={closeChooser}>
      <div className="media-details-choices" aria-label={accessibleLabel}>
        {choices.map(choice => <button type="button" key={choice.id} aria-pressed={choice.id === value}
          onClick={() => { onChange(choice.id); closeChooser(); }}>
          <span>{choice.label}</span>{choice.id === value && <Check size={19} aria-hidden="true" />}
        </button>)}
      </div>
    </Modal>}
  </>;
}
