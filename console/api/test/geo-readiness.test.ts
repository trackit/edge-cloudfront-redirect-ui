import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  GetCachePolicyCommand,
  GetDistributionConfigCommand,
  GetOriginRequestPolicyCommand,
  type CachePolicyConfig,
  type DistributionConfig,
  type OriginRequestPolicyConfig,
} from "@aws-sdk/client-cloudfront";
import { handler } from "../src/handler.js";
import {
  cachePolicyFacts,
  checkGeoReadiness,
  distributionIdOf,
  evaluateDistribution,
  originRequestFacts,
  unqualified,
  resetCloudFrontFactory,
  resetGeoReadinessChecker,
  setCloudFrontFactory,
  setGeoReadinessChecker,
  type CachePolicyFacts,
  type GeoReadiness,
  type OriginRequestFacts,
  type ReadinessTarget,
} from "../src/lib/geo-readiness.js";
import {
  resetTargetsRepository,
  setTargetsRepository,
} from "../src/lib/targets-repository.js";
import { FakeTargetsRepository } from "./fake-targets-repository.js";
import { VIEWER } from "./principal-claims.js";

const ID = "EQFO7A1FE1EPJ";

const ORIGIN_REQUEST = {
  Quantity: 2,
  Items: [
    { EventType: "viewer-request", LambdaFunctionARN: "arn:fn:1" },
    { EventType: "origin-request", LambdaFunctionARN: "arn:fn:1" },
  ],
};

const behavior = (over: Record<string, unknown> = {}) => ({
  TargetOriginId: "origin",
  ViewerProtocolPolicy: "redirect-to-https",
  CachePolicyId: "cache",
  OriginRequestPolicyId: "origin-req",
  LambdaFunctionAssociations: ORIGIN_REQUEST,
  ...over,
});

const distribution = (
  defaultBehavior: Record<string, unknown>,
  others: Record<string, unknown>[] = [],
): DistributionConfig =>
  ({
    DefaultCacheBehavior: defaultBehavior,
    CacheBehaviors: { Quantity: others.length, Items: others },
  }) as unknown as DistributionConfig;

const NO_CACHE: CachePolicyFacts = {
  caches: false,
  cachesByDefault: false,
  keyHeaders: [],
};
const CACHES: CachePolicyFacts = {
  caches: true,
  cachesByDefault: true,
  keyHeaders: [],
};
const CACHES_PER_COUNTRY: CachePolicyFacts = {
  caches: true,
  cachesByDefault: true,
  keyHeaders: ["CloudFront-Viewer-Country", "X-EdgeRoute-Viewer-Host"],
};
const FORWARDS_COUNTRY: OriginRequestFacts = {
  forwardedHeaders: ["x-edgeroute-viewer-host", "CloudFront-Viewer-Country"],
  forwardsAllViewer: false,
  exceptHeaders: [],
};
const FORWARDS_NOTHING: OriginRequestFacts = {
  forwardedHeaders: [],
  forwardsAllViewer: false,
  exceptHeaders: [],
};
// What these two fixtures leave out is the point of the tests using them.
const FORWARDS_ONLY_HOST: OriginRequestFacts = {
  forwardedHeaders: ["X-EdgeRoute-Viewer-Host"],
  forwardsAllViewer: false,
  exceptHeaders: [],
};
const NO_CACHE_HOST_IN_KEY: CachePolicyFacts = {
  caches: false,
  cachesByDefault: false,
  keyHeaders: ["X-EdgeRoute-Viewer-Host"],
};
const FORWARDS_ONLY_COUNTRY: OriginRequestFacts = {
  forwardedHeaders: ["CloudFront-Viewer-Country"],
  forwardsAllViewer: false,
  exceptHeaders: [],
};

const verdictOf = (
  cache: CachePolicyFacts,
  originRequest: OriginRequestFacts,
  over: Record<string, unknown> = {},
) =>
  evaluateDistribution(
    ID,
    distribution(behavior(over)),
    new Map([["cache", cache]]),
    new Map([["origin-req", originRequest]]),
  );

/** The verdict of a one-behavior distribution, or the status when unknown. */
const only = (result: GeoReadiness): string | undefined =>
  result.status === "checked" ? result.behaviors[0]?.verdict : result.status;

