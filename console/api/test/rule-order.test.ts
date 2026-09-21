import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/errors.js";
import { parseReorder, planReorder } from "../src/lib/rule-order.js";
import { REORDER_LIMIT, type RuleItem } from "../src/lib/rules-repository.js";

/**
 * Parsing a reorder body and working out which rules move. Both pure, and the
 * priority arithmetic is all here — the handler test proves it is wired up, and
 * dynamo-rules-repository.test.ts proves the writes are one transaction.
 */

const HOST = "www.example.com";

const redirect = (
  priority: string,
  extra: Partial<RuleItem> = {},
): RuleItem => ({
  pk: HOST,
  sk: `REDIRECT#${priority}`,
  type: "erMatchRule",
  statusCode: 301,
  redirectURL: `https://www.example.com/${priority}`,
  matches: [{ matchType: "path", matchOperator: "equals", matchValue: "/old" }],
  ...extra,
});

const skOf = (rules: RuleItem[]): string[] => rules.map((rule) => rule.sk);

/** The thrown `ApiError`, so a case can assert status, code and details. */
const refusal = (run: () => unknown): ApiError => {
  try {
    run();
  } catch (caught) {
    if (caught instanceof ApiError) return caught;
    throw caught;
  }

  throw new Error("expected a refusal, got none");
};

const paths = (error: ApiError): string[] =>
  (error.details as { path: string }[]).map((detail) => detail.path);

describe("parseReorder", () => {
  const body = {
    type: "erMatchRule",
    order: ["REDIRECT#00200", "REDIRECT#00100"],
  };

  it("reads a type and the keys in their new order", () => {
    expect(parseReorder(body)).toEqual({
      type: "erMatchRule",
      order: ["REDIRECT#00200", "REDIRECT#00100"],
    });
  });

  it.each([
    ["a string", '"REDIRECT#00100"'],
    ["null", null],
    ["an array", [["REDIRECT#00100"]]],
  ])("refuses %s as the body", (_case, sent) => {
    expect(refusal(() => parseReorder(sent)).status).toBe(400);
  });

  it("refuses a body with no usable type", () => {
    // The same message as every other rule route: one bad `type` must not be
    // described two ways depending on where it was sent.
    expect(
      refusal(() => parseReorder({ order: body.order })).message,
    ).toContain('"erMatchRule"');
  });

  it.each([
    ["missing", undefined],
    ["not an array", "REDIRECT#00100"],
    ["empty", []],
  ])("refuses an order that is %s", (_case, order) => {
    const error = refusal(() => parseReorder({ type: body.type, order }));

    expect(error.status).toBe(400);
    expect(paths(error)).toEqual(["/order"]);
  });

  it("points at the entry that is not a sort key", () => {
    const error = refusal(() =>
      parseReorder({ type: body.type, order: ["REDIRECT#00100", "100", 7] }),
    );

    expect(paths(error)).toEqual(["/order/1", "/order/2"]);
  });

  it("refuses a key of the other kind", () => {
    // Redirects and rewrites are independent sequences, so a rewrite key here
    // names a rule this reorder was never given the priorities of.
    const error = refusal(() =>
      parseReorder({
        type: "erMatchRule",
        order: ["REDIRECT#00100", "REWRITE#00100"],
      }),
    );

    expect(paths(error)).toEqual(["/order/1"]);
    expect((error.details as { message: string }[])[0]?.message).toContain(
      "REDIRECT",
    );
  });

  it("refuses a key named twice", () => {
    // Otherwise one rule would claim two priorities and another none, and the
    // set check in `planReorder` would call it a concurrent change.
    const error = refusal(() =>
      parseReorder({
        type: body.type,
        order: ["REDIRECT#00100", "REDIRECT#00100"],
      }),
    );

    expect(paths(error)).toEqual(["/order/1"]);
  });

  it("refuses rule fields sent alongside", () => {
    // A reorder moves rules; silently ignoring these would let a client believe
    // it had edited the rules it had only dragged.
    const error = refusal(() =>
      parseReorder({ ...body, statusCode: 302, disabled: true }),
    );

    expect(paths(error)).toEqual(["/statusCode", "/disabled"]);
  });
});

