/**
 * A connected CloudFront distribution and the DynamoDB table holding its rules.
 *
 * `targetId` is the load-bearing field: every rules route is
 * `/targets/{targetId}/hosts/{host}/rules`, and the id is server-assigned, so it
 * can only come from registering the table with the API.
 *
 * `distributionId` has no counterpart in the API — a `Target` is
 * `{ id, name, region, tableName, roleArn? }` — so it stays client-side, and
 * doubles as the target's `name` when registering. Reconciling the two models
 * properly is still open.
 *
 * Everything that reads or writes this goes through `distribution.ts`.
 *
 * Readonly because a connected distribution is only ever replaced, never edited
 * in place: it is React state, so a field written through an existing entry
 * would leave the reference unchanged and the console showing the old value.
 * Editing settings produces a new entry — see `reduceReplaceCurrent`.
 */
export interface Distribution {
  /** Server-assigned target id. The `targetId` in every rules route. */
  readonly targetId: string;
  /** CloudFront distribution ID or ARN. Client-side only. */
  readonly distributionId: string;
  /** DynamoDB table holding this distribution's redirect/rewrite rules. */
  readonly tableName: string;
  /** Region the table lives in. */
  readonly region: string;
}

/** What the connect form collects, before the API assigns a `targetId`. */
export type DistributionDraft = Omit<Distribution, "targetId">;
