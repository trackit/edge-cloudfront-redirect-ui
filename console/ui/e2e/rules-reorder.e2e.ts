import {
  distribution,
  errorBody,
  expect,
  gotoConsole,
  host,
  seedStorage,
  test,
} from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import type { Rule } from "../src/api";

/**
 * Dragging rules into a new order (CF-31).
 *
 * The arithmetic is unit-tested in `test/reorder.test.ts`; none of what is here
 * can be: pointer capture, an insertion line positioned from real geometry, and
 * rows that have to move before the request comes back and snap back when it is
 * refused.
 */

const prod = distribution();
const www = host("www.example.com", { redirects: 3, rewrites: 1 });

const redirect = (priority: string, path: string): Rule => ({
  pk: "www.example.com",
  sk: `REDIRECT#${priority}`,
  type: "erMatchRule",
  statusCode: 301,
  redirectURL: `https://www.example.com${path}`,
  matches: [{ matchType: "path", matchOperator: "equals", matchValue: path }],
});

const rewrite: Rule = {
  pk: "www.example.com",
  sk: "REWRITE#00150",
  type: "frMatchRule",
  matches: [{ matchType: "path", matchOperator: "equals", matchValue: "/app" }],
  forwardSettings: { pathAndQS: "/app/index.html" },
};

/** Three redirects, 100/200/300, matching /a /b /c in that order. */
const REDIRECTS = [
  redirect("00100", "/a"),
  redirect("00200", "/b"),
  redirect("00300", "/c"),
];

const group = (page: Page, name: "Redirects" | "Rewrites"): Locator =>
  page
    .locator(".rule-group")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });

const rows = (page: Page, name: "Redirects" | "Rewrites" = "Redirects") =>
  group(page, name).locator(".rule-row");

const grip = (page: Page, index: number): Locator =>
  rows(page)
    .nth(index)
    .getByRole("button", { name: /^Reorder / });

/** What each row shows, as `priority path`, top to bottom. */
const onScreen = async (page: Page): Promise<string[]> => {
  const cards = await rows(page).all();
  return Promise.all(
    cards.map(async (card) => {
      const priority = (await card.locator(".rule-prio").innerText()).trim();
      const from = (await card.locator(".rule-from").innerText()).trim();
      return `${priority} ${from}`;
    }),
  );
};

const reorderCalls = (
  calls: { method: string; url: string; body: unknown }[],
): { type?: string; order?: string[] }[] =>
  calls
    .filter((call) => call.method === "POST" && call.url.endsWith("/reorder"))
    .map((call) => call.body as { type?: string; order?: string[] });

const openHost = async (page: Page): Promise<void> => {
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);
  await page.getByRole("link").filter({ hasText: "www.example.com" }).click();
  await expect(rows(page)).toHaveCount(3);
};

/**
 * Drags the handle of row `from` onto row `to`, aiming past that row's midpoint
 * so the drop lands on the far side of it — which is what a user does when they
 * mean "put this one there".
 */
const dragRow = async (page: Page, from: number, to: number): Promise<void> => {
  const handle = await grip(page, from).boundingBox();
  const target = await rows(page).nth(to).boundingBox();
  if (handle === null || target === null) throw new Error("no geometry");

  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  // In steps, and past the midpoint: one jump would still land in the right gap,
  // but it would not exercise the moves the insertion line is drawn from.
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + (from > to ? 4 : target.height - 4),
    { steps: 10 },
  );
  await page.mouse.up();
};

test("dragging a rule to the top sends the new order", async ({
  page,
  api,
}) => {
  api.setHosts([www]);
  api.setRules([...REDIRECTS, rewrite]);
  await openHost(page);

  await dragRow(page, 2, 0);

  await expect.poll(() => reorderCalls(api.calls).length).toBeGreaterThan(0);
  expect(reorderCalls(api.calls)[0]).toEqual({
    type: "erMatchRule",
    // Keys in the new order — the server reuses the priorities they carry.
    order: ["REDIRECT#00300", "REDIRECT#00100", "REDIRECT#00200"],
  });
});

test("the rules keep their priorities and swap which rule holds them", async ({
  page,
  api,
}) => {
  // The whole point of the feature: /c moves to the top and takes priority 100
  // with it. Nothing is renumbered.
  api.setHosts([www]);
  api.setRules([...REDIRECTS, rewrite]);
  await openHost(page);

  await dragRow(page, 2, 0);

  await expect
    .poll(() => onScreen(page))
    .toEqual(["100 /c", "200 /a", "300 /b"]);
});

test("a rule dragged down lands below the row it was dropped on", async ({
  page,
  api,
}) => {
  api.setHosts([www]);
  api.setRules([...REDIRECTS, rewrite]);
  await openHost(page);

  await dragRow(page, 0, 1);

  await expect
    .poll(() => onScreen(page))
    .toEqual(["100 /b", "200 /a", "300 /c"]);
});

test("the insertion line shows where the rule would land", async ({
  page,
  api,
}) => {
  api.setHosts([www]);
  api.setRules([...REDIRECTS, rewrite]);
  await openHost(page);

  const handle = await grip(page, 2).boundingBox();
  const first = await rows(page).nth(0).boundingBox();
  if (handle === null || first === null) throw new Error("no geometry");

  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2, first.y + 4, { steps: 6 });

  // Mid-drag: the row being dragged is marked, and the gap it would drop into
  // is the one above the first row.
  await expect(rows(page).nth(2)).toHaveClass(/is-dragging/);
  await expect(rows(page).nth(0)).toHaveClass(/is-drop-before/);

  await page.mouse.up();
});

