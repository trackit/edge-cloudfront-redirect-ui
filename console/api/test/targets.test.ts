import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EDITOR } from "./principal-claims.js";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "../src/handler.js";
import {
  resetTargetsRepository,
  setTargetsRepository,
} from "../src/lib/targets-repository.js";
import { FakeTargetsRepository } from "./fake-targets-repository.js";
import {
  resetTableVerifier,
  setTableVerifier,
  type TableLocation,
} from "../src/lib/verify-table.js";
import { ApiError } from "../src/lib/errors.js";

const event = (
  method: string,
  path: string,
  body?: unknown,
): APIGatewayProxyEventV2 =>
  ({
    rawPath: path,
    headers: {},
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method }, ...EDITOR },
  }) as unknown as APIGatewayProxyEventV2;

const parse = (body: string | undefined): unknown =>
  JSON.parse(body ?? "null") as unknown;

const input = { name: "Prod", region: "us-east-1", tableName: "rules-prod" };

const create = async (over: Record<string, unknown> = {}) =>
  parse(
    (await handler(event("POST", "/targets", { ...input, ...over }))).body,
  ) as {
    id: string;
    name: string;
  };

/**
 * Tables the stub verifier reports as absent. Empty by default — these tests are
 * about the registry, so a table exists unless a test says otherwise.
 */
let missingTables: string[] = [];
/** What the handler asked about, for the tests that assert on the lookup. */
let verified: TableLocation[] = [];

beforeEach(() => {
  setTargetsRepository(new FakeTargetsRepository());
  missingTables = [];
  verified = [];

  // Stands in for verify-table.ts, whose own suite covers the AWS call. Without
  // this seam every create here would try to DescribeTable for real.
  setTableVerifier((table) => {
    verified.push(table);
    if (!missingTables.includes(table.tableName)) return Promise.resolve();

    return Promise.reject(
      new ApiError(400, "VALIDATION_ERROR", "Target failed validation", [
        { path: "/tableName", message: "no such table" },
      ]),
    );
  });
});

afterEach(() => {
  resetTargetsRepository();
  resetTableVerifier();
});

