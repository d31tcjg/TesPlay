/** Presentation only: a narrow browser window is not necessarily a phone. */
export function isPhoneBrowser(userAgent: string, mobileHint = false) {
  if (/\b(?:Tesla|QtCarBrowser|iPad|Tablet)\b/i.test(userAgent)) return false;
  if (/\b(?:iPhone|iPod|Windows Phone|IEMobile)\b/i.test(userAgent)) return true;
  if (/\bAndroid\b/i.test(userAgent)) return /\bMobile\b/i.test(userAgent) || mobileHint;
  return mobileHint && !/\b(?:Macintosh|Windows NT|CrOS)\b/i.test(userAgent);
}
