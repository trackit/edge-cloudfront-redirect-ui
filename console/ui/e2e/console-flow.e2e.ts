import {
  chip,
  distribution,
  expect,
  readStorage,
  rows,
  seedLegacyStorage,
  seedStorage,
  test,
} from "./fixtures";

/**
 * The console as a whole: which screen a given storage state produces, and what
 * a round trip through the add/settings forms leaves behind.
 *
 * The reducers are unit-tested; what is only true in a browser is that they are
 * wired to the right buttons and that the result survives a reload.
 */

const prod = distribution();
const staging = distribution({
  targetId: "t-2",
  distributionId: "E2BBBBBBBBBBBB",
  tableName: "rules-staging",
  region: "eu-west-1",
});

test("an empty browser gets the connect screen", async ({ page }) => {
  await page.goto("/console");

  await expect(
    page.getByRole("heading", { name: "Connect your distribution" }),
  ).toBeVisible();
});

test("a stored distribution goes straight to the console", async ({ page }) => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await page.goto("/console");

  await expect(chip(page)).toContainText(prod.distributionId);
  await expect(page.getByText(`target ${prod.targetId}`)).toBeVisible();
});

test("a corrupt entry does not cost the user the rest of the list", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "edgeroute.distributions",
      JSON.stringify({
        // Predates `targetId`: unusable, and the console could address no rules
        // with it. The entry beside it is still perfectly good.
        distributions: [
          { distributionId: "E0OLD", tableName: "t", region: "r" },
          {
            targetId: "t-1",
            distributionId: "E1AAAAAAAAAAAA",
            tableName: "rules-prod",
            region: "us-east-1",
          },
        ],
        current: "E0OLD",
      }),
    );
  });
  await page.goto("/console");

  // Rendered, rather than being sent back to connect for someone else's bug.
  await expect(chip(page)).toContainText("E1AAAAAAAAAAAA");
});

test("a browser from before the switcher keeps its environment", async ({
  page,
}) => {
  await seedLegacyStorage(page, prod);
  await page.goto("/console");

  await expect(chip(page)).toContainText(prod.distributionId);

  // One-way: the list is written and the old key is dropped, so a later load
  // cannot resurrect a stale environment.
  expect(JSON.parse((await readStorage(page)) ?? "null")).toEqual({
    distributions: [prod],
    current: prod.distributionId,
  });
  expect(await readStorage(page, "edgeroute.distribution")).toBeNull();
});

test("adding a second distribution appends it and selects it", async ({
  page,
  api,
}) => {
  api.createReply({
    status: 201,
    body: {
      id: "t-2",
      name: staging.distributionId,
      region: staging.region,
      tableName: staging.tableName,
    },
  });
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await page.goto("/console");

  await chip(page).click();
  await page.getByRole("button", { name: "Add distribution" }).click();
  await page.getByLabel("CloudFront distribution").fill(staging.distributionId);
  await page.getByLabel("DynamoDB routing table").fill(staging.tableName);
  await page.getByLabel("Table region").selectOption(staging.region);
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(chip(page)).toContainText(staging.distributionId);

  await chip(page).click();
  // Both are there, and the new one is the selected one.
  await expect(rows(page)).toHaveCount(2);
  await expect(
    rows(page).and(page.locator('[aria-current="true"]')),
  ).toContainText(staging.distributionId);
});

test("settings edits the current entry in place", async ({ page, api }) => {
  api.createReply({
    status: 201,
    body: {
      id: "t-moved",
      name: prod.distributionId,
      region: "us-east-1",
      tableName: "rules-prod-v2",
    },
  });
  await seedStorage(page, {
    distributions: [prod, staging],
    current: prod.distributionId,
  });
  await page.goto("/console");

  await chip(page).click();
  await page.getByRole("button", { name: "Settings for current" }).click();
  await page.getByLabel("DynamoDB routing table").fill("rules-prod-v2");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(chip(page)).toContainText("rules-prod-v2");

  // Replaced, not appended — and still first, because the menu must not reorder
  // under someone who just saved a setting.
  const stored = JSON.parse((await readStorage(page)) ?? "null") as {
    distributions: { distributionId: string; tableName: string }[];
  };
  expect(stored.distributions).toHaveLength(2);
  expect(stored.distributions[0]).toMatchObject({
    distributionId: prod.distributionId,
    tableName: "rules-prod-v2",
    targetId: "t-moved",
  });
});

test("cancelling settings changes nothing", async ({ page }) => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await page.goto("/console");
  const before = await readStorage(page);

  await chip(page).click();
  await page.getByRole("button", { name: "Settings for current" }).click();
  await page.getByLabel("DynamoDB routing table").fill("typed-but-abandoned");
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(chip(page)).toContainText(prod.tableName);
  expect(await readStorage(page)).toBe(before);
});

test("the selection survives a reload", async ({ page }) => {
  await seedStorage(page, {
    distributions: [prod, staging],
    current: prod.distributionId,
  });
  await page.goto("/console");

  await chip(page).click();
  await rows(page).filter({ hasText: staging.distributionId }).click();
  await expect(chip(page)).toContainText(staging.distributionId);

  await page.reload();

  // The whole point of persisting `current`: a reload is not a way to lose which
  // environment you were working in.
  await expect(chip(page)).toContainText(staging.distributionId);
});
