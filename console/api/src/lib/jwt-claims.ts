/**
 * Reading the claims out of a token the gateway has already verified.
 *
 * This does not and must not verify anything. The HTTP API's JWT authorizer has
 * checked the signature, issuer, audience and expiry before the Lambda is
 * invoked, and a second check here would either duplicate that work on every
 * request or — worse — disagree with it. What is needed is narrower: the claim
 * values in the shape the token actually carries.
 *
 * Why that shape matters. API Gateway flattens claim values into strings before
 * putting them in the authorizer context, so `cognito:groups` arrives as
 * `"[editor viewer]"` there while the token itself holds a real JSON array. One
 * of those spellings is documented and stable; the other is a string format we
 * would be guessing at. Reading the token removes the guess.
 *
 * The safety rule that comes with it: **only call this when the authorizer
 * context is present.** That context existing is the proof that the gateway ran,
 * and therefore that the bearer token in the header is one it accepted. On a
 * public route there is no authorizer, nothing has been verified, and the header
 * is whatever the caller felt like sending.
 */

/** Decodes base64url, which JWT uses instead of plain base64. */
const decodeSegment = (segment: string): string =>
  Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf8",
  );

/** The bearer token from an `Authorization` header, or "" if there isn't one. */
export const bearerToken = (header: string | undefined): string => {
  if (header === undefined) return "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? "";
};

/**
 * The payload of a JWT, or `undefined` for anything that is not one.
 *
 * Never throws. A malformed token is not an error to report here — the caller
 * falls back to the authorizer's own claims, which is a worse shape but a
 * verified one, so there is nothing for a 500 to tell anybody.
 */
export const decodeJwtPayload = (
  token: string,
): Record<string, unknown> | undefined => {
  const segments = token.split(".");
  if (segments.length !== 3) return undefined;

  try {
    const payload: unknown = JSON.parse(decodeSegment(segments[1]));
    // Arrays and null are objects to `typeof`, and neither is a claim set.
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return undefined;
    }
    return payload as Record<string, unknown>;
  } catch {
    return undefined;
  }
};
