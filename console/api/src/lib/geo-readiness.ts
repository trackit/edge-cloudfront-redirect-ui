import {
  CloudFrontClient,
  GetCachePolicyCommand,
  GetDistributionConfigCommand,
  GetOriginRequestPolicyCommand,
  type CachePolicyConfig,
  type DistributionConfig,
  type GetCachePolicyCommandOutput,
  type GetDistributionConfigCommandOutput,
  type GetOriginRequestPolicyCommandOutput,
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
 * Stamped by our viewer-request so origin-request knows which site the viewer
 * asked for. Same string as infra/lambda/src/lib/viewer-host.ts.
 */
export const VIEWER_HOST_HEADER = "x-edgeroute-viewer-host";

/**
 * - `ok`: the country reaches the function, and a cached copy is per country
 *   (or nothing is cached).
 * - `notOurs`: our function does not run on this behavior, so no rule does.
 *   Listed anyway: a path served by it is not served by any later behavior.
 * - `noOriginRequest`: the function runs at viewer-request only, and country
 *   conditions are evaluated at origin-request.
 * - `viewerHostMissing`: origin-request never learns which site the viewer
 *   asked for, so it finds no rules at all.
 * - `countryNotForwarded`: no policy asks CloudFront for the country, so every
 *   country rule on this behavior is skipped (the edge logs that one).
 * - `cachedWithoutCountry`: the behavior caches, and the country is not in its
 *   cache key. The silent case.
 * - `cachedByOriginHeaders`: the same, but only when the origin asks for a
 *   copy to be kept — a warning rather than a certainty.
 */
export type BehaviorVerdict =
  | "ok"
  | "notOurs"
  | "noOriginRequest"
  | "viewerHostMissing"
  | "countryNotForwarded"
  | "cachedWithoutCountry"
  | "cachedByOriginHeaders";

/** Names a policy sends on to origin-request, or every one but `except`. */
export interface Passed {
  all: boolean;
  names: string[];
  except: string[];
}

/**
 * What reaches origin-request on a behavior, one entry per policy that can
 * send it on: a name reaches it if any entry lets it through. What does not is
 * dropped, and reads as empty to a rule there.
 */
export interface Forwarding {
  headers: Passed[];
  cookies: Passed[];
}

export interface BehaviorReadiness {
  /** `*` for the default behavior, as CloudFront shows it. */
  pathPattern: string;
  verdict: BehaviorVerdict;
  /** Set on the behaviors a rule runs on. */
  forwards?: Forwarding;
}

/** Why a distribution could not be judged. */
export type UnknownCause =
  | "accessDenied"
  | "notFound"
  | "notADistribution"
  | "noFunction"
  | "transient"
  | "unexpected";

/**
 * A verdict per behavior, not one for the distribution: which behavior matters
 * depends on the rule's path, and that is geo-relevance.ts's call.
 */
export type GeoReadiness =
  | {
      status: "checked";
      distributionId: string;
      /** False when the target names no function and any Lambda counted. */
      functionIdentified: boolean;
      /** In CloudFront's matching order, the default behavior last. */
      behaviors: BehaviorReadiness[];
    }
  | { status: "unknown"; cause: UnknownCause; reason: string };

/** What the evaluator needs of a cache policy, so tests do not build SDK shapes. */
export interface CachePolicyFacts {
  caches: boolean;
  /** Keeps a copy even when the origin says nothing (MinTTL or DefaultTTL > 0). */
  cachesByDefault: boolean;
  keyHeaders: string[];
  /** Headers and cookies in the key, which CloudFront also sends on. */
  passedHeaders?: Passed;
  passedCookies?: Passed;
}

/** What the evaluator needs of an origin request policy. */
export interface OriginRequestFacts {
  /** Headers the policy names: the only way to forward a CloudFront-* one. */
  forwardedHeaders: string[];
  /** Forwards the viewer's headers without naming them. */
  forwardsAllViewer: boolean;
  /** What `allExcept` leaves out; empty for every other behavior. */
  exceptHeaders: string[];
  passedHeaders?: Passed;
  passedCookies?: Passed;
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
    // With MinTTL and DefaultTTL at 0 a copy is only kept when the origin asks
    // for one in Cache-Control — possibly never. Worth a warning, not a block.
    cachesByDefault: (config.MinTTL ?? 0) > 0 || (config.DefaultTTL ?? 0) > 0,
    keyHeaders:
      headers?.HeaderBehavior === "whitelist"
        ? (headers.Headers?.Items ?? [])
        : [],
    passedHeaders: {
      all: false,
      names:
        headers?.HeaderBehavior === "whitelist"
          ? (headers.Headers?.Items ?? [])
          : [],
      except: [],
    },
    passedCookies: cookiesPassed(
      config.ParametersInCacheKeyAndForwardedToOrigin?.CookiesConfig,
    ),
  };
};

