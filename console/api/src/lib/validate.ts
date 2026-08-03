import { Ajv } from "ajv";
import redirectSchema from "@cloudfront-redirect-rules/shared/redirect-rule.schema.json" with { type: "json" };
import rewriteSchema from "@cloudfront-redirect-rules/shared/rewrite-rule.schema.json" with { type: "json" };
import { ApiError } from "./errors.js";
import { formatAjvErrors } from "./ajv-errors.js";

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
      formatAjvErrors(validate.errors),
    );
  }
};