describe("evaluateDistribution", () => {
  it("is ok when nothing is cached and the country is forwarded", () => {
    // The examples/infra setup, tested end to end on a sandbox.
    expect(verdictOf(NO_CACHE, FORWARDS_COUNTRY)).toEqual({
      status: "checked",
      distributionId: ID,
      functionIdentified: false,
      behaviors: [{ pathPattern: "*", verdict: "ok" }],
    });
  });

  it("is ok when the behavior caches per country", () => {
    expect(only(verdictOf(CACHES_PER_COUNTRY, FORWARDS_NOTHING))).toBe("ok");
  });

  it("flags a behavior that caches with the country only forwarded", () => {
    // The silent case: the function gets the country, but only on a miss.
    expect(verdictOf(CACHES, FORWARDS_COUNTRY)).toMatchObject({
      status: "checked",
      behaviors: [{ pathPattern: "*", verdict: "cachedWithoutCountry" }],
    });
  });

  it("flags a behavior that never asks for the country", () => {
    expect(verdictOf(NO_CACHE, FORWARDS_ONLY_HOST)).toMatchObject({
      status: "checked",
      behaviors: [{ verdict: "countryNotForwarded" }],
    });
  });

  it("flags a behavior with no origin request policy and no country key", () => {
    expect(
      only(
        verdictOf(NO_CACHE_HOST_IN_KEY, FORWARDS_NOTHING, {
          OriginRequestPolicyId: undefined,
        }),
      ),
    ).toBe("countryNotForwarded");
  });

  it("matches the header name case-insensitively", () => {
    expect(
      only(
        verdictOf(
          {
            caches: true,
            cachesByDefault: true,
            keyHeaders: [
              "cloudfront-viewer-country",
              "x-edgeroute-viewer-host",
            ],
          },
          FORWARDS_NOTHING,
        ),
      ),
    ).toBe("ok");
  });

  it("flags a function associated at viewer-request only", () => {
    expect(
      verdictOf(NO_CACHE, FORWARDS_COUNTRY, {
        LambdaFunctionAssociations: {
          Quantity: 1,
          Items: [{ EventType: "viewer-request", LambdaFunctionARN: "arn" }],
        },
      }),
    ).toMatchObject({
      status: "checked",
      behaviors: [{ verdict: "noOriginRequest" }],
    });
  });

  it("judges every behavior, and marks the ones without a function notOurs", () => {
    const result = evaluateDistribution(
      ID,
      distribution(behavior(), [
        behavior({ PathPattern: "/campaign/*", CachePolicyId: "caching" }),
        behavior({
          PathPattern: "/static/*",
          LambdaFunctionAssociations: { Quantity: 0, Items: [] },
        }),
      ]),
      new Map([
        ["cache", NO_CACHE],
        ["caching", CACHES],
      ]),
      new Map([["origin-req", FORWARDS_COUNTRY]]),
    );

    expect(result).toEqual({
      status: "checked",
      distributionId: ID,
      functionIdentified: false,
      behaviors: [
        { pathPattern: "/campaign/*", verdict: "cachedWithoutCountry" },
        { pathPattern: "/static/*", verdict: "notOurs" },
        { pathPattern: "*", verdict: "ok" },
      ],
    });
  });

  it("assumes a cache policy it could not read caches", () => {
    // Warning on a policy that turns out fine is the cheaper mistake.
    expect(
      only(
        evaluateDistribution(
          ID,
          distribution(behavior()),
          new Map(),
          new Map([["origin-req", FORWARDS_COUNTRY]]),
        ),
      ),
    ).toBe("cachedWithoutCountry");
  });

  it("reads the legacy cache settings of a behavior with no cache policy", () => {
    const legacy = (headers: string[], maxTtl: number) =>
      only(
        evaluateDistribution(
          ID,
          distribution(
            behavior({
              CachePolicyId: undefined,
              OriginRequestPolicyId: undefined,
              MaxTTL: maxTtl,
              ForwardedValues: { Headers: { Quantity: 1, Items: headers } },
            }),
          ),
          new Map(),
          new Map(),
        ),
      );

    expect(
      legacy(["CloudFront-Viewer-Country", "X-EdgeRoute-Viewer-Host"], 86400),
    ).toBe("ok");
    expect(legacy(["CloudFront-Viewer-Country"], 86400)).toBe(
      "viewerHostMissing",
    );
    expect(legacy(["*"], 86400)).toBe("ok");
    expect(legacy(["Host", "X-EdgeRoute-Viewer-Host"], 86400)).toBe(
      "countryNotForwarded",
    );
  });

  it("is unknown when no behavior runs a function", () => {
    expect(
      verdictOf(NO_CACHE, FORWARDS_COUNTRY, {
        LambdaFunctionAssociations: { Quantity: 0, Items: [] },
      }),
    ).toMatchObject({ status: "unknown", cause: "noFunction" });
  });

  const OURS = "arn:aws:lambda:us-east-1:123456789012:function:edge";
  const assoc = (arn: string) => ({
    Quantity: 2,
    Items: [
      { EventType: "viewer-request", LambdaFunctionARN: `${arn}:3` },
      { EventType: "origin-request", LambdaFunctionARN: `${arn}:3` },
    ],
  });

  it("lists cache behaviors first and the default last, as CloudFront matches them", () => {
    const result = evaluateDistribution(
      ID,
      distribution(behavior(), [
        behavior({ PathPattern: "/geo/*" }),
        behavior({ PathPattern: "/img/*" }),
      ]),
      new Map([["cache", NO_CACHE]]),
      new Map([["origin-req", FORWARDS_COUNTRY]]),
    );
    expect(
      result.status === "checked" && result.behaviors.map((b) => b.pathPattern),
    ).toEqual(["/geo/*", "/img/*", "*"]);
  });

  it("marks a behavior running another function notOurs, comparing ARNs without version", () => {
    const result = evaluateDistribution(
      ID,
      distribution(behavior({ LambdaFunctionAssociations: assoc(OURS) }), [
        behavior({
          PathPattern: "/api/*",
          LambdaFunctionAssociations: assoc(
            "arn:aws:lambda:us-east-1:123456789012:function:someone-else",
          ),
        }),
      ]),
      new Map([["cache", CACHES]]),
      new Map([["origin-req", FORWARDS_COUNTRY]]),
      OURS,
    );
    expect(result).toEqual({
      status: "checked",
      distributionId: ID,
      functionIdentified: true,
      behaviors: [
        { pathPattern: "/api/*", verdict: "notOurs" },
        { pathPattern: "*", verdict: "cachedWithoutCountry" },
      ],
    });
  });

  it("is unknown/noFunction when no behavior runs the named function", () => {
    expect(
      evaluateDistribution(
        ID,
        distribution(behavior()),
        new Map([["cache", NO_CACHE]]),
        new Map([["origin-req", FORWARDS_COUNTRY]]),
        OURS,
      ),
    ).toMatchObject({
      status: "unknown",
      cause: "noFunction",
      reason: expect.stringContaining(OURS),
    });
  });

  it("flags a behavior where the viewer host never reaches origin-request", () => {
    expect(only(verdictOf(NO_CACHE, FORWARDS_ONLY_COUNTRY))).toBe(
      "viewerHostMissing",
    );
  });

  it("flags a behavior with origin-request but no viewer-request association", () => {
    expect(
      only(
        verdictOf(NO_CACHE, FORWARDS_COUNTRY, {
          LambdaFunctionAssociations: {
            Quantity: 1,
            Items: [
              { EventType: "origin-request", LambdaFunctionARN: "arn:fn:1" },
            ],
          },
        }),
      ),
    ).toBe("viewerHostMissing");
  });

  it("counts allViewer as forwarding the viewer host, which our viewer-request adds", () => {
    expect(
      only(
        // allViewerAndWhitelistCloudFront: the one behavior that both names
        // the country and forwards every viewer header.
        verdictOf(NO_CACHE, {
          forwardedHeaders: ["CloudFront-Viewer-Country"],
          forwardsAllViewer: true,
          exceptHeaders: [],
        }),
      ),
    ).toBe("ok");
  });

  it("does not count allExcept when it excludes the viewer host", () => {
    expect(
      only(
        verdictOf(NO_CACHE, {
          forwardedHeaders: ["CloudFront-Viewer-Country"],
          forwardsAllViewer: true,
          exceptHeaders: ["X-EdgeRoute-Viewer-Host"],
        }),
      ),
    ).toBe("viewerHostMissing");
  });

  it("only warns when the policy caches solely on the origin's say-so", () => {
    expect(
      only(
        verdictOf(
          { caches: true, cachesByDefault: false, keyHeaders: [] },
          FORWARDS_COUNTRY,
        ),
      ),
    ).toBe("cachedByOriginHeaders");
  });

  it("strips a version or $LATEST from an ARN", () => {
    expect(unqualified(`${OURS}:12`)).toBe(OURS);
    expect(unqualified(`${OURS}:$LATEST`)).toBe(OURS);
    expect(unqualified(OURS)).toBe(OURS);
  });
});

