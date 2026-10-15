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
 * A refused row's `details` are the only part that says *which field* the API
 * objected to: a `VALIDATION_ERROR`'s message is the same sentence whatever the
 * cause. They were dropped on the way into the failure list, so an import that
 * hit a schema disagreement reported "this row failed" and left the user to
 * guess which cell of their export to fix.
 */
test("names the field the API refused, not just the row", async ({
  page,
  api,
}) => {
  await openHostWithRules(page, api);
  api.createRuleReply({
    status: 400,
    body: errorBody("VALIDATION_ERROR", "Rule failed schema validation", [
      { path: "/redirectURL", message: 'must match pattern "^(?:https?…)$"' },
    ]),
  });

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByPlaceholder(/Paste an Edge Redirector/).fill(csv);
  await page.getByRole("button", { name: /Import 2 rules/ }).click();

  await expect(page.getByText("Imported 0 rules.")).toBeVisible();
  await expect(page.getByText(/Row 1:/)).toBeVisible();
  // The field, and the reason the server gave for it.
  await expect(page.getByText("/redirectURL").first()).toBeVisible();
  await expect(page.getByText(/must match pattern/).first()).toBeVisible();
});

/**
 * The sidebar counts are refreshed on close rather than on success, because
 * refreshing unmounts this modal and would tear the results down before they
 * could be read. That deferral hung on `result`, which editing the source
 * clears — so importing and then touching the textarea lost the refresh, and
 * the counts disagreed with the table until something else reloaded them.
 */
test("refreshes the counts even if the source is edited after a run", async ({
  page,
  api,
}) => {
  await openHostWithRules(page, api);

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByPlaceholder(/Paste an Edge Redirector/).fill(csv);
  await page.getByRole("button", { name: /Import 2 rules/ }).click();
  await expect(page.getByText("Imported 2 rules.")).toBeVisible();

  // Anything that clears the outcome: typing in the source is the easy one.
  await page.getByPlaceholder(/Paste an Edge Redirector/).fill("");

  const before = api.calls.filter(
    (call) => call.method === "GET" && /\/hosts$/.test(call.url),
  ).length;

  // The footer's "Close" belongs to the finished state, which clearing the
  // source has just undone — so the way out is the header's dismiss, exactly as
  // it would be for a user who changed their mind.
  await page.locator(".modal-x").click();

  // `onImported` reloads the host list; that request is the observable proof it
  // fired at all.
  await expect
    .poll(
      () =>
        api.calls.filter(
          (call) => call.method === "GET" && /\/hosts$/.test(call.url),
        ).length,
    )
    .toBeGreaterThan(before);
});

/**
 * A file over the limit must be refused, not truncated.
 *
 * The limit is bytes, but `parseExport`'s own check sees decoded text and
 * compares UTF-16 code units — so a multibyte export can weigh well over the
 * cap while sitting under it. Reading a byte-slice of the file and letting that
 * check refuse it therefore does not work: the truncation lands below the limit
 * the check looks at, nothing refuses it, and the import silently drops
 * whatever fell off the end. The size is read from the file instead, before any
 * of it is read into memory.
 */
test("refuses an oversized file instead of importing part of it", async ({
  page,
  api,
}) => {
  await openHostWithRules(page, api);
  await page.getByRole("button", { name: "Import", exact: true }).click();

  // Multibyte on purpose: two bytes per character, so this is ~12 MB of file
  // and ~6 M code units — over the byte cap, under the same number read as
  // code units, which is exactly the case a slice would have let through.
  // Multibyte, and deliberately under the 5000-row cap so the size path is the
  // one under test: ~4000 long rows of two-byte characters, which weigh ~16 MB
  // as a file while decoding to ~8 M code units. That is the shape that slips
  // past a check comparing code units to a byte limit.
  const header = "ruleName,matchURL,redirectURL,result.statusCode\n";
  const pad = "é".repeat(2000);
  const row = `Rule,/s,/t${pad},301\n`;
  const csv = header + row.repeat(4000);
  expect(Buffer.byteLength(csv)).toBeGreaterThan(10 * 1024 * 1024);
  expect(csv.length).toBeLessThan(10 * 1024 * 1024);

  await page.locator('input[type="file"]').setInputFiles({
    name: "huge.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });

  await expect(page.getByRole("alert")).toContainText("so it was not read");
  // Nothing was previewed, so there is nothing to import — where a byte-slice
  // instead offered a preview of *most* of the file, with no warning at all.
  await expect(
    page.locator(".modal-foot").getByRole("button", { name: /^Import/ }),
  ).toBeDisabled();
  await expect(page.getByText(/\d+ ready/)).toHaveCount(0);
  expect(
    api.calls.filter(
      (call) => call.method === "POST" && /\/rules$/.test(call.url),
    ),
  ).toHaveLength(0);
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

/**
 * A skipped row says why it was skipped (CF-42).
 *
 * Every `redirectURL` finding used to be shown as "Missing redirectURL.", so a
 * row with a perfectly present target — here a capture taken from inside the
 * path, which would redirect relative to the request — was told to add a field
 * it already had, and the message that says how to fix it was never shown.
 */
test('a skipped row shows the reason, not "Missing redirectURL"', async ({
  page,
  api,
}) => {
  await openHostWithRules(page, api);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page
    .getByPlaceholder(/Paste an Edge Redirector/)
    .fill(
      [
        "ruleName,matchURL,redirectURL,result.statusCode",
        "Capture from inside the path,/legacy/*,\\1/moved,301",
        "No target at all,/nowhere,,301",
      ].join("\n"),
    );

  const skipped = page.locator(".import-row.is-skipped");
  await expect(skipped).toHaveCount(2);

  // The present-but-unsafe target: the real reason, under the field's name.
  await expect(skipped.nth(0)).toContainText(
    "Redirect URL starts with a captured group",
  );
  // The genuinely empty one still says it is required.
  await expect(skipped.nth(1)).toContainText("Redirect URL is required");

  await expect(page.getByText("Missing redirectURL")).toHaveCount(0);
});
