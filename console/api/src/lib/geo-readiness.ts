import {
  CloudFrontClient,
  GetCachePolicyCommand,
  GetDistributionConfigCommand,
  GetOriginRequestPolicyCommand,
  type CachePolicyConfig,
  type DistributionConfig,
  type OriginRequestPolicyConfig,
} from "@aws-sdk/client-cloudfront";
import { assumeRole } from "./dynamo.js";
import { errorName } from "./dynamo-errors.js";

/**
 * Whether a distribution can serve country conditions reliably.
 *
 * The edge evaluates a country condition at origin-request, so it only ever
 * sees cache misses. That is fine when the behavior does not cache, or caches
 * per country. It is not when the behavior caches without the country in its
 * cache key: a page fetched for one viewer is served to the next one from
 * anywhere else, and the function never runs for them. A geo redirect then
 * silently misses most viewers, and a geo rewrite serves one country's page to
 * everyone. Nothing at the edge can log that, because the requests it misses
 * never reach it — so the console reads the distribution's configuration and
 * says so where the rule is written.
 */

export const COUNTRY_HEADER = "cloudfront-viewer-country";

/**
 * - `ok`: the country reaches the function, and a cached copy is per country
 *   (or nothing is cached).
 * - `cachedWithoutCountry`: the behavior caches, and the country is not in its
 *   cache key. The silent case.
 * - `countryNotForwarded`: no policy asks CloudFront for the country, so every
 *   country rule on this behavior is skipped (the edge logs that one).
 * - `noOriginRequest`: the function runs at viewer-request only, and country
 *   conditions are evaluated at origin-request.
 */
export type BehaviorVerdict =
  "ok" | "cachedWithoutCountry" | "countryNotForwarded" | "noOriginRequest";

export interface BehaviorReadiness {
  /** `*` for the default behavior, as CloudFront shows it. */
  pathPattern: string;
  verdict: BehaviorVerdict;
}

export type GeoReadiness =
  | {
      status: "ok" | "misconfigured";
      distributionId: string;
      behaviors: BehaviorReadiness[];
    }
  | { status: "unknown"; reason: string };

/** What the evaluator needs of a cache policy, so tests do not build SDK shapes. */
export interface CachePolicyFacts {
  caches: boolean;
  keyHeaders: string[];
}

/** What the evaluator needs of an origin request policy. */
export interface OriginRequestFacts {
  forwardedHeaders: string[];
}

export const cachePolicyFacts = (
  config: CachePolicyConfig,
): CachePolicyFacts => {
  const headers =
    config.ParametersInCacheKeyAndForwardedToOrigin?.HeadersConfig;
  return {
    // Managed-CachingDisabled is 0/0/0. A policy with MaxTTL 0 cannot keep a
    // copy whatever the origin says.
    caches: (config.MaxTTL ?? 0) > 0,
    keyHeaders:
      headers?.HeaderBehavior === "whitelist"
        ? (headers.Headers?.Items ?? [])
        : [],
  };
};

export const originRequestFacts = (
  config: OriginRequestPolicyConfig,
): OriginRequestFacts => {
  const headers = config.HeadersConfig;
  // `allViewer` and `allExcept` forward the viewer's own headers, which the
  // CloudFront-* ones are not: only a whitelist can name them.
  const names =
    headers?.HeaderBehavior === "whitelist" ||
    headers?.HeaderBehavior === "allViewerAndWhitelistCloudFront"
      ? (headers.Headers?.Items ?? [])
      : [];
  return { forwardedHeaders: names };
};

const hasCountry = (names: string[]): boolean =>
  names.some((name) => name.toLowerCase() === COUNTRY_HEADER);

type Behavior = NonNullable<DistributionConfig["DefaultCacheBehavior"]>;

