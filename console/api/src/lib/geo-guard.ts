import { ApiError } from "./errors.js";
import { getGeoReadinessChecker } from "./geo-readiness.js";
import { geoDecision, readsCountry, type MatchLike } from "./geo-relevance.js";
import type { Principal } from "./principal.js";
import type { RuleItem } from "./rules-repository.js";
import { getTargetsRepository } from "./targets-repository.js";

const label = (pattern: string): string =>
  pattern === "*" ? "the default behavior" : pattern;

/**
 * Refuses a country rewrite the distribution would serve to the wrong viewers.
 * The editor checks first, but this is what holds for a script or a direct
 * call. A redirect is never refused: it is `no-store`, so the worst it does is
 * miss viewers. A disabled rule is not checked — it runs nowhere — and is
 * checked when it is turned back on.
 *
 * Known danger has no override: there is no good reason to save it. "Could not
 * check" can be overridden, so a missing permission or a passing AWS failure
 * does not lock everyone out, and every override is logged with who made it —
 * never what the rule says.
 */
export const assertGeoSafe = async ({
  targetId,
  item,
  confirmUnverified,
  principal,
}: {
  targetId: string;
  item: RuleItem;
  confirmUnverified: boolean;
  principal?: Principal;
}): Promise<void> => {
  if (item.type !== "frMatchRule" || item.disabled === true) return;
  const matches = (
    Array.isArray(item["matches"]) ? item["matches"] : []
  ) as MatchLike[];
  if (!readsCountry(matches)) return;

  // resolveTarget has already turned an unknown target into a 404.
  const target = await getTargetsRepository().get(targetId);
  if (!target) return;

  const readiness = await getGeoReadinessChecker()({
    name: target.name,
    ...(target.roleArn ? { roleArn: target.roleArn } : {}),
    ...(target.edgeFunctionArn
      ? { edgeFunctionArn: target.edgeFunctionArn }
      : {}),
  });
  const decision = geoDecision("rewrite", matches, readiness);

  if (decision.outcome === "blocked") {
    const where = decision.relevant
      .filter((b) => b.verdict === "cachedWithoutCountry")
      .map((b) => label(b.pathPattern))
      .join(", ");
    throw new ApiError(
      409,
      "GEO_REWRITE_UNSAFE",
      `This country rewrite would be cached and served to every country: ${where} caches without CloudFront-Viewer-Country in its cache key. Fix the distribution's cache settings first`,
      [
        {
          path: "/forwardSettings",
          message: `${where} caches without CloudFront-Viewer-Country in its cache key`,
        },
      ],
    );
  }

  if (decision.outcome !== "unverifiable" || readiness.status !== "unknown") {
    return;
  }

  if (!confirmUnverified) {
    throw new ApiError(
      409,
      "GEO_UNVERIFIED",
      `The distribution could not be checked: ${readiness.reason}. Confirm to save this country rewrite anyway`,
      [{ path: "/forwardSettings", message: readiness.reason }],
    );
  }

  console.info(
    JSON.stringify({
      event: "geo-unverified-confirmed",
      principal: principal?.sub ?? "unknown",
      targetId,
      host: item.pk,
      sk: item.sk,
      cause: readiness.cause,
    }),
  );
};
