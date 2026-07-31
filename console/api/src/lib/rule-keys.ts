import { ApiError } from "./errors.js";

/** Rule discriminator, as stored in the item and defined by the shared schemas. */
export type RuleType = "erMatchRule" | "frMatchRule";

/** Sort-key prefix. The edge queries `begins_with(sk, "REDIRECT#" | "REWRITE#")`. */
export type RuleKind = "REDIRECT" | "REWRITE";

export const KIND_BY_TYPE: Record<RuleType, RuleKind> = {
  erMatchRule: "REDIRECT",
  frMatchRule: "REWRITE",
};

/**
 * Priority is zero-padded to a fixed width so DynamoDB's lexicographic order on
 * `sk` *is* numeric order: "00100" sorts before "00900", where an unpadded "100"
 * would sort after "9". Five digits is what the shared schemas' `sk` patterns
 * pin down, so the width cannot change without changing them and rewriting every
 * stored item.
 */
const PRIORITY_DIGITS = 5;

export const padPriority = (priority: number): string =>
  String(priority).padStart(PRIORITY_DIGITS, "0");

export const buildSk = (type: RuleType, priority: number): string =>
  `${KIND_BY_TYPE[type]}#${padPriority(priority)}`;

export interface ParsedSk {
  kind: RuleKind;
  priority: number;
}

const SK_PATTERN = /^(REDIRECT|REWRITE)#(\d{5})$/;

/**
 * Parses a sort key taken from the request path. A malformed one is a 400 rather
 * than a DynamoDB round-trip that can only miss — `sk` is half the primary key,
 * so anything off this shape addresses an item the API could never have written.
 * `BAD_REQUEST` rather than `VALIDATION_ERROR`: the fault is in the URL, not in
 * a body field the `details` array could point at.
 */
export const parseSk = (sk: string): ParsedSk => {
  const match = SK_PATTERN.exec(sk);
  if (!match) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      `Rule id "${sk}" must be TYPE#priority, priority zero-padded to ${PRIORITY_DIGITS} digits — e.g. "REDIRECT#00100"`,
    );
  }

  return { kind: match[1] as RuleKind, priority: Number(match[2]) };
};
