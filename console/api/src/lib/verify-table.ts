import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { docClient } from "./dynamo.js";
import { errorName, isResourceNotFound } from "./dynamo-errors.js";
import { ApiError } from "./errors.js";

/** Where a table is, which is all `DescribeTable` needs to reach it. */
export interface TableLocation {
  region: string;
  tableName: string;
  roleArn?: string;
}

export type TableVerifier = (table: TableLocation) => Promise<void>;

/**
 * Rejects a target whose table does not exist — and only that. Every other
 * `DescribeTable` failure means we could not tell, which is not the same answer
 * and is expected while IAM is still catching up with the registration.
 *
 * The asymmetry, and how the IAM grant decides whether this check works at all,
 * are in console/api/README.md § "Why registering a target only half-checks the
 * table". Read that before narrowing either branch.
 */
export const assertTableExists: TableVerifier = async (table) => {
  try {
    await docClient(table.region, table.roleArn).send(
      new DescribeTableCommand({ TableName: table.tableName }),
    );
  } catch (err) {
    if (!isResourceNotFound(err)) {
      // The only trace that the check did not run: allowing the registration is
      // right, but looks identical to a table that exists, so a policy that
      // loses `dynamodb:DescribeTable` would turn the check off with no symptom.
      console.warn(
        `console-api: could not verify table "${table.tableName}" in ${table.region}: ${errorName(err) || "unknown error"} — registering it unchecked`,
      );
      return;
    }

    throw new ApiError(400, "VALIDATION_ERROR", "Target failed validation", [
      {
        path: "/tableName",
        // Names the region and the case: the same name in the wrong region is
        // the other half of this mistake, and case is the difference an
        // operator re-reads three times without seeing.
        message: `no DynamoDB table "${table.tableName}" exists in ${table.region} — check the spelling, the case (table names are case-sensitive) and the region`,
      },
    ]);
  }
};

// Swapped out in tests so the targets suite never reaches AWS. Same seam shape
// as `setTargetsRepository`.
let verifier: TableVerifier = assertTableExists;

export const getTableVerifier = (): TableVerifier => verifier;

export const setTableVerifier = (fake: TableVerifier): void => {
  verifier = fake;
};

export const resetTableVerifier = (): void => {
  verifier = assertTableExists;
};