export const originRequestFacts = (
  config: OriginRequestPolicyConfig,
): OriginRequestFacts => {
  const headers = config.HeadersConfig;
  const behavior = headers?.HeaderBehavior;
  const items = headers?.Headers?.Items ?? [];
  return {
    // `allViewer` and `allExcept` forward the viewer's own headers, which the
    // CloudFront-* ones are not: only a whitelist can name them.
    forwardedHeaders:
      behavior === "whitelist" || behavior === "allViewerAndWhitelistCloudFront"
        ? items
        : [],
    // The viewer host is added by our viewer-request function, so CloudFront
    // treats it as a viewer header: these forward it without naming it.
    forwardsAllViewer:
      behavior === "allViewer" ||
      behavior === "allViewerAndWhitelistCloudFront" ||
      behavior === "allExcept",
    exceptHeaders: behavior === "allExcept" ? items : [],
    passedHeaders: {
      all:
        behavior === "allViewer" ||
        behavior === "allViewerAndWhitelistCloudFront" ||
        behavior === "allExcept",
      names:
        behavior === "whitelist" ||
        behavior === "allViewerAndWhitelistCloudFront"
          ? items
          : [],
      except: behavior === "allExcept" ? items : [],
    },
    passedCookies: cookiesPassed(config.CookiesConfig),
  };
};

const NOTHING: Passed = { all: false, names: [], except: [] };

/**
 * A policy's cookie settings: `whitelist` names them, `all` and `allExcept`
 * send every one (but the listed ones), `none` sends none.
 */
const cookiesPassed = (config?: {
  CookieBehavior?: string;
  Cookies?: { Items?: string[] };
}): Passed => {
  const items = config?.Cookies?.Items ?? [];
  switch (config?.CookieBehavior) {
    case "whitelist":
      return { all: false, names: items, except: [] };
    case "all":
      return { all: true, names: [], except: [] };
    case "allExcept":
      return { all: true, names: [], except: items };
    default:
      return NOTHING;
  }
};

const has = (names: string[], header: string): boolean =>
  names.some((name) => name.toLowerCase() === header);

type Behavior = NonNullable<DistributionConfig["DefaultCacheBehavior"]>;

/** A function ARN without its `:<version>` or `:$LATEST` suffix. */
export const unqualified = (arn: string): string =>
  arn.replace(/:(\d+|\$LATEST)$/, "");

/**
 * Every behavior, in the order CloudFront tries them: the cache behaviors as
 * listed, then the default one, which only serves what none of them matched.
 * Path resolution (geo-relevance.ts) depends on this order.
 */
const behaviorsOf = (
  config: DistributionConfig,
): { pathPattern: string; behavior: Behavior }[] => [
  ...(config.CacheBehaviors?.Items ?? []).map((behavior) => ({
    pathPattern: behavior.PathPattern ?? "?",
    behavior: behavior as Behavior,
  })),
  ...(config.DefaultCacheBehavior
    ? [{ pathPattern: "*", behavior: config.DefaultCacheBehavior }]
    : []),
];

/**
 * The events our function runs at on this behavior. Without a known ARN every
 * Lambda association counts as ours — the old behavior, said so through
 * `functionIdentified: false`.
 */
const ourEvents = (behavior: Behavior, edgeFunctionArn?: string): string[] =>
  (behavior.LambdaFunctionAssociations?.Items ?? [])
    .filter(
      (association) =>
        edgeFunctionArn === undefined ||
        unqualified(association.LambdaFunctionARN ?? "") ===
          unqualified(edgeFunctionArn),
    )
    .map((association) => association.EventType ?? "");

