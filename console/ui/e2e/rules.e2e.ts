import {
  distribution,
  expect,
  gotoConsole,
  host,
  seedStorage,
  test,
} from "./fixtures";
import type { Page } from "@playwright/test";
import type { Rule } from "../src/api";

/**
 * What each role may do to a rule.
 *
 * Not reachable from a unit test: the role comes from a token the browser holds,
 * and what it changes is which controls are live on a rendered page.
 */

const prod = distribution();
const www = host("www.example.com", { redirects: 1 });

const redirect: Rule = {
  pk: "www.example.com",
  sk: "REDIRECT#00100",
  type: "erMatchRule",
  statusCode: 301,
  redirectURL: "https://www.example.com/new",
  matches: [{ matchType: "path", matchOperator: "equals", matchValue: "/old" }],
};

const rewrite: Rule = {
  pk: "www.example.com",
  sk: "REWRITE#00200",
  type: "frMatchRule",
  matches: [
    { matchType: "path", matchOperator: "contains", matchValue: "/legacy/" },
  ],
  forwardSettings: {
    origin: {
      custom: {
        domainName: "legacy.internal.example.com",
        path: "",
        port: 443,
        protocol: "https-only",
        sslProtocols: ["TLSv1.2"],
        readTimeout: 30,
        keepaliveTimeout: 5,
        customHeaders: {},
      },
    },
    pathAndQS: "/api/v1/legacy",
    useIncomingQueryString: true,
  },
};

const toggle = (page: Page) =>
  page.getByRole("switch", { name: /Disable|Enable/ });

// Scoped to the host's action bar: "Redirect" also names a rule-kind badge and
// each card's summary, so the bare role query matches five things.
const addRedirect = (page: Page) =>
  page.locator(".host-actions").getByRole("button", { name: "Redirect" });

// A create control anywhere other than that action bar. Only meaningful on a
// host that has rules — the empty state's own two buttons are the invitation to
// make a first rule, not a second way to do it.
const strayCreate = (page: Page) =>
  page.getByRole("button", { name: /^(Create|New) (redirect|rewrite)$/i });

const openHost = async (page: Page): Promise<void> => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);
  await page.getByRole("link").filter({ hasText: "www.example.com" }).click();
};

test("a viewer sees the write controls, disabled and explained", async ({
  page,
  api,
}) => {
  // Disabled rather than hidden: a console missing its buttons reads as broken,
  // where a dead button with a reason reads as a permission. The API refuses
  // either way — this is only what the user is told.
  api.signedInAs("viewer");
  api.setHosts([www]);
  api.setRules([redirect]);
  await openHost(page);

  await expect(addRedirect(page)).toBeDisabled();
  await expect(addRedirect(page)).toHaveAttribute("title", /read-only/i);

  await expect(toggle(page)).toBeDisabled();
  await expect(
    page.locator(".rule-actions").getByRole("button", { name: /^Delete / }),
  ).toBeDisabled();

  // The group headers used to carry a create button of their own that nothing
  // disabled, so a viewer got one live write control while every other one was
  // dead and explained (CF-25).
  await expect(strayCreate(page)).toHaveCount(0);
});

test("a viewer's empty host offers no live way to create a rule", async ({
  page,
  api,
}) => {
  // CF-59. The "No rules yet" state's own two buttons were never wired to the
  // role, so a viewer could open the editor and only learn on save.
  api.signedInAs("viewer");
  api.setHosts([host("www.example.com")]);
  api.setRules([]);
  await openHost(page);

  await expect(
    page.getByRole("heading", { name: "No rules yet" }),
  ).toBeVisible();
  for (const name of ["New redirect", "New rewrite"]) {
    const button = page.getByRole("button", { name });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", /read-only/i);
    // And looks it: a disabled .btn used to be styled exactly like a live one.
    await expect(button).toHaveCSS("opacity", "0.5");
  }
});

test("creating a rule is offered once, in the host header", async ({
  page,
  api,
}) => {
  // CF-25. Each group's header had its own "Create redirect" / "Create rewrite",
  // so a host with both kinds showed four ways to add a rule and the screenshot
  // on the ticket has three of them in one frame. Two rules of different kinds
  // is what renders both groups, which is the case that showed it.
  api.setHosts([host("www.example.com", { redirects: 1, rewrites: 1 })]);
  api.setRules([redirect, rewrite]);
  await openHost(page);

  await expect(page.locator(".rule-group")).toHaveCount(2);

  await expect(addRedirect(page)).toBeVisible();
  await expect(strayCreate(page)).toHaveCount(0);
});

test("a viewer can still open a rule to read it", async ({ page, api }) => {
  // Read-only is not no-access: seeing what a rule does is the main thing a
  // viewer is here for.
  api.signedInAs("viewer");
  api.setHosts([www]);
  api.setRules([redirect]);
  await openHost(page);

  await page.getByRole("button", { name: /^Edit / }).click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Redirect URL")).toBeVisible();
});

test("a viewer's rule opens read-only, with nothing to save", async ({
  page,
  api,
}) => {
  // CF-59. The editor took no role, so a viewer could change the fields and
  // only learn on save that the API refuses it.
  api.signedInAs("viewer");
  api.setHosts([www]);
  api.setRules([redirect]);
  await openHost(page);

  await page.getByRole("button", { name: /^Edit / }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("View redirect");
  await expect(page.getByLabel("Redirect URL")).toHaveValue(
    "https://www.example.com/new",
  );
  await expect(page.getByLabel("Redirect URL")).toBeDisabled();
  await expect(dialog.getByRole("switch", { name: "Disabled" })).toBeDisabled();

  const save = dialog.getByRole("button", { name: "Save changes" });
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("title", /read-only/i);

  await dialog
    .locator(".modal-actions")
    .getByRole("button", { name: "Close" })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(
    api.calls.filter((c) => c.method !== "GET" && c.url.includes("/targets")),
  ).toEqual([]);
});

test("a viewer's country rule does not ask the distribution", async ({
  page,
  api,
}) => {
  // The check is a write as far as the API is concerned: a viewer asking would
  // only be refused, and the editor would say the distribution could not be
  // checked.
  api.signedInAs("viewer");
  api.setHosts([www]);
  api.setRules([
    {
      ...redirect,
      matches: [
        ...redirect.matches,
        { matchType: "country", matchOperator: "equals", matchValue: "FR" },
      ],
    } as Rule,
  ]);
  await openHost(page);

  await page.getByRole("button", { name: /^Edit / }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Enabled, the check goes to "loading" as the editor mounts; it never leaves
  // "idle" for a viewer.
  await expect(page.locator("form#rule-editor")).toHaveAttribute(
    "data-geo-check",
    "idle",
  );
  expect(api.calls.filter((c) => c.url.endsWith("/geo-readiness"))).toEqual([]);
});

test("an editor's controls are live", async ({ page, api }) => {
  api.setHosts([www]);
  api.setRules([redirect]);
  await openHost(page);

  await expect(addRedirect(page)).toBeEnabled();
  await expect(toggle(page)).toBeEnabled();
});

test("the profile menu names the signed-in user and their role", async ({
  page,
  api,
}) => {
  // The role is shown, not just enforced: a viewer who cannot see why the write
  // controls are dead reads it as the console being broken.
  api.signedInAs("viewer");
  api.setHosts([www]);
  await openHost(page);

  await page.getByRole("button", { name: /^Account for/ }).click();

  await expect(page.getByRole("menu")).toContainText("viewer@example.com");
  await expect(page.getByRole("menu")).toContainText("Viewer");
});