test("escape abandons a drag without saving anything", async ({
  page,
  api,
}) => {
  api.setHosts([www]);
  api.setRules([...REDIRECTS, rewrite]);
  await openHost(page);

  const handle = await grip(page, 2).boundingBox();
  const first = await rows(page).nth(0).boundingBox();
  if (handle === null || first === null) throw new Error("no geometry");

  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2, first.y + 4, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();

  expect(reorderCalls(api.calls)).toEqual([]);
  expect(await onScreen(page)).toEqual(["100 /a", "200 /b", "300 /c"]);
});

test("dropping a rule where it started saves nothing", async ({
  page,
  api,
}) => {
  // A press-and-release on the handle is the common accident, and it must not
  // spend a write on an order that is already stored.
  api.setHosts([www]);
  api.setRules([...REDIRECTS, rewrite]);
  await openHost(page);

  await grip(page, 1).click();

  expect(reorderCalls(api.calls)).toEqual([]);
});

test("the arrow keys move the focused rule", async ({ page, api }) => {
  // The keyboard path is not a convenience: dragging is the one interaction
  // here that a keyboard cannot reach at all.
  api.setHosts([www]);
  api.setRules([...REDIRECTS, rewrite]);
  await openHost(page);

  await grip(page, 2).focus();
  await page.keyboard.press("ArrowUp");

  await expect
    .poll(() => onScreen(page))
    .toEqual(["100 /a", "200 /c", "300 /b"]);
  expect(reorderCalls(api.calls)[0]?.order).toEqual([
    "REDIRECT#00100",
    "REDIRECT#00300",
    "REDIRECT#00200",
  ]);
});

test("focus follows the rule an arrow key moved", async ({ page, api }) => {
  // Otherwise a second press moves whichever rule slid into the old position,
  // and holding the key walks the wrong rule down the list.
  api.setHosts([www]);
  api.setRules([...REDIRECTS, rewrite]);
  await openHost(page);

  await grip(page, 2).focus();
  await page.keyboard.press("ArrowUp");
  await expect
    .poll(() => onScreen(page))
    .toEqual(["100 /a", "200 /c", "300 /b"]);
  await page.keyboard.press("ArrowUp");

  await expect
    .poll(() => onScreen(page))
    .toEqual(["100 /c", "200 /a", "300 /b"]);
});

test("the arrow keys stop at the ends of the group", async ({ page, api }) => {
  api.setHosts([www]);
  api.setRules([...REDIRECTS, rewrite]);
  await openHost(page);

  await grip(page, 0).focus();
  await page.keyboard.press("ArrowUp");
  await grip(page, 2).focus();
  await page.keyboard.press("ArrowDown");

  expect(reorderCalls(api.calls)).toEqual([]);
});

test("a rule cannot be dragged into the other group", async ({ page, api }) => {
  // Redirects and rewrites are separate sequences at the edge, so an order that
  // mixed them would be a 400 — the drag must not be able to express it.
  api.setHosts([www]);
  api.setRules([...REDIRECTS, rewrite]);
  await openHost(page);

  const handle = await grip(page, 0).boundingBox();
  const target = await rows(page, "Rewrites").nth(0).boundingBox();
  if (handle === null || target === null) throw new Error("no geometry");

  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 10 },
  );
  await page.mouse.up();

  // It lands at the bottom of its own group instead — the furthest the gesture
  // can take it.
  expect(reorderCalls(api.calls)[0]?.order).toEqual([
    "REDIRECT#00200",
    "REDIRECT#00300",
    "REDIRECT#00100",
  ]);
});

test("a refused order snaps back and says why", async ({ page, api }) => {
  api.setHosts([www]);
  api.setRules([...REDIRECTS, rewrite]);
  api.reorderReply({
    status: 409,
    body: errorBody(
      "RULES_CHANGED",
      "This order names 3 rule(s) but the host now has 4 of that type",
    ),
  });
  await openHost(page);

  await dragRow(page, 2, 0);

  await expect(page.getByRole("alert")).toContainText(
    "Could not save the new order",
  );
  await expect(page.getByRole("alert")).toContainText("the host now has 4");
  // Back as they were: the rows moved before the request, and a refusal has to
  // undo that rather than leave the list claiming an order the table refused.
  await expect
    .poll(() => onScreen(page))
    .toEqual(["100 /a", "200 /b", "300 /c"]);
});

test("a viewer's handles are inert and say why", async ({ page, api }) => {
  api.signedInAs("viewer");
  api.setHosts([www]);
  api.setRules([...REDIRECTS, rewrite]);
  await openHost(page);

  await expect(grip(page, 0)).toBeDisabled();
  await expect(grip(page, 0)).toHaveAttribute("title", /read-only/i);
});

test("a lone rule has nothing to reorder", async ({ page, api }) => {
  api.setHosts([host("www.example.com", { redirects: 1 })]);
  api.setRules([REDIRECTS[0] as Rule]);
  await seedStorage(page, {
    distributions: [prod],
    current: prod.distributionId,
  });
  await gotoConsole(page);
  await page.getByRole("link").filter({ hasText: "www.example.com" }).click();

  // Still rendered: a row missing its handle would sit out of line with every
  // other row in the console.
  await expect(grip(page, 0)).toBeDisabled();
  await expect(grip(page, 0)).toHaveAttribute("title", /only rule/i);
});
