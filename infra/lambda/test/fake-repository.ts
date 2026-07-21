import type { RuleRepository } from "../src/dynamodb-repository.js";
import type { RedirectRule } from "../src/rule-types.js";

/**
 * In-memory stand-in for the DynamoDB table. `queryByPrefix` reproduces
 * `pk = host AND begins_with(sk, prefix)` with ascending sort-key order.
 */
export class FakeRepository implements RuleRepository {
  queryCount = 0;

  constructor(private readonly items: RedirectRule[] = []) {}

  async queryByPrefix<T>(pk: string, skPrefix: string): Promise<T[]> {
    this.queryCount++;
    return this.items
      .filter((item) => item.pk === pk && item.sk.startsWith(skPrefix))
      .sort((a, b) => a.sk.localeCompare(b.sk)) as T[];
  }
}
