import http from 'node:http';
import { createYouTubeResolver } from './youtube.js';
const resolveYouTube = createYouTubeResolver({ enabled: true, resolverUrl: '' });
const server = http.createServer(async (req, res) => {
  const controller = new AbortController();
  res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'GET' && req.url === '/health') { res.end('{"ok":true}'); return; }
  const match = req.method === 'GET' && /^\/resolve\/([A-Za-z0-9_-]{11})$/.exec(req.url);
  if (!match) { res.writeHead(404).end('{"error":"Not found"}'); return; }
  try { res.end(JSON.stringify(await resolveYouTube(match[1], controller.signal))); }
  catch (error) { if (!controller.signal.aborted) res.writeHead(error.status || 502).end(JSON.stringify({ error: error.message })); }
});
server.listen(4180, '0.0.0.0', () => console.log('TesPlay optional YouTube resolver listening on port 4180'));
const stop = () => { server.close(); server.closeAllConnections(); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
