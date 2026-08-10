import {
  distribution,
  expect,
  gotoConsole,
  host,
  seedStorage,
  test,
} from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * The host rail and the host in the URL.
 *
 * All of this is behaviour a unit test cannot reach: `resolveHostView` is already
 * unit-tested, but nothing there proves the rail renders links a browser can
 * follow, that `aria-current` lands on the right row, that the back button moves
 * between hosts, or that a mixed-case address is corrected in the address bar
 * rather than merely matched internally.
 *
 * The rule counts come from the server, so every mutation reloads the list
 * instead of patching it — the specs below assert the reload happened, because a
 * component that guessed the new counts would look identical until the numbers
 * disagreed.
 */

const prod = distribution();

const www = host("www.example.com", { redirects: 2, rewrites: 1 });
const shop = host("shop.example.com", { redirects: 1 });
const assets = host("assets.example.com");

const seed = async (page: Page, hosts = [assets, shop, www]) => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  return hosts;
};

const row = (page: Page, name: string) =>
  page.getByRole("link").filter({ hasText: name });

/** How many times the page asked for the host list. */
const listCalls = (calls: { method: string; url: string }[]) =>
  calls.filter((c) => c.method === "GET" && c.url.endsWith("/hosts")).length;

test("lists every host with its rule count and badges", async ({
  page,
  api,
}) => {
  api.setHosts(await seed(page));
  await gotoConsole(page);

  await expect(page.getByRole("navigation", { name: "Hosts" })).toBeVisible();
  await expect(page.locator(".hosts-count")).toHaveText("3");

  // Singular and plural both, and the total rather than either kind: the badges
  // break it down, the count says how much is there.
  await expect(row(page, "www.example.com")).toContainText("3 rules");
  await expect(row(page, "shop.example.com")).toContainText("1 rule");
  await expect(row(page, "assets.example.com")).toContainText("No rules");

  // A kind with no rules gets no badge at all, rather than a zero.
  await expect(row(page, "www.example.com")).toContainText("2R");
  await expect(row(page, "www.example.com")).toContainText("1W");
  await expect(row(page, "shop.example.com")).toContainText("1R");
  await expect(row(page, "shop.example.com")).not.toContainText("W");
  await expect(row(page, "assets.example.com")).not.toContainText("R");
});

test("a host is a real link, so the browser's own affordances work", async ({
  page,
  api,
}) => {
  api.setHosts(await seed(page));
  await gotoConsole(page);

  // An href rather than a click handler is what makes middle-click and
  // copy-link-address work, and it is the reason Back moves between hosts below.
  await expect(row(page, "shop.example.com")).toHaveAttribute(
    "href",
    "/console/hosts/shop.example.com",
  );
});

test("marks the addressed host, for the eye and for a screen reader", async ({
  page,
  api,
}) => {
  api.setHosts(await seed(page));
  await gotoConsole(page);

  // No host in the URL lands on the first, which is the API's sort order.
  await expect(page).toHaveURL("/console/hosts/assets.example.com");

  await row(page, "shop.example.com").click();
  await expect(page).toHaveURL("/console/hosts/shop.example.com");

  // The highlight is a class; `aria-current` is what a screen reader hears, so
  // the test asserts on that and not on `.is-active`.
  await expect(row(page, "shop.example.com")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(row(page, "www.example.com")).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator("h1.host-name")).toHaveText("shop.example.com");
});

test("the back button moves between hosts", async ({ page, api }) => {
  api.setHosts(await seed(page));
  await gotoConsole(page);

  await row(page, "shop.example.com").click();
  await expect(page.locator("h1.host-name")).toHaveText("shop.example.com");
  await row(page, "www.example.com").click();
  await expect(page.locator("h1.host-name")).toHaveText("www.example.com");

  await page.goBack();
  await expect(page.locator("h1.host-name")).toHaveText("shop.example.com");

  // The hostless `/console` was replaced rather than pushed, so going back past
  // the first host leaves the console instead of bouncing off a redirect.
  await page.goBack();
  await expect(page.locator("h1.host-name")).toHaveText("assets.example.com");
});

