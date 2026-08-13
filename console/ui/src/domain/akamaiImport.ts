import Papa from "papaparse";
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
 * A rule lands on the target host by default, but a rule that carries its own
 * `hostname` condition is routed to *that* host instead — the condition names the
 * partition, so it becomes the host and drops out of the match list. That is why
 * a preview can span several hosts from one file.
 *
 * Two rules the whole file obeys:
 *  - One bad row never fails the batch. Every row is parsed under its own guard;
 *    a throw becomes a skipped row with a reason, not a dead import.
 *  - Format detection is by file extension first, content shape second — never a
 *    silent fall back to CSV.
 *
 * Priorities are not assigned here. They are per host and only knowable against
 * that host's current rules, so the importer assigns them at write time; the
 * provisional value below exists solely to satisfy `validateDraft`.
 */

/** Absolute vs relative redirect URL — the same test `ruleDraft` uses on load. */
const ABSOLUTE_URL = /^https?:\/\//i;

export type SourceFormat =
  | "edge-redirector-csv"
  | "edge-redirector-policy-csv"
  | "simple-csv"
  | "match-rules-json";

/**
 * `ok` imports cleanly, `warning` imports but lost something in translation,
 * `skipped` cannot be imported (it failed `validateDraft`).
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
  /** Why it was skipped, or what the mapping had to drop (for a warning). */
  messages: string[];
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

/** One source rule, mapped and tagged with the host it belongs to. */
interface Candidate {
  label: string;
  host: string;
  draft: RedirectDraft;
  messages: string[];
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

const extensionOf = (filename?: string): string => {
  if (filename === undefined) return "";
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
};

/** True when the text parses as JSON in one of the matchRules wrapper shapes. */
const looksLikeMatchRules = (text: string): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return matchRulesArray(parsed) !== null;
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

/** Header-driven CSV detection — the two supported shapes, or unrecognized. */
const detectCsv = (text: string): SourceFormat | "unrecognized" => {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) return "unrecognized";
  const names = new Set(header.map((cell) => cell.trim().toLowerCase()));
  if (names.has("rulename") && names.has("matchurl") && names.has("redirecturl")) {
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

  if (ext === "json") {
    return looksLikeMatchRules(trimmed) ? "match-rules-json" : "unrecognized";
  }
  if (ext === "csv" || ext === "txt") return detectCsv(input.text);

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return looksLikeMatchRules(trimmed) ? "match-rules-json" : "unrecognized";
  }
  return detectCsv(input.text);
}

// ---------------------------------------------------------------------------
// Shared mapping helpers
// ---------------------------------------------------------------------------

/**
 * Escapes a glob so only `*` and `?` stay special, then anchors it.
 *
 * Each wildcard becomes a *capturing* group so an Akamai redirect target that
 * reinjects the piece it matched (`\1`, `\2` …) has something to reinject. A
 * capturing group matches exactly what `.*` / `.` matched, so this never changes
 * *what* a rule matches — it only makes the captured pieces available.
 */
const wildcardToRegex = (glob: string): string => {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*/g, "(.*)").replace(/\?/g, "(.)");
  return `^${body}$`;
};

