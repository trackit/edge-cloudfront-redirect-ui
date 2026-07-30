import { describe, expect, it } from "vitest";
import { validateTarget } from "../src/lib/validate-target.js";
import { ApiError } from "../src/lib/errors.js";

const valid = {
  name: "Production",
  region: "us-east-1",
  tableName: "edgeroute-rules-prod",
};

describe("validateTarget", () => {
  it("accepts and returns a valid target", () => {
    expect(validateTarget(valid)).toEqual(valid);
  });

  it("rejects a missing or empty name", () => {
    expect(() =>
      validateTarget({ region: "us-east-1", tableName: "some-table" }),
    ).toThrowError(ApiError);
    expect(() => validateTarget({ ...valid, name: "" })).toThrowError(ApiError);
  });

  it("rejects a region that is well-formed but not real", () => {
    try {
      validateTarget({ ...valid, region: "us-east-11" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects an invalid tableName", () => {
    expect(() => validateTarget({ ...valid, tableName: "ab" })).toThrowError(
      ApiError,
    );
    expect(() =>
      validateTarget({ ...valid, tableName: "has space" }),
    ).toThrowError(ApiError);
  });

  it("rejects a client-supplied id (additionalProperties)", () => {
    expect(() => validateTarget({ ...valid, id: "abc" })).toThrowError(
      ApiError,
    );
  });

  it("rejects a name long enough to threaten the item size limit", () => {
    // Unbounded, a ~500 KB name pushes the item past DynamoDB's 400 KB limit and
    // the PutItem failure surfaces as an opaque 500 instead of a 400.
    expect(() =>
      validateTarget({ ...valid, name: "x".repeat(129) }),
    ).toThrowError(ApiError);
    expect(() =>
      validateTarget({ ...valid, name: "x".repeat(128) }),
    ).not.toThrow();
  });

  it("accepts a region added since the built-in list was written", () => {
    // The static list ages, and a stale list rejects a table the user owns.
    expect(() =>
      validateTarget({ ...valid, region: "mx-central-1" }),
    ).not.toThrow();
    expect(() =>
      validateTarget({ ...valid, region: "ap-southeast-5" }),
    ).not.toThrow();
  });

  it("reports field-level details", () => {
    try {
      validateTarget({ name: "", region: "nope", tableName: "" });
      expect.unreachable();
    } catch (err) {
      const e = err as ApiError;
      expect(Array.isArray(e.details)).toBe(true);
      expect((e.details as unknown[]).length).toBeGreaterThan(0);
    }
  });
});
