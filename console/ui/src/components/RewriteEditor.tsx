import { useState } from 'react';
import type {
  CustomOrigin,
  MatchCondition,
  RewriteRule,
  S3Origin,
} from '../types';
import Drawer from './Drawer';
import Toggle from './Toggle';
import MatchBuilder from './MatchBuilder';
import { IconInfo } from './icons';

interface Props {
  host: string;
  initial: RewriteRule | null; // null = create
  onClose: () => void;
  onSave: (rule: RewriteRule) => void;
}

type OriginKind = 'custom' | 's3';

const pad = (n: number) => `REWRITE#${String(n).padStart(5, '0')}`;

const emptyS3 = (init?: S3Origin): S3Origin => ({
  authMethod: init?.authMethod ?? 'origin-access-identity',
  region: init?.region ?? 'us-east-1',
  domainName: init?.domainName ?? '',
  path: init?.path ?? '',
  customHeaders: init?.customHeaders ?? {},
});

const emptyCustom = (init?: CustomOrigin): CustomOrigin => ({
  domainName: init?.domainName ?? '',
  path: init?.path ?? '',
  port: init?.port ?? 443,
  protocol: init?.protocol ?? 'https-only',
  sslProtocols: init?.sslProtocols ?? ['TLSv1.2'],
  readTimeout: init?.readTimeout ?? 30,
  keepaliveTimeout: init?.keepaliveTimeout ?? 5,
  customHeaders: init?.customHeaders ?? {},
});

