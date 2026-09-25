import safeRegex from "safe-regex";
import { isRedirect, narrowForwardSettings, priorityOf } from "../api";
import type {
  CustomOrigin,
  MatchCondition,
  Rule,
  RuleInput,
  S3Origin,
  ValidationDetail,
} from "../api";

/**
 * The country codes a `country` condition holds, from its `matchValue`.
 *
 * The two functions either side of the wire format, so no component has to know
 * that a set of countries is stored as a string. Space-separated is not this
 * feature's invention: the edge splits every `matchValue` on spaces and matches
 * any variant, which is what makes "one of these countries" work with no
 * matching code at all. See `shared/redirect-rule.schema.json`.
 */
export const parseCountries = (matchValue: string): string[] =>
  matchValue
    .split(" ")
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code !== "");

/**
 * Sorted and de-duplicated, so the same set of countries always produces the
 * same stored string. Without it, adding FR then DE and adding DE then FR would
 * be two different rules, and every reordering would look like an edit in a
 * diff or an audit log.
 */
export const formatCountries = (codes: readonly string[]): string =>
  [...new Set(codes.map((code) => code.trim().toUpperCase()))]
    .filter((code) => code !== "")
    .sort()
    .join(" ");

/**
 * The condition types a redirect cannot combine with a `country` one.
 *
 * A redirect reading the country is answered at origin-request, where only the
 * headers and cookies the distribution forwards are left. A dropped one reads
 * as empty, and negated that matches everyone. The protocol too: the edge reads
 * it from `X-Forwarded-Proto`, which is not guaranteed there, and assumes
 * `https` without it. The redirect schema refuses the combination; this is the
 * same rule, so the editor can say so before saving. See
 * `shared/redirect-rule.schema.json`.
 */
const NOT_BESIDE_COUNTRY: readonly MatchCondition["matchType"][] = [
  "header",
  "cookie",
  "protocol",
];

/**
 * The types condition `at` cannot take, given the rule's other conditions.
 * Always empty for a rewrite: rewrites always ran at origin-request, so the
 * restriction is only about the redirects that moved there.
 */
export const unavailableMatchTypes = (
  kind: RuleDraft["kind"],
  matches: readonly MatchCondition[],
  at: number,
): ReadonlySet<MatchCondition["matchType"]> => {
  if (kind !== "redirect") return new Set();
  const others = matches.filter((_, i) => i !== at);
  if (others.some((match) => match.matchType === "country")) {
    return new Set(NOT_BESIDE_COUNTRY);
  }
  if (others.some((match) => NOT_BESIDE_COUNTRY.includes(match.matchType))) {
    return new Set(["country"]);
  }
  return new Set();
};

/**
 * Whether a `country` condition excludes its countries rather than matching
 * them. Stored as `notEquals`, never `negate` — see the country conditional in
 * `shared/redirect-rule.schema.json` for why that is a safety property. A
 * `negate` is still read, because a rule saved before that rule existed has
 * one; the next save rewrites it as `notEquals` (see `cleanMatch`).
 */
export const isExcludingCountries = (match: MatchCondition): boolean =>
  match.matchOperator === "notEquals" || match.negate === true;

/** A blank condition, as both the editor's "add" button and a new draft need one. */
export const emptyMatch = (): MatchCondition => ({
  matchType: "path",
  matchOperator: "equals",
  matchValue: "",
  negate: false,
  caseSensitive: false,
});

/**
 * The editor's working shape, and how it converts to and from a stored rule.
 *
 * A draft is not a `RuleInput`. It holds what a half-filled form holds — a
 * priority that is still empty, an origin kind that is still undecided, a URL the
 * user is deciding how to express — none of which a `RuleInput` can represent.
 * Conversion happens once, on save, in `toRuleInput`.
 *
 * Kept out of the components so the mapping between form and contract is in one
 * readable place, and so the components stay about layout.
 */

/** Priority is a string in the draft: an `<input type="number">` is empty, not 0. */
type PriorityDraft = string;

