import type { Page } from "@playwright/test";
import {
  distribution,
  expect,
  gotoConsole,
  host,
  seedStorage,
  test,
} from "./fixtures";
import type { Rule } from "../src/api";

/**
 * The Relative URL toggle (CF-33).
 *
 * Switching it on drops the scheme and host from the redirect target, which is
 * a reformat when the target is this host and a retarget when it is not: `/x`
 * served from www.example.com goes to www.example.com/x, whatever other host
 * the rule used to name. Neither the toggle's own state nor the remembered
 * origin exists outside the open editor, so this is only visible in a browser.
 */

const prod = distribution();
const www = host("www.example.com", { redirects: 1 });

const redirectTo = (redirectURL: string): Rule =>
  ({
    pk: "www.example.com",
    sk: "REDIRECT#00100",
    type: "erMatchRule",
    statusCode: 301,
    redirectURL,
    matches: [{ matchType: "path", matchOperator: "equals", matchValue: "/x" }],
  }) as unknown as Rule;

const relativeToggle = (page: Page) =>
  page.getByRole("switch").filter({ hasText: "Relative URL" });

const urlField = (page: Page) => page.getByLabel("Redirect URL");

const openEditor = async (page: Page): Promise<void> => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);
  await page.getByRole("link").filter({ hasText: "www.example.com" }).click();
  await page.getByRole("button", { name: /^Edit / }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
};

test("refuses to relativise a redirect that points at another host", async ({
  page,
  api,
}) => {
  // The bug this exists for. Toggling here used to answer "/x", and toggling
  // back answered "https://www.example.com/x" — a redirect to a different site,
  // reached by pressing the same switch twice.
  api.setHosts([www]);
  api.setRules([redirectTo("https://shop.example.com/x")]);
  await openEditor(page);

  await expect(relativeToggle(page)).toBeDisabled();
  // And says which host it would have sent people to instead, rather than
  // being mysteriously dead.
  await expect(relativeToggle(page)).toContainText("shop.example.com");
  await expect(relativeToggle(page)).toContainText("www.example.com");
  await expect(urlField(page)).toHaveValue("https://shop.example.com/x");
});

test("relativises a redirect that points at this host", async ({
  page,
  api,
}) => {
  api.setHosts([www]);
  api.setRules([redirectTo("https://www.example.com/x")]);
  await openEditor(page);

  await expect(relativeToggle(page)).toBeEnabled();
  await relativeToggle(page).click();

  await expect(urlField(page)).toHaveValue("/x");
});

test("gives back the address it took, scheme and port included", async ({
  page,
  api,
}) => {
  // Re-deriving would answer https://www.example.com/x, changing the scheme and
  // dropping the port of a URL the user only meant to write a shorter way.
  api.setHosts([www]);
  api.setRules([redirectTo("http://www.example.com:8080/x")]);
  await openEditor(page);

  await relativeToggle(page).click();
  await expect(urlField(page)).toHaveValue("/x");

  await relativeToggle(page).click();
  await expect(urlField(page)).toHaveValue("http://www.example.com:8080/x");
});

test("keeps the remembered host behind a path the user edits", async ({
  page,
  api,
}) => {
  api.setHosts([www]);
  api.setRules([redirectTo("http://www.example.com:8080/x")]);
  await openEditor(page);

  await relativeToggle(page).click();
  await urlField(page).fill("/somewhere-else");
  await relativeToggle(page).click();

  // The path is theirs; the origin is the part they could not see.
  await expect(urlField(page)).toHaveValue(
    "http://www.example.com:8080/somewhere-else",
  );
});

test("a rule stored as a path still becomes an absolute URL on this host", async ({
  page,
  api,
}) => {
  // Reopened later, so there is nothing remembered. Deriving the host is right
  // here: a stored path does mean "whichever host asked".
  api.setHosts([www]);
  api.setRules([redirectTo("/x")]);
  await openEditor(page);

  await expect(relativeToggle(page)).toBeEnabled();
  await expect(relativeToggle(page)).toHaveAttribute("aria-checked", "true");

  await relativeToggle(page).click();

  await expect(urlField(page)).toHaveValue("https://www.example.com/x");
});
