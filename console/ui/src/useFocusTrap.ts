import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * Elements Tab can land on — what the browser treats as tabbable, minus
 * anything explicitly removed with `tabindex="-1"`.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Traps keyboard focus inside a dialog panel for as long as it is mounted.
 *
 * A dialog with `aria-modal` promises assistive tech that focus is contained;
 * this is what makes that true. On mount it moves focus into the panel and
 * remembers what had it; while open, Tab and Shift+Tab cycle within the panel
 * rather than escaping to the controls behind the overlay; on unmount it returns
 * focus to the opener.
 *
 * Escape is deliberately not handled here: a drawer and a modal mid-save close
 * on different terms, so the dismiss key stays the caller's to own.
 */
export function useFocusTrap(panelRef: RefObject<HTMLElement | null>): void {
  // Captured on mount, restored on unmount: whatever opened the dialog is where
  // focus belongs afterwards, and only the opener knows what that was.
  useEffect(() => {
    const opener = document.activeElement;
    const panel = panelRef.current;

    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    // The panel itself is the fallback target — it carries tabindex={-1}, so it
    // can hold focus even when the dialog opens with nothing focusable in it.
    (first ?? panel)?.focus();

    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [panelRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab" || panelRef.current === null) return;

      // Queried on every Tab rather than once: a dialog's content can change
      // while it is open — the rule editor adds and removes match conditions —
      // so a list captured on mount would go stale and let focus escape through
      // a control that was not there at open time.
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
  }, [panelRef]);
}
