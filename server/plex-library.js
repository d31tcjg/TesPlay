import { providerError } from './media.js';
const rows = value => value == null ? [] : Array.isArray(value) ? value : [value];
const entries = container => [...rows(container.Metadata), ...rows(container.Video), ...rows(container.Directory), ...rows(container.Track)];
const identifier = value => { if (!/^\d{1,20}$/.test(String(value))) throw providerError('Choose a Plex library.'); return String(value); };
const kind = value => ['show','season','episode'].includes(value) ? 'series' : ['artist','album','track'].includes(value) ? 'audio' : 'movie';

export function registerPlexLibrary(app, { ctx, connection, request, token, item, route, art }) {
  const sections = async (req,c) => {
    const container=(await request(c,'/library/sections',token(req,c))).MediaContainer || {};
    return rows(container.Directory).map(s=>({id:String(s.key),title:String(s.title),kind:kind(s.type),folderId:Buffer.from(`/library/sections/${s.key}/all`).toString('base64url')}))
      .filter(s=>!ctx.canAccess || ctx.canAccess(req,c,{type:s.kind,sectionId:s.id}));
  };
  const seal = (c,s,path) => ctx.sealMedia({purpose:'plex-list',connectionId:c.id,sectionId:s.id,kind:s.kind,path});
  const assert = (req,c,s) => ctx.assertAccess?.(req,c,{type:s.kind,sectionId:s.id});
  const permittedEntries = (req,c,s,data) => entries(data).filter(x=>!ctx.canAccess||ctx.canAccess(req,c,{type:kind(x.type),sectionId:String(x.librarySectionID||s.id)}));
  const watchlist = async (req,c,s,page=1) => {
    const size=60;
    const profileToken=c.config.profileTokens?.[ctx.getProfileId(req)]?.token;
    const data=(await request(c,`https://discover.provider.plex.tv/library/sections/watchlist/all?X-Plex-Container-Start=${(page-1)*size}&X-Plex-Container-Size=${size}`,profileToken||c.config.userToken||token(req,c))).MediaContainer||{};
    const result=await Promise.all(entries(data).filter(x=>kind(x.type)===s.kind).map(async x=>{
      const found=(await request(c,`/library/all?guid=${encodeURIComponent(x.guid||'')}`,token(req,c))).MediaContainer||{};
      const local=permittedEntries(req,c,s,found).find(y=>y.ratingKey);
      if(local) {
        if(ctx.canAccess && !ctx.canAccess(req,c,{type:kind(local.type),sectionId:String(local.librarySectionID||s.id)})) return null;
        return item(req,c,{...local,librarySectionID:local.librarySectionID||s.id},token(req,c));
      }
      if(c.access?.sections) return null;
      return {id:`watchlist:${x.guid||x.ratingKey}`,connectionId:c.id,providerType:'plex',source:c.name,type:s.kind==='series'?'series':'movie',contentKind:s.kind,artwork:'poster',title:String(x.title),year:String(x.year||''),poster:x.thumb?art(req,c,new URL(x.thumb,'https://metadata.provider.plex.tv').toString()):undefined,description:String(x.summary||''),unavailable:true};
    }));
    return {items:result.filter(Boolean),hasMore:Number(data.totalSize||0)>page*size};
  };
  const root='/api/plex/:connectionId';
  app.get(root+'/continuity',route(async(req,res)=>{
    const c=connection(req,req.params.connectionId,'plex'), t=token(req,c), libraries=await sections(req,c);
    const progress=new Map(), saved=new Map(), notes=[];
    const results=await Promise.allSettled(libraries.map(async s=>{
      const params=new URLSearchParams({type:s.kind==='series'?'4':s.kind==='audio'?'10':'1',sort:'lastViewedAt:desc','lastViewedAt>':'0','X-Plex-Container-Size':'200'});
      const data=(await request(c,`/library/sections/${s.id}/all?${params}`,t)).MediaContainer||{};
      return permittedEntries(req,c,s,data).filter(x=>Number(x.viewOffset)>0||Number(x.viewCount)>0).map(x=>{
        const media=item(req,c,{...x,librarySectionID:x.librarySectionID||s.id},t), duration=Number(x.duration||0)/1000;
        return {item:media,seconds:Number(x.viewOffset)>0?Number(x.viewOffset)/1000:media.watched?duration:0,duration,updatedAt:new Date((Number(x.lastViewedAt)||0)*1000).toISOString()};
      });
    }));
    for(const result of results)if(result.status==='fulfilled')for(const p of result.value)progress.set(`${p.item.type}:${p.item.id}`,p);else notes.push('Some Plex history could not load. Your saved TesPlay progress is still available.');
    const kinds=[...new Set(libraries.filter(s=>['movie','series'].includes(s.kind)).map(s=>s.kind))];
    for(const kind of kinds)try{
      const s=libraries.find(s=>s.kind===kind);
      const result=await watchlist(req,c,s);
      for(const media of result.items)saved.set(`${media.type}:${media.id}`,media);
      if(result.hasMore)notes.push('More Plex Watchlist titles are available in your Plex library’s Watchlist.');
    }catch{notes.push('Plex Watchlist could not load. Check your Plex account connection.');}
    res.json({progress:[...progress.values()],watchlist:[...saved.values()],notes:[...new Set(notes)]});
  }));
  app.get(root+'/sections',route(async(req,res)=>{
    const c=connection(req,req.params.connectionId,'plex'); res.json({sections:await sections(req,c)});
  }));
  app.get(root+'/hubs',route(async(req,res)=>{
    const c=connection(req,req.params.connectionId,'plex'), id=identifier(req.query.sectionId);
    const s=(await sections(req,c)).find(s=>s.id===id);
    if(!s) throw providerError('This Plex library is not available to your account.',403);
    assert(req,c,s);
    const t=token(req,c), container=(await request(c,`/hubs/sections/${id}?count=12&includeCollections=1`,t)).MediaContainer||{};
    const hubs=rows(container.Hub).filter(h=>h.key).map(h=>({
      id:seal(c,s,h.key),title:String(h.title||'Collection'),
      items:permittedEntries(req,c,s,h).slice(0,12).map(x=>item(req,c,{...x,librarySectionID:x.librarySectionID||s.id},t)),
    }));
    const all=(await request(c,`/library/sections/${id}/all?X-Plex-Container-Size=12`,t)).MediaContainer||{};
    hubs.push({id:seal(c,s,`/library/sections/${id}/all`),title:`All ${s.title}`,items:permittedEntries(req,c,s,all).slice(0,12).map(x=>item(req,c,{...x,librarySectionID:x.librarySectionID||s.id},t))});
    const notes=[];
    if(['movie','series'].includes(s.kind)) {
      try { const saved=await watchlist(req,c,s); if(saved.items.length) hubs.unshift({id:ctx.sealMedia({purpose:'plex-watchlist',connectionId:c.id,sectionId:s.id,kind:s.kind}),title:'Watchlist',items:saved.items.slice(0,12)}); }
      catch {notes.push('Plex Watchlist could not load. Your server libraries are available below.');}
    }
    res.json({section:s,hubs,notes});
  }));
  app.get(root+'/list',route(async(req,res)=>{
    const c=connection(req,req.params.connectionId,'plex');
    let value;try{value=ctx.openMedia(String(req.query.listId||''));}catch{throw providerError('This Plex list is unavailable. Reopen the library.',404);}
    if(!['plex-list','plex-watchlist'].includes(value.purpose)||value.connectionId!==c.id) throw providerError('Choose a list from this Plex server.',404);
    assert(req,c,{id:value.sectionId,kind:value.kind});
    if(value.purpose==='plex-watchlist') return res.json(await watchlist(req,c,{id:value.sectionId,kind:value.kind},Math.max(1,Math.min(10000,parseInt(req.query.page,10)||1))));
    const u=new URL(value.path,c.config.url);
    // The descriptor is issued by this server, but keep the read-only path boundary explicit.
    if(u.origin!==new URL(c.config.url).origin || !/^\/(?:library\/(?:sections|collections|metadata)|hubs)\//.test(u.pathname)) throw providerError('Unsupported Plex list.');
    const page=Math.max(1,Math.min(10000,parseInt(req.query.page,10)||1)), size=60;
    u.searchParams.set('X-Plex-Container-Start',String((page-1)*size));u.searchParams.set('X-Plex-Container-Size',String(size));
    if(req.query.q) u.searchParams.set('title',String(req.query.q).slice(0,200));
    const t=token(req,c), data=(await request(c,u.pathname+u.search,t)).MediaContainer||{};
    const result=entries(data),permitted=permittedEntries(req,c,{id:value.sectionId},data);
    res.json({items:permitted.map(x=>item(req,c,{...x,librarySectionID:x.librarySectionID||value.sectionId},t)),hasMore:Number(data.totalSize||0)>page*size || (data.totalSize==null && result.length===size)});
  }));
}
