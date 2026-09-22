/**
 * Where a host lives in the URL.
 *
 * The selected host is a route param rather than component state so the console
 * is linkable and survives a reload — and so the back button moves between
 * hosts, which is what a list of links leads someone to expect.
 *
 * A host is a single path segment and is encoded as one. Hostnames are dots and
 * letters in practice, but nothing stops the API from holding one that is not,
 * and an unencoded `/` would silently address a different route.
 */
export const CONSOLE_PATH = "/console";

export const hostPath = (host: string): string =>
  `${CONSOLE_PATH}/hosts/${encodeURIComponent(host)}`;

/**
 * A host as the API stores it, and therefore as this app compares it.
 *
 * The mirror of `hostKey` in the API's `validate-host.ts`, and here for the same
 * reason it is there: DNS is case-insensitive, a DynamoDB partition key is not,
 * so one definition of "the same host" has to exist or `Shop.example.com` and
 * `shop.example.com` become two hosts with one of them unreachable.
 *
 * The API normalizes `:host` centrally in its router rather than in each
 * handler. This is the client's version of that: every place a host arrives from
 * outside the app — a typed URL, a shared link, a form — goes through here, so a
 * later screen cannot reintroduce the split by forgetting.
 */
export const hostKey = (host: string): string => host.toLowerCase();
