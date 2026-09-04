import { useState } from "react";
import Drawer from "./Drawer";
import MatchConditions from "./MatchConditions";
import PriorityField from "./PriorityField";
import RedirectFields from "./RedirectFields";
import RewriteFields from "./RewriteFields";
import Toggle from "./Toggle";
import { ApiError } from "../api";
import type { MatchCondition, Rule, RuleInput, ValidationDetail } from "../api";
import { asApiError } from "../rules";
import {
  draftFromRule,
  emptyRedirect,
  emptyRewrite,
  labelForPath,
  toRuleInput,
  validateDraft,
} from "../ruleDraft";
import type { RedirectDraft, RuleDraft, RewriteDraft } from "../ruleDraft";

interface Props {
  host: string;
  /** The rule being edited, or the kind of rule being created. */
  target: Rule | "redirect" | "rewrite";
  /** Priorities already used by this rule type on this host, excluding the edited rule. */
  taken: number[];
  /**
   * Resolves once the write and the refetch have both succeeded. Receives the
   * request body, not the draft: the draft is this component's working shape, and
   * the caller should not have to know about it to save one.
   */
  onSave: (input: RuleInput) => Promise<void>;
  onClose: () => void;
}

const initialDraft = (target: Props["target"]): RuleDraft =>
  target === "redirect"
    ? emptyRedirect()
    : target === "rewrite"
      ? emptyRewrite()
      : draftFromRule(target);

/**
 * Create or edit one rule.
 *
 * Validates locally first, then lets the API be the authority: both failures land
 * in the same `{ path, message }` list, so a client-side "priority is required"
 * and a server-side `VALIDATION_ERROR` render identically. The client check only
 * saves a round trip — the API owns the schema and the uniqueness of a priority,
 * and it is the one that can 409 on a race.
 */
export default function RuleEditor({
  host,
  target,
  taken,
  onSave,
  onClose,
}: Props) {
  const editing = typeof target !== "string";
  const [draft, setDraft] = useState<RuleDraft>(() => initialDraft(target));
  const [details, setDetails] = useState<ValidationDetail[]>([]);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  const patch = (next: Partial<RuleDraft>): void => {
    // The cast is safe by construction: each field editor only ever patches its
    // own variant, and `kind` is never in a patch. Written once here rather than
    // threaded through two generic components.
    setDraft((prev) => ({ ...prev, ...next }) as RuleDraft);
  };

  const setMatches = (matches: MatchCondition[]): void => patch({ matches });

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (saving) return;

    const found = validateDraft(draft, taken);
    setDetails(found);
    setFailure(null);
    if (found.length > 0) return;

    setSaving(true);
    try {
      await onSave(toRuleInput(draft));
      onClose();
    } catch (caught) {
      const error = asApiError(caught, "The rule could not be saved");
      setFailure(error);
      // The API's own per-field failures replace the local ones, so the list
      // never shows a stale client complaint next to a fresh server one.
      setDetails(error.details);
      setSaving(false);
    }
  };

  const kindLabel = draft.kind === "redirect" ? "redirect" : "rewrite";

  // What the rule does, in the words the list uses: a status code for a
  // redirect, and for a rewrite whether it moves the origin or only the path.
  const summary =
    draft.kind === "redirect"
      ? `${draft.statusCode} redirect`
      : draft.originKind === "none"
        ? "path rewrite"
        : "origin rewrite";

  return (
    <Drawer
      title={editing ? `Edit ${kindLabel}` : `New ${kindLabel}`}
      subtitle={`${host} · ${summary}`}
      onClose={onClose}
      footer={
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="rule-editor"
            className="btn btn-primary"
            disabled={saving}
          >
            {saving ? "Saving…" : editing ? "Save changes" : "Create rule"}
          </button>
        </div>
      }
    >
      {/*
        The submit button lives in the footer, outside this element, so it is
        wired to the form by id rather than by nesting. Keeping the actions
        pinned while the body scrolls is worth that indirection.
      */}
      <form id="rule-editor" onSubmit={submit} noValidate>
        {(failure !== null || details.length > 0) && (
          <div className="form-error" role="alert">
            <strong>
              {failure === null
                ? "Check these details"
                : headingFor(failure, details)}
            </strong>
            {failure !== null && details.length === 0 && (
              <span>{failure.message}</span>
            )}
            {details.length > 0 && (
              <ul>
                {/* Index as key: several details can share a path, and the list
                    is replaced wholesale rather than reordered. */}
                {details.map((detail, at) => (
                  <li key={at}>
                    <strong>{labelForPath(detail.path, draft.matches)}</strong>{" "}
                    {detail.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {draft.kind === "redirect" ? (
          <RedirectFields
            draft={draft as RedirectDraft}
            host={host}
            onChange={patch}
          />
        ) : (
          <RewriteFields draft={draft as RewriteDraft} onChange={patch} />
        )}

        <fieldset
          className={`editor-section${draft.kind === "redirect" ? " is-banded" : ""}`}
        >
          <legend>Match conditions</legend>
          <MatchConditions
            matches={draft.matches}
            kind={draft.kind}
            onChange={setMatches}
          />
        </fieldset>

        {/* A redirect carries its priority next to its status code, where the
            two halves of "which rule answers first" sit together. A rewrite has
            no such pairing, so it lands here instead. */}
        <fieldset className="editor-section">
          <legend>
            {draft.kind === "redirect" ? "Status" : "Priority & status"}
          </legend>

          {draft.kind === "rewrite" && (
            <PriorityField
              kind="rewrite"
              value={draft.priority}
              onChange={(priority) => patch({ priority })}
            />
          )}

          <Toggle
            label="Disabled"
            description="Disabled rules are skipped at the edge, and keep their priority."
            checked={draft.disabled}
            onChange={(disabled) => patch({ disabled })}
          />
        </fieldset>
      </form>
    </Drawer>
  );
}

/**
 * Branches on `code`, not on the message: the codes are a closed set the API
 * commits to, the prose is not.
 */
const headingFor = (error: ApiError, details: ValidationDetail[]): string => {
  switch (error.code) {
    case "VALIDATION_ERROR":
      return "Check these details";
    case "RULE_EXISTS":
      return "That priority is taken";
    case "NETWORK_ERROR":
      return "Cannot reach the API";
    case "TARGET_UNREACHABLE":
      return "The API cannot reach this table";
    case "UNKNOWN_TARGET":
      return "This distribution is no longer registered";
    default:
      return details.length > 0 ? "Check these details" : "Could not save";
  }
};
