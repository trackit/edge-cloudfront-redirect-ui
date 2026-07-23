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
