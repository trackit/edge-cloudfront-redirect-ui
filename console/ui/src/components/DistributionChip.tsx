import { useEffect, useRef, useState } from 'react';
import type { Distribution } from '../types';
import {
  IconServer,
  IconChevron,
  IconCheck,
  IconPlus,
  IconSliders,
} from './icons';

interface Props {
  distributions: Distribution[];
  current: Distribution;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onOpenSettings: () => void;
}

/* Distribution switcher: shows the current distribution, and a dropdown to
   switch between connected distributions, add one, or open Settings. */
export default function DistributionChip({
  distributions,
  current,
  onSelect,
  onAdd,
  onOpenSettings,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div className="target-switch" ref={ref}>
      <button className="dist-chip" onClick={() => setOpen((o) => !o)}>
        <span className="dist-ico">
          <IconServer size={15} />
        </span>
        <span className="dist-meta">
          <span className="dist-id mono">{current.distributionId}</span>
          <span className="dist-table mono">
            {current.tableName} · {current.region}
          </span>
        </span>
        <span className="dist-gear">
          <IconChevron size={14} />
        </span>
      </button>

      {open && (
        <div className="target-menu">
          <div className="target-menu-head">Distributions</div>
          {distributions.map((d) => (
            <button
              key={d.distributionId}
              className={`target-item ${
                d.distributionId === current.distributionId ? 'active' : ''
              }`}
              onClick={() => {
                onSelect(d.distributionId);
                setOpen(false);
              }}
            >
              <span className="dist-ico">
                <IconServer size={14} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div className="mono" style={{ fontWeight: 700 }}>
                  {d.distributionId}
                </div>
                <div className="t-meta">
                  {d.tableName} · {d.region}
                </div>
              </span>
              {d.distributionId === current.distributionId && (
                <span style={{ color: 'var(--orange)' }}>
                  <IconCheck size={16} />
                </span>
              )}
            </button>
          ))}
          <div className="target-menu-foot">
            <button
              className="target-item"
              onClick={() => {
                onAdd();
                setOpen(false);
              }}
            >
              <IconPlus size={16} /> Add distribution
            </button>
            <button
              className="target-item"
              onClick={() => {
                onOpenSettings();
                setOpen(false);
              }}
            >
              <IconSliders size={16} /> Settings for current
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
