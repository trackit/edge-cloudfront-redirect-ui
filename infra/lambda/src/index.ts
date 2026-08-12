import type {
  CloudFrontEvent,
  CloudFrontHeaders,
  CloudFrontOrigin,
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
} from "aws-lambda";
import type { EdgeConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { DynamoDBRuleRepository } from "./dynamodb-repository.js";
import { RulesService } from "./rules-service.js";
import type {
  CloudFrontOriginWithExtendedProtocol,
  RequestParams,
} from "./rule-types.js";
import { VIEWER_HOST_HEADER, stampViewerHost } from "./lib/viewer-host.js";

/**
 * Terraform renders `edge-config.generated.ts` into the zip at package time, so
 * it doesn't exist in the repo. The specifier is held in a variable to keep the
 * missing module out of TypeScript's resolution graph; an absent file falls back
 * to `RULES_*` env vars, which is how local runs and tests configure the Lambda.
 */
const GENERATED_CONFIG = "./edge-config.generated.js";

const loadGeneratedConfig = async (): Promise<Partial<EdgeConfig>> => {
  try {
    const mod = (await import(GENERATED_CONFIG)) as {
      generated?: Partial<EdgeConfig>;
    };
    return mod.generated ?? {};
  } catch {
    return {};
  }
};

// One service per execution environment: the DynamoDB client and the rule cache
// both survive across invocations on a warm container.
let servicePromise: Promise<RulesService> | undefined;

const getService = (): Promise<RulesService> => {
  servicePromise ??= (async () => {
    const config = resolveConfig(await loadGeneratedConfig());
    const repo = new DynamoDBRuleRepository(
      config.tableName,
      config.tableRegion,
    );
    return new RulesService(repo, config.cacheTtlMs);
  })();
  return servicePromise;
};

/** Test seam: drops the memoized service so the next call rebuilds it. */
export const resetService = (): void => {
  servicePromise = undefined;
};

const getParams = (
  request: CloudFrontRequest,
  eventType: CloudFrontEvent["config"]["eventType"],
): RequestParams | null => {
  const headers: Record<string, string> = {};
  for (const [key, entries] of Object.entries(request.headers)) {
    if (entries?.[0]?.value) {
      headers[key.toLowerCase()] = entries[0].value;
    }
  }

  // At origin-request `host` is the origin's domain, not the site the viewer
  // asked for, so the value viewer-request stamped is the one that can find the
  // host's rules (see lib/viewer-host.ts). It is only trusted for that event:
  // at viewer-request the real Host header is right there, and preferring a
  // header the viewer can set would let it choose whose rules to be matched by.
  //
  // Falling back to `host` covers a distribution that attaches origin-request
  // alone — nothing was stamped, so rewrites key on the origin's domain, as they
  // did before. Attach both associations to key them on the viewer's hostname.
  const hostname =
    (eventType === "origin-request"
      ? headers[VIEWER_HOST_HEADER]
      : undefined) ??
    headers["host"] ??
    "";
  if (!hostname) return null;

  const protocol = headers["x-forwarded-proto"] || "https";
  const search = request.querystring ? `?${request.querystring}` : "";

  return {
    hostname,
    path: `${request.uri}${search}`,
    protocol,
    headers,
    cookies: headers["cookie"] || "",
  };
};

const statusDescription = (statusCode: 301 | 302): string =>
  statusCode === 301 ? "Moved Permanently" : "Found";

/**
 * The rule schema allows Akamai-style protocol values; CloudFront only accepts
 * http/https on `request.origin`. Returns a fresh origin rather than mutating
 * the argument: the origin comes from a cached rule, and `match-viewer`
 * resolves per-request, so writing back would freeze the first request's
 * protocol onto every later cache hit.
 */
const normalizeOriginProtocol = (
  origin: CloudFrontOriginWithExtendedProtocol,
  request: CloudFrontRequest,
): CloudFrontOrigin => {
  if (!origin.custom) return origin as CloudFrontOrigin;

  let protocol: "http" | "https";
  switch (origin.custom.protocol) {
    case "http-only":
      protocol = "http";
      break;
    case "https-only":
      protocol = "https";
      break;
    case "match-viewer":
      protocol =
        request.headers["x-forwarded-proto"]?.[0]?.value === "http"
          ? "http"
          : "https";
      break;
    default:
      protocol = origin.custom.protocol;
  }

  return {
    ...origin,
    custom: { ...origin.custom, protocol },
  } as CloudFrontOrigin;
};

const handleViewerRequest = async (
  request: CloudFrontRequest,
  params: RequestParams,
): Promise<CloudFrontRequestResult> => {
  // Stamped before the lookup so origin-request still knows the viewer's
  // hostname when rule evaluation fails and the handler passes the request
  // through untouched.
  stampViewerHost(request.headers, params.hostname);

  const service = await getService();
  const result = await service.match(params, "REDIRECT");

  if (result?.type !== "redirect") return request;

  const headers: CloudFrontHeaders = {
    location: [{ key: "Location", value: result.redirectURL }],
    "cache-control": [
      { key: "Cache-Control", value: "max-age=0, no-cache, no-store" },
    ],
  };

  return {
    status: result.statusCode.toString(),
    statusDescription: statusDescription(result.statusCode),
    headers,
  };
};

const handleOriginRequest = async (
  request: CloudFrontRequest,
  params: RequestParams,
): Promise<CloudFrontRequestResult> => {
  // Its one reader is `params.hostname`, which is already resolved. Dropped
  // rather than forwarded: it is this function's own bookkeeping, and a rewrite
  // may hand the request to an origin that is not ours.
  delete request.headers[VIEWER_HOST_HEADER];

  const service = await getService();
  const result = await service.match(params, "REWRITE");

  if (result?.type !== "rewrite") return request;

  const { pathAndQS, origin } = result.forwardSettings;
  let queryReplaced = false;

  if (pathAndQS) {
    const [newPath, ...qsParts] = pathAndQS.split("?");
    request.uri = newPath || "/";
    if (qsParts.length > 0) {
      request.querystring = qsParts.join("?");
      queryReplaced = true;
    }
  }

  // A query string the rule resolved to wins. Failing that, an explicit
  // `useIncomingQueryString: false` clears what the viewer sent — the only thing
  // that ever drops it. Left alone otherwise: an absent flag means keep, so a
  // rule written by hand against the upstream snippet behaves the same here.
  if (!queryReplaced && result.dropIncomingQueryString) {
    request.querystring = "";
  }

  if (origin) {
    request.origin = normalizeOriginProtocol(origin, request);

    // The origin's own domain must become the Host header, or the new origin
    // rejects the request.
    const domainName = origin.s3?.domainName ?? origin.custom?.domainName ?? "";
    request.headers["host"] = [{ key: "host", value: domainName }];
  }

  return request;
};

export const handler = async (
  event: CloudFrontRequestEvent,
): Promise<CloudFrontRequestResult> => {
  const record = event.Records[0]?.cf;
  const request = record?.request;
  if (!request) {
    throw new Error("redirect-rules: event carried no CloudFront request");
  }

  const params = getParams(request, record.config.eventType);
  if (!params) return request;

  try {
    switch (record.config.eventType) {
      case "viewer-request":
        return await handleViewerRequest(request, params);
      case "origin-request":
        return await handleOriginRequest(request, params);
      default:
        return request;
    }
  } catch (e) {
    // Never fail the request on a rule error — pass it through untouched.
    console.error("redirect-rules: rule evaluation failed", {
      eventType: record.config.eventType,
      hostname: params.hostname,
      path: params.path,
      error: e instanceof Error ? e.message : String(e),
    });
    return request;
  }
};
