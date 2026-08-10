import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import type { ApiClient, HostSummary } from "../api";
import { IconClose } from "./icons";

interface Props {
  targetId: string;
  host: HostSummary;
  /** Dismissed without deleting. */
  onClose: () => void;
  /** Gone — either deleted here, or already gone when we asked. */
  onDeleted: (host: string) => void;
  client?: ApiClient;
}

/** "3 redirects and 1 rewrite", or null when the host has no rules at all. */
const rulesLost = (host: HostSummary): string | null => {
  const parts: string[] = [];
  if (host.redirects > 0) {
    parts.push(
      host.redirects === 1 ? "1 redirect" : `${host.redirects} redirects`,
    );
  }
  if (host.rewrites > 0) {
    parts.push(host.rewrites === 1 ? "1 rewrite" : `${host.rewrites} rewrites`);
  }

  if (parts.length === 0) return null;
  return parts.join(" and ");
};

/*
  Confirming a host delete.

  Worth a dialog rather than deleting on the click: this removes every rule under
  the host, the trash icon sits one row away from the host someone actually wants
  to keep, and there is no undo — the rules are gone from DynamoDB.

  Same native <dialog> as AddHostModal, for the focus trap, Escape and backdrop.
*/
export default function DeleteHostDialog({
  targetId,
  host,
  onClose,
  onDeleted,
  client = api,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // Opened on mount, and the element's own `close` event is deliberately not
  // wired to `onClose` — see the longer note in AddHostModal, which this
  // mirrors: `close()` raises that event from the effect cleanup too, which
  // would read as the user dismissing a dialog that had only just opened.
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  // Closes the element before telling the parent, which is the order that returns
  // focus to the row's delete button — see the note in AddHostModal. The cleanup
  // above cannot do it: React detaches the node first, so focus falls to `<body>`.
  const dismiss = () => {
    dialog.current?.close();
    onClose();
  };

  const lost = rulesLost(host);

  const remove = async () => {
    if (pending) return;

    setPending(true);
    setError(null);
    try {
      await client.hosts.remove(targetId, host.host);
      onDeleted(host.host);
    } catch (caught) {
      // Already gone is the outcome that was asked for. Someone else deleting it
      // first, or a retry after a response that was lost, must not leave the
      // console insisting a host it can no longer show still exists.
      if (caught instanceof ApiError && caught.status === 404) {
        onDeleted(host.host);
        return;
      }

      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError({
              status: 0,
              code: "MALFORMED_RESPONSE",
              message: "Something went wrong deleting the host",
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
      aria-labelledby="delete-host-title"
    >
      <div className="modal-form">
        <header className="modal-head">
          <div>
            <h2 id="delete-host-title">Delete this host?</h2>
            <p className="modal-sub mono">{host.host}</p>
          </div>
          <button
            className="modal-x"
            type="button"
            onClick={dismiss}
            aria-label="Close"
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="modal-body">
          <p className="modal-text">
            {lost === null ? (
              <>This host has no rules. Removing it cannot be undone.</>
            ) : (
              <>
                Its <strong>{lost}</strong> will be deleted with it. This cannot
                be undone.
              </>
            )}
          </p>
          {/* The propagation delay is a property of the edge cache, and it cuts
              both ways — the rules keep firing for about a minute after this. */}
          <p className="modal-text modal-text-dim">
            Rules stop applying at the edge within about a minute.
          </p>

          {error !== null && (
            <div className="console-error" role="alert">
              <strong>Could not delete the host</strong>
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
            {pending ? "Deleting…" : "Delete host"}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
