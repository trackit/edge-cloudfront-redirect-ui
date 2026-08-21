import { useEffect, useId, useRef, useState } from "react";
import DistributionFields from "./DistributionFields";
import { IconClose } from "./icons";
import { ApiError } from "../api";
import { connectDistribution } from "../distribution";
import { useFocusTrap } from "../useFocusTrap";
import type { Distribution, DistributionDraft } from "../types";

interface Props {
  distribution: Distribution;
  /** Saved — re-registered if needed, then stored in place of the current one. */
  onSave: (next: Distribution) => void;
  /** Forget this environment in this browser and close. */
  onDisconnect: () => void;
  onClose: () => void;
}

const errorHeading = (error: ApiError): string => {
  switch (error.code) {
    case "NETWORK_ERROR":
      return "Cannot reach the API";
    case "VALIDATION_ERROR":
      return "Check these details";
    case "TARGET_UNREACHABLE":
      return "The API cannot reach that table";
    default:
      return "Could not save";
  }
};

/**
 * Edit or forget the connected environment.
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
  onDisconnect,
  onClose,
}: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [draft, setDraft] = useState<DistributionDraft>(() => ({
    distributionId: distribution.distributionId,
    tableName: distribution.tableName,
    region: distribution.region,
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // Focus moved in on open, cycled inside on Tab, and returned on close — the
  // same trap the Drawer uses, so `aria-modal` below is not a claim the dialog
  // fails to keep.
  useFocusTrap(panelRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const distributionId = draft.distributionId.trim();
  const tableName = draft.tableName.trim();
  const valid = distributionId !== "" && tableName !== "";

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!valid || pending) return;

    setPending(true);
    setError(null);
    try {
      onSave(
        await connectDistribution({
          distributionId,
          tableName,
          region: draft.region,
        }),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError({
              status: 0,
              code: "MALFORMED_RESPONSE",
              message: "Something went wrong saving the distribution",
            }),
      );
      setPending(false);
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
              <p className="modal-sub">Connected CloudFront distribution</p>
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

            <div className="modal-danger">
              <div className="modal-danger-text">
                <strong>Disconnect</strong>
                <span>
                  Forget this distribution and return to the first-connection
                  screen.
                </span>
              </div>
              <button
                type="button"
                className="btn btn-danger"
                disabled={pending}
                onClick={onDisconnect}
              >
                Disconnect
              </button>
            </div>
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
              disabled={!valid || pending}
            >
              {pending ? "Saving…" : "Save changes"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