test("a mixed-case address is corrected, not merely matched", async ({
  page,
  api,
}) => {
  api.setHosts(await seed(page, [www]));
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });

  await page.goto("/console/hosts/WWW.Example.COM");

  // A host's identity is case-insensitive and the API stores it lowercased, so a
  // typed or shared link has to find the host — and the address bar must not go
  // on showing a spelling that differs from every link the rail produces.
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("h1.host-name")).toHaveText("www.example.com");
  await expect(page).toHaveURL("/console/hosts/www.example.com");
  await expect(row(page, "www.example.com")).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("shows a host the table stored with case in it", async ({ page, api }) => {
  // `listHosts` returns `pk` values straight from the table, and a row written
  // before the API lowercased its keys still carries the case it was stored with.
  // Compared verbatim, the console called the target's only host "No such host".
  // Two hosts, so that failing to leave the deleted one is visible below rather
  // than being covered by the empty view.
  api.setHosts([host("WWW.Example.com", { redirects: 1 }), shop]);
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });

  await gotoConsole(page);

  await expect(page).toHaveURL("/console/hosts/www.example.com");
  await expect(page.getByRole("alert")).toHaveCount(0);
  // The row still reads as the table holds it, but it is the row being shown, and
  // `aria-current` is the only thing that says so to a screen reader.
  await expect(row(page, "WWW.Example.com")).toHaveAttribute(
    "aria-current",
    "page",
  );

  // And the page leaves the host it was showing when that host is deleted, which
  // needs the same comparison a third time — without it the console stays parked
  // on the host it just removed and calls it "No such host".
  await page.getByRole("button", { name: "Delete WWW.Example.com" }).click();
  api.setHosts([shop]);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete host" })
    .click();

  await expect(page).toHaveURL("/console/hosts/shop.example.com");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("names a host that is not in the target rather than showing nothing", async ({
  page,
  api,
}) => {
  api.setHosts(await seed(page, [www]));
  await gotoConsole(page);

  await page.goto("/console/hosts/gone.example.com");

  // A stale link, or a host someone else deleted. An empty pane would read as a
  // host that simply has no rules.
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("No such host");
  await expect(alert).toContainText("gone.example.com");
  // Still addressed, so the rail and the title stay put and the URL is copyable.
  await expect(page.locator("h1.host-name")).toHaveText("gone.example.com");
});

test("an empty target invites adding a host, keeping the rail", async ({
  page,
  api,
}) => {
  api.setHosts([]);
  await seed(page);
  await gotoConsole(page);

  await expect(
    page.getByRole("heading", { name: "No hosts yet" }),
  ).toBeVisible();

  // The rail stays rather than moving its add button to the middle of the screen
  // for this one case and back again afterwards — so both buttons exist here, and
  // each is located within its own region rather than by a name they share.
  const rail = page.getByRole("navigation", { name: "Hosts" });
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("button", { name: "Add a host" })).toBeVisible();
  await expect(
    page.locator("main").getByRole("button", { name: "Add a host" }),
  ).toBeVisible();
});

test("a failed load says so and can be retried", async ({ page, api }) => {
  await seed(page);
  api.setHosts([www]);

  /*
    Fails for as long as this flag is set, then hands the request back to the
    fixture's stub. A counter would not do: React runs the load effect twice on
    mount in development, so "fail the first call" leaves the second succeeding
    and the console never reaches its error state at all.

    Deliberately not `unroute` to lift it either — that matches on the handler it
    was given, and a fresh arrow function is a different reference, so the failing
    route would stay installed and the retry would fail for the wrong reason.
  */
  let failing = true;
  await page.route(
    (url) => url.pathname.endsWith("/hosts"),
    async (route) => {
      if (!failing) return route.fallback();
      // Not the API's error envelope either: a 503 from a gateway is HTML, and it
      // still has to produce a readable message rather than a crash.
      await route.fulfill({
        status: 503,
        contentType: "text/html",
        body: "<h1>503</h1>",
      });
    },
  );
  await page.goto("/console");

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Could not load the hosts");

  // Not a dead end: the same request again is the whole remedy.
  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(row(page, "www.example.com")).toBeVisible();
});

/*
  Dismissing either modal, four ways each.

  Two things are asserted every time: that the parent was told (the dialog is
  gone, and a second open still works), and that focus came back to the control
  that opened it. The second is what a keyboard user notices — a dialog that
  closes without handing focus back drops them at the top of the document — and
  it depends on the *order* of `close()` and the parent's unmount, which is not
  something a component test can see.

  `chip.e2e.ts` holds the distribution panel to the same standard.
*/
const focusedLabel = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement?.getAttribute("aria-label") ??
      document.activeElement?.textContent?.trim() ??
      document.activeElement?.tagName ??
      "",
  );

test.describe("dismissing the add-host modal", () => {
  const open = (page: Page) =>
    page
      .getByRole("navigation", { name: "Hosts" })
      .getByRole("button", { name: "Add a host" })
      .click();

  test.beforeEach(async ({ page, api }) => {
    api.setHosts(await seed(page, [www]));
    await gotoConsole(page);
  });

  for (const [how, dismiss] of [
    ["Escape", (page: Page) => page.keyboard.press("Escape")],
    [
      "the close button",
      (page: Page) => page.getByRole("button", { name: "Close" }).click(),
    ],
    [
      "Cancel",
      (page: Page) => page.getByRole("button", { name: "Cancel" }).click(),
    ],
    [
      "a click on the backdrop",
      // The dialog element itself is the backdrop; its child is the form, so a
      // click at the very top-left of the element lands outside it.
      (page: Page) =>
        page.getByRole("dialog").click({ position: { x: 2, y: 2 } }),
    ],
  ] as const) {
    test(`closes on ${how} and gives focus back`, async ({ page }) => {
      await open(page);
      await expect(page.getByRole("dialog")).toBeVisible();

      await dismiss(page);

      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await focusedLabel(page)).toBe("Add a host");

      // Nothing was added, and the button still works — a dismissal that left the
      // parent believing the modal was open would make it dead for the session.
      await expect(row(page, "www.example.com")).toBeVisible();
      await open(page);
      await expect(page.getByRole("dialog")).toBeVisible();
    });
  }
});

