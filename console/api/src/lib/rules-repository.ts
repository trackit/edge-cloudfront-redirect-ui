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
 * A rule item as the Lambda@Edge reads it. Only the fields the API handles are
 * named; the rest passes through untouched, which is what the index signature
 * stands for. The shared schemas, not this type, are the contract.
 */
export interface RuleItem {
  pk: string;
  sk: string;
  type: RuleType;
  disabled?: boolean;
  [key: string]: unknown;
}

/**
 * One host in a target's table, with its rule counts. A host is not a stored
 * entity — it is the partition key of its rules — so it needs *something* in its
 * partition to be listed: its rules, or the marker item below. Only an empty
 * partition is absent.
 */
export interface HostSummary {
  host: string;
  redirects: number;
  rewrites: number;
}

/** The two key attributes `listHosts` projects; the rest of the item is not read. */
type RuleKey = Pick<RuleItem, "pk" | "sk">;

/**
 * Sort key of the item that makes a host exist before it has any rules — what
 * the console's "add host" writes, and without which a ruleless host would
 * vanish on the next page load.
 *
 * Invisible to the edge by construction: it queries `begins_with(sk,
 * "REDIRECT#")` / `"REWRITE#"`, and neither matches. Unaddressable over the API
 * too, since `parseSk` only accepts `TYPE#priority`.
 */
export const HOST_MARKER_SK = "HOST";

/** DynamoDB's hard cap on one BatchWriteItem request. */
const BATCH_LIMIT = 25;

/**
 * How many times a batch is re-sent for the items DynamoDB declined.
 *
 * BatchWriteItem answers **200 with an `UnprocessedItems` map** when it throttles
 * part of a request — a success to the SDK's retry policy, so nothing below this
 * code re-sends them. Ignored, those rules survive a delete that reported
 * success.
 */
const UNPROCESSED_ATTEMPTS = 5;

/** First wait between re-sends; each later one doubles it. */
const UNPROCESSED_BACKOFF_MS = 50;

/**
 * How long to wait before re-sending declined items.
 *
 * Exponential because items come back unprocessed *while* the partition is hot:
 * five back-to-back attempts are spent in milliseconds and all fail for the one
 * reason. Jittered because the competing batches are in other invocations, and a
 * fixed schedule marches them back together, rebuilding the burst. Half the cap
 * rather than AWS's full jitter — a delay near zero is no backoff at all.
 */
