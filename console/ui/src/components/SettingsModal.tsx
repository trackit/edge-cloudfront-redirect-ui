import { useEffect, useId, useRef, useState } from "react";
import DistributionFields from "./DistributionFields";
import { IconClose } from "./icons";
import { ApiError } from "../api";
import { useCanWrite } from "../auth/useAuth";
import { updateDistribution } from "../domain/distribution";
import { useFocusTrap } from "../useFocusTrap";
import type { Distribution, DistributionDraft } from "../domain/types";

interface Props {
  distribution: Distribution;
  /** Saved on the distribution's target, for the whole team. */
  onSave: (next: Distribution) => void;
  /**
   * Unlinks the distribution for the whole team, moves to the next one and
   * closes. Rejects when the API refuses, so the dialog can say why.
   */
  onUnlink: () => Promise<void>;
  onClose: () => void;
}

const errorHeading = (error: ApiError): string => {
  // Its target is gone: a teammate unlinked it since the list was loaded.
  if (error.status === 404) return "This distribution was unlinked";
  switch (error.code) {
    case "NETWORK_ERROR":
      return "Cannot reach the API";
    case "VALIDATION_ERROR":
      return "Check these details";
    case "TARGET_UNREACHABLE":
      return "The API cannot reach that table";
    case "TARGET_EXISTS":
      return "That distribution is already linked";
    default:
      return "Could not save";
  }
};

/**
 * Edit or unlink the selected distribution.
 *
 * A centred overlay rather than a native <dialog>: under React Strict Mode the
 * dialog's mount/unmount probe calls `close()`, which fires `onClose` and clears
 * the parent's open flag before the real mount can stick. A plain overlay has
 * no such lifecycle — it renders when the parent says so, and leaves when it
 * says so.
 */
export default function SettingsModal({
  distribution,
  onSave,
  onUnlink,
  onClose,
}: Props) {
  // A viewer reads the settings but may change neither them nor the list: the
  // API refuses both, so neither is offered.
  const canWrite = useCanWrite();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [draft, setDraft] = useState<DistributionDraft>(() => ({
    distributionId: distribution.distributionId,
    tableName: distribution.tableName,
    region: distribution.region,
    ...(distribution.edgeFunctionArn
      ? { edgeFunctionArn: distribution.edgeFunctionArn }
      : {}),
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // Focus moved in on open, cycled inside on Tab, and returned on close — the
  // same trap the Drawer uses, so `aria-modal` below is not a claim the dialog
  // fails to keep.
  useFocusTrap(panelRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Gated on `pending` like the X, Cancel and overlay: dismissing mid-save
      // would unmount the modal while the request is still in flight, so a
      // success would commit through the gone dialog and a failure would set
      // state on an unmounted component. Re-registered when `pending` flips so
      // the handler always sees its current value.
      if (event.key === "Escape" && !pending) onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pending]);

  const distributionId = draft.distributionId.trim();
  const tableName = draft.tableName.trim();
  const valid = distributionId !== "" && tableName !== "";

  const fail = (caught: unknown, fallback: string): void => {
    setError(
      caught instanceof ApiError
        ? caught
        : new ApiError({
            status: 0,
            code: "MALFORMED_RESPONSE",
            message: fallback,
          }),
    );
    setPending(false);
  };

  const unlink = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onUnlink();
    } catch (caught) {
      fail(caught, "Something went wrong unlinking the distribution");
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!valid || pending) return;

    setPending(true);
    setError(null);
    try {
      onSave(
        await updateDistribution(distribution, {
          distributionId,
          tableName,
          region: draft.region,
          ...(draft.edgeFunctionArn !== undefined
            ? { edgeFunctionArn: draft.edgeFunctionArn }
            : {}),
        }),
      );
    } catch (caught) {
      fail(caught, "Something went wrong saving the distribution");
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div
        className="modal modal-settings"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <form className="modal-form" onSubmit={submit}>
          <header className="modal-head">
            <div>
              <h2 id={titleId}>Settings</h2>
              <p className="modal-sub">Linked CloudFront distribution</p>
            </div>
            <button
              className="modal-x"
              type="button"
              onClick={onClose}
              aria-label="Close"
              disabled={pending}
            >
              <IconClose size={16} />
            </button>
          </header>

          <div className="modal-body">
            <DistributionFields
              value={draft}
              onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
            />

            {error !== null && (
              <div className="console-error" role="alert">
                <strong>{errorHeading(error)}</strong>
                <span>{error.message}</span>
                {error.details.length > 0 && (
                  <ul>
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

            {canWrite && (
              <div className="modal-danger">
                <div className="modal-danger-text">
                  <strong>Unlink distribution</strong>
                  <span>
                    Removes this distribution from the console for everyone on
                    the team. It stays live: its rules keep redirecting and
                    rewriting at the edge, and you can link it again anytime.
                  </span>
                  <span>
                    You&apos;ll switch to your next distribution, or back to the
                    Link your distribution screen if it was the last one.
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={pending}
                  onClick={() => void unlink()}
                >
                  Unlink
                </button>
              </div>
            )}
          </div>

          <footer className="modal-foot">
            <button
              className="btn btn-ghost"
              type="button"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={!valid || pending || !canWrite}
              title={canWrite ? undefined : "Your account has read-only access"}
            >
              {pending ? "Saving…" : "Save changes"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
