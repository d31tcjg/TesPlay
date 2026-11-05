// Run: node tests/channels-guide-layout.browser.mjs <evidence-dir>
// Chrome + Vite only; no real backend, credentials, DVR, or playback.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const out = resolve(process.argv[2] || 'evidence/guide-layout');
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'guide-chrome-'));
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0] + 'tests/fixtures/guide-layout.html';
const chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank',
], { stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
const results = [], failures = [];
let ws;
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then(s => s.split('\n')[0]).catch(() => null);
    if (!port) await delay(100);
  }
  if (!port) throw new Error('Chrome did not start');
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
  const send = async (method, params = {}) => {
    const response = await new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result;
  };
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const shot = async name => { const s = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const measure = `(() => {
    const sc = document.querySelector('.cg-scroller');
    const r = sc.getBoundingClientRect(), h = document.querySelector('.cg-header').getBoundingClientRect();
    const dock = document.querySelector('.navigation-dock').getBoundingClientRect();
    const line = document.querySelector('.cg-nowline').getBoundingClientRect();
    const cells = [...document.querySelectorAll('.cg-cell.current')].filter(c => { const b=c.getBoundingClientRect(); return b.top>=h.bottom && b.bottom<=r.bottom; });
    const titleHits = cells.map(c => {
      const t=c.querySelector('.cg-cell-title'), range=document.createRange(); range.selectNodeContents(t);
      const b=range.getBoundingClientRect(), x=Math.max(b.left, line.left+1), y=b.top+b.height/2;
      // pointer-events:none makes elementFromPoint unsuitable for paint ordering: inspect the paint stack.
      const layers=document.elementsFromPoint(x,y);
      return { title:t.textContent, left:b.left, right:b.right, crosses:line.left>=b.left&&line.left<b.right,
        textZ:getComputedStyle(t).zIndex, lineZ:getComputedStyle(document.querySelector('.cg-nowline')).zIndex,
        textPosition:getComputedStyle(t).position, cellZ:getComputedStyle(c).zIndex, layers:layers.slice(0,4).map(e=>e.className) };
    });
    return { top:r.top, bottom:r.bottom, height:r.height, headerTop:h.top, headerBottom:h.bottom,
      dockTop:dock.top, scrollY, pageMax:document.documentElement.scrollHeight-innerHeight, scrollTop:sc.scrollTop,
      fullRows:cells.length, rendered:document.querySelectorAll('.cg-row').length, titleHits,
      headerHit:!!document.elementFromPoint(r.left+200,h.top+20)?.closest('.cg-header') };
  })()`;
  for (const [width, height] of [[1280,720], [1920,1200]]) {
    const label = `${width}x${height}`, r = { viewport: label };
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    for (let i=0;i<100;i++) { if (await evaluate(`!!document.querySelector('.cg-cell.current')`)) break; await delay(100); }
    await delay(250);
    r.initial = await evaluate(measure); await shot(`${label}-initial`);
    check(r.initial.fullRows >= (height===720 ? 3 : 6), `${label}: initial grid must show multiple full rows (got ${r.initial.fullRows})`);
    check(r.initial.bottom <= r.initial.dockTop-8, `${label}: grid clears dock`);
    check(r.initial.titleHits.every(t => !t.crosses || (Number(t.textZ)>Number(t.lineZ) && t.textPosition!=='static')), `${label}: title text paints above crossing now-line`);
    await evaluate(`document.querySelector('.cg-scroller').scrollTop=999999`); await delay(150);
    r.gridBottom = await evaluate(measure); await shot(`${label}-grid-bottom`);
    check(r.gridBottom.headerHit, `${label}: time header visible at grid bottom`);
    check(r.gridBottom.rendered < 30, `${label}: rows remain virtualized`);
    // Exercise intermediate and maximum page scrolling, not just grid scrolling.
    const max = await evaluate(`document.documentElement.scrollHeight-innerHeight`);
    for (const fraction of [0.25, 0.5, 0.75]) {
      await evaluate(`scrollTo(0,${max}*${fraction})`); await delay(100);
      const mid = await evaluate(measure);
      check(mid.headerTop>=0 && mid.headerHit, `${label}: time header visible at page fraction ${fraction}`);
    }
    for (let i=0;i<8;i++) { await evaluate(`scrollTo(0,document.documentElement.scrollHeight)`); await delay(100); }
    r.pageBottom = await evaluate(measure); await shot(`${label}-page-bottom`);
    check(r.pageBottom.headerTop>=0 && r.pageBottom.headerHit, `${label}: time header visible at maximum page scroll`);
    check(Math.abs(r.pageBottom.height-r.initial.height)<=1, `${label}: page scroll must not resize grid`);
    // Move the line across the start of a pinned label and keep it readable.
    await evaluate(`(() => { const sc=document.querySelector('.cg-scroller'), line=document.querySelector('.cg-nowline').getBoundingClientRect(), title=document.querySelector('.cg-cell.current .cg-cell-title').getBoundingClientRect(); sc.scrollLeft+=line.left-title.left-2; })()`); await delay(150);
    r.titleCrossing = await evaluate(measure); await shot(`${label}-title-crossing`);
    const capture = await send('Page.captureScreenshot', { format: 'png' });
    r.paint = await evaluate(`(async () => {
      const line=document.querySelector('.cg-nowline'), lr=line.getBoundingClientRect();
      const sc=document.querySelector('.cg-scroller').getBoundingClientRect(), header=document.querySelector('.cg-header').getBoundingClientRect();
      const title=[...document.querySelectorAll('.cg-cell.current .cg-cell-title')].find(t=>{const b=t.getBoundingClientRect();return b.top>=header.bottom&&b.bottom<sc.bottom;});
      const b=title.getBoundingClientRect(), canvas=document.createElement('canvas'); canvas.width=innerWidth;canvas.height=innerHeight;
      const ctx=canvas.getContext('2d');ctx.fillStyle=getComputedStyle(line).backgroundColor;ctx.fillRect(0,0,1,1);
      const accent=[...ctx.getImageData(0,0,1,1).data];
      const img=new Image();img.src='data:image/png;base64,${capture.data}';await img.decode();ctx.drawImage(img,0,0);
      const pixel=y=>[...ctx.getImageData(Math.floor(lr.left),Math.floor(y),1,1).data];
      return { accent, titleBackground:pixel(b.top+1), gap:pixel(b.bottom+1) };
    })()`);
    check(JSON.stringify(r.paint.titleBackground)!==JSON.stringify(r.paint.accent), `${label}: screenshot pixel confirms marker masked behind title`);
    check(JSON.stringify(r.paint.gap)===JSON.stringify(r.paint.accent), `${label}: screenshot pixel confirms marker remains between labels`);
    check(r.titleCrossing.titleHits.some(t=>t.crosses), `${label}: fixture crosses title starts`);
    check(r.titleCrossing.titleHits.every(t=>!t.crosses||(Number(t.textZ)>Number(t.lineZ)&&t.textPosition!=='static')), `${label}: pinned title starts above now-line`);
    results.push(r);
  }
  await send('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:true });
  await send('Page.navigate', { url });
  for (let i=0;i<100;i++) { if (await evaluate(`!!document.querySelector('.cg-onnow-row')`)) break; await delay(100); }
  await shot('390x844-phone');
  const phone=await evaluate(`({grid:!!document.querySelector('.cg-scroller'),rows:document.querySelectorAll('.cg-onnow-row').length,overflow:document.documentElement.scrollWidth>innerWidth})`);
  check(!phone.grid&&phone.rows>0&&!phone.overflow,'phone: On now list without horizontal overflow'); results.push({phone});
  for (const width of [320, 390, 699, 700, 1280]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height:844,deviceScaleFactor:1,mobile:width<700 });
    await send('Page.navigate', { url: url + '?onnow' });
    for (let i=0;i<100;i++) { if (await evaluate(`!!document.querySelector('.cg-next')`)) break; await delay(100); }
    const next = await evaluate(`(() => {
      const e=document.querySelector('.cg-next'), r=e.getBoundingClientRect();
      const time=new Date(1800001800*1000).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
      return {text:e.textContent, expectedPrefix:innerWidth<700?'Next: '+time+' · Upcoming':'Next: Upcoming',
        overflow:document.documentElement.scrollWidth>innerWidth, right:r.right, width:innerWidth,
        ellipsis:getComputedStyle(e).textOverflow, clipped:e.scrollWidth>e.clientWidth};
    })()`);
    check(next.text.startsWith(next.expectedPrefix), `${width}: Next time/title DOM reading order`);
    check(!next.overflow && next.right<=width && next.ellipsis==='ellipsis', `${width}: Next does not overflow`);
    const ax = await send('Accessibility.getFullAXTree');
    const watch = ax.nodes.find(n=>n.role?.value==='button' && n.name?.value.startsWith('Watch 1 '));
    check(watch?.name?.value.includes(next.text), `${width}: Next is included in accessible name in reading order`);
    await shot(`${width}x844-next`); results.push({onNowWidth:width,next,accessibleName:watch?.name?.value});
  }
  // The same mounted On now component must follow a breakpoint change.
  await send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
  await delay(150);
  check(await evaluate(`document.querySelector('.cg-next').textContent.startsWith('Next: '+new Date(1800001800*1000).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+' · Upcoming')`), 'Next reading order follows resize to phone');
  await writeFile(join(out,'results.json'),JSON.stringify({results,failures},null,2));
  console.log(JSON.stringify({results,failures},null,2));
  if (failures.length) process.exitCode=1;
} finally {
  ws?.close(); chrome.kill();
  await new Promise(r=>chrome.exitCode!==null?r():chrome.once('exit',r));
  await server.close(); await rm(profile,{recursive:true,force:true});
}