/* Ticket: Front — Rewrite editor. Create/edit an origin-request rewrite rule. */
export default function RewriteEditor({ host, initial, onClose, onSave }: Props) {
  const initialKind: OriginKind = initial?.forwardSettings.origin?.s3
    ? 's3'
    : 'custom';

  const [kind, setKind] = useState<OriginKind>(initialKind);
  const [s3, setS3] = useState<S3Origin>(
    emptyS3(initial?.forwardSettings.origin?.s3),
  );
  const [custom, setCustom] = useState<CustomOrigin>(
    emptyCustom(initial?.forwardSettings.origin?.custom),
  );
  const [pathAndQS, setPathAndQS] = useState(
    initial?.forwardSettings.pathAndQS ?? '',
  );
  const [useQS, setUseQS] = useState(
    initial?.forwardSettings.useIncomingQueryString ?? true,
  );
  const [disabled, setDisabled] = useState(initial?.disabled ?? false);
  const [priority, setPriority] = useState<number>(
    initial ? parseInt(initial.sk.split('#')[1], 10) : 100,
  );
  const [matches, setMatches] = useState<MatchCondition[]>(
    initial?.matches ?? [
      {
        matchType: 'path',
        matchOperator: 'contains',
        matchValue: '',
        negate: false,
        caseSensitive: false,
      },
    ],
  );

  const errors: string[] = [];
  const originDomain = kind === 's3' ? s3.domainName : custom.domainName;
  if (!originDomain.trim() && !pathAndQS.trim())
    errors.push('Set an origin domain or a rewritten path.');
  matches.forEach((m, i) => {
    if (!m.matchValue.trim())
      errors.push(`Condition ${i + 1}: value is required.`);
    if (m.matchType === 'header' && !m.headerName?.trim())
      errors.push(`Condition ${i + 1}: header name is required.`);
  });

  const save = () => {
    const rule: RewriteRule = {
      pk: host,
      sk: pad(priority),
      type: 'frMatchRule',
      matches,
      forwardSettings: {
        origin: kind === 's3' ? { s3 } : { custom },
        pathAndQS: pathAndQS.trim() || undefined,
        useIncomingQueryString: useQS,
      },
      disabled,
    };
    onSave(rule);
  };

  return (
    <Drawer
      title={initial ? 'Edit rewrite' : 'New rewrite'}
      subtitle={`${host} · origin rewrite`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={errors.length > 0}
            style={errors.length > 0 ? { opacity: 0.5 } : undefined}
            title={errors.length > 0 ? errors.join('\n') : undefined}
          >
            {initial ? 'Save changes' : 'Create rewrite'}
          </button>
        </>
      }
    >
      <div className="info-callout">
        <IconInfo size={16} />
        <span>
          Rewrites are invisible to the user — they change where CloudFront
          fetches content from, without changing the URL in the browser.
        </span>
      </div>

      <div className="section-label">Target origin</div>
      <div className="origin-tabs">
        <button
          className={`origin-tab ${kind === 'custom' ? 'active' : ''}`}
          onClick={() => setKind('custom')}
        >
          <div className="ot-title">Custom origin</div>
          <div className="ot-desc">Any HTTP(S) backend</div>
        </button>
        <button
          className={`origin-tab ${kind === 's3' ? 'active' : ''}`}
          onClick={() => setKind('s3')}
        >
          <div className="ot-title">S3 origin</div>
          <div className="ot-desc">An S3 bucket</div>
        </button>
      </div>

      {kind === 's3' ? (
        <>
          <div className="field">
            <label>Bucket domain name</label>
            <input
              className="input mono"
              placeholder="example-assets.s3.us-east-1.amazonaws.com"
              value={s3.domainName}
              onChange={(e) => setS3({ ...s3, domainName: e.target.value })}
            />
          </div>
          <div className="row">
            <div className="field">
              <label>Auth method</label>
              <select
                className="select"
                value={s3.authMethod}
                onChange={(e) =>
                  setS3({
                    ...s3,
                    authMethod: e.target.value as S3Origin['authMethod'],
                    region:
                      e.target.value === 'origin-access-identity'
                        ? (s3.region ?? 'us-east-1')
                        : undefined,
                  })
                }
              >
                <option value="origin-access-identity">
                  Origin Access Identity
                </option>
                <option value="none">None (public)</option>
              </select>
            </div>
            <div className="field">
              <label>Region</label>
              <input
                className="input mono"
                placeholder="us-east-1"
                value={s3.region ?? ''}
                disabled={s3.authMethod === 'none'}
                onChange={(e) => setS3({ ...s3, region: e.target.value })}
              />
              <div className="hint">Required for Origin Access Identity.</div>
            </div>
          </div>
          <div className="field">
            <label>Origin path</label>
            <input
              className="input mono"
              placeholder="(optional) /prefix"
              value={s3.path}
              onChange={(e) => setS3({ ...s3, path: e.target.value })}
            />
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label>Domain name</label>
            <input
              className="input mono"
              placeholder="legacy-backend.internal.example.com"
              value={custom.domainName}
              onChange={(e) =>
                setCustom({ ...custom, domainName: e.target.value })
              }
            />
          </div>
          <div className="row-3">
            <div className="field">
              <label>Protocol</label>
              <select
                className="select"
                value={custom.protocol}
                onChange={(e) =>
                  setCustom({
                    ...custom,
                    protocol: e.target.value as CustomOrigin['protocol'],
                  })
                }
              >
                {['https-only', 'http-only', 'match-viewer', 'https', 'http'].map(
                  (p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ),
                )}
              </select>
            </div>
            <div className="field">
              <label>Port</label>
              <input
                className="input mono"
                type="number"
                value={custom.port}
                onChange={(e) =>
                  setCustom({ ...custom, port: Number(e.target.value) })
                }
              />
            </div>
            <div className="field">
              <label>Origin path</label>
              <input
                className="input mono"
                placeholder="(optional)"
                value={custom.path}
                onChange={(e) => setCustom({ ...custom, path: e.target.value })}
              />
            </div>
          </div>
          <div className="row-3">
            <div className="field">
              <label>Read timeout (s)</label>
              <input
                className="input mono"
                type="number"
                value={custom.readTimeout}
                onChange={(e) =>
                  setCustom({ ...custom, readTimeout: Number(e.target.value) })
                }
              />
            </div>
            <div className="field">
              <label>Keepalive (s)</label>
              <input
                className="input mono"
                type="number"
                value={custom.keepaliveTimeout}
                onChange={(e) =>
                  setCustom({
                    ...custom,
                    keepaliveTimeout: Number(e.target.value),
                  })
                }
              />
            </div>
            <div className="field">
              <label>SSL protocols</label>
              <input
                className="input mono"
                placeholder="TLSv1.2"
                value={custom.sslProtocols.join(', ')}
                onChange={(e) =>
                  setCustom({
                    ...custom,
                    sslProtocols: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
          </div>
        </>
      )}

      <div className="section-label">Forwarded path</div>
      <div className="field">
        <label>Rewritten path &amp; query string</label>
        <input
          className="input mono"
          placeholder="/api/v1/legacy"
          value={pathAndQS}
          onChange={(e) => setPathAndQS(e.target.value)}
        />
        <div className="hint">
          The path the request is forwarded with. Leave empty to keep the
          incoming path.
        </div>
      </div>
      <Toggle
        label="Keep incoming query string"
        description="Forward the visitor's original ?query to the origin."
        checked={useQS}
        onChange={setUseQS}
      />

      <div className="section-label">Match conditions</div>
      <MatchBuilder matches={matches} onChange={setMatches} />

      <div className="section-label">Priority &amp; status</div>
      <div className="field">
        <label>Priority</label>
        <input
          className="input mono"
          type="number"
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
        />
        <div className="hint">Lower = higher priority · {pad(priority)}</div>
      </div>
      <Toggle
        label="Disabled"
        description="Disabled rules are skipped at the edge (kept for later)."
        checked={disabled}
        onChange={setDisabled}
      />
    </Drawer>
  );
}
