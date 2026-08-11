import { expect, test as base, type Page, type Route } from "@playwright/test";
import type { HostSummary, Rule } from "../src/api";
import type { Stored } from "../src/distribution";
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
  /**
   * Answers every subsequent `POST /targets` with this instead of the default
   * 201 — it is not consumed, so a spec that submits twice gets it twice.
   */
  createReply: (reply: { status: number; body: unknown }) => void;
  /** What `GET /targets` returns. */
  setTargets: (targets: unknown[]) => void;
  /**
   * What `GET …/hosts` returns. The console fetches this on mount, so it is the
   * state the page starts in rather than something a spec arranges afterwards.
   */
  setHosts: (hosts: HostSummary[]) => void;
  /**
   * Answers every subsequent `POST …/hosts` with this instead of the default
   * 201. Same non-consuming behaviour as `createReply`.
   */
  createHostReply: (reply: { status: number; body: unknown }) => void;
  /**
   * Answers every subsequent `DELETE …/hosts/{host}` with this instead of the
   * default 204.
   */
  deleteHostReply: (reply: { status: number; body: unknown }) => void;
  /**
   * What `GET …/hosts/{host}/rules` returns. The host view fetches this on
   * mount, so — like `setHosts` — it is the state the page starts in.
   *
   * Writes are deliberately still unstubbed: no spec exercises one yet, and the
   * 500 fallthrough is what will say so when one does.
   */
  setRules: (rules: Rule[]) => void;
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
  let hosts: HostSummary[] = [];
  let createHost: { status: number; body: unknown } | null = null;
  let deleteHost: { status: number; body: unknown } | null = null;
  let rules: Rule[] = [];

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

      // A pattern rather than `endsWith`, because the host routes are two
      // shapes: the collection ends in `/hosts`, and one host is a segment
      // after it. `endsWith("/hosts")` would answer the collection and drop the
      // item route into the 500 below.
      if (HOSTS_COLLECTION.test(url.pathname)) {
        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(hosts),
          });
          return;
        }

        if (method === "POST") {
          // The API lowercases what it stores and answers with the stored form,
          // so the stub does too — a spec typing mixed case must see back what
          // the real server would send, not what it typed.
          const asked = (body as { host?: unknown })?.host;
          const reply = createHost ?? {
            status: 201,
            body: {
              host: typeof asked === "string" ? asked.toLowerCase() : asked,
              redirects: 0,
              rewrites: 0,
            },
          };
          await route.fulfill({
            status: reply.status,
            contentType: "application/json",
            body: JSON.stringify(reply.body),
          });
          return;
        }
      }

      // Before the fallthrough and after the host routes: the host view fetches
      // its rules on mount, so leaving this to the 500 would put every spec that
      // lands on a host into the "Could not load these rules" state.
      if (method === "GET" && RULES_COLLECTION.test(url.pathname)) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(rules),
        });
        return;
      }

      if (method === "DELETE" && HOSTS_ITEM.test(url.pathname)) {
        const reply = deleteHost ?? { status: 204, body: null };
        await route.fulfill({
          status: reply.status,
          contentType: "application/json",
          // 204 carries no body, and fulfilling one with `"null"` would give the
          // client a length to parse where the real server sends none.
          body: reply.status === 204 ? "" : JSON.stringify(reply.body),
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
    setHosts: (next) => {
      hosts = next;
    },
    createHostReply: (reply) => {
      createHost = reply;
    },
    deleteHostReply: (reply) => {
      deleteHost = reply;
    },
    setRules: (next) => {
      rules = next;
    },
  };
};

/**
 * Opens the console and waits for it to have actually loaded.
 *
 * The console fetches its hosts on mount, so a route this file forgets to stub
 * lands the page in the "Could not load the hosts" state — which no assertion
 * about the chip or storage would notice. Every spec that renders the console
 * would keep passing while exercising a console that is broken, which is the one
 * thing the 500 fallthrough exists to prevent.
 *
 * The wait is load-bearing: the error arrives a tick after the loading state, so
 * checking for an alert straight after `goto` finds none simply because nothing
 * has answered yet.
 */
export const gotoConsole = async (page: Page): Promise<void> => {
  await page.goto("/console");
  await expect(page.getByText(/Loading hosts/)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
};

/** `…/targets/{id}/hosts`, the collection. */
const HOSTS_COLLECTION = /\/hosts$/;

/** `…/targets/{id}/hosts/{host}`, one host — but not its `/rules` below it. */
const HOSTS_ITEM = /\/hosts\/[^/]+$/;

/** `…/hosts/{host}/rules`, the collection — not one rule addressed under it. */
const RULES_COLLECTION = /\/rules$/;

/** A host row as `GET …/hosts` returns it. Counts default to an empty host. */
export const host = (
  name: string,
  over: Partial<HostSummary> = {},
): HostSummary => ({
  host: name,
  redirects: 0,
  rewrites: 0,
  ...over,
});

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

// `Stored` itself rather than a hand-written copy of its fields: the copy was
// mutable where the real type is readonly, so it had already stopped accepting
// the values the app produces, and a spec seeding one would not compile.
export const seedStorage = async (page: Page, value: Stored): Promise<void> => {
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

/**
 * `api` is `auto` so no spec can forget to stub the network.
 *
 * Not merely declared: Playwright builds fixtures lazily, so without this a spec
 * that never destructures `api` installs no route at all and its requests fall
 * through to Vite's `/api` proxy — reaching whatever happens to be listening on
 * port 3000. Nothing fetches after load today, which is exactly why that would
 * go unnoticed until the rules UI does.
 */
export const test = base.extend<{ api: ApiStub }>({
  api: [
    async ({ page }, use) => {
      await use(await stubApi(page));
    },
    { auto: true },
  ],
});

export { expect };
