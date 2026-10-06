import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeoCheckStore } from "../src/domain/geoReadiness";
import type { GeoCheck } from "../src/api";

/**
 * The editor's memory of geo checks: what is asked again and what is not. The
 * API keeps its own answer for a minute, so this only spares a round trip —
 * but a stale answer here is one the user cannot get rid of without a reload,
 * which is what "Re-check" and the two-minute limit are for.
 */

const body = {
  kind: "rewrite" as const,
  matches: [
    { matchType: "country", matchOperator: "equals", matchValue: "FR" },
  ] as never[],
};
const answer = {
  readiness: { status: "unknown", cause: "transient", reason: "r" },
  decision: { outcome: "unverifiable", relevant: [], ambiguous: false },
} as GeoCheck;

describe("createGeoCheckStore", () => {
  it("asks once for the same rule within two minutes, and again after", async () => {
    let now = 0;
    const asked: boolean[] = [];
    const store = createGeoCheckStore({
      fetch: (_t, _b, fresh) => {
        asked.push(fresh);
        return Promise.resolve(answer);
      },
      now: () => now,
    });
    await store.get("t1", body);
    await store.get("t1", body);
    now = 120_001;
    await store.get("t1", body);
    expect(asked).toEqual([false, false]);
  });

  it("asks again for a different rule", async () => {
    let n = 0;
    const store = createGeoCheckStore({
      fetch: () => {
        n++;
        return Promise.resolve(answer);
      },
    });
    await store.get("t1", body);
    await store.get("t1", { ...body, kind: "redirect" });
    expect(n).toBe(2);
  });

  it("refresh bypasses the memory and asks the API for a fresh reading", async () => {
    const asked: boolean[] = [];
    const store = createGeoCheckStore({
      fetch: (_t, _b, fresh) => {
        asked.push(fresh);
        return Promise.resolve(answer);
      },
    });
    await store.get("t1", body);
    await store.refresh("t1", body);
    await store.get("t1", body);
    expect(asked).toEqual([false, true]);
  });

  it("forgets a failed request so the next one retries", async () => {
    let n = 0;
    const store = createGeoCheckStore({
      fetch: () =>
        ++n === 1
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(answer),
    });
    await expect(store.get("t1", body)).rejects.toThrow("offline");
    await expect(store.get("t1", body)).resolves.toBe(answer);
  });

  describe("a request that never answers", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails after the timeout, so no save waits forever, and is retried next time", async () => {
      vi.useFakeTimers();
      let n = 0;
      const store = createGeoCheckStore({
        fetch: () => {
          n++;
          return n === 1
            ? new Promise<GeoCheck>(() => {})
            : Promise.resolve(answer);
        },
        timeoutMs: 1000,
      });

      const hung = store.get("t1", body);
      const outcome = expect(hung).rejects.toThrow(/did not answer/);
      await vi.advanceTimersByTimeAsync(1000);
      await outcome;

      await expect(store.get("t1", body)).resolves.toBe(answer);
      expect(n).toBe(2);
    });
  });
});
