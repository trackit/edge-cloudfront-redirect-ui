import { describe, expect, it } from "vitest";
import {
  EMPTY,
  migrateLegacy,
  parseStored,
  reduceConnect,
  reduceReplaceCurrent,
  reduceSelect,
  type Stored,
} from "../src/distribution";
import type { Distribution } from "../src/types";

/**
 * The store's pure half: what a stored string parses to, and what each mutation
 * does. All of it is reachable without a DOM, which is why it lives outside the
 * hook — the hook is now three `setStored` calls and nothing else.
 *
 * These read from localStorage in production, so the input is whatever was there
 * last time: another build's shape, a half-written value, or an entry a user
 * edited by hand. Every case below has a browser that can produce it.
 */

const dist = (over: Partial<Distribution> = {}): Distribution => ({
  targetId: "t-1",
  distributionId: "E1",
  tableName: "rules-prod",
  region: "us-east-1",
  ...over,
});

const stored = (distributions: Distribution[], current: string | null) =>
  JSON.stringify({ distributions, current });

describe("EMPTY", () => {
  /**
   * One object is shared by every empty console — each `parseStored` failure
   * path and the hook's initial state all return this exact value, so a write
   * through any of them is a write for all the others. `Stored` being readonly
   * is the real guard; these pin the runtime backstop, including the array,
   * which a plain `Object.freeze` on the object would leave writable.
   */
  it("cannot be written through", () => {
    expect(() => (EMPTY.distributions as Distribution[]).push(dist())).toThrow(
      TypeError,
    );
    expect(() => {
      (EMPTY as { current: string | null }).current = "E1";
    }).toThrow(TypeError);

    expect(EMPTY).toEqual({ distributions: [], current: null });
  });
});

describe("parseStored", () => {
  it("reads back what the hook wrote", () => {
    const a = dist();
    const b = dist({ targetId: "t-2", distributionId: "E2" });

    expect(parseStored(stored([a, b], "E2"))).toEqual({
      distributions: [a, b],
      current: "E2",
    });
  });

  it("treats an absent key as empty", () => {
    expect(parseStored(null)).toEqual(EMPTY);
  });

  it.each([
    ["not JSON at all", "{oh no"],
    ["a JSON scalar", '"E1"'],
    ["null", "null"],
    ["no distributions array", '{"current":"E1"}'],
    ["distributions of the wrong type", '{"distributions":{},"current":null}'],
  ])("falls back to empty for %s", (_case, raw) => {
    expect(parseStored(raw)).toEqual(EMPTY);
  });

  it("drops one corrupt entry and keeps the rest", () => {
    const good = dist();
    // A shape from a build that predates `targetId` — the console cannot address
    // any rules with it, but the entries beside it are still usable, and losing
    // them would send the user back to the connect screen for someone else's bug.
    const raw = JSON.stringify({
      distributions: [
        { distributionId: "E0", tableName: "t", region: "r" },
        good,
      ],
      current: "E1",
    });

    expect(parseStored(raw)).toEqual({ distributions: [good], current: "E1" });
  });

  it("falls back to the first entry when current names a dropped one", () => {
    const good = dist();
    const raw = JSON.stringify({
      distributions: [good, { distributionId: "E9" }],
      current: "E9",
    });

    // The selection must never point outside the list — the console reads
    // `current` to decide what to render.
    expect(parseStored(raw)).toEqual({ distributions: [good], current: "E1" });
  });

  it("falls back to the first entry when current is missing or not a string", () => {
    const a = dist();
    const b = dist({ targetId: "t-2", distributionId: "E2" });

    expect(parseStored(JSON.stringify({ distributions: [a, b] }))).toEqual({
      distributions: [a, b],
      current: "E1",
    });
    expect(
      parseStored(JSON.stringify({ distributions: [a, b], current: 7 })),
    ).toEqual({ distributions: [a, b], current: "E1" });
  });

  it("has no selection when every entry was dropped", () => {
    expect(
      parseStored('{"distributions":[{"nope":1}],"current":"E1"}'),
    ).toEqual(EMPTY);
  });
});

