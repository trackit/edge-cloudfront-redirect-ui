import type { components } from "./schema.gen";

/**
 * Readable aliases over the generated schema. Everything here resolves to a type
 * derived from `console/api/openapi.yaml`, which in turn `$ref`s the shared rule
 * schemas — so a rule shape only ever changes in `shared/`, and `npm run
 * generate:api` carries it here.
 */
type Schemas = components["schemas"];

/** A registered target. `id` is server-generated and is the `targetId` in rule routes. */
export type Target = Schemas["Target"];

/** Body for creating a target. The server assigns `id`. */
export type TargetInput = Schemas["TargetInput"];

/** Body for replacing a target. May carry `id`, which must match the path. */
export type TargetUpdate = Schemas["TargetUpdate"];

/**
 * A host in a target's table, with how many rules of each kind it holds. Counts
 * include disabled rules — they are of rules that exist, not rules that are live.
 */
export type HostSummary = Schemas["HostSummary"];

/** Body for creating a host that has no rules yet. */
export type HostInput = Schemas["HostInput"];

/** A stored rule item, exactly as the Lambda@Edge reads it. */
export type Rule = Schemas["Rule"];
export type RedirectRule = Schemas["redirect-rule.schema"];
export type RewriteRule = Schemas["rewrite-rule.schema"];

/**
 * A rule as a client sends it: the rule's own fields plus `priority`. The server
 * owns both keys — it derives `sk` from `type` and `priority`, and takes `pk`
 * from the path. Do not build `sk` here; a value that disagrees with the path is
 * a 400.
 */
export type RuleInput = Schemas["RuleInput"];
export type RedirectRuleInput = Schemas["RedirectRuleInput"];
export type RewriteRuleInput = Schemas["RewriteRuleInput"];

/** A single match condition, shared by both rule kinds. */
export type MatchCondition = Schemas["match"];

/** One entry of an error's `details`, locating a bad field. */
export type ValidationDetail = Schemas["ValidationDetail"];

/** The API's closed set of machine-readable error codes. */
export type ApiErrorCode = Schemas["Error"]["error"]["code"];

/** Narrows a rule to a redirect. */
export const isRedirect = (rule: Rule): rule is RedirectRule =>
  rule.type === "erMatchRule";

/** Narrows a rule to a rewrite. */
export const isRewrite = (rule: Rule): rule is RewriteRule =>
  rule.type === "frMatchRule";

/** The numeric priority encoded in a sort key — `REDIRECT#00100` → `100`. */
export const priorityOf = (sk: string): number =>
  Number.parseInt(sk.split("#")[1] ?? "", 10);
