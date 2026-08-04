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
