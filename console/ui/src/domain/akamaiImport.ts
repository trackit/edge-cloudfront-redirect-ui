import Papa from "papaparse";
import { hostKey } from "./hostRoutes";
import {
  emptyMatch,
  emptyRedirect,
  toRuleInput,
  validateDraft,
  type RedirectDraft,
} from "./ruleDraft";
import type { MatchCondition, RuleInput, ValidationDetail } from "../api";

/**
 * Turns an Akamai Edge Redirector export into rules for a distribution.
 *
 * Edge Redirector is a redirect product, so every source row maps to a
 * `RedirectDraft` (`erMatchRule`). This module is the only place that knows the
 * source formats; it borrows `ruleDraft`'s draft shape, `validateDraft` (the sole
 * authority on whether a row can be imported) and `toRuleInput` (the API body),
 * so the mapping and the contract never drift apart.
 *
 * ## How to read this file
 *
 * `parseExport` is the only entry point, and the file is laid out in the order it
 * runs, so every reference points backwards — nothing is used before it is
 * defined. To follow one rule through, or to put a breakpoint where it went
 * wrong, work down the steps:
 *
 *  - **Step 1 — Reading raw text.** Format-agnostic primitives: CSV rows and
 *    columns (`parseCsv`, `cell`), safe JSON (`parseJson`, `asRecord`). Nothing
 *    here knows what a redirect is.
 *  - **Step 2 — Which format is this?** `detectFormat` picks one of four, or
 *    refuses. `policyIndexNote` catches the file that parses but holds no rules.
 *  - **Step 3 — Translating one rule, piece by piece.** Four independent
 *    concerns, each with the warnings it raises: the match condition (3a), the
 *    redirect target (3b), the status code (3c), the host it lands on (3d). A
 *    mistranslated value almost always comes from here.
 *  - **Step 4 — Assembling one rule, per format.** The row-per-rule CSVs go
 *    through `mapFlatCsv`; the JSON export and the flattened policy CSV both go
 *    through `mapMatchRule`. Either way the output is a `Candidate`.
 *  - **Step 5 — Building the preview.** `parseExport` applies the size limits,
 *    assigns provisional priorities, checks shadowing, runs `validateDraft`, and
 *    tags each row ok / warning / skipped. A row's *status* is decided here, not
 *    in steps 3 or 4.
 *
 * ## Rules the whole file obeys
 *
 *  - One bad row never fails the batch. Every row is parsed under its own guard;
 *    a throw becomes a skipped row with a reason, not a dead import.
 *  - Format detection is by file extension first, content shape second — never a
 *    silent fall back to CSV.
 *  - A warning means "imported, but something was lost". A *drop* means refused:
 *    dropping a condition from an AND widens a rule, so it is never a caveat.
 *
 * A rule lands on the target host by default, but a rule that carries its own
 * `hostname` condition is routed to *that* host instead — the condition names the
 * partition, so it becomes the host and drops out of the match list. That is why
 * a preview can span several hosts from one file.
 *
 * Priorities are not assigned here. They are per host and only knowable against
 * that host's current rules, so the importer assigns them at write time; the
 * provisional value in step 5 exists solely to satisfy `validateDraft`.
 */

// ===========================================================================
// Types — the contract, i.e. what comes out of `parseExport`
// ===========================================================================

export type SourceFormat =
  | "edge-redirector-csv"
  | "edge-redirector-policy-csv"
  | "simple-csv"
  | "match-rules-json";

/**
 * `ok` imports cleanly, `warning` imports but lost something in translation,
 * `skipped` cannot be imported (it failed `validateDraft`, or the source used a
 * construct this model cannot represent).
 */
export type RowStatus = "ok" | "warning" | "skipped";

export interface ParsedRow {
  /** 1-based position in the source, for the preview — data rows, not the header. */
  index: number;
  /** A human label: the rule's name, or `"source → target"`. */
  label: string;
  /** The host this rule imports into: the target, or its own hostname condition. */
  host: string;
  status: RowStatus;
  /** What the mapping had to drop, or noted, without preventing the import. */
  messages: string[];
  /**
   * Why the row cannot be imported at all: a source construct this model has no
   * faithful equivalent for. Separate from `messages` because dropping a
   * condition from an AND *widens* a rule — the import would silently apply to
   * more traffic than the source did — so it is a refusal, not a caveat.
   */
  blocked: string[];
  draft: RedirectDraft;
  /** The API body — present only when the row is importable (status !== "skipped"). */
  input?: RuleInput;
  /** `validateDraft`'s findings — non-empty is what makes a row skipped. */
  validation: ValidationDetail[];
}

export interface ImportPreview {
  format: SourceFormat | "unrecognized";
  rows: ParsedRow[];
  summary: { ready: number; warnings: number; skipped: number; hosts: number };
  /** Set when the format is unrecognized or the whole file failed to parse. */
  error?: string;
}

interface ParseOptions {
  filename?: string;
  /** The host a rule imports into unless it names its own via a hostname match. */
  defaultHost: string;
}

/**
 * One source rule, mapped and tagged with the host it belongs to — the handoff
 * from step 4 to step 5. Not exported: a `Candidate` has no status yet.
 */
interface Candidate {
  label: string;
  host: string;
  draft: RedirectDraft;
  messages: string[];
  /** Untranslatable source constructs — non-empty refuses the row. See `ParsedRow.blocked`. */
  drops?: string[];
}

// ===========================================================================
// Step 1 — Reading raw text
//
// Turning bytes into rows/columns or into plain objects. Nothing in this section
// knows what a redirect is; it is all reused by both detection (step 2) and the
// per-format mappers (step 4).
// ===========================================================================

/**
 * CSV rows via PapaParse (RFC 4180): double-quoted fields may hold commas,
 * newlines and doubled `""` quotes — the shapes an Edge Redirector export puts in
 * `matchURL` / `redirectURL`. `skipEmptyLines: "greedy"` drops blank lines so a
 * trailing newline or a gap never becomes a skipped preview row.
 */
