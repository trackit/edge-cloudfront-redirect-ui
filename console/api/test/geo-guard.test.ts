import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "../src/handler.js";
import {
  resetGeoReadinessChecker,
  setGeoReadinessChecker,
  type GeoReadiness,
} from "../src/lib/geo-readiness.js";
import {
  resetRulesRepositoryFactory,
  setRulesRepositoryFactory,
  type RuleItem,
} from "../src/lib/rules-repository.js";
import {
  resetTargetsRepository,
  setTargetsRepository,
} from "../src/lib/targets-repository.js";
import { FakeRulesRepository } from "./fake-rules-repository.js";
import { FakeTargetsRepository } from "./fake-targets-repository.js";
import { EDITOR } from "./principal-claims.js";

/**
 * The write guard on country rewrites, through the real router: the editor's
 * own check is a courtesy, this is what holds for a script or a direct call.
 */

const HOST = "www.example.com";
const BASE = `/targets/t1/hosts/${HOST}/rules`;
const SK = "REWRITE%2300100";

const event = (
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): APIGatewayProxyEventV2 =>
  ({
    rawPath: path,
    headers: {},
    ...(query ? { queryStringParameters: query } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method }, ...EDITOR },
  }) as unknown as APIGatewayProxyEventV2;

const errorCode = (body: string | undefined): unknown =>
  (JSON.parse(body ?? "null") as { error: { code: string } }).error.code;

const COUNTRY = {
  matchType: "country",
  matchOperator: "equals",
  matchValue: "FR",
};
const SHOP = {
  matchType: "path",
  matchOperator: "equals",
  matchValue: "/shop",
  caseSensitive: true,
};

/** What a client sends for a country rewrite on /shop. */
const geoRewrite = (over: Record<string, unknown> = {}) => ({
  priority: 100,
  type: "frMatchRule",
  matches: [SHOP, COUNTRY],
  forwardSettings: { pathAndQS: "/fr/shop" },
  ...over,
});

/** The same rule as stored. */
const stored = (over: Partial<RuleItem> = {}): RuleItem => ({
  pk: HOST,
  sk: "REWRITE#00100",
  type: "frMatchRule",
  matches: [SHOP, COUNTRY],
  forwardSettings: { pathAndQS: "/fr/shop" },
  ...over,
});

const UNSAFE: GeoReadiness = {
  status: "checked",
  distributionId: "EQFO7A1FE1EPJ",
  functionIdentified: true,
  behaviors: [{ pathPattern: "*", verdict: "cachedWithoutCountry" }],
};

let readiness: GeoReadiness = UNSAFE;
let consulted = 0;

const seed = (items: RuleItem[]): void => {
  const repo = new FakeRulesRepository(items);
  setRulesRepositoryFactory(() => repo);
};

