import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client";
import type { ApiClient } from "../src/api/client";
import { ApiError } from "../src/api/error";

/**
 * `createApiClient` with its `fetch` injected — no network, no MSW.
 *
 * What is worth pinning here is the edges, not the happy path: how a URL is
 * built (a rule's sort key contains `#`), and what every non-JSON answer becomes.
 * The console switches on `code`, so a failure that arrives as the wrong code is
 * a failure the UI renders as the wrong screen.
 */

/** Captures the calls and answers with a real `Response`. */
const stubFetch = (...responses: Response[]) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    return Promise.resolve(next ?? new Response("{}", { status: 200 }));
  });

  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const client = (fetch: typeof globalThis.fetch, baseUrl = "/api") =>
  createApiClient({ baseUrl, fetch });

describe("createApiClient — URLs", () => {
  it("trims trailing slashes off the base URL", () => {
    const { fetch } = stubFetch();
    expect(client(fetch, "https://api.example.com///").baseUrl).toBe(
      "https://api.example.com",
    );
  });

  it("percent-encodes a rule's sort key", async () => {
    const { calls, fetch } = stubFetch(
      json({ pk: "www", sk: "REDIRECT#00100" }),
    );

    await client(fetch).rules.get("t-1", "www.example.com", "REDIRECT#00100");

    // Sent raw, the browser treats everything from `#` as a fragment and the
    // server sees `/rules/REDIRECT` — a 400 on a key that was perfectly valid.
    expect(calls[0].url).toBe(
      "/api/targets/t-1/hosts/www.example.com/rules/REDIRECT%2300100",
    );
  });

  it("encodes the host too", async () => {
    const { calls, fetch } = stubFetch(json([]));

    await client(fetch).rules.list("t-1", "a/b?c");

    expect(calls[0].url).toBe("/api/targets/t-1/hosts/a%2Fb%3Fc/rules");
  });

  it("sends a JSON body only when there is one", async () => {
    const { calls, fetch } = stubFetch(json({ id: "t-1" }), json([]));
    const c = client(fetch);

    await c.targets.create({
      name: "Prod",
      region: "us-east-1",
      tableName: "rules-prod",
    });
    await c.targets.list();

    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe(
      JSON.stringify({
        name: "Prod",
        region: "us-east-1",
        tableName: "rules-prod",
      }),
    );
    expect(
      (calls[0].init.headers as Record<string, string>)["content-type"],
    ).toBe("application/json");
    // A GET must not carry a content-type for a body it does not have.
    expect(calls[1].init.body).toBeUndefined();
    expect(
      (calls[1].init.headers as Record<string, string>)["content-type"],
    ).toBeUndefined();
  });
});

describe("createApiClient — routes", () => {
  const targetInput = {
    name: "P",
    region: "us-east-1",
    tableName: "rules-prod",
  };
  // The route table is what is under test here, not the rule body.
  const ruleInput = {} as Parameters<ApiClient["rules"]["create"]>[2];

  const routes: [string, (c: ApiClient) => Promise<unknown>, string, string][] =
    [
      ["health", (c) => c.health(), "GET", "/api/health"],
      ["targets.list", (c) => c.targets.list(), "GET", "/api/targets"],
      [
        "targets.create",
        (c) => c.targets.create(targetInput),
        "POST",
        "/api/targets",
      ],
      ["targets.get", (c) => c.targets.get("t-1"), "GET", "/api/targets/t-1"],
      [
        "targets.update",
        (c) => c.targets.update("t-1", targetInput),
        "PUT",
        "/api/targets/t-1",
      ],
      [
        "targets.remove",
        (c) => c.targets.remove("t-1"),
        "DELETE",
        "/api/targets/t-1",
      ],
      [
        "rules.list",
        (c) => c.rules.list("t-1", "www"),
        "GET",
        "/api/targets/t-1/hosts/www/rules",
      ],
      [
        "rules.create",
        (c) => c.rules.create("t-1", "www", ruleInput),
        "POST",
        "/api/targets/t-1/hosts/www/rules",
      ],
      [
        "rules.get",
        (c) => c.rules.get("t-1", "www", "REDIRECT#00100"),
        "GET",
        "/api/targets/t-1/hosts/www/rules/REDIRECT%2300100",
      ],
      [
        "rules.put",
        (c) => c.rules.put("t-1", "www", "REDIRECT#00100", ruleInput),
        "PUT",
        "/api/targets/t-1/hosts/www/rules/REDIRECT%2300100",
      ],
      [
        "rules.toggle",
        (c) => c.rules.toggle("t-1", "www", "REDIRECT#00100", true),
        "PATCH",
        "/api/targets/t-1/hosts/www/rules/REDIRECT%2300100",
      ],
      [
        "rules.remove",
        (c) => c.rules.remove("t-1", "www", "REDIRECT#00100"),
        "DELETE",
        "/api/targets/t-1/hosts/www/rules/REDIRECT%2300100",
      ],
    ];

  // Each method is a one-line wrapper, which is exactly why they are worth
  // pinning: nothing else would notice `toggle` sending PUT (a full replace that
  // clears every field the body omits) instead of PATCH.
  it.each(routes)("%s issues %s %s", async (_name, call, method, url) => {
    const { calls, fetch } = stubFetch();

    await call(client(fetch));

    expect(calls[0].init.method).toBe(method);
    expect(calls[0].url).toBe(url);
  });

  it("sends only the disabled flag when toggling", async () => {
    const { calls, fetch } = stubFetch();

    await client(fetch).rules.toggle("t-1", "www", "REDIRECT#00100", false);

    // The route accepts nothing else, and sending a whole rule here would be a
    // 400 rather than a silent full replace.
    expect(calls[0].init.body).toBe(JSON.stringify({ disabled: false }));
  });
});

