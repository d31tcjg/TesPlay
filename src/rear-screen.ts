export function isTeslaBrowser(userAgent: string) {
  return /\b(?:Tesla|QtCarBrowser)\b/i.test(userAgent);
}

export function isTeslaRearScreen({
  userAgent,
  width,
  height,
  pixelRatio,
}: {
  userAgent: string;
  width: number;
  height: number;
  pixelRatio: number;
}) {
  // screen dimensions are CSS pixels; viewport dimensions also lose browser chrome.
  const matches=(cssPixels:number,physicalPixels:number)=>
    Math.round(cssPixels*pixelRatio)===physicalPixels || cssPixels===Math.round(physicalPixels/pixelRatio);
  return isTeslaBrowser(userAgent) &&
    Number.isFinite(pixelRatio) && pixelRatio > 0 &&
    // Non-integer DPRs can round screen.width/height to a whole CSS pixel.
    // The measured Model 3 rear browser reports 1280 × 720 at DPR 1,
    // even though the supplied panel specification is 1280 × 800.
    matches(width,1280) && (matches(height,720) || matches(height,800));
}
