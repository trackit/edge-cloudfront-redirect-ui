import { Ajv, type ErrorObject } from "ajv";
import redirectSchema from "@cloudfront-redirect-rules/shared/redirect-rule.schema.json" with { type: "json" };
import rewriteSchema from "@cloudfront-redirect-rules/shared/rewrite-rule.schema.json" with { type: "json" };
import { ApiError } from "./errors.js";

// Both schemas are registered under their filenames because rewrite-rule cross-
// refs `redirect-rule.schema.json#/definitions/match`. Same setup as shared/test.
const ajv = new Ajv({ allErrors: true, useDefaults: false });
ajv.addSchema(redirectSchema, "redirect-rule.schema.json");
ajv.addSchema(rewriteSchema, "rewrite-rule.schema.json");

const SCHEMA_BY_TYPE = {
  erMatchRule: "redirect-rule.schema.json",
  frMatchRule: "rewrite-rule.schema.json",
} as const;

type RuleType = keyof typeof SCHEMA_BY_TYPE;

/**
 * `allErrors` + `additionalProperties: false` makes one junk key produce one
 * detail, so a large body amplifies into a much larger response — enough to
 * pass Lambda's 6 MB response cap, at which point API Gateway replaces the
 * whole envelope with its own 502. Cap the list: past a few dozen the response
 * is unreadable anyway, and the client only needs enough to fix the request.
 */
const MAX_DETAILS = 50;

/**
 * Ajv puts the offending field in `params`, not in `message` — an
 * `additionalProperties` error says only "must NOT have additional properties"
 * and carries the key in `params.additionalProperty`. Without it the SPA can't
 * highlight the field that failed, so `params` is passed through. It holds
 * schema metadata (the bad key, allowed enum values), never request values.
 */
const toDetails = (errors: ErrorObject[] | null | undefined) => {
  const all = errors ?? [];
  const details: unknown[] = all.slice(0, MAX_DETAILS).map((e) => ({
    path: e.instancePath || "(root)",
    message: e.message ?? "invalid",
    ...(e.params && Object.keys(e.params).length > 0
      ? { params: e.params }
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

/**
 * Validates a rule body against its shared JSON Schema, picked by `type`.
 * Throws `ApiError(400, "VALIDATION_ERROR", …)` with per-field details on
 * failure; returns normally when the body is a valid rule.
 */
export const validateRule = (body: unknown): void => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Request body must be a rule object",
    );
  }

  const type = (body as { type?: unknown }).type;
  if (type !== "erMatchRule" && type !== "frMatchRule") {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      'Rule "type" must be "erMatchRule" (redirect) or "frMatchRule" (rewrite)',
    );
  }

  const key = SCHEMA_BY_TYPE[type as RuleType];
  const validate = ajv.getSchema(key);
  if (!validate) throw new Error(`schema not registered: ${key}`);

  if (!validate(body)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Rule failed schema validation",
      toDetails(validate.errors),
    );
  }
};