/**
 * The verdict for each behavior, from facts already fetched. A behavior our
 * function does not run on is `notOurs`: no rule runs there.
 *
 * A behavior with no cache policy uses the legacy cache settings, where the
 * forwarded headers are the cache key and `MaxTTL` sits on the behavior.
 */
export const evaluateDistribution = (
  distributionId: string,
  config: DistributionConfig,
  cachePolicies: Map<string, CachePolicyFacts>,
  originRequestPolicies: Map<string, OriginRequestFacts>,
  edgeFunctionArn?: string,
): GeoReadiness => {
  const behaviors: BehaviorReadiness[] = [];

  for (const { pathPattern, behavior } of behaviorsOf(config)) {
    const events = ourEvents(behavior, edgeFunctionArn);
    if (events.length === 0) {
      behaviors.push({ pathPattern, verdict: "notOurs" });
      continue;
    }

    if (!events.includes("origin-request")) {
      behaviors.push({ pathPattern, verdict: "noOriginRequest" });
      continue;
    }

    const cache = behavior.CachePolicyId
      ? cachePolicies.get(behavior.CachePolicyId)
      : legacyCacheFacts(behavior);
    const origin = behavior.OriginRequestPolicyId
      ? originRequestPolicies.get(behavior.OriginRequestPolicyId)
      : undefined;
    const forwarded = origin?.forwardedHeaders ?? [];
    const keyHeaders = cache?.keyHeaders ?? [];

    // Without the viewer-request association nothing stamps the header, and
    // without a policy carrying it CloudFront drops it on the way: either way
    // origin-request looks the rules up under the origin's domain and finds none.
    const hostReaches =
      events.includes("viewer-request") &&
      (has(keyHeaders, VIEWER_HOST_HEADER) ||
        has(forwarded, VIEWER_HOST_HEADER) ||
        (origin?.forwardsAllViewer === true &&
          !has(origin.exceptHeaders, VIEWER_HOST_HEADER)));
    if (!hostReaches) {
      behaviors.push({ pathPattern, verdict: "viewerHostMissing" });
      continue;
    }

    const inKey = has(keyHeaders, COUNTRY_HEADER);
    const verdict: BehaviorVerdict =
      !inKey && !has(forwarded, COUNTRY_HEADER)
        ? "countryNotForwarded"
        : (cache?.caches ?? true) && !inKey
          ? (cache?.cachesByDefault ?? true)
            ? "cachedWithoutCountry"
            : "cachedByOriginHeaders"
          : "ok";
    behaviors.push({
      pathPattern,
      verdict,
      forwards: forwardingOf(behavior, cache, origin),
    });
  }

  if (behaviors.every((b) => b.verdict === "notOurs")) {
    return {
      status: "unknown",
      cause: "noFunction",
      reason:
        edgeFunctionArn === undefined
          ? `No behavior of distribution ${distributionId} runs a Lambda@Edge function`
          : `No behavior of distribution ${distributionId} runs ${unqualified(edgeFunctionArn)}`,
    };
  }

  return {
    status: "checked",
    distributionId,
    functionIdentified: edgeFunctionArn !== undefined,
    behaviors,
  };
};

/**
 * One entry per policy that sends things on: the cache policy's key, then the
 * origin request policy. Facts built before cookies were read (tests) fall back
 * to the header fields they do carry.
 */
const forwardingOf = (
  behavior: Behavior,
  cache: CachePolicyFacts | undefined,
  origin: OriginRequestFacts | undefined,
): Forwarding => {
  if (!behavior.CachePolicyId && !behavior.OriginRequestPolicyId) {
    // Legacy settings: the forwarded values are both key and what is sent on.
    const values = behavior.ForwardedValues;
    const headers = values?.Headers?.Items ?? [];
    const cookies = values?.Cookies;
    return {
      headers: [
        headers.includes("*")
          ? { all: true, names: [], except: [] }
          : { all: false, names: headers, except: [] },
      ],
      cookies: [
        cookies?.Forward === "all"
          ? { all: true, names: [], except: [] }
          : cookies?.Forward === "whitelist"
            ? {
                all: false,
                names: cookies.WhitelistedNames?.Items ?? [],
                except: [],
              }
            : NOTHING,
      ],
    };
  }
  return {
    headers: [
      cache?.passedHeaders ?? {
        all: false,
        names: cache?.keyHeaders ?? [],
        except: [],
      },
      origin?.passedHeaders ?? {
        all: origin?.forwardsAllViewer ?? false,
        names: origin?.forwardedHeaders ?? [],
        except: origin?.exceptHeaders ?? [],
      },
    ],
    cookies: [
      cache?.passedCookies ?? NOTHING,
      origin?.passedCookies ?? NOTHING,
    ],
  };
};

