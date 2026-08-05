import { useEffect, useId, useRef } from "react";
import { IconClose } from "./icons";

interface Props {
  title: string;
  /** Sits under the title. Optional, because not every dialog needs to explain itself. */
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** The confirm/cancel row. Kept out of `children` so it pins to the bottom. */
  footer?: React.ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The right-side drawer the rule editor sits in.
 *
 * A drawer rather than a centred dialog because the editor is a long form —
 * origin, forwarded path, match conditions, priority — and full viewport height
 * fits more of it without scrolling, while leaving the rule list visible beside
 * it so the priority being edited can be read against its neighbours.
 *
 * It is still a dialog in every way that matters, and getting focus wrong here
 * is not a detail: content stays in the DOM behind it, so without a trap Tab
 * walks into a form the user cannot see and edits it blind. Hence the four
 * things that make it real — labelled by its own heading, focus moved in on
 * open and returned on close, Tab cycling inside, Escape closing.
 *
 * Rendered inline rather than through a portal. `.console` is a plain flow
 * container with no `transform` or `filter`, so a fixed overlay inside it is
 * positioned against the viewport exactly as one at the document root would be,
 * and a portal would buy nothing but a second render tree.
 */
export default function Drawer({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Captured on mount, restored on unmount: whatever opened the dialog is where
  // focus belongs afterwards, and only the opener knows what that was.
  useEffect(() => {
    const opener = document.activeElement;

    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    // The panel itself is the fallback target — it carries tabindex={-1}, so it
    // can hold focus even when the dialog opens with nothing focusable in it.
    (first ?? panelRef.current)?.focus();

    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== "Tab" || panelRef.current === null) return;

      // Queried on every Tab rather than once: the editor adds and removes match
      // conditions, so a list captured on mount would go stale and let focus
      // escape through a control that was not there at open time.
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="drawer-overlay"
      // The overlay closes on click, but only when it is itself the target —
      // a drag that starts inside the panel and releases on the overlay would
      // otherwise discard the form.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* `drawer` carries the panel; the `modal-*` classes inside are the chrome
          shared with the host dialogs, which are native <dialog>s. */}
      <div
        className="drawer"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle !== undefined && <p className="modal-sub">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <IconClose size={18} />
          </button>
        </header>

        <div className="modal-body">{children}</div>

        {footer !== undefined && (
          <footer className="modal-foot">{footer}</footer>
        )}
      </div>
    </div>
  );
}
