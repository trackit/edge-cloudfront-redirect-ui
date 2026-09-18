import { ApiError } from "./errors.js";
import { KIND_BY_TYPE, isRuleSk, parseSk, type RuleType } from "./rule-keys.js";
import { REORDER_LIMIT, type RuleItem } from "./rules-repository.js";
import { assertRuleType } from "./validate.js";

/**
 * Reordering a host's rules of one kind.
 *
 * A rule's priority *is* part of its key, so a reorder is a set of moves rather
 * than an edit. The one decision this module makes is which priorities the
 * reordered rules land on: the **existing ones**, handed out in ascending order
 * to the requested sequence. Rules swap numbers; no number is invented and none
 * is retired.
 *
 * That is what keeps a reorder cheap and predictable. The set of keys before and
 * after is identical, so nothing is ever created or deleted — every write is a
 * Put over a key some rule of that type already holds, which is why the whole
 * thing fits one transaction with no vacated keys to clean up. It also leaves
 * whatever numbering the author chose intact: a host laid out 100/200/300 still
 * reads 100/200/300 after a drag, and one laid out 10/50/900 keeps its own
 * spacing rather than being flattened into a ladder the console picked.
 */

interface Detail {
  path: string;
  message: string;
}

export interface ParsedReorder {
  type: RuleType;
  /** The rules of that type, by sort key, in the order they should end up in. */
  order: string[];
}

export interface ReorderPlan {
  /**
   * The rules whose key changes, each already carrying its new `sk`. Empty when
   * the requested order is the order they are already in — a drag that ended
   * where it started, which must cost no writes.
   */
  moves: RuleItem[];
  /** Every rule of the type, in the requested order, with the keys it will hold. */
  reordered: RuleItem[];
}

/**
 * The reorder body: `{ type, order }`, and nothing else.
 *
 * Extra fields are refused rather than ignored, for the same reason `parseToggle`
 * refuses them — a client that sent rule fields here would otherwise believe it
 * had edited the rules it had only moved.
 */
export const parseReorder = (body: unknown): ParsedReorder => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      'Request body must be { "type": "erMatchRule" | "frMatchRule", "order": [ sort keys ] }',
    );
  }

  const { type: rawType, order, ...rest } = body as Record<string, unknown>;

  // Before the field checks: `type` decides which keys are even admissible
  // below, and it fails with the same message here as on every other rule route.
  const type = assertRuleType(rawType);
  const kind = KIND_BY_TYPE[type];
  const details: Detail[] = [];

  for (const field of Object.keys(rest)) {
    details.push({
      path: `/${field}`,
      message:
        "is not part of a reorder — this route moves rules, it does not edit them",
    });
  }

  if (!Array.isArray(order)) {
    details.push({
      path: "/order",
      message:
        order === undefined
          ? "is required — it lists the rules by sort key, in their new order"
          : "must be an array of sort keys",
    });
  } else if (order.length === 0) {
    // An empty order would otherwise be a successful no-op that says nothing
    // about the host, while every caller sending one has a bug.
    details.push({ path: "/order", message: "must name at least one rule" });
  } else {
    const seen = new Set<string>();

    order.forEach((sk, index) => {
      const path = `/order/${index}`;

      if (typeof sk !== "string" || !isRuleSk(sk)) {
        details.push({
          path,
          message: 'must be a sort key, e.g. "REDIRECT#00100"',
        });
        return;
      }

      // A key of the other kind names a real rule, just not one this reorder is
      // allowed to touch: redirects and rewrites are independent sequences, and
      // mixing them would renumber rules the caller never listed.
      if (parseSk(sk).kind !== kind) {
        details.push({
          path,
          message: `must be a ${kind} key — "type" is "${type}"`,
        });
        return;
      }

      if (seen.has(sk)) {
        details.push({ path, message: `names "${sk}" twice` });
        return;
      }

      seen.add(sk);
    });
  }

  if (details.length > 0) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Rule order failed validation",
      details,
    );
  }

  return { type, order: order as string[] };
};

/**
 * Works out which rules move, given what the table holds and the order asked
 * for. `stored` is the host's rules *of the reordered type* — the caller filters,
 * since only it knows the type it parsed.
 *
 * Throws 409 unless `order` names exactly those rules. The console sends back a
 * list it has just read, so a mismatch means the host changed underneath it —
 * another tab (or another person) created or deleted a rule — and guessing at
 * the intent would renumber rules nobody dragged.
 */
export const planReorder = (
  stored: RuleItem[],
  order: string[],
): ReorderPlan => {
  const byKey = new Map(stored.map((rule) => [rule.sk, rule]));

  const requested: RuleItem[] = [];
  for (const sk of order) {
    const rule = byKey.get(sk);
    if (rule) requested.push(rule);
  }

  // Both directions: a key that is not there, and a stored rule the order does
  // not mention. `order` holds no duplicates by here, so equal lengths plus
  // every key found is the same set.
  if (requested.length !== order.length || order.length !== stored.length) {
    throw new ApiError(
      409,
      "RULES_CHANGED",
      `This order names ${order.length} rule(s) but the host now has ${stored.length} of that type, or names one it does not have — reload the rules and reorder them again`,
    );
  }

  /*
    The priorities to hand out, ascending. Sorted here rather than trusted from
    the caller: `listByHost` returns ascending `sk` as a property of DynamoDB's
    Query, not as a promise this function should rest on, and the in-memory fake
    returns them unsorted on purpose. Lexicographic sorting is numeric order
    because the priority is zero-padded — the reason it is padded at all.
  */
  const keys = stored.map((rule) => rule.sk).sort();

  const moves: RuleItem[] = [];
  const reordered = requested.map((rule, index) => {
    const sk = keys[index];
    if (sk === rule.sk) return rule;

    const moved = { ...rule, sk };
    moves.push(moved);
    return moved;
  });

  if (moves.length > REORDER_LIMIT) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      `This order moves ${moves.length} rules, and a reorder is applied as one transaction of at most ${REORDER_LIMIT} — move them in smaller steps`,
    );
  }

  return { moves, reordered };
};
