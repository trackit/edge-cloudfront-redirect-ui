import {
  distribution,
  expect,
  gotoConsole,
  host,
  seedStorage,
  test,
} from "./fixtures";
import type { Page } from "@playwright/test";
import type { Rule } from "../src/api";

/**
 * The rewrite editor's origin picker, opened on a rule that already exists.
 *
 * `draftFromRule` is unit-tested and derives the right `originKind` for all
 * three shapes, and it always did — the bug was one layer up, in a picker that
 * had a card for only two of them, so a stored path-only rewrite opened with
 * nothing lit and no control offering the state it was actually in. Only a
 * browser can catch that: the draft was correct on the way in and correct on the
 * way out, and every assertion short of a rendered DOM passed throughout.
 *
 * Hence the load-bearing assertion here, in the words of the ticket: exactly one
 * origin is selected, whichever rule is opened.
 */

const HOST = "www.example.com";
const prod = distribution();

const CONDITION = {
  matchType: "path",
  matchOperator: "equals",
  matchValue: "/old",
  negate: false,
  caseSensitive: false,
};

/** A stored rewrite. The `forwardSettings` is the whole point, so it is the argument. */
const rewrite = (priority: string, forwardSettings: unknown): Rule =>
  ({
    pk: HOST,
    sk: `REWRITE#${priority}`,
    type: "frMatchRule",
    matches: [CONDITION],
    forwardSettings,
  }) as Rule;

const customRule = rewrite("00100", {
  origin: {
    custom: {
      domainName: "legacy-backend.internal.example.com",
      path: "/v1",
      port: 8443,
      protocol: "https-only",
      readTimeout: 30,
      keepaliveTimeout: 5,
      sslProtocols: ["TLSv1.2"],
      customHeaders: {},
    },
  },
  pathAndQS: "/v1",
  useIncomingQueryString: true,
});

const s3Rule = rewrite("00200", {
  origin: {
    s3: {
      authMethod: "origin-access-identity",
      region: "eu-west-3",
      domainName: "example-assets.s3.eu-west-3.amazonaws.com",
      path: "",
      customHeaders: {},
    },
  },
  useIncomingQueryString: false,
});

// No `origin` key at all: the schema's `anyOf` is satisfied by `pathAndQS`
// alone, and this is the rule the picker used to have no answer for.
const pathOnlyRule = rewrite("00300", {
  pathAndQS: "/only",
  useIncomingQueryString: true,
});

const seed = async (page: Page): Promise<void> => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
};

/** The radio the browser considers selected, whichever card it belongs to. */
const selected = (page: Page) =>
  page.locator('input[name="originKind"]:checked');

/** The card that *looks* selected. The class is what the user actually reads. */
const litCard = (page: Page) => page.locator(".origin-card.is-on");

const openHost = async (page: Page): Promise<void> => {
  await gotoConsole(page);
  await page.getByRole("link").filter({ hasText: HOST }).click();
};

const openEditor = async (page: Page, priority: number): Promise<void> => {
  await page
    .getByRole("button", { name: `Edit rewrite at priority ${priority}` })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Edit rewrite" }),
  ).toBeVisible();
};

const cases = [
  {
    stored: "a custom origin",
    priority: 100,
    kind: "custom",
    card: "Custom origin",
    // The fields that exist only for this kind, with the values the rule holds.
    fields: [
      ["#custom-domain", "legacy-backend.internal.example.com"],
      ["#custom-port", "8443"],
    ],
    absent: "#s3-domain",
  },
  {
    stored: "an S3 origin",
    priority: 200,
    kind: "s3",
    card: "S3 origin",
    fields: [
      ["#s3-domain", "example-assets.s3.eu-west-3.amazonaws.com"],
      ["#s3-region", "eu-west-3"],
    ],
    absent: "#custom-domain",
  },
  {
    stored: "no origin, only a path",
    priority: 300,
    kind: "none",
    card: "Path only",
    // Nothing to fill: the rule holds no origin, so neither set of fields shows.
    fields: [],
    absent: "#custom-domain",
  },
] as const;

for (const c of cases) {
  test(`a rewrite with ${c.stored} opens on its own card, fields filled`, async ({
    page,
    api,
  }) => {
    await seed(page);
    api.setHosts([host(HOST, { rewrites: 3 })]);
    api.setRules([customRule, s3Rule, pathOnlyRule]);

    await openHost(page);
    await openEditor(page, c.priority);

    // The ticket, verbatim: something is always selected.
    await expect(selected(page)).toHaveCount(1);
    await expect(selected(page)).toHaveValue(c.kind);
    await expect(litCard(page)).toHaveCount(1);
    await expect(litCard(page)).toContainText(c.card);

    for (const [field, value] of c.fields) {
      await expect(page.locator(field)).toHaveValue(value);
    }
    // The other kind's fields stay out of the form rather than showing blank —
    // a rule has one origin, and two half-filled sections would not say which.
    await expect(page.locator(c.absent)).toHaveCount(0);
  });
}

test("the path-only choice is reachable and reversible", async ({
  page,
  api,
}) => {
  await seed(page);
  api.setHosts([host(HOST, { rewrites: 3 })]);
  api.setRules([customRule, s3Rule, pathOnlyRule]);

  await openHost(page);
  await openEditor(page, 300);

  // A native radio cannot be deselected, so leaving "path only" used to be a
  // one-way door out of it. Going there and back is what the third card buys.
  await page.getByText("Custom origin").click();
  await expect(selected(page)).toHaveValue("custom");
  await expect(page.locator("#custom-domain")).toHaveCount(1);

  await page.getByText("Path only").click();
  await expect(selected(page)).toHaveValue("none");
  await expect(page.locator("#custom-domain")).toHaveCount(0);
});
