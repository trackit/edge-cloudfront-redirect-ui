import type { ApiRequest } from "../context.js";
import { ApiError } from "./errors.js";
import { assertPriority, buildSk } from "./rule-keys.js";
import type { RuleItem } from "./rules-repository.js";
import { assertRuleType, validateRule } from "./validate.js";

/**
 * Turns a rule request into the item that goes to DynamoDB.
 *
 * The client sends the rule's own fields plus `priority`, an integer; the server
 * owns both keys. `pk` is the host from the path and `sk` is `TYPE#priority`
 * zero-padded — which is why `priority` cannot simply be stored alongside the
 * rest: the shared schemas are `additionalProperties: false`, so the composed
 * item must carry the derived key and nothing else, or it would not validate as
 * the shape the Lambda@Edge reads.
 *
 * `pk` and `sk` may still be present — that is what a body fetched with GET and
 * PUT back unchanged looks like — but they are checked, never trusted. Both keys
 * are reported together so a client sees every disagreement at once.
 */
export const composeRule = (req: ApiRequest): RuleItem => {
  const body = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Request body must be a rule object",
    );
  }

  const { pk, sk, priority, ...rest } = body as Record<string, unknown>;
  const type = assertRuleType(rest["type"]);
  const derivedSk = buildSk(type, resolvePriority(priority));

  assertKeysAgree({
    pk,
    sk,
    host: req.params.host,
    // The path names the rule being addressed, and on an item route the derived
    // key may legitimately differ from it — that is a move. So a supplied `sk`
    // is checked against the rule the request addresses, not against where the
    // rule is going: the collection route has no path key, so there the derived
    // one is all there is to compare with.
    addressedSk: req.params.sk ?? derivedSk,
    fromPath: req.params.sk !== undefined,
  });

  const item = { ...rest, pk: req.params.host, sk: derivedSk } as RuleItem;
  validateRule(item);
  return item;
};

/**
 * Always required, on update as much as on create. PUT is a full replace — every
 * other omitted field is cleared — so letting an omitted `priority` mean "leave
 * it where it is" would make one field alone behave the opposite way. It is also
 * the only field that decides where the rule is stored, which is the last place
 * to be clever: a client that means "keep it at 100" says so.
 */
const resolvePriority = (priority: unknown): number => {
  if (priority === undefined) {
    throw new ApiError(400, "VALIDATION_ERROR", "Rule failed validation", [
      {
        path: "/priority",
        message: "is required — the server builds the sort key from it",
      },
    ]);
  }

  // Rejects a string, null or a fraction with the same message as an
  // out-of-range integer: all of them fail to name a storable priority.
  assertPriority(priority as number);
  return priority as number;
};

const assertKeysAgree = (input: {
  pk: unknown;
  sk: unknown;
  host: string;
  addressedSk: string;
  fromPath: boolean;
}): void => {
  const mismatched: { path: string; message: string }[] = [];

  if (input.pk !== undefined && input.pk !== input.host) {
    mismatched.push({
      path: "/pk",
      message: `must equal the host in the path ("${input.host}")`,
    });
  }

  if (input.sk !== undefined && input.sk !== input.addressedSk) {
    // Naming the right authority matters here: on a move the derived key is
    // *meant* to differ from this one, so "the server derives it" would tell the
    // client to send back the very value it is changing. Omitting `sk` is always
    // valid, and is what a client re-prioritising a rule should do.
    mismatched.push({
      path: "/sk",
      message: input.fromPath
        ? `must equal the sort key in the path ("${input.addressedSk}") — it names the rule being replaced, not where "priority" moves it to. Omit it, or send the path's value.`
        : `must equal "${input.addressedSk}", the key the server derives from "type" and "priority". Omit it and the server fills it in.`,
    });
  }

  if (mismatched.length > 0) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Rule body does not match the path it was sent to",
      mismatched,
    );
  }
};
