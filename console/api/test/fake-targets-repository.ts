import type {
  Target,
  TargetsRepository,
} from "../src/lib/targets-repository.js";

/** In-memory registry for tests — same semantics as the DynamoDB version. */
export class FakeTargetsRepository implements TargetsRepository {
  private items = new Map<string, Target>();

  constructor(seed: Target[] = []) {
    for (const t of seed) this.items.set(t.id, t);
  }

  create(target: Target): Promise<void> {
    this.items.set(target.id, target);
    return Promise.resolve();
  }

  list(): Promise<Target[]> {
    return Promise.resolve([...this.items.values()]);
  }

  get(id: string): Promise<Target | null> {
    return Promise.resolve(this.items.get(id) ?? null);
  }

  put(target: Target): Promise<void> {
    this.items.set(target.id, target);
    return Promise.resolve();
  }

  delete(id: string): Promise<void> {
    this.items.delete(id);
    return Promise.resolve();
  }
}
