// Camera views share the car's graphics memory with the browser. Keep fewer
// decoded frames on Tesla rather than retaining a desktop-sized video queue.
export function playbackBufferLimits(userAgent: string) {
  return /Tesla|QtCarBrowser/i.test(userAgent)
    ? {maxAudioSeconds:8,maxVideoFrames:8,decodeLookaheadMs:1500}
    : {maxAudioSeconds:16,maxVideoFrames:24,decodeLookaheadMs:4000};
}