const parseCsv = (text: string): string[][] =>
  Papa.parse<string[]>(text, { delimiter: ",", skipEmptyLines: "greedy" }).data;

/**
 * Lowercased-name → column index, for reading fields by header.
 *
 * The first occurrence of a name wins, so an export carrying both `statusCode`
 * and `StatusCode` reads the leftmost rather than silently preferring the last.
 */
const headerIndex = (header: string[]): Map<string, number> => {
  const index = new Map<string, number>();
  header.forEach((name, at) => {
    const key = name.trim().toLowerCase();
    if (!index.has(key)) index.set(key, at);
  });
  return index;
};

/** One trimmed cell, or `""` when the column is absent from this export. */
const cell = (row: string[], at: number | undefined): string =>
  at === undefined ? "" : (row[at] ?? "").trim();

/** Tolerant boolean for CSV cells: `true` / `1` / `yes` / `y` / `on` → true. */
const parseCsvBool = (raw: string): boolean => {
  const value = raw.trim().toLowerCase();
  return (
    value === "true" ||
    value === "1" ||
    value === "yes" ||
    value === "y" ||
    value === "on"
  );
};

/**
 * `JSON.parse` that reports failure as `null` rather than throwing. Conflating
 * "not JSON" with the literal `null` is harmless here: every caller goes on to
 * ask `matchRulesArray`, which rejects both.
 */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The rule array inside a matchRules document, however it is wrapped. */
const matchRulesArray = (parsed: unknown): unknown[] | null => {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.rules)) return obj.rules;
    if (Array.isArray(obj.matchRules)) return obj.matchRules;
  }
  return null;
};

/**
 * Narrowing for JSON of unknown shape: an absent or non-object value reads as an
 * empty record, so a caller can keep dotting into it without a guard per field.
 * The importer salvages what it can from a malformed rule rather than rejecting
 * the file, which is why these are tolerant rather than validating.
 */
const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

// ===========================================================================
// Step 2 — Which format is this?
//
// Four supported shapes, or `"unrecognized"`. Also where a file that parses but
// carries no rules at all is caught, so the user gets one clear note instead of
// a failure per rule.
// ===========================================================================

const extensionOf = (filename?: string): string => {
  if (filename === undefined) return "";
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
};

/** True when the text parses as JSON in one of the matchRules wrapper shapes. */
const looksLikeMatchRules = (text: string): boolean =>
  matchRulesArray(parseJson(text)) !== null;

/** Header-driven CSV detection — the three supported shapes, or unrecognized. */
const detectCsv = (text: string): SourceFormat | "unrecognized" => {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) return "unrecognized";
  const names = new Set(header.map((cell) => cell.trim().toLowerCase()));
  if (
    names.has("rulename") &&
    names.has("matchurl") &&
    names.has("redirecturl")
  ) {
    return "edge-redirector-csv";
  }
  // The flattened policy export: a redirect column plus per-row match criteria.
  // Distinct from the header above, which carries `matchurl` rather than these.
  if (
    names.has("redirecturl") &&
    names.has("matchtype") &&
    names.has("matchvalue")
  ) {
    return "edge-redirector-policy-csv";
  }
  if (names.has("source") && names.has("target")) return "simple-csv";
  return "unrecognized";
};

/**
 * Extension first, content second, never a silent CSV fallback.
 *
 * `.json` must actually be a matchRules document; `.csv`/`.txt` must carry a
 * header we know. With no extension (a paste) we sniff: a leading `{`/`[` is the
 * JSON branch, anything else the CSV branch — and either can still come back
 * unrecognized.
 */
