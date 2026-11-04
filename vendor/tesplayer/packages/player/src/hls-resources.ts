import type { PlayerPolicy } from '@canvas-stream-player/contracts';

import { EngineFault } from './errors.js';
import {
  MAX_HLS_PLAYLIST_BYTES,
  MAX_HLS_PLAYLIST_DEPTH,
  MAX_HLS_VOD_SEGMENTS,
  validateHlsPlaylist,
  type HlsResourceKind,
} from './hls.js';

const MAX_HLS_PLAYLISTS = 32;

export interface HlsResourcePolicy {
  readonly kind: HlsResourceKind | 'playlist';
  readonly depth: number;
}

/** Resource classification and bounded identities belong to one playback operation. */
export class HlsResources {
  private readonly resources = new Map<string, HlsResourcePolicy>();
  private readonly keys = new Set<string>();
  private readonly mediaOrder: string[] = [];
  private readonly playlists = new Set<string>();
  private directOrigin: string | null = null;
  liveWindowDurationSeconds: number | null = null;

  constructor(
    private readonly policy: PlayerPolicy,
    private readonly isLive: () => boolean,
  ) {}

  registerRoot(url: string, direct: boolean): void {
    this.resources.set(url, { kind: 'playlist', depth: 0 });
    this.playlists.add(url);
    if (direct) this.directOrigin = new URL(url).origin;
  }

  getResource(url: string): HlsResourcePolicy | undefined {
    return this.resources.get(url);
  }

  async validateResponse(
    response: Response,
    url: string,
    resource: HlsResourcePolicy | undefined,
  ): Promise<Response> {
    if (!resource)
      throw new EngineFault(
        'HLS_MANIFEST_INVALID',
        'HLS requested an unclassified child resource',
      );
    if (resource.kind === 'key') {
      if (!response.body)
        throw new EngineFault('HLS_KEY_FAILED', 'HLS AES-128 key body is unavailable');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          byteLength += item.value.byteLength;
          if (byteLength > 16) {
            await reader.cancel('invalid key length');
            break;
          }
          chunks.push(item.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (byteLength !== 16)
        throw new EngineFault('HLS_KEY_FAILED', 'HLS AES-128 key has invalid length');
      const body = new Uint8Array(16);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return this.rebuildResponse(response, body);
    }
    const playlist =
      resource.kind === 'playlist' ||
      resource.kind === 'variant' ||
      resource.kind === 'rendition';
    if (!playlist) return response;
    if (!response.body)
      throw new EngineFault('HLS_MANIFEST_INVALID', 'HLS playlist body is unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        if (byteLength + item.value.byteLength > MAX_HLS_PLAYLIST_BYTES) {
          await reader.cancel('playlist byte limit');
          throw new EngineFault(
            'HLS_MANIFEST_INVALID',
            'HLS playlist exceeds byte limit',
          );
        }
        byteLength += item.value.byteLength;
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const summary = validateHlsPlaylist(
      text,
      this.policy.maxPlaylistEntries,
      this.policy.maxSegmentKeys,
    );
    if (summary.segmentCount > 0 && summary.targetDuration !== null)
      this.liveWindowDurationSeconds = summary.segmentCount * summary.targetDuration;
    const depth = resource.depth;
    if (depth > MAX_HLS_PLAYLIST_DEPTH)
      throw new EngineFault(
        'HLS_MANIFEST_INVALID',
        'HLS playlist nesting limit exceeded',
      );
    for (const child of summary.resources) {
      const childUrl = new URL(child.uri, url).href;
      if (this.directOrigin !== null && new URL(childUrl).origin !== this.directOrigin)
        throw new EngineFault(
          'HLS_MANIFEST_INVALID',
          'Trusted-direct HLS child crossed the allowed origin',
        );
      const childIsPlaylist = child.kind === 'variant' || child.kind === 'rendition';
      const childDepth = depth + (childIsPlaylist ? 1 : 0);
      if (childDepth > MAX_HLS_PLAYLIST_DEPTH)
        throw new EngineFault(
          'HLS_MANIFEST_INVALID',
          'HLS playlist nesting limit exceeded',
        );
      if (childIsPlaylist) {
        this.playlists.add(childUrl);
        if (this.playlists.size > MAX_HLS_PLAYLISTS)
          throw new EngineFault(
            'HLS_MANIFEST_INVALID',
            'HLS playlist expansion limit exceeded',
          );
      }
      if (child.kind === 'key') {
        this.keys.add(childUrl);
        if (this.keys.size > this.policy.maxSegmentKeys)
          throw new EngineFault(
            'HLS_MANIFEST_INVALID',
            'HLS key identity limit exceeded',
          );
      }
      const previous = this.resources.get(childUrl);
      this.resources.set(childUrl, { kind: child.kind, depth: childDepth });
      if (!previous && (child.kind === 'segment' || child.kind === 'map')) {
        this.mediaOrder.push(childUrl);
        // VOD playlists contain the whole title. Evicting their first segments
        // before demux probes begin makes long Plex/YouTube titles unplayable.
        // Live streams retain a rolling window; VOD retains both bounded inputs.
        const mediaLimit = this.isLive()
          ? this.policy.maxSegmentKeys
          : 2 * MAX_HLS_VOD_SEGMENTS + this.policy.maxPlaylistEntries;
        while (this.mediaOrder.length > mediaLimit) {
          const expired = this.mediaOrder.shift();
          if (expired) this.resources.delete(expired);
        }
      }
    }
    return this.rebuildResponse(response, body);
  }

  private rebuildResponse(response: Response, body: BodyInit): Response {
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}