describe("policy facts", () => {
  it("reads Managed-CachingDisabled as not caching", () => {
    expect(
      cachePolicyFacts({
        Name: "Managed-CachingDisabled",
        MinTTL: 0,
        DefaultTTL: 0,
        MaxTTL: 0,
      } as CachePolicyConfig),
    ).toEqual({ caches: false, cachesByDefault: false, keyHeaders: [] });
  });

  it("reads the whitelisted headers of a caching policy as its key", () => {
    expect(
      cachePolicyFacts({
        Name: "geo",
        MinTTL: 0,
        MaxTTL: 86400,
        ParametersInCacheKeyAndForwardedToOrigin: {
          HeadersConfig: {
            HeaderBehavior: "whitelist",
            Headers: { Quantity: 1, Items: ["CloudFront-Viewer-Country"] },
          },
        },
      } as CachePolicyConfig),
    ).toEqual({
      caches: true,
      cachesByDefault: false,
      keyHeaders: ["CloudFront-Viewer-Country"],
    });
  });

  it("reads MinTTL and DefaultTTL into cachesByDefault", () => {
    const facts = (DefaultTTL: number) =>
      cachePolicyFacts({
        Name: "p",
        MinTTL: 0,
        DefaultTTL,
        MaxTTL: 31536000,
      } as CachePolicyConfig);
    expect(facts(0)).toMatchObject({ caches: true, cachesByDefault: false });
    expect(facts(86400)).toMatchObject({ caches: true, cachesByDefault: true });
  });

  it("reads allExcept and allViewer from an origin request policy", () => {
    const facts = (HeaderBehavior: string) =>
      originRequestFacts({
        Name: "p",
        HeadersConfig: {
          HeaderBehavior,
          Headers: { Quantity: 1, Items: ["x-a"] },
        },
      } as OriginRequestPolicyConfig);
    expect(facts("allExcept")).toEqual({
      forwardedHeaders: [],
      forwardsAllViewer: true,
      exceptHeaders: ["x-a"],
    });
    expect(facts("allViewer")).toMatchObject({
      forwardsAllViewer: true,
      exceptHeaders: [],
    });
    expect(facts("whitelist")).toMatchObject({ forwardsAllViewer: false });
  });

  it("does not count allViewer as forwarding CloudFront headers", () => {
    const facts = (HeaderBehavior: string) =>
      originRequestFacts({
        Name: "p",
        HeadersConfig: {
          HeaderBehavior,
          Headers: { Quantity: 1, Items: ["CloudFront-Viewer-Country"] },
        },
      } as OriginRequestPolicyConfig);

    expect(facts("allViewer").forwardedHeaders).toEqual([]);
    expect(facts("allViewerAndWhitelistCloudFront").forwardedHeaders).toEqual([
      "CloudFront-Viewer-Country",
    ]);
    expect(facts("whitelist").forwardedHeaders).toEqual([
      "CloudFront-Viewer-Country",
    ]);
  });
});

