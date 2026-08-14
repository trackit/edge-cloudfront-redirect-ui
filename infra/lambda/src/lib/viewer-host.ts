import type { CloudFrontHeaders } from "aws-lambda";

/**
 * Carries the viewer's hostname from viewer-request across to origin-request.
 *
 * Rules are keyed on the hostname the viewer asked for (`pk = host`), and
 * viewer-request is the only event that still knows it: before origin-request
 * fires, CloudFront replaces the `Host` header with the *origin's* domain, so a
 * lookup there finds the partition of a bucket or backend rather than the site's
 * rules. Every rewrite rule would silently never match.
 *
 * Lowercase because CloudFront event header keys are lowercase; the display
 * casing below is what goes on the wire.
 *
 * Surviving the trip is not automatic. CloudFront builds the origin request from
 * the cache key plus the origin request policy, so a behavior whose policies do
 * not name this header drops it before origin-request and every rewrite silently
 * stops matching. The same string is exposed as the edge module's
 * `viewer_host_header` output (infra/modules/edge/outputs.tf) for consumers to
 * build that policy from — change one, change the other.
 */
export const VIEWER_HOST_HEADER = "x-edgeroute-viewer-host";

/**
 * CloudFront preserves `key` verbatim on the request it forwards, so the header
 * name is spelled once, here, rather than at the call site.
 */
const VIEWER_HOST_HEADER_KEY = "X-EdgeRoute-Viewer-Host";

/**
 * Records the viewer's hostname on the request for origin-request to read.
 *
 * Always overwrites. A viewer is free to send this header itself, and honouring
 * it would let anyone pick which host's rules — and so which origin — apply to
 * their request.
 */
export const stampViewerHost = (
  headers: CloudFrontHeaders,
  hostname: string,
): void => {
  headers[VIEWER_HOST_HEADER] = [
    { key: VIEWER_HOST_HEADER_KEY, value: hostname },
  ];
};
