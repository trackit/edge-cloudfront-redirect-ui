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
 * What each role may do to a rule.
 *
 * Not reachable from a unit test: the role comes from a token the browser holds,
 * and what it changes is which controls are live on a rendered page.
 */

const prod = distribution();
const www = host("www.example.com", { redirects: 1 });

const redirect: Rule = {
  pk: "www.example.com",
  sk: "REDIRECT#00100",
  type: "erMatchRule",
  statusCode: 301,
  redirectURL: "https://www.example.com/new",
  matches: [{ matchType: "path", matchOperator: "equals", matchValue: "/old" }],
};

const toggle = (page: Page) =>
  page.getByRole("switch", { name: /Disable|Enable/ });

// Scoped to the host's action bar: "Redirect" also names a rule-kind badge and
// each card's summary, so the bare role query matches five things.
const addRedirect = (page: Page) =>
  page.locator(".host-actions").getByRole("button", { name: "Redirect" });

const openHost = async (page: Page): Promise<void> => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);
  await page.getByRole("link").filter({ hasText: "www.example.com" }).click();
};

test("a viewer sees the write controls, disabled and explained", async ({
  page,
  api,
}) => {
  // Disabled rather than hidden: a console missing its buttons reads as broken,
  // where a dead button with a reason reads as a permission. The API refuses
  // either way — this is only what the user is told.
  api.signedInAs("viewer");
  api.setHosts([www]);
  api.setRules([redirect]);
  await openHost(page);

  await expect(addRedirect(page)).toBeDisabled();
  await expect(addRedirect(page)).toHaveAttribute("title", /read-only/i);

  await expect(toggle(page)).toBeDisabled();
  await expect(
    page.locator(".rule-actions").getByRole("button", { name: /^Delete / }),
  ).toBeDisabled();
});

test("a viewer can still open a rule to read it", async ({ page, api }) => {
  // Read-only is not no-access: seeing what a rule does is the main thing a
  // viewer is here for.
  api.signedInAs("viewer");
  api.setHosts([www]);
  api.setRules([redirect]);
  await openHost(page);

  await page.getByRole("button", { name: /^Edit / }).click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Redirect URL")).toBeVisible();
});

test("an editor's controls are live", async ({ page, api }) => {
  api.setHosts([www]);
  api.setRules([redirect]);
  await openHost(page);

  await expect(addRedirect(page)).toBeEnabled();
  await expect(toggle(page)).toBeEnabled();
});

test("the profile menu names the signed-in user and their role", async ({
  page,
  api,
}) => {
  // The role is shown, not just enforced: a viewer who cannot see why the write
  // controls are dead reads it as the console being broken.
  api.signedInAs("viewer");
  api.setHosts([www]);
  await openHost(page);

  await page.getByRole("button", { name: /^Account for/ }).click();

  await expect(page.getByRole("menu")).toContainText("viewer@example.com");
  await expect(page.getByRole("menu")).toContainText("Viewer");
});
