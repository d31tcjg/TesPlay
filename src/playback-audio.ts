// Resume sound synchronously in the selecting tap, before lazy imports or requests.
let context: AudioContext | undefined;
export function getPlaybackAudio() {
  if(!context || context.state==='closed') {
    if(typeof AudioContext==='undefined')return undefined;
    context=new AudioContext({latencyHint:'playback'});
  }
  return context;
}
export function beginPlaybackGesture() {
  try { const audio=getPlaybackAudio(); if(audio && audio.state!=='running')void audio.resume().catch(()=>{}); } catch { /* The player offers a sound button when this browser needs another gesture. */ }
}
export function closePlaybackAudio() {const previous=context;context=undefined;void previous?.close().catch(()=>{});}
