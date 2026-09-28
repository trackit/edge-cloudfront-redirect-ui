import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type {
  CachePolicyConfig,
  DistributionConfig,
  OriginRequestPolicyConfig,
} from "@aws-sdk/client-cloudfront";
import { handler } from "../src/handler.js";
import {
  cachePolicyFacts,
  distributionIdOf,
  evaluateDistribution,
  originRequestFacts,
  resetGeoReadinessChecker,
  setGeoReadinessChecker,
  type CachePolicyFacts,
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

const NO_CACHE: CachePolicyFacts = { caches: false, keyHeaders: [] };
const CACHES: CachePolicyFacts = { caches: true, keyHeaders: [] };
const CACHES_PER_COUNTRY: CachePolicyFacts = {
  caches: true,
  keyHeaders: ["CloudFront-Viewer-Country"],
};
const FORWARDS_COUNTRY: OriginRequestFacts = {
  forwardedHeaders: ["x-edgeroute-viewer-host", "CloudFront-Viewer-Country"],
};
const FORWARDS_NOTHING: OriginRequestFacts = { forwardedHeaders: [] };

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

describe("evaluateDistribution", () => {
  it("is ok when nothing is cached and the country is forwarded", () => {
    // The examples/infra setup, tested end to end on a sandbox.
    expect(verdictOf(NO_CACHE, FORWARDS_COUNTRY)).toEqual({
      status: "ok",
      distributionId: ID,
      behaviors: [{ pathPattern: "*", verdict: "ok" }],
    });
  });

  it("is ok when the behavior caches per country", () => {
    expect(verdictOf(CACHES_PER_COUNTRY, FORWARDS_NOTHING).status).toBe("ok");
  });

  it("flags a behavior that caches with the country only forwarded", () => {
    // The silent case: the function gets the country, but only on a miss.
    expect(verdictOf(CACHES, FORWARDS_COUNTRY)).toMatchObject({
      status: "misconfigured",
      behaviors: [{ pathPattern: "*", verdict: "cachedWithoutCountry" }],
    });
  });

  it("flags a behavior that never asks for the country", () => {
    expect(verdictOf(NO_CACHE, FORWARDS_NOTHING)).toMatchObject({
      status: "misconfigured",
      behaviors: [{ verdict: "countryNotForwarded" }],
    });
  });

  it("flags a behavior with no origin request policy and no country key", () => {
    expect(
      verdictOf(NO_CACHE, FORWARDS_NOTHING, {
        OriginRequestPolicyId: undefined,
      }).status,
    ).toBe("misconfigured");
  });

  it("matches the header name case-insensitively", () => {
    expect(
      verdictOf(
        { caches: true, keyHeaders: ["cloudfront-viewer-country"] },
        FORWARDS_NOTHING,
      ).status,
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
      status: "misconfigured",
      behaviors: [{ verdict: "noOriginRequest" }],
    });
  });

  it("checks every behavior running the function, and skips the others", () => {
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
      status: "misconfigured",
      distributionId: ID,
      behaviors: [
        { pathPattern: "*", verdict: "ok" },
        { pathPattern: "/campaign/*", verdict: "cachedWithoutCountry" },
      ],
    });
  });

  it("assumes a cache policy it could not read caches", () => {
    // Warning on a policy that turns out fine is the cheaper mistake.
    expect(
      evaluateDistribution(
        ID,
        distribution(behavior()),
        new Map(),
        new Map([["origin-req", FORWARDS_COUNTRY]]),
      ).status,
    ).toBe("misconfigured");
  });

  it("reads the legacy cache settings of a behavior with no cache policy", () => {
    const legacy = (headers: string[], maxTtl: number) =>
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
      ).status;

    expect(legacy(["CloudFront-Viewer-Country"], 86400)).toBe("ok");
    expect(legacy(["*"], 86400)).toBe("ok");
    expect(legacy(["Host"], 86400)).toBe("misconfigured");
  });

  it("is unknown when no behavior runs a function", () => {
    expect(
      verdictOf(NO_CACHE, FORWARDS_COUNTRY, {
        LambdaFunctionAssociations: { Quantity: 0, Items: [] },
      }).status,
    ).toBe("unknown");
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
    ).toEqual({ caches: false, keyHeaders: [] });
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
    ).toEqual({ caches: true, keyHeaders: ["CloudFront-Viewer-Country"] });
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
    });
    setTargetsRepository(targets);
    setGeoReadinessChecker((target) => {
      asked.push(target);
      return Promise.resolve({
        status: "misconfigured",
        distributionId: ID,
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
      status: "misconfigured",
    });
    expect(asked).toEqual([
      { name: ID, roleArn: "arn:aws:iam::123456789012:role/edge" },
    ]);
  });

  it("404s an unknown target", async () => {
    const res = await handler(event("/targets/nope/geo-readiness"));
    expect(res.statusCode).toBe(404);
  });
});
