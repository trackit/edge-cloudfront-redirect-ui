import { isRedirect, narrowForwardSettings, priorityOf } from "./api";
import type {
  CustomOrigin,
  MatchCondition,
  Rule,
  RuleInput,
  S3Origin,
  ValidationDetail,
} from "./api";
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
  // visible immediately. `none` (path-only, keep the distribution's origin)
  // remains valid for existing rules and for validation, but is no longer the
  // blank starting point now that that card was removed from the picker.
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
 * Rewrites a redirect URL between relative and absolute.
 *
 * Turning "relative" on drops the scheme and host; turning it off puts the
 * current host back. Possible only because the console knows the host — it is the
 * rule's partition key — and it beats making the user retype the address to change
 * how it is expressed.
 */
export const convertRedirectUrl = (
  url: string,
  toRelative: boolean,
  host: string,
): string => {
  if (toRelative) {
    if (!ABSOLUTE_URL.test(url)) return url;
    const withoutScheme = url.replace(ABSOLUTE_URL, "");
    const slash = withoutScheme.indexOf("/");
    return slash === -1 ? "/" : withoutScheme.slice(slash);
  }

  if (ABSOLUTE_URL.test(url) || host === "") return url;
  return `https://${host}${url.startsWith("/") ? url : `/${url}`}`;
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
        message: "is required",
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
    if (match.matchOperator === "regex") {
      try {
        new RegExp(match.matchValue);
      } catch {
        details.push({
          path: `/matches/${at}/matchValue`,
          message: "is not a valid regular expression",
        });
      }
    }
  });

  if (draft.kind === "redirect") {
    if (draft.redirectURL.trim() === "") {
      details.push({ path: "/redirectURL", message: "is required" });
    } else if (draft.relative && !draft.redirectURL.startsWith("/")) {
      details.push({
        path: "/redirectURL",
        message: "must start with / when it is a relative URL",
      });
    } else if (!draft.relative && !ABSOLUTE_URL.test(draft.redirectURL)) {
      details.push({
        path: "/redirectURL",
        message: "must start with http:// or https://",
      });
    }
    return details;
  }

  // The schema's `anyOf` requires a rewrite to change the origin, the path, or
  // both. Neither is a rule the API accepts and the edge then ignores.
  if (draft.originKind === "none" && draft.pathAndQS.trim() === "") {
    details.push({
      path: "/forwardSettings",
      message:
        "a rewrite must change something — pick an origin, set a path, or both",
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
    for (const [field, value] of [
      ["port", draft.custom.port],
      ["readTimeout", draft.custom.readTimeout],
      ["keepaliveTimeout", draft.custom.keepaliveTimeout],
    ] as const) {
      if (!Number.isInteger(Number(value)) || value.trim() === "") {
        details.push({
          path: `/forwardSettings/origin/custom/${field}`,
          message: "must be a whole number",
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
