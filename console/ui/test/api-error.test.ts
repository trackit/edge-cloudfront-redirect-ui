import { describe, expect, it } from "vitest";
import { ApiError, toApiError } from "../src/api/error";

/**
 * `toApiError` is the only thing standing between the console and
 * `body.error.code` on a body that has no `error` — which is every 4xx/5xx that
 * did not come from the API itself: API Gateway's pages, a proxy, a CDN, an
 * HTML login redirect.
 */

describe("toApiError", () => {
  it("reads a well-formed envelope", () => {
    const error = toApiError(409, {
      error: { code: "TARGET_EXISTS", message: "already registered" },
    });

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("TARGET_EXISTS");
    expect(error.message).toBe("already registered");
    expect(error.details).toEqual([]);
  });

  it("keeps details when they are an array", () => {
    const details = [{ path: "/region", message: "not allowed" }];
    expect(
      toApiError(400, { error: { code: "X", message: "m", details } }),
    ).toHaveProperty("details", details);
  });

  it("ignores details that are not an array", () => {
    const error = toApiError(400, {
      error: { code: "X", message: "m", details: "nope" },
    });

    // The onboarding screen maps over `details`, so a string here would be a
    // render crash rather than an error message.
    expect(error.details).toEqual([]);
  });

  it.each([
    ["an HTML page", "<html>504</html>"],
    ["no error key", { message: "boom" }],
    ["a null error", { error: null }],
    ["an error that is a string", { error: "boom" }],
    ["a code that is not a string", { error: { code: 500, message: "m" } }],
    ["no message", { error: { code: "INTERNAL" } }],
    ["undefined", undefined],
    ["null", null],
  ])("falls back to MALFORMED_RESPONSE for %s", (_case, body) => {
    const error = toApiError(500, body);

    expect(error.code).toBe("MALFORMED_RESPONSE");
    // The status is the one useful fact left, so it must survive.
    expect(error.status).toBe(500);
    expect(error.message).toContain("500");
  });
});

describe("ApiError", () => {
  it("is only a validation error for VALIDATION_ERROR", () => {
    const validation = new ApiError({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "m",
    });
    const other = new ApiError({
      status: 400,
      code: "BAD_REQUEST",
      message: "m",
    });

    expect(validation.isValidation).toBe(true);
    expect(other.isValidation).toBe(false);
  });

  it("is catchable as an Error and names itself", () => {
    const error = new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "m",
    });

    // `instanceof` is how every caller branches, and `name` is what shows up in
    // a console trace.
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
  });
});
