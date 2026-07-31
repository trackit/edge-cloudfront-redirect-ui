import { useMemo, useState } from 'react';
import type { Rule } from '../types';
import { isRedirect } from '../types';
import { IconSearch, IconPlus, IconTrash } from './icons';

interface Props {
  rules: Rule[];
  hosts?: string[];
  selectedHost: string | null;
  onSelectHost: (host: string) => void;
  onAddHost?: () => void;
  onDeleteHost?: (host: string) => void;
}

/* Ticket: Front — Host & rule list (the host panel + search half). */
export default function Sidebar({
  rules,
  hosts: hostsProp,
  selectedHost,
  onSelectHost,
  onAddHost,
  onDeleteHost,
}: Props) {
  const [q, setQ] = useState('');

  const hosts = useMemo(() => {
    const map = new Map<string, { redirects: number; rewrites: number }>();
    for (const h of hostsProp ?? []) map.set(h, { redirects: 0, rewrites: 0 });
    for (const r of rules) {
      const e = map.get(r.pk) ?? { redirects: 0, rewrites: 0 };
      if (isRedirect(r)) e.redirects++;
      else e.rewrites++;
      map.set(r.pk, e);
    }
    return Array.from(map.entries())
      .map(([host, counts]) => ({ host, ...counts }))
      .filter((h) => h.host.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => a.host.localeCompare(b.host));
  }, [rules, hostsProp, q]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title">
          <h3>Hosts</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="count-chip">{hosts.length}</span>
            {onAddHost && (
              <button
                className="icon-btn"
                title="Add a host"
                onClick={onAddHost}
                style={{ width: 28, height: 28 }}
              >
                <IconPlus size={15} />
              </button>
            )}
          </div>
        </div>
        <div className="search">
          <IconSearch size={15} />
          <input
            placeholder="Search hosts…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      <div className="host-list">
        {hosts.length === 0 && (
          <div style={{ padding: 20, color: 'var(--text-dim)', fontSize: 13 }}>
            No host matches “{q}”.
          </div>
        )}
        {hosts.map((h) => (
          <div
            key={h.host}
            className={`host-item ${h.host === selectedHost ? 'active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => onSelectHost(h.host)}
            onKeyDown={(e) => e.key === 'Enter' && onSelectHost(h.host)}
          >
            <span style={{ minWidth: 0 }}>
              <div className="host-name">{h.host}</div>
              <div className="host-sub">
                {h.redirects + h.rewrites} rule
                {h.redirects + h.rewrites !== 1 ? 's' : ''}
              </div>
            </span>
            <span className="host-counts">
              {h.redirects > 0 && (
                <span
                  className="mini-count"
                  style={{
                    background: 'var(--orange-glow)',
                    color: 'var(--orange-600)',
                  }}
                  title={`${h.redirects} redirect(s)`}
                >
                  {h.redirects} R
                </span>
              )}
              {h.rewrites > 0 && (
                <span
                  className="mini-count"
                  style={{
                    background: 'var(--blue-glow)',
                    color: 'var(--blue-600)',
                  }}
                  title={`${h.rewrites} rewrite(s)`}
                >
                  {h.rewrites} W
                </span>
              )}
              {onDeleteHost && (
                <button
                  className="host-del"
                  title="Delete host"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteHost(h.host);
                  }}
                >
                  <IconTrash size={14} />
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}
