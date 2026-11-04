import type { PlayerError } from '@canvas-stream-player/contracts';

const SECRET_NAME =
  /(?:access|auth|bearer|code|cookie|credential|csrf|key|password|secret|session|signature|token)/iu;
const SCHEME_URL =
  /\b(?:https?|ftp|file|data|blob|filesystem|gopher|smb|rtsp|wss?):\/\/[^\s"'<>]*/giu;
const PROTOCOL_RELATIVE_URL = /(^|[\s(])\/\/[^\s"'<>]*/gu;
const CAPABILITY_PATH =
  /\/api\/(?:v\d+\/)?media(?:\/sessions)?\/[A-Za-z0-9._~-]+(?:\/resources\/[A-Za-z0-9._~-]+)?(?:\?[^\s"'<>]*)?/giu;
const RELATIVE_QUERY = /(?:\.{0,2}\/|\/)?[A-Za-z0-9._~!$&'()*+,;=:@%/-]+\?[^\s"'<>]*/gu;
const AUTHORIZATION =
  /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-csrf-token)\s*[:=]\s*[^\r\n,;]*/giu;
const CREDENTIAL_SCHEME = /\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]*/giu;
const JWT = /\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}(?:\.[A-Za-z0-9_-]{2,})?/gu;
const ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_-]{0,40})=([^\s&,;]*)/gu;
const MAX_SAFE_TEXT_BYTES = 1024;
const MAX_SERIALIZATION_DEPTH = 4;
const MAX_SERIALIZATION_BRANCHES = 32;
const MAX_SERIALIZATION_NODES = 256;
export const MAX_SAFE_DIAGNOSTIC_BYTES = 8192;
const SERIALIZATION_WORK_BYTES = 6144;
const SAFE_ERROR_ROLES = new Set([
  'audio',
  'key',
  'manifest',
  'map',
  'media',
  'playlist',
  'rendition',
  'segment',
  'subtitle',
  'variant',
  'video',
]);

export type EngineErrorCode = PlayerError['code'];
export type SafeDiagnosticScalar = string | number | boolean | null;
export type SafeDiagnosticValue =
  | SafeDiagnosticScalar
  | readonly SafeDiagnosticValue[]
  | { readonly [key: string]: SafeDiagnosticValue };

