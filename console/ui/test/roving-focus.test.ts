import { describe, expect, it } from "vitest";
import { nextIndex } from "../src/domain/rovingFocus";

/**
 * Keyboard movement through the country chips: one tab stop for the whole
 * grid, the arrows within it. The DOM wiring is the e2e's job; where focus
 * should go is decided here.
 */
describe("nextIndex", () => {
  it("moves by one on left/right, and stops at the ends", () => {
    expect(nextIndex("ArrowRight", 0, 5, 3)).toBe(1);
    expect(nextIndex("ArrowLeft", 0, 5, 3)).toBe(0);
    expect(nextIndex("ArrowRight", 4, 5, 3)).toBe(4);
  });

  it("moves by a row on up/down", () => {
    expect(nextIndex("ArrowDown", 1, 10, 3)).toBe(4);
    expect(nextIndex("ArrowDown", 8, 10, 3)).toBe(9);
    expect(nextIndex("ArrowUp", 1, 10, 3)).toBe(0);
    expect(nextIndex("ArrowUp", 7, 10, 3)).toBe(4);
  });

  it("treats a layout it could not measure as one column", () => {
    expect(nextIndex("ArrowDown", 1, 10, 0)).toBe(2);
  });

  it("jumps to the ends on Home/End", () => {
    expect(nextIndex("Home", 4, 10, 3)).toBe(0);
    expect(nextIndex("End", 4, 10, 3)).toBe(9);
  });

  it("ignores every other key, Space and Enter included", () => {
    for (const key of ["a", " ", "Enter", "Tab"]) {
      expect(nextIndex(key, 4, 10, 3)).toBeNull();
    }
  });
});
