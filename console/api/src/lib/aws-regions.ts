/**
 * Commercial-partition AWS regions, for validating a target's `region`. We check
 * existence rather than just format, so a typo like "us-east-11" is rejected at
 * create time instead of surfacing later as an opaque failure.
 *
 * A static list fails in both directions, so it is only the default:
 *   - It goes stale as AWS launches regions, and a stale list rejects a table
 *     the user legitimately owns.
 *   - Opt-in regions (see OPT_IN_REGIONS) are accepted even when the account has
 *     not enabled them, in which case credentials are not valid there.
 *
 * `ALLOWED_REGIONS` overrides it — a comma-separated list. Set it to the regions
 * this deployment can actually reach and both failure modes go away without a
 * code change. See getAllowedRegions.
 */
export const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "af-south-1",
  "ap-east-1",
  "ap-east-2",
  "ap-south-1",
  "ap-south-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-7",
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
  "mx-central-1",
  "sa-east-1",
] as const;

export type AwsRegion = (typeof AWS_REGIONS)[number];

/**
 * Regions that require the account to opt in. Accepting one of these only means
 * it exists — not that this deployment's credentials work there. Constrain
 * `ALLOWED_REGIONS` if that distinction matters.
 */
export const OPT_IN_REGIONS: ReadonlySet<string> = new Set([
  "af-south-1",
  "ap-east-1",
  "ap-east-2",
  "ap-south-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-7",
  "ca-west-1",
  "eu-central-2",
  "eu-south-1",
  "eu-south-2",
  "il-central-1",
  "me-south-1",
  "me-central-1",
  "mx-central-1",
]);

const DEFAULT_REGIONS: ReadonlySet<string> = new Set(AWS_REGIONS);

/**
 * The regions a target may name. `ALLOWED_REGIONS` (comma-separated) replaces
 * the built-in list entirely; blank entries are ignored, and a value that is set
 * but yields nothing falls back to the default rather than rejecting everything.
 */
export const getAllowedRegions = (
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> => {
  const raw = env["ALLOWED_REGIONS"];
  if (!raw) return DEFAULT_REGIONS;

  const configured = raw
    .split(",")
    .map((region) => region.trim())
    .filter((region) => region.length > 0);

  return configured.length > 0 ? new Set(configured) : DEFAULT_REGIONS;
};

export const isValidRegion = (
  region: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean => getAllowedRegions(env).has(region);
