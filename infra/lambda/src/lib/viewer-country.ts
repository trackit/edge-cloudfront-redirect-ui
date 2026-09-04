/**
 * The header CloudFront puts the viewer's country in, as an ISO 3166-1 alpha-2
 * code. Unlike `VIEWER_HOST_HEADER`, nothing here ever writes it: it is
 * CloudFront's, and a viewer-request function that sets it makes CloudFront
 * answer the viewer with a 502.
 *
 * Two conditions have to hold before it carries anything:
 *
 * 1. **The event is origin-request** (or origin-response). CloudFront works the
 *    country out after the viewer-request event, so a viewer-request function
 *    sees either nothing under this name or whatever the viewer chose to send.
 *    That is why `getParams` only reads it for origin-request, and why a rule
 *    with a country condition is evaluated there.
 * 2. **The distribution asks for it**, in a cache policy or an origin request
 *    policy. Neither is this module's to configure, and a response that varies
 *    by country needs the header in the *cache key* to not be served to the
 *    wrong country, which means a cache policy. See ../../README.md.
 *
 * Lowercase because CloudFront event header keys are lowercase.
 */
export const VIEWER_COUNTRY_HEADER = "cloudfront-viewer-country";