describe("createApiClient — responses", () => {
  it("resolves a 204 to undefined without parsing", async () => {
    const { fetch } = stubFetch(new Response(null, { status: 204 }));

    await expect(client(fetch).targets.remove("t-1")).resolves.toBeUndefined();
  });

  it("resolves an empty 200 body to undefined", async () => {
    const { fetch } = stubFetch(new Response("", { status: 200 }));

    await expect(client(fetch).health()).resolves.toBeUndefined();
  });

  it("returns the parsed body on success", async () => {
    const { fetch } = stubFetch(json({ status: "ok" }));

    await expect(client(fetch).health()).resolves.toEqual({ status: "ok" });
  });
});

describe("createApiClient — failures", () => {
  it("maps a rejected fetch to NETWORK_ERROR with status 0", async () => {
    const fetch = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    ) as unknown as typeof globalThis.fetch;

    const error = await client(fetch)
      .health()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const api = error as ApiError;
    expect(api.code).toBe("NETWORK_ERROR");
    // Status 0 is how a caller tells "never left the browser" from any real
    // HTTP failure.
    expect(api.status).toBe(0);
    expect(api.message).toContain("Failed to fetch");
  });

  it("still reports NETWORK_ERROR when the rejection is not an Error", async () => {
    const fetch = vi.fn(() =>
      Promise.reject("offline"),
    ) as unknown as typeof globalThis.fetch;

    const error = (await client(fetch)
      .health()
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.message).toBe("Could not reach the API");
  });

  it("maps a 2xx that is not JSON to MALFORMED_RESPONSE", async () => {
    // A proxy or a dev server answering HTML on a route the API does not serve.
    const { fetch } = stubFetch(
      new Response("<!doctype html>", { status: 200 }),
    );

    const error = (await client(fetch)
      .health()
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe("MALFORMED_RESPONSE");
    expect(error.status).toBe(200);
  });

  it("maps an error status with no JSON body to MALFORMED_RESPONSE, keeping the status", async () => {
    // API Gateway's own 5xx page — an error, but not the API's envelope.
    const { fetch } = stubFetch(
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    );

    const error = (await client(fetch)
      .health()
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe("MALFORMED_RESPONSE");
    expect(error.status).toBe(502);
  });

  it("reads the API's error envelope, details and all", async () => {
    const { fetch } = stubFetch(
      json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Target failed validation",
            details: [{ path: "/tableName", message: "no such table" }],
          },
        },
        400,
      ),
    );

    const error = (await client(fetch)
      .targets.create({ name: "P", region: "us-east-1", tableName: "x" })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.status).toBe(400);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.isValidation).toBe(true);
    expect(error.details).toEqual([
      { path: "/tableName", message: "no such table" },
    ]);
  });
});
