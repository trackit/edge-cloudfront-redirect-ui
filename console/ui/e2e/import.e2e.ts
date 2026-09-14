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
  // An absolute match URL is reduced to its path — importable, but warned.
  "Old blog,https://www.example.com/blog,/news,301",
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

  // One clean row and one warned row (an absolute match URL) — both importable,
  // so two ready of which one is warned.
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

  const first = posts[0].body as {
    priority: number;
    redirectURL: string;
    statusCode: number;
  };
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

/**
 * The query-string default is the one thing an import changes that the preview
 * cannot show — a CSV carries no `useIncomingQueryString` column, so every row
 * from one lands with it off, the opposite of a rule typed by hand. Stated once
 * above the preview, and only when rows actually drop it.
 */
test("states that imported rules drop the incoming query string", async ({
  page,
  api,
}) => {
  await openHostWithRules(page, api);

  await page.getByRole("button", { name: "Import", exact: true }).click();
  const note = page.getByText(/drop the incoming query string/);
  // Nothing loaded yet: no rows, so nothing to caveat.
  await expect(note).toBeHidden();

  await page.getByPlaceholder(/Paste an Edge Redirector/).fill(csv);
  await expect(note).toBeVisible();

  // A source that says to keep it has nothing to warn about.
  await page
    .getByPlaceholder(/Paste an Edge Redirector/)
    .fill(
      [
        "ruleName,matchURL,redirectURL,result.statusCode,useIncomingQueryString",
        "Promo,/promo,/sale,302,true",
      ].join("\n"),
    );
  await expect(page.getByText("1 ready")).toBeVisible();
  await expect(note).toBeHidden();
});

/**
 * Re-importing the same file is how an interrupted run is finished, so it has to
 * be safe: the rules that landed are recognised and left alone instead of being
 * created a second time at a fresh priority, where nothing would flag them.
 */
test("re-importing the same export creates nothing twice", async ({
  page,
  api,
}) => {
  await openHostWithRules(page, api);

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByPlaceholder(/Paste an Edge Redirector/).fill(csv);
  await page.getByRole("button", { name: /Import 2 rules/ }).click();
  await expect(page.getByText("Imported 2 rules.")).toBeVisible();
  await page
    .locator(".modal-foot")
    .getByRole("button", { name: "Close" })
    .click();

  const postsAfterFirst = api.calls.filter(
    (call) => call.method === "POST" && /\/rules$/.test(call.url),
  ).length;

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByPlaceholder(/Paste an Edge Redirector/).fill(csv);
  await page.getByRole("button", { name: /Import 2 rules/ }).click();

  await expect(page.getByText("Imported 0 rules.")).toBeVisible();
  await expect(page.getByText(/2 already existed/)).toBeVisible();
  expect(
    api.calls.filter(
      (call) => call.method === "POST" && /\/rules$/.test(call.url),
    ),
  ).toHaveLength(postsAfterFirst);
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

  // Two rules for the target host, one carrying its own hostname condition
  // (→ support.example.com), one broken and one whose `method` condition cannot
  // be translated (→ both skipped).
  const json = JSON.stringify([
    {
      name: "Home",
      matchURL: "/old-home",
      redirectURL: "/new-home",
      statusCode: 301,
    },
    {
      name: "Promo",
      matchURL: "/promo",
      redirectURL: "/campaigns/summer",
      statusCode: 302,
    },
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
        {
          matchType: "hostname",
          matchOperator: "equals",
          matchValue: "support.example.com",
        },
      ],
    },
    { name: "Broken", matchURL: "/broken", statusCode: 301 },
  ]);

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByPlaceholder(/Paste an Edge Redirector/).fill(json);

  // The preview announces the two hosts the file spans.
  await expect(page.getByText("2 hosts")).toBeVisible();

  await page.getByRole("button", { name: /Import 3 rules/ }).click();
  await expect(page.getByText("Imported 3 rules.")).toBeVisible();

  const posts = api.calls.filter(
    (call) => call.method === "POST" && /\/rules$/.test(call.url),
  );
  const toWww = posts.filter((c) =>
    c.url.includes("/hosts/www.example.com/rules"),
  );
  const toSupport = posts.filter((c) =>
    c.url.includes("/hosts/support.example.com/rules"),
  );

  // Two rules landed on the target host, and the hostname-conditioned one was
  // routed to support.example.com instead — the broken row and the untranslatable
  // one were never posted.
  expect(toWww).toHaveLength(2);
  expect(toSupport).toHaveLength(1);
  expect(toSupport[0].body).toMatchObject({
    redirectURL: "https://help.example.com",
  });
});

/**
 * A domain-move rule as a real export writes it: the visible condition is the
 * Akamai idiom for "everything", and the guard that actually decides is the
 * regex over the full URL. Leading the row with the idiom would read as "the
 * whole site redirects", which is what the row does *not* say.
 */