test("dismissing the delete dialog keeps the host and restores focus", async ({
  page,
  api,
}) => {
  api.setHosts(await seed(page, [www]));
  await gotoConsole(page);

  await page.getByRole("button", { name: "Delete www.example.com" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await focusedLabel(page)).toBe("Delete www.example.com");
  await expect(row(page, "www.example.com")).toBeVisible();
});

test("adding a host reloads the list and lands on it", async ({
  page,
  api,
}) => {
  api.setHosts(await seed(page, [www]));
  await gotoConsole(page);
  const before = listCalls(api.calls);

  await page.getByRole("button", { name: "Add a host" }).click();
  await page.getByLabel("Host name").fill("Shop.Example.com");
  // The server lowercases what it stores, and the stub answers the same way.
  api.setHosts([shop, www]);
  await page.getByRole("button", { name: "Add host" }).click();

  // Navigating is what makes the add feel finished; the reload is what makes the
  // counts honest, since the host may already have had rules.
  await expect(page).toHaveURL("/console/hosts/shop.example.com");
  await expect(page.locator("h1.host-name")).toHaveText("shop.example.com");
  expect(listCalls(api.calls)).toBeGreaterThan(before);
  await expect(row(page, "shop.example.com")).toContainText("1 rule");
});

test("deleting the current host names its rules, then leaves it", async ({
  page,
  api,
}) => {
  api.setHosts(await seed(page, [shop, www]));
  await gotoConsole(page);
  await row(page, "www.example.com").click();

  await page.getByRole("button", { name: "Delete www.example.com" }).click();

  // The confirmation names what goes with the host — those counts are only in
  // the list, which is why the dialog is handed the whole summary.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("2 redirects and 1 rewrite");

  api.setHosts([shop]);
  await dialog.getByRole("button", { name: "Delete host" }).click();

  // The host being read is gone, so the console picks the first that remains
  // rather than leaving the page on a host that no longer exists.
  await expect(page).toHaveURL("/console/hosts/shop.example.com");
  await expect(row(page, "www.example.com")).toHaveCount(0);
});

test("deleting the first host in the rail leaves it for the next one", async ({
  page,
  api,
}) => {
  /*
    Position matters, which is why this is not covered by the case above deleting
    `www`. Leaving the deleted host goes via the hostless URL so that "which host
    now" is decided in one place — and that decision reads the list. Reloading
    without dropping the old list first let it redirect onto `hosts[0]`, the host
    just deleted, and settle there reporting "No such host".
  */
  api.setHosts(await seed(page, [assets, www]));
  await gotoConsole(page);
  await expect(page).toHaveURL("/console/hosts/assets.example.com");

  await page.getByRole("button", { name: "Delete assets.example.com" }).click();
  api.setHosts([www]);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete host" })
    .click();

  await expect(page).toHaveURL("/console/hosts/www.example.com");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("deleting another host does not move the page", async ({ page, api }) => {
  api.setHosts(await seed(page, [shop, www]));
  await gotoConsole(page);
  await row(page, "www.example.com").click();

  await page.getByRole("button", { name: "Delete shop.example.com" }).click();
  api.setHosts([www]);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete host" })
    .click();

  // Deleting a host from the list must not move whoever is reading another one.
  await expect(page).toHaveURL("/console/hosts/www.example.com");
  await expect(page.locator("h1.host-name")).toHaveText("www.example.com");
  await expect(row(page, "shop.example.com")).toHaveCount(0);
});

test("deleting the last host lands on the empty view", async ({
  page,
  api,
}) => {
  api.setHosts(await seed(page, [www]));
  await gotoConsole(page);

  await page.getByRole("button", { name: "Delete www.example.com" }).click();
  api.setHosts([]);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete host" })
    .click();

  await expect(
    page.getByRole("heading", { name: "No hosts yet" }),
  ).toBeVisible();
});

test("a delete that fails leaves the host and says why", async ({
  page,
  api,
}) => {
  api.setHosts(await seed(page, [www]));
  await gotoConsole(page);

  api.deleteHostReply({
    status: 502,
    body: {
      error: { code: "TARGET_UNREACHABLE", message: "Cannot reach the table" },
    },
  });

  await page.getByRole("button", { name: "Delete www.example.com" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Delete host" }).click();

  // The dialog stays open with the reason: closing it would leave the user
  // believing a host was removed that is still there.
  await expect(dialog).toContainText("Could not delete the host");
  await expect(dialog).toContainText("Cannot reach the table");
  await expect(row(page, "www.example.com")).toBeVisible();
});
