import type { CloudFrontCustomOrigin, CloudFrontS3Origin } from "aws-lambda";

/**
 * CloudFront's own origin union, widened to the extra protocol values the rule
 * schema allows. `normalizeOriginProtocol` collapses them back to http/https
 * before the origin is assigned to `request.origin`.
 */
export type CloudFrontOriginWithExtendedProtocol =
  | { s3: CloudFrontS3Origin; custom?: never | undefined }
  | {
      custom: Omit<CloudFrontCustomOrigin, "protocol"> & {
        protocol:
          | CloudFrontCustomOrigin["protocol"]
          | "http-only"
          | "https-only"
          | "match-viewer";
      };
      s3?: never | undefined;
    };

export const MatchType = {
  PATH: "path",
  HOSTNAME: "hostname",
  PROTOCOL: "protocol",
  REGEX: "regex",
  HEADER: "header",
  COOKIE: "cookie",
} as const;

export const MatchOperator = {
  EQUALS: "equals",
  CONTAINS: "contains",
  REGEX: "regex",
} as const;

export type MatchType = (typeof MatchType)[keyof typeof MatchType];
export type MatchOperator = (typeof MatchOperator)[keyof typeof MatchOperator];

export interface MatchCondition {
  matchType: MatchType;
  matchValue: string;
  matchOperator: MatchOperator;
  negate?: boolean;
  caseSensitive?: boolean;
  headerName?: string;
}

export interface ForwardSettings {
  origin?: CloudFrontOriginWithExtendedProtocol;
  pathAndQS?: string;
  useIncomingQueryString?: boolean;
}

interface BaseRule {
  pk: string;
  sk: string;
  matches: MatchCondition[];
  disabled?: boolean;
}

export interface EdgeRedirectRule extends BaseRule {
  type: "erMatchRule";
  statusCode: 301 | 302;
  redirectURL: string;
  useIncomingQueryString?: boolean;
}

export interface ForwardRewriteRule extends BaseRule {
  type: "frMatchRule";
  forwardSettings: ForwardSettings;
}

export type RedirectRule = EdgeRedirectRule | ForwardRewriteRule;

export type MatchResult =
  | { type: "redirect"; statusCode: 301 | 302; redirectURL: string }
  | {
      type: "rewrite";
      forwardSettings: ForwardSettings;
      /**
       * The rule set `useIncomingQueryString: false`, so the query string the
       * viewer sent must not reach the origin.
       *
       * Separate from `forwardSettings.pathAndQS` because the two are
       * independent: a rewrite that only switches origin resolves no path at
       * all, and still has to be able to clear the query string. An **absent**
       * flag is not an opt-out — it keeps the query string, which is what it has
       * always done here and in the upstream snippet, and what hand-written
       * rules therefore rely on.
       */
      dropIncomingQueryString: boolean;
    };

export type RequestParams = {
  hostname: string;
  path: string;
  protocol: string;
  headers?: Record<string, string>;
  cookies?: string;
};

/** Sort-key prefix. Also the DynamoDB `begins_with` operand. */
export type RuleKind = "REDIRECT" | "REWRITE";
