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
}

/** What a handler returns; `handler.ts` serializes it to the Lambda result. */
export interface ApiResponse {
  status: number;
  body: unknown;
}

export type Handler = (req: ApiRequest) => ApiResponse | Promise<ApiResponse>;
