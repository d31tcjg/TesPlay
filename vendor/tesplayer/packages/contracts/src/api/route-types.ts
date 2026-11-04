import type { z } from 'zod';

export type ApiAuth = 'public' | 'pairing-cookie' | 'owner';
export type ApiMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ApiResponseKind = 'json' | 'binary' | 'text-vtt';
export type ApiOriginPolicy = 'none' | 'exact-configured';

export interface ApiRouteContract {
  readonly id: string;
  readonly method: ApiMethod;
  readonly path: string;
  readonly auth: ApiAuth;
  readonly csrf: boolean;
  readonly originPolicy: ApiOriginPolicy;
  readonly localOnly: boolean;
  readonly successStatus: number;
  readonly responseKind: ApiResponseKind;
  readonly request: z.ZodType;
  readonly response: z.ZodType;
  readonly errors: readonly number[];
  readonly sensitiveFields?: readonly string[];
}