/**
 * How a raw Akamai match value becomes our operator + value — the single
 * decision the importer makes about match syntax.
 *
 * Our edge already speaks Akamai for `contains` / `equals`: at runtime it splits
 * a value on spaces into alternatives and expands `*` within each (contains
 * unanchored, equals anchored — see `checkAkamaiVariant`). So values are passed
 * through VERBATIM and the runtime does the work; there is no growing list of
 * glob/space/operator quirks to translate here.
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
} => {
  // Already a regular expression (by operator, or a forced `regex` type) — never
  // translate it, or its `.*` / `?` would be mistaken for glob wildcards.
  if (operator === "regex" || operator === "matches") {
    return { matchOperator: "regex", matchValue: value, messages: [] };
  }

  if (captureMode && /[*?]/.test(value)) {
    const messages = [
      "wildcard translated to a capturing regular expression to feed the redirect",
    ];
    if (value.includes(" ")) {
      messages.push(
        "match had space-separated alternatives a single capturing regex can't " +
          "represent — verify the result",
      );
    }
    return { matchOperator: "regex", matchValue: wildcardToRegex(value), messages };
  }

  return {
    matchOperator: operator === "contains" ? "contains" : "equals",
    matchValue: value,
    messages: [],
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
): { match: MatchCondition; messages: string[] } => {
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
  return { match, messages };
};

/** Status column → 301/302, warning on anything else. Accepts string or number. */
const mapStatus = (
  raw: string | number | undefined,
): { statusCode: 301 | 302; messages: string[] } => {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "302") return { statusCode: 302, messages: [] };
  if (trimmed === "" || trimmed === "301") return { statusCode: 301, messages: [] };
  return {
    statusCode: 301,
    messages: [`unsupported status code ${trimmed} — mapped to 301`],
  };
};

/** Akamai reinjects captured groups as `\1 \2 …`; our edge substitutes `$1 $2 …`. */
const toEdgeBackrefs = (url: string): string =>
  url.replace(/\\([1-9]\d*)/g, (_, n: string) => `$${n}`);

/** True when a redirect target reinjects a capture (`$1` …). */
const usesCapture = (url: string): boolean => /\$[1-9]\d*/.test(url);

/** True when a condition is a regex that actually captures a group. */
const capturesAGroup = (match: MatchCondition): boolean =>
  match.matchOperator === "regex" && /\((?!\?)/.test(match.matchValue);

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
  return draft;
};

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * CSV rows via PapaParse (RFC 4180): double-quoted fields may hold commas,
 * newlines and doubled `""` quotes — the shapes an Edge Redirector export puts in
 * `matchURL` / `redirectURL`. `skipEmptyLines: "greedy"` drops blank lines so a
 * trailing newline or a gap never becomes a skipped preview row.
 */
const parseCsv = (text: string): string[][] =>
  Papa.parse<string[]>(text, { delimiter: ",", skipEmptyLines: "greedy" }).data;

/** Lowercased-name → column index, for reading fields by header. */
const headerIndex = (header: string[]): Map<string, number> => {
  const index = new Map<string, number>();
  header.forEach((name, at) => {
    const key = name.trim().toLowerCase();
    if (!index.has(key)) index.set(key, at);
  });
  return index;
};

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

// ---------------------------------------------------------------------------
// Per-format mappers → Candidate[]
// ---------------------------------------------------------------------------

const mapEdgeRedirectorCsv = (text: string, host: string): Candidate[] => {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) return [];
  const idx = headerIndex(header);
  const nameAt = idx.get("rulename");
  const matchAt = idx.get("matchurl");
  const targetAt = idx.get("redirecturl");
  const statusAt =
    idx.get("result.statuscode") ?? idx.get("statuscode") ?? idx.get("status");

  return rows.slice(1).map((row): Candidate => {
    const target = cell(row, targetAt);
    const captureMode = usesCapture(toEdgeBackrefs(target));
    const label = cell(row, nameAt) || target || "rule";
    const { match, messages: matchMsg } = mapMatchUrl(cell(row, matchAt), captureMode);
    const { statusCode, messages: statusMsg } = mapStatus(cell(row, statusAt));
    return {
      label,
      host,
      draft: redirectDraft(target, statusCode, [match]),
      messages: [...matchMsg, ...statusMsg],
    };
  });
};

const mapSimpleCsv = (text: string, host: string): Candidate[] => {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) return [];
  const idx = headerIndex(header);
  const sourceAt = idx.get("source");
  const targetAt = idx.get("target");
  const statusAt =
    idx.get("statuscode") ??
    idx.get("status") ??
    idx.get("code") ??
    (header.length > 2 ? 2 : undefined);

  return rows.slice(1).map((row): Candidate => {
    const target = cell(row, targetAt);
    const captureMode = usesCapture(toEdgeBackrefs(target));
    const label = `${cell(row, sourceAt) || "(any)"} → ${target || "(none)"}`;
    const { match, messages: matchMsg } = mapMatchUrl(cell(row, sourceAt), captureMode);
    const { statusCode, messages: statusMsg } = mapStatus(cell(row, statusAt));
    return {
      label,
      host,
      draft: redirectDraft(target, statusCode, [match]),
      messages: [...matchMsg, ...statusMsg],
    };
  });
};

