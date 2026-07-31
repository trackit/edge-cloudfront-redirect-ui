import type {
  MoveOutcome,
  RuleItem,
  RulesRepository,
} from "../src/lib/rules-repository.js";

/**
 * In-memory rules table for tests — same semantics as the DynamoDB version, for
 * one target. Items are keyed by the full primary key, so a host only ever sees
 * its own rules, and insertion order is deliberately not sort order: a caller
 * that forgets to sort must fail.
 */
export class FakeRulesRepository implements RulesRepository {
  private items = new Map<string, RuleItem>();

  constructor(seed: RuleItem[] = []) {
    for (const item of seed) this.items.set(this.key(item.pk, item.sk), item);
  }

  // JSON rather than a delimiter: nothing a host or an sk can contain collides,
  // and unlike a control character it leaves this file as text git can diff.
  private key(pk: string, sk: string): string {
    return JSON.stringify([pk, sk]);
  }

  listByHost(host: string): Promise<RuleItem[]> {
    const rules = [...this.items.values()].filter((item) => item.pk === host);
    return Promise.resolve(rules);
  }

  get(host: string, sk: string): Promise<RuleItem | null> {
    return Promise.resolve(this.items.get(this.key(host, sk)) ?? null);
  }

  delete(host: string, sk: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(this.key(host, sk)));
  }

  create(item: RuleItem): Promise<boolean> {
    const key = this.key(item.pk, item.sk);
    if (this.items.has(key)) return Promise.resolve(false);

    this.items.set(key, item);
    return Promise.resolve(true);
  }

  replace(item: RuleItem): Promise<boolean> {
    const key = this.key(item.pk, item.sk);
    if (!this.items.has(key)) return Promise.resolve(false);

    this.items.set(key, item);
    return Promise.resolve(true);
  }

  // All-or-nothing, like the transaction it stands in for: on either refusal the
  // table is left exactly as it was. A move to the key it is already at is a
  // replace — matching DynamoRulesRepository, which cannot put one item in a
  // transaction twice.
  move(fromSk: string, item: RuleItem): Promise<MoveOutcome> {
    const from = this.key(item.pk, fromSk);
    if (!this.items.has(from)) return Promise.resolve("missing");
    if (fromSk === item.sk) {
      this.items.set(from, item);
      return Promise.resolve("moved");
    }
    if (this.items.has(this.key(item.pk, item.sk))) {
      return Promise.resolve("occupied");
    }

    this.items.delete(from);
    this.items.set(this.key(item.pk, item.sk), item);
    return Promise.resolve("moved");
  }
}
