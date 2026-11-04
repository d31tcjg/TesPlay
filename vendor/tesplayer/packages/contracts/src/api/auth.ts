import { z } from 'zod';

import {
  Base64UrlSha256Schema,
  CONTRACT_FREEZE_VERSION,
  IdSchema,
  OpaqueSecretTokenSchema,
  PasswordSchema,
  SafeOriginSchema,
  Sha256Schema,
  TimestampSchema,
} from '../common.js';

const canonicalIpv4Address = (value: string) => {
  const octets = value.split('.');
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => /^(?:0|[1-9][0-9]{0,2})$/u.test(octet) && Number(octet) <= 255,
    )
  );
};
const privateIpv4Address = (value: string) => {
  if (!canonicalIpv4Address(value)) return false;
  const octets = value.split('.').map(Number);
  const first = octets[0];
  const second = octets[1];
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

export const PairingModeSchema = z.enum([
  'disabled',
  'same-device-loopback',
  'cross-device-https',
]);

export const DeviceDescriptorSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    kind: z.enum(['desktop', 'mobile', 'tablet', 'vehicle-browser', 'unknown']),
    fingerprint: z.string().min(16).max(256),
  })
  .strict();

export const DeviceSchema = DeviceDescriptorSchema.extend({
  id: IdSchema,
  publicKeyThumbprint: Base64UrlSha256Schema.nullable(),
  createdAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  current: z.boolean(),
  revokedAt: TimestampSchema.nullable(),
}).strict();

export const OwnerSessionSchema = z
  .object({
    authenticated: z.boolean(),
    owner: z.object({ id: IdSchema, displayName: z.string().min(1).max(128) }).nullable(),
    device: DeviceSchema.nullable(),
    expiresAt: TimestampSchema.nullable(),
  })
  .strict();

export const SetupStatusSchema = z
  .object({
    initialized: z.boolean(),
    localRequest: z.boolean(),
    ownerCount: z.number().int().min(0).max(1),
  })
  .strict();

export const SetupOwnerRequestSchema = z
  .object({
    bootstrapToken: OpaqueSecretTokenSchema,
    displayName: z.string().trim().min(1).max(128),
    password: PasswordSchema,
    device: DeviceDescriptorSchema,
  })
  .strict();

export const BootstrapIngressConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('native-loopback') }).strict(),
  z
    .object({
      mode: z.literal('docker-published-loopback'),
      publishedHost: z.literal('127.0.0.1'),
      networkName: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/u),
      trustedPeerAddress: z.string().refine(privateIpv4Address, {
        message: 'Expected a canonical RFC 1918 IPv4 bridge gateway address',
      }),
    })
    .strict(),
]);

export const LoginRequestSchema = z
  .object({
    password: z
      .string()
      .min(1)
      .refine((value) => new TextEncoder().encode(value).length <= 1024),
    device: DeviceDescriptorSchema,
  })
  .strict();

export const PasswordChangeRequestSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1)
      .refine((value) => new TextEncoder().encode(value).length <= 1024),
    newPassword: PasswordSchema,
  })
  .strict();

export const CsrfTokenSchema = z
  .object({
    token: OpaqueSecretTokenSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

export const PairingPublicKeyJwkSchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    y: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    ext: z.literal(true),
    key_ops: z.tuple([z.literal('verify')]),
  })
  .strict();

export const PairingCreateRequestSchema = z
  .object({
    device: DeviceDescriptorSchema,
    publicKey: PairingPublicKeyJwkSchema,
    browserNonce: OpaqueSecretTokenSchema,
    intendedOrigin: SafeOriginSchema,
  })
  .strict();

export const PairingStateSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'expired',
  'consumed',
]);

export const PairingChallengeSchema = z
  .object({
    fragmentToken: OpaqueSecretTokenSchema,
    publicKeyThumbprint: Base64UrlSha256Schema,
    contextFingerprint: Sha256Schema,
    displayFingerprint: z.string().regex(/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}$/u),
    expiresAt: TimestampSchema,
    pollAfterMs: z.number().int().min(1000).max(10_000),
    state: z.literal('pending'),
  })
  .strict();

export const PairingTokenRequestSchema = z
  .object({ fragmentToken: OpaqueSecretTokenSchema })
  .strict();

export const PairingStatusSchema = z
  .object({
    state: PairingStateSchema,
    expiresAt: TimestampSchema,
    pollAfterMs: z.number().int().min(1000).max(10_000),
  })
  .strict();

export const PairingApprovalContextSchema = z
  .object({
    device: DeviceDescriptorSchema.pick({ name: true, kind: true }),
    createdAt: TimestampSchema,
    intendedOrigin: SafeOriginSchema,
    publicKeyThumbprint: Base64UrlSha256Schema,
    contextFingerprint: Sha256Schema,
    displayFingerprint: z.string().regex(/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}$/u),
    requestContext: z.enum(['same-device-loopback', 'cross-device-https']),
    expiresAt: TimestampSchema,
  })
  .strict();

export const PairingDecisionRequestSchema = z
  .object({
    fragmentToken: OpaqueSecretTokenSchema,
    contextFingerprint: Sha256Schema,
  })
  .strict();

export const PairingFinalizeNonceSchema = z
  .object({
    nonce: OpaqueSecretTokenSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

export const PairingFinalizeRequestSchema = z
  .object({
    fragmentToken: OpaqueSecretTokenSchema,
    serverNonce: OpaqueSecretTokenSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
  })
  .strict();

export const PairingFinalizeTranscriptSchema = z
  .object({
    version: z.literal(CONTRACT_FREEZE_VERSION),
    purpose: z.literal('pairing-finalize'),
    fragmentToken: OpaqueSecretTokenSchema,
    serverNonce: OpaqueSecretTokenSchema,
    origin: SafeOriginSchema,
    publicKeyThumbprint: Base64UrlSha256Schema,
  })
  .strict();

export const serializePairingFinalizeTranscript = (
  input: z.input<typeof PairingFinalizeTranscriptSchema>,
): Uint8Array<ArrayBuffer> => {
  const value = PairingFinalizeTranscriptSchema.parse(input);
  const serialized =
    `{"version":${JSON.stringify(value.version)}` +
    `,"purpose":${JSON.stringify(value.purpose)}` +
    `,"fragmentToken":${JSON.stringify(value.fragmentToken)}` +
    `,"serverNonce":${JSON.stringify(value.serverNonce)}` +
    `,"origin":${JSON.stringify(value.origin)}` +
    `,"publicKeyThumbprint":${JSON.stringify(value.publicKeyThumbprint)}}`;
  return new TextEncoder().encode(serialized);
};

export type BootstrapIngressConfig = z.infer<typeof BootstrapIngressConfigSchema>;

export type Device = z.infer<typeof DeviceSchema>;

export type OwnerSession = z.infer<typeof OwnerSessionSchema>;

export type PairingChallenge = z.infer<typeof PairingChallengeSchema>;
