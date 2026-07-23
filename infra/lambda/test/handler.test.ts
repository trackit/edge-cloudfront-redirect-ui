import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontResultResponse,
} from "aws-lambda";
import type { RedirectRule } from "../src/rule-types.js";
import { CloudfrontRequestEventMother } from "./cloudfront-request-event.mother.js";
import { FakeRepository } from "./fake-repository.js";

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
        forwardSettings: {
          origin: {
            s3: {
              authMethod: "origin-access-identity",
              region: "us-east-1",
              domainName: "example-assets.s3.us-east-1.amazonaws.com",
              path: "",
              customHeaders: {},
            },
          },
        },
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
