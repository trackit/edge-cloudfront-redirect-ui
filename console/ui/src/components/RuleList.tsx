import { useCallback, useEffect, useRef, useState } from "react";
import { isRedirect, priorityOf } from "../api";
import type { Rule } from "../api";
import type { GroupedRules } from "../rules";
import { isNoOpSlot, moveToSlot, stepSlot } from "../reorder";
import { useDragSort } from "../useDragSort";
import {
  describeMatches,
  ruleFrom,
  ruleKindLabel,
  ruleTo,
} from "../ruleSummary";
import { IconArrow, IconEdit, IconGrip, IconPlus, IconTrash } from "./icons";

type Filter = "all" | "redirect" | "rewrite";

/** Said the same way in every place a viewer meets a control they cannot use. */
const READ_ONLY = "Your account has read-only access";

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
  /**
   * Saves a new order for one kind. Resolves `true` when it was applied and
   * `false` when it was refused — the list then snaps back, and the caller is
   * the one that has already said why.
   */
  onReorder: (type: Rule["type"], order: string[]) => Promise<boolean>;
  /** Sort keys currently being written, so their row can show it. */
  busy: string[];
  /** False for a viewer: the row's controls are shown but inert, and say why. */
  canWrite: boolean;
}

/**
 * A host's rules, as two lists.
 *
 * Redirects and rewrites are separate groups because they are separate priority
 * sequences at the edge: redirects run at viewer-request, rewrites at
 * origin-request. Priority 100 in one has nothing to do with priority 100 in the
 * other, so a single merged list ordered by number would imply a relationship
 * that does not exist — and it is why a rule can only be dragged within its own
 * group.
 *
 * Rows can be reordered by dragging the grip, or with the arrow keys once it has
 * focus. Either way the priorities themselves stay put: the server hands the
 * group's existing numbers back out in the new order, so the rules swap numbers
 * rather than being renumbered. Editing the number by hand in the editor is
 * still there, and is the only way to change what the numbers are.
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
  onReorder,
  busy,
  canWrite,
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
        <span className="rules-order">
          Sorted by priority · lower = higher · drag to reorder
        </span>
      </div>

      {showRedirects && (
        <RuleGroup
          title="Redirects"
          type="erMatchRule"
          phase="viewer-request"
          rules={grouped.redirects}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
          onReorder={onReorder}
          busy={busy}
          canWrite={canWrite}
        />
      )}

      {showRewrites && (
        <RuleGroup
          title="Rewrites"
          type="frMatchRule"
          phase="origin-request"
          rules={grouped.rewrites}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
          onReorder={onReorder}
          busy={busy}
          canWrite={canWrite}
        />
      )}
    </div>
  );
}

function RuleGroup({
  title,
  type,
  phase,
  rules,
  onEdit,
  onToggle,
  onDelete,
  onReorder,
  busy,
  canWrite,
}: {
  title: string;
  /**
   * Which sequence this group is. Passed as the wire type rather than as a
   * "redirect"/"rewrite" kind because reordering is all the group needs it for,
   * and `onReorder` takes the wire type.
   */
  type: Rule["type"];
  phase: string;
  rules: Rule[];
  onEdit: (rule: Rule) => void;
  onToggle: (rule: Rule) => void;
  onDelete: (rule: Rule) => void;
  onReorder: (type: Rule["type"], order: string[]) => Promise<boolean>;
  busy: string[];
  /** False for a viewer: the row's controls are shown but inert, and say why. */
  canWrite: boolean;
}) {
  /**
   * The order on screen while a reorder is in flight.
   *
   * Set before the request and cleared when it settles. On success the refetch
   * has already landed by then, so clearing falls through to the same order; on
   * failure it snaps back to what the server still holds. Without it the rows
   * would not move until the round trip finished, and a drag that appears to do
   * nothing reads as a broken control.
   */
  const [pending, setPending] = useState<Rule[] | null>(null);
  const [saving, setSaving] = useState(false);
  /** Spoken, not shown: the rows move, which is the sighted feedback. */
  const [announcement, setAnnouncement] = useState("");

  // Keyed by index, not by rule: the rows are keyed by sort key and a reorder
  // keeps that set intact, so the handle at a given position is one DOM node
  // throughout — which is what lets focus follow a rule moved by the keyboard.
  const handles = useRef(new Map<number, HTMLButtonElement>());
  /** Where an arrow key left the rule, for the effect below to focus. */
  const moved = useRef<number | null>(null);

  /**
   * Returns focus to the rule an arrow key moved, once the save has settled.
   *
   * In an effect rather than at the end of `save` because the handles are
   * disabled while saving: focusing one before React has re-rendered it as
   * enabled does nothing at all, and the next arrow press would then move
   * whichever rule had slid into the old position — or nothing, with focus on
   * the body.
   */
  useEffect(() => {
    if (saving) return;

    const index = moved.current;
    if (index === null) return;

    moved.current = null;
    handles.current.get(index)?.focus();
  }, [saving]);

  const shown = pending ?? rules;
  const sortable = canWrite && shown.length > 1;

  const save = useCallback(
    async (from: number, slot: number, byKeyboard: boolean): Promise<void> => {
      if (saving || isNoOpSlot(from, slot)) return;

      const next = moveToSlot(shown, from, slot);
      const to = slot > from ? slot - 1 : slot;

      setPending(next);
      setSaving(true);
      setAnnouncement(`Moved to position ${to + 1} of ${next.length}. Saving…`);

      const applied = await onReorder(
        type,
        next.map((rule) => rule.sk),
      );

      // Only for the keyboard: a pointer leaves focus where the user's attention
      // already is, while an arrow key has to keep the moved rule under the keys
      // that are still being pressed. Set before the state below, since the
      // effect that acts on it runs off `saving`.
      if (byKeyboard && applied) moved.current = to;

      setSaving(false);
      setPending(null);
      setAnnouncement(
        applied
          ? `Moved to position ${to + 1} of ${next.length}.`
          : "The order could not be saved, so the rules are back as they were.",
      );
    },
    [type, onReorder, saving, shown],
  );

  const drag = useDragSort({
    count: shown.length,
    disabled: !sortable || saving,
    onDrop: (from, slot) => void save(from, slot, false),
  });

  const handleTitle = !canWrite
    ? READ_ONLY
    : shown.length > 1
      ? "Drag to reorder, or use the arrow keys"
      : "Nothing to reorder — this is the only rule here";

  return (
    <section className="rule-group">
      <header className="rule-group-head">
        <h3>{title}</h3>
        <span className="count-chip">{shown.length}</span>
        {/* Which CloudFront event the group runs at. Worth surfacing: it explains
            why the two lists have independent priorities, and why a rewrite only
            fires on a cache miss. */}
        <span className="phase-chip mono">{phase}</span>

        {/* No create button here. Creating lives once, in the host header — which
            is also the only copy that refuses a write a viewer cannot make and
            stays dead while the list could not be read (CF-25). */}
      </header>

      <ul className="rule-cards" aria-busy={saving}>
        {shown.map((rule, index) => (
          /* Keyed on `sk` — unique per host per type, and this list is one host
             and one type. A reorder leaves that set of keys untouched and only
             changes which rule holds each one, so the rows stay put and their
             contents move: exactly what keeps focus and the drag from being
             pulled out from under the pointer. */
          <li
            key={rule.sk}
            ref={drag.rowRef(index)}
            className={[
              "rule-row",
              drag.dragging === index ? "is-dragging" : "",
              drag.slot === index ? "is-drop-before" : "",
              drag.slot === shown.length && index === shown.length - 1
                ? "is-drop-after"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <RuleCard
              rule={rule}
              busy={busy.includes(rule.sk)}
              canWrite={canWrite}
              onEdit={onEdit}
              onToggle={onToggle}
              onDelete={onDelete}
              handle={
                <button
                  type="button"
                  ref={(element) => {
                    if (element === null) handles.current.delete(index);
                    else handles.current.set(index, element);
                  }}
                  className="rule-grip"
                  // The row's position is the thing being changed, so it belongs
                  // in the name rather than only in the rows either side of it.
                  aria-label={`Reorder ${ruleKindLabel(rule)} at priority ${priorityOf(rule.sk)}, position ${index + 1} of ${shown.length}`}
                  disabled={!sortable || saving}
                  title={handleTitle}
                  onPointerDown={drag.handleProps(index).onPointerDown}
                  onPointerMove={drag.handleProps(index).onPointerMove}
                  onPointerUp={drag.handleProps(index).onPointerUp}
                  onPointerCancel={drag.handleProps(index).onPointerCancel}
                  onKeyDown={(event) => {
                    const direction =
                      event.key === "ArrowUp"
                        ? "up"
                        : event.key === "ArrowDown"
                          ? "down"
                          : null;
                    if (direction === null) return;
                    if (direction === "up" && index === 0) return;
                    if (direction === "down" && index === shown.length - 1) {
                      return;
                    }

                    // Otherwise the page scrolls under the row being moved.
                    event.preventDefault();
                    void save(index, stepSlot(index, direction), true);
                  }}
                >
                  <IconGrip size={16} />
                </button>
              }
            />
          </li>
        ))}
      </ul>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}

function RuleCard({
  rule,
  busy,
  canWrite,
  handle,
  onEdit,
  onToggle,
  onDelete,
}: {
  rule: Rule;
  busy: boolean;
  canWrite: boolean;
  handle: React.ReactNode;
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
      {handle}

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
          disabled={busy || !canWrite}
          title={canWrite ? undefined : READ_ONLY}
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
          title={canWrite ? undefined : "View this rule"}
          onClick={() => onEdit(rule)}
        >
          <IconEdit size={16} />
        </button>

        <button
          type="button"
          className="icon-btn is-danger"
          aria-label={`Delete ${label}`}
          disabled={busy || !canWrite}
          title={canWrite ? undefined : READ_ONLY}
          onClick={() => onDelete(rule)}
        >
          <IconTrash size={16} />
        </button>
      </div>
    </article>
  );
}
