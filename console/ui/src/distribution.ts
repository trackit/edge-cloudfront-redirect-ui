import { useCallback, useEffect, useState } from "react";
import type { Distribution } from "./types";

/**
 * Where the connected distribution is kept.
 *
 * localStorage is deliberate for now: the ticket defers persistence to the user
 * profile, and there is no API to hold it in the meantime. Every read and write
 * goes through this module, so moving to the profile — or onto the rules API's
 * targets registry — is a change here and nowhere else.
 */
const STORAGE_KEY = "edgeroute.distribution";

/** Prefills the connect form. Not written anywhere until the user connects. */
export const SAMPLE_DISTRIBUTION: Distribution = {
  distributionId: "E2QWERTY123456",
  tableName: "edgeroute-rules",
  region: "us-east-1",
};

export const emptyDistribution = (): Distribution => ({
  distributionId: "",
  tableName: "",
  region: "us-east-1",
});

/**
 * A stored value is whatever was in localStorage last time, which is not
 * necessarily a Distribution — a half-written key, or a shape from an older
 * build. Anything that does not carry all three fields as strings is treated as
 * absent, so a bad entry shows onboarding again instead of rendering a console
 * bound to undefined.
 */
const parse = (raw: string | null): Distribution | null => {
  if (raw === null) return null;

  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;

    const { distributionId, tableName, region } = value as Record<
      string,
      unknown
    >;
    if (
      typeof distributionId !== "string" ||
      typeof tableName !== "string" ||
      typeof region !== "string"
    ) {
      return null;
    }

    return { distributionId, tableName, region };
  } catch {
    return null;
  }
};

const read = (): Distribution | null => {
  try {
    return parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private-browsing modes throw on access rather than returning null.
    return null;
  }
};

/**
 * The connected distribution, or `null` when the console has nothing configured.
 * `connect` persists, `disconnect` clears — both are the only writers.
 */
export function useDistribution() {
  const [distribution, setDistribution] = useState<Distribution | null>(read);

  const connect = useCallback((value: Distribution) => {
    setDistribution(value);
  }, []);

  const disconnect = useCallback(() => {
    setDistribution(null);
  }, []);

  useEffect(() => {
    try {
      if (distribution === null) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(distribution));
      }
    } catch {
      // Storage unavailable or full: the console still works for this session.
    }
  }, [distribution]);

  return { distribution, connect, disconnect };
}
