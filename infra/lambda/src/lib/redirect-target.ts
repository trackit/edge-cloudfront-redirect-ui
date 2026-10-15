/**
 * Where a redirect may go once its `$n` captures are filled in — or `null` when
 * the filled-in target would leave the site the rule was written for.
 *
 * The schema checks the template the API stores, and a template cannot name
 * another site: a path may not start with "//" or "/\", and an absolute URL
 * names its host. A capture can, though. It is part of the viewer's URL, so
 * `/$1` fed `//evil.com` becomes `//evil.com`, which a browser reads as another
 * host, and `https://www.example.com$1` fed `@evil.com/` becomes a URL whose
 * host is evil.com. Checked on the result, after substitution, because only the
 * result is what the browser follows.
 *
 * - A path template stays a path on this site: leading slashes and
 *   backslashes collapse to one "/".
 * - An absolute template keeps the scheme, host and port it was written with.
 * - A template that starts with a capture becomes a path on this site, or an
 *   absolute URL to the host the viewer asked for. Anything else is the
 *   viewer choosing where the redirect goes.
 */

const CAPTURE = /\$[1-9]\d*/g;
const LEADING_SEPARATORS = /^[/\\]+/;
const ABSOLUTE = /^https?:\/\//i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const CONTROL_OR_SPACE = /[\u0000- \u007f]/;

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** Same scheme, host and port, and no userinfo smuggled in. */
const sameOrigin = (url: URL, origin: { protocol: string; host: string }) =>
  url.username === "" &&
  url.password === "" &&
  url.protocol === origin.protocol &&
  url.host.toLowerCase() === origin.host.toLowerCase();

export const keepOnSite = (
  template: string,
  target: string,
  viewerHost: string,
): string | null => {
  // A browser drops a tab or newline anywhere in a Location and trims leading
  // spaces and controls, so "/\t/evil.com" is "//evil.com" by the time it is
  // followed. The schema refuses whitespace in a template, so any here came
  // from a capture — a header or cookie value, say. An empty target redirects
  // to the URL it came from, and loops.
  if (target === "" || CONTROL_OR_SPACE.test(target)) return null;

  if (template.startsWith("/")) {
    return target.replace(LEADING_SEPARATORS, "/");
  }

  if (ABSOLUTE.test(template)) {
    const written = parse(template.replace(CAPTURE, ""));
    const filled = parse(target);
    if (written === null || filled === null) return null;
    return sameOrigin(filled, written) ? target : null;
  }

  // Starts with a capture: nothing in the template fixes where it goes.
  if (LEADING_SEPARATORS.test(target)) {
    return target.replace(LEADING_SEPARATORS, "/");
  }
  if (!SCHEME.test(target)) return target;
  const filled = parse(target);
  if (filled === null || !ABSOLUTE.test(target)) return null;
  return sameOrigin(filled, { protocol: filled.protocol, host: viewerHost })
    ? target
    : null;
};
