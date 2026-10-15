/**
 * A linked CloudFront distribution and the DynamoDB table holding its rules —
 * one entry of the API's target registry, which is the team's list.
 *
 * `targetId` is the load-bearing field: every rules route is
 * `/targets/{targetId}/hosts/{host}/rules`, and the id is server-assigned, so it
 * can only come from linking the distribution through the API. It is also the
 * entry's identity in the console.
 *
 * `distributionId` is the target's `name`: a target is one linked distribution,
 * and the API keeps names unique.
 *
 * Everything that reads or writes this goes through `distribution.ts`.
 *
 * Readonly because a linked distribution is only ever replaced, never edited in
 * place: it is React state, so a field written through an existing entry would
 * leave the reference unchanged and the console showing the old value.
 */
export interface Distribution {
  /** Server-assigned target id. The `targetId` in every rules route. */
  readonly targetId: string;
  /** CloudFront distribution ID or ARN — the target's name. */
  readonly distributionId: string;
  /** DynamoDB table holding this distribution's redirect/rewrite rules. */
  readonly tableName: string;
  /** Region the table lives in. */
  readonly region: string;
  /**
   * The role the API assumes to reach a table in another account. Not edited in
   * the console, but carried so a save sends it back instead of clearing it.
   */
  readonly roleArn?: string;
  /**
   * The Lambda@Edge function ARN, from the edge module's
   * `viewer_request_lambda_arn` output. Optional: the country check uses it to
   * ignore behaviors running another function.
   */
  readonly edgeFunctionArn?: string;
}

/** What the link form collects, before the API assigns a `targetId`. */
export type DistributionDraft = Omit<Distribution, "targetId" | "roleArn">;
