import { Ajv } from "ajv";
import { ApiError } from "./errors.js";
import { formatAjvErrors } from "./ajv-errors.js";
import { getAllowedRegions } from "./aws-regions.js";

export interface TargetInput {
  name: string;
  region: string;
  tableName: string;
  /**
   * Optional IAM role the API assumes to reach this target's rules table. Absent
   * means "use the API's own execution role", which only works for tables its
   * policy already covers. See console/api/infra/README.md.
   */
  roleArn?: string;
}

const ajv = new Ajv({ allErrors: true, useDefaults: false });

const validate = ajv.compile<TargetInput>({
  type: "object",
  additionalProperties: false,
  required: ["name", "region", "tableName"],
  properties: {
    // \S, not minLength — "   " is a blank row in the target switcher, and the
    // value is trimmed below so trailing whitespace can't create near-duplicates.
    name: { type: "string", pattern: "\\S" },
    // Format only. Membership is checked separately so the ALLOWED_REGIONS
    // override applies at call time rather than being frozen into this schema
    // when the module is first imported.
    region: { type: "string", pattern: "^[a-z]{2}(-[a-z]+)+-\\d+$" },
    // DynamoDB table naming rules, same as the table module.
    tableName: { type: "string", pattern: "^[a-zA-Z0-9_.-]{3,255}$" },
    // arn:aws:iam::<account>:role/<path><name> — partition varies (aws-cn,
    // aws-us-gov), account is always 12 digits, and IAM roles are global so
    // there is no region segment.
    roleArn: {
      type: "string",
      pattern: "^arn:aws[a-z-]*:iam::\\d{12}:role/.+$",
    },
  },
});

/**
 * Validates a target request body `{ name, region, tableName, roleArn? }`. The
 * server assigns `id`, so a client-supplied `id` (or any extra field) is
 * rejected. Throws `ApiError(400, "VALIDATION_ERROR", …)` with per-field details.
 * Returns the input with `name` trimmed.
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

  if (!getAllowedRegions().has(body.region)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Target failed validation", [
      {
        path: "/region",
        message: `"${body.region}" is not an allowed region`,
      },
    ]);
  }

  return { ...body, name: body.name.trim() };
};
