import type { Distribution } from '../types';

interface Props {
  value: Distribution;
  onChange: (patch: Partial<Distribution>) => void;
}

const REGIONS = [
  'us-east-1',
  'us-west-2',
  'eu-west-1',
  'eu-central-1',
  'ap-southeast-1',
  'ap-northeast-1',
];

/* Shared form fields for connecting/editing a CloudFront distribution + its
   DynamoDB routing table. Used by onboarding and settings. */
export default function DistributionFields({ value, onChange }: Props) {
  return (
    <>
      <div className="field">
        <label>CloudFront distribution</label>
        <input
          className="input mono"
          placeholder="E2QWERTY123456  (ID or ARN)"
          value={value.distributionId}
          onChange={(e) => onChange({ distributionId: e.target.value })}
        />
        <div className="hint">
          The distribution ID (or full ARN) of the CloudFront distribution
          EdgeRoute is attached to.
        </div>
      </div>

      <div className="field">
        <label>DynamoDB routing table</label>
        <input
          className="input mono"
          placeholder="edgeroute-rules"
          value={value.tableName}
          onChange={(e) => onChange({ tableName: e.target.value })}
        />
        <div className="hint">
          The table that stores the redirect / rewrite rules for this
          distribution.
        </div>
      </div>

      <div className="field">
        <label>Table region</label>
        <select
          className="select"
          value={value.region}
          onChange={(e) => onChange({ region: e.target.value })}
        >
          {REGIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
