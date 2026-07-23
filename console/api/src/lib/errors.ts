import type { ApiResponse } from "../context.js";

/**
 * A failure with an HTTP status and a stable `code` the SPA can switch on.
 * Anything thrown from a handler that is an `ApiError` becomes a standardized
 * error response; anything else becomes a 500.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
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
