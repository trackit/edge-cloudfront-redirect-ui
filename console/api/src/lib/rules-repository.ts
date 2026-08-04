import { randomUUID } from "node:crypto";
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo.js";
import { isConditionalCheckFailed, toTargetError } from "./dynamo-errors.js";
import { isRuleSk, type RuleType } from "./rule-keys.js";
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
 * One host in a target's table, with how many rules of each kind it holds.
 *
 * A host is not a stored entity — it is the partition key of its rule items — so
 * a host exists exactly as long as it has at least one rule, and one with none
 * cannot be listed because there is nothing in the table to list.
 */
export interface HostSummary {
  host: string;
  redirects: number;
  rewrites: number;
}

/** The two key attributes `listHosts` projects; the rest of the item is not read. */
type RuleKey = Pick<RuleItem, "pk" | "sk">;

/**
 * Sort key of the item that makes a host exist before it has any rules.
 *
 * A host is otherwise only the partition key of its rules, so one with none is
 * indistinguishable from one that was never created — it cannot be listed, and
 * would vanish on the next page load. This item is what the console's "add host"
 * writes.
 *
 * Invisible to the edge by construction: the Lambda@Edge queries
 * `begins_with(sk, "REDIRECT#")` and `begins_with(sk, "REWRITE#")`, and `"HOST"`
 * begins with neither, so it is never read, matched, or evaluated. It is equally
 * unaddressable over the API — `parseSk` rejects anything that is not
 * `TYPE#priority`, so `/rules/HOST` is a 400 rather than a route to this item.
 */
export const HOST_MARKER_SK = "HOST";

/** DynamoDB's hard cap on one BatchWriteItem request. */
const BATCH_LIMIT = 25;

/**
 * How many times a batch is re-sent for the items DynamoDB declined.
 *
 * BatchWriteItem answers **200 with an `UnprocessedItems` map** when it throttles
 * part of a request — a success as far as the SDK's retry policy is concerned, so
 * nothing below this code will ever re-send them. Ignored, those rules quietly
 * survive a delete that reported success.
 */
const UNPROCESSED_ATTEMPTS = 5;

/**
 * Folds projected keys into one entry per host. Exported so the in-memory fake
 * counts the same way the real repository does rather than reimplementing it.
 *
 * An `sk` matching neither prefix still puts its host on the list but counts
 * toward neither total: the sort key is where a future non-rule item (a marker
 * for a host with no rules, say) would live, and such an item must not be
 * reported as a rule.
 */
