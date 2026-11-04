import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { api, errorMessage } from './api';
import { Busy, Modal } from './components';
import QrCode from './QrCode';
import type { Connection } from './types';
import './stremio.css';

type Addon = { key:string; name:string; description:string; enabled:boolean; showCatalogs:boolean; catalogCount:number; resources:string[]; configurable:boolean; custom:boolean };
type Settings = { connection:Pick<Connection,'id'|'type'|'name'>; linked:boolean; addons:Addon[] };
type Link = { id:string; url:string; code:string; expiresAt:string };

export default function StremioConnectionDialog({ connection, preview, onClose, onSignIn, onChanged }: {
  connection:Connection|null; preview:boolean; onClose:()=>void; onSignIn:()=>void; onChanged:()=>Promise<void>;
}) {
  const [activeId,setActiveId] = useState(connection?.id || '');
  const [settings,setSettings] = useState<Settings|null>(null);
  const [name,setName] = useState(connection?.name || 'Stremio');
  const [link,setLink] = useState<Link|null>(null);
  const linkRef = useRef<Link|null>(null);
  const [busy,setBusy] = useState(false), [loading,setLoading] = useState(Boolean(connection)), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [url,setUrl] = useState(''), [editKey,setEditKey] = useState('');
  const alive = useRef(true);
  useEffect(()=>{
    alive.current=true;
    return ()=>{alive.current=false; const pending=linkRef.current;if(pending)void api(`/stremio/link/${pending.id}`,{},'DELETE').catch(()=>{});};
  },[]);
  useEffect(()=>{
    if(!activeId || preview)return;
    const controller=new AbortController();setLoading(true);
    void api<Settings>(`/stremio/${activeId}/settings`,undefined,undefined,controller.signal)
      .then(value=>{if(!controller.signal.aborted){setSettings(value);setName(value.connection.name);}})
      .catch(reason=>{if(!controller.signal.aborted)setError(errorMessage(reason));})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[activeId,preview]);
  useEffect(()=>{
    if(!link)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try {
        const result=await api<{pending?:boolean;connection?:Connection}>('/stremio/link/check',{id:link.id},undefined,controller.signal);
        if(controller.signal.aborted)return;
        if(result.connection){
          const value = await api<Settings>(`/stremio/${result.connection.id}/settings`,undefined,undefined,controller.signal);
          if(controller.signal.aborted)return;
          linkRef.current=null;setLink(null);setActiveId(result.connection.id);setSettings(value);setNotice('Connected. Choose the addons you want to use below.');await onChanged();
        }
        else timer=setTimeout(()=>void poll(),3500);
      }catch(reason){if(!controller.signal.aborted){setError(errorMessage(reason));linkRef.current=null;setLink(null);}}
    };
    timer=setTimeout(()=>void poll(),1500);
    return()=>{controller.abort();clearTimeout(timer);};
  },[link,onChanged]);
  async function run(action:()=>Promise<void>){
    setBusy(true);setError('');setNotice('');
    try{await action();}catch(reason){if(alive.current)setError(errorMessage(reason));}finally{if(alive.current)setBusy(false);}
  }
  async function startLink(){
    await run(async()=>{
      const result=await api<Link>('/stremio/link',activeId?{connectionId:activeId}:{});
      if(!alive.current){void api(`/stremio/link/${result.id}`,{},'DELETE').catch(()=>{});return;}
      linkRef.current=result;setLink(result);
    });
  }
  async function updateAddon(addon:Addon,patch:Partial<Pick<Addon,'enabled'|'showCatalogs'>>){
    await run(async()=>{const value=await api<Settings>(`/stremio/${activeId}/addons/${addon.key}`,patch,'PATCH');if(alive.current)setSettings(value);await onChanged();});
  }
  async function saveUrl(){
    await run(async()=>{
      const value=editKey?await api<Settings>(`/stremio/${activeId}/addons/${editKey}`,{url},'PATCH'):
        await api<Settings>('/stremio/addon',{connectionId:activeId||undefined,url});
      if(alive.current){setSettings(value);setActiveId(value.connection.id);setUrl('');setEditKey('');setNotice('Addon saved. Your choices are used in TesPlay immediately.');}
      await onChanged();
    });
  }
  return <Modal title={activeId?'Your Stremio addons':'Connect Stremio'} onClose={onClose} className="stremio-dialog">
    {preview?<><p>Sign in to connect your Stremio account.</p><button className="button primary full" onClick={onSignIn}>Sign in to TesPlay</button></>:<>
      {!settings?.linked&&!link&&<div className="stremio-welcome"><span className="service-mark stremio">S</span><h3>Your Stremio, ready to watch</h3><p>Sign in on Stremio and we’ll bring your addons here. Choose what you want to see, then watch with TesPlayer.</p></div>}
      {link?<div className="stremio-link">
        <QrCode value={link.url} label="Scan to sign in with Stremio"/>
        <p>Scan with your phone, or continue on this device. Sign in on Stremio’s page; this window connects automatically.</p>
        <a className="button primary full" href={link.url} target="_blank" rel="noopener noreferrer">Continue on Stremio <ArrowUpRight size={17}/></a>
        <p className="form-help">If Stremio asks for a code: <strong>{link.code}</strong></p>
        <Busy label="Waiting for Stremio approval…"/>
        <button className="text-button" onClick={()=>{const pending=linkRef.current;linkRef.current=null;setLink(null);if(pending)void api(`/stremio/link/${pending.id}`,{},'DELETE').catch(()=>{});}}>Cancel sign-in</button>
      </div>:<button className={`button ${settings?.linked?'ghost':'primary'} full`} disabled={busy} onClick={()=>void startLink()}>{settings?.linked?'Reconnect Stremio account':'Sign in with Stremio'} <ArrowUpRight size={17}/></button>}
      {loading&&<Busy label="Loading your addons…"/>}
      {error&&<p className="form-error" role="alert">{error}</p>}
      {notice&&<p className="notice" role="status">{notice}</p>}
      {settings&&<>
        <div className="stremio-addon-heading"><div><h3>Use in TesPlay</h3><p className="form-help">These choices only change TesPlay. Your Stremio setup stays yours.</p></div>
          {settings.linked&&<button className="button ghost small" disabled={busy} onClick={()=>void run(async()=>{const value=await api<Settings>(`/stremio/${activeId}/sync`,{});if(alive.current)setSettings(value);await onChanged();})}><RefreshCw size={16}/>Import changes</button>}
        </div>
        <div className="stremio-addons">{settings.addons.map(addon=><article className={`stremio-addon ${addon.enabled?'enabled':''}`} key={addon.key}>
          <label className="stremio-addon-toggle"><input type="checkbox" checked={addon.enabled} disabled={busy} onChange={event=>void updateAddon(addon,{enabled:event.target.checked})}/><span><strong>{addon.name}</strong><small>{addon.resources.includes('stream')?'Provides playback sources':addon.resources.includes('meta')?'Provides title details':'Catalog addon'}{addon.catalogCount?` · ${addon.catalogCount} catalogs`:''}</small></span></label>
          {addon.catalogCount>0&&<label className="stremio-catalog-toggle"><input type="checkbox" checked={addon.showCatalogs} disabled={busy||!addon.enabled} onChange={event=>void updateAddon(addon,{showCatalogs:event.target.checked})}/>Show catalogs in Home and Library</label>}
          <div className="stremio-addon-actions">
            <button className="text-button" disabled={busy} aria-label={`Edit link for ${addon.name}`} onClick={()=>{setEditKey(addon.key);setUrl('');}}><Pencil size={14}/>Edit link</button>
            {addon.configurable&&<a className="text-button" href={`/api/stremio/${activeId}/addons/${addon.key}/configure`} target="_blank" rel="noopener noreferrer">Configure <ArrowUpRight size={14}/></a>}
            <button className="text-button danger" disabled={busy} aria-label={`Remove ${addon.name} from TesPlay`} onClick={()=>void run(async()=>{const value=await api<Settings>(`/stremio/${activeId}/addons/${addon.key}`,{},'DELETE');if(alive.current)setSettings(value);await onChanged();})}><Trash2 size={14}/>Remove</button>
          </div>
        </article>)}</div>
        {!settings.addons.length&&<p>No addons selected yet. Import from Stremio or add a link below.</p>}
        {settings.linked&&<a className="text-button" href="https://web.stremio.com/#/addons" target="_blank" rel="noopener noreferrer">Manage addons in Stremio <ArrowUpRight size={15}/></a>}
        {!settings.addons.some(addon=>addon.enabled&&addon.resources.includes('stream'))&&<p className="form-help">To watch, enable a stream addon that provides direct video links. Catalogs such as Cinemeta provide title details, not video.</p>}
      </>}
      <details className="stremio-add-link" open={editKey?true:undefined}>
        <summary>{editKey?`Edit ${settings?.addons.find(addon=>addon.key===editKey)?.name || 'addon'} link`:'Add a configured addon link'}</summary>
        <p className="form-help">Copy the install link from the addon’s configuration page and paste it here. It already includes the settings you chose, including any service credentials. HTTPS and stremio:// links are supported.</p>
        <form onSubmit={event=>{event.preventDefault();void saveUrl();}}><label>Configured addon link<input type="password" value={url} onChange={event=>setUrl(event.target.value)} autoComplete="off" spellCheck={false} placeholder="stremio://…/manifest.json" maxLength={8000} required/></label><div className="stremio-form-actions"><button className="button ghost" disabled={busy||!url.trim()} type="submit">{editKey?'Save addon link':'Add addon'}</button>{editKey&&<button type="button" className="text-button" onClick={()=>{setEditKey('');setUrl('');}}>Cancel edit</button>}</div></form>
      </details>
      {activeId&&<form className="stremio-name" onSubmit={event=>{event.preventDefault();void run(async()=>{await api(`/connections/${activeId}`,{name},'PUT');await onChanged();setNotice('Connection name saved.');});}}><label>Connection name<input value={name} onChange={event=>setName(event.target.value)} required maxLength={80}/></label><button className="button ghost small" type="submit" disabled={busy}>Save name</button></form>}
      <button className="button primary full" onClick={onClose}>{activeId?<><Check size={17}/>Done</>:'Close'}</button>
    </>}
  </Modal>;
}