describe("targets API", () => {
  it("POST /targets creates with a server-generated id", async () => {
    const res = await handler(event("POST", "/targets", input));
    expect(res.statusCode).toBe(201);

    const body = parse(res.body) as { id: string };
    expect(body).toMatchObject(input);
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
  });

  it("POST /targets 400s an unknown region", async () => {
    const res = await handler(
      event("POST", "/targets", { ...input, region: "nope" }),
    );
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("GET /targets lists sorted by name", async () => {
    await create({ name: "Zebra", tableName: "rules-zebra" });
    await create({ name: "Alpha", tableName: "rules-alpha" });

    const res = await handler(event("GET", "/targets"));
    expect(res.statusCode).toBe(200);
    const names = (parse(res.body) as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["Alpha", "Zebra"]);
  });

  it("GET /targets/:id returns a created target", async () => {
    const created = await create();
    const res = await handler(event("GET", `/targets/${created.id}`));
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toEqual(created);
  });

  it("GET /targets/:id 404s an unknown id", async () => {
    const res = await handler(event("GET", "/targets/nope"));
    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("PUT /targets/:id updates and keeps the id", async () => {
    const created = await create();
    const res = await handler(
      event("PUT", `/targets/${created.id}`, { ...input, name: "Renamed" }),
    );
    expect(res.statusCode).toBe(200);

    const body = parse(res.body) as { id: string; name: string };
    expect(body.id).toBe(created.id);
    expect(body.name).toBe("Renamed");
  });

  it("PUT /targets/:id accepts the target GET returned, unchanged", async () => {
    // The GET → edit → PUT round-trip must work without the caller stripping
    // `id` by hand; CF-21's editor does exactly this.
    const created = await create();
    const fetched = parse(
      (await handler(event("GET", `/targets/${created.id}`))).body,
    );

    const res = await handler(event("PUT", `/targets/${created.id}`, fetched));

    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toEqual(fetched);
  });

  it("PUT /targets/:id 400s an id that disagrees with the path", async () => {
    const created = await create();

    const res = await handler(
      event("PUT", `/targets/${created.id}`, { ...input, id: "some-other-id" }),
    );

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: [{ path: "/id" }] },
    });
  });

  it("POST /targets still refuses a client-supplied id", async () => {
    // Only update accepts `id`; on create the server assigns it.
    const res = await handler(
      event("POST", "/targets", { ...input, id: "client-chosen" }),
    );

    expect(res.statusCode).toBe(400);
  });

  it("PUT /targets/:id 404s an unknown id", async () => {
    const res = await handler(event("PUT", "/targets/nope", input));
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /targets/:id removes it and returns 204", async () => {
    const created = await create();

    const del = await handler(event("DELETE", `/targets/${created.id}`));
    expect(del.statusCode).toBe(204);

    const after = await handler(event("GET", `/targets/${created.id}`));
    expect(after.statusCode).toBe(404);
  });

  it("DELETE /targets/:id 404s an unknown id", async () => {
    const res = await handler(event("DELETE", "/targets/nope"));
    expect(res.statusCode).toBe(404);
  });

  it("POST /targets 409s a name that is already taken, whatever its case", async () => {
    await create();

    // A target is one linked distribution, named after its distribution ID: a
    // second entry under that name would list the distribution twice.
    const res = await handler(
      event("POST", "/targets", {
        ...input,
        name: "PROD",
        tableName: "rules-other",
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(parse(res.body)).toMatchObject({
      error: { code: "TARGET_EXISTS" },
    });
  });

  it("POST /targets 409s a distribution already linked by its ARN", async () => {
    await create({ name: "E1ABCDEFGHIJKL" });

    const res = await handler(
      event("POST", "/targets", {
        ...input,
        name: "arn:aws:cloudfront::123456789012:distribution/E1ABCDEFGHIJKL",
        tableName: "rules-other",
      }),
    );
    expect(res.statusCode).toBe(409);
  });

  it("POST /targets allows two targets on the same table", async () => {
    // Two distributions served by one rules table are two linked distributions.
    await create();

    const res = await handler(
      event("POST", "/targets", { ...input, name: "Prod copy" }),
    );
    expect(res.statusCode).toBe(201);
  });

  it("PUT /targets/:id 409s a rename onto another target's name", async () => {
    const first = await create();
    await create({ name: "Staging", tableName: "rules-staging" });

    const res = await handler(
      event("PUT", `/targets/${first.id}`, { ...input, name: "Staging" }),
    );
    expect(res.statusCode).toBe(409);
  });

  it("PUT /targets/:id allows keeping its own name and repointing its table", async () => {
    const created = await create();
    await create({ name: "Staging", tableName: "rules-staging" });

    // The uniqueness check must exclude the target being updated, and another
    // target's table is no longer a clash.
    const res = await handler(
      event("PUT", `/targets/${created.id}`, {
        ...input,
        tableName: "rules-staging",
      }),
    );
    expect(res.statusCode).toBe(200);
  });

  it("POST /targets 400s a whitespace-only name and trims the rest", async () => {
    const blank = await handler(
      event("POST", "/targets", { ...input, name: "   " }),
    );
    expect(blank.statusCode).toBe(400);

    const padded = await handler(
      event("POST", "/targets", {
        ...input,
        name: "  Prod  ",
        tableName: "rules-padded",
      }),
    );
    expect((parse(padded.body) as { name: string }).name).toBe("Prod");
  });

  it("POST /targets round-trips an optional roleArn and rejects a bad one", async () => {
    const roleArn = "arn:aws:iam::123456789012:role/edgeroute-target-prod";
    const ok = await handler(event("POST", "/targets", { ...input, roleArn }));
    expect(ok.statusCode).toBe(201);
    expect(parse(ok.body)).toMatchObject({ roleArn });

    const bad = await handler(
      event("POST", "/targets", {
        ...input,
        tableName: "rules-bad-role",
        roleArn: "not-an-arn",
      }),
    );
    expect(bad.statusCode).toBe(400);
  });

  it("POST /targets 400s a table that does not exist", async () => {
    missingTables = ["rules-prodd"];

    const res = await handler(
      event("POST", "/targets", { ...input, tableName: "rules-prodd" }),
    );
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        details: [{ path: "/tableName" }],
      },
    });
  });

  it("POST /targets does not register a mistyped table alongside the real one", async () => {
    // The reported bug: the uniqueness check compares tableName exactly — as it
    // must, DynamoDB table names being case-sensitive — so a typo is not a
    // duplicate, and used to land as a second entry under the same display name.
    // Nothing caught it until the first rules request 502'd.
    await create();
    missingTables = ["Rules-Prod"];

    const res = await handler(
      event("POST", "/targets", { ...input, tableName: "Rules-Prod" }),
    );
    expect(res.statusCode).toBe(400);

    const list = parse((await handler(event("GET", "/targets"))).body) as {
      tableName: string;
    }[];
    expect(list.map((t) => t.tableName)).toEqual(["rules-prod"]);
  });

  it("POST /targets checks the table under the target's own role and region", async () => {
    const roleArn = "arn:aws:iam::111111111111:role/edgeroute-target-prod";
    await handler(
      event("POST", "/targets", { ...input, region: "eu-west-1", roleArn }),
    );

    // A cross-account table is only visible through its role, so verifying with
    // the API's own credentials would report every one of them as missing.
    expect(verified).toEqual([
      { name: "Prod", region: "eu-west-1", tableName: "rules-prod", roleArn },
    ]);
  });

  it("PUT /targets/:id does not re-check a table the update leaves alone", async () => {
    const created = await create();
    // The table has gone missing since it was registered — dropped, or renamed
    // out from under the entry. Renaming the target is how an operator labels
    // that, so it has to keep working; only the delete would remain otherwise.
    missingTables = ["rules-prod"];
    verified = [];

    const res = await handler(
      event("PUT", `/targets/${created.id}`, { ...input, name: "Prod (dead)" }),
    );
    expect(res.statusCode).toBe(200);
    expect(verified).toEqual([]);
  });

  it("PUT /targets/:id re-checks when only the role changes", async () => {
    const created = await create();
    verified = [];

    // Same name and region, different role: cross-account, that can be a
    // different table, so it is a retarget and gets checked.
    const roleArn = "arn:aws:iam::111111111111:role/edgeroute-target-prod";
    await handler(
      event("PUT", `/targets/${created.id}`, { ...input, roleArn }),
    );
    expect(verified).toEqual([{ ...input, roleArn }]);
  });

  it("PUT /targets/:id 400s when repointed at a table that does not exist", async () => {
    const created = await create();
    missingTables = ["rules-typo"];

    const res = await handler(
      event("PUT", `/targets/${created.id}`, {
        ...input,
        tableName: "rules-typo",
      }),
    );
    expect(res.statusCode).toBe(400);

    const after = parse(
      (await handler(event("GET", `/targets/${created.id}`))).body,
    ) as {
      tableName: string;
    };
    expect(after.tableName).toBe("rules-prod");
  });
});
