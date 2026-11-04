export class AccessSessionExpiredError extends Error {
  constructor() {
    super("Your Cloudflare screen sign-in expired. Reload TesPlay to sign in again; your library is saved.");
  }
}

/** Ask Access for an HTTP error instead of following an HTML login redirect. */
export const tesPlayFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const ownApi = url.origin === location.origin && url.pathname.startsWith('/api/');
  if (!ownApi) return fetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('X-Requested-With', 'XMLHttpRequest');
  const res = await fetch(input, { ...init, headers, redirect: 'manual' });
  if (res.type === 'opaqueredirect' || (res.status === 401 && !res.headers.get('content-type')?.includes('application/json')))
    throw new AccessSessionExpiredError();
  return res;
};

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?:string) { super(message); }
}

export async function api<T = Record<string, never>>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
  keepalive = false,
): Promise<T> {
  const res = await tesPlayFetch(`/api${path}`, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    keepalive,
  });
  const data = await res.json().catch(() => {
    if (!res.ok && res.status >= 500)
      throw new Error(`The TesPlay server is temporarily unavailable (${res.status}). Please try again in a moment.`);
    throw new Error("The server returned an unreadable response. Reload TesPlay and sign in again if requested.");
  });
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status}).`, res.status, data.code);
  return data as T;
}
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
export function youtubeId(input: string) {
  if (/^[A-Za-z0-9_-]{11}$/.test(input.trim())) return input.trim();
  try {
    const u = new URL(input);
    if (u.hostname === "youtu.be")
      return u.pathname.slice(1).match(/^[A-Za-z0-9_-]{11}$/)?.[0];
    if (
      ["youtube.com", "www.youtube.com", "m.youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com"].includes(u.hostname)
    )
      return (u.searchParams.get("v") || u.pathname.split("/")[2] || "").match(
        /^[A-Za-z0-9_-]{11}$/,
      )?.[0];
  } catch {
    /* Not a video URL. */
  }
  return undefined;
}
