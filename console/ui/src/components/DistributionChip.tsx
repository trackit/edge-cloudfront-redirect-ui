import { useEffect, useRef, useState } from "react";
import type { Distribution } from "../types";
import {
  IconCheck,
  IconChevron,
  IconPlus,
  IconServer,
  IconSliders,
} from "./icons";

interface Props {
  distributions: readonly Distribution[];
  current: Distribution;
  onSelect: (distributionId: string) => void;
  onAddDistribution: () => void;
  onOpenSettings: () => void;
}

/**
 * The connected environment in the console bar, and the actions behind it.
 *
 * The three values were flat text before, which left nowhere to put an action
 * that belongs to the environment rather than to the page. Collapsing them into
 * one control gives them a single owner: the chip identifies what the console is
 * pointed at, and the panel under it holds everything that acts on it.
 *
 * The panel replaces the bar's `Disconnect` button. That button existed only so
 * the connect screen stayed reachable once an environment was configured, and
 * "Add distribution" reaches it now — so the escape hatch survives without a
 * destructive-sounding action sitting permanently in the bar.
 */
export default function DistributionChip({
  distributions,
  current,
  onSelect,
  onAddDistribution,
  onOpenSettings,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Dismissal. Both listeners are bound only while the panel is open, so a
   * closed chip costs nothing.
   *
   * `mousedown` rather than `click`: a click that starts outside and ends on the
   * panel would otherwise be read as "inside" and leave it open. Escape returns
   * focus to the trigger, because closing a panel that holds the focused element
   * would otherwise drop focus to the document and lose a keyboard user's place.
   */
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /** Runs an action and closes, so no caller has to remember to. */
  const act = (action: () => void) => (): void => {
    setOpen(false);
    action();
  };

  return (
    <div className="dist-switch" ref={rootRef}>
      {/*
        A real button, so Enter and Space work and screen readers announce the
        expanded state. Deliberately not `role="menu"`: that pattern owes the
        user arrow-key navigation and focus capture, and announcing a menu
        without them is worse than announcing nothing. Plain buttons in a
        labelled group are reachable with Tab, which is enough here.
      */}
      <button
        ref={triggerRef}
        type="button"
        className="dist-chip"
        aria-expanded={open}
        aria-controls="dist-panel"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="dist-ico" aria-hidden="true">
          <IconServer size={15} />
        </span>
        <span className="dist-meta">
          <span className="dist-id mono">{current.distributionId}</span>
          <span className="dist-table mono">
            {current.tableName} · {current.region}
          </span>
        </span>
        <span
          className={`dist-caret${open ? " is-open" : ""}`}
          aria-hidden="true"
        >
          <IconChevron size={14} />
        </span>
      </button>

      {open && (
        <div
          className="dist-panel"
          id="dist-panel"
          role="group"
          aria-label="Connected distributions"
        >
          <p className="dist-panel-head">Distributions</p>

          {/*
            Keyed on `distributionId`, not on `targetId`: two distributions served
            by the same rules table share one target id, so keying on that would
            collapse them into a single row. See the note in `distribution.ts`.

            The selected row is still a button. Clicking it re-selects what is
            already selected, which is a no-op — but disabling it would make the
            one row the user is most likely to aim at the only unclickable thing
            in the list.
          */}
          {distributions.map((entry) => {
            const isCurrent = entry.distributionId === current.distributionId;
            return (
              <button
                key={entry.distributionId}
                type="button"
                className={`dist-row${isCurrent ? " is-current" : ""}`}
                aria-current={isCurrent}
                onClick={act(() => onSelect(entry.distributionId))}
              >
                <span className="dist-ico" aria-hidden="true">
                  <IconServer size={14} />
                </span>
                <span className="dist-row-meta">
                  <span className="dist-id mono">{entry.distributionId}</span>
                  <span className="dist-table mono">
                    {entry.tableName} · {entry.region}
                  </span>
                </span>
                {isCurrent && (
                  <span className="dist-row-mark" aria-hidden="true">
                    <IconCheck size={16} />
                  </span>
                )}
              </button>
            );
          })}

          <div className="dist-panel-foot">
            {/*
              Add before Settings: it acts on the list above it, while Settings
              acts on the row that is selected in that list. Reading top to bottom
              then goes broad to narrow, which is also the order the design puts
              them in.
            */}
            <button
              type="button"
              className="dist-action"
              onClick={act(onAddDistribution)}
            >
              <IconPlus size={16} />
              Add distribution
            </button>
            <button
              type="button"
              className="dist-action"
              onClick={act(onOpenSettings)}
            >
              <IconSliders size={16} />
              Settings for current
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
