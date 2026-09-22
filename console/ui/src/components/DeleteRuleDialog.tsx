import { useEffect, useRef, useState } from "react";
import { ApiError, isRedirect, priorityOf } from "../api";
import type { Rule } from "../api";
import { ruleFrom, ruleTo } from "../domain/ruleSummary";
import { IconClose } from "./icons";

interface Props {
  rule: Rule;
  /**
   * Performs the delete. Rejects with the failure so the dialog can show it in
   * place; the parent owns the request (and the list refetch that follows), this
   * only owns the confirmation.
   */
  onConfirm: () => Promise<void>;
  /** Dismissed without deleting. */
  onClose: () => void;
}

/*
  Confirming a rule delete.

  A dialog rather than deleting on the click, and rather than the native
  `window.confirm`: the trash icon sits beside the toggle and edit on a dense
  row, there is no undo — the item is gone from DynamoDB — and a real dialog can
  name the rule, show the delete failing in place, and match the delete-host and
  add-host dialogs instead of a browser popup that does none of that.

  Same native <dialog> as DeleteHostDialog, for the focus trap, Escape and
  backdrop it gives for free.
*/
export default function DeleteRuleDialog({ rule, onConfirm, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // Opened on mount; the element's own `close` event is deliberately not wired
  // to `onClose` — the cleanup's `close()` would otherwise read as the user
  // dismissing a dialog that had only just opened. Mirrors DeleteHostDialog.
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  // Gated on pending like every other dismiss: a delete in flight must not be
  // interrupted by Escape, the backdrop or the X.
  const dismiss = () => {
    if (pending) return;
    dialog.current?.close();
    onClose();
  };

  const kind = isRedirect(rule) ? "redirect" : "rewrite";
  const priority = priorityOf(rule.sk);

  const remove = async () => {
    if (pending) return;

    setPending(true);
    setError(null);
    try {
      await onConfirm();
      // On success the parent unmounts this dialog; nothing left to do here.
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError({
              status: 0,
              code: "MALFORMED_RESPONSE",
              message: "Something went wrong deleting the rule",
            }),
      );
      setPending(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="modal"
      // Escape, which unlike `close` is only ever the user.
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
      onClick={(e) => {
        if (e.target === dialog.current) dismiss();
      }}
      aria-labelledby="delete-rule-title"
    >
      <div className="modal-form">
        <header className="modal-head">
          <div>
            <h2 id="delete-rule-title">Delete this {kind}?</h2>
            <p className="modal-sub mono">priority {priority}</p>
          </div>
          <button
            className="modal-x"
            type="button"
            onClick={dismiss}
            aria-label="Close"
            disabled={pending}
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="modal-body">
          <p className="modal-text">
            <span className="mono">{ruleFrom(rule)}</span> →{" "}
            <span className="mono">{ruleTo(rule)}</span> will be removed. This
            cannot be undone.
          </p>
          {/* The propagation delay cuts both ways — the rule keeps firing for
              about a minute after this, until the edge cache expires. */}
          <p className="modal-text modal-text-dim">
            It keeps serving traffic for about a minute after deletion.
          </p>

          {error !== null && (
            <div className="console-error" role="alert">
              <strong>Could not delete the rule</strong>
              <span>{error.message}</span>
            </div>
          )}
        </div>

        <footer className="modal-foot">
          <button
            className="btn btn-ghost"
            type="button"
            disabled={pending}
            onClick={dismiss}
          >
            Cancel
          </button>
          <button
            className="btn btn-danger"
            type="button"
            disabled={pending}
            onClick={remove}
          >
            {pending ? "Deleting…" : `Delete ${kind}`}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
