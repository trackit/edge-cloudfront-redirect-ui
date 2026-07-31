/* Rule shapes mirror shared/*.schema.json (the single source of truth).
   These are the exact DynamoDB item shapes the Lambda@Edge reads. */

export type MatchType =
  | 'path'
  | 'hostname'
  | 'protocol'
  | 'regex'
  | 'header'
  | 'cookie';
export type MatchOperator = 'equals' | 'contains' | 'regex';

export interface MatchCondition {
  matchType: MatchType;
  matchOperator: MatchOperator;
  matchValue: string;
  negate?: boolean;
  caseSensitive?: boolean;
  headerName?: string; // required iff matchType === 'header'
}

export interface RedirectRule {
  pk: string; // host
  sk: string; // REDIRECT#00100
  type: 'erMatchRule';
  statusCode: 301 | 302;
  redirectURL: string;
  useIncomingQueryString?: boolean;
  useRelativeUrl?: 'relative_url' | 'absolute_url';
  matches: MatchCondition[];
  disabled?: boolean;
}

export interface S3Origin {
  authMethod: 'origin-access-identity' | 'none';
  customHeaders: Record<string, { key?: string; value: string }[]>;
  domainName: string;
  path: string;
  region?: string; // required iff authMethod === 'origin-access-identity'
}

export interface CustomOrigin {
  customHeaders: Record<string, { key?: string; value: string }[]>;
  domainName: string;
  keepaliveTimeout: number;
  path: string;
  port: number;
  protocol: 'http' | 'https' | 'http-only' | 'https-only' | 'match-viewer';
  readTimeout: number;
  sslProtocols: string[];
}

export interface ForwardSettings {
  origin?: { s3?: S3Origin; custom?: CustomOrigin };
  pathAndQS?: string;
  useIncomingQueryString?: boolean;
}

export interface RewriteRule {
  pk: string;
  sk: string; // REWRITE#00200
  type: 'frMatchRule';
  matches: MatchCondition[];
  forwardSettings: ForwardSettings;
  disabled?: boolean;
}

export type Rule = RedirectRule | RewriteRule;

/* A connected CloudFront distribution + its linked DynamoDB routing table.
   Replaces the old multi "target/environment" concept (tech-lead feedback). */
export interface Distribution {
  distributionId: string; // CloudFront distribution ID or ARN
  tableName: string; // linked DynamoDB routing table
  region: string; // table region
}

export const isRedirect = (r: Rule): r is RedirectRule =>
  r.type === 'erMatchRule';
export const isRewrite = (r: Rule): r is RewriteRule => r.type === 'frMatchRule';

/** Extract the numeric priority from an sk like REDIRECT#00100 -> 100. */
export const priorityOf = (sk: string): number =>
  parseInt(sk.split('#')[1] ?? '0', 10);
