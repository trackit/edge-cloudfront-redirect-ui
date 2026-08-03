import { useState } from "react";
import { Link } from "react-router-dom";
import Brand from "./Brand";
import DistributionFields from "./DistributionFields";
import { SAMPLE_DISTRIBUTION, emptyDistribution } from "../distribution";
import type { Distribution } from "../types";
import { IconArrow, IconBolt, IconServer, IconSliders } from "./icons";

interface Props {
  onConnect: (d: Distribution) => void;
}

const STEPS = [
  {
    icon: <IconServer size={16} />,
    title: "Connect",
    desc: "Point EdgeRoute at your CloudFront distribution and its DynamoDB table.",
  },
  {
    icon: <IconSliders size={16} />,
    title: "Add rules",
    desc: "Create redirects and rewrites per host — no code, no redeploy.",
  },
  {
    icon: <IconBolt size={16} />,
    title: "Go live",
    desc: "Changes reach the edge in about a minute.",
  },
];

/* Ticket: MVP - Front — Console + env configuration, the "no env available"
   half. Explains EdgeRoute on the left, takes the distribution details on the
   right. Shown until a distribution is connected. */
export default function OnboardingScreen({ onConnect }: Props) {
  const [d, setD] = useState<Distribution>(emptyDistribution);

  const distributionId = d.distributionId.trim();
  const tableName = d.tableName.trim();
  const valid = distributionId !== "" && tableName !== "";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onConnect({ distributionId, tableName, region: d.region });
  };

  return (
    <div className="onboard">
      <div className="onboard-shell">
        {/* left — what this is */}
        <aside className="onboard-aside">
          <Brand />
          <h2 className="oa-title">
            Redirects &amp; rewrites,
            <br />
            without touching code.
          </h2>
          <ul className="oa-steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="oa-step-ico">{s.icon}</span>
                <span>
                  <span className="oa-step-title">
                    {i + 1}. {s.title}
                  </span>
                  <span className="oa-step-desc">{s.desc}</span>
                </span>
              </li>
            ))}
          </ul>
          <Link to="/" className="oa-back-home">
            ← Back to home
          </Link>
        </aside>

        {/* right — the details we need */}
        <div className="onboard-main">
          <form className="onboard-connect" onSubmit={submit}>
            <h1>Connect your distribution</h1>
            <p className="onboard-sub">
              The CloudFront distribution EdgeRoute is attached to, and the
              DynamoDB table that stores its rules.
            </p>

            <div className="onboard-form">
              <DistributionFields
                value={d}
                onChange={(patch) => setD((prev) => ({ ...prev, ...patch }))}
              />
            </div>

            <div className="onboard-actions">
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => setD(SAMPLE_DISTRIBUTION)}
              >
                Use sample values
              </button>
              <button
                className="btn btn-primary btn-lg"
                type="submit"
                disabled={!valid}
                style={!valid ? { opacity: 0.5 } : undefined}
              >
                Connect <IconArrow size={18} />
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
