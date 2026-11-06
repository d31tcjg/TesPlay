/// <reference types="vite/client" />
// Isolated browser fixture for the Channels Recordings list. Real components, talking (through the Vite proxy)
// to the real catalog route backed by synthetic fake-DVR data. See tests/channels-recordings.browser.mjs.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles.css';
import '../../src/remote.css';
import '../../src/remote-layout.css';
import Navigation from '../../src/Navigation';
import LibraryBrowser from '../../src/LibraryBrowser';
import RemoteLibrary from '../../src/RemoteLibrary';
import { recordingsFolder } from '../../src/channels-recordings';

const connection = { id: 'c1', type: 'channels', name: 'Synthetic DVR', createdAt: '', configured: true } as never;
const library = { favorites: [], progress: [], stars: [], queue: [] };
const noop = () => {};
const params = new URLSearchParams(location.search);
const root = createRoot(document.getElementById('root')!);
if (params.get('mode') === 'remote') {
  root.render(<div className="cinema-remote remote-paired"><main className="remote-workspace"><div className="remote-view">
    <RemoteLibrary connections={[connection]} library={library} onOpen={noop} onFavorite={noop} onStar={noop} onClearQueue={noop} onRemoveQueue={noop} />
  </div></main></div>);
} else {
  root.render(<div className="app-shell" data-navigation-overlay="false">
    <Navigation view="catalog" phone={innerWidth < 700} signedIn searchOpen={false} onNavigate={noop} onSearch={noop} onRemote={noop} onProfile={noop} onSignIn={noop} />
    <main><div><LibraryBrowser mode="catalog" selectedConnection={connection} initialParent={recordingsFolder({ id: 'c1', name: 'Synthetic DVR' })} connections={[connection]}
      library={library} query="" onOpen={noop} onFavorite={noop} onStar={noop} onConnect={noop} onYouTube={noop} onGuide={noop} /></div></main>
  </div>);
}
