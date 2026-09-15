import { describe, expect, it } from "vitest";
import {
  isNoOpSlot,
  moveToSlot,
  slotFromMidpoints,
  stepSlot,
} from "../src/reorder";

/**
 * The list arithmetic behind drag-to-reorder. All of it is pure, which is the
 * point: the gap-versus-index confusion this module exists to contain is the
 * kind of off-by-one a browser test reports as "the rule went one row too far".
 *
 * The drag gesture itself — pointer capture, the insertion line, the arrow keys
 * — is DOM behaviour and belongs to the Playwright suite.
 */

const LIST = ["a", "b", "c", "d"];

describe("moveToSlot", () => {
  it.each([
    ["the first row to the end", 0, 4, ["b", "c", "d", "a"]],
    ["the last row to the top", 3, 0, ["d", "a", "b", "c"]],
    ["a middle row up one", 2, 1, ["a", "c", "b", "d"]],
    ["a middle row down one", 1, 3, ["a", "c", "b", "d"]],
    ["a row across the list", 1, 4, ["a", "c", "d", "b"]],
  ])("moves %s", (_case, from, slot, expected) => {
    expect(moveToSlot(LIST, from, slot)).toEqual(expected);
  });

  it.each([
    ["the gap above it", 2, 2],
    ["the gap below it", 2, 3],
  ])("leaves the list alone for %s", (_case, from, slot) => {
    // Both gaps either side of a row are that row's own position. Numbering
    // them from the pre-lift list is what makes the two distinct values mean
    // the same place.
    expect(moveToSlot(LIST, from, slot)).toEqual(LIST);
  });

  it("does not mutate the list it was given", () => {
    const original = [...LIST];

    moveToSlot(LIST, 0, 3);

    expect(LIST).toEqual(original);
  });

  it("returns the list unchanged for a row that is not in it", () => {
    // Defensive: an index from a stale render must not produce a list with an
    // `undefined` row in it, which would then be sent as an order.
    expect(moveToSlot(LIST, 9, 0)).toEqual(LIST);
  });
});

describe("slotFromMidpoints", () => {
  // Four 40px rows with a 10px gap, as the list renders them.
  const midpoints = [120, 170, 220, 270];

  it.each([
    ["above the first row", 100, 0],
    ["just past the first midpoint", 121, 1],
    ["between two rows", 195, 2],
    ["below the last row", 400, 4],
  ])("puts a pointer %s in gap %i", (_case, y, expected) => {
    expect(slotFromMidpoints(midpoints, y)).toBe(expected);
  });

  it("switches at the midpoint, not at the border", () => {
    // Half way is what keeps the insertion line following the cursor instead of
    // jumping as it crosses each card's edge.
    expect(slotFromMidpoints(midpoints, 119)).toBe(0);
    expect(slotFromMidpoints(midpoints, 120)).toBe(0);
    expect(slotFromMidpoints(midpoints, 121)).toBe(1);
  });

  it("is gap 0 for a list with no rows", () => {
    expect(slotFromMidpoints([], 500)).toBe(0);
  });
});

describe("isNoOpSlot", () => {
  it.each([
    ["its own gap", 1, 1, true],
    ["the gap below it", 1, 2, true],
    ["one gap higher", 1, 0, false],
    ["two gaps lower", 1, 3, false],
  ])("reads %s as %s", (_case, from, slot, expected) => {
    expect(isNoOpSlot(from, slot)).toBe(expected);
  });
});

describe("stepSlot", () => {
  it("moves a row past the one above it", () => {
    expect(moveToSlot(LIST, 2, stepSlot(2, "up"))).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
  });

  it("moves a row past the one below it", () => {
    // `from + 2`, not `from + 1`: the nearer gap is the row's own position, so
    // an arrow key there would do nothing at all.
    expect(moveToSlot(LIST, 1, stepSlot(1, "down"))).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
  });

  it.each([
    ["up", "up" as const, 0],
    ["down", "down" as const, 3],
  ])("is never a no-op when stepping %s", (_case, direction, from) => {
    expect(isNoOpSlot(from, stepSlot(from, direction))).toBe(false);
  });
});
