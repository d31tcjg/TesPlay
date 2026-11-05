/// <reference types="vite/client" />
// Isolated browser fixture: real library and navigation, synthetic API data only.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles.css';
import Navigation from '../../src/Navigation';
import LibraryBrowser from '../../src/LibraryBrowser';

const now = 1800001000;
Date.now = () => now * 1000;
const start = 1800000000;
const channels = Array.from({ length: 40 }, (_, i) => ({
  id: `live:${i + 1}`, number: String(i + 1), name: `Synthetic ${i + 1}`, source: 'Antenna',
  airings: Array.from({ length: 48 }, (_, j) => ({ start: start + j * 1800, end: start + (j + 1) * 1800,
    title: `Program ${i + 1} · ${j + 1}` })),
}));
window.fetch = async (input) => {
  const url = new URL(String(input), location.href);
  let body = {};
  if (url.pathname.endsWith('/guide')) body = { start, end: start + 86400, channels };
  else if (url.pathname.endsWith('/now')) body = { start, end: start + 86400, channels: channels.map(c => ({ ...c, airings: c.airings.slice(0, 1) })) };
  else if (url.pathname === '/api/catalog') body = { items: [] };
  else throw new Error(`Unexpected fixture API: ${url}`);
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
};
const noop = () => {};
createRoot(document.getElementById('root')!).render(<div className="app-shell" data-navigation-overlay="false">
  <Navigation view="live" phone={innerWidth < 700} signedIn searchOpen={false} onNavigate={noop} onSearch={noop} onRemote={noop} onProfile={noop} onSignIn={noop} />
  <main><div><LibraryBrowser mode="live" selectedConnection={null} query="" connections={[{ id: 'synthetic', type: 'channels', name: 'Synthetic DVR', createdAt: '', configured: true }]}
    library={{ favorites: [], progress: [], stars: [], queue: [] }} onOpen={noop} onFavorite={noop} onStar={noop} onConnect={noop} onYouTube={noop} onGuide={noop} /></div></main>
</div>);