export function detectFormat(input: {
  filename?: string;
  text: string;
}): SourceFormat | "unrecognized" {
  const ext = extensionOf(input.filename);
  const trimmed = input.text.trim();

  // `.json` takes the JSON branch on its extension alone; `.csv`/`.txt` take the
  // CSV one. Any other extension, or none, sniffs the first character.
  const isJson =
    ext === "json" || (ext !== "csv" && ext !== "txt" && /^[{[]/.test(trimmed));

  if (isJson) {
    return looksLikeMatchRules(trimmed) ? "match-rules-json" : "unrecognized";
  }
  return detectCsv(input.text);
}

/**
 * A policy *index* — the catalogue of policies (`policyId` + `ruleCount`, no
 * rules) — parses as a JSON array but carries nothing to import. Recognising it
 * lets the user see one clear "wrong file" note instead of a "Missing
 * redirectURL" per policy. Returns the note, or null when it is not an index.
 *
 * The test is strict so real rules are never mistaken for an index: every entry
 * must identify a policy (`policyId` / `ruleCount`) and carry no rule content
 * (`rule` / `matches` / `redirectURL` / `matchURL` / `type`).
 */
const policyIndexNote = (text: string): string | null => {
  const list = matchRulesArray(parseJson(text));
  if (list === null || list.length === 0) return null;

  const isIndexEntry = (value: unknown): boolean => {
    const entry = asRecord(value);
    const identifies = ["policyId", "ruleCount"].some((key) => key in entry);
    const carriesRule = [
      "rule",
      "matches",
      "redirectURL",
      "matchURL",
      "type",
    ].some((key) => key in entry);
    return identifies && !carriesRule;
  };
  if (!list.every(isIndexEntry)) return null;

  const policies = list.length;
  const totalRules = list.reduce<number>((sum, value) => {
    const count = asRecord(value).ruleCount;
    return sum + (typeof count === "number" ? count : 0);
  }, 0);

  return (
    `This is a policy index — it lists ${policies} ` +
    `${policies === 1 ? "policy" : "policies"}` +
    (totalRules > 0 ? ` (~${totalRules} rules total)` : "") +
    ` but contains no rules. Export the rules (matchRules) of each policy and ` +
    `import those instead.`
  );
};

// ===========================================================================
// Step 3 — Translating one rule, piece by piece
//
// Four independent concerns, in the order a rule is built up: the match
// condition (3a), the redirect target (3b), the status code (3c), and the host
// the rule lands on (3d). Each sub-section also holds the warnings it raises, so
// a message in the preview is traceable to the decision that produced it.
//
// Everything here returns `{ messages, drops }` alongside its value: `messages`
// is "imported, but lossy", `drops` is "refused". Step 4 collects them; step 5
// turns them into a row status.
// ===========================================================================

// --- 3a. The match condition --------------------------------------------------

/** Absolute vs relative redirect URL — the same test `ruleDraft` uses on load. */
const ABSOLUTE_URL = /^https?:\/\//i;

/**
 * Escapes a glob so only `*` stays special, then anchors it.
 *
 * `*` becomes a *capturing* group so an Akamai redirect target that reinjects the
 * piece it matched (`\1`, `\2` …) has something to reinject. A capturing group
 * matches exactly what `.*` matched, so this never changes *what* a rule matches
 * — it only makes the captured pieces available.
 *
 * The escape class is the one `checkAkamaiVariant` uses at the edge, character
 * for character, and for the same reason: `?` is a literal in an Akamai match
 * value, not a single-character wildcard. Treating it as one here would make the
 * same value mean two different things depending on whether the import rewrote
 * it, and would spend the `$1` slot on the `?` itself.
 * See `infra/lambda/src/lib/check-akamai-variant.ts`.
 */
const wildcardToRegex = (glob: string): string => {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped.replace(/\*/g, "(.*)")}$`;
};

/**
 * The Akamai operators we can state in our model. An empty string counts: an
 * export routinely omits `matchOperator`, and that means `equals`.
 */
const KNOWN_OPERATORS = new Set(["", "equals", "contains", "regex", "matches"]);

/**
 * How a raw Akamai match value becomes our operator + value — the single
 * decision the importer makes about match syntax.
 *
 * Our edge already speaks Akamai for `contains` / `equals`: at runtime it splits
 * a value on spaces into alternatives and expands `*` within each — and only `*`
 * — (contains unanchored, equals anchored, see `checkAkamaiVariant`). So values
 * are passed through VERBATIM and the runtime does the work; there is no growing
 * list of glob/space/operator quirks to translate here.
 *
 * The one thing native matching cannot do is feed a captured group back into the
 * redirect. So when — and only when — a rule's target reinjects a capture
 * (`$1` …), a wildcard value is rewritten into a *capturing* regex for that rule.
 */
const resolveMatchValue = (
  value: string,
  operator: string,
  captureMode: boolean,
): {
  matchOperator: MatchCondition["matchOperator"];
  matchValue: string;
  messages: string[];
  drops: string[];
} => {
  // An operator we have no equivalent for is refused, not approximated. Akamai
  // has several (`exists`, `does_not_exist`, …) and folding them onto `equals`
  // would quietly turn "the header is present" into "the header is exactly this"
  // — a different rule that still looks imported.
  if (!KNOWN_OPERATORS.has(operator)) {
    return {
      matchOperator: "equals",
      matchValue: value,
      messages: [],
      drops: [`match operator "${operator}" cannot be translated`],
    };
  }

  // Already a regular expression (by operator, or a forced `regex` type) — never
  // translate it, or its `.*` / `?` would be mistaken for glob wildcards.
  if (operator === "regex" || operator === "matches") {
    return {
      matchOperator: "regex",
      matchValue: value,
      messages: [],
      drops: [],
    };
  }

  if (captureMode && value.includes("*")) {
    const messages = [
      "wildcard translated to a capturing regular expression to feed the redirect",
    ];
    if (value.includes(" ")) {
      messages.push(
        "match had space-separated alternatives a single capturing regex can't " +
          "represent — verify the result",
      );
    }
    return {
      matchOperator: "regex",
      matchValue: wildcardToRegex(value),
      messages,
      drops: [],
    };
  }

  return {
    matchOperator: operator === "contains" ? "contains" : "equals",
    matchValue: value,
    messages: [],
    drops: [],
  };
};

/**
 * A match URL / source path → one path `MatchCondition`.
 *
 * An absolute URL is reduced to its path (our single condition cannot AND a
 * hostname and a path from one column); a `*`/`?` wildcard becomes an anchored
 * regex. Both are lossy, so both add a warning.
 */
const mapMatchUrl = (
  raw: string,
  captureMode: boolean,
): { match: MatchCondition; messages: string[]; drops: string[] } => {
  const messages: string[] = [];
  let value = raw.trim();

  if (ABSOLUTE_URL.test(value)) {
    const withoutScheme = value.replace(ABSOLUTE_URL, "");
    const slash = withoutScheme.indexOf("/");
    value = slash === -1 ? "/" : withoutScheme.slice(slash);
    messages.push(
      "match URL was absolute — host and scheme dropped, matched on path only",
    );
  }

  const match = emptyMatch();
  match.matchType = "path";
  // A matchURL / source is an anchored path pattern → `equals` (the edge anchors
  // it and expands any `*` itself).
  const resolved = resolveMatchValue(value, "equals", captureMode);
  match.matchOperator = resolved.matchOperator;
  match.matchValue = resolved.matchValue;
  messages.push(...resolved.messages);
  return { match, messages, drops: resolved.drops };
};

/**
 * Whether a path condition is true of every request, so it constrains nothing.
 *
 * Akamai exports use one as a deliberate idiom: `path contains "/ /*"` reads like
 * a filter but is not one. The edge splits a value on spaces into alternatives
 * (any may match) and expands `*` within each, so that value asks "does the path
 * contain `/`, or contain anything at all" — true for every request. The real
 * filter then lives in another condition, usually a regex.
 *
 * Recognising it matters twice: such a rule wins for every request (see the
 * shadowing check in step 5), and whatever the preview leads with should not be
 * this.
 *
 * Only the plain operators are read. A regex that happens to match everything is
 * not worth guessing at, and a negated condition is the opposite case anyway.
 */
export const isVacuousMatch = (match: MatchCondition): boolean => {
  if (match.negate === true) return false;
  if (match.matchType !== "path" && match.matchType !== "regex") return false;
  if (match.matchOperator === "regex") return false;

  return match.matchValue
    .split(" ")
    .filter((variant) => variant.length > 0)
    .some((variant) => {
      const literal = variant.replace(/\*/g, "");
      // `contains ""`/`contains "/"` hold for any path, and so does an anchored
      // `equals` once the wildcards are what carry the rest.
      return literal === "" || literal === "/";
    });
};

/** True when nothing about a rule's conditions can keep a request out. */
const matchesEveryRequest = (matches: MatchCondition[]): boolean =>
  matches.length === 0 || matches.every(isVacuousMatch);

// --- 3b. The redirect target --------------------------------------------------

/** Akamai reinjects captured groups as `\1 \2 …`; our edge substitutes `$1 $2 …`. */
const toEdgeBackrefs = (url: string): string =>
  url.replace(/\\([1-9]\d*)/g, (_, n: string) => `$${n}`);

/** True when a redirect target reinjects a capture (`$1` …). */
const usesCapture = (url: string): boolean => /\$[1-9]\d*/.test(url);

/** True when a condition is a regex that actually captures a group. */
const capturesAGroup = (match: MatchCondition): boolean =>
  match.matchOperator === "regex" && /\((?!\?)/.test(match.matchValue);

/**
 * Warns when a target reinjects a capture no condition provides.
 *
 * `$1` with nothing to fill it resolves to an empty string at the edge, so the
 * redirect silently drops the part of the path it was supposed to carry over.
 * Shared by every format: the target is rewritten to `$1` form in one place, so
 * the check belongs in one place too.
 */
const captureWarnings = (draft: RedirectDraft): string[] =>
  usesCapture(draft.redirectURL) && !draft.matches.some(capturesAGroup)
    ? [
        "redirect target reinjects a captured group ($1 …) but no condition " +
          "captures one — it may resolve to an empty string",
      ]
    : [];

/**
 * Builds a redirect draft from a target URL, status and conditions.
 *
 * Akamai backreferences in the target are rewritten to the edge's `$1` form
 * here, so every format that produces a redirect gets the same treatment and the
 * `relative` flag is derived from the rewritten value.
 */
const redirectDraft = (
  redirectURL: string,
  statusCode: 301 | 302,
  matches: MatchCondition[],
): RedirectDraft => {
  const draft = emptyRedirect();
  draft.redirectURL = toEdgeBackrefs(redirectURL);
  draft.relative = !ABSOLUTE_URL.test(draft.redirectURL);
  draft.statusCode = statusCode;
  draft.matches = matches;
  // Akamai drops the incoming query string unless the rule opts in, so an import
  // has to start from `false` — `emptyRedirect()` starts from `true`, which is the
  // convenient default for someone typing a rule by hand, not the source's.
  // A rule that states the flag overrides this in step 4.
  draft.keepQueryString = false;
  return draft;
};

// --- 3c. The status code ------------------------------------------------------

/**
 * What each source status code becomes, and what that costs.
 *
 * The model stores 301 or 302, so 307/308 have to be mapped — but onto their
 * real equivalents, by permanence: 308 is the permanent one, 307 the temporary
 * one. Both also guarantee the HTTP method survives the redirect, which 301/302
 * do not, so the mapping is stated rather than silent.
 *
 * An absent code goes to 302 and not 301. A wrong 302 is retried on the next
 * request; a wrong 301 is cached by the browser, often for good, so it outlives
 * the fix. Guessing has to lean towards the recoverable side.
 */
const STATUS_MAP: Record<string, { statusCode: 301 | 302; note?: string }> = {
  "": {
    statusCode: 302,
    note: "no status code in the source, defaulted to 302 (temporary)",
  },
  "301": { statusCode: 301 },
  "302": { statusCode: 302 },
  "307": {
    statusCode: 302,
    note: "307 mapped to 302 — same permanence, but the HTTP method is no longer preserved",
  },
  "308": {
    statusCode: 301,
    note: "308 mapped to 301 — same permanence, but the HTTP method is no longer preserved",
  },
  "303": {
    statusCode: 302,
    note: "303 mapped to 302 — close, but 303 also forces the follow-up to be a GET",
  },
};

/**
 * Status column → 301/302. Accepts string or number.
 *
 * A code with no equivalent at all is refused (`drops`) rather than guessed: a
 * rule whose redirect semantics we invented is worse than a rule the user has to
 * redo by hand knowingly.
 */
const mapStatus = (
  raw: string | number | undefined,
): { statusCode: 301 | 302; messages: string[]; drops: string[] } => {
  const trimmed = String(raw ?? "").trim();
  const mapped = STATUS_MAP[trimmed];
  if (mapped === undefined) {
    return {
      statusCode: 302,
      messages: [],
      drops: [`status code ${trimmed} has no 301/302 equivalent`],
    };
  }
  return {
    statusCode: mapped.statusCode,
    messages: mapped.note === undefined ? [] : [mapped.note],
    drops: [],
  };
};

// --- 3d. Which host the rule lands on -----------------------------------------

/**
 * Whether a hostname value can be a partition key a request will ever match.
 *
 * An Akamai hostname condition is a *match*: it may hold a `*` or several
 * space-separated alternatives. A partition key is a literal — the edge looks up
 * the host the viewer sent — so turning `*.example.com` into one would store the
 * rule under a name no request ever carries: present in the console, invisible to
 * traffic. `console/api/src/lib/validate-host.ts` is the authority on the shape;
 * this mirrors its `LABEL` so the importer refuses the same values the API would.
 */
const ROUTABLE_HOST =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** What a positive `hostname equals` condition means for where the rule lands. */
type HostRouting =
  /** It names one addressable host: that becomes the partition. */
  | { kind: "route"; host: string }
  /** It is a match, not a name: it stays a condition, with its limit stated. */
  | { kind: "keep"; note: string }
  /** Not a routing candidate — negated, fuzzy, or another match type. */
  | null;

/**
 * A positive `hostname equals` condition names the partition, so it routes —
 * but only when it names a single addressable host. Anything else stays a
 * condition, which the edge evaluates correctly, globs and alternatives included.
 */
const hostRoute = (
  entry: Record<string, unknown>,
  type: string,
): HostRouting => {
  if (type !== "hostname" || entry.negate === true) return null;
  const operator = str(entry.matchOperator).toLowerCase();
  if (operator !== "" && operator !== "equals") return null;
  // Lowercased here, not just at the API: the raw value is what groups the batch
  // by host at write time, so two spellings would otherwise read the same
  // partition twice and hand out the same priorities.
  const value = hostKey(str(entry.matchValue).trim());
  if (value === "") return null;
  if (ROUTABLE_HOST.test(value)) return { kind: "route", host: value };
  return {
    kind: "keep",
    note:
      `hostname "${value}" is a pattern, not a single host — kept as a ` +
      `condition, so the rule only applies to traffic on the target host`,
  };
};

/**
 * Mirrors `isFullUrlRegex` at the edge: a pattern that mentions a scheme or `://`
 * is tested against the whole URL, host included, rather than against the path.
 * See `infra/lambda/src/lib/is-full-url-regex.ts`.
 */
const isFullUrlRegex = (pattern: string): boolean =>
  /^\^?https?/.test(pattern) || pattern.includes("://");

/**
 * The host guard inside a full-URL pattern — everything between `://` and the
 * next `/` — read once, as both things a warning needs: `test` to check the host
 * the rule is landing on, and `named` to say which host it should land on
 * instead.
 *
 * `named` drops optional groups (`(www\.)?shop.example.com` names
 * `shop.example.com`) and escapes, then insists the result looks like a single
 * host — naming the wrong one would be worse than naming none, so a pattern over
 * several hosts leaves it null and the warning stays generic.
 *
 * Null overall means no opinion: no host part, or a body that is not a valid
 * regex. A warning nobody can act on is worse than no warning, so this gives up
 * rather than guesses.
 */
const hostGuardOf = (
  pattern: string,
): { test: RegExp; named: string | null } | null => {
  const scheme = pattern.indexOf("://");
  if (scheme === -1) return null;
  const rest = pattern.slice(scheme + 3);
  const slash = rest.indexOf("/");
  const body = slash === -1 ? rest : rest.slice(0, slash);
  if (body === "") return null;

  let test: RegExp;
  try {
    test = new RegExp(`^${body}$`, "i");
  } catch {
    return null;
  }
  const plain = body.replace(/\([^()]*\)\?/g, "").replace(/\\/g, "");
  return { test, named: ROUTABLE_HOST.test(plain) ? plain : null };
};

/**
 * Warns when a rule guards on a host inside a regex rather than with a
 * `hostname` condition, and that host is not the one the rule is landing on.
 *
 * Rules are stored per host and only consulted for requests to that host, while a
 * full-URL regex is tested against the URL the viewer asked for. So a rule
 * demanding `shop.example.com` that sits under `www.example.com` needs two things
 * that can never both be true: it imports cleanly, reads as ok, and never fires.
 *
 * Only a `hostname` condition can route, because it names one partition. A regex
 * may describe a *pattern* of hosts, so the importer will not route on it — it
 * says which host to pick instead.
 */
const foreignHostWarnings = (
  matches: MatchCondition[],
  host: string,
): string[] =>
  matches.flatMap((match) => {
    if (match.matchOperator !== "regex" || !isFullUrlRegex(match.matchValue)) {
      return [];
    }
    const guard = hostGuardOf(match.matchValue);
    if (guard === null || guard.test.test(host)) return [];

    const named = guard.named;
    return [
      named === null
        ? `this rule only fires on requests to the host its regex names, not ` +
          `on ${host}, because the regex compares the whole URL. Import it ` +
          `with that host selected as the target.`
        : `this rule only fires on requests to ${named}, not on ${host}, ` +
          `because its regex compares the whole URL. Select ${named} as the ` +
          `target host to import it.`,
    ];
  });

// ===========================================================================
// Step 4 — Assembling one rule, per format
//
// Two paths, both producing `Candidate[]`:
//  - `mapFlatCsv` for the CSVs that carry one rule per row (4a);
//  - `mapMatchRule` for a rule with a `matches[]` array — the JSON export, and
//    the flattened policy CSV once its rows are regrouped (4b).
//
// Anything shared between the two paths belongs in step 3, not here. That is
// what stops the formats from drifting apart.
// ===========================================================================

// --- 4a. The flat CSVs (one rule per row) -------------------------------------

/** Which columns a flat CSV carries, and how to label one of its rows. */
interface FlatCsvColumns {
  /** The match URL / source path — one condition per row. */
  match?: number;
  target?: number;
  status?: number;
  /** The query-string flag, when the format has one. */
  qs?: number;
  label: (row: string[], target: string) => string;
}

/**
 * The one-rule-per-row CSVs: Edge Redirector's export and the simple
 * source/target map. They differ only in which headers carry the match, the
 * target and the status, and in how a row is labelled — so that is all a caller
 * supplies. Everything downstream (capture detection, match mapping, status
 * normalisation, query-string flag, capture warnings) is identical and lives
 * here once, which is what keeps the two formats from drifting.
 */
const mapFlatCsv = (
  text: string,
  host: string,
  columnsOf: (idx: Map<string, number>, header: string[]) => FlatCsvColumns,
): Candidate[] => {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) return [];
  const columns = columnsOf(headerIndex(header), header);

  return rows.slice(1).map((row): Candidate => {
    const target = cell(row, columns.target);
    const captureMode = usesCapture(toEdgeBackrefs(target));
    const mapped = mapMatchUrl(cell(row, columns.match), captureMode);
    const status = mapStatus(cell(row, columns.status));
    const draft = redirectDraft(target, status.statusCode, [mapped.match]);
    const qs = cell(row, columns.qs);
    if (qs !== "") draft.keepQueryString = parseCsvBool(qs);
    return {
      label: columns.label(row, target),
      host,
      draft,
      messages: [
        ...mapped.messages,
        ...status.messages,
        ...captureWarnings(draft),
      ],
      drops: [...mapped.drops, ...status.drops],
    };
  });
};

const mapEdgeRedirectorCsv = (text: string, host: string): Candidate[] =>
  mapFlatCsv(text, host, (idx) => ({
    match: idx.get("matchurl"),
    target: idx.get("redirecturl"),
    status:
      idx.get("result.statuscode") ??
      idx.get("statuscode") ??
      idx.get("status"),
    qs:
      idx.get("useincomingquerystring") ??
      idx.get("result.useincomingquerystring"),
    label: (row, target) => cell(row, idx.get("rulename")) || target || "rule",
  }));

const mapSimpleCsv = (text: string, host: string): Candidate[] =>
  mapFlatCsv(text, host, (idx, header) => ({
    match: idx.get("source"),
    target: idx.get("target"),
    // No status header at all: a third column is the status by position, which
    // is how a hand-written two-or-three column map is usually laid out.
    status:
      idx.get("statuscode") ??
      idx.get("status") ??
      idx.get("code") ??
      (header.length > 2 ? 2 : undefined),
    label: (row, target) =>
      `${cell(row, idx.get("source")) || "(any)"} → ${target || "(none)"}`,
  }));

// --- 4b. The `matches[]` rule (JSON export & policy CSV) ----------------------

/**
 * Our match types that an Akamai `matches[]` entry can map onto directly.
 *
 * `cookie` is deliberately absent. An Akamai cookie condition names the cookie it
 * tests (`ab_test` equals `on`), and a `MatchCondition` has nowhere to put that
 * name, so the edge compares the value against the whole `Cookie` header:
 * `equals` then never matches, and `contains` matches unrelated cookies. Until
 * the model carries a cookie name, the honest answer is to refuse the row.
 */
const PASSTHROUGH_MATCH_TYPES = new Set<MatchCondition["matchType"]>([
  "path",
  "hostname",
  "protocol",
  "regex",
  "header",
]);

/** One Akamai match entry → a `MatchCondition`, or null if its type is unmapped. */
const mapJsonMatch = (
  entry: Record<string, unknown>,
  type: string,
  captureMode: boolean,
): { match: MatchCondition; messages: string[]; drops: string[] } | null => {
  if (!PASSTHROUGH_MATCH_TYPES.has(type as MatchCondition["matchType"])) {
    return null;
  }

  // A `regex` matchType is a regular expression whatever operator it states.
  const operator =
    type === "regex" ? "regex" : str(entry.matchOperator).toLowerCase();
  const resolved = resolveMatchValue(
    str(entry.matchValue),
    operator,
    captureMode,
  );

  const match = emptyMatch();
  match.matchType = type as MatchCondition["matchType"];
  match.matchOperator = resolved.matchOperator;
  match.matchValue = resolved.matchValue;
  match.negate = entry.negate === true;
  match.caseSensitive = entry.caseSensitive === true;
  if (type === "header") {
    match.headerName = str(entry.name) || str(entry.headerName);
  }
  return { match, messages: resolved.messages, drops: resolved.drops };
};

/**
 * One Akamai match rule → a `Candidate`, whatever carried it.
 *
 * Both the JSON export (a `matches[]` rule) and the flattened policy CSV — whose
 * rows are regrouped into a synthetic rule of this same shape — come through
 * here, so the two formats can never drift in how a hostname routes, a wildcard
 * captures, a status normalizes, or a target reinjects a capture.
 *
 * Reads top to bottom as the rule is built: unwrap the envelope, find the
 * target, the status, decide capture mode, then walk the conditions (routing the
 * first hostname out of the list), and finally the warnings that need the
 * finished picture.
 */
const mapMatchRule = (
  raw: unknown,
  at: number,
  defaultHost: string,
): Candidate => {
  const outer = asRecord(raw);
  // Some exports wrap each rule in an envelope of policy metadata
  // (`{ policyId, policyName, why, rule: {...} }`). Unwrap to the real rule; a
  // bare rule (fields already at the top level) is used as-is.
  const wrapped = asRecord(outer.rule);
  const rule = Object.keys(wrapped).length > 0 ? wrapped : outer;
  const result = asRecord(rule.result);
  const messages: string[] = [];
  const drops: string[] = [];

  // The target may sit on the rule or in a `result` block, under any of a few
  // names — Edge Redirector variants differ. A value found anywhere but
  // `redirectURL` is flagged, since we had to guess.
  let target = str(rule.redirectURL) || str(result.redirectURL);
  if (target === "") {
    target = str(result.destinationPath) || str(result.destination);
    if (target !== "") messages.push("redirect target inferred from result");
  }

  const status = mapStatus(
    (rule.statusCode as number | string | undefined) ??
      (result.statusCode as number | string | undefined),
  );
  messages.push(...status.messages);
  drops.push(...status.drops);

  // A wildcard is rewritten into a capturing regex only when the target
  // reinjects a capture AND no explicit regex condition already provides one.
  // Otherwise the glob would steal the capture slot from the real regex, since
  // the edge captures from the *first* regex condition it finds.
  const rawMatches = Array.isArray(rule.matches) ? rule.matches : [];
  const hasExplicitRegex = rawMatches.some((rawMatch) => {
    const entry = asRecord(rawMatch);
    const type = str(entry.matchType).toLowerCase();
    const operator = str(entry.matchOperator).toLowerCase();
    return type === "regex" || operator === "regex" || operator === "matches";
  });
  const captureMode = usesCapture(toEdgeBackrefs(target)) && !hasExplicitRegex;

  let host = defaultHost;
  let matches: MatchCondition[] = [];
  // An empty `matches` is not a set of conditions, it is the absence of one — so
  // it must fall through to `matchURL` rather than short-circuit it, or a rule
  // carrying both would import with no condition at all and match every request.
  if (rawMatches.length > 0) {
    let routed = false;
    for (const rawMatch of rawMatches) {
      const entry = asRecord(rawMatch);
      const type = str(entry.matchType).toLowerCase();

      // First positive hostname condition becomes the host and drops out of
      // the conditions; a later one (or a negated / fuzzy one) stays a match.
      const route = hostRoute(entry, type);
      if (route?.kind === "route" && !routed) {
        host = route.host;
        routed = true;
        continue;
      }
      if (route?.kind === "keep") messages.push(route.note);

      const mapped = mapJsonMatch(entry, type, captureMode);
      if (mapped === null) {
        // Refused, not warned. Conditions AND together, so dropping one widens
        // the rule: "path /api AND method GET" would become "path /api" and
        // redirect the POSTs too. Drop them all and it matches every request.
        drops.push(`match type "${type || "?"}" cannot be translated`);
      } else {
        matches.push(mapped.match);
        messages.push(...mapped.messages);
        drops.push(...mapped.drops);
      }
    }
  } else if (str(rule.matchURL) !== "") {
    const mapped = mapMatchUrl(str(rule.matchURL), captureMode);
    matches = [mapped.match];
    messages.push(...mapped.messages);
    drops.push(...mapped.drops);
  }

  const draft = redirectDraft(target, status.statusCode, matches);
  messages.push(...captureWarnings(draft));
  // After the loop, so `host` is final: a hostname condition may route the rule
  // from a line below the regex that guards on a host.
  messages.push(...foreignHostWarnings(matches, host));

  // Honour the source's query-string flag, wherever it sits; absent (as opposed
  // to `false`) leaves the draft default.
  const keepQueryString = [
    rule.useIncomingQueryString,
    result.useIncomingQueryString,
  ].find((value): value is boolean => typeof value === "boolean");
  if (keepQueryString !== undefined) draft.keepQueryString = keepQueryString;

  return {
    label: str(rule.name) || str(outer.policyName) || `rule ${at + 1}`,
    host,
    draft,
    messages,
    drops,
  };
};

const mapMatchRulesJson = (text: string, defaultHost: string): Candidate[] => {
  const rules = matchRulesArray(JSON.parse(text));
  if (rules === null) return [];
  return rules.map((raw, at) => mapMatchRule(raw, at, defaultHost));
};

/**
 * The flattened Edge Redirector policy CSV: one row per match criterion, with
 * the redirect result repeated on each. Rows of one policy (same `policyId`)
 * describe one rule whose conditions AND together, so they are regrouped and
 * handed to `mapMatchRule` as a synthetic `matches[]` rule — the same path the
 * JSON export takes. A blank `policyId` cannot group, so each such row becomes
 * its own rule rather than silently merging with unrelated ones.
 */
const mapEdgeRedirectorPolicyCsv = (
  text: string,
  defaultHost: string,
): Candidate[] => {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) return [];
  const idx = headerIndex(header);

  const policyAt = idx.get("policyid");
  const nameAt = idx.get("policyname");
  const statusAt = idx.get("statuscode") ?? idx.get("status");
  const targetAt = idx.get("redirecturl");
  const qsAt = idx.get("useincomingquerystring");
  const typeAt = idx.get("matchtype");
  const opAt = idx.get("matchoperator");
  const valueAt = idx.get("matchvalue");
  const negateAt = idx.get("negate");
  const caseAt = idx.get("casesensitive");
  const headerNameAt = idx.get("name") ?? idx.get("headername");

  // A Map iterates in insertion order, so grouping preserves file order. A blank
  // `policyId` cannot group, so it is keyed by row position behind a NUL — a
  // prefix no real policy id can carry — which keeps each such row its own rule
  // instead of merging unrelated ones.
  const byPolicy = new Map<string, string[][]>();
  rows.slice(1).forEach((row, i) => {
    const policyId = cell(row, policyAt);
    const key = policyId === "" ? `\0${i}` : policyId;
    const group = byPolicy.get(key);
    if (group === undefined) byPolicy.set(key, [row]);
    else group.push(row);
  });

  return [...byPolicy.values()].map((group, at): Candidate => {
    const first = group[0];

    // A row with no matchType carries no condition (result-only); skip it so it
    // does not become an empty match that swallows every request.
    const matches = group
      .filter((row) => cell(row, typeAt) !== "")
      .map((row) => {
        const entry: Record<string, unknown> = {
          matchType: cell(row, typeAt),
          matchOperator: cell(row, opAt),
          matchValue: cell(row, valueAt),
          negate: parseCsvBool(cell(row, negateAt)),
          caseSensitive: parseCsvBool(cell(row, caseAt)),
        };
        const name = cell(row, headerNameAt);
        if (name !== "") entry.name = name;
        return entry;
      });

    const rule: Record<string, unknown> = {
      name: cell(first, nameAt),
      redirectURL: cell(first, targetAt),
      statusCode: cell(first, statusAt),
      matches,
    };
    const qs = cell(first, qsAt);
    if (qs !== "") rule.useIncomingQueryString = parseCsvBool(qs);

    return mapMatchRule(rule, at, defaultHost);
  });
};

