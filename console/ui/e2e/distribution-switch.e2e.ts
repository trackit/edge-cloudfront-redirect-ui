import type { Page } from "@playwright/test";
import {
  chip,
  distribution,
  errorBody,
  expect,
  gotoConsole,
  host,
  rows,
  seedStorage,
  test,
} from "./fixtures";
import type { HostSummary, Rule } from "../src/api";

/**
 * Switching distribution lands on the new one's own hosts (CF-58).
 *
 * The selected host is in the URL and the distribution is not, so a host from
 * the distribution just left used to stay selected under the new one and read
 * "No such host". The shared stub answers every target with one host list, so
 * these specs serve each target its own.
 */

const prod = distribution();
const staging = distribution({
  targetId: "t-2",
  distributionId: "E2BBBBBBBBBBBB",
  tableName: "rules-staging",
});

const redirect = (pk: string, redirectURL: string): Rule =>
  ({
    pk,
    sk: "REDIRECT#00100",
    type: "erMatchRule",
    statusCode: 301,
    priority: 100,
    redirectURL,
    matches: [{ matchType: "path", matchOperator: "equals", matchValue: "/x" }],
  }) as unknown as Rule;

interface Served {
  /** Each target's hosts, read on every request so a spec can change them. */
  hosts: Record<string, HostSummary[]>;
  /** Rules by `<targetId> <host>`; a host with no entry has none. */
  rules?: Record<string, Rule[]>;
  /** Targets the API no longer knows: their hosts answer `UNKNOWN_TARGET`. */
  unknown?: string[];
}

/** Every rules list asked for, as `<targetId> <host>`. */
const serve = async (page: Page, served: Served): Promise<string[]> => {
  const asked: string[] = [];
  await page.route(
    (url) =>
      /^\/api\/targets\/[^/]+\/hosts(\/[^/]+\/rules)?$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const [, targetId, , hostName] =
        /^\/api\/targets\/([^/]+)\/hosts(\/([^/]+)\/rules)?$/.exec(
          new URL(route.request().url()).pathname,
        ) ?? [];
      const id = decodeURIComponent(targetId ?? "");
      if (hostName === undefined) {
        if (served.unknown?.includes(id)) {
          return route.fulfill({
            status: 404,
            json: errorBody("UNKNOWN_TARGET", "No such target"),
          });
        }
        return route.fulfill({ json: served.hosts[id] ?? [] });
      }
      const key = `${id} ${decodeURIComponent(hostName)}`;
      asked.push(key);
      return route.fulfill({ json: served.rules?.[key] ?? [] });
    },
  );
  return asked;
};

const pick = async (page: Page, distributionId: string): Promise<void> => {
  await chip(page).click();
  await rows(page).filter({ hasText: distributionId }).click();
};

const title = (page: Page) => page.locator(".host-name");

const twoDistributions = async (page: Page, served: Served) => {
  const asked = await serve(page, served);
  await seedStorage(page, {
    distributions: [prod, staging],
    current: prod.distributionId,
  });
  await gotoConsole(page);
  return asked;
};

