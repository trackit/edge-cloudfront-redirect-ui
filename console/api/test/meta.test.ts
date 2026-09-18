import { afterEach, describe, expect, it } from "vitest";
import { AWS_REGIONS } from "../src/lib/aws-regions.js";
import { meta } from "../src/handlers/meta.js";

/**
 * `GET /meta` exists so the console stops carrying its own copy of this list,
 * so what matters is that it reports what the *running* deployment validates
 * against — not what the code shipped with.
 */

const regions = (): string[] => (meta().body as { regions: string[] }).regions;

const original = process.env["ALLOWED_REGIONS"];

afterEach(() => {
  if (original === undefined) delete process.env["ALLOWED_REGIONS"];
  else process.env["ALLOWED_REGIONS"] = original;
});

describe("GET /meta", () => {
  it("answers 200", () => {
    expect(meta().status).toBe(200);
  });

  it("serves the built-in region list when nothing is configured", () => {
    delete process.env["ALLOWED_REGIONS"];

    expect(regions()).toEqual([...AWS_REGIONS].sort());
  });

  it("serves exactly what ALLOWED_REGIONS names", () => {
    // The case the bug was about: a deployment narrowed to one region, where a
    // console guessing from its own list offers six it cannot have.
    process.env["ALLOWED_REGIONS"] = "us-east-1";

    expect(regions()).toEqual(["us-east-1"]);
  });

  it("sorts, whatever order the operator typed", () => {
    process.env["ALLOWED_REGIONS"] = "eu-west-3,us-east-1,ap-northeast-1";

    expect(regions()).toEqual(["ap-northeast-1", "eu-west-3", "us-east-1"]);
  });

  it("reads the environment per request, not once at import", () => {
    // The handler is a module-level const in a warm Lambda, so a value captured
    // at import would outlive a redeploy that changed it.
    process.env["ALLOWED_REGIONS"] = "us-east-1";
    expect(regions()).toEqual(["us-east-1"]);

    process.env["ALLOWED_REGIONS"] = "eu-west-1";
    expect(regions()).toEqual(["eu-west-1"]);
  });
});
