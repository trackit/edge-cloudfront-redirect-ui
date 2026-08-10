import {
  chip,
  distribution,
  expect,
  gotoConsole,
  panel,
  rows,
  seedStorage,
  test,
} from "./fixtures";

/**
 * The environment switcher in the console bar.
 *
 * All of this is behaviour a unit test structurally cannot see: dismissal is two
 * document-level listeners, `mousedown` is deliberately not `click`, and Escape
 * has to put focus back somewhere a keyboard user can carry on from.
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

test.beforeEach(async ({ page }) => {
  await seedStorage(page, {
    distributions: [prod, staging],
    current: prod.distributionId,
  });
  await gotoConsole(page);
});

test("announces its state and what it controls", async ({ page }) => {
  const trigger = chip(page);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(panel(page)).toBeVisible();

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(panel(page)).toBeHidden();
});

test("lists every known distribution and marks the current one", async ({
  page,
}) => {
  await chip(page).click();

  await expect(rows(page)).toHaveCount(2);
  // `aria-current` is rendered on every row as "true"/"false", so presence is
  // not the assertion — the value is.
  await expect(currentRow(page)).toHaveCount(1);
  await expect(currentRow(page)).toContainText(prod.distributionId);
});

test("closes on an outside press", async ({ page }) => {
  await chip(page).click();
  await expect(panel(page)).toBeVisible();

  // Anywhere outside the panel will do, so this takes the landmark rather than
  // the copy inside it — the console body is documented as being replaced by the
  // console skeleton, and this test does not care what it says.
  await page.getByRole("main").click();

  await expect(panel(page)).toBeHidden();
});

test("stays open when the press lands inside it", async ({ page }) => {
  await chip(page).click();
  await panel(page).getByText("Distributions", { exact: true }).click();

  await expect(panel(page)).toBeVisible();
});

test("a drag that starts inside it does not dismiss it", async ({ page }) => {
  await chip(page).click();
  const row = await rows(page).first().boundingBox();
  if (row === null) throw new Error("the panel rendered no rows to drag from");

  // Press inside, release outside — selecting the table name by dragging past
  // the edge. This is the case the `mousedown` binding exists for: bound to
  // `click`, the event lands on the common ancestor of the two, which is
  // outside the panel, and the panel closes under a user who was reading it.
  await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + row.width / 2, row.y + 400);
  await page.mouse.up();

  await expect(panel(page)).toBeVisible();
});

test("Escape closes it and gives focus back to the chip", async ({ page }) => {
  const trigger = chip(page);
  await trigger.click();

  // Move focus into the panel first. With focus still on the chip, closing
  // would leave it there regardless and the assertion below would pass against
  // a component that restores nothing.
  await page.keyboard.press("Tab");
  await expect(rows(page).first()).toBeFocused();

  await page.keyboard.press("Escape");

  await expect(panel(page)).toBeHidden();
  // Otherwise closing takes the focused element with it and drops a keyboard
  // user back to the document, with no way back to where they were.
  await expect(trigger).toBeFocused();
});

test("switching distributions moves the selection and closes", async ({
  page,
}) => {
  await chip(page).click();
  await rows(page).filter({ hasText: staging.distributionId }).click();

  await expect(chip(page)).toContainText(staging.distributionId);
  await expect(chip(page)).toContainText("rules-staging");
  await expect(chip(page)).toContainText("eu-west-1");
  await expect(panel(page)).toBeHidden();

  // And the mark follows, on the next open.
  await chip(page).click();
  await expect(currentRow(page)).toContainText(staging.distributionId);
});

test("re-selecting the current distribution is a no-op that still closes", async ({
  page,
}) => {
  await chip(page).click();
  await currentRow(page).click();

  // The selected row stays clickable on purpose — disabling it would make the
  // row the user is most likely to aim at the only dead one in the list.
  await expect(panel(page)).toBeHidden();
  await expect(chip(page)).toContainText(prod.distributionId);
});

test("reaching the connect screen for a new distribution", async ({ page }) => {
  await chip(page).click();
  await page.getByRole("button", { name: "Add distribution" }).click();

  await expect(
    page.getByRole("heading", { name: "Connect your distribution" }),
  ).toBeVisible();
  // Empty, not prefilled — this is a new environment, not an edit.
  await expect(page.getByLabel("CloudFront distribution")).toHaveValue("");
});

test("settings opens prefilled with the current distribution", async ({
  page,
}) => {
  await chip(page).click();
  await page.getByRole("button", { name: "Settings for current" }).click();

  await expect(
    page.getByRole("heading", { name: "Distribution settings" }),
  ).toBeVisible();
  await expect(page.getByLabel("CloudFront distribution")).toHaveValue(
    prod.distributionId,
  );
  await expect(page.getByLabel("DynamoDB routing table")).toHaveValue(
    prod.tableName,
  );
  // Editing must not offer a one-click way to overwrite a working environment.
  await expect(
    page.getByRole("button", { name: "Use sample values" }),
  ).toBeHidden();
});
