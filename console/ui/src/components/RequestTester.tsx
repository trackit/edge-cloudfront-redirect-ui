import { useMemo, useState } from 'react';
import type { Rule } from '../types';
import { priorityOf } from '../types';
import { simulate, type SimResult, type TestRequest } from '../simulate';
import Drawer from './Drawer';
import { IconArrow, IconCheck, IconClose } from './icons';

interface Props {
  rules: Rule[];
  hosts: string[];
  defaultHost: string | null;
  onClose: () => void;
}

/* In-browser request simulator: evaluate the mock rules against a fake request
   the way the Lambda@Edge would, and show the outcome + a step-by-step trace. */
export default function RequestTester({
  rules,
  hosts,
  defaultHost,
  onClose,
}: Props) {
  const [host, setHost] = useState(defaultHost ?? hosts[0] ?? '');
  const [protocol, setProtocol] = useState<'https' | 'http'>('https');
  const [path, setPath] = useState('/old-landing');
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');
  const [result, setResult] = useState<SimResult | null>(null);

  const req: TestRequest = useMemo(
    () => ({
      host,
      path,
      protocol,
      headerName: headerName.trim() || undefined,
      headerValue: headerValue.trim() || undefined,
    }),
    [host, path, protocol, headerName, headerValue],
  );

  const run = () => setResult(simulate(rules, req));

  return (
    <Drawer
      title="Test a request"
      subtitle="Evaluate your rules like the edge would — no AWS needed"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" onClick={run}>
            Run test
          </button>
        </>
      }
    >
      {/* the fake request */}
      <div className="section-label">Incoming request</div>
      <div className="field">
        <label>Host</label>
        <input
          className="input mono"
          list="tester-hosts"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="www.example.com"
        />
        <datalist id="tester-hosts">
          {hosts.map((h) => (
            <option key={h} value={h} />
          ))}
        </datalist>
      </div>
      <div className="row">
        <div className="field">
          <label>Protocol</label>
          <select
            className="select"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as 'https' | 'http')}
          >
            <option value="https">https</option>
            <option value="http">http</option>
          </select>
        </div>
        <div className="field">
          <label>Path</label>
          <input
            className="input mono"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/old-landing?ref=x"
          />
        </div>
      </div>

      <div className="field" style={{ marginBottom: 4 }}>
        <label>Optional request header</label>
        <div className="row">
          <input
            className="input mono"
            value={headerName}
            onChange={(e) => setHeaderName(e.target.value)}
            placeholder="x-maintenance"
          />
          <input
            className="input mono"
            value={headerValue}
            onChange={(e) => setHeaderValue(e.target.value)}
            placeholder="true"
          />
        </div>
        <div className="hint">
          Only needed to test rules that match on a header.
        </div>
      </div>

      {/* the request line preview */}
      <div
        className="mono"
        style={{
          marginTop: 14,
          padding: '10px 12px',
          borderRadius: 8,
          background: 'var(--surface-3)',
          color: 'var(--text-soft)',
          fontSize: 12.5,
          wordBreak: 'break-all',
        }}
      >
        {protocol}://{host || 'host'}
        {path || '/'}
      </div>

      {/* result */}
      {result && <Result result={result} />}
    </Drawer>
  );
}

function Result({ result }: { result: SimResult }) {
  return (
    <>
      <div className="section-label" style={{ marginTop: 22 }}>
        Result
      </div>

      {result.outcome === 'redirect' && result.redirect && (
        <div className="sim-result sim-redirect">
          <div className="sim-head">
            <span className="badge badge-redirect">
              {result.redirect.statusCode} redirect
            </span>
            <span className="sim-prio">
              matched priority {priorityOf(result.matchedRule!.sk)}
            </span>
          </div>
          <div className="sim-line">
            <span className="from mono">browser is sent to</span>
            <IconArrow size={15} />
            <span className="to mono">{result.redirect.location}</span>
          </div>
          <p className="sim-note">
            The visitor's browser URL changes to this address.
          </p>
        </div>
      )}

      {result.outcome === 'rewrite' && result.rewrite && (
        <div className="sim-result sim-rewrite">
          <div className="sim-head">
            <span className="badge badge-rewrite">rewrite</span>
            <span className="sim-prio">
              matched priority {priorityOf(result.matchedRule!.sk)}
            </span>
          </div>
          <div className="sim-line">
            <span className="from mono">content fetched from</span>
            <IconArrow size={15} />
            <span className="to mono">{result.rewrite.originLabel}</span>
          </div>
          <div className="sim-line" style={{ marginTop: 6 }}>
            <span className="from mono">forwarded path</span>
            <IconArrow size={15} />
            <span className="to mono">{result.rewrite.pathAndQS}</span>
          </div>
          <p className="sim-note">
            The URL in the browser stays the same — only the origin changes.
          </p>
        </div>
      )}

      {result.outcome === 'passthrough' && (
        <div className="sim-result sim-pass">
          <div className="sim-head">
            <span className="badge badge-off">
              <span className="badge-dot" />
              no match
            </span>
          </div>
          <p className="sim-note" style={{ margin: 0 }}>
            No rule matched. The request passes through to your origin
            unchanged.
          </p>
        </div>
      )}

      {/* evaluation trace */}
      <div className="section-label">Evaluation order</div>
      {result.trace.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          This host has no rules.
        </p>
      )}
      {result.trace.map((t, i) => {
        const win = t.rule === result.matchedRule;
        return (
          <div
            key={i}
            className={`trace-row ${win ? 'win' : ''} ${t.skipped ? 'skip' : ''}`}
          >
            <span className="trace-prio mono">{priorityOf(t.rule.sk)}</span>
            <span className="trace-body">
              <span className="trace-type">
                {t.rule.type === 'erMatchRule' ? 'redirect' : 'rewrite'}
              </span>
              {t.skipped === 'disabled' ? (
                <span className="trace-cond dim">skipped · disabled</span>
              ) : (
                t.conditions.map((c, j) => (
                  <span
                    key={j}
                    className={`trace-cond ${c.passed ? 'ok' : 'no'}`}
                  >
                    {c.passed ? <IconCheck size={12} /> : <IconClose size={12} />}
                    {c.text}
                  </span>
                ))
              )}
            </span>
            {win && <span className="trace-win-tag">winner</span>}
          </div>
        );
      })}
    </>
  );
}
