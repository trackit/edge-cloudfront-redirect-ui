import { describe, expect, it } from "vitest";
import { createRouter } from "../src/router.js";
import type { ApiRequest } from "../src/context.js";

const req = (over: Partial<ApiRequest> = {}): ApiRequest => ({
  method: "GET",
  path: "/",
  params: {},
  query: {},
  headers: {},
  body: undefined,
  ...over,
});

describe("router", () => {
  it("dispatches a matching method and path", async () => {
    const router = createRouter([
      {
        method: "GET",
        pattern: "/health",
        handler: () => ({ status: 200, body: { ok: true } }),
      },
    ]);

    expect(await router.handle(req({ path: "/health" }))).toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  it("lowercases a host param and leaves the others alone", async () => {
    // `host` is a DynamoDB partition key, so two cases of one DNS name would be
    // two partitions. Normalizing here rather than per handler is what stops a
    // later route reintroducing the split — `targetId` and `sk` are opaque
    // server-generated strings and must survive exactly as sent.
    const router = createRouter([
      {
        method: "GET",
        pattern: "/targets/:targetId/hosts/:host/rules/:sk",
        handler: (r) => ({ status: 200, body: r.params }),
      },
    ]);

    const res = await router.handle(
      req({
        path: "/targets/T1-Ab/hosts/WWW.Example.COM/rules/REDIRECT%2300100",
      }),
    );

    expect(res.body).toEqual({
      targetId: "T1-Ab",
      host: "www.example.com",
      sk: "REDIRECT#00100",
    });
  });

  it("normalizes a host after decoding it, not before", async () => {
    // Percent-escapes are uppercase by convention (%2E, not %2e); lowercasing
    // the raw segment first would leave the escape intact and produce a
    // different string than decoding does.
    const router = createRouter([
      {
        method: "GET",
        pattern: "/hosts/:host",
        handler: (r) => ({ status: 200, body: r.params }),
      },
    ]);

    const res = await router.handle(
      req({ path: "/hosts/WWW%2EEXAMPLE%2ECOM" }),
    );

    expect(res.body).toEqual({ host: "www.example.com" });
  });

  it("extracts path params", async () => {
    const router = createRouter([
      {
        method: "GET",
        pattern: "/targets/:targetId/hosts/:host/rules",
        handler: (r) => ({ status: 200, body: r.params }),
      },
    ]);

    const res = await router.handle(
      req({ path: "/targets/prod/hosts/www.example.com/rules" }),
    );

    expect(res.body).toEqual({ targetId: "prod", host: "www.example.com" });
  });

  it("percent-decodes params", async () => {
    const router = createRouter([
      {
        method: "GET",
        pattern: "/hosts/:host",
        handler: (r) => ({ status: 200, body: r.params }),
      },
    ]);

    expect((await router.handle(req({ path: "/hosts/a%2Fb" }))).body).toEqual({
      host: "a/b",
    });
  });

  it("ignores a trailing slash", async () => {
    const router = createRouter([
      {
        method: "GET",
        pattern: "/health",
        handler: () => ({ status: 200, body: {} }),
      },
    ]);

    expect((await router.handle(req({ path: "/health/" }))).status).toBe(200);
  });

  it("throws a 400 for malformed percent-encoding in a param", async () => {
    const router = createRouter([
      {
        method: "GET",
        pattern: "/hosts/:host",
        handler: (r) => ({ status: 200, body: r.params }),
      },
    ]);

    await expect(
      router.handle(req({ path: "/hosts/%" })),
    ).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
  });

  it("throws a 404 for an unknown path", async () => {
    const router = createRouter([]);

    await expect(router.handle(req({ path: "/nope" }))).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("throws a 405 when the path matches but the method does not", async () => {
    const router = createRouter([
      {
        method: "GET",
        pattern: "/health",
        handler: () => ({ status: 200, body: {} }),
      },
    ]);

    await expect(
      router.handle(req({ method: "POST", path: "/health" })),
    ).rejects.toMatchObject({ status: 405, code: "METHOD_NOT_ALLOWED" });
  });
});
