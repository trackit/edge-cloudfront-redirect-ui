import { errorBody, expect, readStorage, test } from "./fixtures";

/**
 * The connect screen: the only way a distribution comes to exist.
 *
 * The unit suite already covers what `connectDistribution` does with each
 * response. What it cannot reach is the screen around it — whether the submit
 * button is actually disabled, whether an error the API returned is rendered at
 * all, and whether a success leaves anything behind in storage.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/console");
});

const fill = async (
  page: import("@playwright/test").Page,
  distributionId: string,
  tableName: string,
) => {
  await page.getByLabel("CloudFront distribution").fill(distributionId);
  await page.getByLabel("DynamoDB routing table").fill(tableName);
};

test("shows the connect screen when nothing is stored", async ({ page }) => {
  await expect(
    page.getByRole("heading", { name: "Connect your distribution" }),
  ).toBeVisible();
});

test("keeps submit disabled until both fields have a value", async ({
  page,
}) => {
  const submit = page.getByRole("button", { name: "Connect", exact: true });
  await expect(submit).toBeDisabled();

  await page.getByLabel("CloudFront distribution").fill("E1AAAAAAAAAAAA");
  await expect(submit).toBeDisabled();

  await page.getByLabel("DynamoDB routing table").fill("rules-prod");
  await expect(submit).toBeEnabled();

  // Whitespace is not a value — the field is trimmed before it counts.
  await page.getByLabel("DynamoDB routing table").fill("   ");
  await expect(submit).toBeDisabled();
});

test("fills the form from the sample values", async ({ page }) => {
  await page.getByRole("button", { name: "Use sample values" }).click();

  await expect(page.getByLabel("CloudFront distribution")).toHaveValue(
    "E2QWERTY123456",
  );
  await expect(page.getByLabel("DynamoDB routing table")).toHaveValue(
    "edgeroute-rules",
  );
  await expect(
    page.getByRole("button", { name: "Connect", exact: true }),
  ).toBeEnabled();
});

test("connects, lands on the console, and remembers it", async ({
  page,
  api,
}) => {
  await fill(page, "E1AAAAAAAAAAAA", "rules-prod");
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "No rules yet" }),
  ).toBeVisible();

  // The distribution ID doubles as the target's name, and the region comes from
  // the select's default — this is the whole body the API is sent.
  expect(api.calls).toContainEqual({
    method: "POST",
    url: "/api/targets",
    body: {
      name: "E1AAAAAAAAAAAA",
      region: "us-east-1",
      tableName: "rules-prod",
    },
  });

  // The id the server assigned has to survive into storage, or a reload lands
  // back on this screen.
  const stored = await readStorage(page);
  expect(JSON.parse(stored ?? "null")).toEqual({
    distributions: [
      {
        targetId: "t-generated",
        distributionId: "E1AAAAAAAAAAAA",
        tableName: "rules-prod",
        region: "us-east-1",
      },
    ],
    current: "E1AAAAAAAAAAAA",
  });
});

test("renders a validation failure field by field", async ({ page, api }) => {
  api.createReply({
    status: 400,
    body: errorBody("VALIDATION_ERROR", "Target failed validation", [
      {
        path: "/tableName",
        message: 'no DynamoDB table "rules-prodd" exists in us-east-1',
      },
    ]),
  });

  await fill(page, "E1AAAAAAAAAAAA", "rules-prodd");
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  // The heading comes from the code, the prose from the API, and the list from
  // `details` — all three, because the code is the only stable part.
  await expect(alert).toContainText("Check these details");
  await expect(alert).toContainText("Target failed validation");
  await expect(alert.getByRole("listitem")).toHaveText([
    '/tableName no DynamoDB table "rules-prodd" exists in us-east-1',
  ]);

  // Still on the form, and nothing was remembered.
  await expect(
    page.getByRole("button", { name: "Connect", exact: true }),
  ).toBeEnabled();
  expect(await readStorage(page)).toBeNull();
});

test("names the failure when the API cannot be reached", async ({
  page,
  api,
}) => {
  api.createReply({ status: 502, body: errorBody("TARGET_UNREACHABLE", "no") });

  await fill(page, "E1AAAAAAAAAAAA", "rules-prod");
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText(
    "The API cannot reach that table",
  );
});

test("survives a response that is not the API's envelope", async ({ page }) => {
  // API Gateway's own error page, or a proxy in front of it. The screen has to
  // say something rather than crash on `body.error.code`.
  await page.route(
    (url) => url.pathname === "/api/targets",
    (route) =>
      route.fulfill({
        status: 504,
        contentType: "text/html",
        body: "<html>504 Gateway Timeout</html>",
      }),
  );

  await fill(page, "E1AAAAAAAAAAAA", "rules-prod");
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText("Could not connect");
  await expect(page.getByRole("alert")).toContainText("504");
});

test("reuses an existing target when the table is already registered", async ({
  page,
  api,
}) => {
  api.createReply({
    status: 409,
    body: errorBody(
      "TARGET_EXISTS",
      'table "rules-prod" is already registered',
    ),
  });
  api.setTargets([
    {
      id: "t-existing",
      name: "someone else",
      region: "us-east-1",
      tableName: "rules-prod",
    },
  ]);

  await fill(page, "E1AAAAAAAAAAAA", "rules-prod");
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  // A 409 is a success for what the user asked for: point me at this table.
  await expect(
    page.getByRole("heading", { name: "No rules yet" }),
  ).toBeVisible();
  await expect(page.getByText("target t-existing")).toBeVisible();
});
