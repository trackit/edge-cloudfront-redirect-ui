import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontResultResponse,
} from "aws-lambda";
import type { MatchCondition, RedirectRule } from "../src/rule-types.js";
import { CloudfrontRequestEventMother } from "./cloudfront-request-event.mother.js";
import { FakeRepository } from "./fake-repository.js";
import { VIEWER_HOST_HEADER } from "../src/lib/viewer-host.js";

// The handler builds its own repository from baked config; swap in the fake so
// the rest of the pipeline (config -> service -> matcher -> response) runs real.
let repo = new FakeRepository();
vi.mock("../src/dynamodb-repository.js", () => ({
  DynamoDBRuleRepository: class {
    queryByPrefix<T>(pk: string, skPrefix: string): Promise<T[]> {
      return repo.queryByPrefix<T>(pk, skPrefix);
    }
  },
}));

const { handler, resetService } = await import("../src/index.js");

const HOST = "www.example.com";

const redirectRule = (over: Partial<RedirectRule> = {}): RedirectRule =>
  ({
    pk: HOST,
    sk: "REDIRECT#00100",
    type: "erMatchRule",
    statusCode: 301,
    redirectURL: "https://www.example.com/new-landing",
    matches: [
      {
        matchType: "path",
        matchOperator: "equals",
        matchValue: "/old-landing",
      },
    ],
    ...over,
  }) as RedirectRule;

const rewriteRule = (over: Partial<RedirectRule> = {}): RedirectRule =>
  ({
    pk: HOST,
    sk: "REWRITE#00200",
    type: "frMatchRule",
    matches: [
      { matchType: "path", matchOperator: "contains", matchValue: "/legacy/" },
    ],
    forwardSettings: {
      origin: {
        custom: {
          domainName: "legacy-backend.internal.example.com",
          path: "",
          port: 443,
          protocol: "https-only",
          sslProtocols: ["TLSv1.2"],
          readTimeout: 30,
          keepaliveTimeout: 5,
          customHeaders: {},
        },
      },
      pathAndQS: "/api/v1/legacy",
    },
    ...over,
  }) as RedirectRule;

const S3_ORIGIN = {
  s3: {
    authMethod: "origin-access-identity",
    region: "us-east-1",
    domainName: "example-assets.s3.us-east-1.amazonaws.com",
    path: "",
    customHeaders: {},
  },
} as const;

const withRules = (...rules: RedirectRule[]): void => {
  repo = new FakeRepository(rules);
  resetService();
};

beforeEach(() => {
  vi.stubEnv("RULES_TABLE_NAME", "test-rules");
  vi.stubEnv("RULES_TABLE_REGION", "us-east-1");
  withRules();
});

describe("viewer-request (redirects)", () => {
  it("returns a 301 response when a rule matches", async () => {
    withRules(redirectRule());

    const result = (await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .build(),
    )) as CloudFrontResultResponse;

    expect(result.status).toBe("301");
    expect(result.statusDescription).toBe("Moved Permanently");
    expect(result.headers?.["location"]?.[0]?.value).toBe(
      "https://www.example.com/new-landing",
    );
  });

  it("returns a 302 when the rule says so", async () => {
    withRules(redirectRule({ statusCode: 302 } as Partial<RedirectRule>));

    const result = (await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .build(),
    )) as CloudFrontResultResponse;

    expect(result.status).toBe("302");
    expect(result.statusDescription).toBe("Found");
  });

  it("appends the incoming query string when useIncomingQueryString is set", async () => {
    withRules(
      redirectRule({ useIncomingQueryString: true } as Partial<RedirectRule>),
    );

    const result = (await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .withQuerystring("utm=abc")
        .build(),
    )) as CloudFrontResultResponse;

    expect(result.headers?.["location"]?.[0]?.value).toBe(
      "https://www.example.com/new-landing?utm=abc",
    );
  });

  it("passes the request through when no rule matches", async () => {
    withRules(redirectRule());

    const event = CloudfrontRequestEventMother.viewerRequest()
      .withUri("/somewhere-else")
      .build();
    const result = await handler(event);

    expect(result).toBe(event.Records[0]!.cf.request);
    expect((result as CloudFrontResultResponse).status).toBeUndefined();
  });

  it("ignores REWRITE rules", async () => {
    withRules(rewriteRule());

    const result = await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/legacy/thing")
        .build(),
    );

    expect((result as CloudFrontResultResponse).status).toBeUndefined();
  });
});

