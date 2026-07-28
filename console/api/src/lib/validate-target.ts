import { Ajv } from "ajv";
import { ApiError } from "./errors.js";
import { formatAjvErrors } from "./ajv-errors.js";
import { AWS_REGIONS } from "./aws-regions.js";

export interface TargetInput {
  name: string;
  region: string;
  tableName: string;
}

const ajv = new Ajv({ allErrors: true, useDefaults: false });

const validate = ajv.compile<TargetInput>({
  type: "object",
  additionalProperties: false,
  required: ["name", "region", "tableName"],
  properties: {
    name: { type: "string", minLength: 1 },
    // Existence, not just format — an unknown region is rejected here.
    region: { type: "string", enum: [...AWS_REGIONS] },
    // DynamoDB table naming rules, same as the table module.
    tableName: { type: "string", pattern: "^[a-zA-Z0-9_.-]{3,255}$" },
  },
});

/**
 * Validates a target request body `{ name, region, tableName }`. The server
 * assigns `id`, so a client-supplied `id` (or any extra field) is rejected.
 * Throws `ApiError(400, "VALIDATION_ERROR", …)` with per-field details.
 */
export const validateTarget = (body: unknown): TargetInput => {
  if (!validate(body)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Target failed validation",
      formatAjvErrors(validate.errors),
    );
  }
  return body;
};
