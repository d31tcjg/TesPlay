import {mkdirSync,readdirSync,copyFileSync,statSync,unlinkSync,utimesSync} from 'node:fs';
import {join} from 'node:path';

// Open tabs can still import an earlier build's hashed chunks after deployment.
// Cache only public build assets, never the data directory or its private files.
export function retainUiAssets(source,destination,now=Date.now()) {
  mkdirSync(destination,{recursive:true,mode:0o700});
  const current=new Set();
  for(const entry of readdirSync(source,{withFileTypes:true})) {
    if(!entry.isFile())continue;
    current.add(entry.name);const target=join(destination,entry.name);
    copyFileSync(join(source,entry.name),target);utimesSync(target,now/1000,now/1000);
  }
  const cached=readdirSync(destination,{withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>({name:entry.name,...statSync(join(destination,entry.name))})).sort((a,b)=>a.mtimeMs-b.mtimeMs);
  let size=cached.reduce((sum,file)=>sum+file.size,0);
  for(const file of cached) {
    if(current.has(file.name))continue;
    if(file.mtimeMs<now-14*86400000 || size>64*1024*1024) {unlinkSync(join(destination,file.name));size-=file.size;}
  }
}
