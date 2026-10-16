import {
  distribution,
  expect,
  gotoConsole,
  seedStorage,
  test,
} from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Dark mode: the switch in the profile menu, and what the page starts in.
 *
 * The theme is set on <html> by an inline script before first paint, so these
 * read `data-theme` there rather than any component's state.
 */

const theme = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.theme);

const DARK = "(prefers-color-scheme: dark)";

const html = (page: Page) => page.locator("html");

const darkSwitch = (page: Page) =>
  page.getByRole("menuitemcheckbox", { name: "Dark mode" });

const openConsole = async (page: Page): Promise<void> => {
  await seedStorage(page, {
    distributions: [distribution()],
    current: distribution().distributionId,
  });
  await gotoConsole(page);
};

test("the profile menu's switch turns dark mode on and off", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openConsole(page);
  await expect(html(page)).toHaveAttribute("data-theme", "light");

  await page.locator(".profile-trigger").click();
  await expect(darkSwitch(page)).toHaveAttribute("aria-checked", "false");
  await darkSwitch(page).click();

  // The menu stays open, so the change can be undone in place.
  await expect(darkSwitch(page)).toHaveAttribute("aria-checked", "true");
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(11, 19, 34)",
  );

  await darkSwitch(page).click();
  await expect(darkSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect(html(page)).toHaveAttribute("data-theme", "light");
});

test("the choice survives a reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openConsole(page);
  await page.locator(".profile-trigger").click();
  await darkSwitch(page).click();

  await page.reload();

  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await page.locator(".profile-trigger").click();
  await expect(darkSwitch(page)).toHaveAttribute("aria-checked", "true");
});

test("with no choice made, it follows the system", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openConsole(page);
  await expect(html(page)).toHaveAttribute("data-theme", "dark");

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => theme(page)).toBe("light");
});

test("a choice made outranks the system", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openConsole(page);
  await page.locator(".profile-trigger").click();
  await darkSwitch(page).click();
  await expect(html(page)).toHaveAttribute("data-theme", "light");

  await page.reload();
  await expect(html(page)).toHaveAttribute("data-theme", "light");
});

test("a choice holds for the visit even when storage is blocked", async ({
  page,
}) => {
  // Private modes that refuse storage: nothing can be remembered, but the
  // system changing must not undo what was just chosen.
  // Only the theme's key, so the console's own seeded storage still works.
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "edgeroute.theme") throw new Error("blocked");
      setItem.call(this, key, value);
    };
  });
  await page.emulateMedia({ colorScheme: "light" });
  await openConsole(page);
  await page.locator(".profile-trigger").click();
  await darkSwitch(page).click();
  await expect(html(page)).toHaveAttribute("data-theme", "dark");

  // The system going dark then light. The page only hears it a moment later,
  // so wait for the change event itself: asserting straight away would pass
  // before the listener had a chance to undo the choice.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => page.evaluate((query) => matchMedia(query).matches, DARK))
    .toBe(true);
  await page.evaluate((query) => {
    const w = window as unknown as { seen: Promise<void>; mq: MediaQueryList };
    w.mq = matchMedia(query);
    w.seen = new Promise((resolve) =>
      w.mq.addEventListener("change", () => setTimeout(resolve, 50), {
        once: true,
      }),
    );
  }, DARK);
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(
    () => (window as unknown as { seen: Promise<void> }).seen,
  );

  await expect(html(page)).toHaveAttribute("data-theme", "dark");
});

test("a page without the profile menu follows the system too", async ({
  page,
  api,
}) => {
  api.signedInAs(undefined);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/login");
  await expect(html(page)).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".profile-trigger")).toHaveCount(0);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
});
