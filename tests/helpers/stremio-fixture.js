export const catalogManifest = {
  id:'com.linvo.cinemeta',name:'Cinemeta',version:'1.0.0',resources:['catalog','meta'],types:['movie','series'],idPrefixes:['tt'],
  catalogs:['movie','series'].map(type=>({id:'top',type,name:type==='movie'?'Movies':'Series',extra:[{name:'skip'},{name:'search'}]})),
};
export const streamManifest = {
  id:'org.fixture.streams',name:'My sources',version:'1.0.0',resources:[{name:'stream',types:['movie','series'],idPrefixes:['tt']},'subtitles'],types:['movie','series'],idPrefixes:['tt'],catalogs:[],behaviorHints:{configurable:true},
};
export const movie = {id:'ttmovie',type:'movie',name:'Flower',description:'A short sample video.',poster:'https://images.example/poster.jpg',releaseInfo:'2026'};
export const series = {id:'ttseries',type:'series',name:'Sample series',videos:[{id:'ttseries:special:opening',title:'Opening',season:0,episode:1},{id:'ttseries:first',title:'First episode',season:1,episode:1},{id:'ttseries:second',title:'Second episode',season:1,episode:2}]};
export const configuredUrl = 'https://addon.example/debrid-private-key/manifest.json';
export const sampleUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

export function stremioProviderFixture(){
  const state={approved:false,requests:[],calls:[],broken:new Set(),streams:[
    {name:'Torrent',infoHash:'a'.repeat(40)},
    {name:'1080p · Direct',title:'Your configured source',url:sampleUrl+'?token=private-playback-token',behaviorHints:{bingeGroup:'fixture-direct',proxyHeaders:{request:{'User-Agent':'Fixture player','Referer':'https://source.example',Host:'forbidden.example','X-Bad':'bad\r\nheader'}}}},
    {name:'HLS',url:'https://video.example/movie.m3u8?key=private-hls-token'},
  ]};
  const request=async(raw,options={})=>{
    state.requests.push(String(raw));state.calls.push({url:String(raw),options});
    const url=new URL(raw);
    if(state.broken.has(url.hostname))throw new Error('Fixture provider unavailable');
    if(url.hostname==='link.stremio.com'){
      if(url.pathname==='/api/create')return {result:{code:'ABCD',link:'https://link.stremio.com/ABCD',qrcode:'ignored'}};
      return state.approved?{result:{authKey:'private-stremio-auth-key'}}:{error:{code:2},result:null};
    }
    if(url.hostname==='api.strem.io'){
      if(url.pathname.endsWith('addonCollectionGet'))return {result:{addons:[{transportUrl:'https://v3-cinemeta.strem.io/manifest.json',manifest:structuredClone(catalogManifest)},{transportUrl:configuredUrl,manifest:structuredClone(streamManifest)}]}};
      throw new Error('Unexpected Stremio account mutation');
    }
    if(url.pathname.endsWith('manifest.json'))return structuredClone(url.hostname==='v3-cinemeta.strem.io'?catalogManifest:streamManifest);
    if(url.pathname.includes('/meta/'))return {meta:structuredClone(url.pathname.includes('/series/')?series:movie)};
    if(url.pathname.includes('/catalog/')){
      const extra=decodeURIComponent(url.pathname.split('/').at(-1).replace(/\.json$/,''));
      const offset=Number(extra.match(/skip=(\d+)/)?.[1]||0);
      if(url.pathname.includes('/series/'))return {metas:[structuredClone(series)]};
      return {metas:Array.from({length:100},(_,i)=>({...movie,id:i+offset===0?movie.id:`ttmovie${i+offset}`,name:i+offset===0?movie.name:`Flower ${i+offset}`}))};
    }
    if(url.pathname.includes('/stream/'))return {streams:structuredClone(state.streams)};
    if(url.pathname.includes('/subtitles/'))return {subtitles:[{id:'en',lang:'eng',url:'https://subs.example/captions.srt?key=private-subtitle-key'}]};
    throw new Error('Unexpected fixture request');
  };
  return {state,request};
}
