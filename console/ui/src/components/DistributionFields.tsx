import type { Distribution } from "../types";

interface Props {
  value: Distribution;
  onChange: (patch: Partial<Distribution>) => void;
}

/**
 * A short list rather than every AWS region: these are the ones the rules table
 * is realistically in. The console API validates `region` against its own
 * curated list, which a deployment can override via `allowed_regions` — when the
 * two are wired together this should come from the API, not from here.
 */
const REGIONS = [
  "us-east-1",
  "us-west-2",
  "eu-west-1",
  "eu-central-1",
  "ap-southeast-1",
  "ap-northeast-1",
];

/* Form fields for a CloudFront distribution and its DynamoDB rules table.
   Used by onboarding, and by Settings once that ticket lands. */
export default function DistributionFields({ value, onChange }: Props) {
  return (
    <>
      <div className="field">
        <label htmlFor="distributionId">CloudFront distribution</label>
        <input
          id="distributionId"
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
        <label htmlFor="tableName">DynamoDB routing table</label>
        <input
          id="tableName"
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
        <label htmlFor="region">Table region</label>
        <select
          id="region"
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
