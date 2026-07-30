import type { ApiResponse } from "../context.js";

/** Build a JSON response. Serialization to the Lambda result happens once, in `handler.ts`. */
export const json = (status: number, body: unknown): ApiResponse => ({
  status,
  body,
});
