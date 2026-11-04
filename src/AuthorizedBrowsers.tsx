import {useCallback,useEffect,useState} from 'react';
import {Monitor,Smartphone,Globe,RefreshCw} from 'lucide-react';
import {api,errorMessage} from './api';
import {Busy,Modal} from './components';
import './authorized-browsers.css';
type BrowserAuthorization={id:string;name:string;role:'screen'|'remote'|'browser';current:boolean;scope:'full'|'remote';lastSeen:string|null;authorizedAt:string|null;screen:string|null};
function lastSeen(value:string|null) {
  if(!value)return 'Not recorded';
  const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(value))/60000));
  if(minutes<1)return 'Just now';
  if(minutes<60)return `${minutes} minute${minutes===1?'':'s'} ago`;
  if(minutes<1440){const hours=Math.floor(minutes/60);return `${hours} hour${hours===1?'':'s'} ago`;}
  return new Date(value).toLocaleDateString();
}
export default function AuthorizedBrowsers({onRemovedCurrent,onCount}:{onRemovedCurrent:()=>Promise<void>;onCount?:(count:number)=>void}) {
  const [browsers,setBrowsers]=useState<BrowserAuthorization[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [selected,setSelected]=useState<BrowserAuthorization|null>(null),[removing,setRemoving]=useState(false);
  const load=useCallback(async(signal?:AbortSignal)=>{
    setLoading(true);
    try{const result=await api<{browsers:BrowserAuthorization[]}>('/browsers',undefined,undefined,signal);if(!signal?.aborted){setBrowsers(result.browsers);onCount?.(result.browsers.length);setError('');}}
    catch(e){if(!signal?.aborted)setError(errorMessage(e));}
    finally{if(!signal?.aborted)setLoading(false);}
  },[onCount]);
  useEffect(()=>{const controller=new AbortController();void load(controller.signal);return()=>controller.abort();},[load]);
  return <article className="authorized-browsers settings-card">
    <div className="authorized-heading"><div><h2>Authorized browsers</h2><p>See which browsers can access your account or control a screen. Remove a browser to end its authorization.</p></div><button className="icon-button" aria-label="Refresh authorized browsers" disabled={loading} onClick={()=>void load()}><RefreshCw size={19}/></button></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {loading&&!browsers.length?<Busy label="Loading authorized browsers…"/>:<div className="authorized-table-scroll"><table className="authorized-table"><thead><tr><th scope="col">Browser / device</th><th scope="col">Role</th><th scope="col">Last seen</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{browsers.map(browser=>{
      const Icon=browser.role==='screen'?Monitor:browser.role==='remote'?Smartphone:Globe;
      return <tr key={browser.id}><td><div className="authorized-name"><Icon size={19}/><strong>{browser.name}</strong></div>{browser.current&&<span className="authorized-current">This browser</span>}{browser.screen&&<small>Controls {browser.screen}</small>}{browser.scope==='remote'&&<small>Remote access only</small>}</td><td>{browser.role==='screen'?'Screen':browser.role==='remote'?'Remote':'Browser'}</td><td><time dateTime={browser.lastSeen||undefined} title={browser.lastSeen?new Date(browser.lastSeen).toLocaleString():undefined}>{lastSeen(browser.lastSeen)}</time></td><td><button className="button ghost small" aria-label={`Remove ${browser.name}${browser.current?' (this browser)':''}`} onClick={()=>setSelected(browser)}>Remove</button></td></tr>;
    })}</tbody></table></div>}
    <p className="form-help">Removing the browser you’re using will sign you out here. Removing a screen also ends the remote authorizations created by its QR codes.</p>
    {selected&&<Modal title="Remove browser authorization?" onClose={()=>{if(!removing)setSelected(null);}}><p>{selected.current?'You will be signed out of this browser.':`${selected.name} will lose its authorization.`}{selected.role==='screen'?' Its QR-authorized remotes will also be disconnected.':''}</p><div className="form-actions"><button className="button danger" disabled={removing} onClick={async()=>{
      setRemoving(true);setError('');
      try{await api(`/browsers/${encodeURIComponent(selected.id)}`,{},'DELETE');const current=selected.current;setSelected(null);if(current)await onRemovedCurrent();else await load();}
      catch(e){setError(errorMessage(e));}finally{setRemoving(false);}
    }}>{removing?'Removing…':selected.current?'Remove & sign out':'Remove browser'}</button><button className="button ghost" disabled={removing} onClick={()=>setSelected(null)}>Cancel</button></div></Modal>}
  </article>;
}