describe("checkGeoReadiness", () => {
  let calls: string[] = [];
  let fail: Error | null = null;

  const named = (name: string): Error =>
    Object.assign(new Error(name), { name });
  const reads = () =>
    calls.filter((c) => c === "GetDistributionConfigCommand").length;

  beforeEach(() => {
    calls = [];
    fail = null;
    setCloudFrontFactory(() => ({
      send: (command: unknown) => {
        calls.push((command as object).constructor.name);
        if (fail) return Promise.reject(fail);
        if (command instanceof GetDistributionConfigCommand) {
          return Promise.resolve({
            DistributionConfig: distribution(behavior()),
          });
        }
        if (command instanceof GetCachePolicyCommand) {
          return Promise.resolve({
            CachePolicy: {
              CachePolicyConfig: {
                Name: "c",
                MinTTL: 0,
                DefaultTTL: 0,
                MaxTTL: 0,
              },
            },
          });
        }
        if (command instanceof GetOriginRequestPolicyCommand) {
          return Promise.resolve({
            OriginRequestPolicy: {
              OriginRequestPolicyConfig: {
                Name: "o",
                HeadersConfig: {
                  HeaderBehavior: "whitelist",
                  Headers: {
                    Quantity: 2,
                    Items: [
                      "CloudFront-Viewer-Country",
                      "X-EdgeRoute-Viewer-Host",
                    ],
                  },
                },
              },
            },
          });
        }
        return Promise.reject(new Error("unexpected command"));
      },
    }));
  });

  afterEach(() => {
    resetCloudFrontFactory();
    resetGeoReadinessChecker();
  });

  it("reads the distribution and judges it", async () => {
    expect(await checkGeoReadiness({ name: ID })).toMatchObject({
      status: "checked",
      behaviors: [{ pathPattern: "*", verdict: "ok" }],
    });
  });

  it("reads once for two simultaneous checks", async () => {
    await Promise.all([
      checkGeoReadiness({ name: ID }),
      checkGeoReadiness({ name: ID }),
    ]);
    expect(reads()).toBe(1);
  });

  it("reuses a checked answer, and reads again when asked for a fresh one", async () => {
    await checkGeoReadiness({ name: ID });
    await checkGeoReadiness({ name: ID });
    await checkGeoReadiness({ name: ID }, { fresh: true });
    expect(reads()).toBe(2);
  });

  it("only blames IAM for an access denial", async () => {
    fail = named("AccessDenied");
    expect(await checkGeoReadiness({ name: ID })).toMatchObject({
      status: "unknown",
      cause: "accessDenied",
      reason: expect.stringContaining("cloudfront:GetDistributionConfig"),
    });
  });

  it("calls throttling transient, without naming permissions, and does not keep it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fail = named("Throttling");
    const first = await checkGeoReadiness({ name: ID });
    expect(first).toMatchObject({ status: "unknown", cause: "transient" });
    expect(first.status === "unknown" && first.reason).not.toContain(
      "cloudfront:",
    );
    fail = null;
    expect((await checkGeoReadiness({ name: ID })).status).toBe("checked");
  });

  it("calls only retryable failures transient", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const name of ["ThrottlingException", "TimeoutError", "ECONNRESET"]) {
      fail = named(name);
      expect(await checkGeoReadiness({ name: ID })).toMatchObject({
        cause: "transient",
      });
    }
    fail = Object.assign(named("InternalError"), {
      $metadata: { httpStatusCode: 503 },
    });
    expect(await checkGeoReadiness({ name: ID })).toMatchObject({
      cause: "transient",
    });
  });

  it("treats a credential failure as an access problem", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const name of ["CredentialsProviderError", "ExpiredTokenException"]) {
      fail = named(name);
      expect(await checkGeoReadiness({ name: ID })).toMatchObject({
        cause: "accessDenied",
      });
    }
  });

  it("calls anything else unexpected, never 'try again', and logs the error itself", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fail = new TypeError("cannot read properties of undefined");
    const answer = await checkGeoReadiness({ name: ID });
    expect(answer).toMatchObject({ status: "unknown", cause: "unexpected" });
    expect(answer.status === "unknown" && answer.reason).not.toMatch(
      /try again/i,
    );
    expect(warn.mock.calls[0]).toContain(fail);
  });

  it("keeps a good reading when a fresh read fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await checkGeoReadiness({ name: ID });
    fail = named("ThrottlingException");
    expect(
      (await checkGeoReadiness({ name: ID }, { fresh: true })).status,
    ).toBe("unknown");
    fail = null;
    calls = [];
    expect((await checkGeoReadiness({ name: ID })).status).toBe("checked");
    expect(reads()).toBe(0);
  });

  it("does not let an older read overwrite a fresh one, or drop it from the in-flight map", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    setCloudFrontFactory(() => ({
      send: async (command: unknown) => {
        calls.push((command as object).constructor.name);
        if (command instanceof GetDistributionConfigCommand && first) {
          first = false;
          await gate;
          throw named("ThrottlingException");
        }
        if (command instanceof GetDistributionConfigCommand) {
          return { DistributionConfig: distribution(behavior()) };
        }
        return {};
      },
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const older = checkGeoReadiness({ name: ID });
    const fresh = await checkGeoReadiness({ name: ID }, { fresh: true });
    expect(fresh.status).toBe("checked");
    release();
    await older;

    calls = [];
    expect((await checkGeoReadiness({ name: ID })).status).toBe("checked");
    expect(reads()).toBe(0);
  });

  it("keeps a noFunction answer, which only a deploy changes", async () => {
    setCloudFrontFactory(() => ({
      send: (command: unknown) => {
        calls.push((command as object).constructor.name);
        return Promise.resolve(
          command instanceof GetDistributionConfigCommand
            ? {
                DistributionConfig: distribution(
                  behavior({ LambdaFunctionAssociations: undefined }),
                ),
              }
            : {},
        );
      },
    }));
    await checkGeoReadiness({ name: ID });
    await checkGeoReadiness({ name: ID });
    expect(reads()).toBe(1);
  });

  it("maps NoSuchDistribution to notFound", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fail = named("NoSuchDistribution");
    expect(await checkGeoReadiness({ name: ID })).toMatchObject({
      cause: "notFound",
    });
  });
});

