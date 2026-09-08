import type { ErrorObject } from "ajv";

/**
 * `allErrors` + `additionalProperties: false` makes one junk key produce one
 * detail, so a large body amplifies into a much larger response — enough to pass
 * Lambda's 6 MB response cap, at which point API Gateway replaces the whole
 * envelope with its own 502. Cap the list: past a few dozen the response is
 * unreadable anyway, and the client only needs enough to fix the request.
 */
const MAX_DETAILS = 50;

export interface ValidationDetail {
  path: string;
  message: string;
  params?: Record<string, unknown>;
}

/**
 * Ajv's bookkeeping keywords, dropped from the details.
 *
 * A conditional in the schema — `headerName` is required iff the type is
 * `header`, and the same for `cookieName` — makes Ajv report twice: once for the
 * real problem ("must have required property 'cookieName'") and once to say the
 * branch it sits in failed ('must match "then" schema'). The second is true and
 * useless: it names no field and tells the user nothing to change. Only the
 * bookkeeping is dropped, never a leaf error, so nothing actionable is hidden —
 * and if a conditional ever fails with no leaf error to explain it, the fallback
 * below still says something rather than answering with an empty list.
 */
const BOOKKEEPING_KEYWORDS = new Set(["if", "then", "else"]);

/**
 * Ajv errors → the `details` array of our standard error envelope.
 *
 * `params` is passed through because Ajv puts the offending field there, not in
 * `message` — an `additionalProperties` error says only "must NOT have
 * additional properties" and carries the key in `params.additionalProperty`.
 * Without it the SPA cannot highlight the field that failed. `params` holds
 * schema metadata (the bad key, allowed enum values), never request values.
 */
export const formatAjvErrors = (
  errors: ErrorObject[] | null | undefined,
): ValidationDetail[] => {
  const raw = errors ?? [];
  const meaningful = raw.filter((e) => !BOOKKEEPING_KEYWORDS.has(e.keyword));
  // Unless that left nothing: a failure the client cannot see described at all
  // is worse than one described awkwardly.
  const all = meaningful.length > 0 ? meaningful : raw;
  const details: ValidationDetail[] = all.slice(0, MAX_DETAILS).map((e) => ({
    path: e.instancePath || "(root)",
    message: e.message ?? "invalid",
    ...(e.params && Object.keys(e.params).length > 0
      ? { params: e.params as Record<string, unknown> }
      : {}),
  }));

  if (all.length > MAX_DETAILS) {
    details.push({
      path: "(root)",
      message: `${all.length - MAX_DETAILS} further errors omitted; showing the first ${MAX_DETAILS}`,
    });
  }

  return details;
};
