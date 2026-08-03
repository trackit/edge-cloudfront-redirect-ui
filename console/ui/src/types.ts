/**
 * A connected CloudFront distribution and the DynamoDB table holding its rules.
 *
 * This is the console's own shape, not the API's. The rules API is organised
 * around a `Target { id, name, region, tableName, roleArn? }` whose `id` the
 * server assigns, and it has no notion of a distribution ID. Reconciling the two
 * is still open, so everything that reads or writes this type goes through
 * `distribution.ts` and nothing else touches storage directly.
 */
export interface Distribution {
  /** CloudFront distribution ID or ARN. */
  distributionId: string;
  /** DynamoDB table holding this distribution's redirect/rewrite rules. */
  tableName: string;
  /** Region the table lives in. */
  region: string;
}
