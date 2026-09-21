import type { Principal } from "./lib/principal.js";

/** The framework-agnostic request the router and handlers operate on. */
export interface ApiRequest {
  method: string;
  path: string;
  /** Path params extracted by the router, e.g. `{ targetId, host }`. */
  params: Record<string, string>;
  query: Record<string, string>;
  /** Lowercased header names. */
  headers: Record<string, string>;
  /** Parsed JSON body, or `undefined` when there is no body. */
  body: unknown;
  /**
   * Who is asking, from the gateway's verified JWT claims. Absent on the public
   * routes, and absent nowhere else — the router refuses a protected route with
   * no principal rather than dispatching it.
   */
  principal?: Principal;
}

/** What a handler returns; `handler.ts` serializes it to the Lambda result. */
export interface ApiResponse {
  status: number;
  body: unknown;
  /**
   * `Set-Cookie` values. API Gateway v2 carries these in their own array rather
   * than in `headers`, because a headers map cannot hold two of the same key and
   * a response may legitimately set more than one cookie.
   *
   * Only the auth routes use this: it is how the refresh token reaches the
   * browser without passing through JavaScript.
   */
  cookies?: string[];
}

export type Handler = (req: ApiRequest) => ApiResponse | Promise<ApiResponse>;
