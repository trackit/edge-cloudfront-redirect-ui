import type { ApiErrorCode, ValidationDetail } from "./types";

/**
 * Codes the client raises itself, for failures that never reached the API or
 * came back in a shape it does not define. Kept distinct from `ApiErrorCode` so
 * a `switch` over server codes stays exhaustive.
 */
export type ClientErrorCode = "NETWORK_ERROR" | "MALFORMED_RESPONSE";

/**
 * Any failed call. `status` is 0 when the request never got a response.
 *
 * Callers should branch on `code`, not `message`: the codes are a closed set the
 * API commits to, while messages are prose and change freely.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | ClientErrorCode;
  readonly details: ValidationDetail[];

  constructor(init: {
    status: number;
    code: ApiErrorCode | ClientErrorCode;
    message: string;
    details?: ValidationDetail[];
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? [];
  }

  /** True when the failure is per-field and `details` is worth rendering. */
  get isValidation(): boolean {
    return this.code === "VALIDATION_ERROR";
  }
}

/**
 * Reads the API's `{ error: { code, message, details? } }` envelope out of a
 * parsed body.
 *
 * A non-2xx is not guaranteed to carry it — API Gateway's own 4xx/5xx pages, a
 * proxy, or an HTML error page all arrive here too — so anything that does not
 * match the shape becomes MALFORMED_RESPONSE with the status preserved, rather
 * than a crash on `body.error.code`.
 */
export const toApiError = (status: number, body: unknown): ApiError => {
  if (typeof body === "object" && body !== null && "error" in body) {
    const { error } = body as { error: unknown };
    if (typeof error === "object" && error !== null) {
      const { code, message, details } = error as Record<string, unknown>;
      if (typeof code === "string" && typeof message === "string") {
        return new ApiError({
          status,
          code: code as ApiErrorCode,
          message,
          details: Array.isArray(details)
            ? (details as ValidationDetail[])
            : undefined,
        });
      }
    }
  }

  return new ApiError({
    status,
    code: "MALFORMED_RESPONSE",
    message: `Request failed with status ${status}`,
  });
};