describe("planReorder", () => {
  const first = redirect("00100");
  const second = redirect("00200");
  const third = redirect("00300");
  const stored = [first, second, third];

  it("moves nothing when the order is the one already stored", () => {
    // A drag that ended where it started must cost no writes.
    const plan = planReorder(stored, skOf(stored));

    expect(plan.moves).toEqual([]);
    expect(plan.reordered).toEqual(stored);
  });

  it("keeps the priorities and swaps which rule holds them", () => {
    // The point of the whole module: 100/200/300 is still 100/200/300
    // afterwards, so a host's numbering survives a reorder.
    const plan = planReorder(stored, [
      "REDIRECT#00200",
      "REDIRECT#00100",
      "REDIRECT#00300",
    ]);

    expect(skOf(plan.reordered)).toEqual([
      "REDIRECT#00100",
      "REDIRECT#00200",
      "REDIRECT#00300",
    ]);
    expect(plan.reordered[0]?.redirectURL).toBe(second.redirectURL);
    expect(plan.reordered[1]?.redirectURL).toBe(first.redirectURL);
  });

  it("writes only the rules whose key changes", () => {
    const plan = planReorder(stored, [
      "REDIRECT#00200",
      "REDIRECT#00100",
      "REDIRECT#00300",
    ]);

    expect(skOf(plan.moves)).toEqual(["REDIRECT#00100", "REDIRECT#00200"]);
  });

  it("keeps uneven spacing rather than flattening it into a ladder", () => {
    // A host laid out by hand keeps its own numbers — the console never
    // renumbers a rule the user did not drag.
    const plan = planReorder(
      [redirect("00010"), redirect("00050"), redirect("00900")],
      ["REDIRECT#00900", "REDIRECT#00050", "REDIRECT#00010"],
    );

    expect(skOf(plan.reordered)).toEqual([
      "REDIRECT#00010",
      "REDIRECT#00050",
      "REDIRECT#00900",
    ]);
  });

  it("carries every other field across with the moved rule", () => {
    // The move is a full Put, so a field dropped here is a field cleared in the
    // table — `disabled` above all, which would put a retired rule back into
    // service at the edge.
    const disabled = redirect("00200", { disabled: true });
    const plan = planReorder(
      [first, disabled],
      ["REDIRECT#00200", "REDIRECT#00100"],
    );

    expect(plan.moves[0]).toEqual({ ...disabled, sk: "REDIRECT#00100" });
  });

  it("sorts the stored rules itself", () => {
    // `listByHost` returns ascending keys as a property of DynamoDB's Query, not
    // as a promise this function rests on — and the in-memory fake returns them
    // unsorted on purpose.
    const plan = planReorder(
      [third, first, second],
      ["REDIRECT#00300", "REDIRECT#00200", "REDIRECT#00100"],
    );

    expect(skOf(plan.reordered)).toEqual([
      "REDIRECT#00100",
      "REDIRECT#00200",
      "REDIRECT#00300",
    ]);
    expect(plan.reordered[0]?.redirectURL).toBe(third.redirectURL);
  });

  it("refuses an order that leaves a stored rule out", () => {
    // The omitted rule's priority would be handed to someone else while it kept
    // its own, and the two would collide.
    const error = refusal(() =>
      planReorder(stored, ["REDIRECT#00200", "REDIRECT#00100"]),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe("RULES_CHANGED");
  });

  it("refuses an order naming a rule the host does not have", () => {
    const error = refusal(() =>
      planReorder(stored, [
        "REDIRECT#00200",
        "REDIRECT#00100",
        "REDIRECT#00999",
      ]),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe("RULES_CHANGED");
  });

  it("refuses more moves than one transaction can carry", () => {
    // Reversing a long list moves every rule in it, and a reorder that cannot
    // commit as one transaction must be refused rather than half applied.
    const many = Array.from({ length: REORDER_LIMIT + 2 }, (_, index) =>
      redirect(String(index + 1).padStart(5, "0")),
    );

    const error = refusal(() => planReorder(many, skOf(many).reverse()));

    expect(error.status).toBe(400);
    expect(error.message).toContain(String(REORDER_LIMIT));
  });

  it("allows exactly as many moves as one transaction can carry", () => {
    const many = Array.from({ length: REORDER_LIMIT }, (_, index) =>
      redirect(String(index + 1).padStart(5, "0")),
    );

    expect(planReorder(many, skOf(many).reverse()).moves).toHaveLength(
      REORDER_LIMIT,
    );
  });
});
