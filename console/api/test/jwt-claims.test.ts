import { describe, expect, it } from "vitest";
import { bearerToken, decodeJwtPayload } from "../src/lib/jwt-claims.js";

/**
 * Reading a verified token's payload.
 *
 * Nothing here verifies anything, and that is the point — the gateway has
 * already done it. What these cover is that a malformed or hostile-looking token
 * produces `undefined` rather than an exception, because the caller's fallback is
 * the authorizer's own claims and a throw would turn a worse-shaped-but-valid
 * request into a 500.
 */

const jwt = (payload: unknown): string =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature-not-checked-here",
  ].join(".");

describe("bearerToken", () => {
  it("takes the token out of a Bearer header", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("is case-insensitive on the scheme and tolerates extra space", () => {
    // Clients spell this inconsistently and the RFC makes the scheme
    // case-insensitive, so matching only "Bearer " would drop real tokens.
    expect(bearerToken("bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("  Bearer   abc.def.ghi  ")).toBe("abc.def.ghi");
  });

  it("is empty for anything that is not a Bearer header", () => {
    expect(bearerToken(undefined)).toBe("");
    expect(bearerToken("")).toBe("");
    expect(bearerToken("Basic dXNlcjpwYXNz")).toBe("");
    expect(bearerToken("Bearer")).toBe("");
    expect(bearerToken("Bearer a b")).toBe("");
  });
});

describe("decodeJwtPayload", () => {
  it("reads the claims, with cognito:groups as the array the token carries", () => {
    // The whole reason this module exists: here the claim is a real array, where
    // the authorizer context would have flattened it to "[editor viewer]".
    expect(
      decodeJwtPayload(
        jwt({ sub: "user-1", "cognito:groups": ["editor", "viewer"] }),
      ),
    ).toEqual({ sub: "user-1", "cognito:groups": ["editor", "viewer"] });
  });

  it("decodes base64url, not plain base64", () => {
    // A payload whose base64 contains + and / — decoded as plain base64 this
    // still parses, so a wrong implementation fails only on some tokens.
    const payload = { sub: "user-1", note: "ÿÿÿ?>?>" };
    expect(decodeJwtPayload(jwt(payload))).toEqual(payload);
  });

  it("is undefined when there are not three segments", () => {
    expect(decodeJwtPayload("")).toBeUndefined();
    expect(decodeJwtPayload("only.two")).toBeUndefined();
    expect(decodeJwtPayload("a.b.c.d")).toBeUndefined();
  });

  it("is undefined for a payload that is not JSON", () => {
    const notJson = Buffer.from("not json").toString("base64url");
    expect(decodeJwtPayload(`header.${notJson}.sig`)).toBeUndefined();
  });

  it("is undefined for JSON that is not a claim set", () => {
    // `typeof` calls both of these "object"; neither is a set of claims, and
    // indexing them later would silently produce undefined for every claim.
    expect(decodeJwtPayload(jwt(["editor"]))).toBeUndefined();
    expect(decodeJwtPayload(jwt(null))).toBeUndefined();
    expect(decodeJwtPayload(jwt("a string"))).toBeUndefined();
  });
});