export interface RedirectDraft {
  kind: "redirect";
  priority: PriorityDraft;
  /**
   * Carried through the editor rather than left to the toggle in the list.
   * `PUT` replaces the whole item, so a draft without it would send an enabled
   * rule back over a disabled one and quietly put it into service.
   */
  disabled: boolean;
  statusCode: 301 | 302;
  redirectURL: string;
  /**
   * UI-only. The schema stores one `redirectURL` string and the edge accepts
   * either form, so this is not a field — it is which form the user is writing,
   * derived from the value on load and used to convert it on toggle.
   */
  relative: boolean;
  /**
   * UI-only, like `relative`, and never sent — `toRuleInput` names every field
   * it writes.
   *
   * The origin the URL had when the toggle was switched on, scheme and port
   * included: `http://www.example.com:8080`. Switching the toggle back off
   * restores it rather than re-deriving `https://<host>`, which would silently
   * drop a scheme or a port the user never touched.
   *
   * Only lives as long as the editor is open. A rule reopened later has no
   * memory of how it was written, and `relative` is derived from the value
   * again — which is correct: a stored path does mean "this host".
   */
  relativeFrom?: string;
  keepQueryString: boolean;
  matches: MatchCondition[];
}

/** `none` means "path only" — a rewrite may change the path without the origin. */
export type OriginKind = "none" | "s3" | "custom";

export interface RewriteDraft {
  kind: "rewrite";
  priority: PriorityDraft;
  /** Same reason as on a redirect: `PUT` replaces, so the flag must round-trip. */
  disabled: boolean;
  originKind: OriginKind;
  s3: S3Draft;
  custom: CustomDraft;
  pathAndQS: string;
  keepQueryString: boolean;
  matches: MatchCondition[];
}

export interface S3Draft {
  authMethod: S3Origin["authMethod"];
  region: string;
  domainName: string;
  path: string;
  /**
   * Not editable in this ticket. Carried through the draft verbatim so a `PUT`
   * — which replaces the whole item — preserves any headers the origin already
   * has instead of overwriting them with an empty object.
   */
  customHeaders: S3Origin["customHeaders"];
}

/**
 * CloudFront's allowed origin SSL protocols, strongest first. SSLv3 is omitted
 * on purpose — too broken to offer in the console. TLSv1.3 is not a valid value
 * for a custom origin's `sslProtocols` in CloudFront.
 */
export const SSL_PROTOCOLS = ["TLSv1.2", "TLSv1.1", "TLSv1"] as const;
export type SslProtocol = (typeof SSL_PROTOCOLS)[number];

export interface CustomDraft {
  domainName: string;
  path: string;
  port: string;
  protocol: CustomOrigin["protocol"];
  readTimeout: string;
  keepaliveTimeout: string;
  /**
   * The stored array itself, carried through verbatim. The dropdown shows the
   * strongest of it (`pickSslProtocol`) for a single-choice feel, but the array
   * stays the source of truth: leaving the field alone round-trips every version
   * the origin allowed, and only an explicit pick narrows it to that one. Free
   * text is gone so a typo cannot reach the edge.
   */
  sslProtocols: CustomOrigin["sslProtocols"];
  /** Same as on S3: not editable here, carried through so a `PUT` keeps them. */
  customHeaders: CustomOrigin["customHeaders"];
}

export type RuleDraft = RedirectDraft | RewriteDraft;

export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 99999;

/** The TCP port range. A custom origin's port must fall inside it. */
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

/** CloudFront's own defaults for a custom origin, so a new one is valid as-is. */
const CUSTOM_DEFAULTS: CustomDraft = {
  domainName: "",
  path: "",
  port: "443",
  protocol: "https-only",
  readTimeout: "30",
  keepaliveTimeout: "5",
  sslProtocols: ["TLSv1.2"],
  customHeaders: {},
};

const isSslProtocol = (value: string): value is SslProtocol =>
  (SSL_PROTOCOLS as readonly string[]).includes(value);

/** The strongest listed protocol — what the single-choice dropdown displays. */
export const pickSslProtocol = (protocols: string[]): SslProtocol => {
  for (const preferred of SSL_PROTOCOLS) {
    if (protocols.includes(preferred)) return preferred;
  }
  return "TLSv1.2";
};

