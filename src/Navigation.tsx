import { useEffect, useId, useRef, useState } from 'react';
import { Bookmark, Cable, ChevronLeft, Clapperboard, History, House, Layers, Search, Settings, Smartphone, Tv, UserRound, Youtube } from 'lucide-react';
import { Brand } from './components';
import { useGlassNavigation } from './navigation/glass-navigation';
import './navigation.css';

type NavigationView = 'home' | 'live' | 'movies' | 'series' | 'apps' | 'list' | 'history' | 'connections' | 'settings' | 'remote';
type Props = {
  view: string;
  phone: boolean;
  signedIn: boolean;
  searchOpen: boolean;
  profileOpen?: boolean;
  onNavigate: (view: NavigationView) => void;
  onSearch: () => void;
  onRemote: () => void;
  onProfile: () => void;
  onSignIn: () => void;
};

const destinations = [
  { view: 'home', label: 'Home', Icon: House },
  { view: 'live', label: 'Live TV', Icon: Tv },
  { view: 'movies', label: 'Movies', Icon: Clapperboard },
  { view: 'series', label: 'Series', Icon: Layers },
  { view: 'apps', label: 'YouTube', Icon: Youtube },
  { view: 'list', label: 'My List', Icon: Bookmark },
] as const;

export default function Navigation({ view, phone, signedIn, searchOpen, profileOpen = false, onNavigate, onSearch, onRemote, onProfile, onSignIn }: Props) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const actionsId = useId();
  const dock = useRef<HTMLElement>(null);
  const profile = useRef<HTMLElement>(null);
  const mainCurrent = destinations.some(destination => destination.view === view) ? view : '';
  const topCurrent = profileOpen ? 'profile' : searchOpen ? 'search' : ['history', 'connections', 'settings', 'remote'].includes(view) ? view : '';
  const pillCurrent = expanded ? topCurrent : topCurrent ? 'profile' : '';
  useGlassNavigation(dock, mainCurrent, false, true);
  useGlassNavigation(profile, pillCurrent, expanded);

  useEffect(() => { setExpanded(false); }, [view]);

  useEffect(() => {
    if (!expanded) return;
    // Wait until the newly visible, non-inert action row can receive focus.
    const focusFrame = requestAnimationFrame(() => actions.current?.querySelector<HTMLButtonElement>('button')?.focus());
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setExpanded(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [expanded]);

  function navigate(next: NavigationView) {
    setExpanded(false);
    onNavigate(next);
  }

  return <header ref={root} className="pill-navigation glass-navigation" data-phone={phone}>
    <button type="button" className="navigation-brand" aria-label="TesPlay home" onClick={() => navigate('home')}><Brand /></button>
    <nav ref={profile} className="navigation-profile-pill glass-bar" aria-label="Quick actions" data-expanded={expanded} data-glass-current={pillCurrent}>
      <div ref={actions} id={actionsId} className="navigation-actions" inert={!expanded} aria-hidden={!expanded}>
        <button type="button" className="navigation-icon" data-navigation-key="history" data-glass-active={pillCurrent === 'history'} aria-label="History" title="History" aria-current={view === 'history' ? 'page' : undefined} onClick={() => navigate('history')}><History aria-hidden="true" /></button>
        <button type="button" className="navigation-icon" data-navigation-key="search" data-glass-active={pillCurrent === 'search'} aria-label="Search library" title="Search" aria-expanded={searchOpen} onClick={() => { setExpanded(false); onSearch(); }}><Search aria-hidden="true" /></button>
        <button type="button" className="navigation-icon" data-navigation-key="connections" data-glass-active={pillCurrent === 'connections'} aria-label="Connections" title="Connections" aria-current={view === 'connections' ? 'page' : undefined} onClick={() => navigate('connections')}><Cable aria-hidden="true" /></button>
        {phone && <button type="button" className="navigation-icon" data-navigation-key="remote" data-glass-active={pillCurrent === 'remote'} aria-label="Open remote controls" title="Phone remote" onClick={() => { setExpanded(false); onRemote(); }}><Smartphone aria-hidden="true" /></button>}
        <button type="button" className="navigation-icon" data-navigation-key="settings" data-glass-active={pillCurrent === 'settings'} aria-label="Account settings" title="Settings" aria-current={view === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Settings aria-hidden="true" /></button>
      </div>
      <button type="button" ref={toggle} className="navigation-icon navigation-expand" aria-label={expanded ? 'Collapse quick actions' : 'Expand quick actions'} aria-expanded={expanded} aria-controls={actionsId} onClick={() => setExpanded(value => !value)}><span className="navigation-chevron"><ChevronLeft aria-hidden="true" /></span></button>
      <button type="button" className="navigation-icon navigation-user" data-navigation-key="profile" data-glass-active={pillCurrent === 'profile'} aria-haspopup="dialog" aria-expanded={profileOpen} aria-label={signedIn ? 'Profiles and account' : 'Sign in'} title={signedIn ? 'Profiles and account' : 'Sign in'} onClick={() => {
        setExpanded(false);
        if (signedIn) onProfile(); else onSignIn();
      }}><UserRound aria-hidden="true" /></button>
    </nav>
    <nav ref={dock} className="navigation-dock glass-bar glass-dock" aria-label="Main navigation" data-glass-current={mainCurrent}>
      {destinations.map(({ view: next, label, Icon }) => <button type="button" key={next} className="navigation-icon" data-navigation-key={next} data-glass-active={mainCurrent === next} aria-label={label} title={label} aria-current={view === next ? 'page' : undefined} onClick={() => navigate(next)}><Icon aria-hidden="true" /><span className="navigation-label" aria-hidden="true">{label}</span></button>)}
    </nav>
  </header>;
}
