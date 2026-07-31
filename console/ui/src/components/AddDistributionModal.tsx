import { useState } from 'react';
import DistributionFields from './DistributionFields';
import { SAMPLE_DISTRIBUTION } from '../mockData';
import { IconClose } from './icons';
import type { Distribution } from '../types';

interface Props {
  existingIds: string[];
  onClose: () => void;
  onAdd: (d: Distribution) => void;
}

/* Add another CloudFront distribution to switch between. */
export default function AddDistributionModal({
  existingIds,
  onClose,
  onAdd,
}: Props) {
  const [d, setD] = useState<Distribution>({
    distributionId: '',
    tableName: '',
    region: 'us-east-1',
  });

  const id = d.distributionId.trim();
  const duplicate = existingIds.includes(id);
  const valid = id !== '' && d.tableName.trim() !== '' && !duplicate;

  return (
    <div className="overlay center" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h2>Add a distribution</h2>
            <p className="sub">Connect another CloudFront distribution</p>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            <IconClose size={18} />
          </button>
        </div>

        <div style={{ padding: '22px 24px' }}>
          <DistributionFields
            value={d}
            onChange={(patch) => setD((prev) => ({ ...prev, ...patch }))}
          />
          {duplicate && (
            <div className="hint" style={{ color: 'var(--red)' }}>
              This distribution is already connected.
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <button
            className="btn btn-ghost"
            onClick={() => setD(SAMPLE_DISTRIBUTION)}
            style={{ marginRight: 'auto' }}
          >
            Use sample
          </button>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!valid}
            style={!valid ? { opacity: 0.5 } : undefined}
            onClick={() =>
              onAdd({
                distributionId: id,
                tableName: d.tableName.trim(),
                region: d.region,
              })
            }
          >
            Add distribution
          </button>
        </div>
      </div>
    </div>
  );
}
