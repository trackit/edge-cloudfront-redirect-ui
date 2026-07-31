import type { Distribution, Rule } from './types';

/* Mock data for the visual prototype — no real API/DynamoDB behind it.
   Shapes match shared/*.schema.json. */

/* Used only to pre-fill the onboarding form in the demo. */
export const SAMPLE_DISTRIBUTION: Distribution = {
  distributionId: 'E2QWERTY123456',
  tableName: 'edgeroute-rules',
  region: 'us-east-1',
};

export const RULES: Rule[] = [
  // ---- www.example.com ----
  {
    pk: 'www.example.com',
    sk: 'REDIRECT#00100',
    type: 'erMatchRule',
    statusCode: 301,
    redirectURL: 'https://www.example.com/new-landing',
    useRelativeUrl: 'absolute_url',
    useIncomingQueryString: true,
    matches: [
      {
        matchType: 'path',
        matchOperator: 'equals',
        matchValue: '/old-landing',
        negate: false,
        caseSensitive: false,
      },
    ],
    disabled: false,
  },
  {
    pk: 'www.example.com',
    sk: 'REDIRECT#00200',
    type: 'erMatchRule',
    statusCode: 302,
    redirectURL: '/promo/summer',
    useRelativeUrl: 'relative_url',
    useIncomingQueryString: false,
    matches: [
      {
        matchType: 'path',
        matchOperator: 'contains',
        matchValue: '/sale',
        negate: false,
        caseSensitive: false,
      },
    ],
    disabled: false,
  },
  {
    pk: 'www.example.com',
    sk: 'REDIRECT#00300',
    type: 'erMatchRule',
    statusCode: 301,
    redirectURL: 'https://help.example.com',
    useRelativeUrl: 'absolute_url',
    matches: [
      {
        matchType: 'path',
        matchOperator: 'regex',
        matchValue: '^/support/.*',
        negate: false,
        caseSensitive: true,
      },
    ],
    disabled: true,
  },
  {
    pk: 'www.example.com',
    sk: 'REWRITE#00150',
    type: 'frMatchRule',
    matches: [
      {
        matchType: 'path',
        matchOperator: 'contains',
        matchValue: '/legacy/',
        negate: false,
        caseSensitive: false,
      },
    ],
    forwardSettings: {
      origin: {
        custom: {
          domainName: 'legacy-backend.internal.example.com',
          path: '',
          port: 443,
          protocol: 'https-only',
          sslProtocols: ['TLSv1.2'],
          readTimeout: 30,
          keepaliveTimeout: 5,
          customHeaders: {},
        },
      },
      pathAndQS: '/api/v1/legacy',
      useIncomingQueryString: true,
    },
    disabled: false,
  },

  // ---- assets.example.com ----
  {
    pk: 'assets.example.com',
    sk: 'REWRITE#00050',
    type: 'frMatchRule',
    matches: [
      {
        matchType: 'path',
        matchOperator: 'contains',
        matchValue: '/downloads/',
        negate: false,
        caseSensitive: false,
      },
    ],
    forwardSettings: {
      origin: {
        s3: {
          authMethod: 'origin-access-identity',
          region: 'us-east-1',
          domainName: 'example-assets.s3.us-east-1.amazonaws.com',
          path: '',
          customHeaders: {},
        },
      },
      useIncomingQueryString: false,
    },
    disabled: false,
  },
  {
    pk: 'assets.example.com',
    sk: 'REDIRECT#00100',
    type: 'erMatchRule',
    statusCode: 301,
    redirectURL: 'https://cdn.example.com',
    useRelativeUrl: 'absolute_url',
    useIncomingQueryString: true,
    matches: [
      {
        matchType: 'hostname',
        matchOperator: 'equals',
        matchValue: 'static.example.com',
        negate: false,
        caseSensitive: false,
      },
    ],
    disabled: false,
  },

  // ---- shop.example.com ----
  {
    pk: 'shop.example.com',
    sk: 'REDIRECT#00100',
    type: 'erMatchRule',
    statusCode: 301,
    redirectURL: 'https://shop.example.com/collections/all',
    useRelativeUrl: 'absolute_url',
    useIncomingQueryString: false,
    matches: [
      {
        matchType: 'path',
        matchOperator: 'equals',
        matchValue: '/products',
        negate: false,
        caseSensitive: false,
      },
    ],
    disabled: false,
  },
  {
    pk: 'shop.example.com',
    sk: 'REDIRECT#00250',
    type: 'erMatchRule',
    statusCode: 302,
    redirectURL: '/maintenance',
    useRelativeUrl: 'relative_url',
    matches: [
      {
        matchType: 'header',
        matchOperator: 'equals',
        matchValue: 'true',
        headerName: 'x-maintenance',
        negate: false,
        caseSensitive: false,
      },
    ],
    disabled: false,
  },

  // ---- blog.example.com (no rules → sits empty when created) ----
];

/** Distinct hosts present in the current data set. */
export function hostsFromRules(rules: Rule[]): string[] {
  return Array.from(new Set(rules.map((r) => r.pk))).sort();
}
