import { useEffect, useId, useRef } from "react";
import { IconClose } from "./icons";
import { useFocusTrap } from "../useFocusTrap";

interface Props {
  title: string;
  /** Sits under the title. Optional, because not every dialog needs to explain itself. */
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** The confirm/cancel row. Kept out of `children` so it pins to the bottom. */
  footer?: React.ReactNode;
}

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

  // Focus moved in on open, cycled inside on Tab, and returned on close.
  useFocusTrap(panelRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
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
