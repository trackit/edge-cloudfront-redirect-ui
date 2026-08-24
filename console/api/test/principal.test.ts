import { describe, expect, it } from "vitest";
import { canWrite, parseGroups, roleOf } from "../src/lib/principal.js";
import type { Principal } from "../src/lib/principal.js";

/**
 * Reading a role off a verified token.
 *
 * Nothing here validates the token — the gateway has already checked signature,
 * issuer, audience and expiry. What is left is deciding what the caller may do,
 * and the awkward part of that is `cognito:groups` not having one spelling.
 */

const principal = (groups: string[]): Principal => ({ sub: "user-1", groups });

describe("parseGroups", () => {
  it("reads the array a decoded token carries", () => {
    expect(parseGroups(["editor", "viewer"])).toEqual(["editor", "viewer"]);
  });

  it("reads the bracketed string API Gateway flattens it into", () => {
    // The same claim, delivered differently depending on the path it took to the
    // Lambda. Getting this wrong means every group lookup silently misses and
    // every authenticated user looks role-less.
    expect(parseGroups("[editor viewer]")).toEqual(["editor", "viewer"]);
  });

  it("reads a single group either way", () => {
    expect(parseGroups("[editor]")).toEqual(["editor"]);
    expect(parseGroups("editor")).toEqual(["editor"]);
  });

  it("reads a comma-separated string too", () => {
    expect(parseGroups("editor, viewer")).toEqual(["editor", "viewer"]);
  });

  it("is empty for a user in no group", () => {
    expect(parseGroups(undefined)).toEqual([]);
    expect(parseGroups("[]")).toEqual([]);
    expect(parseGroups("")).toEqual([]);
  });

  it("is empty for a claim that is neither array nor string", () => {
    expect(parseGroups(42)).toEqual([]);
    expect(parseGroups(null)).toEqual([]);
  });
});

describe("roleOf", () => {
  it("names the role the user holds", () => {
    expect(roleOf(principal(["viewer"]))).toBe("viewer");
    expect(roleOf(principal(["editor"]))).toBe("editor");
  });

  it("prefers editor when the user is in both", () => {
    // Being added to viewer as well should not take write access away.
    expect(roleOf(principal(["viewer", "editor"]))).toBe("editor");
  });

  it("is undefined for a user in no role group", () => {
    // Deliberately not a fallback to viewer: "created but not yet assigned"
    // should not be a state that grants a view of every target and rule.
    expect(roleOf(principal([]))).toBeUndefined();
    expect(roleOf(principal(["some-other-group"]))).toBeUndefined();
  });
});

describe("canWrite", () => {
  it("is true only for an editor", () => {
    expect(canWrite(principal(["editor"]))).toBe(true);
    expect(canWrite(principal(["viewer"]))).toBe(false);
    expect(canWrite(principal([]))).toBe(false);
  });
});
