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

/** A rewrite's S3 origin, exactly as the edge assigns it to `request.origin`. */
export type S3Origin = Schemas["s3Origin"];

/** A rewrite's custom (HTTP) origin, same. */
export type CustomOrigin = Schemas["customOrigin"];

/**
 * A rewrite's `forwardSettings`.
 *
 * Restated here because the generated type is not usable: the shared schema says
 * `anyOf: [{ required: [origin] }, { required: [pathAndQS] }]`, and
 * openapi-typescript renders that as `{ … } | unknown | unknown`, which collapses
 * to plain `unknown`. Reading `rule.forwardSettings.origin` does not compile.
 *
 * The nested origins still `$ref` the generated `s3Origin` / `customOrigin`, so
 * the only thing spelled out is the three-key wrapper — and `narrowForwardSettings`
 * below is the single place that asserts it. The "at least one of" constraint the
 * `anyOf` expresses is not represented; the API validates it, which is where it
 * belongs.
 */
export interface ForwardSettings {
  origin?: {
    s3?: S3Origin;
    custom?: CustomOrigin;
  };
  pathAndQS?: string;
  useIncomingQueryString?: boolean;
}

/**
 * The one assertion that bridges the generated `unknown` to `ForwardSettings`.
 *
 * Safe because the API validates every stored item against the shared schema
 * before writing it, so a rewrite read back cannot carry another shape. Isolated
 * in one function so the cast is reviewable rather than sprinkled across the
 * components that need to read an origin.
 */
export const narrowForwardSettings = (rule: RewriteRule): ForwardSettings =>
  rule.forwardSettings as ForwardSettings;

/**
 * A signed-in session, as `/auth/session` and `/auth/refresh` return it.
 *
 * There is no refresh token here on purpose — it is set as an HttpOnly cookie so
 * that script cannot read it, and repeating it in the body would undo that.
 */
export type Session = Schemas["Session"];

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

/**
 * The inverse — `("redirect", 100)` → `REDIRECT#00100`.
 *
 * The server derives the key on write and the client never sends one, so this
 * exists only to show the user where a priority will land. Duplicating the
 * five-digit padding is the point: seeing the key is what makes it obvious that
 * changing a priority moves the rule rather than editing it in place.
 */
export const sortKeyFor = (kind: "redirect" | "rewrite", priority: number) =>
  `${kind === "redirect" ? "REDIRECT" : "REWRITE"}#${String(priority).padStart(5, "0")}`;
