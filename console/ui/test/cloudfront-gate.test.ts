import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Tests the CloudFront Function that fronts the console distribution.
 *
 * The function lives in `infra/gate.js.tftpl` because Terraform renders the
 * credential into it, so it is not importable: the template is read, the one
 * placeholder is substituted, and the result is evaluated here. That keeps the
 * test honest about what gets deployed — a hand-copied version of the logic would
 * pass while the deployed file was broken.
 *
 * What this cannot check is whether CloudFront accepts the file. The runtime is
 * not ES2015+ everywhere and there is no local emulator, so the deployed function
 * is only proven by `aws cloudfront test-function` or a real request.
 *
 * It lives in this workspace because the template is deployed by this workspace's
 * infra and this is the workspace with a test runner.
 */
const TEMPLATE = fileURLToPath(
  new URL("../infra/gate.js.tftpl", import.meta.url),
);

const USERNAME = "demo";
const PASSWORD = "correct-horse-battery";
const CREDENTIAL = Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");

interface CfHeaders {
  [name: string]: { value: string };
}

interface CfRequest {
  uri: string;
  headers: CfHeaders;
}

interface CfResponse {
  statusCode?: number;
  statusDescription?: string;
  headers?: CfHeaders;
}

type Handler = (event: { request: CfRequest }) => CfRequest | CfResponse;

let handler: Handler;

beforeAll(() => {
  const rendered = readFileSync(TEMPLATE, "utf8")
    // What Terraform's templatefile() does: the one variable, then the `$$`
    // escape that lets the file document `${...}` without being interpolated.
    .replace(/\$\{credential\}/g, CREDENTIAL)
    .replace(/\$\$\{/g, "${");

  // The template is a script, not a module: evaluate it and hand back `handler`.
  handler = new Function(`${rendered}\nreturn handler;`)() as Handler;
});

const request = (uri: string, authorization = `Basic ${CREDENTIAL}`) =>
  handler({
    request: {
      uri,
      headers:
        authorization === "" ? {} : { authorization: { value: authorization } },
    },
  });

const isResponse = (result: CfRequest | CfResponse): result is CfResponse =>
  "statusCode" in result;

describe("basic auth", () => {
  it("challenges a request with no Authorization header", () => {
    const result = request("/console", "");

    expect(isResponse(result)).toBe(true);
    const response = result as CfResponse;
    expect(response.statusCode).toBe(401);
    // Without this the browser renders the body instead of prompting.
    expect(response.headers?.["www-authenticate"]?.value).toMatch(
      /^Basic realm=/,
    );
  });

  it("challenges a wrong credential", () => {
    const wrong = Buffer.from(`${USERNAME}:wrong`).toString("base64");

    expect(
      (request("/console", `Basic ${wrong}`) as CfResponse).statusCode,
    ).toBe(401);
  });

  it("does not let a 401 be cached, so a fixed credential is not shadowed", () => {
    const response = request("/console", "") as CfResponse;

    expect(response.headers?.["cache-control"]?.value).toBe("no-store");
  });

  it("challenges the API path too, not just the SPA", () => {
    // The console being behind auth is worth little if /api/targets is not.
    expect((request("/api/targets", "") as CfResponse).statusCode).toBe(401);
  });

  it("lets the right credential through", () => {
    expect(isResponse(request("/console"))).toBe(false);
  });
});

describe("the /api prefix", () => {
  it("strips it, because the API serves /health not /api/health", () => {
    expect((request("/api/health") as CfRequest).uri).toBe("/health");
  });

  it("strips it from a nested path", () => {
    expect((request("/api/targets/abc/hosts") as CfRequest).uri).toBe(
      "/targets/abc/hosts",
    );
  });

  it("maps a bare /api to the API's root", () => {
    expect((request("/api") as CfRequest).uri).toBe("/");
    expect((request("/api/") as CfRequest).uri).toBe("/");
  });

  it("does not rewrite an API path to index.html", () => {
    // The fallback below must not swallow API requests: /api/hosts has no file
    // extension either.
    expect((request("/api/hosts") as CfRequest).uri).not.toBe("/index.html");
  });

  it("does not treat a path that merely starts with 'api' as an API path", () => {
    // /apidocs is a console route, so it gets the SPA, not the API with a
    // mangled path.
    expect((request("/apidocs") as CfRequest).uri).toBe("/index.html");
  });
});

describe("SPA routing", () => {
  it("serves index.html for a client-side route", () => {
    expect((request("/console") as CfRequest).uri).toBe("/index.html");
  });

  it("serves index.html for a host route whose segment contains dots", () => {
    // The reason the file check is an allowlist rather than "the last segment has
    // a dot": this path ends in something that looks exactly like an extension.
    expect(
      (request("/console/hosts/d111abcdef8.cloudfront.net") as CfRequest).uri,
    ).toBe("/index.html");
  });

  it("leaves the root alone for the default root object", () => {
    expect((request("/") as CfRequest).uri).toBe("/");
  });

  it("leaves hashed build assets alone", () => {
    expect((request("/assets/index-a1b2c3.js") as CfRequest).uri).toBe(
      "/assets/index-a1b2c3.js",
    );
  });

  it("leaves a root static file alone", () => {
    expect((request("/favicon.svg") as CfRequest).uri).toBe("/favicon.svg");
  });

  it("does not mistake a route containing an extension-like segment for a file", () => {
    expect(
      (request("/console/hosts/site.js.example.com") as CfRequest).uri,
    ).toBe("/index.html");
  });
});
