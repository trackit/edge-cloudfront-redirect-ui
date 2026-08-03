import { Ajv } from "ajv";
import redirectSchema from "@cloudfront-redirect-rules/shared/redirect-rule.schema.json" with { type: "json" };
import rewriteSchema from "@cloudfront-redirect-rules/shared/rewrite-rule.schema.json" with { type: "json" };
import { ApiError } from "./errors.js";
import { formatAjvErrors } from "./ajv-errors.js";
import type { RuleType } from "./rule-keys.js";

// Both schemas are registered under their filenames because rewrite-rule cross-
// refs `redirect-rule.schema.json#/definitions/match`. Same setup as shared/test.
const ajv = new Ajv({ allErrors: true, useDefaults: false });
ajv.addSchema(redirectSchema, "redirect-rule.schema.json");
ajv.addSchema(rewriteSchema, "rewrite-rule.schema.json");

const SCHEMA_BY_TYPE: Record<RuleType, string> = {
  erMatchRule: "redirect-rule.schema.json",
  frMatchRule: "rewrite-rule.schema.json",
};

/**
 * Narrows the `type` discriminator. Separate from `validateRule` because the
 * sort key is built from `type` before there is an item to validate — and both
 * paths must fail with the same message, or the same bad body would be described
 * two ways depending on which route it was sent to.
 */
export const assertRuleType = (type: unknown): RuleType => {
  if (type !== "erMatchRule" && type !== "frMatchRule") {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      'Rule "type" must be "erMatchRule" (redirect) or "frMatchRule" (rewrite)',
    );
  }

  return type;
};

/**
 * Validates a rule item against its shared JSON Schema, picked by `type`.
 * Throws `ApiError(400, "VALIDATION_ERROR", …)` with per-field details on
 * failure; returns normally when the item is a valid rule.
 *
 * Runs on the *composed* item — keys and all — not on the request body, so the
 * schemas stay the single definition of what reaches DynamoDB.
 */
export const validateRule = (body: unknown): void => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Request body must be a rule object",
    );
  }

  const type = assertRuleType((body as { type?: unknown }).type);
  const key = SCHEMA_BY_TYPE[type];
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
