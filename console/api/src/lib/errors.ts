import type { ApiResponse } from "../context.js";

/**
 * Every error code the API can return. This is the contract the SPA switches on,
 * so it is a closed set rather than free-form strings: a typo fails to compile,
 * and `openapi-error-codes.test.ts` fails if the OpenAPI `code` enum drifts from
 * this list. Add a code here first, then to the spec.
 */
export const ERROR_CODES = [
  "BAD_REQUEST",
  "HOST_EXISTS",
  "INTERNAL",
  "INVALID_JSON",
  "METHOD_NOT_ALLOWED",
  "NOT_FOUND",
  "RULE_EXISTS",
  "TARGET_EXISTS",
  "TARGET_UNREACHABLE",
  "UNKNOWN_TARGET",
  "VALIDATION_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * A failure with an HTTP status and a stable `code` the SPA can switch on.
 * Anything thrown from a handler that is an `ApiError` becomes a standardized
 * error response; anything else becomes a 500.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toResponse(): ApiResponse {
    return {
      status: this.status,
      body: {
        error: {
          code: this.code,
          message: this.message,
          ...(this.details !== undefined ? { details: this.details } : {}),
        },
      },
    };
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, "NOT_FOUND", message);
  }

  static methodNotAllowed(message: string): ApiError {
    return new ApiError(405, "METHOD_NOT_ALLOWED", message);
  }
}
