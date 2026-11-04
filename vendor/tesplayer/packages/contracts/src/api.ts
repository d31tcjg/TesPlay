// Keep the package API stable while domain modules own their schemas and routes.
export * from './api/auth.js';
export * from './api/sources.js';
export * from './api/playback.js';
export * from './api/diagnostics.js';
export * from './api/runtime.js';
export type * from './api/route-types.js';
export * from './api/routes.js';
export * from './api/internal.js';
export * from './api/internal-routes.js';
export { ApiErrorSchema as API_ERROR_SCHEMA } from './common.js';
