import { useEffect } from "react";
import { regionOptions, useRegions } from "../regions";
import type { DistributionDraft } from "../types";

interface Props {
  /** The draft, not a connected Distribution — these fields exist before the
      API has assigned a target id, and none of them can edit one. */
  value: DistributionDraft;
  onChange: (patch: Partial<DistributionDraft>) => void;
  /**
   * True for a draft nobody has connected yet.
   *
   * Its region is only a default `emptyDistribution` picked, so it may be
   * corrected to one this deployment allows. An existing distribution's region
   * is a fact about a table that exists, and is left alone even when the
   * deployment no longer allows it — correcting that would rewrite a setting
   * nobody touched, on a table the console cannot move.
   */
  isNew?: boolean;
}

/* Form fields for a CloudFront distribution and its DynamoDB rules table.
   Shared by onboarding (first connect / add) and the Settings modal. */
export default function DistributionFields({
  value,
  onChange,
  isNew = false,
}: Props) {
  // From the API, not from a list in here: see `regions.ts` for why a copy in
  // the front end is wrong in both directions.
  const regions = useRegions();

  useEffect(() => {
    if (!isNew || regions.length === 0) return;
    if (regions.includes(value.region)) return;
    // The first option as rendered, not `regions[0]`: the list is displayed
    // sorted, and adopting the API's array order would leave the select showing
    // a value that is not its first entry.
    //
    // Converges after one patch, because the next render finds the region in
    // the list — so this cannot loop even with a fresh `onChange` each render.
    onChange({ region: regionOptions(regions, "")[0] });
  }, [isNew, regions, value.region, onChange]);

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
          {regionOptions(regions, value.region).map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <div className="hint">
          Where the table above lives. Only the regions this deployment is
          configured to reach are listed.
        </div>
      </div>
    </>
  );
}
