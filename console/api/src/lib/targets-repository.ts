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
 * target. 404/409 semantics live in the handlers; this stays thin data access.
 */
export class DynamoTargetsRepository implements TargetsRepository {
  private readonly table = getConfig().targetsTableName;
  private readonly client = docClient(getConfig().region);

  async create(target: Target): Promise<void> {
    await this.client.send(
      new PutCommand({ TableName: this.table, Item: target }),
    );
  }

  async list(): Promise<Target[]> {
    const out = await this.client.send(
      new ScanCommand({ TableName: this.table }),
    );
    return (out.Items ?? []) as Target[];
  }

  async get(id: string): Promise<Target | null> {
    const out = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { id } }),
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

/**
 * Resolves a target id to the DynamoDB table coordinates rule operations use
 * (ER-203). Throws `404 UNKNOWN_TARGET` when the id is not registered.
 */
export const resolveTarget = async (
  id: string,
): Promise<{ region: string; tableName: string }> => {
  const target = await getTargetsRepository().get(id);
  if (!target) {
    throw new ApiError(404, "UNKNOWN_TARGET", `No target with id "${id}"`);
  }
  return { region: target.region, tableName: target.tableName };
};