describe("origin-request (rewrites)", () => {
  it("rewrites the path and switches to a custom origin", async () => {
    withRules(rewriteRule());

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/legacy/thing")
        .build(),
    )) as CloudFrontRequest;

    expect(result.uri).toBe("/api/v1/legacy");
    expect(result.origin?.custom?.domainName).toBe(
      "legacy-backend.internal.example.com",
    );
    // https-only is not a value CloudFront accepts on request.origin.
    expect(result.origin?.custom?.protocol).toBe("https");
    expect(result.headers["host"]?.[0]?.value).toBe(
      "legacy-backend.internal.example.com",
    );
  });

  it("switches to an s3 origin", async () => {
    withRules(
      rewriteRule({
        forwardSettings: { origin: S3_ORIGIN },
      } as Partial<RedirectRule>),
    );

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/legacy/thing")
        .build(),
    )) as CloudFrontRequest;

    expect(result.origin?.s3?.domainName).toBe(
      "example-assets.s3.us-east-1.amazonaws.com",
    );
    expect(result.headers["host"]?.[0]?.value).toBe(
      "example-assets.s3.us-east-1.amazonaws.com",
    );
    // Path untouched: this rule carries no pathAndQS.
    expect(result.uri).toBe("/legacy/thing");
  });

  it("rewrites the path without touching the origin", async () => {
    withRules(
      rewriteRule({
        forwardSettings: { pathAndQS: "/api/v1/legacy?flag=1" },
      } as Partial<RedirectRule>),
    );

    const event = CloudfrontRequestEventMother.originRequest()
      .withUri("/legacy/thing")
      .build();
    const originalOrigin = event.Records[0]!.cf.request.origin;

    const result = (await handler(event)) as CloudFrontRequest;

    expect(result.uri).toBe("/api/v1/legacy");
    expect(result.querystring).toBe("flag=1");
    expect(result.origin).toBe(originalOrigin);
  });

  it("resolves match-viewer per request, not once for the whole cache", async () => {
    withRules(
      rewriteRule({
        forwardSettings: {
          origin: {
            custom: {
              domainName: "backend.example.com",
              path: "",
              port: 443,
              protocol: "match-viewer",
              sslProtocols: ["TLSv1.2"],
              readTimeout: 30,
              keepaliveTimeout: 5,
              customHeaders: {},
            },
          },
          pathAndQS: "/api",
        },
      } as Partial<RedirectRule>),
    );

    const forProto = (proto: string): CloudFrontRequestEvent => {
      const event = CloudfrontRequestEventMother.originRequest()
        .withUri("/legacy/thing")
        .build();
      event.Records[0]!.cf.request.headers["x-forwarded-proto"] = [
        { key: "X-Forwarded-Proto", value: proto },
      ];
      return event;
    };

    // First request (http) primes the cache; a later https request served from
    // that cache must still resolve to https, not inherit the first protocol.
    const http = (await handler(forProto("http"))) as CloudFrontRequest;
    expect(http.origin?.custom?.protocol).toBe("http");

    const https = (await handler(forProto("https"))) as CloudFrontRequest;
    expect(https.origin?.custom?.protocol).toBe("https");
  });

  it("passes the request through when no rule matches", async () => {
    withRules(rewriteRule());

    const event = CloudfrontRequestEventMother.originRequest()
      .withUri("/modern/thing")
      .build();
    const result = (await handler(event)) as CloudFrontRequest;

    expect(result).toBe(event.Records[0]!.cf.request);
    expect(result.uri).toBe("/modern/thing");
    expect(result.origin?.s3?.domainName).toBe(
      "original-bucket.s3.amazonaws.com",
    );
  });

  it("ignores REDIRECT rules", async () => {
    withRules(redirectRule());

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/old-landing")
        .build(),
    )) as CloudFrontRequest;

    expect(result.uri).toBe("/old-landing");
  });
});

