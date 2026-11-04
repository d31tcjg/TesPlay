import { api, ApiError, tesPlayFetch } from "./api";
import type { MediaItem } from "./types";
import formats from "../shared/video-formats.json" with { type: "json" };

export const MAX_PHONE_VIDEO_BYTES = 1024 * 1024 * 1024;
export const PHONE_VIDEO_ACCEPT =
  "video/*," + [...formats.direct, ...formats.convert, ...formats.playlists].join(",");

type PreparedVideo = { item: MediaItem; preparing?: boolean };

async function removeTemporaryVideo(id: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await api(`/remote/media/${encodeURIComponent(id)}`, {}, "DELETE");
      return;
    } catch (reason) {
      if (!(reason instanceof ApiError) || reason.status !== 409) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function waitForVideo(
  prepared: PreparedVideo,
  signal: AbortSignal,
  onPreparing: (message: string) => void,
): Promise<MediaItem> {
  if (!prepared.preparing) return prepared.item;
  onPreparing("Preparing video for your browser…");
  for (;;) {
    signal.throwIfAborted();
    const value = await api<{ item: MediaItem; status: string; message?: string }>(
      `/remote/media/${encodeURIComponent(prepared.item.id)}/status`,
      undefined, undefined, signal,
    );
    if (value.status === "ready") return value.item;
    if (value.status === "failed") throw new Error(value.message || "The video could not be prepared.");
    onPreparing(value.message || "Preparing video for your browser…");
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

export async function linkRemoteVideo(
  input: { roomId: string; url: string; title?: string; compatibility?: boolean },
  signal: AbortSignal,
  onPreparing: (message: string) => void,
): Promise<MediaItem> {
  const prepared = await api<PreparedVideo>("/remote/media/link", input, undefined, signal);
  try {
    return await waitForVideo(prepared, signal, onPreparing);
  } catch (error) {
    await removeTemporaryVideo(prepared.item.id);
    throw error;
  }
}

/** Send bounded chunks so large phone videos also work through the HTTPS tunnel. */
export async function uploadPhoneVideo(
  file: File,
  roomId: string,
  signal: AbortSignal,
  onProgress: (received: number) => void,
  options: { compatibility?: boolean; onPreparing?: (message: string) => void } = {},
): Promise<MediaItem> {
  if (!file.size || file.size > MAX_PHONE_VIDEO_BYTES)
    throw new Error("Choose a video between 1 byte and 1 GB.");
  const extension = "." + file.name.split(".").at(-1)?.toLowerCase();
  if (![...formats.direct, ...formats.convert, ...formats.playlists].includes(extension))
    throw new Error("Choose a video such as MP4, MOV, MKV, WebM, AVI, WMV, FLV, MPEG, 3GP or an HLS playlist.");
  if (formats.playlists.includes(extension) && file.size > 2 * 1024 * 1024)
    throw new Error("HLS playlists can be up to 2 MB. Paste the hosted playlist link instead.");
  let uploadId = "";
  try {
    const upload = await api<{ uploadId: string; chunkBytes: number }>(
      "/remote/media/upload",
      { roomId, name: file.name, size: file.size, compatibility: options.compatibility },
      undefined,
      signal,
    );
    uploadId = upload.uploadId;
    if (
      !Number.isSafeInteger(upload.chunkBytes) ||
      upload.chunkBytes < 1 ||
      upload.chunkBytes > 4 * 1024 * 1024
    )
      throw new Error("The server returned an invalid upload size.");
    onProgress(0);
    for (let offset = 0; offset < file.size;) {
      signal.throwIfAborted();
      const chunk = file.slice(
        offset,
        Math.min(offset + upload.chunkBytes, file.size),
      );
      const response = await tesPlayFetch(
        `/api/remote/media/upload/${encodeURIComponent(uploadId)}?${new URLSearchParams({ roomId, offset: String(offset) })}`,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/octet-stream" },
          body: chunk,
          signal,
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new ApiError(
          result.error || "The video upload failed. Try again.",
          response.status,
        );
      if (result.received !== offset + chunk.size)
        throw new Error("The upload position changed. Select the video again.");
      offset = result.received;
      onProgress(offset);
    }
    const prepared = await api<PreparedVideo>(
      `/remote/media/upload/${encodeURIComponent(uploadId)}/complete`,
      { roomId },
      undefined,
      signal,
    );
    return await waitForVideo(prepared, signal, options.onPreparing || (() => {}));
  } catch (error) {
    if (uploadId) {
      await removeTemporaryVideo(uploadId);
    }
    throw error;
  }
}
