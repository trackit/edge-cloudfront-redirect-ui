import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { getConfig } from "../config.js";
import { docClient } from "./dynamo.js";
import { ApiError } from "./errors.js";

export interface Target {
  id: string;
  name: string;
  region: string;
  tableName: string;
  /**
   * Optional IAM role the API assumes to reach this target's rules table.
   * Absent means "use the API's own execution role". Registering a target is a
   * runtime action while IAM is granted at deploy time, so this is how a target
   * added after the fact becomes reachable without a Terraform apply — see
   * console/api/infra/README.md.
   */
  roleArn?: string;
}

export interface TargetsRepository {
  create(target: Target): Promise<void>;
  list(): Promise<Target[]>;
  get(id: string): Promise<Target | null>;
  put(target: Target): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * The registry table (control-plane's own state): `pk = id`, one item per
 * target. Status-code semantics (404 for an unknown id, 409 for a table already
 * registered) live in the handlers; this stays thin data access.
 */
export class DynamoTargetsRepository implements TargetsRepository {
  private readonly table = getConfig().targetsTableName;
  private readonly client = docClient(getConfig().region);

  async create(target: Target): Promise<void> {
    await this.client.send(
      new PutCommand({ TableName: this.table, Item: target }),
    );
  }

  // Follows LastEvaluatedKey: a Scan returns at most 1 MB per page, and stopping
  // at the first page would silently return a short list with no error.
  async list(): Promise<Target[]> {
    const items: Target[] = [];
    let start: Record<string, unknown> | undefined;

    do {
      const out = await this.client.send(
        new ScanCommand({
          TableName: this.table,
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      items.push(...((out.Items ?? []) as Target[]));
      start = out.LastEvaluatedKey;
    } while (start);

    return items;
  }

  // ConsistentRead because the SPA reads a target back immediately after
  // creating it; an eventually-consistent GetItem can 404 on the id it was just
  // handed. Costs one extra read unit on a table this small.
  async get(id: string): Promise<Target | null> {
    const out = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { id },
        ConsistentRead: true,
      }),
    );
    return (out.Item as Target | undefined) ?? null;
  }

  async put(target: Target): Promise<void> {
    await this.client.send(
      new PutCommand({ TableName: this.table, Item: target }),
    );
  }

  async delete(id: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({ TableName: this.table, Key: { id } }),
    );
  }
}

// One repository per execution environment, built lazily so `getConfig()` runs
// on first use (not import). `setTargetsRepository` is a test seam.
let repo: TargetsRepository | undefined;

export const getTargetsRepository = (): TargetsRepository => {
  repo ??= new DynamoTargetsRepository();
  return repo;
};

export const setTargetsRepository = (fake: TargetsRepository): void => {
  repo = fake;
};

export const resetTargetsRepository = (): void => {
  repo = undefined;
};

/** The coordinates a rule operation needs to reach a target's table. */
export interface ResolvedTarget {
  region: string;
  tableName: string;
  roleArn?: string;
}

/**
 * Resolves a target id to the coordinates rule operations use. Every rule route
 * calls this first, so an unknown target is a 404 rather than being mistaken for
 * a valid one — and it is the single choke point where per-target authorization
 * attaches in ER-205.
 */
export const resolveTarget = async (id: string): Promise<ResolvedTarget> => {
  const target = await getTargetsRepository().get(id);
  if (!target) {
    throw new ApiError(404, "UNKNOWN_TARGET", `No target with id "${id}"`);
  }
  return {
    region: target.region,
    tableName: target.tableName,
    ...(target.roleArn ? { roleArn: target.roleArn } : {}),
  };
};