test("leads a row with the condition that really guards it", async ({
  page,
  api,
}) => {
  await openHostWithRules(page, api);

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByPlaceholder(/Paste an Edge Redirector/).fill(
    JSON.stringify([
      {
        name: "domain move",
        redirectURL: "https://new.example.com/nl",
        statusCode: 301,
        matches: [
          { matchType: "path", matchOperator: "contains", matchValue: "/ /*" },
          {
            matchType: "regex",
            matchOperator: "equals",
            matchValue: "https://(www\\.)?old.example.com/.*",
          },
        ],
      },
    ]),
  );

  const row = page.locator(".import-row").first();
  await expect(row.locator(".import-from")).toContainText("old.example.com");
  await expect(row.locator(".import-from")).not.toContainText("/ /*");
  // And the note says which host it belongs on, since it is not this one.
  await expect(row).toContainText("only fires on requests to old.example.com");
});

/**
 * A batch lands after the host's current highest priority, so a host whose last
 * rule sits at the top of the range has no room left. Named as that, before the
 * request: the API would answer with a schema error about a number, which says
 * nothing about what to do next.
 */
test("says so when a host has no priority left, without posting", async ({
  page,
  api,
}) => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  api.setHosts([host("www.example.com", { redirects: 1 })]);
  api.setRules([redirect(99999, "/last")]);
  await page.goto("/console/hosts/www.example.com");
  await expect(page.getByRole("heading", { name: "Redirects" })).toBeVisible();

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page
    .getByPlaceholder(/Paste an Edge Redirector/)
    .fill("source,target\n/one,/two");
  await page.getByRole("button", { name: /Import 1 rule/ }).click();

  await expect(page.getByText("Imported 0 rules.")).toBeVisible();
  await expect(
    page.getByText(/no priority left on www\.example\.com/),
  ).toBeVisible();
  expect(
    api.calls.filter(
      (call) => call.method === "POST" && /\/rules$/.test(call.url),
    ),
  ).toHaveLength(0);
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

/**
 * The Formats help (CF-32).
 *
 * All of it is browser behaviour: that the panel escapes the dialog's scroll
 * container, that it survives being taller than the space under its button, and
 * that it goes away on the gestures people actually use. The content of each tab
 * is checked against the parser in `test/import-formats.test.ts`, so these only
 * assert that the right tab is showing.
 */

const openFormats = async (page: Page, api: ApiStub): Promise<void> => {
  await openHostWithRules(page, api);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("button", { name: "Formats" }).click();
};

const popover = (page: Page) =>
  page.getByRole("group", { name: "Accepted import formats" });

test("the Formats help names every format the importer accepts", async ({
  page,
  api,
}) => {
  await openFormats(page, api);

  // Four, not the three the ticket listed: the policy CSV is a format the
  // importer detects, and a help panel that omits it sends someone off to
  // reshape a file that would have imported as it was.
  const tabs = popover(page).getByRole("tab");
  await expect(tabs).toHaveCount(4);
  await expect(tabs).toHaveText([
    "Edge Redirector CSV",
    "Edge Redirector policy CSV",
    "Simple CSV",
    "matchRules JSON",
  ]);
});

test("the Formats help shows one format at a time", async ({ page, api }) => {
  await openFormats(page, api);

  // The first tab is selected without being clicked, so the panel is never
  // empty on open.
  await expect(
    popover(page).getByRole("tab", { name: "Edge Redirector CSV" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(popover(page).getByRole("tabpanel")).toContainText("ruleName");

  await popover(page).getByRole("tab", { name: "matchRules JSON" }).click();

  await expect(popover(page).getByRole("tabpanel")).toContainText("matchRules");
  await expect(popover(page).getByRole("tabpanel")).not.toContainText(
    "ruleName",
  );
});

test("the Formats help is not trapped inside the dialog's scroll area", async ({
  page,
  api,
}) => {
  // The acceptance criterion that needs a DOM assertion rather than an eye: an
  // inline panel is clipped by `.modal-body`'s overflow the moment it is taller
  // than the room under its button, which — with an example in it — it is.
  await openFormats(page, api);

  await expect(popover(page)).toBeVisible();
  await expect(page.locator(".modal-body .formats-popover")).toHaveCount(0);
  await expect(page.locator("body > .formats-popover")).toHaveCount(1);
});

test("the Formats help closes on the gestures that should close it", async ({
  page,
  api,
}) => {
  await openFormats(page, api);
  await expect(popover(page)).toBeVisible();

  // Toggling the button it came from.
  await page.getByRole("button", { name: "Formats" }).click();
  await expect(popover(page)).toHaveCount(0);

  // A click outside it — on the dialog, which must stay open.
  await page.getByRole("button", { name: "Formats" }).click();
  await expect(popover(page)).toBeVisible();
  await page.getByRole("heading", { name: "Import rules" }).click();
  await expect(popover(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();

  // Escape takes the panel and leaves the dialog, so a file loaded to check its
  // format is not thrown away along with the help about that format.
  await page.getByRole("button", { name: "Formats" }).click();
  await expect(popover(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();

  // And the second Escape closes the dialog, as it did before.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
