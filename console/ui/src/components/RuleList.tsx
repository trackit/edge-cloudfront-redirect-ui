import { useMemo, useRef, useState } from 'react';
import type { Rule } from '../types';
import { isRedirect, priorityOf } from '../types';
import { describeMatch, ruleFrom, ruleTo } from './ruleSummary';
import { IconArrow, IconEdit, IconTrash, IconPlus, IconGrip } from './icons';

type Filter = 'all' | 'redirect' | 'rewrite';

interface Props {
  host: string | null;
  rules: Rule[];
  loading: boolean;
  onEdit: (rule: Rule) => void;
  onDelete: (rule: Rule) => void;
  onToggle: (rule: Rule) => void;
  onCreate: (type: 'redirect' | 'rewrite') => void;
  /** Enable drag-to-reorder (off by default). */
  reorderable?: boolean;
  /** Called with all rules of one host+type in their new order after a drag. */
  onReprioritize?: (orderedOfType: Rule[]) => void;
}

function reorderTo<T>(arr: T[], from: number, insertion: number): T[] {
  const next = arr.slice();
  const [moved] = next.splice(from, 1);
  const idx = insertion > from ? insertion - 1 : insertion;
  next.splice(idx, 0, moved);
  return next;
}

/* Ticket: Front — Host & rule list. Redirects and rewrites are shown as
   separate groups (independent priority sequences: viewer-request vs
   origin-request). */
export default function RuleList({
  host,
  rules,
  loading,
  onEdit,
  onDelete,
  onToggle,
  onCreate,
  reorderable = false,
  onReprioritize,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all');

  const { redirects, rewrites } = useMemo(() => {
    const byPrio = (a: Rule, b: Rule) => priorityOf(a.sk) - priorityOf(b.sk);
    return {
      redirects: rules.filter(isRedirect).sort(byPrio),
      rewrites: rules.filter((r) => !isRedirect(r)).sort(byPrio),
    };
  }, [rules]);

  if (loading) {
    return (
      <div className="rules">
        {[0, 1, 2, 3].map((i) => (
          <div className="skeleton" key={i} />
        ))}
      </div>
    );
  }

  if (!host) {
    return (
      <div className="empty">
        <div className="emo">👈</div>
        <h3>Pick a host</h3>
        <p>Select a host on the left to see its redirect and rewrite rules.</p>
      </div>
    );
  }

  if (rules.length === 0) {
    return (
      <div className="empty">
        <div className="emo">🗺️</div>
        <h3>No rules yet</h3>
        <p>
          <span className="mono">{host}</span> has no rules. Create the first
          one.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button
            className="btn btn-primary"
            onClick={() => onCreate('redirect')}
          >
            <IconPlus size={16} /> New redirect
          </button>
          <button className="btn btn-ghost" onClick={() => onCreate('rewrite')}>
            <IconPlus size={16} /> New rewrite
          </button>
        </div>
      </div>
    );
  }

  const showRedirects = filter !== 'rewrite' && redirects.length > 0;
  const showRewrites = filter !== 'redirect' && rewrites.length > 0;

  return (
    <div className="rules">
      <div className="rules-toolbar">
        <div className="seg">
          {(['all', 'redirect', 'rewrite'] as Filter[]).map((f) => (
            <button
              key={f}
              className={filter === f ? 'active' : ''}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f === 'redirect' ? 'Redirects' : 'Rewrites'}
            </button>
          ))}
        </div>
        <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          ordered by priority · lower = higher
        </span>
      </div>

      {showRedirects && (
        <RuleGroup
          title="Redirects"
          phase="viewer-request"
          rules={redirects}
          reorderable={reorderable}
          onEdit={onEdit}
          onDelete={onDelete}
          onToggle={onToggle}
          onReprioritize={onReprioritize}
        />
      )}
      {showRewrites && (
        <RuleGroup
          title="Rewrites"
          phase="origin-request"
          rules={rewrites}
          reorderable={reorderable}
          onEdit={onEdit}
          onDelete={onDelete}
          onToggle={onToggle}
          onReprioritize={onReprioritize}
        />
      )}
    </div>
  );
}