/** Our match types that an Akamai `matches[]` entry can map onto directly. */
const PASSTHROUGH_MATCH_TYPES = new Set<MatchCondition["matchType"]>([
  "path",
  "hostname",
  "protocol",
  "regex",
  "header",
  "cookie",
]);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** The first argument that is an actual boolean, else undefined. */
const firstBoolean = (...values: unknown[]): boolean | undefined => {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
};

/** One Akamai match entry → a `MatchCondition`, or null if its type is unmapped. */
const mapJsonMatch = (
  entry: Record<string, unknown>,
  type: string,
  captureMode: boolean,
): { match: MatchCondition; messages: string[] } | null => {
  if (!PASSTHROUGH_MATCH_TYPES.has(type as MatchCondition["matchType"])) {
    return null;
  }

  // A `regex` matchType is a regular expression whatever operator it states.
  const operator =
    type === "regex" ? "regex" : str(entry.matchOperator).toLowerCase();
  const resolved = resolveMatchValue(str(entry.matchValue), operator, captureMode);

  const match = emptyMatch();
  match.matchType = type as MatchCondition["matchType"];
  match.matchOperator = resolved.matchOperator;
  match.matchValue = resolved.matchValue;
  match.negate = entry.negate === true;
  match.caseSensitive = entry.caseSensitive === true;
  if (type === "header") {
    match.headerName = str(entry.name) || str(entry.headerName);
  }
  return { match, messages: resolved.messages };
};

/** A positive `hostname equals` condition names the partition, so it routes. */
const hostRoute = (entry: Record<string, unknown>, type: string): string | null => {
  if (type !== "hostname" || entry.negate === true) return null;
  const operator = str(entry.matchOperator).toLowerCase();
  if (operator !== "" && operator !== "equals") return null;
  const value = str(entry.matchValue).trim();
  return value === "" ? null : value;
};

