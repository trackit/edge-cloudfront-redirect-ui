import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import type { ApiClient } from "../api";
import { hostKey } from "../domain/hostRoutes";
import { IconClose, IconGlobe } from "./icons";

interface Props {
  targetId: string;
  /** Dismissed without adding anything. */
  onClose: () => void;
  /**
   * Added — or found to exist already. The host is the server's, which is
   * lowercased, so it is the one that addresses the rules.
   */
  onAdded: (host: string) => void;
  client?: ApiClient;
}

/**
 * A short heading for the failure, so the API's prose is not the only thing the
 * user reads. Same approach as OnboardingScreen: codes are stable, messages are
 * not, so the branch is on `code`.
 */
const errorHeading = (error: ApiError): string => {
  switch (error.code) {
    case "NETWORK_ERROR":
      return "Cannot reach the API";
    case "VALIDATION_ERROR":
      return "That is not a hostname";
    case "TARGET_UNREACHABLE":
      return "The API cannot reach that table";
    default:
      return "Could not add the host";
  }
};

/*
  Add a host.

  A native <dialog> rather than a div with a high z-index: it brings the focus
  trap, Escape-to-close, the inert background and the ::backdrop with it, all of
  which are easy to get subtly wrong by hand and none of which are this ticket.
*/
export default function AddHostModal({
  targetId,
  onClose,
  onAdded,
  client = api,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [host, setHost] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  /*
    `showModal()` is what makes it modal — rendering the element alone leaves it
    hidden. Opening once on mount, since the component only exists while open.

    The element's own `close` event is deliberately *not* wired to `onClose`.
    Whether this dialog exists is the parent's state, and `close()` fires that
    event however it was reached — including from this cleanup. React re-runs
    effects on mount in development, so the cleanup's `close()` would tell the
    parent the user had dismissed a dialog that had only just opened, and it
    would vanish on the frame it appeared. A flag guarding the handler does not
    help: `close` is queued rather than dispatched synchronously, so it lands
    after the flag has been cleared for the remount.

    So every genuine dismissal goes through `dismiss` below — the two buttons,
    the backdrop, and `onCancel` for Escape, which only fires for the user.
  */
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();

    /*
      Focused here rather than with `autoFocus` on the input, which does nothing:
      React does not emit the `autofocus` attribute, and `showModal()` runs after
      mount anyway, so the dialog's own focusing steps had already picked the first
      focusable child — the close button.

      That is not a cosmetic difference. Focus on a button means Enter activates
      it, so opening this and pressing Enter dismissed the dialog instead of
      submitting it, and anything typed went nowhere until the field was clicked.
    */
    field.current?.focus();

    return () => element?.close();
  }, []);

  /**
   * Closes the element first, then tells the parent.
   *
   * The order is what returns focus to whatever opened this. Closing a modal
   * dialog is what hands focus back, and those steps only work while the element
   * is still in the document — leaving it to the effect cleanup above is too
   * late, because React detaches the node before running it, so the steps find a
   * disconnected element and focus falls to `<body>`. A keyboard user would be
   * dropped at the top of the page on every add or cancel.
   */
  const dismiss = () => {
    dialog.current?.close();
    onClose();
  };

  const trimmed = host.trim();
  const valid = trimmed !== "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || pending) return;

    setPending(true);
    setError(null);
    try {
      const created = await client.hosts.create(targetId, trimmed);
      onAdded(created.host);
    } catch (caught) {
      // Already there is not a failure of what the user asked for — they want to
      // be looking at this host, and it exists. Same reading as a target that
      // turns out to be registered already in distribution.ts. The list is
      // reloaded by the caller either way, so a host missing from a stale
      // sidebar appears rather than being reported as an error.
      if (caught instanceof ApiError && caught.code === "HOST_EXISTS") {
        onAdded(hostKey(trimmed));
        return;
      }

      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError({
              status: 0,
              code: "MALFORMED_RESPONSE",
              message: "Something went wrong adding the host",
            }),
      );
      setPending(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="modal"
      // Escape, and only ever the user — unlike `close`, which `close()` raises
      // too. `preventDefault` so the browser's own close is not what happens:
      // `dismiss` closes it in the order that restores focus.
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
      // A click landing on the dialog element itself is a click on the backdrop:
      // anything inside is over a child. Matches the dismiss-by-clicking-away
      // people expect from an overlay.
      onClick={(e) => {
        if (e.target === dialog.current) dismiss();
      }}
      aria-labelledby="add-host-title"
    >
      <form className="modal-form" onSubmit={submit}>
        <header className="modal-head">
          <div>
            <h2 id="add-host-title">Add a host</h2>
            <p className="modal-sub">
              A domain served by your CloudFront distribution
            </p>
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
          <div className="field">
            <label htmlFor="host">Host name</label>
            <div className="input-icon">
              <IconGlobe size={15} />
              {/* Focused from the open effect above, not with `autoFocus` — see
                  the note there for why that attribute never took effect. */}
              <input
                ref={field}
                id="host"
                className="input mono"
                placeholder="shop.example.com"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
            <div className="hint">
              This is the incoming domain rules apply to — not the redirect
              destination.
            </div>
          </div>

          {error !== null && (
            <div className="console-error" role="alert">
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
            className="btn btn-primary"
            type="submit"
            disabled={!valid || pending}
          >
            {pending ? "Adding…" : "Add host"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
