import { useState } from 'react';
import DistributionFields from './DistributionFields';
import { IconClose } from './icons';
import type { Distribution } from '../types';

interface Props {
  distribution: Distribution;
  onClose: () => void;
  onSave: (d: Distribution) => void;
  onDisconnect: () => void;
}

/* Settings — edit the connected distribution + DynamoDB table, or disconnect. */
export default function SettingsModal({
  distribution,
  onClose,
  onSave,
  onDisconnect,
}: Props) {
  const [d, setD] = useState<Distribution>(distribution);
  const valid = d.distributionId.trim() !== '' && d.tableName.trim() !== '';

  return (
    <div className="overlay center" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h2>Settings</h2>
            <p className="sub">Connected CloudFront distribution</p>
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

          <div className="danger-zone">
            <div>
              <div className="dz-title">Disconnect</div>
              <div className="dz-desc">
                Forget this distribution and return to the first-connection
                screen.
              </div>
            </div>
            <button className="btn btn-danger btn-sm" onClick={onDisconnect}>
              Disconnect
            </button>
          </div>
        </div>

        <div className="drawer-foot">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!valid}
            style={!valid ? { opacity: 0.5 } : undefined}
            onClick={() =>
              onSave({
                distributionId: d.distributionId.trim(),
                tableName: d.tableName.trim(),
                region: d.region,
              })
            }
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
