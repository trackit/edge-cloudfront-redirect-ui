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
 * The geolocation condition in the rule editor.
 *
 * `countries.test.ts` already proves the grouping and the search are right, and
 * `rule-draft.test.ts` proves a stored rule survives the trip to the form and
 * back. What only a browser shows is that they are wired to each other: that
 * choosing the type swaps three columns for the picker, that clicking a chip
 * reaches `matchValue`, that a stored rule opens with the right chips lit, and
 * that a code our list has never heard of is offered, kept, and flagged rather
 * than silently swallowed.
 */

const prod = distribution();
const HOST = "www.example.com";

/**
 * A code the picker's generated list does not contain, and that matches nothing
 * by name either — so a search for it finds no country and the escape hatch is
 * offered.
 *
 * Not "ZZ", which looks like the obvious choice and is not: "Congo -
 * Brazzaville" contains "zz", so the search does find a country. Check any
 * replacement against both the codes and the names in `countries.gen.ts`.
 */
const UNKNOWN = "QQ";

const geoRedirect = (matchValue: string, negate = false): Rule =>
  ({
    pk: HOST,
    sk: "REDIRECT#00100",
    type: "erMatchRule",
    statusCode: 302,
    redirectURL: "https://www.example.fr/boutique",
    matches: [
      { matchType: "path", matchOperator: "equals", matchValue: "/shop" },
      { matchType: "country", matchOperator: "equals", matchValue, negate },
    ],
  }) as Rule;

const open = async (page: Page, rules: Rule[] = []): Promise<void> => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);
  await page.getByRole("link").filter({ hasText: HOST }).click();
  void rules;
};

const editor = (page: Page) => page.getByRole("dialog");
/**
 * Indexed and scoped to the drawer. `getByLabel` matches an accessible name by
 * substring, so unscoped this also caught the list's "Filter by rule type"
 * group, and a rule with two conditions has two of these.
 */
const typeSelect = (page: Page, at = 0) =>
  editor(page).getByLabel("Type").nth(at);
const search = (page: Page) => page.getByPlaceholder("Search countries...");
const chipFor = (page: Page, code: string) =>
  editor(page).getByRole("button", { name: new RegExp(`\\b${code}\\b`) });
const selectedBox = (page: Page) => editor(page).locator(".countries-selected");

/** Every chip currently pressed, which is the picker's whole visible state. */
const pressed = (page: Page) =>
  editor(page).locator(".country-chip[aria-pressed='true']");

const newRedirect = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "New redirect" }).click();
  await expect(editor(page)).toBeVisible();
};

const editFirst = async (page: Page): Promise<void> => {
  await page
    .getByRole("button", { name: /^Edit / })
    .first()
    .click();
  await expect(editor(page)).toBeVisible();
};

test.beforeEach(async ({ api }) => {
  api.setHosts([host(HOST, { redirects: 1 })]);
});

test("choosing the type swaps the value field for the picker", async ({
  page,
}) => {
  await open(page);
  await newRedirect(page);

  // The three columns a condition normally has.
  await expect(editor(page).getByLabel("Operator")).toBeVisible();
  await expect(editor(page).getByLabel("Value")).toBeVisible();

  await typeSelect(page).selectOption("country");

  // Operator and Value are gone rather than disabled: a country condition can
  // only be `equals`, and a visible control with no effect is a trap.
  await expect(editor(page).getByLabel("Operator")).toHaveCount(0);
  await expect(editor(page).getByLabel("Value")).toHaveCount(0);
  await expect(search(page)).toBeVisible();

  // So are the two chips a condition normally carries: `negate` is the
  // picker's own Exclude button, and case cannot mean anything on two
  // uppercase letters.
  await expect(
    editor(page).getByRole("button", { name: "Negate" }),
  ).toHaveCount(0);
  await expect(
    editor(page).getByRole("button", { name: "Case sensitive" }),
  ).toHaveCount(0);
});

test("the dropdown names it Geographic location, not country", async ({
  page,
}) => {
  // The stored value is `country`, so `city` and `region` can join it later.
  // What the user reads is the mockup's wording.
  await open(page);
  await newRedirect(page);

  await expect(
    typeSelect(page).getByRole("option", { name: "Geographic location" }),
  ).toHaveAttribute("value", "country");
});

test("clicking a country selects it, and clicking it again does not", async ({
  page,
}) => {
  await open(page);
  await newRedirect(page);
  await typeSelect(page).selectOption("country");

  await expect(selectedBox(page)).toContainText("No country selected yet");

  await chipFor(page, "FR").click();
  await expect(selectedBox(page)).toContainText("France");
  await expect(pressed(page)).toHaveCount(1);

  await chipFor(page, "DE").click();
  await expect(pressed(page)).toHaveCount(2);
  await expect(selectedBox(page)).toContainText("Germany");

  await chipFor(page, "FR").click();
  await expect(pressed(page)).toHaveCount(1);
  await expect(selectedBox(page)).not.toContainText("France");
});

test("the search filters the list, by name and by code", async ({ page }) => {
  await open(page);
  await newRedirect(page);
  await typeSelect(page).selectOption("country");

  await search(page).fill("germ");
  await expect(chipFor(page, "DE")).toBeVisible();
  await expect(chipFor(page, "FR")).toHaveCount(0);

  await search(page).fill("FR");
  await expect(chipFor(page, "FR")).toBeVisible();
  await expect(chipFor(page, "DE")).toHaveCount(0);
});

