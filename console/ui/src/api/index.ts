/**
 * Typed client for the console API.
 *
 * Types are generated from `console/api/openapi.yaml` into `schema.gen.ts` by
 * `npm run generate:api -w console/ui`. That file is committed and must not be
 * edited by hand — regenerate it whenever the spec or the shared rule schemas
 * change.
 *
 *   import { api, ApiError } from "./api";
 *
 *   try {
 *     const rules = await api.rules.list(targetId, "www.example.com");
 *   } catch (e) {
 *     if (e instanceof ApiError && e.isValidation) render(e.details);
 *   }
 */
export { api, createApiClient, setAuthTokenProvider } from "./client";
export type { ApiClient, ApiClientOptions } from "./client";
export { ApiError, toApiError } from "./error";
export type { ClientErrorCode } from "./error";
export * from "./types";
