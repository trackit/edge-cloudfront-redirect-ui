import { useState } from "react";
import { isRedirect, priorityOf } from "../api";
import type { Rule } from "../api";
import type { GroupedRules } from "../domain/rules";
import {
  describeMatches,
  ruleFrom,
  ruleKindLabel,
  ruleTo,
} from "../domain/ruleSummary";
import { IconArrow, IconEdit, IconPlus, IconTrash } from "./icons";

type Filter = "all" | "redirect" | "rewrite";

interface Props {
  host: string;
  grouped: GroupedRules;
  loading: boolean;
  /**
   * True when the load failed. The list is then empty because nothing arrived,
   * not because the host has no rules — and those two must not look alike.
   */
  failed: boolean;
  onCreate: (kind: "redirect" | "rewrite") => void;
  onEdit: (rule: Rule) => void;
  onToggle: (rule: Rule) => void;
  onDelete: (rule: Rule) => void;
  /** Sort keys currently being written, so their row can show it. */
  busy: string[];
}

/**
 * A host's rules, as two lists.
 *
 * Redirects and rewrites are separate groups because they are separate priority
 * sequences at the edge: redirects run at viewer-request, rewrites at
 * origin-request. Priority 100 in one has nothing to do with priority 100 in the
 * other, so a single merged list ordered by number would imply a relationship
 * that does not exist.
 *
 * No drag-to-reorder — out of scope for the MVP. Priority is edited as a number in
 * the editor, which is also the only thing that actually moves a rule.
 */
export default function RuleList({
  host,
  grouped,
  loading,
  failed,
  onCreate,
  onEdit,
  onToggle,
  onDelete,
  busy,
}: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const total = grouped.redirects.length + grouped.rewrites.length;

  if (loading) {
    return (
      <div className="rules" aria-busy="true">
        {[0, 1, 2].map((row) => (
          <div className="skeleton" key={row} />
        ))}
      </div>
    );
  }

  /*
    A failed load renders nothing at all — the error the caller shows above is the
    whole message. Offering "no rules yet, create the first one" here would claim
    the host is clean and invite a write into a table we just failed to read, and
    a rule created at a priority that turns out to be taken is a 409 at best.
  */
  if (failed) return null;

  if (total === 0) {
    return (
      <div className="rules-empty">
        <h3>No rules yet</h3>
        <p>
          <span className="mono">{host}</span> has no redirects or rewrites. The
          edge serves it untouched.
        </p>
        <div className="rules-empty-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onCreate("redirect")}
          >
            <IconPlus size={16} />
            New redirect
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onCreate("rewrite")}
          >
            <IconPlus size={16} />
            New rewrite
          </button>
        </div>
      </div>
    );
  }

  const showRedirects = filter !== "rewrite" && grouped.redirects.length > 0;
  const showRewrites = filter !== "redirect" && grouped.rewrites.length > 0;

  return (
    <div className="rules">
      <div className="rules-toolbar">
        {/* A group of related toggles, so one accessible name covers all three and
            each button reports its own pressed state. */}
        <div className="seg" role="group" aria-label="Filter by rule type">
          {(["all", "redirect", "rewrite"] as Filter[]).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              className={filter === value ? "is-active" : ""}
              onClick={() => setFilter(value)}
            >
              {value === "all"
                ? "All"
                : value === "redirect"
                  ? "Redirects"
                  : "Rewrites"}
            </button>
          ))}
        </div>
        <span className="rules-order">Sorted by priority · lower = higher</span>
      </div>

      {showRedirects && (
        <RuleGroup
          title="Redirects"
          kind="redirect"
          phase="viewer-request"
          rules={grouped.redirects}
          onCreate={onCreate}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
          busy={busy}
        />
      )}

      {showRewrites && (
        <RuleGroup
          title="Rewrites"
          kind="rewrite"
          phase="origin-request"
          rules={grouped.rewrites}
          onCreate={onCreate}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
          busy={busy}
        />
      )}
    </div>
  );
}

function RuleGroup({
  title,
  kind,
  phase,
  rules,
  onCreate,
  onEdit,
  onToggle,
  onDelete,
  busy,
}: {
  title: string;
  kind: "redirect" | "rewrite";
  phase: string;
  rules: Rule[];
  onCreate: (kind: "redirect" | "rewrite") => void;
  onEdit: (rule: Rule) => void;
  onToggle: (rule: Rule) => void;
  onDelete: (rule: Rule) => void;
  busy: string[];
}) {
  return (
    <section className="rule-group">
      <header className="rule-group-head">
        <h3>{title}</h3>
        <span className="count-chip">{rules.length}</span>
        {/* Which CloudFront event the group runs at. Worth surfacing: it explains
            why the two lists have independent priorities, and why a rewrite only
            fires on a cache miss. */}
        <span className="phase-chip mono">{phase}</span>

        <button
          type="button"
          className="btn btn-ghost btn-sm rule-group-add"
          onClick={() => onCreate(kind)}
        >
          <IconPlus size={15} />
          Create {kind}
        </button>
      </header>

      <ul className="rule-cards">
        {rules.map((rule) => (
          /* Keyed on `sk` — unique per host per type, and this list is one host
             and one type. A moved rule gets a new key, which is correct: it is a
             different item in the table. */
          <li key={rule.sk}>
            <RuleCard
              rule={rule}
              busy={busy.includes(rule.sk)}
              onEdit={onEdit}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RuleCard({
  rule,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  rule: Rule;
  busy: boolean;
  onEdit: (rule: Rule) => void;
  onToggle: (rule: Rule) => void;
  onDelete: (rule: Rule) => void;
}) {
  const enabled = rule.disabled !== true;
  const label = `${ruleKindLabel(rule)} at priority ${priorityOf(rule.sk)}`;

  return (
    <article
      className={`rule-card${enabled ? "" : " is-disabled"}${busy ? " is-busy" : ""}`}
    >
      <div className="rule-prio" title="Priority">
        {priorityOf(rule.sk)}
      </div>

      <div className="rule-body">
        <div className="rule-badges">
          <span
            className={`badge ${isRedirect(rule) ? "badge-redirect" : "badge-rewrite"}`}
          >
            {ruleKindLabel(rule)}
          </span>
          <span className={`badge ${enabled ? "badge-on" : "badge-off"}`}>
            <span className="badge-dot" aria-hidden="true" />
            {enabled ? "enabled" : "disabled"}
          </span>
        </div>

        <p className="rule-summary">
          <span className="rule-from mono">{ruleFrom(rule)}</span>
          <span className="rule-arrow" aria-hidden="true">
            <IconArrow size={15} />
          </span>
          <span className="rule-to mono">{ruleTo(rule)}</span>
        </p>

        <p className="rule-cond mono">{describeMatches(rule)}</p>
      </div>

      <div className="rule-actions">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? "Disable" : "Enable"} ${label}`}
          disabled={busy}
          className={`switch${enabled ? " is-on" : ""}`}
          onClick={() => onToggle(rule)}
        >
          <span className="switch-knob" aria-hidden="true" />
        </button>

        <button
          type="button"
          className="icon-btn"
          aria-label={`Edit ${label}`}
          disabled={busy}
          onClick={() => onEdit(rule)}
        >
          <IconEdit size={16} />
        </button>

        <button
          type="button"
          className="icon-btn is-danger"
          aria-label={`Delete ${label}`}
          disabled={busy}
          onClick={() => onDelete(rule)}
        >
          <IconTrash size={16} />
        </button>
      </div>
    </article>
  );
}
