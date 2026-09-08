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

  /**
   * Hosted UI base URL, e.g.
   * `https://edgeroute-dev.auth.us-east-1.amazoncognito.com`. Set by the
   * `console/ui/infra` apply from `console/api/infra`'s `cognito_domain`
   * output. Optional here because it is absent in dev until a pool exists;
   * `authConfig()` is what refuses to run without it.
   */
  readonly VITE_COGNITO_DOMAIN?: string;

  /**
   * The Cognito app client the console presents as, from the same stack's
   * `user_pool_client_id` output. Not a secret — it is in every authorize URL.
   */
  readonly VITE_COGNITO_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
