import {
  chip,
  distribution,
  errorBody,
  expect,
  gotoConsole,
  readStorage,
  rows,
  seedStorage,
  selectionKey,
  test,
} from "./fixtures";

/**
 * The console as a whole: which screen the team's list produces, and what a
 * round trip through the link/settings forms does to it (CF-56).
 *
 * The helpers are unit-tested; what is only true in a browser is that they are
 * wired to the right buttons and that the result survives a reload.
 */

const prod = distribution();
const staging = distribution({
  targetId: "t-2",
  distributionId: "E2BBBBBBBBBBBB",
  tableName: "rules-staging",
  region: "eu-west-1",
});

const currentRow = (page: import("@playwright/test").Page) =>
  rows(page).and(page.locator('[aria-current="true"]'));

test("a team with no distribution gets the link screen", async ({ page }) => {
  // Not `gotoConsole`: nothing is linked, so the console never renders and
  // there are no hosts to load or fail to load.
  await page.goto("/console");

  await expect(
    page.getByRole("heading", { name: "Link your distribution" }),
  ).toBeVisible();
});

test("a team's distribution goes straight to the console", async ({ page }) => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);

  await expect(chip(page)).toContainText(prod.distributionId);
  await expect(chip(page)).toContainText(prod.tableName);
});

test("a fresh browser with nothing stored still sees the team's list", async ({
  page,
  api,
}) => {
  // No selection seeded: what someone on a new browser or device gets.
  api.setTargets([
    {
      id: prod.targetId,
      name: prod.distributionId,
      tableName: prod.tableName,
      region: prod.region,
    },
  ]);
  await gotoConsole(page);

  await expect(chip(page)).toContainText(prod.distributionId);
});

test("a viewer sees the team's list, read-only", async ({ page, api }) => {
  api.signedInAs("viewer");
  await seedStorage(page, {
    distributions: [prod, staging],
    current: prod.distributionId,
  });
  await gotoConsole(page);

  await chip(page).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Link distribution" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Settings for current" }).click();
  // CF-57: viewers do not get the Unlink section at all.
  await expect(page.getByText("Unlink distribution")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
});

test("the API's list failing is an error, never the link screen", async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === "/api/targets",
    (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify(errorBody("INTERNAL", "boom")),
      }),
  );
  await page.goto("/console");

  await expect(page.getByRole("alert")).toContainText(
    "Could not load the distributions",
  );
  await expect(
    page.getByRole("heading", { name: "Link your distribution" }),
  ).toHaveCount(0);
});

test("the lists left behind by older builds are deleted", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("edgeroute.distributions", "{}");
    window.localStorage.setItem("edgeroute.distribution", "{}");
  });
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);
  await expect(chip(page)).toContainText(prod.distributionId);

  // The init script writes them again on every load, so read them back without
  // navigating.
  expect(await readStorage(page, "edgeroute.distributions")).toBeNull();
  expect(await readStorage(page, "edgeroute.distribution")).toBeNull();
});

test("linking a second distribution appends it and selects it", async ({
  page,
}) => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);

  await chip(page).click();
  await page.getByRole("button", { name: "Link distribution" }).click();
  await page.getByLabel("CloudFront distribution").fill(staging.distributionId);
  await page.getByLabel("DynamoDB routing table").fill(staging.tableName);
  await page.getByLabel("Table region").selectOption(staging.region);
  await page.getByRole("button", { name: "Link", exact: true }).click();

  await expect(chip(page)).toContainText(staging.distributionId);

  await chip(page).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(currentRow(page)).toContainText(staging.distributionId);
});

test("two distributions on one table are two rows", async ({ page }) => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);

  await chip(page).click();
  await page.getByRole("button", { name: "Link distribution" }).click();
  await page.getByLabel("CloudFront distribution").fill("E3CCCCCCCCCCCC");
  await page.getByLabel("DynamoDB routing table").fill(prod.tableName);
  await page.getByRole("button", { name: "Link", exact: true }).click();

  await expect(chip(page)).toContainText("E3CCCCCCCCCCCC");
  await chip(page).click();
  await expect(rows(page)).toHaveCount(2);
});

test("settings saves onto the distribution's target, in place", async ({
  page,
  api,
}) => {
  await seedStorage(page, {
    distributions: [prod, staging],
    current: prod.distributionId,
  });
  await gotoConsole(page);

  await chip(page).click();
  await page.getByRole("button", { name: "Settings for current" }).click();
  await expect(page.getByText("Linked CloudFront distribution")).toBeVisible();
  await page.getByLabel("DynamoDB routing table").fill("rules-prod-v2");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(chip(page)).toContainText("rules-prod-v2");

  // The same target, replaced — not a new one registered beside it.
  expect(api.calls).toContainEqual(
    expect.objectContaining({
      method: "PUT",
      url: `/api/targets/${prod.targetId}`,
      body: {
        name: prod.distributionId,
        region: prod.region,
        tableName: "rules-prod-v2",
      },
    }),
  );

  // Still first, because the menu must not reorder under someone who just
  // saved a setting.
  await chip(page).click();
  await expect(rows(page).first()).toContainText("rules-prod-v2");
  await expect(rows(page)).toHaveCount(2);
});