test("switching lands on the new distribution's first host", async ({
  page,
}) => {
  await twoDistributions(page, {
    hosts: { "t-1": [host("a.example.com")], "t-2": [host("b.example.com")] },
    rules: { "t-2 b.example.com": [redirect("b.example.com", "/from-b")] },
  });
  await expect(title(page)).toHaveText("a.example.com");

  await pick(page, staging.distributionId);

  await expect(title(page)).toHaveText("b.example.com");
  await expect(page).toHaveURL(/\/console\/hosts\/b\.example\.com$/);
  await expect(page.getByText("/from-b").first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("the new distribution is never asked for the old one's host", async ({
  page,
}) => {
  const asked = await twoDistributions(page, {
    hosts: { "t-1": [host("a.example.com")], "t-2": [host("b.example.com")] },
  });
  await expect(title(page)).toHaveText("a.example.com");

  // For one render the old host list is still on screen with the new target;
  // the request it used to send goes out before the new list comes back.
  const newHosts = page.waitForResponse((response) =>
    response.url().endsWith("/api/targets/t-2/hosts"),
  );
  await pick(page, staging.distributionId);
  await newHosts;

  expect(asked).not.toContain("t-2 a.example.com");
});

test("switching back shows the first distribution's host again", async ({
  page,
}) => {
  await twoDistributions(page, {
    hosts: { "t-1": [host("a.example.com")], "t-2": [host("b.example.com")] },
  });

  await pick(page, staging.distributionId);
  await expect(title(page)).toHaveText("b.example.com");
  await pick(page, prod.distributionId);

  await expect(title(page)).toHaveText("a.example.com");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("switching to a distribution with no host shows its empty state", async ({
  page,
}) => {
  await twoDistributions(page, {
    hosts: { "t-1": [host("a.example.com")], "t-2": [] },
  });

  await pick(page, staging.distributionId);

  await expect(
    page.getByRole("heading", { name: "No hosts yet" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/console$/);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a host name both distributions have shows each one's own rules", async ({
  page,
}) => {
  await twoDistributions(page, {
    hosts: {
      "t-1": [host("www.example.com")],
      "t-2": [host("www.example.com")],
    },
    rules: {
      "t-1 www.example.com": [redirect("www.example.com", "/from-prod")],
      "t-2 www.example.com": [redirect("www.example.com", "/from-staging")],
    },
  });
  await expect(page.getByText("/from-prod").first()).toBeVisible();

  await pick(page, staging.distributionId);

  await expect(page.getByText("/from-staging").first()).toBeVisible();
  await expect(page.getByText("/from-prod")).toHaveCount(0);
});

test("a reload after switching keeps the distribution and its host", async ({
  page,
}) => {
  await twoDistributions(page, {
    hosts: { "t-1": [host("a.example.com")], "t-2": [host("b.example.com")] },
  });
  await pick(page, staging.distributionId);
  await expect(title(page)).toHaveText("b.example.com");

  await page.reload();

  await expect(chip(page)).toContainText(staging.distributionId);
  await expect(title(page)).toHaveText("b.example.com");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a viewer switching lands on the new distribution's host too", async ({
  page,
  api,
}) => {
  api.signedInAs("viewer");
  await twoDistributions(page, {
    hosts: { "t-1": [host("a.example.com")], "t-2": [host("b.example.com")] },
  });

  await pick(page, staging.distributionId);

  await expect(title(page)).toHaveText("b.example.com");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("unlinking lands on the next distribution's host", async ({ page }) => {
  await twoDistributions(page, {
    hosts: { "t-1": [host("a.example.com")], "t-2": [host("b.example.com")] },
  });

  await chip(page).click();
  await page.getByRole("button", { name: "Settings for current" }).click();
  await page.getByRole("button", { name: "Unlink", exact: true }).click();

  await expect(chip(page)).toContainText(staging.distributionId);
  await expect(title(page)).toHaveText("b.example.com");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("linking another distribution lands on its host", async ({ page }) => {
  // The stub names the first target it creates `t-generated`.
  await serve(page, {
    hosts: {
      "t-1": [host("a.example.com")],
      "t-generated": [host("b.example.com")],
    },
  });
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);
  await expect(title(page)).toHaveText("a.example.com");

  await chip(page).click();
  await page.getByRole("button", { name: "Link distribution" }).click();
  await page.getByLabel("CloudFront distribution").fill(staging.distributionId);
  await page.getByLabel("DynamoDB routing table").fill(staging.tableName);
  await page.getByRole("button", { name: "Link", exact: true }).click();

  await expect(chip(page)).toContainText(staging.distributionId);
  await expect(title(page)).toHaveText("b.example.com");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a distribution a teammate unlinked moves to the next one's host", async ({
  page,
}) => {
  // Still in the list (an eventually consistent Scan), but its hosts answer
  // that the API no longer knows it.
  await serve(page, {
    hosts: { "t-1": [host("a.example.com")], "t-2": [host("b.example.com")] },
    unknown: ["t-1"],
  });
  await seedStorage(page, {
    distributions: [prod, staging],
    current: prod.distributionId,
  });

  await page.goto("/console/hosts/a.example.com");

  await expect(chip(page)).toContainText(staging.distributionId);
  await expect(title(page)).toHaveText("b.example.com");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a link to a host still opens that host on load", async ({ page }) => {
  await serve(page, {
    hosts: {
      "t-1": [host("a.example.com"), host("second.example.com")],
      "t-2": [host("b.example.com")],
    },
  });
  await seedStorage(page, {
    distributions: [prod, staging],
    current: prod.distributionId,
  });

  await page.goto("/console/hosts/second.example.com");

  await expect(title(page)).toHaveText("second.example.com");
  await expect(page).toHaveURL(/\/console\/hosts\/second\.example\.com$/);
});

test("settings pointing at another table loads that table's hosts", async ({
  page,
}) => {
  const served: Served = {
    hosts: { "t-1": [host("a.example.com")], "t-2": [host("b.example.com")] },
  };
  await twoDistributions(page, served);
  await expect(title(page)).toHaveText("a.example.com");

  // The API answers by target id; the new table's hosts are what it answers
  // once the target points there.
  served.hosts["t-1"] = [host("new-table.example.com")];
  await chip(page).click();
  await page.getByRole("button", { name: "Settings for current" }).click();
  await page.getByLabel("DynamoDB routing table").fill("rules-prod-v2");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(title(page)).toHaveText("new-table.example.com");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