/** Every behavior, the default one included, with the pattern it serves. */
const behaviorsOf = (
  config: DistributionConfig,
): { pathPattern: string; behavior: Behavior }[] => [
  ...(config.DefaultCacheBehavior
    ? [{ pathPattern: "*", behavior: config.DefaultCacheBehavior }]
    : []),
  ...(config.CacheBehaviors?.Items ?? []).map((behavior) => ({
    pathPattern: behavior.PathPattern ?? "?",
    behavior: behavior as Behavior,
  })),
];

const eventTypes = (behavior: Behavior): string[] =>
  (behavior.LambdaFunctionAssociations?.Items ?? []).map(
    (association) => association.EventType ?? "",
  );

/**
 * The verdict for each behavior that runs a Lambda@Edge function, from facts
 * already fetched. Behaviors without one are left out: no rule runs there.
 *
 * A behavior with no cache policy uses the legacy cache settings, where the
 * forwarded headers are the cache key and `MaxTTL` sits on the behavior.
 */
export const evaluateDistribution = (
  distributionId: string,
  config: DistributionConfig,
  cachePolicies: Map<string, CachePolicyFacts>,
  originRequestPolicies: Map<string, OriginRequestFacts>,
): GeoReadiness => {
  const behaviors: BehaviorReadiness[] = [];

  for (const { pathPattern, behavior } of behaviorsOf(config)) {
    const events = eventTypes(behavior);
    if (events.length === 0) continue;

    if (!events.includes("origin-request")) {
      behaviors.push({ pathPattern, verdict: "noOriginRequest" });
      continue;
    }

    const cache = behavior.CachePolicyId
      ? cachePolicies.get(behavior.CachePolicyId)
      : legacyCacheFacts(behavior);
    const forwarded = behavior.OriginRequestPolicyId
      ? (originRequestPolicies.get(behavior.OriginRequestPolicyId)
          ?.forwardedHeaders ?? [])
      : [];

    const inKey = hasCountry(cache?.keyHeaders ?? []);
    const verdict: BehaviorVerdict =
      !inKey && !hasCountry(forwarded)
        ? "countryNotForwarded"
        : (cache?.caches ?? true) && !inKey
          ? "cachedWithoutCountry"
          : "ok";
    behaviors.push({ pathPattern, verdict });
  }

  if (behaviors.length === 0) {
    return {
      status: "unknown",
      reason: `No behavior of distribution ${distributionId} runs a Lambda@Edge function`,
    };
  }

  return {
    status: behaviors.every((b) => b.verdict === "ok") ? "ok" : "misconfigured",
    distributionId,
    behaviors,
  };
};

const legacyCacheFacts = (behavior: Behavior): CachePolicyFacts => {
  const headers = behavior.ForwardedValues?.Headers?.Items ?? [];
  return {
    // Forwarding every header makes the whole request the key, which is per
    // country too.
    caches: (behavior.MaxTTL ?? 0) > 0 && !headers.includes("*"),
    keyHeaders: headers.includes("*") ? [COUNTRY_HEADER] : headers,
  };
};

/**
 * The distribution a target serves, from its `name`. The console registers a
 * target under the distribution ID it was connected with (an ID or an ARN), and
 * the API model has no other field for it — see ui/src/domain/types.ts.
 */
export const distributionIdOf = (name: string): string | null => {
  const trimmed = name.trim();
  const fromArn =
    /^arn:aws[a-z-]*:cloudfront::\d{12}:distribution\/(E[A-Z0-9]+)$/.exec(
      trimmed,
    );
  if (fromArn) return fromArn[1] ?? null;
  return /^E[A-Z0-9]{7,}$/.test(trimmed) ? trimmed : null;
};

export interface ReadinessTarget {
  name: string;
  roleArn?: string;
}

export type GeoReadinessChecker = (
  target: ReadinessTarget,
) => Promise<GeoReadiness>;

const clients = new Map<string, CloudFrontClient>();