test("cancelling settings changes nothing", async ({ page, api }) => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);

  await chip(page).click();
  await page.getByRole("button", { name: "Settings for current" }).click();
  await page.getByLabel("DynamoDB routing table").fill("typed-but-abandoned");
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(chip(page)).toContainText(prod.tableName);
  expect(api.calls.some((call) => call.method === "PUT")).toBe(false);
});

test("unlinking removes it for the team and moves to the next one", async ({
  page,
  api,
}) => {
  await seedStorage(page, {
    distributions: [prod, staging],
    current: prod.distributionId,
  });
  await gotoConsole(page);

  await chip(page).click();
  await page.getByRole("button", { name: "Settings for current" }).click();
  // CF-57's copy: it stays live, and where the user lands.
  await expect(page.getByText("It stays live")).toBeVisible();
  await expect(
    page.getByText("switch to your next distribution"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unlink", exact: true }).click();

  await expect(chip(page)).toContainText(staging.distributionId);
  expect(api.calls).toContainEqual(
    expect.objectContaining({
      method: "DELETE",
      url: `/api/targets/${prod.targetId}`,
    }),
  );

  // Gone from the team's list, not only from this page.
  await page.reload();
  await chip(page).click();
  await expect(rows(page)).toHaveCount(1);
});

test("unlinking the last distribution lands on the link screen", async ({
  page,
}) => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);

  await chip(page).click();
  await page.getByRole("button", { name: "Settings for current" }).click();
  await page.getByRole("button", { name: "Unlink", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "Link your distribution" }),
  ).toBeVisible();
});

test("a refused unlink is said in the dialog, and nothing moves", async ({
  page,
  api,
}) => {
  api.removeTargetReply({
    status: 500,
    body: errorBody("INTERNAL", "boom"),
  });
  await seedStorage(page, {
    distributions: [prod, staging],
    current: prod.distributionId,
  });
  await gotoConsole(page);

  await chip(page).click();
  await page.getByRole("button", { name: "Settings for current" }).click();
  await page.getByRole("button", { name: "Unlink", exact: true }).click();

  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "boom",
  );
  await expect(chip(page)).toContainText(prod.distributionId);
});

test("the selected distribution unlinked by a teammate falls back to the first", async ({
  page,
  api,
}) => {
  await seedStorage(page, {
    distributions: [prod, staging],
    current: staging.distributionId,
  });
  await gotoConsole(page);
  await expect(chip(page)).toContainText(staging.distributionId);

  api.setTargets([
    {
      id: prod.targetId,
      name: prod.distributionId,
      tableName: prod.tableName,
      region: prod.region,
    },
  ]);
  await page.reload();

  await expect(chip(page)).toContainText(prod.distributionId);
});

test("the selection survives a reload", async ({ page }) => {
  await seedStorage(page, {
    distributions: [prod, staging],
    current: prod.distributionId,
  });
  await gotoConsole(page);

  await chip(page).click();
  await rows(page).filter({ hasText: staging.distributionId }).click();
  await expect(chip(page)).toContainText(staging.distributionId);

  await page.reload();

  await expect(chip(page)).toContainText(staging.distributionId);
});

test("each user keeps their own selection on a shared browser", async ({
  page,
  api,
}) => {
  await seedStorage(page, {
    distributions: [prod, staging],
    current: prod.distributionId,
  });
  await gotoConsole(page);

  // The editor switches to staging.
  await chip(page).click();
  await rows(page).filter({ hasText: staging.distributionId }).click();
  await expect(chip(page)).toContainText(staging.distributionId);
  expect(await readStorage(page, selectionKey("editor"))).toBe(
    staging.targetId,
  );

  // Someone else signs in on this browser: they get their own selection, never
  // the editor's.
  api.signedInAs("viewer");
  await page.reload();
  await expect(chip(page)).toContainText(prod.distributionId);
});

test("a distribution unlinked by a teammate mid-session moves to the next one", async ({
  page,
}) => {
  await seedStorage(page, {
    distributions: [prod, staging],
    current: prod.distributionId,
  });
  // The API no longer knows prod by the time its hosts are asked for — but the
  // list, an eventually consistent Scan, still returns it. Reloading must not
  // land on prod again and loop.
  let prodHostLoads = 0;
  await page.route(
    (url) => url.pathname === `/api/targets/${prod.targetId}/hosts`,
    async (route) => {
      prodHostLoads += 1;
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify(errorBody("UNKNOWN_TARGET", "No target")),
      });
    },
  );
  await page.goto("/console");

  await expect(chip(page)).toContainText(staging.distributionId);
  await chip(page).click();
  await expect(rows(page)).toHaveCount(1);
  // Settled: prod is not asked for again. (Not an exact count — StrictMode
  // runs the dev build's effects twice.)
  const settled = prodHostLoads;
  await page.waitForTimeout(1000);
  expect(prodHostLoads).toBe(settled);
});
