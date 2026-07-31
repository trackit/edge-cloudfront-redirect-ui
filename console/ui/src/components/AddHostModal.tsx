import { useState } from 'react';
import { IconClose, IconGlobe } from './icons';

interface Props {
  existing: string[];
  onClose: () => void;
  onAdd: (host: string) => void;
}

/* Small centered modal to register a new host (domain) in the console. */
export default function AddHostModal({ existing, onClose, onAdd }: Props) {
  const [value, setValue] = useState('');

  // strip protocol / trailing slash / path if pasted from a URL
  const clean = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');

  const isHostname = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/.test(clean);
  const duplicate = existing.includes(clean);
  const valid = isHostname && !duplicate;

  const error =
    clean === ''
      ? null
      : !isHostname
        ? 'Enter a valid domain, e.g. www.example.com'
        : duplicate
          ? 'That host already exists.'
          : null;

  const submit = () => {
    if (valid) onAdd(clean);
  };

  return (
    <div className="overlay center" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h2>Add a host</h2>
            <p className="sub">A domain served by your CloudFront distribution</p>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            <IconClose size={18} />
          </button>
        </div>

        <div style={{ padding: '22px 24px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Host name</label>
            <div className="search" style={{ padding: '10px 12px' }}>
              <IconGlobe size={16} />
              <input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="shop.example.com"
                style={{ fontFamily: 'var(--mono)' }}
              />
            </div>
            {error ? (
              <div className="hint" style={{ color: 'var(--red)' }}>
                {error}
              </div>
            ) : (
              <div className="hint">
                This is the incoming domain rules apply to — not the redirect
                destination.
              </div>
            )}
          </div>
        </div>

        <div className="drawer-foot">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={!valid}
            style={!valid ? { opacity: 0.5 } : undefined}
          >
            Add host
          </button>
        </div>
      </div>
    </div>
  );
}
