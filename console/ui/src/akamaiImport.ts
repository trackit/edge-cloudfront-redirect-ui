import {
  emptyMatch,
  emptyRedirect,
  toRuleInput,
  validateDraft,
  type RedirectDraft,
} from "./ruleDraft";
import type { MatchCondition, RuleInput, ValidationDetail } from "./api";

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

/** Escapes a glob so only `*` and `?` stay special, then anchors it. */
const wildcardToRegex = (glob: string): string => {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return `^${body}$`;
};

/**
 * A match URL / source path → one path `MatchCondition`.
 *
 * An absolute URL is reduced to its path (our single condition cannot AND a
 * hostname and a path from one column); a `*`/`?` wildcard becomes an anchored
 * regex. Both are lossy, so both add a warning.
 */
const mapMatchUrl = (raw: string): { match: MatchCondition; messages: string[] } => {
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
  if (/[*?]/.test(value)) {
    match.matchOperator = "regex";
    match.matchValue = wildcardToRegex(value);
    messages.push("wildcard translated to a regular expression");
  } else {
    match.matchValue = value;
  }
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

/** Builds a redirect draft from a target URL, status and conditions. */
const redirectDraft = (
  redirectURL: string,
  statusCode: 301 | 302,
  matches: MatchCondition[],
): RedirectDraft => {
  const draft = emptyRedirect();
  draft.redirectURL = redirectURL;
  draft.relative = !ABSOLUTE_URL.test(redirectURL);
  draft.statusCode = statusCode;
  draft.matches = matches;
  return draft;
};

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * A small RFC-4180-ish CSV reader: double-quoted fields may hold commas,
 * newlines and doubled `""` quotes. Enough for the columns an Edge Redirector
 * export puts in `matchURL` / `redirectURL` (query strings carry commas).
 */
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);

  // Drop rows that are entirely empty (a trailing newline, or a blank line):
  // they are not data, and would otherwise each become a skipped preview row.
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
};

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
    const label = cell(row, nameAt) || cell(row, targetAt) || "rule";
    const { match, messages: matchMsg } = mapMatchUrl(cell(row, matchAt));
    const { statusCode, messages: statusMsg } = mapStatus(cell(row, statusAt));
    return {
      label,
      host,
      draft: redirectDraft(cell(row, targetAt), statusCode, [match]),
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
    const label = `${cell(row, sourceAt) || "(any)"} → ${target || "(none)"}`;
    const { match, messages: matchMsg } = mapMatchUrl(cell(row, sourceAt));
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
  "header",
  "cookie",
]);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** One Akamai match entry → a `MatchCondition`, or null if its type is unmapped. */
const mapJsonMatch = (
  entry: Record<string, unknown>,
  type: string,
): { match: MatchCondition; messages: string[] } | null => {
  if (!PASSTHROUGH_MATCH_TYPES.has(type as MatchCondition["matchType"])) {
    return null;
  }

  const value = str(entry.matchValue);
  const operator = str(entry.matchOperator).toLowerCase();
  const match = emptyMatch();
  match.matchType = type as MatchCondition["matchType"];
  match.matchValue = value;
  match.negate = entry.negate === true;
  match.caseSensitive = entry.caseSensitive === true;

  const messages: string[] = [];
  if (/[*?]/.test(value)) {
    match.matchOperator = "regex";
    match.matchValue = wildcardToRegex(value);
    messages.push("wildcard translated to a regular expression");
  } else if (operator === "contains") {
    match.matchOperator = "contains";
  } else if (operator === "regex" || operator === "matches") {
    match.matchOperator = "regex";
  } else {
    match.matchOperator = "equals";
  }

  if (type === "header") {
    match.headerName = str(entry.name) || str(entry.headerName);
  }
  return { match, messages };
};

/** A positive `hostname equals` condition names the partition, so it routes. */
const hostRoute = (entry: Record<string, unknown>, type: string): string | null => {
  if (type !== "hostname" || entry.negate === true) return null;
  const operator = str(entry.matchOperator).toLowerCase();
  if (operator !== "" && operator !== "equals") return null;
  const value = str(entry.matchValue).trim();
  return value === "" ? null : value;
};

const mapMatchRulesJson = (text: string, defaultHost: string): Candidate[] => {
  const rules = matchRulesArray(JSON.parse(text));
  if (rules === null) return [];

  return rules.map((raw, at): Candidate => {
    const rule = asRecord(raw);
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

        const mapped = mapJsonMatch(entry, type);
        if (mapped === null) {
          messages.push(`match type "${type || "?"}" not supported`);
        } else {
          matches.push(mapped.match);
          messages.push(...mapped.messages);
        }
      }
    } else if (str(rule.matchURL) !== "") {
      const mapped = mapMatchUrl(str(rule.matchURL));
      matches = [mapped.match];
      messages.push(...mapped.messages);
    }

    return {
      label: str(rule.name) || `rule ${at + 1}`,
      host,
      draft: redirectDraft(target, status.statusCode, matches),
      messages,
    };
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
 * Parses an export into a preview: one row per source rule, each mapped to our
 * model and tagged ok / warning / skipped, plus a summary. Never throws — a
 * whole-file failure comes back as `error` with no rows, and a single bad row
 * comes back skipped with a reason.
 */
export function parseExport(text: string, opts: ParseOptions): ImportPreview {
  const format = detectFormat({ filename: opts.filename, text });
  if (format === "unrecognized") {
    return emptyPreview(
      "unrecognized",
      "Unrecognized format. Expected an Edge Redirector CSV, a simple " +
        "source/target CSV, or a matchRules JSON export.",
    );
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