describe("disabled rules", () => {
  it("skips a disabled redirect rule", async () => {
    withRules(redirectRule({ disabled: true }));

    const result = await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .build(),
    );

    expect((result as CloudFrontResultResponse).status).toBeUndefined();
  });

  it("skips a disabled rewrite rule", async () => {
    withRules(rewriteRule({ disabled: true }));

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/legacy/thing")
        .build(),
    )) as CloudFrontRequest;

    expect(result.uri).toBe("/legacy/thing");
  });

  it("falls through to the next enabled rule when a higher-priority rule is disabled", async () => {
    withRules(
      redirectRule({
        sk: "REDIRECT#00001",
        disabled: true,
        redirectURL: "https://www.example.com/disabled",
      }),
      redirectRule({
        sk: "REDIRECT#00002",
        redirectURL: "https://www.example.com/enabled",
      }),
    );

    const result = (await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .build(),
    )) as CloudFrontResultResponse;

    expect(result.headers?.["location"]?.[0]?.value).toBe(
      "https://www.example.com/enabled",
    );
  });

  it("still applies a rule with disabled: false", async () => {
    withRules(redirectRule({ disabled: false }));

    const result = (await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .build(),
    )) as CloudFrontResultResponse;

    expect(result.status).toBe("301");
  });
});

describe("priority ordering", () => {
  it("applies the lowest sort key when several rules match", async () => {
    withRules(
      redirectRule({
        sk: "REDIRECT#00300",
        redirectURL: "https://www.example.com/third",
      }),
      redirectRule({
        sk: "REDIRECT#00010",
        redirectURL: "https://www.example.com/first",
      }),
      redirectRule({
        sk: "REDIRECT#00200",
        redirectURL: "https://www.example.com/second",
      }),
    );

    const result = (await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .build(),
    )) as CloudFrontResultResponse;

    expect(result.headers?.["location"]?.[0]?.value).toBe(
      "https://www.example.com/first",
    );
  });

  it("orders by zero-padded priority, not numeric string length", async () => {
    withRules(
      redirectRule({
        sk: "REDIRECT#00002",
        redirectURL: "https://www.example.com/priority-2",
      }),
      redirectRule({
        sk: "REDIRECT#00010",
        redirectURL: "https://www.example.com/priority-10",
      }),
    );

    const result = (await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .build(),
    )) as CloudFrontResultResponse;

    expect(result.headers?.["location"]?.[0]?.value).toBe(
      "https://www.example.com/priority-2",
    );
  });

  it("prefers a more specific rule only by priority, not specificity", async () => {
    withRules(
      redirectRule({
        sk: "REDIRECT#00001",
        redirectURL: "https://www.example.com/broad",
        matches: [
          { matchType: "path", matchOperator: "contains", matchValue: "/old" },
        ],
      }),
      redirectRule({
        sk: "REDIRECT#00002",
        redirectURL: "https://www.example.com/exact",
      }),
    );

    const result = (await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .build(),
    )) as CloudFrontResultResponse;

    expect(result.headers?.["location"]?.[0]?.value).toBe(
      "https://www.example.com/broad",
    );
  });
});

