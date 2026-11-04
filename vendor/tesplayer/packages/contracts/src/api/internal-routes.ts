import { z } from 'zod';

import { EmptyResponseSchema, IdSchema, OpaqueSecretTokenSchema } from '../common.js';

import type { ApiMethod, ApiResponseKind } from './route-types.js';

import type { CapabilityAudienceSchema } from './internal.js';
import {
  BrokerFetchControlSchema,
  BrokerResourceCloneSchema,
  BrokerResourceRegistrationResultSchema,
  BrokerResourceRegistrationSchema,
  CancellationRequestSchema,
  CompatibilityWorkerJobRequestSchema,
  ResolverJobRequestSchema,
  ResolverJobStatusSchema,
  WorkerJobStatusSchema,
  WorkerOutputFetchControlSchema,
} from './internal.js';

export const INTERNAL_SERVICE_BINDINGS = {
  api: {
    port: 3000,
    publishedHost: '127.0.0.1',
    bootstrapPeerPolicy: 'explicit-config',
    bootstrapNetworkIpMasquerade: false,
  },
  broker: { workerPort: 7301, controlSocket: '/run/csp-broker/control.sock' },
  worker: { controlSocket: '/run/csp-worker/control.sock' },
  resolver: { controlSocket: '/run/csp-resolver/control.sock' },
  resolverEgress: { proxyPort: 7304, dnsPort: 53 },
} as const;

export type InternalTransport = 'unix' | 'http';
export interface InternalRouteContract {
  readonly id: string;
  readonly method: ApiMethod;
  readonly path: string;
  readonly transport: InternalTransport;
  readonly socket?: string;
  readonly port?: number;
  readonly audience: z.infer<typeof CapabilityAudienceSchema>;
  readonly request: z.ZodType;
  readonly response: z.ZodType;
  readonly responseKind: ApiResponseKind;
  readonly sensitiveFields?: readonly string[];
}

const bearerHeaders = z
  .object({ authorization: z.string().regex(/^Bearer [A-Za-z0-9_-]{43,512}$/u) })
  .loose();
const internalParams = (fields: Record<string, z.ZodType>) =>
  z.object({ params: z.object(fields).strict(), headers: bearerHeaders }).strict();
const workerStatusParams = internalParams({ jobId: IdSchema });

