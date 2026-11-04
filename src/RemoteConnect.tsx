import {useEffect,useState} from 'react';
import {Monitor} from 'lucide-react';
import {api,errorMessage} from './api';
import type {Auth} from './types';
type Screen={id:string;name:string;online:boolean};
export default function RemoteConnect({onConnected}:{onConnected:(auth:Auth,roomId:string)=>void}) {
  const [screens,setScreens]=useState<Screen[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let pending=false;
    const discover=async()=>{
      if(pending)return;pending=true;
      try{
        const result=await api<{screens:Screen[]}>('/remote/screens',undefined,undefined,controller.signal);
        if(controller.signal.aborted)return;
        setScreens(result.screens);
        const online=result.screens.filter(s=>s.online);
        if(online.length===1){setBusy(true);const auth=await api<Auth&{roomId:string}>('/remote/connect',{screenId:online[0].id},undefined,controller.signal);if(!controller.signal.aborted)onConnected(auth,auth.roomId);}
      }catch(e){if(!controller.signal.aborted)setError(errorMessage(e));}
      finally{pending=false;if(!controller.signal.aborted)setBusy(false);}
    };
    void discover();const timer=window.setInterval(discover,5000);return()=>{controller.abort();window.clearInterval(timer);};
  },[onConnected]);
  return <><p>{busy?'Connecting to your screen…':screens.length?'Choose a screen from your account. No QR is needed.':'Open TesPlay on your screen. It will appear here automatically.'}</p><div className="remote-screen-list">{screens.map(screen=><button className="button ghost full" key={screen.id} disabled={busy} onClick={async()=>{
    setBusy(true);setError('');try{const auth=await api<Auth&{roomId:string}>('/remote/connect',{screenId:screen.id});onConnected(auth,auth.roomId);}catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }}><Monitor size={20}/>{screen.name}{screen.online?' · Online':' · Offline'}</button>)}</div>{error&&<p className="form-error" role="alert">{error}</p>}</>;
}
