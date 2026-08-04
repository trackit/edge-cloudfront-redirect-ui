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
  /**
   * Prefills the form with an already-connected environment, which turns this
   * screen into Settings. Its presence is what distinguishes the two modes —
   * there is nothing else to tell them apart, since editing submits through the
   * same call as connecting.
   */
  initial?: DistributionDraft;
  /** Leaves without submitting. Only meaningful when there is something to go back to. */
  onCancel?: () => void;
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
export default function OnboardingScreen({
  onConnect,
  initial,
  onCancel,
}: Props) {
  // Two independent questions, so two flags rather than one mode. Editing an
  // existing environment changes the wording; being able to go back depends only
  // on there being a console to go back to. Adding a second distribution from the
  // console is "not editing" *and* cancellable, which one flag could not express.
  const editing = initial !== undefined;
  const canCancel = onCancel !== undefined;
  // Lazy initialiser so `initial` is captured once. A later prop change is not a
  // new environment to edit, it is the one being edited — reseeding mid-edit
  // would discard what the user typed.
  const [d, setD] = useState<DistributionDraft>(
    () => initial ?? emptyDistribution(),
  );
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
          {/* Reached from the console, so back means the console — sending the
              user to the marketing page would lose their place. */}
          {canCancel ? (
            <button
              type="button"
              className="oa-back-home oa-back-btn"
              onClick={onCancel}
            >
              ← Back to console
            </button>
          ) : (
            <Link to="/" className="oa-back-home">
              ← Back to home
            </Link>
          )}
        </aside>

        {/* right — the details we need */}
        <div className="onboard-main">
          <form className="onboard-connect" onSubmit={submit}>
            <h1>
              {editing ? "Distribution settings" : "Connect your distribution"}
            </h1>
            <p className="onboard-sub">
              {editing
                ? "Change what this console is pointed at. Saving re-points it; the rules already in the other table are left untouched."
                : "The CloudFront distribution EdgeRoute is attached to, and the DynamoDB table that stores its rules."}
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
              {/* Sample values are for a first connection. Offering them while
                  editing would put a one-click way to overwrite a working
                  environment next to the save button. */}
              {editing ? (
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={pending}
                  onClick={onCancel}
                >
                  Cancel
                </button>
              ) : (
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={pending}
                  onClick={() => setD(SAMPLE_DISTRIBUTION)}
                >
                  Use sample values
                </button>
              )}
              <button
                className="btn btn-primary btn-lg"
                type="submit"
                disabled={!valid || pending}
                style={!valid || pending ? { opacity: 0.5 } : undefined}
              >
                {pending
                  ? editing
                    ? "Saving…"
                    : "Connecting…"
                  : editing
                    ? "Save"
                    : "Connect"}
                <IconArrow size={18} />
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
