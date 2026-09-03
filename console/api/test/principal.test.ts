import { describe, expect, it } from "vitest";
import {
  canWrite,
  parseGroups,
  principalFrom,
  roleOf,
} from "../src/lib/principal.js";
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

/**
 * Building the principal from the two things the Lambda is handed.
 *
 * The split under test: the authorizer context decides *whether* there is a
 * principal, because its presence is the only proof the gateway verified
 * anything. The token supplies the *shape* of the claims, because the context
 * has flattened them into a string format we would otherwise be guessing at.
 */
describe("principalFrom", () => {
  const bearer = (payload: unknown): string =>
    `Bearer ${[
      Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      "signature-checked-by-the-gateway",
    ].join(".")}`;

  const flattened = {
    sub: "user-1",
    email: "editor@example.com",
    // How API Gateway delivers the claim to a Lambda.
    "cognito:groups": "[editor viewer]",
  };

  it("has no principal without an authorizer, whatever the header says", () => {
    // A public route. Nothing verified the token, so a caller could have written
    // it themselves — reading it here is how a self-signed editor gets in.
    expect(
      principalFrom(undefined, bearer({ sub: "attacker", groups: ["editor"] })),
    ).toBeUndefined();
  });

  it("has no principal when the claims carry no usable sub", () => {
    expect(principalFrom({}, undefined)).toBeUndefined();
    expect(principalFrom({ sub: "" }, undefined)).toBeUndefined();
    expect(principalFrom({ sub: 42 }, undefined)).toBeUndefined();
  });

  it("prefers the token's array over the context's flattened string", () => {
    const result = principalFrom(
      flattened,
      bearer({ sub: "user-1", "cognito:groups": ["editor", "viewer"] }),
    );

    expect(result).toEqual({
      sub: "user-1",
      email: "editor@example.com",
      groups: ["editor", "viewer"],
    });
  });

  it("falls back to the flattened claims when there is no header", () => {
    // Still works, just via the parser we would rather not depend on. This is
    // the path every existing suite takes, so it has to keep working.
    expect(principalFrom(flattened, undefined)).toEqual({
      sub: "user-1",
      email: "editor@example.com",
      groups: ["editor", "viewer"],
    });
  });

  it("falls back when the token is not decodable", () => {
    expect(principalFrom(flattened, "Bearer not-a-jwt")).toEqual({
      sub: "user-1",
      email: "editor@example.com",
      groups: ["editor", "viewer"],
    });
  });

  it("ignores a token whose sub disagrees with the verified context", () => {
    // Identity comes from the context either way, so the danger is only the
    // groups. A mismatch means something upstream is wrong in a way this code
    // cannot adjudicate, so it trusts the verified side and nothing else.
    const result = principalFrom(
      { sub: "user-1", "cognito:groups": "[viewer]" },
      bearer({ sub: "user-2", "cognito:groups": ["editor"] }),
    );

    expect(result).toEqual({ sub: "user-1", groups: ["viewer"] });
  });

  it("reads an email only when there is one to read", () => {
    expect(principalFrom({ sub: "user-1" }, bearer({ sub: "user-1" }))).toEqual(
      { sub: "user-1", groups: [] },
    );
  });
});
