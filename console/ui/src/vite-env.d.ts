/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the console API. Defaults to `/api` — a relative path, so the
   * SPA and the API are same-origin and no CORS is involved. In dev that path is
   * proxied to a local API by `vite.config.ts`; in production it expects the API
   * to be reachable under the same host (e.g. a `/api/*` CloudFront behaviour
   * pointing at the HTTP API).
   *
   * Set it to an absolute URL — the `api_endpoint` Terraform output — to talk to
   * a deployed API directly instead. That is cross-origin, so the API needs CORS
   * configured, which it currently does not have.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
