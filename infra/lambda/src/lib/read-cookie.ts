/**
 * The value of one named cookie, out of the single header holding them all.
 *
 * A viewer sends `Cookie: session=a1b2c3; region=london; locale=nl`, so a
 * condition that names `locale` has to be compared against `nl` and nothing
 * else. Comparing against the whole line is what made a cookie condition either
 * never match (`equals`) or match unrelated cookies (`contains`).
 *
 * Cookie names are case-sensitive (RFC 6265), so the lookup is exact. A
 * condition's `caseSensitive` flag is about its *value*, and is applied by the
 * caller, as it is for every other match type.
 *
 * An absent cookie gives an empty string, the same answer as an absent header:
 * the comparison then fails, and `negate` can still turn that into a match.
 */
export const readCookie = (header: string, name: string): string => {
  if (name === "") return "";

  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    // Only the name is trimmed. A value's surrounding spaces are part of what
    // the viewer sent, and the separator is `"; "`, so the leading space belongs
    // to the delimiter rather than to the name.
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1);
  }

  return "";
};