describe("migrateLegacy", () => {
  it("promotes the old single distribution to a one-entry list", () => {
    const only = dist();

    // A browser that connected before the switcher shipped. Without this it
    // would land on the connect screen with its environment apparently gone.
    expect(migrateLegacy(JSON.stringify(only))).toEqual({
      distributions: [only],
      current: "E1",
    });
  });

  it("is empty when there is no legacy value, or it is unusable", () => {
    expect(migrateLegacy(null)).toEqual(EMPTY);
    expect(migrateLegacy("{oh no")).toEqual(EMPTY);
    // Predates `targetId`: shaped like a distribution, useless as one.
    expect(
      migrateLegacy('{"distributionId":"E1","tableName":"t","region":"r"}'),
    ).toEqual(EMPTY);
  });
});

describe("reduceConnect", () => {
  it("appends and selects", () => {
    const a = dist();
    const b = dist({ targetId: "t-2", distributionId: "E2" });

    expect(reduceConnect({ distributions: [a], current: "E1" }, b)).toEqual({
      distributions: [a, b],
      current: "E2",
    });
  });

  it("replaces an entry with the same distribution ID instead of duplicating", () => {
    const a = dist();
    // Same distribution, now served by a different table. Two rows naming one
    // distribution is not something the menu could tell apart.
    const moved = dist({ targetId: "t-9", tableName: "rules-new" });

    expect(reduceConnect({ distributions: [a], current: "E1" }, moved)).toEqual(
      {
        distributions: [moved],
        current: "E1",
      },
    );
  });

  it("does not mutate the previous state", () => {
    const prev: Stored = { distributions: [dist()], current: "E1" };
    // Snapshot, not just a length: an in-place edit of the existing entry keeps
    // the count and would slip past a `toHaveLength`. React renders from the
    // previous state, so a reducer that writes into it is a stale-render bug.
    const before = structuredClone(prev);

    reduceConnect(prev, dist({ distributionId: "E2" }));

    expect(prev).toEqual(before);
  });
});

describe("reduceReplaceCurrent", () => {
  it("edits in place, keeping the entry's position", () => {
    const a = dist();
    const b = dist({ targetId: "t-2", distributionId: "E2" });
    const c = dist({ targetId: "t-3", distributionId: "E3" });
    const edited = dist({
      targetId: "t-2",
      distributionId: "E2",
      region: "eu-west-1",
    });

    // Position matters: the menu lists these, and reordering under the user on
    // a settings save is disorienting.
    expect(
      reduceReplaceCurrent({ distributions: [a, b, c], current: "E2" }, edited),
    ).toEqual({ distributions: [a, edited, c], current: "E2" });
  });

  it("dedupes when the edit renames onto another entry's ID", () => {
    const a = dist();
    const b = dist({ targetId: "t-2", distributionId: "E2" });
    // Editing E2's ID to E1, which E1 already holds. The older row goes.
    const renamed = dist({ targetId: "t-2", distributionId: "E1" });

    expect(
      reduceReplaceCurrent({ distributions: [a, b], current: "E2" }, renamed),
    ).toEqual({ distributions: [renamed], current: "E1" });
  });

  it("appends when the selection points at nothing", () => {
    const value = dist();

    // Only reachable if `current` and the list disagree; parseStored prevents
    // that on load, so this is the belt to its braces.
    expect(reduceReplaceCurrent(EMPTY, value)).toEqual({
      distributions: [value],
      current: "E1",
    });
  });
});

describe("reduceSelect", () => {
  it("switches to an entry in the list", () => {
    const a = dist();
    const b = dist({ targetId: "t-2", distributionId: "E2" });

    expect(
      reduceSelect({ distributions: [a, b], current: "E1" }, "E2"),
    ).toEqual({ distributions: [a, b], current: "E2" });
  });

  it("returns the same state for an id that is not there", () => {
    const prev: Stored = { distributions: [dist()], current: "E1" };

    // Identity, not just equality: React bails out of the re-render when the
    // reducer hands back the state it was given.
    expect(reduceSelect(prev, "E-nope")).toBe(prev);
  });
});
