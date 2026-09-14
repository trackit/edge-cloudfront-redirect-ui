import type { Page } from "@playwright/test";
import {
  chip,
  distribution,
  expect,
  gotoConsole,
  host,
  seedStorage,
  test,
} from "./fixtures";

/**
 * Where the Table region options come from (CF-34).
 *
 * The console used to carry its own list of seven regions. It was too narrow —
 * the API accepts thirty-two by default, and the other twenty-five could not be
 * chosen at all — and too wide, because `ALLOWED_REGIONS` replaces that default
 * per deployment, so a dev environment narrowed to one region still offered
 * seven and rejected six of them on save.
 *
 * Only a browser shows this: the options are what the API answered, for a form
 * that has to stay completable when it cannot ask.
 */

const regionSelect = (page: Page) => page.getByLabel("Table region");

const optionValues = async (page: Page): Promise<string[]> =>
  regionSelect(page)
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );

test("offers the regions the deployment allows, not a list of its own", async ({
  page,
  api,
}) => {
  // None of these three was in the old shortlist, which is the point: they are
  // regions the API has always accepted and the console could not reach.
  api.setRegions(["us-east-2", "ca-central-1", "eu-north-1"]);

  await page.goto("/console");

  await expect(
    page.getByRole("heading", { name: "Connect your distribution" }),
  ).toBeVisible();
  await expect(regionSelect(page)).toBeVisible();
  await expect
    .poll(() => optionValues(page))
    .toEqual(["ca-central-1", "eu-north-1", "us-east-2"]);

  // And the form does not start on a region this deployment rejects.
  // `emptyDistribution` defaults to us-east-1, which is not allowed here, so a
  // draft left untouched would otherwise submit straight into a 400.
  await expect(regionSelect(page)).toHaveValue("ca-central-1");
});

test("narrows to one option when the deployment allows one region", async ({
  page,
  api,
}) => {
  // The deployed dev environment: `allowed_regions = ["us-east-1"]`. Offering
  // anything else is offering a save that the API answers with a 400.
  api.setRegions(["us-east-1"]);

  await page.goto("/console");

  await expect(regionSelect(page)).toBeVisible();
  await expect.poll(() => optionValues(page)).toEqual(["us-east-1"]);
});

test("stays completable when it cannot ask what is allowed", async ({
  page,
  api,
}) => {
  // A console that cannot render its own connect form because one endpoint is
  // down would be a worse bug than the one this fixes.
  api.failMeta();
  api.createReply({
    status: 201,
    body: {
      id: "t-1",
      name: "E1AAAAAAAAAAAA",
      region: "us-east-1",
      tableName: "rules-prod",
    },
  });

  await page.goto("/console");

  await expect(regionSelect(page)).toBeVisible();
  expect((await optionValues(page)).length).toBeGreaterThan(0);

  await page.getByLabel("CloudFront distribution").fill("E1AAAAAAAAAAAA");
  await page.getByLabel("DynamoDB routing table").fill("rules-prod");
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  // Not merely rendered — the form still completes and lands in the console.
  await expect(chip(page)).toContainText("rules-prod");
});

test("keeps a stored region the deployment no longer allows", async ({
  page,
  api,
}) => {
  /*
    A distribution connected while eu-west-1 was allowed, opened in Settings
    after the deployment narrowed to us-east-1. The select must still show
    eu-west-1: a `<select>` whose value is absent from its options renders
    blank, and saving would then write us-east-1 over a region nobody touched.
  */
  const prod = distribution({ region: "eu-west-1", tableName: "rules-prod" });
  api.setRegions(["us-east-1"]);
  api.setHosts([host("www.example.com")]);
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);

  await chip(page).click();
  await page.getByRole("button", { name: "Settings for current" }).click();

  await expect(regionSelect(page)).toHaveValue("eu-west-1");
  await expect
    .poll(() => optionValues(page))
    .toEqual(["eu-west-1", "us-east-1"]);
});
