import { ApiError } from "./errors.js";
import type { ValidationDetail } from "./ajv-errors.js";

/**
 * Refuses a rewrite whose origin carries a custom header CloudFront will not
 * add to an origin request.
 *
 * The edge hands `customHeaders` to CloudFront as part of the origin, and
 * CloudFront validates it on every request: one refused name turns each request
 * the rule matches into a 502 (LambdaValidationError). The console never edits
 * these headers, so the rules that carry them come from imports, curl, or the
 * table itself — which is why the check lives here and not in the form.
 *
 * Not in the schema because header names are case-insensitive and draft-07
 * patterns have no flag for that. The list is CloudFront's own, from "Custom
 * headers that CloudFront can't add to origin requests".
 */
const DENIED = new Set([
  "cache-control",
  "connection",
  "content-length",
  "cookie",
  "host",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "max-forwards",
  "pragma",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "range",
  "request-range",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-real-ip",
]);

const DENIED_PREFIXES = ["x-amz-", "x-edge-"];

const isDenied = (name: string): boolean => {
  const lower = name.toLowerCase();
  return DENIED.has(lower) || DENIED_PREFIXES.some((p) => lower.startsWith(p));
};

export const assertOriginHeaders = (item: unknown): void => {
  const origin = (
    item as { forwardSettings?: { origin?: Record<string, unknown> } }
  ).forwardSettings?.origin;
  if (typeof origin !== "object" || origin === null) return;

  const details: ValidationDetail[] = [];

  for (const kind of ["s3", "custom"] as const) {
    const headers = (origin[kind] as { customHeaders?: unknown } | undefined)
      ?.customHeaders;
    if (typeof headers !== "object" || headers === null) continue;

    for (const [name, values] of Object.entries(headers)) {
      // The object key is what CloudFront matches on, but each entry's `key`
      // is what reaches the origin, so either one being refused is enough.
      const keys = Array.isArray(values)
        ? values.map((v) => (v as { key?: unknown }).key)
        : [];
      const refused = [name, ...keys].find(
        (k): k is string => typeof k === "string" && isDenied(k),
      );
      if (refused === undefined) continue;

      details.push({
        path: `/forwardSettings/origin/${kind}/customHeaders/${name}`,
        message: `"${refused}" is a header CloudFront does not allow on an origin request`,
      });
    }
  }

  if (details.length > 0) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Rule failed schema validation",
      details,
    );
  }
};
