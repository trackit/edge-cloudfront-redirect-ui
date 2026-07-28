/**
 * Known AWS regions, for validating a target's `region`. Static list — update
 * when AWS adds a region. We check existence, not just format, so a typo like
 * "us-east-11" is rejected at create time instead of surfacing later when a
 * rule operation tries to reach the (nonexistent) region.
 */
export const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "af-south-1",
  "ap-east-1",
  "ap-south-1",
  "ap-south-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ca-central-1",
  "ca-west-1",
  "eu-central-1",
  "eu-central-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-south-1",
  "eu-south-2",
  "eu-north-1",
  "il-central-1",
  "me-south-1",
  "me-central-1",
  "sa-east-1",
] as const;

export type AwsRegion = (typeof AWS_REGIONS)[number];

const REGION_SET: ReadonlySet<string> = new Set(AWS_REGIONS);

export const isValidRegion = (region: string): boolean =>
  REGION_SET.has(region);