/** Format → its mapper. The only place a `SourceFormat` turns into behaviour. */
const MAPPERS: Record<
  SourceFormat,
  (text: string, defaultHost: string) => Candidate[]
> = {
  "edge-redirector-csv": mapEdgeRedirectorCsv,
  "edge-redirector-policy-csv": mapEdgeRedirectorPolicyCsv,
  "simple-csv": mapSimpleCsv,
  "match-rules-json": mapMatchRulesJson,
};

// ===========================================================================
// Step 5 — Building the preview
//
// The entry point. Applies the size limits, then per candidate: a provisional
// priority, the shadowing check, `validateDraft`, and the ok / warning / skipped
// verdict. This is the only step that decides a row's *status*; steps 3 and 4
// only report what they had to do.
// ===========================================================================

/**
 * A ceiling on the input we will parse. Both PapaParse and `JSON.parse` load the
 * whole string into memory, so a huge paste/file would freeze the tab.
 */
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/**
 * A ceiling on the number of rules, which is the figure that actually costs
 * something: the count drives the mapping, the preview render, and one HTTP
 * request each at import time. Bytes only bound the parse. A real Edge Redirector
 * policy stays well under this; anything above it is a file that wants splitting.
 */
const MAX_IMPORT_ROWS = 5000;

// How many rows the preview *renders* is a display concern, and lives with the
// modal that renders them — every row is still parsed and imported.

