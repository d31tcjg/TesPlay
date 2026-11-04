import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {ArrowRight,Cable,Check,Clock,LogOut,Play,Settings,ShieldCheck,Users} from 'lucide-react';
import {api,errorMessage} from './api';
import {Busy,ConnectorLogo} from './components';
import Connections from './Connections';
import AuthorizedBrowsers from './AuthorizedBrowsers';
import type {Auth,Connection,Preferences,PlayerPreferences} from './types';
import {defaultPlayerPreferences,normalizeLanguage,playbackLanguages,playbackQualities} from './player-preferences';
import './settings-dashboard.css';
const Accounts=lazy(()=>import('./Accounts'));
type Section='account'|'connections'|'browsers'|'profiles'|'playback'|'content'|'accounts';
const sections: {id:Section;label:string;description:string}[]=[
  {id:'account',label:'Account',description:'Your account details and screen shortcuts.'},
  {id:'playback',label:'Playback',description:'Choose your autoplay, language, subtitle and quality preferences.'},
  {id:'content',label:'Content',description:'Choose which videos appear across TesPlay.'},
  {id:'browsers',label:'Browsers',description:'Review which browsers can access your account or control a screen.'},
  {id:'connections',label:'Connections',description:'Manage your connected services and libraries.'},
  {id:'profiles',label:'Profiles',description:'Switch profiles or manage your personal spaces.'},
  {id:'accounts',label:'Household accounts',description:'Manage accounts and shared library access.'},
];
function sectionFromUrl(owner:boolean):Section {
  const requested=new URLSearchParams(location.search).get('section');
  return sections.find(item=>item.id===requested&&(item.id!=='accounts'||owner))?.id||'account';
}
export default function SettingsDashboard({auth,connections,preferences,preferencesBusy,preferencesReady,profileBusy,onAutoplay,onHideYouTubeShorts,onReloadPreferences,onRemovedCurrent,onReloadConnections,onBrowse,onManageProfiles,onSwitchProfile,onRemote,onPairPhone,onHistory,onSignOut,onToast,initialConnection,onInitialUsed,phone,onFullscreen}: {
  auth:Auth;connections:Connection[];preferences:Preferences;preferencesBusy:boolean;preferencesReady:boolean;profileBusy:boolean;
  onHideYouTubeShorts:(value:boolean)=>Promise<void>;onReloadPreferences:()=>Promise<void>;
  onAutoplay:(value:boolean)=>Promise<void>;onRemovedCurrent:()=>Promise<void>;onReloadConnections:()=>Promise<void>;onBrowse:(connection:Connection)=>void;
  onManageProfiles:()=>void;onSwitchProfile:(id:string)=>Promise<void>;onRemote:()=>void;onPairPhone:()=>void;onHistory:()=>void;onSignOut:()=>Promise<void>;onToast:(value:string)=>void;
  initialConnection?:string;onInitialUsed:()=>void;phone:boolean;onFullscreen:()=>void;
}) {
  const owner=auth.user?.role==='owner';
  const [section,setSection]=useState<Section>(()=>sectionFromUrl(owner));
  const [subtitle,setSubtitle]=useState<PlayerPreferences>(defaultPlayerPreferences),[subtitleBusy,setSubtitleBusy]=useState(true),[subtitleReady,setSubtitleReady]=useState(false),[subtitleError,setSubtitleError]=useState('');
  const [subtitleIdentity,setSubtitleIdentity]=useState('');
  const identity=`${auth.user?.id}:${auth.activeProfileId}`;
  const currentIdentity=useRef(identity);currentIdentity.current=identity;
  useEffect(()=>{
    function restoreSection(){
      if(new URLSearchParams(location.search).get('view')!=='settings')return;
      const next=sectionFromUrl(owner);
      setSection(next);
      const url=new URL(location.href);
      if(url.searchParams.get('section')!==next){
        url.searchParams.set('section',next);
        history.replaceState(history.state,'',url.pathname+url.search+url.hash);
      }
    }
    restoreSection();
    window.addEventListener('popstate',restoreSection);
    return()=>window.removeEventListener('popstate',restoreSection);
  },[owner]);
  function selectSection(next:Section){
    if(next===section)return;
    const url=new URL(location.href);
    url.searchParams.set('view','settings');
    url.searchParams.set('section',next);
    history.pushState(history.state,'',url.pathname+url.search+url.hash);
    setSection(next);
  }
  useEffect(()=>{
    if(section!=='playback')return;
    const controller=new AbortController();setSubtitleBusy(true);setSubtitleReady(false);setSubtitleError('');
    void api<PlayerPreferences>('/player/preferences',undefined,undefined,controller.signal).then(value=>{if(!controller.signal.aborted){setSubtitle(value);setSubtitleIdentity(identity);setSubtitleReady(true);}}).catch(e=>{if(!controller.signal.aborted)setSubtitleError(errorMessage(e));}).finally(()=>{if(!controller.signal.aborted)setSubtitleBusy(false);});
    return()=>controller.abort();
  },[identity,section]);
  async function savePlaybackDefaults(value:PlayerPreferences){
    setSubtitleBusy(true);setSubtitleError('');
    try{const saved=await api<PlayerPreferences>('/player/preferences',value,'PATCH');if(currentIdentity.current===identity)setSubtitle(saved);}
    catch(e){if(currentIdentity.current===identity)setSubtitleError(errorMessage(e));}finally{if(currentIdentity.current===identity)setSubtitleBusy(false);}
  }
  if(!auth.user)return null;
  const user=auth.user,canManage=user.canManageConnections??owner;
  const currentSection=sections.find(item=>item.id===section)!;
  const profile=auth.profiles.find(p=>p.id===auth.activeProfileId);
  const readySubtitle=subtitleReady&&subtitleIdentity===identity;
  const languageValue=normalizeLanguage(subtitle.subtitleLanguage);
  const audioValue=normalizeLanguage(subtitle.audioLanguage);
  const playbackPanel=<article className="settings-card dashboard-panel"><div className="dashboard-panel-heading"><Play size={21}/><div><h2>Playback preferences</h2><p>Make playback feel right for {profile?.name||'your profile'}.</p></div></div>
    <div className="dashboard-setting"><span><strong>Play the next episode</strong><small>Continue automatically when an episode ends.</small></span><button type="button" className="dashboard-switch" role="switch" aria-label="Play next episode automatically" aria-checked={preferences.autoPlayNext} disabled={preferencesBusy||!preferencesReady} onClick={()=>void onAutoplay(!preferences.autoPlayNext)}><span className="dashboard-switch-track" aria-hidden="true"><span/></span></button></div>
    <label className="dashboard-setting"><span><strong>Audio language</strong><small>Used when the title offers this language.</small></span><select aria-label="Preferred audio language" disabled={subtitleBusy||!readySubtitle} value={readySubtitle?audioValue:''} onChange={e=>void savePlaybackDefaults({...subtitle,audioLanguage:e.target.value||null})}><option value="">Automatic</option>{playbackLanguages.map(([code,label])=><option key={code} value={code}>{label}</option>)}{audioValue&&!playbackLanguages.some(([code])=>code===audioValue)&&<option value={audioValue}>{subtitle.audioLanguage}</option>}</select></label>
    <div className="dashboard-setting"><span><strong>Subtitles by default</strong><small>Saved to your selected profile.</small></span><button type="button" className="dashboard-switch" role="switch" aria-label="Subtitles by default" aria-checked={readySubtitle&&subtitle.subtitlesEnabled} disabled={subtitleBusy||!readySubtitle} onClick={()=>void savePlaybackDefaults({...subtitle,subtitlesEnabled:!subtitle.subtitlesEnabled})}><span className="dashboard-switch-track" aria-hidden="true"><span/></span></button></div>
    <label className="dashboard-setting"><span><strong>Subtitle language</strong><small>Used when the title offers this language.</small></span><select aria-label="Preferred subtitle language" disabled={subtitleBusy||!readySubtitle} value={readySubtitle?languageValue:''} onChange={e=>void savePlaybackDefaults({...subtitle,subtitleLanguage:e.target.value||null})}><option value="">Automatic</option>{playbackLanguages.map(([code,label])=><option key={code} value={code}>{label}</option>)}{languageValue&&!playbackLanguages.some(([code])=>code===languageValue)&&<option value={languageValue}>{subtitle.subtitleLanguage}</option>}</select></label>
    <label className="dashboard-setting"><span><strong>Playback quality</strong><small>Uses the nearest available quality.</small></span><select aria-label="Preferred playback quality" disabled={subtitleBusy||!readySubtitle} value={subtitle.qualityId} onChange={e=>void savePlaybackDefaults({...subtitle,qualityId:e.target.value as PlayerPreferences['qualityId']})}>{playbackQualities.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
    {subtitleError&&<p className="form-error" role="alert">{subtitleError}</p>}
    <button className="text-button dashboard-history" onClick={onHistory}><Clock size={16}/>View watch history<ArrowRight size={16}/></button>
  </article>;
  const contentPanel=<article className="settings-card dashboard-panel"><div className="dashboard-panel-heading"><Settings size={21}/><div><h2>Content preferences</h2><p>Saved to your account and applied across TesPlay.</p></div></div>
    <div className="dashboard-setting"><span><strong>Hide YouTube Reels / Shorts</strong><small>Hide short YouTube videos everywhere, including Home, Highlights, search and your saved lists.</small></span><button type="button" className="dashboard-switch" role="switch" aria-label="Hide YouTube Reels / Shorts" aria-describedby="youtube-shorts-help" aria-checked={!!preferences.hideYouTubeShorts} disabled={preferencesBusy||!preferencesReady} onClick={()=>void onHideYouTubeShorts(!preferences.hideYouTubeShorts)}><span className="dashboard-switch-track" aria-hidden="true"><span/></span></button></div>
    <p id="youtube-shorts-help" className="form-help">Videos up to three minutes long are hidden, including ordinary short uploads. Videos with unknown duration may still appear. Your saved items return when you turn this off.</p>
    {!preferencesReady&&!preferencesBusy&&<button className="button ghost small" onClick={()=>void onReloadPreferences()}>Retry account preferences</button>}
  </article>;
  const connectionsPanel=<article className="settings-card dashboard-panel"><div className="dashboard-panel-heading"><Cable size={21}/><div><h2>Your connections</h2><p>{canManage?'Your personal connections and libraries shared with you.':'Libraries shared with your account.'}</p></div></div>
    {connections.map(c=><div className="dashboard-connection" key={c.id}><ConnectorLogo type={c.type}/><div><strong>{c.name}</strong><small>{c.configured?'Connected':'Setup needed'}</small></div><button className="button ghost small" onClick={()=>onBrowse(c)}>Browse</button></div>)}
    {!connections.length&&<p className="form-help">{canManage?'Connect a library to make this space yours.':'Your server owner can share libraries with you.'}</p>}
  </article>;
  return <section className="page-section settings-dashboard"><div className="page-heading"><div><span className="eyebrow">Settings</span><h1>{currentSection.label}</h1><p>{currentSection.description}</p></div>{section==='account'&&<button className="button ghost small" onClick={()=>void onSignOut().catch(e=>onToast(errorMessage(e)))}><LogOut size={16}/>Sign out</button>}{section==='connections'&&canManage&&<span className="count-pill"><Cable size={16}/>{connections.length} connected</span>}</div>
    <nav className="dashboard-section-nav" aria-label="Settings sections">{sections.filter(item=>item.id!=='accounts'||owner).map(({id,label})=><button type="button" key={id} aria-current={section===id?'page':undefined} onClick={()=>selectSection(id)}>{label}</button>)}</nav>
    {section==='account'&&<article className="settings-card dashboard-panel"><div className="dashboard-panel-heading"><ShieldCheck size={21}/><div><h2>Your account</h2><p>Your sign-in and screen controls.</p></div></div><div className="dashboard-account"><span className="avatar">{user.name.slice(0,1).toUpperCase()}</span><div><strong>{user.name}</strong><small>{user.username}{user.email?` · ${user.email}`:''}</small><span className="dashboard-account-role">{owner?'Server owner':canManage?'Personal account':'Household member'}</span></div></div>{phone&&<div className="dashboard-setting"><span><strong>Phone remote</strong><small>Open the controls on your phone and reconnect to an authorized screen.</small></span><button className="button ghost small" onClick={onRemote}>Open remote</button></div>}<div className="dashboard-setting"><span><strong>Pair a phone with this screen</strong><small>Show a QR code on the device that will play your videos.</small></span><button className="button ghost small" onClick={onPairPhone}>Show pairing QR</button></div><div className="dashboard-setting"><span><strong>Fullscreen browser</strong><small>Open TesPlay through Theater on your Tesla screen.</small></span><button className="button ghost small" onClick={onFullscreen}>Open in fullscreen</button></div></article>}
    {section==='playback'&&playbackPanel}
    {section==='content'&&contentPanel}
    {section==='profiles'&&<article className="settings-card dashboard-panel"><div className="dashboard-panel-heading"><Users size={21}/><div><h2>Your profiles</h2><p>Separate watchlists, history and playback preferences.</p></div></div>{auth.profiles.map(p=><div className="dashboard-profile" key={p.id}><span className="avatar" style={{background:p.color}}>{p.name.slice(0,1).toUpperCase()}</span><div><strong>{p.name}</strong><small>{p.id===auth.activeProfileId?'Selected profile':'Personal list and history'}</small></div>{p.id===auth.activeProfileId?<Check size={19}/>:<button className="button ghost small" disabled={profileBusy} onClick={()=>void onSwitchProfile(p.id)}>Switch</button>}</div>)}<button className="text-button dashboard-history" onClick={onManageProfiles}>Add or remove profiles<ArrowRight size={16}/></button></article>}
    {section==='accounts'&&owner&&<Suspense fallback={<Busy label="Loading household accounts…"/>}><Accounts connections={connections} onToast={onToast}/></Suspense>}
    {section==='connections'&&(canManage?<div className="dashboard-full-connections"><Connections embedded connections={connections} onRefresh={onReloadConnections} onBrowse={onBrowse} initialType={initialConnection} onInitialUsed={onInitialUsed} preview={false} onSignIn={()=>{}}/></div>:connectionsPanel)}
    {section==='browsers'&&<AuthorizedBrowsers onRemovedCurrent={onRemovedCurrent}/>}
    <div className="settings-foot"><span>TesPlay · Your screen. Your stories.</span></div>
  </section>;
}
