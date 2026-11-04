import { useEffect, useState } from 'react';
import { Plus, Save, ShieldCheck, Users, ChevronDown, Trash2 } from 'lucide-react';
import { api, errorMessage } from './api';
import { Busy, Empty, Modal, ConnectorLogo } from './components';
import type { Connection, Grant } from './types';
import PlaybackDefaultsFields from './PlaybackDefaultsFields';
import { defaultPlayerPreferences } from './player-preferences';
type Account={id:string;name:string;email:string|null;username:string;role:'owner'|'member';disabled:boolean;grants:Grant[]};
const kinds:Record<string,string[]>={stremio:['movie','series'],plex:['movie','series','audio'],xtream:['movie','series','live'],m3u:['live'],youtube:['video'],drive:['video','audio'],local:['video','audio']};
const labels:Record<string,string>={movie:'Movies',series:'TV shows',live:'Live TV',video:'Videos',audio:'Music & audio'};
export default function Accounts({connections,onToast}:{connections:Connection[];onToast:(s:string)=>void}) {
  const [accounts,setAccounts]=useState<Account[]>([]),[busy,setBusy]=useState(true),[error,setError]=useState('');
  const [playbackDefaults,setPlaybackDefaults]=useState(defaultPlayerPreferences);
  const [editing,setEditing]=useState<Account|'new'|null>(null),[name,setName]=useState(''),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[grants,setGrants]=useState<Grant[]>([]),[saving,setSaving]=useState(false);
  const [expanded,setExpanded]=useState<string|null>(null),[confirmation,setConfirmation]=useState<{account:Account;action:'toggle'|'delete'}|null>(null);
  const [options,setOptions]=useState<Record<string,{id:string;name:string}[]>>({});
  const reload=async()=>{const r=await api<{accounts:Account[]}>('/accounts');setAccounts(r.accounts);};
  useEffect(()=>{void reload().catch(e=>setError(errorMessage(e))).finally(()=>setBusy(false));},[]);
  useEffect(()=>{
    if(!editing)return;
    const controller=new AbortController();
    for(const c of connections.filter(c=>['plex','xtream','m3u'].includes(c.type))) {
      const path=c.type==='plex'?`/plex/${c.id}/sections`:`/catalog?connectionId=${c.id}&kind=all&limit=1`;
      void api<{sections?:{id:string;title:string}[];categories?:{id:string;name:string}[]}>(path,undefined,undefined,controller.signal).then(r=>{if(!controller.signal.aborted)setOptions(o=>({...o,[c.id]:r.sections?.map(s=>({id:s.id,name:s.title}))||r.categories||[]}));}).catch(()=>{});
    }
    return()=>controller.abort();
  },[editing,connections]);
  const edit=(value:Account|'new')=>{setEditing(value);setName(value==='new'?'':value.name);setUsername(value==='new'?'':value.username);setPassword('');setExpanded(null);setGrants(value==='new'?[]:value.grants);setPlaybackDefaults(defaultPlayerPreferences);setError('');};
  const update=(id:string,value:Partial<Grant>)=>setGrants(g=>g.map(x=>x.connectionId===id?{...x,...value}:x));
  const toggle=(c:Connection)=>setGrants(g=>g.some(x=>x.connectionId===c.id)?g.filter(x=>x.connectionId!==c.id):[...g,{connectionId:c.id,kinds:kinds[c.type]||['video'],sections:null,categories:null}]);
  const confirm = (account:Account,action:'toggle'|'delete') => { setError(''); setConfirmation({account,action}); };
  const applyConfirmation = async () => {
    if (!confirmation || saving) return;
    const {account,action}=confirmation;
    setSaving(true);setError('');
    try {
      if(action==='delete') await api(`/accounts/${account.id}`,{},'DELETE');
      else await api(`/accounts/${account.id}`,{disabled:!account.disabled},'PATCH');
      await reload();
      onToast(action==='delete'?'Account deleted.':account.disabled?'Account re-enabled.':'Account disabled and signed out.');
      setConfirmation(null);
    } catch(e) {setError(errorMessage(e));} finally {setSaving(false);}
  };
  return <section className="accounts-panel">
    <div className="section-heading"><div><span className="eyebrow"><ShieldCheck size={16}/> SERVER OWNER</span><h2>Accounts & access</h2><p>Create accounts and share the libraries each person can watch. Each account can also add and manage its own connections.</p></div><button className="button primary small" onClick={()=>edit('new')}><Plus size={16}/>Create account</button></div>
    {busy?<Busy label="Loading accounts…"/>:accounts.length?<ul className="account-list" aria-label="Server accounts">{accounts.map(account=>{
      const shared=connections.filter(c=>account.grants.some(g=>g.connectionId===c.id));
      return <li className={`account-row ${account.disabled?'account-disabled':''}`} key={account.id} aria-label={`Account ${account.name}`}>
        <span className="avatar account-avatar" aria-hidden="true">{Array.from(account.name)[0]?.toUpperCase()}</span>
        <div className="account-identity">
          <div className="account-name"><strong>{account.name}</strong><span className={`account-status ${account.role==='owner'?'owner':account.disabled?'disabled':'active'}`}>{account.role==='owner'?'Server owner':account.disabled?'Disabled':'Active'}</span></div>
          <small className="account-username">{account.username || account.email}</small>
          {account.role==='member'&&<div className="account-sources">{shared.slice(0,4).map(c=><span className="account-source" key={c.id} title={c.name}><ConnectorLogo type={c.type}/><span>{c.type==='youtube'?'YouTube':c.name}</span></span>)}{shared.length>4&&<span>+{shared.length-4} more</span>}{!shared.length&&<span>No shared connections</span>}</div>}
        </div>
        {account.role==='member'&&<div className="account-actions">
          <button className="button ghost small" onClick={()=>edit(account)} disabled={saving}>Manage access</button>
          <button className={`button small ${account.disabled?'ghost':'danger'}`} disabled={saving} onClick={()=>confirm(account,'toggle')}>{account.disabled?'Re-enable account':'Disable account'}</button>
          <button className="button danger small" disabled={saving} onClick={()=>confirm(account,'delete')}><Trash2 size={15}/>Delete account</button>
        </div>}
      </li>;
    })}</ul>:<Empty icon={<Users/>} title="No accounts yet"/>}
    {error&&!editing&&!confirmation&&<div className="form-error" role="alert">{error}</div>}
    {confirmation&&<Modal title={confirmation.action==='delete'?'Delete this account?':confirmation.account.disabled?'Re-enable account?':'Disable this account?'} onClose={()=>{if(!saving)setConfirmation(null);}}>
      <p>{confirmation.action==='delete'?`Are you sure you want to delete ${confirmation.account.name} (${confirmation.account.username})? They will be signed out on every device. Their profiles, watch history, saved lists and access will be permanently removed. Your connections and other accounts will stay in place. This cannot be undone.`:confirmation.account.disabled?`${confirmation.account.name} will be able to sign in again with their existing password and access.`:`${confirmation.account.name} will be signed out on every device and unable to sign in. You can re-enable this account later.`}</p>
      {error&&<div className="form-error" role="alert">{error}</div>}
      <div className="form-actions account-confirm-actions"><button className="button ghost" disabled={saving} onClick={()=>setConfirmation(null)}>Cancel</button><button className={`button ${confirmation.action==='delete'||!confirmation.account.disabled?'danger':'primary'}`} disabled={saving} onClick={()=>void applyConfirmation()}>{saving?confirmation.action==='delete'?'Deleting…':'Saving…':confirmation.action==='delete'?'Delete account':confirmation.account.disabled?'Re-enable account':'Disable account'}</button></div>
    </Modal>}
    {editing&&<Modal title={editing==='new'?'Create an account':`Manage ${editing.name}`} onClose={()=>{setEditing(null);setPassword('');}} wide>
      <form className="account-form" onSubmit={async e=>{e.preventDefault();setSaving(true);setError('');try{const body={name,grants,...(editing==='new'?{username,password,playbackDefaults}:{...(password?{password}:{})})};await api(editing==='new'?'/accounts':`/accounts/${editing.id}`,body,editing==='new'?'POST':'PATCH');await reload();setEditing(null);setPassword('');onToast(editing==='new'?'Account created. Share the sign-in details with them.':'Account access saved.');}catch(err){setError(errorMessage(err));}finally{setSaving(false);}}}>
        <div className="form-grid"><label>Name<input required maxLength={60} value={name} onChange={e=>setName(e.target.value)}/></label><label>Username<input required minLength={3} maxLength={40} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,39}" disabled={editing!=='new'} value={username} onChange={e=>setUsername(e.target.value)} autoComplete="off" placeholder="Choose a sign-in name"/></label></div>
        <label>{editing==='new'?'Password':'Reset password'}<input type="password" required={editing==='new'} minLength={12} maxLength={256} value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password" placeholder={editing==='new'?'At least 12 characters':'Leave blank to keep the current password'}/></label>
        {editing!=='new'&&<p className="form-help">Setting a new password signs this account out on all devices.</p>}
        {editing==='new'&&<PlaybackDefaultsFields value={playbackDefaults} onChange={setPlaybackDefaults} disabled={saving}/>}
        <fieldset className="grant-list"><legend>Shared connections</legend>{connections.map(c=>{const grant=grants.find(g=>g.connectionId===c.id),field=c.type==='plex'?'sections':'categories';return <div className={`connection-grant ${grant?'selected':''}`} key={c.id}>
          <div className="connection-grant-row"><button type="button" className="connector-choice" aria-pressed={!!grant} aria-label={`Share ${c.name}`} onClick={()=>toggle(c)}><ConnectorLogo type={c.type}/><span><strong>{c.type==='youtube'?'YouTube':c.name}</strong><small>{grant?'Shared with this account':'Not shared'}</small></span></button><button type="button" className="grant-permissions" disabled={!grant} aria-expanded={expanded===c.id} onClick={()=>setExpanded(expanded===c.id?null:c.id)}>Permissions <ChevronDown size={15}/></button></div>
          {grant&&expanded===c.id&&<div className="grant-details"><div className="grant-kinds">{(kinds[c.type]||[]).map(k=><label className="check-label" key={k}><input type="checkbox" checked={grant.kinds.includes(k)} onChange={e=>update(c.id,{kinds:e.target.checked?[...grant.kinds,k]:grant.kinds.filter(x=>x!==k)})}/>{labels[k]}</label>)}</div>
            {['plex','xtream','m3u'].includes(c.type)&&<><label className="check-label"><input type="checkbox" checked={grant[field]===null} onChange={e=>update(c.id,{[field]:e.target.checked?null:[]})}/>All {c.type==='plex'?'Plex libraries':'categories'}</label>{grant[field]!==null&&<div className="grant-options">{options[c.id]?.length?options[c.id].map(o=><label className="check-label" key={o.id}><input type="checkbox" checked={grant[field]?.includes(o.id)||false} onChange={e=>update(c.id,{[field]:e.target.checked?[...(grant[field]||[]),o.id]:(grant[field]||[]).filter(x=>x!==o.id)})}/>{o.name}</label>):<p className="form-help">Library choices are unavailable. Retry after checking the connection.</p>}</div>}</>}
          </div>}
        </div>;})}</fieldset>
        {error&&<div className="form-error" role="alert">{error}</div>}
        <div className="form-actions"><button className="button primary" disabled={saving}><Save size={17}/>{saving?'Saving…':editing==='new'?'Create account':'Save access'}</button><button type="button" className="button ghost" onClick={()=>{setEditing(null);setPassword('');}}>Cancel</button></div>
      </form>
    </Modal>}
  </section>;
}