export const summarizeHosts = (keys: RuleKey[]): HostSummary[] => {
  const hosts = new Map<string, HostSummary>();

  for (const { pk, sk } of keys) {
    let summary = hosts.get(pk);
    if (!summary) {
      summary = { host: pk, redirects: 0, rewrites: 0 };
      hosts.set(pk, summary);
    }

    if (sk.startsWith("REDIRECT#")) summary.redirects += 1;
    else if (sk.startsWith("REWRITE#")) summary.rewrites += 1;
  }

  return [...hosts.values()];
};

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
  /** Every host holding at least one rule, with per-kind counts. Unordered. */
  listHosts(): Promise<HostSummary[]>;
  /**
   * Creates a host that has no rules yet. `false` when the host already exists —
   * whether it holds rules or was created this way before — which the caller
   * turns into a 409. Never touches an existing host's rules.
   */
  createHost(host: string): Promise<boolean>;
  /**
   * Deletes every rule under a host. Returns how many were removed — 0 means the
   * host had none, which is the caller's 404, a host being exactly its rules.
   */
  deleteHost(host: string): Promise<number>;
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
  /**
   * Flips `disabled` on one rule, leaving every other field alone. Returns the
   * updated rule, or `null` when there was none — the caller's 404.
   */
  setDisabled(
    host: string,
    sk: string,
    disabled: boolean,
  ): Promise<RuleItem | null>;
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

    // The partition holds more than rules: a host created before it had any
    // carries a marker item, and returning that as a rule would put a phantom
    // row in the console's list — one with no type, priority or action. Filtered
    // here rather than with a FilterExpression, which costs the same read and
    // cannot express "either prefix" in a key condition anyway.
    return items.filter((item) => isRuleSk(item.sk));
  }

  /**
   * A Scan, because the hosts *are* the partition keys: there is no index to
   * query for "every distinct pk", and a GSI keyed on one would cost a second
   * copy of the table to answer a question the console asks once per page load.
   *
   * `ProjectionExpression` keeps this off the item bodies — a rule carries its
   * matches and forwardSettings, and the Scan's 1 MB pages are counted against
   * the bytes read, not the bytes returned. Neither `pk` nor `sk` is a DynamoDB
   * reserved word, so they need no ExpressionAttributeNames indirection (unlike
   * `disabled` in `setDisabled`).
   *
   * Eventually consistent, like `listByHost` and for the same reason: this is a
   * whole-table read, not an item the caller was just handed.
   */
  async listHosts(): Promise<HostSummary[]> {
    const keys: RuleKey[] = [];
    let start: Record<string, unknown> | undefined;

    do {
      const out = await this.send(() =>
        this.client.send(
          new ScanCommand({
            TableName: this.target.tableName,
            ProjectionExpression: "pk, sk",
            ...(start ? { ExclusiveStartKey: start } : {}),
          }),
        ),
      );

      keys.push(...((out.Items ?? []) as RuleKey[]));
      start = out.LastEvaluatedKey;
    } while (start);

    return summarizeHosts(keys);
  }

  /**
   * Writes the marker that makes an empty host exist.
   *
   * Two steps, because "already exists" is broader than "this key is taken": a
   * host with rules and no marker must still be refused, and a condition on the
   * marker's own key cannot see those rules. So the partition is probed first,
   * and the conditional Put then guards the narrow race where two callers add
   * the same empty host at once. A host that gained its first *rule* between the
   * probe and the Put still gets a marker — harmless, since `listHosts` folds
   * the partition into one entry and `deleteHost` takes the whole thing.
   */
  async createHost(host: string): Promise<boolean> {
    if (await this.hostExists(host)) return false;

    // Its own Put rather than `putIf`: the marker carries no `type`, because it
    // is not a rule and must not read as a malformed one to anything that walks
    // the table.
    try {
      await this.send(() =>
        this.client.send(
          new PutCommand({
            TableName: this.target.tableName,
            Item: { pk: host, sk: HOST_MARKER_SK },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        ),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  /** Whether anything at all is stored under this host — a rule or a marker. */
  private async hostExists(host: string): Promise<boolean> {
    const out = await this.send(() =>
      this.client.send(
        new QueryCommand({
          TableName: this.target.tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": host },
          // One item is enough to answer the question, and the key is all of it
          // that is read. ConsistentRead so a host created moments ago cannot be
          // created a second time.
          ProjectionExpression: "pk",
          ConsistentRead: true,
          Limit: 1,
        }),
      ),
    );

    return (out.Items ?? []).length > 0;
  }

  /**
   * Deleting a host means deleting its rules one by one — DynamoDB has no
   * "drop this partition" operation, so this reads the keys and writes them back
   * as deletes, 25 at a time.
   *
   * **Not atomic.** A `TransactWriteItems` would be, but it caps at 100 items,
   * and a host with more rules than that would need several transactions anyway
   * — atomic in pieces is not atomic. So a failure part-way leaves the host with
   * fewer rules rather than none. That is recoverable by repeating the delete,
   * which is why this reports the count rather than pretending to be all-or-
   * nothing.
   *
   * The keys are read first with a strongly consistent Query: an eventually
   * consistent one can miss a rule written moments ago, and a delete that skips
   * the newest rule is the one an author is most likely to notice.
   */
  async deleteHost(host: string): Promise<number> {
    const keys = await this.listKeys(host);
    if (keys.length === 0) return 0;

    for (let i = 0; i < keys.length; i += BATCH_LIMIT) {
      await this.deleteBatch(keys.slice(i, i + BATCH_LIMIT));
    }

    return keys.length;
  }

  /** Keys only, for the delete above — the item bodies are never needed. */
  private async listKeys(host: string): Promise<RuleKey[]> {
    const keys: RuleKey[] = [];
    let start: Record<string, unknown> | undefined;

    do {
      const out = await this.send(() =>
        this.client.send(
          new QueryCommand({
            TableName: this.target.tableName,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: { ":pk": host },
            ProjectionExpression: "pk, sk",
            ConsistentRead: true,
            ...(start ? { ExclusiveStartKey: start } : {}),
          }),
        ),
      );

      keys.push(...((out.Items ?? []) as RuleKey[]));
      start = out.LastEvaluatedKey;
    } while (start);

    return keys;
  }

  /** One BatchWriteItem, re-sending whatever DynamoDB hands back unprocessed. */
  private async deleteBatch(keys: RuleKey[]): Promise<void> {
    let pending = keys.map((Key) => ({ DeleteRequest: { Key } }));

    for (let attempt = 0; attempt < UNPROCESSED_ATTEMPTS; attempt += 1) {
      const out = await this.send(() =>
        this.client.send(
          new BatchWriteCommand({
            RequestItems: { [this.target.tableName]: pending },
          }),
        ),
      );

      const left = out.UnprocessedItems?.[this.target.tableName] ?? [];
      if (left.length === 0) return;
      pending = left as typeof pending;
    }

    // A plain Error, so the handler logs it and answers 500: the rules that did
    // go are gone, and the caller's remedy is to repeat the delete. Reporting
    // 204 here would claim a host was removed while some of it is still live at
    // the edge.
    throw new Error(
      `BatchWriteItem left ${pending.length} of ${keys.length} rules undeleted on "${this.target.tableName}" after ${UNPROCESSED_ATTEMPTS} attempts`,
    );
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
   * An update rather than a Put: the toggle must not depend on the client having
   * sent the rest of the rule, and a Put would silently clear any field a stale
   * client had not sent. `ALL_NEW` hands back the whole item so the response is
   * the same `Rule` every other route returns.
   */
  async setDisabled(
    host: string,
    sk: string,
    disabled: boolean,
  ): Promise<RuleItem | null> {
    try {
      const out = await this.send(() =>
        this.client.send(
          new UpdateCommand({
            TableName: this.target.tableName,
            Key: { pk: host, sk },
            // `DISABLED` is a DynamoDB reserved word, so the attribute has to be
            // named indirectly — inline, this is a ValidationException.
            UpdateExpression: "SET #disabled = :disabled",
            ExpressionAttributeNames: { "#disabled": "disabled" },
            ExpressionAttributeValues: { ":disabled": disabled },
            ConditionExpression: "attribute_exists(pk)",
            ReturnValues: "ALL_NEW",
          }),
        ),
      );

      return (out.Attributes as RuleItem | undefined) ?? null;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return null;
      throw err;
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