export const INTERNAL_API_ROUTES = [
  {
    id: 'broker.resources.register',
    method: 'POST',
    path: '/internal/v1/broker/resources',
    transport: 'unix',
    socket: INTERNAL_SERVICE_BINDINGS.broker.controlSocket,
    audience: 'api-broker-control',
    request: z
      .object({ headers: bearerHeaders, body: BrokerResourceRegistrationSchema })
      .strict(),
    response: BrokerResourceRegistrationResultSchema,
    responseKind: 'json',
    sensitiveFields: [
      'headers.authorization',
      'body.resourceId',
      'body.rootResourceId',
      'body.upstreamUrl',
      'body.credentials',
      'body.workerBinding.capability.token',
    ],
  },
  {
    id: 'broker.resources.clone',
    method: 'POST',
    path: '/internal/v1/broker/resources/:resourceId/clone',
    transport: 'unix',
    socket: INTERNAL_SERVICE_BINDINGS.broker.controlSocket,
    audience: 'api-broker-control',
    request: z
      .object({
        params: z.object({ resourceId: OpaqueSecretTokenSchema }).strict(),
        headers: bearerHeaders,
        body: BrokerResourceCloneSchema,
      })
      .strict(),
    response: BrokerResourceRegistrationResultSchema,
    responseKind: 'json',
    sensitiveFields: [
      'headers.authorization',
      'params.resourceId',
      'body.newResourceId',
      'body.workerBinding.capability.token',
    ],
  },
  {
    id: 'broker.resources.fetch-control',
    method: 'POST',
    path: '/internal/v1/broker/resources/:resourceId/fetch',
    transport: 'unix',
    socket: INTERNAL_SERVICE_BINDINGS.broker.controlSocket,
    audience: 'api-broker-control',
    request: z
      .object({
        params: z.object({ resourceId: OpaqueSecretTokenSchema }).strict(),
        headers: bearerHeaders,
        body: BrokerFetchControlSchema,
      })
      .strict(),
    response: z.unknown(),
    responseKind: 'binary',
    sensitiveFields: ['headers.authorization', 'params.resourceId'],
  },
  {
    id: 'broker.generations.cancel',
    method: 'DELETE',
    path: '/internal/v1/broker/generations/:generationId',
    transport: 'unix',
    socket: INTERNAL_SERVICE_BINDINGS.broker.controlSocket,
    audience: 'api-broker-control',
    request: z
      .object({
        params: z.object({ generationId: IdSchema }).strict(),
        headers: bearerHeaders,
        body: CancellationRequestSchema,
      })
      .strict(),
    response: EmptyResponseSchema,
    responseKind: 'json',
    sensitiveFields: ['headers.authorization'],
  },
  {
    id: 'broker.worker.fetch',
    method: 'GET',
    path: '/internal/v1/broker/jobs/:jobId/resources/:resourceId',
    transport: 'http',
    port: INTERNAL_SERVICE_BINDINGS.broker.workerPort,
    audience: 'worker-broker-input',
    request: z
      .object({
        params: z
          .object({ jobId: IdSchema, resourceId: OpaqueSecretTokenSchema })
          .strict(),
        headers: bearerHeaders.extend({ range: z.string().max(256).optional() }),
      })
      .strict(),
    response: z.unknown(),
    responseKind: 'binary',
    sensitiveFields: ['headers.authorization', 'params.resourceId'],
  },
  {
    id: 'broker.worker.head',
    method: 'HEAD',
    path: '/internal/v1/broker/jobs/:jobId/resources/:resourceId',
    transport: 'http',
    port: INTERNAL_SERVICE_BINDINGS.broker.workerPort,
    audience: 'worker-broker-input',
    request: internalParams({
      jobId: IdSchema,
      resourceId: OpaqueSecretTokenSchema,
    }),
    response: z.unknown(),
    responseKind: 'binary',
    sensitiveFields: ['headers.authorization', 'params.resourceId'],
  },
  {
    id: 'worker.jobs.create',
    method: 'POST',
    path: '/internal/v1/worker/jobs',
    transport: 'unix',
    socket: INTERNAL_SERVICE_BINDINGS.worker.controlSocket,
    audience: 'api-worker-control',
    request: z
      .object({ headers: bearerHeaders, body: CompatibilityWorkerJobRequestSchema })
      .strict(),
    response: WorkerJobStatusSchema,
    responseKind: 'json',
    sensitiveFields: ['headers.authorization', 'body.inputs', 'response.outputId'],
  },
  {
    id: 'worker.jobs.get',
    method: 'GET',
    path: '/internal/v1/worker/jobs/:jobId',
    transport: 'unix',
    socket: INTERNAL_SERVICE_BINDINGS.worker.controlSocket,
    audience: 'api-worker-control',
    request: workerStatusParams,
    response: WorkerJobStatusSchema,
    responseKind: 'json',
    sensitiveFields: ['headers.authorization', 'response.outputId'],
  },
  {
    id: 'worker.jobs.cancel',
    method: 'DELETE',
    path: '/internal/v1/worker/jobs/:jobId',
    transport: 'unix',
    socket: INTERNAL_SERVICE_BINDINGS.worker.controlSocket,
    audience: 'api-worker-control',
    request: z
      .object({
        params: z.object({ jobId: IdSchema }).strict(),
        headers: bearerHeaders,
        body: CancellationRequestSchema,
      })
      .strict(),
    response: WorkerJobStatusSchema,
    responseKind: 'json',
    sensitiveFields: ['headers.authorization', 'response.outputId'],
  },
  {
    id: 'worker.outputs.fetch',
    method: 'POST',
    path: '/internal/v1/worker/jobs/:jobId/outputs/:outputId/fetch',
    transport: 'unix',
    socket: INTERNAL_SERVICE_BINDINGS.worker.controlSocket,
    audience: 'api-worker-control',
    request: z
      .object({
        params: z.object({ jobId: IdSchema, outputId: OpaqueSecretTokenSchema }).strict(),
        headers: bearerHeaders,
        body: WorkerOutputFetchControlSchema,
      })
      .strict(),
    response: z.unknown(),
    responseKind: 'binary',
    sensitiveFields: ['headers.authorization', 'params.outputId'],
  },
  {
    id: 'resolver.jobs.create',
    method: 'POST',
    path: '/internal/v1/resolver/jobs',
    transport: 'unix',
    socket: INTERNAL_SERVICE_BINDINGS.resolver.controlSocket,
    audience: 'api-resolver-control',
    request: z
      .object({ headers: bearerHeaders, body: ResolverJobRequestSchema })
      .strict(),
    response: ResolverJobStatusSchema,
    responseKind: 'json',
    sensitiveFields: [
      'headers.authorization',
      'body.input',
      'body.capability.token',
      'response.result.resources',
    ],
  },
  {
    id: 'resolver.jobs.get',
    method: 'GET',
    path: '/internal/v1/resolver/jobs/:jobId',
    transport: 'unix',
    socket: INTERNAL_SERVICE_BINDINGS.resolver.controlSocket,
    audience: 'api-resolver-control',
    request: workerStatusParams,
    response: ResolverJobStatusSchema,
    responseKind: 'json',
    sensitiveFields: ['headers.authorization', 'response.result.resources'],
  },
  {
    id: 'resolver.jobs.cancel',
    method: 'DELETE',
    path: '/internal/v1/resolver/jobs/:jobId',
    transport: 'unix',
    socket: INTERNAL_SERVICE_BINDINGS.resolver.controlSocket,
    audience: 'api-resolver-control',
    request: z
      .object({
        params: z.object({ jobId: IdSchema }).strict(),
        headers: bearerHeaders,
        body: CancellationRequestSchema,
      })
      .strict(),
    response: ResolverJobStatusSchema,
    responseKind: 'json',
    sensitiveFields: ['headers.authorization', 'response.result.resources'],
  },
] as const satisfies readonly InternalRouteContract[];