function RuleGroup({
  title,
  phase,
  rules,
  reorderable,
  onEdit,
  onDelete,
  onToggle,
  onReprioritize,
}: {
  title: string;
  phase: string;
  rules: Rule[];
  reorderable: boolean;
  onEdit: (r: Rule) => void;
  onDelete: (r: Rule) => void;
  onToggle: (r: Rule) => void;
  onReprioritize?: (ordered: Rule[]) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [below, setBelow] = useState(false);

  const clear = () => {
    setDragIndex(null);
    setOverIndex(null);
    setBelow(false);
  };

  // pointer-based drag: reliable across browsers, no native HTML5 DnD lifecycle
  const startDrag = (e: React.PointerEvent, i: number) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragIndex(i);
    setOverIndex(i);
  };

  const moveDrag = (e: React.PointerEvent) => {
    if (dragIndex === null || !listRef.current) return;
    const cards = Array.from(listRef.current.children) as HTMLElement[];
    for (let k = 0; k < cards.length; k++) {
      const r = cards[k].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        if (overIndex !== k) setOverIndex(k);
        if (below !== false) setBelow(false);
        return;
      }
    }
    if (overIndex !== cards.length - 1) setOverIndex(cards.length - 1);
    if (below !== true) setBelow(true);
  };

  const endDrag = () => {
    if (dragIndex !== null && overIndex !== null) {
      const insertion = below ? overIndex + 1 : overIndex;
      const reordered = reorderTo(rules, dragIndex, insertion);
      if (reordered.some((r, k) => r !== rules[k])) onReprioritize?.(reordered);
    }
    clear();
  };

  return (
    <div className="rule-group">
      <div className="rules-group-head">
        <span className="rgh-title">{title}</span>
        <span className="count-chip">{rules.length}</span>
        <span className="rgh-phase">{phase}</span>
      </div>

      <div ref={listRef}>
        {rules.map((rule, i) => {
          const redirect = isRedirect(rule);
          const showBar = reorderable && overIndex === i && dragIndex !== null;
          const cls = [
            'rule-card',
            rule.disabled ? 'is-disabled' : '',
            dragIndex === i ? 'dragging' : '',
            showBar ? (below ? 'drop-after' : 'drop-before') : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div className={cls} key={rule.sk + rule.pk}>
              {reorderable && (
                <span
                  className="grip"
                  title="Drag to reorder"
                  onPointerDown={(e) => startDrag(e, i)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                >
                  <IconGrip size={16} />
                </span>
              )}

              <div className="rule-prio">{priorityOf(rule.sk)}</div>

              <div className="rule-body">
                <div className="rule-line1">
                  <span
                    className={`badge ${redirect ? 'badge-redirect' : 'badge-rewrite'}`}
                  >
                    {redirect ? `${rule.statusCode} redirect` : 'rewrite'}
                  </span>
                  <span
                    className={`badge ${rule.disabled ? 'badge-off' : 'badge-on'}`}
                  >
                    <span className="badge-dot" />
                    {rule.disabled ? 'disabled' : 'enabled'}
                  </span>
                </div>

                <div className="rule-summary">
                  <span className="from">{ruleFrom(rule)}</span>
                  <span className="arrow">
                    <IconArrow size={15} />
                  </span>
                  <span className="to">{ruleTo(rule)}</span>
                </div>

                <div className="rule-cond" style={{ marginTop: 6 }}>
                  {rule.matches.map(describeMatch).join('  ·  ') || 'matches any'}
                </div>
              </div>

              <div className="rule-actions">
                <button
                  title={rule.disabled ? 'Enable' : 'Disable'}
                  onClick={() => onToggle(rule)}
                  style={{ border: 0, background: 'transparent', padding: 0 }}
                >
                  <span className={`switch ${rule.disabled ? '' : 'on'}`} />
                </button>
                <button
                  className="icon-btn"
                  title="Edit"
                  onClick={() => onEdit(rule)}
                >
                  <IconEdit size={16} />
                </button>
                <button
                  className="icon-btn danger"
                  title="Delete"
                  onClick={() => onDelete(rule)}
                >
                  <IconTrash size={16} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