const backoffFor = (attempt: number): number =>
  Math.round(
    UNPROCESSED_BACKOFF_MS * 2 ** attempt * (0.5 + Math.random() * 0.5),
  );

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Folds projected keys into one entry per host. Exported so the in-memory fake
 * counts the same way rather than reimplementing it.
 *
 * An `sk` matching neither prefix lists its host but counts toward neither total
 * — that is where a non-rule item like `HOST` lives, and it is not a rule.
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
  /**
   * Every host with anything under its partition — rules, a marker, or both —
   * with per-kind counts. A host that has never held either is not there.
   * Unordered.
   */
  listHosts(): Promise<HostSummary[]>;
  /**
   * Creates a host that has no rules yet. `false` when the host already exists —
   * whether it holds rules or was created this way before — which the caller
   * turns into a 409. Never touches an existing host's rules.
   */
  createHost(host: string): Promise<boolean>;
  /**
   * Deletes everything under a host. Returns how many *items* went, which is the
   * rules plus the host marker if one was there — only ever compared against 0,
   * where it means the host held nothing at all and is the caller's 404.
   */
  deleteHost(host: string): Promise<number>;
  get(host: string, sk: string): Promise<RuleItem | null>;
  /** `false` when there was no such rule — the caller turns that into a 404. */
  delete(host: string, sk: string): Promise<boolean>;
  /**
   * `false` when that key is already taken — never overwrites. A successful
   * create also ensures the host's marker, so a host reached this way survives
   * the deletion of its last rule exactly as one added through `createHost` does.
   */
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

  /**
   * `sleep` is the backoff seam: injected so a test can assert the retry delays
   * without spending them, rather than waiting out five doubling timeouts.
   */
  constructor(
    private readonly target: ResolvedTarget,
    private readonly sleep: (ms: number) => Promise<void> = sleepFor,
  ) {
    this.client = docClient(target.region, target.roleArn);
  }

  // Follows LastEvaluatedKey: a Query pages at 1 MB, and stopping at the first
  // page would silently drop a busy host's lowest-priority rules.
  //
  // Eventually consistent, unlike `get`: this is a whole partition, not an item
  // the caller was just handed. A write can lag by milliseconds here, against
  // the ~1 min the edge takes to see it at all.
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

    // The partition holds more than rules: returning a host's marker item as a
    // rule would put a phantom row — no type, priority or action — in the
    // console's list. Filtered here because a FilterExpression costs the same
    // read and cannot express "either prefix" anyway.
    return items.filter((item) => isRuleSk(item.sk));
  }

  /**
   * A Scan, because the hosts *are* the partition keys: nothing can query "every
   * distinct pk", and a GSI keyed on one would cost a second copy of the table.
   *
   * `ProjectionExpression` keeps it off the item bodies — the Scan's 1 MB pages
   * count bytes read, not bytes returned. Eventually consistent, like
   * `listByHost`: a whole-table read, not an item just handed to the caller.
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
   * host with rules and no marker must also be refused, and a condition on the
   * marker's key cannot see those rules. So the partition is probed first, and
   * the conditional Put guards the race between two callers adding the same
   * empty host.
   *
   * An existing host is refused but has its marker ensured on the way out —
   * the repair path for hosts whose rules predate the marker, or whose marker
   * write failed. Without it the 409 is a dead end: the host cannot be added,
   * yet still disappears when its last rule goes.
   */
  async createHost(host: string): Promise<boolean> {
    if (await this.hostExists(host)) {
      await this.ensureHostMarker(host);
      return false;
    }

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
   * DynamoDB has no "drop this partition", so this reads the host's keys and
   * writes them back as deletes, 25 at a time.
   *
   * **Not atomic.** `TransactWriteItems` caps at 100 items, and a bigger host
   * would need several transactions anyway — atomic in pieces is not atomic. A
   * failure part-way leaves fewer rules rather than none, recoverable by
   * repeating the delete, which is why this reports a count.
   *
   * Strongly consistent Query first: an eventually consistent one can miss a
   * rule written moments ago, and skipping the newest is what an author notices.
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
      // Between attempts only: nothing is owed before the first, and waiting
      // after the last would delay the throw by a backoff nobody uses.
      if (attempt > 0) await this.sleep(backoffFor(attempt - 1));

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
    const created = await this.putIf(item, "attribute_not_exists(pk)");
    if (created) await this.ensureHostMarker(item.pk);
    return created;
  }

  /**
   * Writes the host marker unless it is already there, so that a host outlives
   * its rules however it came to exist. Without it, a host added through the
   * console keeps its place in the sidebar when its last rule goes while one
   * that first appeared as a rule's partition key does not — a difference the
   * user cannot see.
   *
   * Runs after the rule and never fails the create: the rule is what the caller
   * asked for, and a lost marker only costs the empty-host case, since
   * `listHosts` reports a host from its rules regardless.
   */
  private async ensureHostMarker(host: string): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.target.tableName,
          Item: { pk: host, sk: HOST_MARKER_SK },
          // Writes once; every later create through the same host is refused
          // here rather than rewriting it.
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (err) {
      // Already there is not a failure — it is what every create after the
      // first sees, and what the condition exists to produce.
      if (isConditionalCheckFailed(err)) return;

      // Anything else is swallowed but not silently: this is the one path that
      // lets the invariant decay, and the console cannot report it.
      console.warn(
        `could not write the host marker for "${host}" on "${this.target.tableName}"`,
        err,
      );
    }
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
            // retries on its own. If a committed transaction's response is lost,
            // the retry finds the new key taken and the old one gone — both
            // conditions failing, which reads like "someone else deleted this
            // rule" and answers 404 for a move that succeeded. Generated per
            // call, so it makes a retry a no-op without collapsing two moves a
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