/**
 * One Akamai match rule → a `Candidate`, whatever carried it.
 *
 * Both the JSON export (a `matches[]` rule) and the flattened policy CSV — whose
 * rows are regrouped into a synthetic rule of this same shape — come through
 * here, so the two formats can never drift in how a hostname routes, a wildcard
 * captures, a status normalizes, or a target reinjects a capture.
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
  const captureMode =
    usesCapture(toEdgeBackrefs(target)) && !hasExplicitRegex;

  let host = defaultHost;
  let matches: MatchCondition[] = [];
  if (Array.isArray(rule.matches)) {
    let routed = false;
    for (const rawMatch of rule.matches) {
      const entry = asRecord(rawMatch);
      const type = str(entry.matchType).toLowerCase();

      // First positive hostname condition becomes the host and drops out of
      // the conditions; a later one (or a negated / fuzzy one) stays a match.
      const route = hostRoute(entry, type);
      if (route !== null && !routed) {
        host = route;
        routed = true;
        continue;
      }

      const mapped = mapJsonMatch(entry, type, captureMode);
      if (mapped === null) {
        messages.push(`match type "${type || "?"}" not supported`);
      } else {
        matches.push(mapped.match);
        messages.push(...mapped.messages);
      }
    }
  } else if (str(rule.matchURL) !== "") {
    const mapped = mapMatchUrl(str(rule.matchURL), captureMode);
    matches = [mapped.match];
    messages.push(...mapped.messages);
  }

  // `redirectDraft` has already rewritten Akamai's `\1` backreferences to the
  // edge's `$1` form. A target that reinjects a capture but has no capturing
  // condition to fill it resolves to an empty string at the edge — flag it
  // rather than import a redirect that silently drops part of the path.
  const draft = redirectDraft(target, status.statusCode, matches);
  if (usesCapture(draft.redirectURL) && !matches.some(capturesAGroup)) {
    messages.push(
      "redirect target reinjects a captured group ($1 …) but no condition " +
        "captures one — it may resolve to an empty string",
    );
  }

  // Honour the source's query-string flag; absent leaves the draft default.
  const keepQueryString = firstBoolean(
    rule.useIncomingQueryString,
    result.useIncomingQueryString,
  );
  if (keepQueryString !== undefined) draft.keepQueryString = keepQueryString;

  return {
    label: str(rule.name) || str(outer.policyName) || `rule ${at + 1}`,
    host,
    draft,
    messages,
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

  const groups: string[][][] = [];
  const byPolicy = new Map<string, string[][]>();
  rows.slice(1).forEach((row, i) => {
    const policyId = cell(row, policyAt);
    const key = policyId === "" ? ` ${i}` : policyId;
    let group = byPolicy.get(key);
    if (group === undefined) {
      group = [];
      byPolicy.set(key, group);
      groups.push(group);
    }
    group.push(row);
  });

  return groups.map((group, at): Candidate => {
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

// ---------------------------------------------------------------------------
// parseExport
// ---------------------------------------------------------------------------

const MAPPERS: Record<
  SourceFormat,
  (text: string, defaultHost: string) => Candidate[]
> = {
  "edge-redirector-csv": mapEdgeRedirectorCsv,
  "edge-redirector-policy-csv": mapEdgeRedirectorPolicyCsv,
  "simple-csv": mapSimpleCsv,
  "match-rules-json": mapMatchRulesJson,
};

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const list = matchRulesArray(parsed);
  if (list === null || list.length === 0) return null;

  const isIndexEntry = (value: unknown): boolean => {
    const entry = asRecord(value);
    const identifies = ["policyId", "ruleCount"].some((key) => key in entry);
    const carriesRule = ["rule", "matches", "redirectURL", "matchURL", "type"].some(
      (key) => key in entry,
    );
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

/**
 * Parses an export into a preview: one row per source rule, each mapped to our
 * model and tagged ok / warning / skipped, plus a summary. Never throws — a
 * whole-file failure comes back as `error` with no rows, and a single bad row
 * comes back skipped with a reason.
 */
/**
 * A ceiling on the input we will parse. Both PapaParse and `JSON.parse` load the
 * whole string into memory, so a huge paste/file would freeze the tab; a real
 * Edge Redirector export of thousands of rules stays comfortably under this.
 */
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export function parseExport(text: string, opts: ParseOptions): ImportPreview {
  if (text.length > MAX_IMPORT_BYTES) {
    const mb = Math.round(text.length / (1024 * 1024));
    return emptyPreview(
      "unrecognized",
      `Import is too large (~${mb} MB, limit 50 MB). Split it into smaller ` +
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

  let candidates: Candidate[];
  try {
    candidates = MAPPERS[format](text, opts.defaultHost);
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    return emptyPreview(format, `Could not read the ${format} export: ${reason}`);
  }

  // A per-host counter, so each host's provisional priorities are distinct and
  // `validateDraft` never flags a within-host collision. The real priorities are
  // assigned against each host's live rules at import time.
  const counters = new Map<string, number>();
  const nextProvisional = (host: string): number => {
    const at = counters.get(host) ?? 0;
    counters.set(host, at + 1);
    return at;
  };

  const rows: ParsedRow[] = candidates.map((candidate, at) => {
    const draft = candidate.draft;
    draft.priority = String(nextProvisional(candidate.host));
    const validation = validateDraft(draft, []);
    const status: RowStatus =
      validation.length > 0
        ? "skipped"
        : candidate.messages.length > 0
          ? "warning"
          : "ok";

    return {
      index: at + 1,
      label: candidate.label,
      host: candidate.host,
      status,
      messages: candidate.messages,
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
