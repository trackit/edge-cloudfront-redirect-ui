import { chip, errorBody, expect, test } from "./fixtures";

/**
 * The link screen: the only way a distribution joins the team's list.
 *
 * The unit suite already covers what `linkDistribution` does with each
 * response. What it cannot reach is the screen around it — whether the submit
 * button is actually disabled, whether an error the API returned is rendered at
 * all, and whether a success reaches the team's list.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/console");
  // The list is asked for after load: until it answers, a spec arranging the
  // API would change the answer to the load rather than to the form.
  await expect(
    page.getByRole("heading", { name: "Link your distribution" }),
  ).toBeVisible();
});

const fill = async (
  page: import("@playwright/test").Page,
  distributionId: string,
  tableName: string,
) => {
  await page.getByLabel("CloudFront distribution").fill(distributionId);
  await page.getByLabel("DynamoDB routing table").fill(tableName);
};

test("shows the link screen when the team has no distribution", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", { name: "Link your distribution" }),
  ).toBeVisible();
  // CF-57: the first step says Link too.
  await expect(page.getByText("1. Link")).toBeVisible();
});

test("a viewer gets no form, and who to ask instead", async ({ page, api }) => {
  api.signedInAs("viewer");
  await page.reload();

  await expect(
    page.getByRole("heading", { name: "Link your distribution" }),
  ).toBeVisible();
  await expect(page.getByText("ask an editor to link one")).toBeVisible();
  await expect(page.getByLabel("CloudFront distribution")).toHaveCount(0);
});

test("keeps submit disabled until both fields have a value", async ({
  page,
}) => {
  const submit = page.getByRole("button", { name: "Link", exact: true });
  await expect(submit).toBeDisabled();

  await page.getByLabel("CloudFront distribution").fill("E1AAAAAAAAAAAA");
  await expect(submit).toBeDisabled();

  await page.getByLabel("DynamoDB routing table").fill("rules-prod");
  await expect(submit).toBeEnabled();

  // Whitespace is not a value — the field is trimmed before it counts.
  await page.getByLabel("DynamoDB routing table").fill("   ");
  await expect(submit).toBeDisabled();
});

test("the region select still looks like a select (CF-35)", async ({
  page,
}) => {
  // `.select` draws its chevron with a background-image, and the dark-card
  // overrides on this form sit one rule away from resetting it — which is
  // exactly what the `background` shorthand did. Asserted on the computed
  // style because that is the only place the collision is visible: the markup
  // is a plain <select> either way, and every other test passes without it.
  const chevron = await page
    .getByLabel("Table region")
    .evaluate((el) => getComputedStyle(el).backgroundImage);

  expect(chevron).toContain("url(");
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
    page.getByRole("button", { name: "Link", exact: true }),
  ).toBeEnabled();
});

test("links, lands on the console, and lists it for the team", async ({
  page,
  api,
}) => {
  await fill(page, "E1AAAAAAAAAAAA", "rules-prod");
  await page.getByRole("button", { name: "Link", exact: true }).click();

  // The chip only exists once something is linked, so it is the signal that
  // the console replaced the form — and unlike the body's copy, it is not
  // slated for replacement by the console skeleton.
  await expect(chip(page)).toContainText("E1AAAAAAAAAAAA");

  // The distribution ID doubles as the target's name, and the region comes from
  // the select's default — this is the whole body the API is sent.
  expect(api.calls).toContainEqual(
    expect.objectContaining({
      method: "POST",
      url: "/api/targets",
      body: {
        name: "E1AAAAAAAAAAAA",
        region: "us-east-1",
        tableName: "rules-prod",
      },
    }),
  );

  // The list is the API's now, so a reload asks it again and finds it there.
  await page.reload();
  await expect(chip(page)).toContainText("E1AAAAAAAAAAAA");
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
  await page.getByRole("button", { name: "Link", exact: true }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  // The heading comes from the code, the prose from the API, and the list from
  // `details` — all three, because the code is the only stable part.
  await expect(alert).toContainText("Check these details");
  await expect(alert).toContainText("Target failed validation");
  await expect(alert.getByRole("listitem")).toHaveText([
    '/tableName no DynamoDB table "rules-prodd" exists in us-east-1',
  ]);

  // Still on the form.
  await expect(
    page.getByRole("button", { name: "Link", exact: true }),
  ).toBeEnabled();
});

test("names the failure when the API cannot be reached", async ({
  page,
  api,
}) => {
  api.createReply({ status: 502, body: errorBody("TARGET_UNREACHABLE", "no") });

  await fill(page, "E1AAAAAAAAAAAA", "rules-prod");
  await page.getByRole("button", { name: "Link", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText(
    "The API cannot reach that table",
  );
});

test("says the API is unreachable when the request never completes", async ({
  page,
}) => {
  // Offline, DNS, TLS, or a refused CORS preflight: `fetch` rejects and there is
  // no status at all. The client turns that into NETWORK_ERROR, and this is the
  // only test that renders what the screen then says.
  await page.route(
    (url) => url.pathname === "/api/targets",
    (route) => route.abort("connectionrefused"),
  );

  await fill(page, "E1AAAAAAAAAAAA", "rules-prod");
  await page.getByRole("button", { name: "Link", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText("Cannot reach the API");
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
  await page.getByRole("button", { name: "Link", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText("Could not link");
  await expect(page.getByRole("alert")).toContainText("504");
});

test("reuses the distribution a teammate already linked", async ({
  page,
  api,
}) => {
  // Linked by someone else after this page loaded the list.
  api.setTargets([
    {
      id: "t-existing",
      name: "E1AAAAAAAAAAAA",
      region: "us-east-1",
      tableName: "rules-prod",
    },
  ]);

  await fill(page, "E1AAAAAAAAAAAA", "rules-prod");
  await page.getByRole("button", { name: "Link", exact: true }).click();

  // A 409 is a success for what the user asked for: it appears once.
  await expect(chip(page)).toContainText("E1AAAAAAAAAAAA");
  await chip(page).click();
  await expect(page.locator("#dist-panel [aria-current]")).toHaveCount(1);
});

test("refuses a distribution already linked to another table", async ({
  page,
  api,
}) => {
  api.setTargets([
    {
      id: "t-existing",
      name: "E1AAAAAAAAAAAA",
      region: "us-east-1",
      tableName: "rules-other",
    },
  ]);

  await fill(page, "E1AAAAAAAAAAAA", "rules-prod");
  await page.getByRole("button", { name: "Link", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText(
    "That distribution is already linked",
  );
});
