import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
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

/**
 * Why a move is its own operation: `sk` embeds the priority, so re-prioritising a
 * rule is not an update but a delete plus an insert under a new key. Done as two
 * calls, a failure between them leaves the rule live at both priorities.
 */
export type MoveOutcome =
  /** Written at the new key, removed from the old one. */
  | "moved"
  /** Nothing at the old key — the rule was already deleted or never existed. */
  | "missing"
  /** Another rule already holds the new key. */
  | "occupied";

export interface RulesRepository {
  /** Every rule for a host, ascending `sk` (type, then priority). */
  listByHost(host: string): Promise<RuleItem[]>;
  get(host: string, sk: string): Promise<RuleItem | null>;
  /** `false` when there was no such rule — the caller turns that into a 404. */
  delete(host: string, sk: string): Promise<boolean>;
  /** `false` when that key is already taken — never overwrites. */
  create(item: RuleItem): Promise<boolean>;
  /** `false` when there was no rule at that key — replace, never insert. */
  replace(item: RuleItem): Promise<boolean>;
  /**
   * Moves the rule at `fromSk` to `item.sk`, atomically. `fromSk` equal to
   * `item.sk` is allowed and is a plain replace.
   */
  move(fromSk: string, item: RuleItem): Promise<MoveOutcome>;
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
  //
  // Eventually consistent, unlike `get` — a list is a whole partition rather
  // than one item the caller was just handed, and the registry's own list reads
  // the same way. A write can therefore lag by milliseconds here, against the
  // ~1 min the edge takes to see it at all.
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

  // Conditional so a create can never overwrite the rule already sitting at that
  // priority — a plain Put would silently replace it, and the author would see
  // their new rule while the old one simply vanished.
  async create(item: RuleItem): Promise<boolean> {
    return this.putIf(item, "attribute_not_exists(pk)");
  }

  // The mirror image: PUT replaces the addressed rule and never inserts one, so
  // a rule deleted in another tab does not quietly come back.
  async replace(item: RuleItem): Promise<boolean> {
    return this.putIf(item, "attribute_exists(pk)");
  }

  /**
   * Re-prioritising, as one transaction: write the new key only if free, remove
   * the old one only if still there. Either both happen or neither does, so the
   * rule is never live at two priorities at once — which at the edge would mean
   * two rules matching the same request.
   */
  async move(fromSk: string, item: RuleItem): Promise<MoveOutcome> {
    // DynamoDB rejects a transaction that touches one item twice, so a "move"
    // that does not actually move is a plain replace. Handled here rather than
    // left to callers: the alternative is a ValidationException surfacing as a
    // 500 the first time some future caller does not check first.
    if (fromSk === item.sk) {
      return (await this.replace(item)) ? "moved" : "missing";
    }

    try {
      await this.send(() =>
        this.client.send(
          new TransactWriteCommand({
            // TransactWriteItems is not idempotent without a token, and the SDK
            // retries on its own. Should a committed transaction's response be
            // lost, the retry finds the new key taken and the old one gone —
            // both conditions failing, which reads exactly like "someone else
            // already deleted this rule" and would answer 404 for a move that
            // succeeded. An author who then re-creates the rule at its old
            // priority ends up with it live at both. The token is generated per
            // call and reused across the SDK's own retries, so it makes a
            // retried transaction a no-op without ever collapsing two moves a
            // client genuinely asked for.
            ClientRequestToken: randomUUID(),
            TransactItems: [
              {
                Put: {
                  TableName: this.target.tableName,
                  Item: item,
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
              {
                Delete: {
                  TableName: this.target.tableName,
                  Key: { pk: item.pk, sk: fromSk },
                  ConditionExpression: "attribute_exists(pk)",
                },
              },
            ],
          }),
        ),
      );
      return "moved";
    } catch (err) {
      return this.moveFailure(err);
    }
  }

  /**
   * Which leg of the transaction refused. `CancellationReasons` is positional —
   * index 0 is the Put, index 1 the Delete — so the outcome says whether the
   * destination was taken or the source had already gone. "missing" wins when
   * both failed: the caller addressed a rule that no longer exists, which is the
   * more specific answer.
   */
  private moveFailure(err: unknown): MoveOutcome {
    const reasons = (err as { CancellationReasons?: { Code?: string }[] })
      .CancellationReasons;
    if (!reasons) throw err;

    const refused = (index: number): boolean =>
      reasons[index]?.Code === "ConditionalCheckFailed";

    if (refused(1)) return "missing";
    if (refused(0)) return "occupied";
    throw err;
  }

  private async putIf(item: RuleItem, condition: string): Promise<boolean> {
    try {
      await this.send(() =>
        this.client.send(
          new PutCommand({
            TableName: this.target.tableName,
            Item: item,
            ConditionExpression: condition,
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
