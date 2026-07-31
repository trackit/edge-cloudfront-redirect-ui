import { describe, expect, it } from "vitest";
import { buildSk, padPriority, parseSk } from "../src/lib/rule-keys.js";
import { ApiError } from "../src/lib/errors.js";

describe("padPriority", () => {
  it("pads to the five digits the shared schemas pin down", () => {
    expect(padPriority(100)).toBe("00100");
    expect(padPriority(0)).toBe("00000");
    expect(padPriority(99999)).toBe("99999");
  });

  it("keeps lexicographic order equal to numeric order", () => {
    // The whole reason for padding: unpadded, "100" sorts after "9".
    const sorted = [9, 100, 1000].map(padPriority).sort();
    expect(sorted).toEqual(["00009", "00100", "01000"]);
  });
});

describe("buildSk", () => {
  it("maps each rule type to its sort-key prefix", () => {
    expect(buildSk("erMatchRule", 100)).toBe("REDIRECT#00100");
    expect(buildSk("frMatchRule", 100)).toBe("REWRITE#00100");
  });

  const unrepresentable = [
    ["over the five-digit width", 100000],
    ["negative", -1],
    ["fractional", 1.5],
    ["not a number at all", Number.NaN],
  ] as const;

  it.each(unrepresentable)("refuses a priority that is %s", (_label, value) => {
    // Padding one of these produces a key parseSk then rejects — an item that
    // lists but that no fetch, update or delete can ever address again.
    expect(() => buildSk("erMatchRule", value)).toThrow(
      expect.objectContaining({
        status: 400,
        code: "VALIDATION_ERROR",
      }) as Error,
    );
  });
});

describe("parseSk", () => {
  it("round-trips every priority buildSk accepts", () => {
    for (const priority of [0, 1, 100, 9999, 99999]) {
      expect(parseSk(buildSk("erMatchRule", priority))).toEqual({
        kind: "REDIRECT",
        priority,
      });
      expect(parseSk(buildSk("frMatchRule", priority))).toEqual({
        kind: "REWRITE",
        priority,
      });
    }
  });

  const malformed = [
    ["an unpadded priority", "REDIRECT#100"],
    ["an over-long priority", "REDIRECT#000100"],
    ["a non-numeric priority", "REDIRECT#abcde"],
    ["a lower-case kind", "redirect#00100"],
    ["an unknown kind", "REWRITTEN#00100"],
    ["no separator", "REDIRECT00100"],
    ["a trailing segment", "REDIRECT#00100#2"],
    ["an empty string", ""],
    // The router decodes path params, so a still-encoded `#` means the client
    // double-encoded it — it addresses no item either way.
    ["a still-encoded separator", "REDIRECT%2300100"],
  ] as const;

  it.each(malformed)("rejects %s", (_label, sk) => {
    expect(() => parseSk(sk)).toThrow(ApiError);
    // A path that could not name an item is the caller's URL being wrong, not a
    // body field the `details` array could point at.
    expect(() => parseSk(sk)).toThrow(
      expect.objectContaining({ status: 400, code: "BAD_REQUEST" }) as Error,
    );
  });
});