/** CloudFront's control plane is global and answers in us-east-1. */
const cloudFront = (roleArn?: string): CloudFrontClient => {
  const key = roleArn ?? "";
  let client = clients.get(key);
  if (!client) {
    client = new CloudFrontClient({
      region: "us-east-1",
      ...(roleArn ? { credentials: assumeRole(roleArn, "us-east-1") } : {}),
    });
    clients.set(key, client);
  }
  return client;
};

/** How long an answer is reused. A fixed config is read once a minute at most. */
const TTL_MS = 60_000;
const answers = new Map<string, { at: number; value: GeoReadiness }>();

/**
 * Reads the target's distribution and evaluates it. Never throws: a
 * distribution the API cannot read is `unknown` with the reason, because this
 * only decides what the console warns about — it must not stop anyone writing
 * a rule.
 */
export const checkGeoReadiness: GeoReadinessChecker = async (target) => {
  const distributionId = distributionIdOf(target.name);
  if (distributionId === null) {
    return {
      status: "unknown",
      reason: `The target "${target.name}" is not named after a CloudFront distribution ID, so its cache settings cannot be checked`,
    };
  }

  const key = `${target.roleArn ?? ""} ${distributionId}`;
  const cached = answers.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const value = await readAndEvaluate(distributionId, target.roleArn);
  answers.set(key, { at: Date.now(), value });
  return value;
};

const readAndEvaluate = async (
  distributionId: string,
  roleArn?: string,
): Promise<GeoReadiness> => {
  const client = cloudFront(roleArn);
  try {
    const out = await client.send(
      new GetDistributionConfigCommand({ Id: distributionId }),
    );
    const config = out.DistributionConfig;
    if (!config) throw new Error("GetDistributionConfig returned no config");

    const behaviors = behaviorsOf(config).map(({ behavior }) => behavior);
    const cacheIds = new Set(
      behaviors.flatMap((b) => (b.CachePolicyId ? [b.CachePolicyId] : [])),
    );
    const originIds = new Set(
      behaviors.flatMap((b) =>
        b.OriginRequestPolicyId ? [b.OriginRequestPolicyId] : [],
      ),
    );

    const cachePolicies = new Map<string, CachePolicyFacts>();
    for (const id of cacheIds) {
      const policy = await client.send(new GetCachePolicyCommand({ Id: id }));
      const policyConfig = policy.CachePolicy?.CachePolicyConfig;
      if (policyConfig) cachePolicies.set(id, cachePolicyFacts(policyConfig));
    }

    const originRequestPolicies = new Map<string, OriginRequestFacts>();
    for (const id of originIds) {
      const policy = await client.send(
        new GetOriginRequestPolicyCommand({ Id: id }),
      );
      const policyConfig =
        policy.OriginRequestPolicy?.OriginRequestPolicyConfig;
      if (policyConfig) {
        originRequestPolicies.set(id, originRequestFacts(policyConfig));
      }
    }

    return evaluateDistribution(
      distributionId,
      config,
      cachePolicies,
      originRequestPolicies,
    );
  } catch (err) {
    const name = errorName(err) || "unknown error";
    console.warn(
      `console-api: could not read distribution ${distributionId}: ${name}`,
    );
    return {
      status: "unknown",
      reason:
        name === "NoSuchDistribution"
          ? `No CloudFront distribution ${distributionId}`
          : `The console could not read distribution ${distributionId} (${name}): it needs cloudfront:GetDistributionConfig, cloudfront:GetCachePolicy and cloudfront:GetOriginRequestPolicy`,
    };
  }
};

// Swapped out in tests so no suite reaches AWS. Same seam shape as
// `setTableVerifier`.
let checker: GeoReadinessChecker = checkGeoReadiness;

export const getGeoReadinessChecker = (): GeoReadinessChecker => checker;

export const setGeoReadinessChecker = (fake: GeoReadinessChecker): void => {
  checker = fake;
};

export const resetGeoReadinessChecker = (): void => {
  checker = checkGeoReadiness;
  answers.clear();
};
