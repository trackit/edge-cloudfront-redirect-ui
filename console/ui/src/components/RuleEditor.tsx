import { useEffect, useRef, useState } from "react";
import Drawer from "./Drawer";
import GeoReadinessNotice from "./GeoReadinessNotice";
import MatchConditions from "./MatchConditions";
import PriorityField from "./PriorityField";
import RedirectFields from "./RedirectFields";
import RewriteFields from "./RewriteFields";
import Toggle from "./Toggle";
import { ApiError } from "../api";
import type {
  GeoCheck,
  MatchCondition,
  Rule,
  RuleInput,
  ValidationDetail,
} from "../api";
import { asApiError } from "../domain/rules";
import { useGeoCheck } from "../domain/geoReadiness";
import {
  draftFromRule,
  emptyRedirect,
  emptyRewrite,
  labelForPath,
  toRuleInput,
  validateDraft,
} from "../domain/ruleDraft";
import type {
  RedirectDraft,
  RuleDraft,
  RewriteDraft,
} from "../domain/ruleDraft";

interface Props {
  /** The rule's target, whose distribution a country condition is checked against. */
  targetId: string;
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
  onSave: (
    input: RuleInput,
    options?: { confirmUnverifiedGeo?: boolean },
  ) => Promise<void>;
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
  targetId,
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
  const readsCountry = draft.matches.some(
    (match) => match.matchType === "country",
  );
  const { state: geo, recheck } = useGeoCheck(
    targetId,
    draft.kind,
    draft.matches,
    readsCountry,
  );
  const [confirmUnverified, setConfirmUnverified] = useState(false);
  const [awaitingCheck, setAwaitingCheck] = useState(false);
  // Closed (Cancel, Escape) while a save waited for the check: the wait must
  // not resume into a save nobody asked for any more.
  const open = useRef(true);
  useEffect(() => {
    // Set on mount too: StrictMode mounts, unmounts and mounts again.
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  // A confirmation is for the rule it was given for: changing what the rule
  // matches withdraws it.
  const ruleShape = JSON.stringify({
    kind: draft.kind,
    matches: draft.matches,
  });
  useEffect(() => setConfirmUnverified(false), [ruleShape]);
  const check =
    geo.status === "ready"
      ? geo.check
      : geo.status === "loading"
        ? geo.previous
        : null;
  // A rewrite the API could not check: the one case a save can be confirmed.
  // The API, checking again at save time, may fail where the editor's reading
  // did not: its GEO_UNVERIFIED is the same case, confirmed the same way.
  const serverUnverified = failure?.code === "GEO_UNVERIFIED";
  const unverifiable =
    readsCountry &&
    draft.kind === "rewrite" &&
    !draft.disabled &&
    (geo.status === "failed" ||
      check?.decision.outcome === "unverifiable" ||
      serverUnverified);

  const patch = (next: Partial<RuleDraft>): void => {
    // The cast is safe by construction: each field editor only ever patches its
    // own variant, and `kind` is never in a patch. Written once here rather than
    // threaded through two generic components.
    setDraft((prev) => ({ ...prev, ...next }) as RuleDraft);
  };

  const setMatches = (matches: MatchCondition[]): void => patch({ matches });

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (saving || awaitingCheck) return;

    // Only a rewrite is ever held back: a redirect is no-store, so the same
    // setup makes it miss viewers, never misdirect them. So only a rewrite
    // waits for the check — and not a disabled one, which runs nowhere and is
    // checked by the API when it is turned on.
    const guarded = readsCountry && draft.kind === "rewrite" && !draft.disabled;
    let decided: GeoCheck | null = geo.status === "ready" ? geo.check : null;
    if (guarded && geo.status === "loading") {
      // Saving before the check answers is how an unsafe rewrite got through.
      // Wait for it: the API would refuse the rule anyway, but saying so here
      // keeps the reason next to the fields that cause it.
      setAwaitingCheck(true);
      decided = await geo.settled;
      if (!open.current) return;
      setAwaitingCheck(false);
    }
    const outcome = guarded
      ? (decided?.decision.outcome ?? "unverifiable")
      : "ok";
    const confirming =
      guarded &&
      confirmUnverified &&
      (outcome === "unverifiable" || serverUnverified);

    const found = validateDraft(draft, taken);
    // Checked here rather than in validateDraft, which knows nothing of the
    // distribution.
    if (outcome === "blocked" && decided !== null) {
      const unsafe = decided.decision.relevant
        .filter((b) => b.verdict === "cachedWithoutCountry")
        .map((b) =>
          b.pathPattern === "*" ? "the default behavior" : b.pathPattern,
        );
      found.push({
        path: "/forwardSettings",
        message: `cannot read the country here yet: ${unsafe.join(", ")} caches without CloudFront-Viewer-Country in its cache key, so the page rewritten for one country would be served to everyone. Fix the distribution's cache settings first.`,
      });
    }
    if (
      (outcome === "unverifiable" || serverUnverified) &&
      !confirmUnverified
    ) {
      found.push({
        path: "/forwardSettings",
        message:
          'the distribution could not be checked. Tick "I understand, save anyway" to save it regardless.',
      });
    }
    setDetails(found);
    setFailure(null);
    if (found.length > 0) return;

    setSaving(true);
    try {
      await onSave(toRuleInput(draft), { confirmUnverifiedGeo: confirming });
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
            disabled={saving || awaitingCheck}
          >
            {saving
              ? "Saving…"
              : awaitingCheck
                ? "Checking the distribution…"
                : editing
                  ? "Save changes"
                  : "Create rule"}
          </button>
        </div>
      }
    >
      {/*
        The submit button lives in the footer, outside this element, so it is
        wired to the form by id rather than by nesting. Keeping the actions
        pinned while the body scrolls is worth that indirection.
      */}
      <form
        id="rule-editor"
        onSubmit={submit}
        noValidate
        data-geo-check={geo.status}
      >
        {/* Locked while a save waits for the check: what is saved is what was
            on screen when Save was clicked. */}
        <fieldset className="editor-lock" disabled={awaitingCheck}>
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
                      <strong>
                        {labelForPath(detail.path, draft.matches)}
                      </strong>{" "}
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
            <GeoReadinessNotice
              check={
                geo.status === "failed"
                  ? {
                      readiness: {
                        status: "unknown",
                        cause: "transient",
                        reason: geo.message,
                      },
                      decision: {
                        outcome: "unverifiable",
                        relevant: [],
                        ambiguous: false,
                      },
                    }
                  : check
              }
              kind={draft.kind}
              onRecheck={recheck}
              rechecking={geo.status === "loading"}
            />
            {unverifiable && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={confirmUnverified}
                  onChange={(e) => setConfirmUnverified(e.target.checked)}
                />{" "}
                I understand, save anyway
              </label>
            )}
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
    case "GEO_REWRITE_UNSAFE":
      return "This rewrite would be served to every country";
    case "GEO_UNVERIFIED":
      return "The distribution could not be checked";
    default:
      return details.length > 0 ? "Check these details" : "Could not save";
  }
};
