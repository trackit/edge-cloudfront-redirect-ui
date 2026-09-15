import type { components } from "./schema.gen";

/**
 * Readable aliases over the generated schema. Everything here derives from
 * `console/api/openapi.yaml`, which `$ref`s the shared rule schemas — so a rule
 * shape only ever changes in `shared/`, and `npm run generate:api` carries it here.
 */
type Schemas = components["schemas"];

/**
 * What the deployment the console is talking to will accept — currently the
 * regions a target may name. Worth reading rather than hardcoding: the set is
 * whatever `ALLOWED_REGIONS` says, which the front end cannot know (CF-34).
 */
export type Meta = Schemas["Meta"];

/** A registered target. `id` is server-generated and is the `targetId` in rule routes. */
export type Target = Schemas["Target"];

/** Body for creating a target. The server assigns `id`. */
export type TargetInput = Schemas["TargetInput"];

/** Body for replacing a target. May carry `id`, which must match the path. */
export type TargetUpdate = Schemas["TargetUpdate"];

/** A host and its rule counts, which include disabled rules. */
export type HostSummary = Schemas["HostSummary"];

/** Body for creating a host that has no rules yet. */
export type HostInput = Schemas["HostInput"];

/** A stored rule item, exactly as the Lambda@Edge reads it. */
export type Rule = Schemas["Rule"];
export type RedirectRule = Schemas["redirect-rule.schema"];
export type RewriteRule = Schemas["rewrite-rule.schema"];

/**
 * A rule as a client sends it: the rule's own fields plus `priority`. The server
 * owns both keys — `sk` derived from `type` and `priority`, `pk` from the path —
 * so do not build `sk` here; one that disagrees with the path is a 400.
 */
export type RuleInput = Schemas["RuleInput"];
export type RedirectRuleInput = Schemas["RedirectRuleInput"];
export type RewriteRuleInput = Schemas["RewriteRuleInput"];

/**
 * Body for reordering one kind of a host's rules: the type, and that type's
 * sort keys in their new order. No priorities — the server reuses the ones
 * those keys already carry.
 */
export type RuleReorder = Schemas["RuleReorder"];

/** A single match condition, shared by both rule kinds. */
export type MatchCondition = Schemas["match"];

/** A rewrite's S3 origin, exactly as the edge assigns it to `request.origin`. */
export type S3Origin = Schemas["s3Origin"];

/** A rewrite's custom (HTTP) origin, same. */
export type CustomOrigin = Schemas["customOrigin"];

/**
 * A rewrite's `forwardSettings`, restated because the generated type is not
 * usable: openapi-typescript renders the shared schema's
 * `anyOf: [{ required: [origin] }, { required: [pathAndQS] }]` as
 * `{ … } | unknown | unknown`, which collapses to `unknown`.
 *
 * Only the three-key wrapper is spelled out; the origins still `$ref` the
 * generated types. The "at least one of" constraint is left to the API, which
 * validates it.
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
 * The one assertion bridging that `unknown` to `ForwardSettings`. Safe because
 * the API validates every item against the shared schema before writing it, and
 * isolated here so the cast stays reviewable.
 */
export const narrowForwardSettings = (rule: RewriteRule): ForwardSettings =>
  rule.forwardSettings as ForwardSettings;

/**
 * A signed-in session. No refresh token: it is set as an HttpOnly cookie so that
 * script cannot read it, and repeating it here would undo that.
 */
export type Session = Schemas["Session"];

/** One entry of an error's `details`, locating a bad field. */
export type ValidationDetail = Schemas["ValidationDetail"];

/** The API's closed set of machine-readable error codes. */
export type ApiErrorCode = Schemas["Error"]["error"]["code"];

export const isRedirect = (rule: Rule): rule is RedirectRule =>
  rule.type === "erMatchRule";

export const isRewrite = (rule: Rule): rule is RewriteRule =>
  rule.type === "frMatchRule";

/** The numeric priority encoded in a sort key — `REDIRECT#00100` → `100`. */
export const priorityOf = (sk: string): number =>
  Number.parseInt(sk.split("#")[1] ?? "", 10);

/**
 * The inverse — `("redirect", 100)` → `REDIRECT#00100`. Only ever shown to the
 * user: seeing the key is what makes it obvious that changing a priority moves
 * the rule rather than editing it in place.
 */
export const sortKeyFor = (kind: "redirect" | "rewrite", priority: number) =>
  `${kind === "redirect" ? "REDIRECT" : "REWRITE"}#${String(priority).padStart(5, "0")}`;
