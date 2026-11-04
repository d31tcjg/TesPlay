import type { PlayerPreferences } from './types';
import { normalizeLanguage, playbackLanguages, playbackQualities } from './player-preferences';
import './playback-default-fields.css';

export default function PlaybackDefaultsFields({ value, onChange, disabled = false }: { value: PlayerPreferences; onChange: (value: PlayerPreferences) => void; disabled?: boolean }) {
  const audio = normalizeLanguage(value.audioLanguage);
  const subtitles = value.subtitlesEnabled ? normalizeLanguage(value.subtitleLanguage) || 'auto' : 'off';
  return <fieldset className="playback-default-fields" disabled={disabled}>
    <legend>Playback defaults</legend>
    <p>You can change these later in Settings.</p>
    <label>Audio language<select aria-label="Default audio language" value={audio} onChange={event => onChange({ ...value, audioLanguage: event.target.value || null })}>
      <option value="">Automatic</option>{playbackLanguages.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
    </select></label>
    <label>Subtitles<select aria-label="Default subtitles" value={subtitles} onChange={event => onChange({ ...value, subtitlesEnabled: event.target.value !== 'off', subtitleLanguage: ['off', 'auto'].includes(event.target.value) ? null : event.target.value })}>
      <option value="off">Off</option><option value="auto">Automatic</option>{playbackLanguages.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
    </select></label>
    <label>Quality<select aria-label="Default playback quality" value={value.qualityId} onChange={event => onChange({ ...value, qualityId: event.target.value as PlayerPreferences['qualityId'] })}>
      {playbackQualities.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
    </select></label>
  </fieldset>;
}
