import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { docClient } from "./dynamo.js";
import { isResourceNotFound } from "./dynamo-errors.js";
import { ApiError } from "./errors.js";

/** Where a table is, which is all `DescribeTable` needs to reach it. */
export interface TableLocation {
  region: string;
  tableName: string;
  roleArn?: string;
}

export type TableVerifier = (table: TableLocation) => Promise<void>;

/**
 * Rejects a target whose table does not exist.
 *
 * Without this, a mistyped table name is a perfectly valid registration: the
 * duplicate check in `handlers/targets.ts` compares `tableName` exactly — and
 * has to, since DynamoDB table names are case-sensitive — so `Edgeroute-rules`
 * is simply a different table from `edgeroute-rules`, not a duplicate. Both
 * entries then sit in the registry under the same display name, and the broken
 * one only reveals itself on the first rules request, as a 502.
 *
 * **Only `ResourceNotFoundException` rejects.** Every other failure — the role
 * cannot be assumed, the policy does not allow `DescribeTable`, DynamoDB
 * throttled us — means we could not determine anything, and a target that is
 * unreachable *right now* is expected: registering is a runtime action while IAM
 * is granted at apply time, so `target_table_arns` is routinely still empty when
 * the target goes in (see console/api/infra/README.md, and the `assumeRole`
 * comment in dynamo.ts). Rejecting those would break that order. They keep
 * surfacing later as 502 TARGET_UNREACHABLE, which explains itself.
 *
 * So this closes the case where AWS positively says "no such table", and leaves
 * "cannot tell" alone.
 */
export const assertTableExists: TableVerifier = async (table) => {
  try {
    await docClient(table.region, table.roleArn).send(
      new DescribeTableCommand({ TableName: table.tableName }),
    );
  } catch (err) {
    if (!isResourceNotFound(err)) return;

    throw new ApiError(400, "VALIDATION_ERROR", "Target failed validation", [
      {
        path: "/tableName",
        // Names the region because the same table name in the wrong region is
        // the other half of this mistake, and flags case because that is the
        // difference an operator re-reads three times without seeing.
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
