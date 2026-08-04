import { useState } from "react";
import { Link } from "react-router-dom";
import Brand from "./Brand";
import DistributionFields from "./DistributionFields";
import {
  SAMPLE_DISTRIBUTION,
  connectDistribution,
  emptyDistribution,
} from "../distribution";
import { ApiError } from "../api";
import type { Distribution, DistributionDraft } from "../types";
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

/**
 * A short heading for the failure, so the API's prose is not the only thing the
 * user reads. Codes are stable; messages are not, so the branch is on `code`.
 */
const errorHeading = (error: ApiError): string => {
  switch (error.code) {
    case "NETWORK_ERROR":
      return "Cannot reach the API";
    case "VALIDATION_ERROR":
      return "Check these details";
    case "TARGET_UNREACHABLE":
      return "The API cannot reach that table";
    default:
      return "Could not connect";
  }
};

/* Ticket: MVP - Front — Console + env configuration, the "no env available"
   half. Explains EdgeRoute on the left, takes the distribution details on the
   right. Shown until a distribution is connected. */
export default function OnboardingScreen({ onConnect }: Props) {
  const [d, setD] = useState<DistributionDraft>(emptyDistribution);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const distributionId = d.distributionId.trim();
  const tableName = d.tableName.trim();
  const valid = distributionId !== "" && tableName !== "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || pending) return;

    setPending(true);
    setError(null);
    try {
      // Registers the table with the API, which assigns the target id the rules
      // routes are keyed on. Only after that is there anything worth persisting.
      onConnect(
        await connectDistribution({
          distributionId,
          tableName,
          region: d.region,
        }),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError({
              status: 0,
              code: "MALFORMED_RESPONSE",
              message: "Something went wrong connecting the distribution",
            }),
      );
      setPending(false);
    }
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

            {error !== null && (
              <div className="onboard-error" role="alert">
                <strong>{errorHeading(error)}</strong>
                <span>{error.message}</span>
                {error.details.length > 0 && (
                  <ul>
                    {/* Index as key: several details can share one path, and the
                        capped final entry has none. The list never reorders. */}
                    {error.details.map((detail, i) => (
                      <li key={i}>
                        <span className="mono">{detail.path}</span>{" "}
                        {detail.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="onboard-actions">
              <button
                className="btn btn-ghost"
                type="button"
                disabled={pending}
                onClick={() => setD(SAMPLE_DISTRIBUTION)}
              >
                Use sample values
              </button>
              <button
                className="btn btn-primary btn-lg"
                type="submit"
                disabled={!valid || pending}
                style={!valid || pending ? { opacity: 0.5 } : undefined}
              >
                {pending ? "Connecting…" : "Connect"}
                <IconArrow size={18} />
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
