import type { MatchCondition, MatchOperator, MatchType } from '../types';
import { IconPlus, IconTrash } from './icons';

interface Props {
  matches: MatchCondition[];
  onChange: (matches: MatchCondition[]) => void;
}

const TYPES: MatchType[] = [
  'path',
  'hostname',
  'protocol',
  'regex',
  'header',
  'cookie',
];
const OPERATORS: MatchOperator[] = ['equals', 'contains', 'regex'];

/* Shared matches[] builder used by both the redirect and rewrite editors.
   Ticket: Front — Redirect editor / Rewrite editor. */
export default function MatchBuilder({ matches, onChange }: Props) {
  const update = (i: number, patch: Partial<MatchCondition>) => {
    const next = matches.map((m, idx) => (idx === i ? { ...m, ...patch } : m));
    onChange(next);
  };

  const add = () =>
    onChange([
      ...matches,
      {
        matchType: 'path',
        matchOperator: 'equals',
        matchValue: '',
        negate: false,
        caseSensitive: false,
      },
    ]);

  const remove = (i: number) => onChange(matches.filter((_, idx) => idx !== i));

  return (
    <div>
      {matches.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: '0 0 12px' }}>
          No conditions — this rule would match every request. Add at least one.
        </p>
      )}

      {matches.map((m, i) => (
        <div className="match-card" key={i}>
          <div className="match-card-head">
            <span className="idx">Condition {i + 1}</span>
            <button
              className="icon-btn danger"
              onClick={() => remove(i)}
              title="Remove condition"
              style={{ width: 30, height: 30 }}
            >
              <IconTrash size={15} />
            </button>
          </div>

          <div className="row-3">
            <div className="field" style={{ margin: 0 }}>
              <label>Type</label>
              <select
                className="select"
                value={m.matchType}
                onChange={(e) => {
                  const matchType = e.target.value as MatchType;
                  update(i, {
                    matchType,
                    headerName:
                      matchType === 'header' ? (m.headerName ?? '') : undefined,
                  });
                }}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Operator</label>
              <select
                className="select"
                value={m.matchOperator}
                onChange={(e) =>
                  update(i, { matchOperator: e.target.value as MatchOperator })
                }
              >
                {OPERATORS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Value</label>
              <input
                className="input mono"
                placeholder="/old-path"
                value={m.matchValue}
                onChange={(e) => update(i, { matchValue: e.target.value })}
              />
            </div>
          </div>

          {m.matchType === 'header' && (
            <div className="field" style={{ margin: '12px 0 0' }}>
              <label>Header name</label>
              <input
                className="input mono"
                placeholder="x-custom-header"
                value={m.headerName ?? ''}
                onChange={(e) => update(i, { headerName: e.target.value })}
              />
              <div className="hint">Required when the match type is “header”.</div>
            </div>
          )}

          <div className="chip-toggles">
            <button
              className={`chip-toggle ${m.negate ? 'on' : ''}`}
              onClick={() => update(i, { negate: !m.negate })}
            >
              Negate
            </button>
            <button
              className={`chip-toggle ${m.caseSensitive ? 'on' : ''}`}
              onClick={() => update(i, { caseSensitive: !m.caseSensitive })}
            >
              Case sensitive
            </button>
          </div>
        </div>
      ))}

      <button className="add-match" onClick={add}>
        <IconPlus size={15} /> Add condition
      </button>
    </div>
  );
}
