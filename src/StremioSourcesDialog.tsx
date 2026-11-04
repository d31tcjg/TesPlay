import { useEffect, useState } from 'react';
import { Play, RefreshCw } from 'lucide-react';
import { api, errorMessage } from './api';
import { Busy, Modal } from './components';
import type { MediaItem, PlaybackOptions } from './types';
import './stremio.css';

export default function StremioSourcesDialog({item,onClose,onPlay}:{item:MediaItem;onClose:()=>void;onPlay:(sourceId:string)=>void}) {
  const [options,setOptions]=useState<PlaybackOptions|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0),[selected,setSelected]=useState('');
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');setOptions(null);setSelected('');
    void api<PlaybackOptions>(`/playback/options?${new URLSearchParams({connectionId:item.connectionId||'',itemId:item.id,kind:item.type,...(refresh?{refresh:'1'}:{})})}`,undefined,undefined,controller.signal)
      .then(value=>{if(!controller.signal.aborted){setOptions(value);setSelected(value.sources?.find(source=>!source.unavailable)?.id||'');}})
      .catch(reason=>{if(!controller.signal.aborted)setError(errorMessage(reason));})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[item.connectionId,item.id,item.type,refresh]);
  return <Modal title={`Watch ${item.title}`} onClose={onClose} className="stremio-sources-dialog">
    <p>Choose a source to play with TesPlayer.</p>
    {loading?<Busy label="Finding your Stremio sources…"/>:<>
      {error&&<p className="form-error" role="alert">{error}</p>}
      {options?.note&&<p className="form-help" role="status">{options.note}</p>}
      <div className="stremio-sources" role="radiogroup" aria-label="Playback source">{options?.sources?.map(source=><label className={`stremio-source ${source.unavailable?'unavailable':''}`} key={source.id}>
        <input type="radio" name="stremio-source" value={source.id} checked={selected===source.id} disabled={source.unavailable} onChange={()=>setSelected(source.id)}/>
        <span><strong>{source.label}</strong><small>{source.addon}</small>{source.description&&<span className="stremio-source-description">{source.description}</span>}{source.unavailableReason&&<small>{source.unavailableReason}</small>}</span>
      </label>)}</div>
      <button className="button primary full" disabled={!selected} onClick={()=>onPlay(selected)}><Play size={17}/>Play on your screen</button>
      <button className="text-button" onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={15}/>Try sources again</button>
    </>}
  </Modal>;
}
