import { describe, expect, it } from "vitest";
import {
  AWS_REGIONS,
  OPT_IN_REGIONS,
  getAllowedRegions,
  isValidRegion,
} from "../src/lib/aws-regions.js";

describe("getAllowedRegions", () => {
  it("falls back to the built-in list when ALLOWED_REGIONS is unset", () => {
    expect(getAllowedRegions({})).toEqual(new Set(AWS_REGIONS));
  });

  it("replaces the built-in list entirely when set", () => {
    // The point of the override: restrict to what this deployment can reach, so
    // an opt-in region the account never enabled stops being accepted.
    const allowed = getAllowedRegions({
      ALLOWED_REGIONS: "us-east-1,eu-west-1",
    });

    expect(allowed).toEqual(new Set(["us-east-1", "eu-west-1"]));
    expect(allowed.has("af-south-1")).toBe(false);
  });

  it("tolerates spacing and blank entries", () => {
    expect(
      getAllowedRegions({ ALLOWED_REGIONS: " us-east-1 , ,eu-west-1," }),
    ).toEqual(new Set(["us-east-1", "eu-west-1"]));
  });

  it("falls back rather than rejecting everything when the value is blank", () => {
    // A misconfigured empty string must not brick target creation.
    expect(getAllowedRegions({ ALLOWED_REGIONS: "  ," })).toEqual(
      new Set(AWS_REGIONS),
    );
  });
});

describe("isValidRegion", () => {
  it("rejects a well-formed region that does not exist", () => {
    expect(isValidRegion("us-east-11", {})).toBe(false);
  });

  it("honours the override", () => {
    expect(isValidRegion("eu-west-1", { ALLOWED_REGIONS: "us-east-1" })).toBe(
      false,
    );
  });
});

describe("OPT_IN_REGIONS", () => {
  it("only names regions that are in the built-in list", () => {
    // A drifted entry here would document a region the API never accepts.
    for (const region of OPT_IN_REGIONS) {
      expect(AWS_REGIONS as readonly string[]).toContain(region);
    }
  });
});