const legacyCacheFacts = (behavior: Behavior): CachePolicyFacts => {
  const headers = behavior.ForwardedValues?.Headers?.Items ?? [];
  return {
    // Forwarding every header makes the whole request the key, which is per
    // country too.
    caches: (behavior.MaxTTL ?? 0) > 0 && !headers.includes("*"),
    cachesByDefault:
      (behavior.MinTTL ?? 0) > 0 || (behavior.DefaultTTL ?? 0) > 0,
    // Legacy forwarded headers are the cache key and what reaches the origin.
    keyHeaders: headers.includes("*")
      ? [COUNTRY_HEADER, VIEWER_HOST_HEADER]
      : headers,
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
  /** Our function. Absent: every Lambda association counts as ours. */
  edgeFunctionArn?: string;
}

export type GeoReadinessChecker = (
  target: ReadinessTarget,
  /** `fresh` skips the reuse of a recent answer: the editor's "Re-check". */
  options?: { fresh?: boolean },
) => Promise<GeoReadiness>;

/** The one SDK method this module uses, so a test can stand in for CloudFront. */
interface CloudFrontLike {
  send: (command: unknown) => Promise<unknown>;
}

const clients = new Map<string, CloudFrontClient>();

/** CloudFront's control plane is global and answers in us-east-1. */
const cloudFront = (roleArn?: string): CloudFrontLike => {
  const key = roleArn ?? "";
  let client = clients.get(key);
  if (!client) {
    client = new CloudFrontClient({
      region: "us-east-1",
      ...(roleArn ? { credentials: assumeRole(roleArn, "us-east-1") } : {}),
    });
    clients.set(key, client);
  }
  return client as unknown as CloudFrontLike;
};

let clientFor: (roleArn?: string) => CloudFrontLike = cloudFront;

/** Test seam: replaces the CloudFront client, so no suite reaches AWS. */
export const setCloudFrontFactory = (
  fake: (roleArn?: string) => CloudFrontLike,
): void => {
  clientFor = fake;
};

export const resetCloudFrontFactory = (): void => {
  clientFor = cloudFront;
};

/** How long an answer is reused. A fixed config is read once a minute at most. */
const TTL_MS = 60_000;
const answers = new Map<string, { at: number; value: GeoReadiness }>();
/** Reads under way, so two editors asking at once cost one read. */
const inFlight = new Map<string, Promise<GeoReadiness>>();

/** Permissions, or the credentials the role assumption produced. */
const ACCESS =
  /^(AccessDenied|AccessDeniedException|UnauthorizedOperation|CredentialsProviderError|ExpiredToken|ExpiredTokenException|InvalidClientTokenId|UnrecognizedClientException|InvalidSignatureException)$/;
/** Failures a retry can fix. */
const PASSING =
  /Throttl|TooManyRequests|RequestLimitExceeded|Timeout|TimedOut|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|NetworkingError|ServiceUnavailable/;

/**
 * Only an access problem is about IAM, and only a failure a retry can fix is
 * "try again". Anything else — a bug, a config the SDK refuses — is said to be
 * unexpected, so it is looked into rather than retried forever.
 */
const causeOf = (err: unknown, name: string): UnknownCause => {
  if (name === "NoSuchDistribution") return "notFound";
  if (ACCESS.test(name)) return "accessDenied";
  const meta = err as {
    $retryable?: unknown;
    $metadata?: { httpStatusCode?: number };
  } | null;
  if (
    PASSING.test(name) ||
    meta?.$retryable !== undefined ||
    (meta?.$metadata?.httpStatusCode ?? 0) >= 500
  ) {
    return "transient";
  }
  return "unexpected";
};

const reasonFor = (
  cause: UnknownCause,
  distributionId: string,
  name: string,
): string =>
  cause === "notFound"
    ? `No CloudFront distribution ${distributionId}`
    : cause === "accessDenied"
      ? `The console could not read distribution ${distributionId} (${name}): it needs cloudfront:GetDistributionConfig, cloudfront:GetCachePolicy and cloudfront:GetOriginRequestPolicy`
      : cause === "transient"
        ? `AWS did not answer when reading distribution ${distributionId} (${name}). Try again`
        : `Reading distribution ${distributionId} failed unexpectedly (${name}). The console API logs have the details`;

/** Answers that only a deploy changes, worth keeping like a reading. */
const keeps = (value: GeoReadiness): boolean =>
  value.status === "checked" || value.cause === "noFunction";

/**
 * Reads the target's distribution and evaluates it. Never throws: a
 * distribution the API cannot read is `unknown` with the cause, because this
 * decides what the console warns about and what a write guard refuses, and an
 * exception would turn that into a 500.
 */
export const checkGeoReadiness: GeoReadinessChecker = (
  target,
  options = {},
) => {
  const distributionId = distributionIdOf(target.name);
  if (distributionId === null) {
    return Promise.resolve({
      status: "unknown",
      cause: "notADistribution",
      reason: `The target "${target.name}" is not named after a CloudFront distribution ID, so its cache settings cannot be checked`,
    });
  }

  const key = `${target.roleArn ?? ""} ${distributionId} ${target.edgeFunctionArn ?? ""}`;
  if (!options.fresh) {
    const cached = answers.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      return Promise.resolve(cached.value);
    }
    const pending = inFlight.get(key);
    if (pending) return pending;
  }

  const startedAt = Date.now();
  const request: Promise<GeoReadiness> = readAndEvaluate(
    distributionId,
    target.roleArn,
    target.edgeFunctionArn,
  )
    .then((value) => {
      // Only a reading is kept: an unknown answer is often a passing throttle,
      // and keeping it would repeat the wrong advice for a minute. A failed
      // read leaves an earlier reading in place, and an older read never
      // replaces one that started after it.
      const current = answers.get(key);
      if (keeps(value) && (current === undefined || current.at <= startedAt)) {
        answers.set(key, { at: startedAt, value });
      }
      return value;
    })
    .finally(() => {
      // Only our own entry: a fresh read may have replaced it meanwhile.
      if (inFlight.get(key) === request) inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
};

const readAndEvaluate = async (
  distributionId: string,
  roleArn?: string,
  edgeFunctionArn?: string,
): Promise<GeoReadiness> => {
  const client = clientFor(roleArn);
  try {
    const out = (await client.send(
      new GetDistributionConfigCommand({ Id: distributionId }),
    )) as GetDistributionConfigCommandOutput;
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

    // In parallel: one slow policy read should not stack on the others.
    const [cacheEntries, originEntries] = await Promise.all([
      Promise.all(
        [...cacheIds].map(async (id) => {
          const policy = (await client.send(
            new GetCachePolicyCommand({ Id: id }),
          )) as GetCachePolicyCommandOutput;
          const policyConfig = policy.CachePolicy?.CachePolicyConfig;
          return policyConfig
            ? ([id, cachePolicyFacts(policyConfig)] as const)
            : null;
        }),
      ),
      Promise.all(
        [...originIds].map(async (id) => {
          const policy = (await client.send(
            new GetOriginRequestPolicyCommand({ Id: id }),
          )) as GetOriginRequestPolicyCommandOutput;
          const policyConfig =
            policy.OriginRequestPolicy?.OriginRequestPolicyConfig;
          return policyConfig
            ? ([id, originRequestFacts(policyConfig)] as const)
            : null;
        }),
      ),
    ]);

    return evaluateDistribution(
      distributionId,
      config,
      new Map(cacheEntries.filter((entry) => entry !== null)),
      new Map(originEntries.filter((entry) => entry !== null)),
      edgeFunctionArn,
    );
  } catch (err) {
    const name = errorName(err) || "unknown error";
    // The error itself, not only its name: an unexpected one is a bug to find.
    console.warn(
      `console-api: could not read distribution ${distributionId}: ${name}`,
      err,
    );
    const cause = causeOf(err, name);
    return {
      status: "unknown",
      cause,
      reason: reasonFor(cause, distributionId, name),
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
  inFlight.clear();
};