beforeEach(() => {
  readiness = UNSAFE;
  consulted = 0;
  setTargetsRepository(
    new FakeTargetsRepository([
      {
        id: "t1",
        name: "EQFO7A1FE1EPJ",
        region: "us-east-1",
        tableName: "rules",
      },
    ]),
  );
  setGeoReadinessChecker(() => {
    consulted++;
    return Promise.resolve(readiness);
  });
  seed([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetTargetsRepository();
  resetRulesRepositoryFactory();
  resetGeoReadinessChecker();
});

describe("country rewrite write guard", () => {
  it("refuses a rewrite cached without the country, even when confirmed", async () => {
    for (const query of [undefined, { confirmUnverifiedGeo: "true" }]) {
      const res = await handler(event("POST", BASE, geoRewrite(), query));
      expect(res.statusCode).toBe(409);
      expect(errorCode(res.body)).toBe("GEO_REWRITE_UNSAFE");
    }
  });

  it("refuses an unverifiable rewrite unless confirmed, and logs the confirmation", async () => {
    readiness = { status: "unknown", cause: "accessDenied", reason: "r" };

    const refused = await handler(event("POST", BASE, geoRewrite()));
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused.body)).toBe("GEO_UNVERIFIED");

    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const accepted = await handler(
      event("POST", BASE, geoRewrite(), { confirmUnverifiedGeo: "true" }),
    );
    expect(accepted.statusCode).toBe(201);

    const logged = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(logged).toMatchObject({
      event: "geo-unverified-confirmed",
      targetId: "t1",
      host: HOST,
      sk: "REWRITE#00100",
      cause: "accessDenied",
      principal: expect.any(String),
    });
    // Who and what, never the rule's content.
    expect(JSON.stringify(logged)).not.toContain("/fr/shop");
  });

  it("saves a rewrite on a behavior that is fine", async () => {
    readiness = {
      ...UNSAFE,
      behaviors: [{ pathPattern: "*", verdict: "ok" }],
    } as GeoReadiness;
    const res = await handler(event("POST", BASE, geoRewrite()));
    expect(res.statusCode).toBe(201);
  });

  it("is not fooled by alternatives or wildcards in an exact path", async () => {
    readiness = {
      status: "checked",
      distributionId: "EQFO7A1FE1EPJ",
      functionIdentified: true,
      behaviors: [
        { pathPattern: "/fr/*", verdict: "cachedWithoutCountry" },
        { pathPattern: "*", verdict: "ok" },
      ],
    };
    for (const matchValue of ["/a /fr/page", "/*"]) {
      const res = await handler(
        event(
          "POST",
          BASE,
          geoRewrite({ matches: [{ ...SHOP, matchValue }, COUNTRY] }),
        ),
      );
      expect(res.statusCode).toBe(409);
      expect(errorCode(res.body)).toBe("GEO_REWRITE_UNSAFE");
    }
  });

  it("never blocks a redirect", async () => {
    readiness = { status: "unknown", cause: "transient", reason: "r" };
    const res = await handler(
      event("POST", BASE, {
        priority: 100,
        type: "erMatchRule",
        statusCode: 302,
        redirectURL: "https://www.example.fr/",
        matches: [COUNTRY],
      }),
    );
    expect(res.statusCode).toBe(201);
  });

  it("guards PUT the same way", async () => {
    seed([stored({ matches: [SHOP] })]);
    const res = await handler(event("PUT", `${BASE}/${SK}`, geoRewrite()));
    expect(res.statusCode).toBe(409);
    expect(errorCode(res.body)).toBe("GEO_REWRITE_UNSAFE");
  });

  it("lets an unsafe rewrite be saved disabled, but not re-enabled", async () => {
    const off = await handler(
      event("POST", BASE, geoRewrite({ disabled: true })),
    );
    expect(off.statusCode).toBe(201);

    const on = await handler(
      event("PATCH", `${BASE}/${SK}`, { disabled: false }),
    );
    expect(on.statusCode).toBe(409);
    expect(errorCode(on.body)).toBe("GEO_REWRITE_UNSAFE");

    const stillOff = await handler(
      event("PATCH", `${BASE}/${SK}`, { disabled: true }),
    );
    expect(stillOff.statusCode).toBe(200);
  });

  it("re-enables an unverifiable rewrite only when confirmed", async () => {
    readiness = { status: "unknown", cause: "transient", reason: "r" };
    seed([stored({ disabled: true })]);
    vi.spyOn(console, "info").mockImplementation(() => {});

    const refused = await handler(
      event("PATCH", `${BASE}/${SK}`, { disabled: false }),
    );
    expect(refused.statusCode).toBe(409);

    const accepted = await handler(
      event(
        "PATCH",
        `${BASE}/${SK}`,
        { disabled: false },
        { confirmUnverifiedGeo: "true" },
      ),
    );
    expect(accepted.statusCode).toBe(200);
  });

  it("does not consult the distribution for a rewrite without a country condition", async () => {
    const res = await handler(
      event("POST", BASE, geoRewrite({ matches: [SHOP] })),
    );
    expect(res.statusCode).toBe(201);
    expect(consulted).toBe(0);
  });
});
