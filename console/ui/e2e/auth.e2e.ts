import {
  distribution,
  expect,
  gotoConsole,
  host,
  seedPendingLogin,
  seedStorage,
  test,
} from "./fixtures";

/**
 * Getting into the console, and being kept out of it.
 *
 * None of this is reachable from a unit test: the guard, the redirect it issues
 * and the deep link it preserves are all router behaviour, and the failure mode
 * worth guarding against — a signed-in user bounced to the login page for a
 * frame before being sent back — only appears in a real load.
 */

const prod = distribution();
const www = host("www.example.com");

const seed = (page: import("@playwright/test").Page) =>
  seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });

test("a signed-out visitor is sent to the login page", async ({
  page,
  api,
}) => {
  api.signedInAs(undefined);
  api.setHosts([www]);
  await seed(page);

  await page.goto("/console");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("a signed-in visitor reaches the console without passing through login", async ({
  page,
  api,
}) => {
  // The three-state guard exists for this: with nothing in browser storage the
  // app cannot know who you are until the API answers, and treating that gap as
  // "signed out" shows the login page to someone who is signed in.
  api.setHosts([www]);
  await seed(page);

  const seen: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) seen.push(new URL(frame.url()).pathname);
  });

  await gotoConsole(page);

  expect(seen).not.toContain("/login");
});

test("the login page offers a way back home", async ({ page, api }) => {
  api.signedInAs(undefined);
  await seed(page);

  await page.goto("/login");
  await page.getByRole("link", { name: "Back home" }).click();

  await expect(page).toHaveURL(/\/$/);
});

test("signing in returns to the page that was asked for", async ({
  page,
  api,
}) => {
  // A deep link has to survive the detour: being sent to the console root after
  // asking for one host is a small thing that is felt every time.
  api.signedInAs(undefined);
  api.setHosts([www]);
  await seed(page);

  await page.goto("/console/hosts/www.example.com");
  await expect(page).toHaveURL(/\/login$/);

  // The guard records where it turned the visitor away from, and the login page
  // reads it back — asserted through the control that consumes it.
  api.signedInAs("editor");
  await page.reload();
  await page.goto("/console/hosts/www.example.com");

  await expect(page).toHaveURL(/\/console\/hosts\/www\.example\.com$/);
});

test("an already-signed-in visitor who opens /login is sent on", async ({
  page,
  api,
}) => {
  // Typing the URL, or a stale bookmark. Asking someone to sign in twice is a
  // bug they will report.
  api.setHosts([www]);
  await seed(page);

  await page.goto("/login");

  await expect(page).toHaveURL(/\/console/);
});

test("a completed sign-in lands on the console, not back on the login page", async ({
  page,
  api,
}) => {
  // The regression this exists for. The exchange succeeded and set the cookie,
  // but nothing handed the session to the provider — so the guard was still
  // holding the "signed out" the boot refresh had returned a moment earlier,
  // and sent the browser straight back to /login. A sign-in that worked, thrown
  // away one tick later, looking exactly like a sign-in that failed.
  api.signedInAs(undefined); // no cookie yet, so the boot refresh 401s
  api.exchangeAs("editor");
  api.setHosts([www]);
  await seed(page);
  await seedPendingLogin(page, {
    verifier: "v-1",
    state: "s-1",
    returnTo: "/console",
  });

  await page.goto("/auth/callback?code=good-code&state=s-1");

  await expect(page).toHaveURL(/\/console$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
});

test("a completed sign-in returns to the deep link that was asked for", async ({
  page,
  api,
}) => {
  api.signedInAs(undefined);
  api.exchangeAs("editor");
  api.setHosts([www]);
  await seed(page);
  await seedPendingLogin(page, {
    verifier: "v-1",
    state: "s-1",
    returnTo: "/console/hosts/www.example.com",
  });

  await page.goto("/auth/callback?code=good-code&state=s-1");

  await expect(page).toHaveURL(/\/console\/hosts\/www\.example\.com$/);
});

test("the callback refuses a code that did not come from this browser", async ({
  page,
  api,
}) => {
  // No pending login in this tab, so the state cannot match. This is the CSRF
  // guard, and it has to fail closed on a URL someone was sent.
  api.signedInAs(undefined);
  await seed(page);

  await page.goto("/auth/callback?code=abc&state=not-ours");

  await expect(page.getByRole("alert")).toContainText("no longer valid");
});
