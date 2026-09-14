import type { SourceFormat } from "./akamaiImport";

/**
 * What the console calls each source format, and what it shows as an example of
 * one.
 *
 * Both live here rather than in the modal because two places name these: the
 * pill that reports what was detected, and the Formats help that lists what may
 * be dropped. Kept apart they drift, and the help is the copy people read when
 * an import has already failed to detect — the worst moment for it to be wrong.
 *
 * The examples are load-bearing, not decoration: `import-formats.test.ts` runs
 * every one of them through `parseExport`, so an example that stops being
 * importable fails the suite rather than quietly misleading someone.
 */
export const FORMAT_LABEL: Record<SourceFormat, string> = {
  "edge-redirector-csv": "Edge Redirector CSV",
  "edge-redirector-policy-csv": "Edge Redirector policy CSV",
  "simple-csv": "Simple CSV",
  "match-rules-json": "matchRules JSON",
};

export interface FormatHelp {
  format: SourceFormat;
  /** Suggested name: detection reads the extension before it reads the text. */
  filename: string;
  /** Where this shape comes from, in one line. */
  blurb: string;
  /** Header plus one row, or one rule — short enough to read at a glance. */
  example: string;
}

/**
 * Tab order, and the reasoning behind it: the two shapes an Akamai export
 * actually arrives in, then the flattened policy dump, then the hand-written
 * mapping people reach for when they have no export at all.
 */
export const FORMAT_HELP: FormatHelp[] = [
  {
    format: "edge-redirector-csv",
    filename: "export.csv",
    blurb: "The Edge Redirector rule export — one rule per row.",
    example: [
      "ruleName,matchURL,redirectURL,result.statusCode",
      "Old blog,/blog/*,https://example.com/news/,301",
    ].join("\n"),
  },
  {
    format: "edge-redirector-policy-csv",
    filename: "policy.csv",
    blurb:
      "A flattened policy dump — several condition rows may share one policy.",
    example: [
      "policyId,policyName,statusCode,redirectURL,matchType,matchOperator,matchValue",
      "12345,Old blog,301,https://example.com/news/,path,equals,/blog/*",
    ].join("\n"),
  },
  {
    format: "simple-csv",
    filename: "map.csv",
    blurb: "A plain source-to-target mapping, for when there is no export.",
    example: ["source,target,status", "/old,/new,301"].join("\n"),
  },
  {
    format: "match-rules-json",
    filename: "rules.json",
    blurb:
      "A matchRules document — a bare array, or wrapped in rules or matchRules.",
    // Wrapped one field per line. The natural one-line form of a match object
    // is wider than the panel, and the fields it pushed off the right-hand edge
    // were `matchOperator` and `matchValue` — the two anyone reads this to see.
    example: `{
  "matchRules": [
    {
      "name": "Old blog",
      "matches": [
        {
          "matchType": "path",
          "matchOperator": "equals",
          "matchValue": "/blog/*"
        }
      ],
      "redirectURL": "https://example.com/news/",
      "statusCode": 301
    }
  ]
}`,
  },
];
