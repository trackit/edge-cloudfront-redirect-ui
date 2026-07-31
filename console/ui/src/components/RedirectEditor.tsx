import { useState } from 'react';
import type { MatchCondition, RedirectRule } from '../types';
import Drawer from './Drawer';
import Toggle from './Toggle';
import MatchBuilder from './MatchBuilder';

interface Props {
  host: string;
  initial: RedirectRule | null; // null = create
  onClose: () => void;
  onSave: (rule: RedirectRule) => void;
}

const pad = (n: number) => `REDIRECT#${String(n).padStart(5, '0')}`;

/* Ticket: Front — Redirect editor. Create/edit a 301/302 redirect rule. */
export default function RedirectEditor({
  host,
  initial,
  onClose,
  onSave,
}: Props) {
  const [statusCode, setStatusCode] = useState<301 | 302>(
    initial?.statusCode ?? 301,
  );
  const [redirectURL, setRedirectURL] = useState(initial?.redirectURL ?? '');
  const [useRelative, setUseRelative] = useState(
    initial?.useRelativeUrl === 'relative_url',
  );
  const [useQS, setUseQS] = useState(initial?.useIncomingQueryString ?? true);
  const [disabled, setDisabled] = useState(initial?.disabled ?? false);
  const [priority, setPriority] = useState<number>(
    initial ? parseInt(initial.sk.split('#')[1], 10) : 100,
  );
  const [matches, setMatches] = useState<MatchCondition[]>(
    initial?.matches ?? [
      {
        matchType: 'path',
        matchOperator: 'equals',
        matchValue: '',
        negate: false,
        caseSensitive: false,
      },
    ],
  );

  const errors: string[] = [];
  if (!redirectURL.trim()) errors.push('Redirect URL is required.');
  if (matches.length === 0) errors.push('Add at least one match condition.');
  matches.forEach((m, i) => {
    if (!m.matchValue.trim())
      errors.push(`Condition ${i + 1}: value is required.`);
    if (m.matchType === 'header' && !m.headerName?.trim())
      errors.push(`Condition ${i + 1}: header name is required.`);
  });

  const save = () => {
    const rule: RedirectRule = {
      pk: host,
      sk: pad(priority),
      type: 'erMatchRule',
      statusCode,
      redirectURL: redirectURL.trim(),
      useRelativeUrl: useRelative ? 'relative_url' : 'absolute_url',
      useIncomingQueryString: useQS,
      matches,
      disabled,
    };
    onSave(rule);
  };

  return (
    <Drawer
      title={initial ? 'Edit redirect' : 'New redirect'}
      subtitle={`${host} · ${statusCode} redirect`}
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
            {initial ? 'Save changes' : 'Create redirect'}
          </button>
        </>
      }
    >
      <div className="section-label">Destination</div>

      <div className="row">
        <div className="field">
          <label>Status code</label>
          <select
            className="select"
            value={statusCode}
            onChange={(e) =>
              setStatusCode(Number(e.target.value) as 301 | 302)
            }
          >
            <option value={301}>301 — Moved Permanently</option>
            <option value={302}>302 — Found (temporary)</option>
          </select>
        </div>
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
      </div>

      <div className="field">
        <label>Redirect URL</label>
        <input
          className="input mono"
          placeholder="https://www.example.com/new-landing"
          value={redirectURL}
          onChange={(e) => setRedirectURL(e.target.value)}
        />
      </div>

      <Toggle
        label="Relative URL"
        description="Redirect to a path on the same host instead of an absolute URL."
        checked={useRelative}
        onChange={setUseRelative}
      />
      <Toggle
        label="Keep incoming query string"
        description="Append the visitor's original ?query to the redirect target."
        checked={useQS}
        onChange={setUseQS}
      />

      <div className="section-label">Match conditions</div>
      <MatchBuilder matches={matches} onChange={setMatches} />

      <div className="section-label">Status</div>
      <Toggle
        label="Disabled"
        description="Disabled rules are skipped at the edge (kept for later)."
        checked={disabled}
        onChange={setDisabled}
      />
    </Drawer>
  );
}