test("a selected country stays visible while the search excludes it", async ({
  page,
}) => {
  // Hiding the current value makes the row look empty, and the user cannot
  // deselect what they cannot see.
  await open(page);
  await newRedirect(page);
  await typeSelect(page).selectOption("country");

  await chipFor(page, "FR").click();
  await search(page).fill("germ");

  await expect(chipFor(page, "FR")).toBeVisible();
  await expect(pressed(page)).toHaveCount(1);
});

test("Exclude these countries toggles, and says which state it is in", async ({
  page,
}) => {
  await open(page);
  await newRedirect(page);
  await typeSelect(page).selectOption("country");

  const exclude = editor(page).getByRole("button", {
    name: "Exclude these countries",
  });

  // `aria-pressed` rather than a label that changes: a button that only says
  // what it does cannot say whether it is already doing it.
  await expect(exclude).toHaveAttribute("aria-pressed", "false");
  await exclude.click();
  await expect(exclude).toHaveAttribute("aria-pressed", "true");
  await exclude.click();
  await expect(exclude).toHaveAttribute("aria-pressed", "false");
});

test("editing a stored rule opens with its countries already selected", async ({
  page,
  api,
}) => {
  api.setRules([geoRedirect("BE FR")]);
  await open(page);
  await editFirst(page);

  await expect(typeSelect(page, 1)).toHaveValue("country");
  await expect(pressed(page)).toHaveCount(2);
  await expect(selectedBox(page)).toContainText("Belgium");
  await expect(selectedBox(page)).toContainText("France");
});

test("editing an excluding rule opens with Exclude already on", async ({
  page,
  api,
}) => {
  api.setRules([geoRedirect("US", true)]);
  await open(page);
  await editFirst(page);

  await expect(
    editor(page).getByRole("button", { name: "Exclude these countries" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("a code our list has never heard of is offered, kept and flagged", async ({
  page,
}) => {
  // The resilience story, end to end in a browser. The code stands in for both
  // a typo and a country CloudFront started reporting after our list was last
  // generated — indistinguishable from here, which is why the answer is a
  // warning and not a refusal.
  await open(page);
  await newRedirect(page);
  await typeSelect(page).selectOption("country");

  await search(page).fill(UNKNOWN);
  await expect(editor(page).getByText(/No country matches/)).toBeVisible();

  const offer = editor(page).getByRole("button", {
    name: `Use code ${UNKNOWN}`,
  });
  await expect(offer).toBeVisible();
  await offer.click();

  // Kept, under its own heading, and selected.
  await expect(selectedBox(page)).toContainText(UNKNOWN);
  await expect(editor(page).getByText("Not in our list")).toBeVisible();
  await expect(pressed(page)).toHaveCount(1);

  // Flagged, but the rule is still saveable: the save button stays enabled.
  await expect(editor(page).getByText(/not in our country list/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create rule" })).toBeEnabled();
});

test("a search that cannot be a country code offers nothing", async ({
  page,
}) => {
  // Three letters is not an ISO 3166-1 alpha-2 code, so the schema would reject
  // it. Offering a value that cannot be saved is worse than offering none.
  // "FRA" would be the tempting example and is the wrong one: it matches France
  // by name, so the search does find something.
  await open(page);
  await newRedirect(page);
  await typeSelect(page).selectOption("country");

  await search(page).fill("zzz");

  await expect(editor(page).getByText(/No country matches/)).toBeVisible();
  await expect(
    editor(page).getByRole("button", { name: /^Use code/ }),
  ).toHaveCount(0);
});

test("a stored unknown code opens visible and selected", async ({
  page,
  api,
}) => {
  // The half of the round trip only a browser proves: a save replaces the whole
  // rule, so a code the picker declines to render is a code the next save
  // deletes. `rule-draft.test.ts` pins the conversion; this pins the screen.
  api.setRules([geoRedirect(`FR ${UNKNOWN}`)]);
  await open(page);
  await editFirst(page);

  await expect(selectedBox(page)).toContainText(UNKNOWN);
  await expect(selectedBox(page)).toContainText("France");
  await expect(pressed(page)).toHaveCount(2);
  await expect(editor(page).getByText(/not in our country list/)).toBeVisible();
});

test("the editor says the distribution has to report the country", async ({
  page,
}) => {
  // Without this, a user creates a rule that quietly never fires and has no way
  // to find out why: the cache policy is not something the console can see.
  await open(page);
  await newRedirect(page);

  await expect(editor(page).getByText(/CloudFront-Viewer-Country/)).toHaveCount(
    0,
  );

  await typeSelect(page).selectOption("country");

  await expect(
    editor(page).getByText(/CloudFront-Viewer-Country/),
  ).toBeVisible();
  await expect(editor(page).getByText(/origin request stage/)).toBeVisible();
});

test("switching away from a country clears the value", async ({ page }) => {
  // A country code is not a path. Carrying "FR" into a path condition would
  // save a rule matching the literal path "FR".
  await open(page);
  await newRedirect(page);
  await typeSelect(page).selectOption("country");
  await chipFor(page, "FR").click();

  await typeSelect(page).selectOption("path");

  await expect(editor(page).getByLabel("Value")).toHaveValue("");
});
