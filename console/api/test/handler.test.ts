import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EDITOR, claims } from "./principal-claims.js";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "../src/handler.js";
import {
  resetTargetsRepository,
  setTargetsRepository,
} from "../src/lib/targets-repository.js";
import {
  resetRulesRepositoryFactory,
  setRulesRepositoryFactory,
} from "../src/lib/rules-repository.js";
import { FakeTargetsRepository } from "./fake-targets-repository.js";
import { FakeRulesRepository } from "./fake-rules-repository.js";

const event = (
  method: string,
  path: string,
  body?: string,
): APIGatewayProxyEventV2 =>
  ({
    rawPath: path,
    headers: {},
    body,
    isBase64Encoded: false,
    requestContext: { http: { method }, ...EDITOR },
  }) as unknown as APIGatewayProxyEventV2;

const parse = (body: string | undefined): unknown =>
  JSON.parse(body ?? "{}") as unknown;

// Rule routes resolve their target first and then read its table, so they need
// both a registry and a rules table — without the second, a read route here
// would try to reach DynamoDB for real. Scoping and rule behaviour are covered in
// rules-scoping.test.ts and rules.test.ts; here "prod" just has to exist.
beforeEach(() => {
  setTargetsRepository(
    new FakeTargetsRepository([
      {
        id: "prod",
        name: "Prod",
        region: "us-east-1",
        tableName: "rules-prod",
      },
    ]),
  );
  setRulesRepositoryFactory(() => new FakeRulesRepository());
});

afterEach(() => {
  resetTargetsRepository();
  resetRulesRepositoryFactory();
});

describe("handler", () => {
  it("GET /health returns 200 with status ok", async () => {
    const res = await handler(event("GET", "/health"));

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["content-type"]).toBe("application/json");
    expect(parse(res.body)).toEqual({ status: "ok" });
  });

  it("returns a standardized 404 for an unknown route", async () => {
    const res = await handler(event("GET", "/nope"));

    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("returns a 405 when the method is wrong for a known path", async () => {
    const res = await handler(event("DELETE", "/health"));

    expect(res.statusCode).toBe(405);
    expect(parse(res.body)).toMatchObject({
      error: { code: "METHOD_NOT_ALLOWED" },
    });
  });

  it("returns a 400 for a malformed JSON body", async () => {
    const res = await handler(event("POST", "/health", "{not json"));

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({ error: { code: "INVALID_JSON" } });
  });

  const RULES = "/targets/prod/hosts/www.example.com/rules";

  it("validates the body on create and 400s an invalid rule", async () => {
    const res = await handler(
      event("POST", RULES, JSON.stringify({ type: "erMatchRule" })),
    );

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("passes a valid rule through to persistence", async () => {
    const rule = {
      priority: 100,
      type: "erMatchRule",
      statusCode: 301,
      redirectURL: "https://www.example.com/new",
      matches: [
        { matchType: "path", matchOperator: "equals", matchValue: "/old" },
      ],
    };
    const res = await handler(event("POST", RULES, JSON.stringify(rule)));

    expect(res.statusCode).toBe(201);
    expect(parse(res.body)).toMatchObject({
      pk: "www.example.com",
      sk: "REDIRECT#00100",
    });
  });

  it("serializes a read route's JSON body", async () => {
    const res = await handler(event("GET", RULES));

    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ "content-type": "application/json" });
    expect(parse(res.body)).toEqual([]);
  });

  /**
   * That the `Authorization` header actually reaches `principalFrom`.
   *
   * Worth its own test because the fallback hides a broken wire: misspell the
   * header lookup and the authorizer's own claims are still read, so every other
   * test in the repo passes and only the flattened-string guess ships.
   *
   * The two sides deliberately disagree, which cannot happen in production —
   * they are the same token. Disagreement is simply the only way to observe
   * which one was used.
   */
  it.each(["authorization", "Authorization"])(
    "reads the groups from the token in the %s header",
    async (headerName) => {
      const token = [
        Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
        Buffer.from(
          JSON.stringify({ sub: "user-1", "cognito:groups": ["editor"] }),
        ).toString("base64url"),
        "signature-checked-by-the-gateway",
      ].join(".");

      const res = await handler({
        rawPath: "/targets/prod/hosts",
        headers: { [headerName]: `Bearer ${token}` },
        isBase64Encoded: false,
        requestContext: {
          http: { method: "POST" },
          // The context says viewer; the token says editor. A write landing
          // means the token was read.
          ...claims(["viewer"]),
        },
      } as unknown as APIGatewayProxyEventV2);

      expect(res.statusCode).not.toBe(403);
    },
  );
});