describe("the incoming query string on rewrites", () => {
  /** A rewrite whose forwardSettings are spelled out per case. */
  const rewriteForwarding = (
    forwardSettings: Record<string, unknown>,
  ): RedirectRule => rewriteRule({ forwardSettings } as Partial<RedirectRule>);

  const rewriting = async (rule: RedirectRule): Promise<CloudFrontRequest> => {
    withRules(rule);

    return (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/legacy/thing")
        .withQuerystring("a=1")
        .build(),
    )) as CloudFrontRequest;
  };

  it("replaces it with the query string the rule spells out", async () => {
    const result = await rewriting(
      rewriteForwarding({ pathAndQS: "/api/v1/legacy?x=1" }),
    );

    expect(result.querystring).toBe("x=1");
  });

  it("keeps it when the rule only switches origin", async () => {
    const result = await rewriting(rewriteForwarding({ origin: S3_ORIGIN }));

    expect(result.querystring).toBe("a=1");
  });

  // The case hand-written rules depend on: a path with no query of its own says
  // nothing about the incoming query string, so it is forwarded. Unchanged from
  // the upstream snippet, and deliberately not "fixed" along with the opt-out.
  it("keeps it when the rule's path carries no query string", async () => {
    const result = await rewriting(
      rewriteForwarding({ pathAndQS: "/api/v1/legacy" }),
    );

    expect(result.uri).toBe("/api/v1/legacy");
    expect(result.querystring).toBe("a=1");
  });

  it("keeps it when the rule opts in explicitly", async () => {
    const result = await rewriting(
      rewriteForwarding({
        pathAndQS: "/api/v1/legacy",
        useIncomingQueryString: true,
      }),
    );

    expect(result.querystring).toBe("a=1");
  });

  it("drops it when the rule opts out", async () => {
    const result = await rewriting(
      rewriteForwarding({
        pathAndQS: "/api/v1/legacy",
        useIncomingQueryString: false,
      }),
    );

    expect(result.uri).toBe("/api/v1/legacy");
    expect(result.querystring).toBe("");
  });

  it("drops it on an origin-only rewrite, without touching the path", async () => {
    const result = await rewriting(
      rewriteForwarding({ origin: S3_ORIGIN, useIncomingQueryString: false }),
    );

    expect(result.uri).toBe("/legacy/thing");
    expect(result.querystring).toBe("");
    expect(result.origin?.s3?.domainName).toBe(
      "example-assets.s3.us-east-1.amazonaws.com",
    );
  });

  it("prefers the rule's own query string over the opt-out", async () => {
    const result = await rewriting(
      rewriteForwarding({
        pathAndQS: "/api/v1/legacy?x=1",
        useIncomingQueryString: false,
      }),
    );

    expect(result.querystring).toBe("x=1");
  });

  it("keeps a literal ? inside the rule's query string", async () => {
    const result = await rewriting(
      rewriteForwarding({ pathAndQS: "/api?next=/somewhere?deep=1" }),
    );

    expect(result.uri).toBe("/api");
    expect(result.querystring).toBe("next=/somewhere?deep=1");
  });
});

describe("the viewer's hostname at origin-request", () => {
  it("stamps the viewer's host on the request it passes through", async () => {
    withRules(redirectRule());

    const result = (await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/somewhere-else")
        .withHost("shop.example.com")
        .build(),
    )) as CloudFrontRequest;

    expect(result.headers[VIEWER_HOST_HEADER]?.[0]?.value).toBe(
      "shop.example.com",
    );
  });

  it("overwrites a viewer-supplied value, so nobody can pick a host", async () => {
    withRules(redirectRule());

    const result = (await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/somewhere-else")
        .withHost("shop.example.com")
        .withViewerHostHeader("victim.example.com")
        .build(),
    )) as CloudFrontRequest;

    expect(result.headers[VIEWER_HOST_HEADER]?.[0]?.value).toBe(
      "shop.example.com",
    );
  });

  it("keys a rewrite on the stamped host, not the origin's domain", async () => {
    withRules(rewriteRule());

    const event = CloudfrontRequestEventMother.originRequest()
      .withUri("/legacy/thing")
      .build();
    // The state CloudFront actually delivers: Host is the origin, and the rule
    // lives under the viewer's hostname.
    expect(event.Records[0]!.cf.request.headers["host"]?.[0]?.value).toBe(
      "original-bucket.s3.amazonaws.com",
    );

    const result = (await handler(event)) as CloudFrontRequest;

    expect(result.uri).toBe("/api/v1/legacy");
  });

  it("matches a hostname condition against the viewer's host", async () => {
    withRules(
      rewriteRule({
        matches: [
          {
            matchType: "hostname",
            matchOperator: "equals",
            matchValue: HOST,
          },
        ],
      } as Partial<RedirectRule>),
    );

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/legacy/thing")
        .build(),
    )) as CloudFrontRequest;

    expect(result.uri).toBe("/api/v1/legacy");
  });

  it("does not forward the stamped header to the origin", async () => {
    withRules(rewriteRule());

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/legacy/thing")
        .build(),
    )) as CloudFrontRequest;

    expect(result.headers[VIEWER_HOST_HEADER]).toBeUndefined();
  });

  it("drops the header even when no rule matches", async () => {
    withRules(rewriteRule());

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/modern/thing")
        .build(),
    )) as CloudFrontRequest;

    expect(result.headers[VIEWER_HOST_HEADER]).toBeUndefined();
  });

  it("falls back to Host when nothing stamped it", async () => {
    // origin-request attached on its own: no viewer-request ran, so the only
    // hostname available is the origin's. Rules keyed there still apply.
    withRules(rewriteRule({ pk: "original-bucket.s3.amazonaws.com" }));

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/legacy/thing")
        .withoutViewerHostHeader()
        .build(),
    )) as CloudFrontRequest;

    expect(result.uri).toBe("/api/v1/legacy");
  });

  it("warns once per execution environment when nothing stamped it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    withRules(rewriteRule());

    const unstamped = () =>
      handler(
        CloudfrontRequestEventMother.originRequest()
          .withUri("/legacy/thing")
          .withoutViewerHostHeader()
          .build(),
      );

    await unstamped();
    await unstamped();

    // A missing association is one deployment mistake, not one per cache miss.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      keyedOn: "original-bucket.s3.amazonaws.com",
    });

    warn.mockRestore();
  });

  it("stays quiet when the header is there", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    withRules(rewriteRule());

    await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/legacy/thing")
        .build(),
    );

    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it("ignores the header at viewer-request", async () => {
    // Rules for the spoofed host must not apply just because a viewer asked.
    withRules(redirectRule({ pk: "victim.example.com" }));

    const result = await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .withHost("shop.example.com")
        .withViewerHostHeader("victim.example.com")
        .build(),
    );

    expect((result as CloudFrontResultResponse).status).toBeUndefined();
  });
});