const S3_DEFAULTS: S3Draft = {
  authMethod: "origin-access-identity",
  region: "us-east-1",
  domainName: "",
  path: "",
  customHeaders: {},
};

const ABSOLUTE_URL = /^https?:\/\//i;

/**
 * A target whose first characters are `$1`.
 *
 * Only the *leading* backreference decides the shape of the `Location` the edge
 * builds, and only `$1` at that: where a later group starts inside the pattern
 * is not something this can read, so `$2…` is not treated as knowable.
 */
const LEADING_CAPTURE = /^\$1(?!\d)/;

/**
 * Whether a pattern's first capturing group starts at the beginning of whatever
 * the pattern is tested against: `^(…)`, or an unanchored `(.*`/`(.+`, which
 * starts at index 0 anyway — a leading `.*` absorbs any prefix, so the match
 * never has to begin further in.
 *
 * A non-capturing `(?:` opens no group, so it does not qualify.
 */
const CAPTURES_FROM_START = /^(?:\^\((?!\?)|\(\.[*+])/;

/** Regex mode at the edge: a `regex` operator, or a `regex` match type. */
const isRegexMode = (match: MatchCondition): boolean =>
  match.matchOperator === "regex" || match.matchType === "regex";

/**
 * Whether the condition that fills `$1` takes its capture from the start of the
 * request, which is what makes a target that *begins* with `$1` safe.
 *
 * The edge substitutes from the first regex condition that matches, against the
 * request path for a `path`/`regex` condition and against the whole URL for a
 * pattern that mentions a scheme (`rules-service.ts` `firstRegexCapture`,
 * `lib/get-match-source.ts`). Both of those sources start with something a
 * browser can resolve — `/…` or `https://…` — so a group anchored to their
 * start expands to a `Location` that is still root-relative or absolute.
 *
 * Every other source cannot say that: a group behind a literal (`^/old/(.*)$`
 * captures `shoes`), or a capture off a `hostname`, `header` or `cookie`
 * condition, expands to a bare word.
 */
const capturesFromRequestStart = (matches: MatchCondition[]): boolean => {
  // A negated regex only lets a rule through by *not* matching, so it never
  // supplies the capture. Any of the others may be the one that does — the edge
  // takes the first that matches, which is per-request — so all of them qualify
  // or none does.
  const sources = matches.filter(
    (match) => isRegexMode(match) && match.negate !== true,
  );
  return (
    sources.length > 0 &&
    sources.every(
      (match) =>
        (match.matchType === "path" || match.matchType === "regex") &&
        CAPTURES_FROM_START.test(match.matchValue),
    )
  );
};

/**
 * Whether a regex is free of catastrophic backtracking (ReDoS), via `safe-regex`.
 * An unparseable pattern is treated as safe here — its invalidity is reported
 * separately — so a single value never draws two overlapping errors.
 */
const isSafeRegex = (pattern: string): boolean => {
  try {
    return safeRegex(pattern);
  } catch {
    return true;
  }
};

/**
 * The whole of what a redirect target may be, kept in step with
 * `redirectURL`'s `pattern` in shared/redirect-rule.schema.json — the messages
 * below name the individual reasons, but this is what the API will actually
 * apply, so the form must not accept anything it rejects.
 */
const REDIRECT_TARGET = /^(?:https?:\/\/[^\s]+|\/(?![/\\])[^\s]*)$/i;

export const emptyRedirect = (): RedirectDraft => ({
  kind: "redirect",
  priority: "",
  disabled: false,
  statusCode: 301,
  redirectURL: "",
  relative: false,
  keepQueryString: true,
  matches: [emptyMatch()],
});

export const emptyRewrite = (): RewriteDraft => ({
  kind: "rewrite",
  priority: "",
  disabled: false,
  // New rewrites open on Custom origin so the domain / protocol fields are
  // visible immediately. `none` (path-only, keep the distribution's origin) is
  // one click away in the picker and is what an existing path-only rule loads
  // as; it is just not the blank starting point.
  originKind: "custom",
  s3: S3_DEFAULTS,
  custom: CUSTOM_DEFAULTS,
  pathAndQS: "",
  keepQueryString: true,
  matches: [emptyMatch()],
});

/**
 * Loads a stored rule into the editor.
 *
 * `priority` comes from the sort key, which is the only place it exists — a stored
 * item carries no `priority` field, the server having folded it into `sk`.
 */
export const draftFromRule = (rule: Rule): RuleDraft => {
  const priority = String(priorityOf(rule.sk));
  const disabled = rule.disabled === true;

  if (isRedirect(rule)) {
    return {
      kind: "redirect",
      priority,
      disabled,
      statusCode: rule.statusCode,
      redirectURL: rule.redirectURL,
      relative: !ABSOLUTE_URL.test(rule.redirectURL),
      keepQueryString: rule.useIncomingQueryString === true,
      matches: rule.matches.map((match) => ({ ...match })),
    };
  }

  const forward = narrowForwardSettings(rule);
  const s3 = forward.origin?.s3;
  const custom = forward.origin?.custom;

  return {
    kind: "rewrite",
    priority,
    disabled,
    originKind:
      s3 !== undefined ? "s3" : custom !== undefined ? "custom" : "none",
    // The unused branch keeps its defaults, so switching origin kind in the
    // editor offers a valid form rather than an empty one.
    s3:
      s3 === undefined
        ? S3_DEFAULTS
        : {
            authMethod: s3.authMethod,
            region: s3.region ?? "",
            domainName: s3.domainName,
            path: s3.path,
            customHeaders: s3.customHeaders,
          },
    custom:
      custom === undefined
        ? CUSTOM_DEFAULTS
        : {
            domainName: custom.domainName,
            path: custom.path,
            port: String(custom.port),
            protocol: custom.protocol,
            readTimeout: String(custom.readTimeout),
            keepaliveTimeout: String(custom.keepaliveTimeout),
            sslProtocols: custom.sslProtocols,
            customHeaders: custom.customHeaders,
          },
    pathAndQS: forward.pathAndQS ?? "",
    keepQueryString: forward.useIncomingQueryString === true,
    matches: rule.matches.map((match) => ({ ...match })),
  };
};

/**
 * The scheme and authority of an absolute URL — `https://shop.example.com:8443`.
 * `undefined` for a relative one, which has no origin to remember.
 */
export const originOf = (url: string): string | undefined => {
  const scheme = ABSOLUTE_URL.exec(url)?.[0];
  if (scheme === undefined) return undefined;
  const slash = url.slice(scheme.length).indexOf("/");
  return slash === -1 ? url : url.slice(0, scheme.length + slash);
};

/** The host of an absolute URL, lowercased, without scheme, port or path. */
const hostOf = (url: string): string | undefined =>
  originOf(url)?.replace(ABSOLUTE_URL, "").split(":")[0]?.toLowerCase();

/**
 * Whether the relative toggle expresses the same destination for this value.
 *
 * "Relative" means "a path on whichever host was asked for", so it only says
 * the same thing when the URL already names the rule's own host. Offered for a
 * redirect to somewhere else, it is a retarget wearing the costume of a
 * reformat: `/x` served from www.example.com sends visitors to
 * www.example.com/x, whatever shop.example.com the rule used to name — same
 * status code, same path, different site (CF-33).
 *
 * A relative URL has no host to disagree with, so switching back off is always
 * available.
 */
export const canBeRelative = (url: string, host: string): boolean => {
  const target = hostOf(url);
  return target === undefined || host === "" || target === host.toLowerCase();
};

/**
 * Rewrites a redirect URL between relative and absolute.
 *
 * Turning "relative" on drops the scheme and host; turning it off puts an
 * absolute form back. It beats making the user retype the address to change how
 * it is expressed.
 *
 * `from` is the origin the value had when it was made relative, if the editor
 * still remembers it. Without it the only origin available is `https://<host>`,
 * which is right for a rule stored as a path but would invent `https` and drop
 * a port for one the user only just converted.
 */
export const convertRedirectUrl = (
  url: string,
  toRelative: boolean,
  host: string,
  from?: string,
): string => {
  if (toRelative) {
    if (!ABSOLUTE_URL.test(url)) return url;
    const withoutScheme = url.replace(ABSOLUTE_URL, "");
    const slash = withoutScheme.indexOf("/");
    return slash === -1 ? "/" : withoutScheme.slice(slash);
  }

  if (ABSOLUTE_URL.test(url)) return url;
  const origin = from ?? (host === "" ? undefined : `https://${host}`);
  if (origin === undefined) return url;
  return `${origin}${url.startsWith("/") ? url : `/${url}`}`;
};

/**
 * Validates a draft and returns the same `{ path, message }` shape the API uses
 * for its own failures, so one error list renders both.
 *
 * This is not the authority. The API validates against the shared schemas and
 * owns uniqueness; this catches what a form can catch, before spending a request
 * on it.
 */
export const validateDraft = (
  draft: RuleDraft,
  takenPriorities: number[],
): ValidationDetail[] => {
  const details: ValidationDetail[] = [];

  const priority = Number(draft.priority);
  if (draft.priority.trim() === "") {
    details.push({ path: "/priority", message: "is required" });
  } else if (
    !Number.isInteger(priority) ||
    priority < PRIORITY_MIN ||
    priority > PRIORITY_MAX
  ) {
    details.push({
      path: "/priority",
      message: `must be a whole number between ${PRIORITY_MIN} and ${PRIORITY_MAX}`,
    });
  } else if (takenPriorities.includes(priority)) {
    details.push({
      path: "/priority",
      message: "is already used by another rule of this type on this host",
    });
  }

  draft.matches.forEach((match, at) => {
    if (match.matchValue.trim() === "") {
      details.push({
        path: `/matches/${at}/matchValue`,
        message:
          match.matchType === "country"
            ? "needs at least one country"
            : "is required",
      });
    }
    // Only the format, never membership of the picker's list. That list is
    // generated from Route 53 and ships with the front, so validating against
    // it would reject a country CloudFront started reporting after the last
    // release. An unrecognised code is warned about in the picker instead —
    // see CountryPicker.
    if (match.matchType === "country") {
      const malformed = parseCountries(match.matchValue).filter(
        (code) => !/^[A-Z]{2}$/.test(code),
      );
      if (malformed.length > 0) {
        details.push({
          path: `/matches/${at}/matchValue`,
          message: `must be two-letter country codes (${malformed.join(", ")} ${malformed.length === 1 ? "is" : "are"} not)`,
        });
      }
    }
    // Reported on the non-country side only, so one conflict is one
    // error rather than one per condition involved.
    if (
      match.matchType !== "country" &&
      unavailableMatchTypes(draft.kind, draft.matches, at).has(match.matchType)
    ) {
      details.push({
        path: `/matches/${at}/matchType`,
        message: `cannot be ${match.matchType} on a redirect that also checks the geographic location`,
      });
    }
    if (
      match.matchType === "header" &&
      (match.headerName ?? "").trim() === ""
    ) {
      details.push({
        path: `/matches/${at}/headerName`,
        message: "is required for a header condition",
      });
    }
    // Either is regex mode at the edge: a `regex` operator, or a `regex` match
    // type. Checking only the operator lets a `matchType: "regex"` with an
    // invalid pattern through to the server.
    if (isRegexMode(match)) {
      let compiles = true;
      try {
        new RegExp(match.matchValue);
      } catch {
        compiles = false;
        details.push({
          path: `/matches/${at}/matchValue`,
          message: "is not a valid regular expression",
        });
      }
      // The edge runs this pattern on every matching request, so a catastrophic
      // one (ReDoS) would hang the edge. Reject it here rather than let it ship —
      // this guards both the importer and the manual editor.
      if (compiles && !isSafeRegex(match.matchValue)) {
        details.push({
          path: `/matches/${at}/matchValue`,
          message:
            "is a potentially catastrophic regular expression (ReDoS) that " +
            "could hang the edge on every request",
        });
      }
    }
  });

  if (draft.kind === "redirect") {
    // The value as it will be sent: `toRuleInput` trims it, so surrounding
    // space is not an error, and checking the untrimmed string would reject a
    // trailing space the save would have dropped anyway.
    //
    // The edge writes this value into `Location` as it stands, so it has to be
    // absolute or root-relative: anything else is resolved against the path the
    // request came in on, and `/a/b/` asking for `a/b/` lands on `/a/b/a/b/`.
    //
    // A reinjected capture is checked on the same terms, not exempted from them.
    // Only a target that *starts* with `$1` has a leading segment the form
    // cannot read, and even then only when the capture is not anchored to the
    // start of the request — a later `$1` sits behind a literal prefix this can
    // check like any other.
    const target = draft.redirectURL.trim();
    if (target === "") {
      details.push({ path: "/redirectURL", message: "is required" });
    } else if (/\s/.test(target)) {
      // Ahead of the capture branch, not after it: whitespace is wrong in every
      // shape this field can take, and a target starting with `$1` was reaching
      // the API with a space in it because that branch short-circuited the chain.
      //
      // Rejected rather than encoded: guessing at which spaces were meant to be
      // %20 and which were a typo is not the form's call, and the value reaches
      // a Location header verbatim.
      details.push({
        path: "/redirectURL",
        message: "cannot contain a space — percent-encode it as %20",
      });
    } else if (LEADING_CAPTURE.test(target)) {
      if (/^\$[1-9][0-9]*\/[/\\]/.test(target)) {
        // `$1//host` is the off-host case wearing a capture: a group that
        // matches nothing substitutes as the empty string — and `(.*)` matches
        // nothing quite happily — leaving `//host`, which the browser resolves
        // against the scheme alone. Refused whatever the condition looks like,
        // because "this group is never empty" is not something either side can
        // promise.
        details.push({
          path: "/redirectURL",
          message:
            "must not continue with // or /\\ after the captured group — an " +
            "empty capture would leave the browser reading that as another host",
        });
      } else if (!capturesFromRequestStart(draft.matches)) {
        details.push({
          path: "/redirectURL",
          message:
            "starts with a captured group that is not taken from the start of " +
            "the request, so the redirect may not begin with / — the browser " +
            "would resolve it against the path it came from, sending /a/b/ to " +
            "/a/b/a/b/. Write the leading path in the target (/$1), or widen " +
            "the condition's group so it captures from the start of the path",
        });
      }
    } else if (draft.relative && !target.startsWith("/")) {
      details.push({
        path: "/redirectURL",
        message: "must start with / when it is a relative URL",
      });
    } else if (draft.relative && /^\/[/\\]/.test(target)) {
      // `//host` and `/\host` read as paths but are not: the browser resolves
      // them against the scheme alone and leaves this host, which is the one
      // thing a "relative" URL is supposed to guarantee it does not do.
      details.push({
        path: "/redirectURL",
        message:
          "must not start with // or /\\ — the browser reads that as another host, not a path on this one",
      });
    } else if (!draft.relative && !ABSOLUTE_URL.test(target)) {
      details.push({
        path: "/redirectURL",
        message: "must start with http:// or https://",
      });
    } else if (!REDIRECT_TARGET.test(target)) {
      // The backstop for whatever the named cases above miss, so the form can
      // never pass the API something its schema refuses: a bare "https://" with
      // no host lands here.
      details.push({
        path: "/redirectURL",
        message:
          "must be a full URL like https://example.com/path, or a path like /path",
      });
    }
    return details;
  }

  // The schema's `anyOf` requires a rewrite to change the origin, the path, or
  // both. Neither is a rule the API accepts and the edge then ignores.
  if (draft.originKind === "none" && draft.pathAndQS.trim() === "") {
    details.push({
      path: "/forwardSettings",
      message: "must change something — pick an origin, set a path, or both",
    });
  }

  if (draft.originKind === "s3") {
    if (draft.s3.domainName.trim() === "") {
      details.push({
        path: "/forwardSettings/origin/s3/domainName",
        message: "is required",
      });
    }
    if (
      draft.s3.authMethod === "origin-access-identity" &&
      draft.s3.region.trim() === ""
    ) {
      details.push({
        path: "/forwardSettings/origin/s3/region",
        message: "is required when the auth method is origin-access-identity",
      });
    }
  }

  if (draft.originKind === "custom") {
    if (draft.custom.domainName.trim() === "") {
      details.push({
        path: "/forwardSettings/origin/custom/domainName",
        message: "is required",
      });
    }
    // Integer-ness is not enough: a 0 or negative port or timeout is a whole
    // number but a meaningless one. Port is bounded to the TCP range; timeouts
    // only need to be positive, the API owning CloudFront's upper limits.
    for (const [field, value, min, max] of [
      ["port", draft.custom.port, PORT_MIN, PORT_MAX],
      ["readTimeout", draft.custom.readTimeout, 1, undefined],
      ["keepaliveTimeout", draft.custom.keepaliveTimeout, 1, undefined],
    ] as const) {
      const parsed = Number(value);
      const valid =
        value.trim() !== "" &&
        Number.isInteger(parsed) &&
        parsed >= min &&
        (max === undefined || parsed <= max);
      if (!valid) {
        details.push({
          path: `/forwardSettings/origin/custom/${field}`,
          message:
            max === undefined
              ? "must be a whole number greater than 0"
              : `must be a whole number between ${min} and ${max}`,
        });
      }
    }
    if (
      draft.custom.sslProtocols.length === 0 ||
      !draft.custom.sslProtocols.every(isSslProtocol)
    ) {
      details.push({
        path: "/forwardSettings/origin/custom/sslProtocols",
        message: "must each be TLSv1.2, TLSv1.1, or TLSv1",
      });
    }
  }

  return details;
};

/**
 * A human label for a validation `path`, so the error list reads "Priority is
 * required" rather than "/priority is required".
 *
 * The messages are written to follow their field, so `label + message` reads as
 * a sentence. Paths this UI does not produce — a server error keyed on
 * something else — fall back to the raw pointer rather than hiding where the
 * problem is.
 */
const FIELD_LABELS: Record<string, string> = {
  "/priority": "Priority",
  "/redirectURL": "Redirect URL",
  "/forwardSettings": "This rewrite",
  "/forwardSettings/origin/s3/domainName": "Bucket domain name",
  "/forwardSettings/origin/s3/region": "Bucket region",
  "/forwardSettings/origin/custom/domainName": "Domain name",
  "/forwardSettings/origin/custom/port": "Port",
  "/forwardSettings/origin/custom/readTimeout": "Read timeout",
  "/forwardSettings/origin/custom/keepaliveTimeout": "Keepalive",
  "/forwardSettings/origin/custom/sslProtocols": "SSL protocols",
};

const MATCH_FIELD_LABELS: Record<string, string> = {
  matchType: "type",
  matchValue: "value",
  headerName: "header name",
};

/**
 * Same as `MATCH_FIELD_LABELS`, for the fields a condition type renames. A
 * country condition has no "value" on screen — it has countries — so an error
 * reading "Condition 1 value needs at least one country" would point at a field
 * the user cannot see.
 */
const MATCH_FIELD_LABELS_BY_TYPE: Record<string, Record<string, string>> = {
  country: { matchValue: "countries" },
};

/**
 * `matches` is the draft's conditions, so a field can be named the way its own
 * condition type shows it. Optional: a server error may name a condition the
 * draft no longer has, and the generic label is still better than a pointer.
 */
export const labelForPath = (
  path: string,
  matches: readonly MatchCondition[] = [],
): string => {
  const known = FIELD_LABELS[path];
  if (known !== undefined) return known;

  // `/matches/0/matchValue` → "Condition 1 value" — 1-based, since the number
  // is for the user, not the array index.
  const inMatch = /^\/matches\/(\d+)\/(\w+)$/.exec(path);
  if (inMatch !== null) {
    const [, index, field] = inMatch;
    const at = Number(index);
    const matchType = matches[at]?.matchType ?? "";
    const label =
      MATCH_FIELD_LABELS_BY_TYPE[matchType]?.[field] ??
      MATCH_FIELD_LABELS[field] ??
      field;
    return `Condition ${at + 1} ${label}`;
  }

  return path;
};

/**
 * Turns a validated draft into the body the API expects.
 *
 * Two things this deliberately does not send: `pk` and `sk`. The server takes the
 * host from the path and derives the sort key from `type` and `priority`, and a
 * supplied key that disagrees with either is a 400 — so omitting them is both
 * simpler and the only form that is always correct, including on a move.
 *
 * `customHeaders` is not edited here, but it is round-tripped: `draftFromRule`
 * reads the stored headers into the draft and this sends them back unchanged.
 * A `PUT` replaces the whole item, so sending `{}` instead would drop any
 * headers an origin already has — an auth header to its backend, say — on an
 * edit as innocent as a priority change. A new origin defaults to `{}`, the
 * valid "none".
 */
export const toRuleInput = (draft: RuleDraft): RuleInput => {
  const priority = Number(draft.priority);
  const matches = draft.matches.map(cleanMatch);
  // Sent only when set. An enabled rule carries no flag in the table, and the
  // schema makes it optional, so `false` would add a field the edge reads as
  // the default it already assumes.
  const disabled = draft.disabled ? { disabled: true } : {};

  if (draft.kind === "redirect") {
    return {
      type: "erMatchRule",
      priority,
      statusCode: draft.statusCode,
      redirectURL: draft.redirectURL.trim(),
      useIncomingQueryString: draft.keepQueryString,
      matches,
      ...disabled,
    };
  }

  const origin =
    draft.originKind === "s3"
      ? {
          s3: {
            authMethod: draft.s3.authMethod,
            domainName: draft.s3.domainName.trim(),
            path: draft.s3.path.trim(),
            customHeaders: draft.s3.customHeaders,
            // Present only for origin-access-identity: the schema's if/then/else
            // requires it there and forbids it for `none`.
            ...(draft.s3.authMethod === "origin-access-identity"
              ? { region: draft.s3.region.trim() }
              : {}),
          },
        }
      : draft.originKind === "custom"
        ? {
            custom: {
              domainName: draft.custom.domainName.trim(),
              path: draft.custom.path.trim(),
              port: Number(draft.custom.port),
              protocol: draft.custom.protocol,
              readTimeout: Number(draft.custom.readTimeout),
              keepaliveTimeout: Number(draft.custom.keepaliveTimeout),
              sslProtocols: draft.custom.sslProtocols,
              customHeaders: draft.custom.customHeaders,
            },
          }
        : undefined;

  const pathAndQS = draft.pathAndQS.trim();

  return {
    type: "frMatchRule",
    priority,
    matches,
    ...disabled,
    forwardSettings: {
      ...(origin === undefined ? {} : { origin }),
      // Omitted rather than sent empty: an empty `pathAndQS` means "keep the
      // incoming path", and the edge treats an absent one differently from a
      // present empty string when deciding about the query string.
      ...(pathAndQS === "" ? {} : { pathAndQS }),
      useIncomingQueryString: draft.keepQueryString,
    },
  } as RuleInput;
};

/**
 * Drops the fields the schema rejects rather than sending them falsy.
 *
 * `headerName` is forbidden unless the type is `header`, and the schemas are
 * `additionalProperties: false`, so an `undefined` left on the object would be
 * serialised away by `JSON.stringify` — but a `""` would not, and that is a 400.
 */
const cleanMatch = (match: MatchCondition): MatchCondition => {
  if (match.matchType === "country") {
    return {
      matchType: "country",
      // Derived rather than carried over: the editor hides the operator, so
      // whatever the condition held before the type was switched would be a
      // 400. `negate` is always false — an exclusion is `notEquals`.
      matchOperator: isExcludingCountries(match) ? "notEquals" : "equals",
      matchValue: formatCountries(parseCountries(match.matchValue)),
      negate: false,
      // Meaningless on two uppercase letters, and the editor offers no way to
      // set it. Sent as false rather than dropped because the schema has no
      // conditional forbidding it, and a rule that once had it set should not
      // keep a flag the UI cannot show.
      caseSensitive: false,
    };
  }

  const base: MatchCondition = {
    matchType: match.matchType,
    matchOperator: match.matchOperator,
    matchValue: match.matchValue.trim(),
    negate: match.negate === true,
    caseSensitive: match.caseSensitive === true,
  };

  return match.matchType === "header"
    ? { ...base, headerName: (match.headerName ?? "").trim() }
    : base;
};