describe("distributionIdOf", () => {
  it("reads an ID or an ARN, and nothing else", () => {
    expect(distributionIdOf("EQFO7A1FE1EPJ")).toBe("EQFO7A1FE1EPJ");
    expect(
      distributionIdOf(
        "arn:aws:cloudfront::123456789012:distribution/EQFO7A1FE1EPJ",
      ),
    ).toBe("EQFO7A1FE1EPJ");
    expect(distributionIdOf("Prod")).toBeNull();
    expect(distributionIdOf("eqfo7a1fe1epj")).toBeNull();
  });
});

describe("GET /targets/{id}/geo-readiness", () => {
  let asked: ReadinessTarget[] = [];

  const event = (path: string): APIGatewayProxyEventV2 =>
    ({
      rawPath: path,
      headers: {},
      isBase64Encoded: false,
      // A viewer: the route is read-only, and what it says is not a secret.
      requestContext: { http: { method: "GET" }, ...VIEWER },
    }) as unknown as APIGatewayProxyEventV2;

  beforeEach(async () => {
    asked = [];
    const targets = new FakeTargetsRepository();
    await targets.create({
      id: "t1",
      name: ID,
      region: "us-east-1",
      tableName: "rules",
      roleArn: "arn:aws:iam::123456789012:role/edge",
      edgeFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:edge",
    });
    setTargetsRepository(targets);
    setGeoReadinessChecker((target) => {
      asked.push(target);
      return Promise.resolve({
        status: "checked",
        distributionId: ID,
        functionIdentified: true,
        behaviors: [{ pathPattern: "*", verdict: "cachedWithoutCountry" }],
      });
    });
  });

  afterEach(() => {
    resetTargetsRepository();
    resetGeoReadinessChecker();
  });

  it("answers the verdict, checked under the target's role", async () => {
    const res = await handler(event("/targets/t1/geo-readiness"));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "null")).toMatchObject({
      status: "checked",
    });
    expect(asked).toEqual([
      {
        name: ID,
        roleArn: "arn:aws:iam::123456789012:role/edge",
        edgeFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:edge",
      },
    ]);
  });

  it("404s an unknown target", async () => {
    const res = await handler(event("/targets/nope/geo-readiness"));
    expect(res.statusCode).toBe(404);
  });
});