interface SerializationBudget {
  bytes: number;
  nodes: number;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Length(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function redactText(value: string): string {
  return value
    .replace(SCHEME_URL, '[url]')
    .replace(PROTOCOL_RELATIVE_URL, '$1[url]')
    .replace(CAPABILITY_PATH, '[capability]')
    .replace(RELATIVE_QUERY, '[resource]?[redacted]')
    .replace(AUTHORIZATION, (match) => {
      const name = match.split(/[:=]/u, 1)[0];
      return `${name ?? 'credential'}=[redacted]`;
    })
    .replace(CREDENTIAL_SCHEME, (match) => {
      const scheme = match.split(/\s/u, 1)[0];
      return `${scheme ?? 'credential'} [redacted]`;
    })
    .replace(JWT, '[redacted-token]')
    .replace(ASSIGNMENT, (match, name: string) =>
      SECRET_NAME.test(name) ? `${name}=[redacted]` : match,
    )
    .replace(/\?[^\s"'<>]*/gu, '?[redacted]')
    .replace(/[\r\n\t]+/gu, ' ')
    .trim();
}

function boundedPublicText(value: string, maxBytes = MAX_SAFE_TEXT_BYTES): string {
  // Reject oversized input before regexp work or whole-string UTF-8 allocation.
  // Do not truncate first, since that could cut off a credential marker.
  if (value.length > MAX_SAFE_TEXT_BYTES * 4) return '[bounded]';
  return truncateUtf8(redactText(value), maxBytes);
}

function reserve(budget: SerializationBudget, value: string): boolean {
  const bytes = utf8Length(value);
  if (budget.nodes <= 0 || budget.bytes < bytes) return false;
  budget.nodes--;
  budget.bytes -= bytes;
  return true;
}

function boundedMarker(budget: SerializationBudget): string {
  const marker = '[bounded]';
  reserve(budget, JSON.stringify(marker));
  return marker;
}

function safeErrorMetadata(
  error: Error,
  budget: SerializationBudget,
): SafeDiagnosticValue {
  const result: Record<string, SafeDiagnosticValue> = {};
  Object.setPrototypeOf(result, null);
  if (error instanceof EngineFault) {
    result['type'] = 'engine-fault';
    result['code'] = error.code;
    result['fatal'] = error.fatal;
    result['retryable'] = error.retryable;
  } else if (error instanceof DOMException && error.name === 'TimeoutError') {
    result['type'] = 'dependency-error';
    result['category'] = 'timeout';
  } else if (error instanceof DOMException && error.name === 'AbortError') {
    result['type'] = 'dependency-error';
    result['category'] = 'aborted';
  } else {
    result['type'] = 'dependency-error';
    result['category'] = 'failure';
  }

  for (const name of ['status', 'statusCode'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(error, name);
    const status: unknown =
      descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof status === 'number') {
      result[name] = Number.isFinite(status) ? status : null;
    }
  }
  const roleDescriptor = Object.getOwnPropertyDescriptor(error, 'role');
  const role: unknown =
    roleDescriptor && 'value' in roleDescriptor ? roleDescriptor.value : undefined;
  if (typeof role === 'string' && SAFE_ERROR_ROLES.has(role)) result['role'] = role;
  const retryableDescriptor = Object.getOwnPropertyDescriptor(error, 'retryable');
  const retryable: unknown =
    retryableDescriptor && 'value' in retryableDescriptor
      ? retryableDescriptor.value
      : undefined;
  if (!(error instanceof EngineFault) && typeof retryable === 'boolean')
    result['retryable'] = retryable;

  reserve(budget, JSON.stringify(result));
  return result;
}

function safeUnknown(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  budget: SerializationBudget,
): SafeDiagnosticValue {
  if (budget.nodes <= 0 || budget.bytes <= 0) return boundedMarker(budget);
  if (value === null) {
    reserve(budget, 'null');
    return null;
  }
  if (typeof value === 'string') {
    const result = boundedPublicText(value);
    if (!reserve(budget, JSON.stringify(result))) return boundedMarker(budget);
    return result;
  }
  if (typeof value === 'number') {
    const result = Number.isFinite(value) ? value : null;
    reserve(budget, JSON.stringify(result));
    return result;
  }
  if (typeof value === 'boolean') {
    reserve(budget, JSON.stringify(value));
    return value;
  }
  if (typeof value === 'bigint') {
    const result = truncateUtf8(value.toString(), MAX_SAFE_TEXT_BYTES);
    if (!reserve(budget, JSON.stringify(result))) return boundedMarker(budget);
    return result;
  }
  if (
    typeof value === 'undefined' ||
    typeof value === 'symbol' ||
    typeof value === 'function'
  ) {
    reserve(budget, 'null');
    return null;
  }
  if (value instanceof Error) return safeErrorMetadata(value, budget);
  if (depth >= MAX_SERIALIZATION_DEPTH) return boundedMarker(budget);
  if (seen.has(value)) {
    const marker = '[circular]';
    reserve(budget, JSON.stringify(marker));
    return marker;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const items: unknown[] = value;
    const result: SafeDiagnosticValue[] = [];
    reserve(budget, '[]');
    for (
      let index = 0;
      index < items.length && index < MAX_SERIALIZATION_BRANCHES;
      index++
    ) {
      if (budget.nodes <= 0 || budget.bytes <= 0) {
        result.push(boundedMarker(budget));
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(items, String(index));
      if (!descriptor || !('value' in descriptor)) {
        reserve(budget, JSON.stringify('[unavailable]'));
        result.push('[unavailable]');
      } else {
        const item: unknown = descriptor.value;
        result.push(safeUnknown(item, seen, depth + 1, budget));
      }
    }
    if (items.length > MAX_SERIALIZATION_BRANCHES) result.push(boundedMarker(budget));
    return result;
  }

  const result: Record<string, SafeDiagnosticValue> = {};
  Object.setPrototypeOf(result, null);
  reserve(budget, '{}');
  let count = 0;
  for (const rawKey in value) {
    if (!Object.prototype.hasOwnProperty.call(value, rawKey)) continue;
    if (count >= MAX_SERIALIZATION_BRANCHES || budget.nodes <= 0 || budget.bytes <= 0) {
      result['bounded'] = '[bounded]';
      break;
    }
    count++;
    const key = boundedPublicText(rawKey, 128) || 'field';
    if (!reserve(budget, JSON.stringify(key))) {
      result['bounded'] = '[bounded]';
      break;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, rawKey);
    if (!descriptor || !('value' in descriptor)) {
      result[key] = '[unavailable]';
      continue;
    }
    const item: unknown = descriptor.value;
    result[key] = SECRET_NAME.test(rawKey)
      ? '[redacted]'
      : safeUnknown(item, seen, depth + 1, budget);
  }
  return result;
}

export function safeDiagnosticValue(value: unknown): SafeDiagnosticValue {
  const result = safeUnknown(value, new WeakSet<object>(), 0, {
    bytes: SERIALIZATION_WORK_BYTES,
    nodes: MAX_SERIALIZATION_NODES,
  });
  return utf8Length(JSON.stringify(result)) <= MAX_SAFE_DIAGNOSTIC_BYTES
    ? result
    : '[bounded]';
}

export class EngineFault extends Error {
  readonly code: EngineErrorCode;
  readonly fatal: boolean;
  readonly retryable: boolean;
  readonly safeCause: string | null;

  constructor(
    code: EngineErrorCode,
    message: string,
    options: {
      fatal?: boolean;
      retryable?: boolean;
      safeCause?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(safePublicText(message), { cause: options.cause });
    this.name = 'EngineFault';
    this.code = code;
    this.fatal = options.fatal ?? true;
    this.retryable = options.retryable ?? false;
    this.safeCause = options.safeCause ? safePublicText(options.safeCause) : null;
  }
}

export function safePublicText(
  value: unknown,
  fallback = 'Playback operation failed',
): string {
  let initial: string;
  if (typeof value === 'string') initial = value;
  else {
    try {
      initial = JSON.stringify(safeDiagnosticValue(value));
    } catch {
      initial = '';
    }
  }
  const safe = boundedPublicText(initial);
  return safe || fallback;
}

/**
 * Dependency messages are not a public interface. Return only closed, static
 * classifications; the original error remains available as Error.cause.
 */
export function safeErrorCause(error: unknown): string {
  if (error instanceof EngineFault) return `Engine fault: ${error.code}`;
  if (error instanceof DOMException) {
    if (error.name === 'TimeoutError') return 'Dependency deadline expired';
    if (error.name === 'AbortError') return 'Dependency operation aborted';
  }
  return 'Dependency failure';
}

export function engineFault(
  error: unknown,
  fallbackCode: EngineErrorCode,
  fallbackMessage: string,
): EngineFault {
  if (error instanceof EngineFault) return error;
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new EngineFault('NETWORK_TIMEOUT', 'Network operation timed out', {
      retryable: true,
      safeCause: 'Configured deadline expired',
      cause: error,
    });
  }
  return new EngineFault(fallbackCode, fallbackMessage, {
    safeCause: safeErrorCause(error),
    cause: error,
  });
}

export function abortError(message = 'Operation aborted'): DOMException {
  return new DOMException(message, 'AbortError');
}

export function timeoutError(message = 'Operation timed out'): DOMException {
  return new DOMException(message, 'TimeoutError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
