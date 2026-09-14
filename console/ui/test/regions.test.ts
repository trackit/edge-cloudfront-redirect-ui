import { describe, expect, it } from "vitest";
import { FALLBACK_REGIONS, regionOptions } from "../src/regions";

describe("regionOptions", () => {
  it("sorts what the deployment allows", () => {
    expect(regionOptions(["us-east-1", "eu-west-1"], "us-east-1")).toEqual([
      "eu-west-1",
      "us-east-1",
    ]);
  });

  it("keeps a current region the deployment no longer allows", () => {
    /*
      The case that would otherwise corrupt a stored distribution. A `<select>`
      whose value is absent from its options renders blank, and the next change
      event writes whatever the user picked over a region they never touched —
      so an environment narrowed after a distribution was connected would
      quietly rewrite it on the way past Settings.

      Showing it is not the same as endorsing it: the API refuses it on save,
      which is where that argument belongs.
    */
    expect(regionOptions(["us-east-1"], "eu-west-1")).toEqual([
      "eu-west-1",
      "us-east-1",
    ]);
  });

  it("does not duplicate the current region", () => {
    expect(regionOptions(["us-east-1", "eu-west-1"], "eu-west-1")).toEqual([
      "eu-west-1",
      "us-east-1",
    ]);
  });

  it("offers no empty option for a draft with no region yet", () => {
    // The connect screen starts with "", which must not become a blank choice
    // the user can submit.
    expect(regionOptions(["us-east-1"], "")).toEqual(["us-east-1"]);
  });

  it("never returns nothing to choose from", () => {
    // A dropdown with no options is a form nobody can complete.
    expect(regionOptions(FALLBACK_REGIONS, "").length).toBeGreaterThan(0);
  });
});