describe("host scoping", () => {
  it("does not apply another host's rules", async () => {
    withRules(redirectRule({ pk: "other.example.com" }));

    const result = await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .withHost("www.example.com")
        .build(),
    );

    expect((result as CloudFrontResultResponse).status).toBeUndefined();
  });
});

describe("the viewer's country", () => {
  const countryMatch = (
    matchValue: string,
    negate = false,
  ): MatchCondition => ({
    matchType: "country",
    matchOperator: "equals",
    matchValue,
    negate,
  });

  it("matches a rewrite on the country CloudFront reported", async () => {
    withRules(
      rewriteRule({
        matches: [countryMatch("BE FR")],
      } as Partial<RedirectRule>),
    );

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/anything")
        .withViewerCountry("FR")
        .build(),
    )) as CloudFrontRequest;

    expect(result.uri).toBe("/api/v1/legacy");
  });

  it("leaves the request alone when the country is not listed", async () => {
    withRules(
      rewriteRule({
        matches: [countryMatch("BE FR")],
      } as Partial<RedirectRule>),
    );

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/anything")
        .withViewerCountry("DE")
        .build(),
    )) as CloudFrontRequest;

    expect(result.uri).toBe("/anything");
  });

  it("ignores the header a viewer sent itself at viewer-request", async () => {
    // CloudFront only works the country out after this event, so anything under
    // that name here came from the client. Trusting it would let a visitor pick
    // which country's rules apply to them by setting one header.
    withRules(redirectRule({ matches: [countryMatch("FR")] }));

    const result = await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .withViewerCountry("FR")
        .build(),
    );

    expect((result as CloudFrontResultResponse).status).toBeUndefined();
  });

  it("does not fire a NEGATED country rule at viewer-request", async () => {
    // The failure mode the skip in RulesService exists for. Evaluated with an
    // empty country, "everyone except France" inverts into "everyone", so this
    // one rule would redirect the entire site.
    withRules(redirectRule({ matches: [countryMatch("FR", true)] }));

    const result = await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .build(),
    );

    expect((result as CloudFrontResultResponse).status).toBeUndefined();
  });

  it("does not fire a NEGATED country rewrite when the header is missing", async () => {
    // Same inversion, this time from a distribution whose cache and origin
    // request policies never ask for the header. Nothing is wrong with the
    // rule, so the only signal is that it does nothing.
    withRules(
      rewriteRule({
        matches: [countryMatch("FR", true)],
      } as Partial<RedirectRule>),
    );

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest().withUri("/anything").build(),
    )) as CloudFrontRequest;

    expect(result.uri).toBe("/anything");
  });

  it("still redirects on a rule with no country condition", async () => {
    // The country is absent at viewer-request for every request, so an ordinary
    // redirect must be untouched by all of the above.
    withRules(redirectRule());

    const result = (await handler(
      CloudfrontRequestEventMother.viewerRequest()
        .withUri("/old-landing")
        .build(),
    )) as CloudFrontResultResponse;

    expect(result.status).toBe("301");
  });
});

