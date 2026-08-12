import type { Page } from "@playwright/test";
import {
  distribution,
  errorBody,
  expect,
  host,
  seedStorage,
  test,
} from "./fixtures";
import type { ApiStub } from "./fixtures";
import type { Rule } from "../src/api";

/**
 * Importing an Akamai export into a host.
 *
 * The parser and its mapping are unit-tested; what only a browser can show is
 * that pasting an export drives the preview, that Import posts one rule per
 * ready row at a per-host priority after the existing max, and that a rejected
 * row is reported rather than swallowed.
 */

const prod = distribution();

const redirect = (priority: number, redirectURL: string): Rule =>
  ({
    pk: "www.example.com",
    sk: `REDIRECT#${String(priority).padStart(5, "0")}`,
    type: "erMatchRule",
    statusCode: 301,
    redirectURL,
    matches: [
      { matchType: "path", matchOperator: "equals", matchValue: redirectURL },
    ],
  }) as unknown as Rule;

// Two redirects already at priorities 0 and 1, so an import must land at 2+.
const seeded = [redirect(0, "/existing-0"), redirect(1, "/existing-1")];

const csv = [
  "ruleName,matchURL,redirectURL,result.statusCode",
  "Promo,/promo,/sale,302",
  "Old blog,/blog/*,/news,301",
].join("\n");

const openHostWithRules = async (page: Page, api: ApiStub): Promise<void> => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  api.setHosts([host("www.example.com", { redirects: 2 })]);
  api.setRules(seeded);
  await page.goto("/console/hosts/www.example.com");
  // The Redirects group only renders once the rules have loaded — which is when
  // the taken priorities the import needs are actually known.
  await expect(page.getByRole("heading", { name: "Redirects" })).toBeVisible();
};

test("pastes an export, previews it, and imports the ready rows", async ({
  page,
  api,
}) => {
  await openHostWithRules(page, api);

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Import rules" }),
  ).toBeVisible();

  await page.getByPlaceholder(/Paste an Edge Redirector/).fill(csv);

  // One clean row and one wildcard row (a warning) — both importable, so two
  // ready of which one is warned.
  await expect(page.getByText("Detected: Edge Redirector CSV")).toBeVisible();
  await expect(page.getByText("2 ready")).toBeVisible();
  await expect(page.getByText("1 warning")).toBeVisible();

  await page.getByRole("button", { name: /Import 2 rules/ }).click();
  await expect(page.getByText("Imported 2 rules.")).toBeVisible();

  // One POST per ready row, at priorities assigned per host after the seeded
  // max of 1, carrying the mapped bodies.
  const posts = api.calls.filter(
    (call) => call.method === "POST" && /\/rules$/.test(call.url),
  );
  expect(posts).toHaveLength(2);

  const first = posts[0].body as { priority: number; redirectURL: string; statusCode: number };
  const second = posts[1].body as { priority: number; redirectURL: string };
  expect(first).toMatchObject({
    priority: 2,
    redirectURL: "/sale",
    statusCode: 302,
  });
  expect(second).toMatchObject({ priority: 3, redirectURL: "/news" });

  // The refetch after the import shows the new rules once the modal is closed.
  await page
    .locator(".modal-foot")
    .getByRole("button", { name: "Close" })
    .click();
  await expect(page.getByText("/sale")).toBeVisible();
  await expect(page.getByText("/news")).toBeVisible();
});

test("routes a hostname-conditioned rule to its own host", async ({
  page,
  api,
}) => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  api.setHosts([host("www.example.com")]);
  api.setRules([]);
  await page.goto("/console/hosts/www.example.com");
  await expect(
    page.getByRole("heading", { name: "www.example.com" }),
  ).toBeVisible();

  // Three rules for the target host, one carrying its own hostname condition
  // (→ support.example.com), one broken (→ skipped).
  const json = JSON.stringify([
    { name: "Home", matchURL: "/old-home", redirectURL: "/new-home", statusCode: 301 },
    { name: "Promo", matchURL: "/promo", redirectURL: "/campaigns/summer", statusCode: 302 },
    {
      name: "API",
      redirectURL: "/api/v2",
      statusCode: 301,
      matches: [
        { matchType: "path", matchOperator: "equals", matchValue: "/api" },
        { matchType: "method", matchValue: "GET" },
      ],
    },
    {
      name: "Support",
      redirectURL: "https://help.example.com",
      statusCode: 301,
      matches: [
        { matchType: "hostname", matchOperator: "equals", matchValue: "support.example.com" },
      ],
    },
    { name: "Broken", matchURL: "/broken", statusCode: 301 },
  ]);

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByPlaceholder(/Paste an Edge Redirector/).fill(json);

  // The preview announces the two hosts the file spans.
  await expect(page.getByText("2 hosts")).toBeVisible();

  await page.getByRole("button", { name: /Import 4 rules/ }).click();
  await expect(page.getByText("Imported 4 rules.")).toBeVisible();

  const posts = api.calls.filter(
    (call) => call.method === "POST" && /\/rules$/.test(call.url),
  );
  const toWww = posts.filter((c) => c.url.includes("/hosts/www.example.com/rules"));
  const toSupport = posts.filter((c) =>
    c.url.includes("/hosts/support.example.com/rules"),
  );

  // Three rules landed on the target host, and the hostname-conditioned one was
  // routed to support.example.com instead — the broken row was never posted.
  expect(toWww).toHaveLength(3);
  expect(toSupport).toHaveLength(1);
  expect(toSupport[0].body).toMatchObject({
    redirectURL: "https://help.example.com",
  });
});

test("reports rows the API rejects instead of failing the whole import", async ({
  page,
  api,
}) => {
  await openHostWithRules(page, api);
  api.createRuleReply({
    status: 409,
    body: errorBody("RULE_EXISTS", "a rule with that priority exists"),
  });

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page
    .getByPlaceholder(/Paste an Edge Redirector/)
    .fill("source,target\n/one,/two");

  await page.getByRole("button", { name: /Import 1 rule/ }).click();

  // The run finishes and accounts for the failure rather than throwing.
  await expect(page.getByText("Imported 0 rules.")).toBeVisible();
  await expect(page.getByText(/Row 1:/)).toBeVisible();
});