/** A refusal: the format, no rows, and the reason to show the user. */
const emptyPreview = (
  format: ImportPreview["format"],
  error: string,
): ImportPreview => ({
  format,
  rows: [],
  summary: { ready: 0, warnings: 0, skipped: 0, hosts: 0 },
  error,
});

/**
 * Parses an export into a preview: one row per source rule, each mapped to our
 * model and tagged ok / warning / skipped, plus a summary. Never throws — a
 * whole-file failure comes back as `error` with no rows, and a single bad row
 * comes back skipped with a reason.
 */
export function parseExport(text: string, opts: ParseOptions): ImportPreview {
  // --- Refuse the whole file, before doing any work on it ---
  if (text.length > MAX_IMPORT_BYTES) {
    const mb = Math.round(text.length / (1024 * 1024));
    return emptyPreview(
      "unrecognized",
      `Import is too large (~${mb} MB, limit 10 MB). Split it into smaller ` +
        `exports and import them separately.`,
    );
  }

  const format = detectFormat({ filename: opts.filename, text });
  if (format === "unrecognized") {
    return emptyPreview(
      "unrecognized",
      "Unrecognized format. Expected an Edge Redirector CSV, a flattened " +
        "Edge Redirector policy CSV, a simple source/target CSV, or a " +
        "matchRules JSON export.",
    );
  }

  // A policy index parses as matchRules JSON but has no rules to map — tell the
  // user to export each policy's rules rather than emit a "missing" per policy.
  if (format === "match-rules-json") {
    const indexNote = policyIndexNote(text);
    if (indexNote !== null) return emptyPreview("unrecognized", indexNote);
  }

  // --- Step 4, under a guard: a broken file is a message, not an exception ---
  let candidates: Candidate[];
  try {
    candidates = MAPPERS[format](text, opts.defaultHost);
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    return emptyPreview(
      format,
      `Could not read the ${format} export: ${reason}`,
    );
  }

  if (candidates.length > MAX_IMPORT_ROWS) {
    return emptyPreview(
      format,
      `That export holds ${candidates.length} rules (limit ` +
        `${MAX_IMPORT_ROWS}). Split it and import the parts separately: each ` +
        `rule is one request, so a batch this size would take a long time and ` +
        `could not be followed.`,
    );
  }

  // --- Per-host bookkeeping the verdict below needs ---

  // A per-host counter, so each host's provisional priorities are distinct and
  // `validateDraft` never flags a within-host collision. The real priorities are
  // assigned against each host's live rules at import time.
  const counters = new Map<string, number>();
  const nextProvisional = (host: string): number => {
    const at = counters.get(host) ?? 0;
    counters.set(host, at + 1);
    return at;
  };

  // Where each host's last rule sits. Priorities follow file order, and the edge
  // takes the first rule that matches, so a rule that matches every request
  // shadows everything imported after it on the same host. Being last is what
  // makes such a rule harmless.
  const lastRowOfHost = new Map<string, number>();
  candidates.forEach((candidate, at) => lastRowOfHost.set(candidate.host, at));

  // --- The verdict, one row at a time ---
  const rows: ParsedRow[] = candidates.map((candidate, at) => {
    const draft = candidate.draft;
    draft.priority = String(nextProvisional(candidate.host));
    const validation = validateDraft(draft, []);
    const blocked = candidate.drops ?? [];
    const shadows =
      matchesEveryRequest(draft.matches) &&
      lastRowOfHost.get(candidate.host) !== at;
    const messages = shadows
      ? [
          ...candidate.messages,
          `this rule matches every request, so the rules imported after it on ` +
            `${candidate.host} will never be reached. Move it to the end of the ` +
            `file, or give it a higher priority number once imported.`,
        ]
      : candidate.messages;

    // Two independent reasons to refuse: the draft is not a valid rule, or the
    // source said something this model cannot say. Either is a refusal, so a row
    // is importable only when both are empty.
    const status: RowStatus =
      validation.length > 0 || blocked.length > 0
        ? "skipped"
        : messages.length > 0
          ? "warning"
          : "ok";

    return {
      index: at + 1,
      label: candidate.label,
      host: candidate.host,
      status,
      messages,
      blocked,
      draft,
      input: status === "skipped" ? undefined : toRuleInput(draft),
      validation,
    };
  });

  return {
    format,
    rows,
    summary: {
      // "ready" is everything importable — the clean rows and the warned ones,
      // i.e. every row that produced an `input`. `warnings` then annotates how
      // many of those carried a caveat; it is a subset, not a separate bucket.
      ready: rows.filter((row) => row.input !== undefined).length,
      warnings: rows.filter((row) => row.status === "warning").length,
      skipped: rows.filter((row) => row.status === "skipped").length,
      hosts: new Set(rows.map((row) => row.host)).size,
    },
  };
}