/**
 * A redirect that reads the country cannot be evaluated at viewer-request, so
 * origin-request picks it up -- the one place the country exists. What these
 * tests pin down is the boundary: exactly those redirects and no others, or an
 * ordinary redirect would start firing on cache misses only.
 */
describe("geo redirects at origin-request", () => {
  const countryRedirect = (matchValue: string, negate = false) =>
    redirectRule({
      statusCode: 302,
      redirectURL: "https://www.example.fr/boutique",
      matches: [
        { matchType: "country", matchOperator: "equals", matchValue, negate },
      ],
    } as Partial<RedirectRule>);

  it("answers with the redirect when the country matches", async () => {
    withRules(countryRedirect("BE FR"));

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/shop")
        .withViewerCountry("FR")
        .build(),
    )) as CloudFrontResultResponse;

    expect(result.status).toBe("302");
    expect(result.statusDescription).toBe("Found");
    expect(result.headers?.["location"]?.[0]?.value).toBe(
      "https://www.example.fr/boutique",
    );
  });

  it("marks the redirect no-store, so no other country is served it", async () => {
    // The response is decided per viewer. Cached, it would be handed to the
    // next viewer from anywhere, and a French redirect would answer a German.
    withRules(countryRedirect("FR"));

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/shop")
        .withViewerCountry("FR")
        .build(),
    )) as CloudFrontResultResponse;

    expect(result.headers?.["cache-control"]?.[0]?.value).toBe(
      "max-age=0, no-cache, no-store",
    );
  });

  it("excludes the listed countries when negated", async () => {
    withRules(countryRedirect("US", true));

    const excluded = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/shop")
        .withViewerCountry("US")
        .build(),
    )) as CloudFrontResultResponse;
    expect(excluded.status).toBeUndefined();

    const redirected = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/shop")
        .withViewerCountry("FR")
        .build(),
    )) as CloudFrontResultResponse;
    expect(redirected.status).toBe("302");
  });

  it("does NOT re-evaluate an ordinary redirect at origin-request", async () => {
    // The boundary this whole split rests on. viewer-request already had its
    // chance at this rule; running it again here would make it fire on cache
    // misses only, so the same URL would redirect or not depending on whether
    // CloudFront happened to hold the page.
    withRules(redirectRule());

    const result = await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/old-landing")
        .withViewerCountry("FR")
        .build(),
    );

    expect((result as CloudFrontResultResponse).status).toBeUndefined();
    expect((result as CloudFrontRequest).uri).toBe("/old-landing");
  });

  it("takes the redirect over a rewrite that also matches", async () => {
    // Priority must not depend on which event evaluated the rule. At
    // viewer-request a redirect always wins by running first; that has to hold
    // here too.
    withRules(
      countryRedirect("FR"),
      rewriteRule({
        matches: [
          { matchType: "country", matchOperator: "equals", matchValue: "FR" },
        ],
      } as Partial<RedirectRule>),
    );

    const result = (await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/shop")
        .withViewerCountry("FR")
        .build(),
    )) as CloudFrontResultResponse;

    expect(result.status).toBe("302");
  });

  it("falls through to the rewrite when no geo redirect matches", async () => {
    withRules(countryRedirect("US"), rewriteRule());

    const result = await handler(
      CloudfrontRequestEventMother.originRequest()
        .withUri("/legacy/thing")
        .withViewerCountry("FR")
        .build(),
    );

    expect((result as CloudFrontResultResponse).status).toBeUndefined();
    expect((result as CloudFrontRequest).uri).toBe("/api/v1/legacy");
  });
});

describe("resilience", () => {
  it("passes the request through when the query throws", async () => {
    const failing = new FakeRepository();
    vi.spyOn(failing, "queryByPrefix").mockRejectedValue(
      new Error("DDB unavailable"),
    );
    repo = failing;
    resetService();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const event = CloudfrontRequestEventMother.viewerRequest()
      .withUri("/old-landing")
      .build();
    const result = await handler(event);

    expect(result).toBe(event.Records[0]!.cf.request);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("ignores event types it is not associated with", async () => {
    withRules(redirectRule());

    const event = CloudfrontRequestEventMother.forEventType("viewer-response")
      .withUri("/old-landing")
      .build();

    const result = await handler(event);

    expect((result as CloudFrontResultResponse).status).toBeUndefined();
  });
});
