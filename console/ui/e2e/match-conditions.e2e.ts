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
 * The catch-all warning: a rule with no conditions fires on every request to its
 * host, which the API deliberately still accepts (CF-38), so the console warning
 * is the only thing standing between an author and a host-wide redirect.
 *
 * Not reachable from a unit test — there is no component-render suite here, and
 * what is asserted is a conditional branch of a rendered DOM reacting to real
 * clicks.
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

const warning = (page: Page) =>
  page.getByText(/No conditions, so this rule would fire on/);

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

test("the warning tracks the condition count, both ways", async ({
  page,
  api,
}) => {
  api.setHosts([www]);
  api.setRules([redirect]);
  await openHost(page);

  // A new redirect opens with one blank condition (`emptyRedirect`), so the
  // warning starts hidden — it is reached by emptying the list, not by opening
  // the form.
  await addRedirect(page).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(warning(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Remove condition 1" }).click();
  await expect(warning(page)).toBeVisible();

  // And back: the warning is a function of the current list, not a one-way flag
  // latched the first time the list emptied.
  await page.getByRole("button", { name: "Add condition" }).click();
  await expect(warning(page)).toHaveCount(0);
});

test("a rule that has a condition never shows the warning", async ({
  page,
  api,
}) => {
  api.setHosts([www]);
  api.setRules([redirect]);
  await openHost(page);

  await page.getByRole("button", { name: /^Edit / }).click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Redirect URL")).toBeVisible();
  await expect(warning(page)).toHaveCount(0);
});
