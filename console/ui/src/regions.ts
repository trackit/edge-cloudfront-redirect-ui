import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * The regions a target's table may live in, as the API reports them.
 *
 * The console used to carry its own shortlist, which was wrong twice over: too
 * narrow, because it named seven of the thirty-two regions the API accepts by
 * default; and too wide, because `ALLOWED_REGIONS` replaces that default per
 * deployment, so an environment narrowed to one region still offered seven
 * (CF-34). Neither could be fixed here — only the running API knows.
 */

/**
 * Used until the answer arrives, and kept if it never does. A dropdown with no
 * options is a form nobody can complete, so a failed request has to degrade to
 * a guess rather than to nothing; the API validates the choice regardless, so
 * the cost of guessing wrong is a named error rather than a bad write.
 *
 * These are the regions the shortlist named, which are the ones a rules table
 * is most often in.
 */
export const FALLBACK_REGIONS = [
  "us-east-1",
  "us-west-2",
  "eu-west-1",
  "eu-west-3",
  "eu-central-1",
  "ap-southeast-1",
  "ap-northeast-1",
] as const;

/**
 * What to show in the select.
 *
 * `current` is always present, even when the deployment no longer allows it: a
 * `<select>` whose value is not among its options renders blank, and the next
 * change would silently rewrite a stored region the user never touched. Showing
 * it keeps an existing distribution readable in Settings, and the API still
 * refuses it on save — which is the right place for that argument.
 */
export const regionOptions = (
  allowed: readonly string[],
  current: string,
): string[] => {
  const options = new Set(allowed);
  if (current !== "") options.add(current);
  return [...options].sort();
};

/**
 * Module-level, so the answer is fetched once per page load rather than once
 * per mount: the connect screen, the add-distribution modal and Settings all
 * render the same fields, and the set cannot change while the tab is open.
 */
let cached: string[] | undefined;
let inFlight: Promise<string[]> | undefined;

const load = async (): Promise<string[]> => {
  if (cached !== undefined) return cached;
  inFlight ??= api
    .meta()
    .then((meta) => {
      cached = meta.regions;
      return cached;
    })
    .catch(() => {
      // Not cached: a deployment that was briefly unreachable should get the
      // real list on the next mount rather than the fallback for the session.
      inFlight = undefined;
      return [...FALLBACK_REGIONS];
    });
  return inFlight;
};

/** Exposed for tests, which would otherwise inherit each other's cache. */
export const resetRegionCache = (): void => {
  cached = undefined;
  inFlight = undefined;
};

export const useRegions = (): readonly string[] => {
  const [regions, setRegions] = useState<readonly string[]>(
    cached ?? FALLBACK_REGIONS,
  );

  useEffect(() => {
    let live = true;
    void load().then((loaded) => {
      if (live) setRegions(loaded);
    });
    return () => {
      live = false;
    };
  }, []);

  return regions;
};
