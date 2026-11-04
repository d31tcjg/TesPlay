import type { ClientCapabilities } from '@canvas-stream-player/contracts';

type ClientCodecCapability = ClientCapabilities['codecs'][number];

import { safeErrorCause } from './errors.js';

export interface CapabilityProbeOptions {
  videoConfigs?: readonly VideoDecoderConfig[];
  audioConfigs?: readonly AudioDecoderConfig[];
}

const DEFAULT_VIDEO: readonly VideoDecoderConfig[] = [
  { codec: 'avc1.42E01E', codedWidth: 640, codedHeight: 360 },
  { codec: 'hvc1.1.6.L93.B0', codedWidth: 640, codedHeight: 360 },
  { codec: 'vp8', codedWidth: 640, codedHeight: 360 },
  { codec: 'vp09.00.10.08', codedWidth: 640, codedHeight: 360 },
  { codec: 'av01.0.04M.08', codedWidth: 640, codedHeight: 360 },
];
const DEFAULT_AUDIO: readonly AudioDecoderConfig[] = [
  { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 },
  { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
  { codec: 'mp3', sampleRate: 48_000, numberOfChannels: 2 },
  { codec: 'vorbis', sampleRate: 48_000, numberOfChannels: 2 },
  { codec: 'flac', sampleRate: 48_000, numberOfChannels: 2 },
];

interface DecoderSupport {
  supported: boolean;
}
interface DecoderConstructorLike<C> {
  isConfigSupported(config: C): Promise<DecoderSupport>;
}

interface RuntimeCodecs {
  VideoDecoder?: DecoderConstructorLike<VideoDecoderConfig>;
  AudioDecoder?: DecoderConstructorLike<AudioDecoderConfig>;
  AudioContext?: typeof AudioContext;
}

function runtimeCodecs(): RuntimeCodecs {
  return globalThis as unknown as RuntimeCodecs;
}

function serializableConfig(
  config: VideoDecoderConfig | AudioDecoderConfig,
): Record<string, boolean | number | string | null> {
  const record: Record<string, boolean | number | string | null> = {};
  for (const [key, value] of Object.entries(
    config as unknown as Record<string, unknown>,
  )) {
    if (
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string' ||
      value === null
    )
      record[key] = value;
  }
  return record;
}

export async function probeTrackDecoderCapability(
  config: VideoDecoderConfig | AudioDecoderConfig,
  kind: 'video' | 'audio',
): Promise<ClientCodecCapability> {
  const runtime = runtimeCodecs();
  const decoder = kind === 'video' ? runtime.VideoDecoder : runtime.AudioDecoder;
  if (!decoder) {
    return {
      codec: config.codec,
      supported: false,
      smooth: null,
      powerEfficient: null,
      testedConfig: serializableConfig(config),
      error: `${kind} WebCodecs decoder is unavailable`,
    };
  }
  try {
    const result =
      kind === 'video'
        ? await runtime.VideoDecoder?.isConfigSupported(config)
        : await runtime.AudioDecoder?.isConfigSupported(config as AudioDecoderConfig);
    return {
      codec: config.codec,
      supported: result?.supported === true,
      smooth: null,
      powerEfficient: null,
      testedConfig: serializableConfig(config),
      error: null,
    };
  } catch (error) {
    return {
      codec: config.codec,
      supported: false,
      smooth: null,
      powerEfficient: null,
      testedConfig: serializableConfig(config),
      error: safeErrorCause(error).slice(0, 512),
    };
  }
}

export async function probeMediaCapabilities(
  options: CapabilityProbeOptions = {},
): Promise<ClientCapabilities> {
  const codecs: ClientCapabilities['codecs'] = [];
  for (const config of options.videoConfigs ?? DEFAULT_VIDEO)
    codecs.push(await probeTrackDecoderCapability(config, 'video'));
  for (const config of options.audioConfigs ?? DEFAULT_AUDIO)
    codecs.push(await probeTrackDecoderCapability(config, 'audio'));

  const canvas = document.createElement('canvas');
  // Context modes are exclusive: probing WebGL must not consume the 2D canvas.
  const gl = document.createElement('canvas').getContext('webgl');
  const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
  const runtime = runtimeCodecs();
  let audioState: ClientCapabilities['audioContextState'] = 'unsupported';
  const AudioContextConstructor = runtime.AudioContext;
  if (AudioContextConstructor !== undefined) {
    const context = new AudioContextConstructor();
    audioState = context.state === 'interrupted' ? 'suspended' : context.state;
    await context.close();
  }
  return {
    measuredAt: new Date().toISOString(),
    synthetic: false,
    userAgent: navigator.userAgent || 'unknown',
    platform: navigator.platform,
    screen: {
      width: Math.max(1, screen.width),
      height: Math.max(1, screen.height),
      colorDepth: Math.max(1, screen.colorDepth),
      devicePixelRatio: Math.max(0.1, devicePixelRatio || 1),
    },
    touchPoints: navigator.maxTouchPoints,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    webglRenderer:
      gl && debugInfo
        ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)).slice(0, 512)
        : null,
    canvas2d: Boolean(canvas.getContext('2d')),
    webAudio: AudioContextConstructor !== undefined,
    audioContextState: audioState,
    webCodecs: {
      videoDecoder: runtime.VideoDecoder !== undefined,
      audioDecoder: runtime.AudioDecoder !== undefined,
    },
    mediaSession: 'mediaSession' in navigator,
    fullscreen: 'requestFullscreen' in canvas,
    codecs,
  };
}

export async function probeTrackDecoderConfig(
  config: VideoDecoderConfig | AudioDecoderConfig,
  kind: 'video' | 'audio',
): Promise<boolean> {
  return (await probeTrackDecoderCapability(config, kind)).supported;
}
