import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo.js";
import { isConditionalCheckFailed, toTargetError } from "./dynamo-errors.js";
import type { RuleType } from "./rule-keys.js";
import type { ResolvedTarget } from "./targets-repository.js";

/**
 * A rule item in the shape the Lambda@Edge reads. Only the fields the API itself
 * handles are named; the rest of the shape (matches, redirectURL,
 * forwardSettings…) is defined by the shared JSON Schemas and passed through
 * untouched — that is what the index signature stands for. The schemas, not this
 * type, are the contract.
 */
export interface RuleItem {
  pk: string;
  sk: string;
  type: RuleType;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface RulesRepository {
  /** Every rule for a host, ascending `sk` (type, then priority). */
  listByHost(host: string): Promise<RuleItem[]>;
  get(host: string, sk: string): Promise<RuleItem | null>;
  /** `false` when there was no such rule — the caller turns that into a 404. */
  delete(host: string, sk: string): Promise<boolean>;
}

/**
 * Rules live in the *target's* table, not the control plane's own — so unlike
 * `DynamoTargetsRepository` this takes its coordinates from the resolved target
 * rather than from `getConfig()`, and reaches the table under that target's role
 * when it has one. Status-code semantics stay in the handlers; the one exception
 * is `delete`, which folds its conditional failure into a boolean so no SDK error
 * shape leaks upward.
 */
export class DynamoRulesRepository implements RulesRepository {
  private readonly client: DynamoDBDocumentClient;

  constructor(private readonly target: ResolvedTarget) {
    this.client = docClient(target.region, target.roleArn);
  }

  // Follows LastEvaluatedKey: a Query returns at most 1 MB per page, and
  // stopping at the first page would silently drop a busy host's lowest-priority
  // rules with no error. Same reason DynamoTargetsRepository.list paginates.
  async listByHost(host: string): Promise<RuleItem[]> {
    const items: RuleItem[] = [];
    let start: Record<string, unknown> | undefined;

    do {
      const out = await this.send(() =>
        this.client.send(
          new QueryCommand({
            TableName: this.target.tableName,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: { ":pk": host },
            // Ascending sort key order == REDIRECT before REWRITE, and ascending
            // priority within each — the order the edge evaluates them in.
            ScanIndexForward: true,
            ...(start ? { ExclusiveStartKey: start } : {}),
          }),
        ),
      );

      items.push(...((out.Items ?? []) as RuleItem[]));
      start = out.LastEvaluatedKey;
    } while (start);

    return items;
  }

  // ConsistentRead for the same reason the targets registry uses it: the SPA
  // reads a rule back immediately after writing it, and an eventually consistent
  // GetItem can 404 on the rule it was just handed.
  async get(host: string, sk: string): Promise<RuleItem | null> {
    const out = await this.send(() =>
      this.client.send(
        new GetCommand({
          TableName: this.target.tableName,
          Key: { pk: host, sk },
          ConsistentRead: true,
        }),
      ),
    );

    return (out.Item as RuleItem | undefined) ?? null;
  }

  // DeleteItem is idempotent — it reports success for an item that was never
  // there. The condition is what lets a delete of a non-existent rule be a 404
  // instead of a 204 that claims to have removed something.
  async delete(host: string, sk: string): Promise<boolean> {
    try {
      await this.send(() =>
        this.client.send(
          new DeleteCommand({
            TableName: this.target.tableName,
            Key: { pk: host, sk },
            ConditionExpression: "attribute_exists(pk)",
          }),
        ),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  /** Turns an unreachable target into a 502; leaves every other failure alone. */
  private async send<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      throw toTargetError(err, this.target);
    }
  }
}

/**
 * One repository per target, built per request — the expensive part (the
 * DocumentClient, and the assumed-role credentials behind it) is already
 * memoized in `dynamo.ts`, so there is nothing here worth caching.
 * `setRulesRepositoryFactory` is the test seam.
 */
type RulesRepositoryFactory = (target: ResolvedTarget) => RulesRepository;

const dynamoFactory: RulesRepositoryFactory = (target) =>
  new DynamoRulesRepository(target);

let factory: RulesRepositoryFactory = dynamoFactory;

export const getRulesRepository = (target: ResolvedTarget): RulesRepository =>
  factory(target);

export const setRulesRepositoryFactory = (
  fake: RulesRepositoryFactory,
): void => {
  factory = fake;
};

export const resetRulesRepositoryFactory = (): void => {
  factory = dynamoFactory;
};
