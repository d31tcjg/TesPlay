import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

const scrypt = promisify(scryptCallback);
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = "aperture_session";
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}
export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}
export function constantTimeEqual(first, second) {
  const a = createHash("sha256")
    .update(String(first ?? ""))
    .digest();
  const b = createHash("sha256")
    .update(String(second ?? ""))
    .digest();
  return timingSafeEqual(a, b);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$32768$8$1$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  if (
    typeof password !== "string" ||
    password.length > 256 ||
    typeof stored !== "string"
  )
    return false;
  const [algorithm, n, r, p, saltHex, derivedHex] = stored.split("$");
  if (
    algorithm !== "scrypt" ||
    n !== "32768" ||
    r !== "8" ||
    p !== "1" ||
    !/^[a-f0-9]{32}$/.test(saltHex ?? "") ||
    !/^[a-f0-9]{128}$/.test(derivedHex ?? "")
  )
    return false;
  const derived = await scrypt(
    password,
    Buffer.from(saltHex, "hex"),
    64,
    SCRYPT_OPTIONS,
  );
  return timingSafeEqual(derived, Buffer.from(derivedHex, "hex"));
}

export function loadEncryptionKey(dataDir, providedKey) {
  if (providedKey) {
    if (!/^[a-fA-F0-9]{64}$/.test(providedKey))
      throw new Error(
        "ENCRYPTION_KEY must contain exactly 64 hexadecimal characters.",
      );
    return Buffer.from(providedKey, "hex");
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = resolve(dataDir, "encryption.key");
  try {
    writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath);
  if (key.length !== 32)
    throw new Error(
      "The saved encryption key is invalid. Restore the original key from your backup.",
    );
  return key;
}

export function encryptJSON(value, key, scope) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(scope));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
    "base64",
  );
}

export function decryptJSON(value, key, scope) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 29) throw new Error("Encrypted data is incomplete.");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(scope));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8"),
  );
}

export function validateEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw httpError(400, "Enter a valid email address.");
  return email;
}

export function cleanText(value, label, maxLength = 80) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maxLength
  )
    throw httpError(
      400,
      `${label} must contain between 1 and ${maxLength} characters.`,
    );
  return value.trim();
}

export function validatePassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 256)
    throw httpError(400, "Use a password between 12 and 256 characters.");
  return value;
}

export function csrfProtection({ publicUrl, production }) {
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : null;
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const videoChunk = req.method === "PUT" && /^\/remote\/media\/upload\/remote-[a-f0-9-]+$/.test(req.path) && req.is("application/octet-stream");
    if (!req.is("application/json") && !videoChunk)
      return next(httpError(415, "Send requests as application/json."));
    const origin = req.get("origin");
    const allowed = new Set([
      publicOrigin || `${req.protocol}://${req.get("host")}`,
    ]);
    if (!production) {
      allowed.add("http://127.0.0.1:5173");
      allowed.add("http://localhost:5173");
    }
    if (
      (origin && !allowed.has(origin)) ||
      (!origin && req.get("sec-fetch-site") === "cross-site")
    )
      return next(
        httpError(403, "This request came from an untrusted website."),
      );
    next();
  };
}

export function cookieOptions(req, publicUrl) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(publicUrl?.startsWith("https:") || req.secure),
    path: "/",
    maxAge: SESSION_LIFETIME_MS,
  };
}

export function validateMediaItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw httpError(400, "A media item is required.");
  const types = [
    "movie",
    "series",
    "episode",
    "live",
    "folder",
    "video",
    "audio",
  ];
  const item = {
    id: cleanText(value.id, "Media ID", 2048),
    title: cleanText(value.title, "Media title", 300),
    type: value.type,
    source: cleanText(value.source, "Media source", 100),
  };
  if (!types.includes(item.type))
    throw httpError(400, "This media type is not supported.");
  for (const field of [
    "connectionId",
    "poster",
    "backdrop",
    "description",
    "year",
    "category",
    "categoryLabel",
    "accessCategory",
    "playbackUrl",
    "externalUrl",
    "subtitle",
    "seriesId",
    "channelId",
    "publishedAt",
    "addedAt",
    "providerType",
    "contentKind",
    "sectionId",
    "artwork",
  ]) {
    if (value[field] == null) continue;
    if (
      typeof value[field] !== "string" ||
      value[field].length > (field === "description" ? 6000 : 3000)
    )
      throw httpError(400, `Invalid media ${field}.`);
    item[field] = value[field];
  }
  for (const field of ["poster", "backdrop", "playbackUrl", "externalUrl"]) {
    if (
      item[field] &&
      !/^https?:\/\//i.test(item[field]) &&
      !/^\/(?!\/)/.test(item[field])
    )
      throw httpError(400, `Invalid media ${field} URL.`);
  }
  if (value.duration != null) {
    if (
      !Number.isFinite(value.duration) ||
      value.duration < 0 ||
      value.duration > 604800
    )
      throw httpError(400, "Invalid media duration.");
    item.duration = value.duration;
  }
  for (const field of ["seasonNumber", "episodeNumber"]) {
    if (value[field] == null) continue;
    if (
      !Number.isInteger(value[field]) ||
      value[field] < 0 ||
      value[field] > 1_000_000
    )
      throw httpError(400, `Invalid media ${field}.`);
    item[field] = value[field];
  }
  if(value.watched != null) { if(typeof value.watched !== "boolean") throw httpError(400,"Invalid watched status."); item.watched=value.watched; }
  return item;
}
