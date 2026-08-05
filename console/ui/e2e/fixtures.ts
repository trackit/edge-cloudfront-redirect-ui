import { expect, test as base, type Page, type Route } from "@playwright/test";
import type { Distribution } from "../src/types";

/**
 * The two things every spec here needs: a stubbed API, and a browser that
 * already remembers a distribution.
 *
 * Interception happens in the page, so it lands *before* Vite's `/api` proxy —
 * nothing leaves the browser. Anything a spec forgets to stub therefore hits the
 * proxy and fails on a refused connection, which is the point: a spec must not
 * be able to pass by quietly talking to whatever is running on port 3000.
 */

/** The API's error envelope, as `toApiError` expects to find it. */
export const errorBody = (
  code: string,
  message: string,
  details?: { path: string; message: string }[],
) => ({ error: { code, message, ...(details ? { details } : {}) } });

export interface ApiStub {
  /** Every request the page made, in order. */
  calls: { method: string; url: string; body: unknown }[];
  /** Answers the next `POST /targets` with this instead of the default 201. */
  createReply: (reply: { status: number; body: unknown }) => void;
  /** What `GET /targets` returns. */
  setTargets: (targets: unknown[]) => void;
}

const jsonOf = (route: Route): unknown => {
  const raw = route.request().postData();
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

/**
 * Stubs the console API. The default answer to a create is a 201 echoing the
 * body with a server-assigned id, which is the shape `connectDistribution`
 * expects — a spec only overrides it when the failure is the point.
 */
export const stubApi = async (page: Page): Promise<ApiStub> => {
  const calls: ApiStub["calls"] = [];
  let create: { status: number; body: unknown } | null = null;
  let targets: unknown[] = [];

  // A predicate, not the `**/api/**` glob that looks right: the app's own source
  // lives in `src/api/`, and in dev Vite serves those modules from URLs the glob
  // also matches — so the stub answers the app's imports with JSON and the page
  // renders nothing at all. Anchoring on the client's base path cannot.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const method = request.method();
      const url = new URL(request.url());
      const body = jsonOf(route);
      calls.push({ method, url: url.pathname, body });

      if (method === "POST" && url.pathname.endsWith("/targets")) {
        const reply = create ?? {
          status: 201,
          body: { id: "t-generated", ...(body as Record<string, unknown>) },
        };
        await route.fulfill({
          status: reply.status,
          contentType: "application/json",
          body: JSON.stringify(reply.body),
        });
        return;
      }

      if (method === "GET" && url.pathname.endsWith("/targets")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(targets),
        });
        return;
      }

      // Deliberately not a catch-all 200: an unexpected call should look like a
      // bug in the test, not like a passing assertion.
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify(
          errorBody("INTERNAL", `unstubbed ${method} ${url.pathname}`),
        ),
      });
    },
  );

  return {
    calls,
    createReply: (reply) => {
      create = reply;
    },
    setTargets: (next) => {
      targets = next;
    },
  };
};

export const STORAGE_KEY = "edgeroute.distributions";
export const LEGACY_STORAGE_KEY = "edgeroute.distribution";

export const distribution = (
  over: Partial<Distribution> = {},
): Distribution => ({
  targetId: "t-1",
  distributionId: "E1AAAAAAAAAAAA",
  tableName: "rules-prod",
  region: "us-east-1",
  ...over,
});

/**
 * Seeds localStorage before the app boots, so a spec about the console does not
 * have to walk the connect form to get there. `addInitScript` runs before any
 * page script, which is the only ordering that works — the store reads storage
 * during the first render.
 *
 * Writes only when the key is absent, because this runs again on every
 * navigation: seeding unconditionally would restore the fixture on reload and
 * quietly make "survives a reload" untestable.
 */
const seedOnce = (page: Page, key: string, value: unknown) =>
  page.addInitScript(
    ([k, json]) => {
      if (window.localStorage.getItem(k) === null) {
        window.localStorage.setItem(k, json);
      }
    },
    [key, JSON.stringify(value)] as const,
  );

export const seedStorage = async (
  page: Page,
  value: { distributions: Distribution[]; current: string | null },
): Promise<void> => {
  await seedOnce(page, STORAGE_KEY, value);
};

/** Seeds the pre-switcher single-distribution key, for the migration spec. */
export const seedLegacyStorage = async (
  page: Page,
  value: Distribution,
): Promise<void> => {
  await seedOnce(page, LEGACY_STORAGE_KEY, value);
};

/**
 * The chip in the console bar — the only element that owns the panel, so this
 * needs neither a class nor a test id.
 */
export const chip = (page: Page) =>
  page.locator('[aria-controls="dist-panel"]');

/** The panel's distribution rows: every row carries `aria-current`, the actions do not. */
export const rows = (page: Page) => page.locator("#dist-panel [aria-current]");

export const panel = (page: Page) =>
  page.getByRole("group", { name: "Connected distributions" });

export const readStorage = (page: Page, key = STORAGE_KEY) =>
  page.evaluate((k) => window.localStorage.getItem(k), key);

/** `api` is set up per test so no spec can forget to stub the network. */
export const test = base.extend<{ api: ApiStub }>({
  api: async ({ page }, use) => {
    await use(await stubApi(page));
  },
});

export { expect };
