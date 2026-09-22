import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FORMAT_HELP, FORMAT_LABEL } from "../domain/importFormats";

interface Props {
  /**
   * The button it hangs from. Used to place the panel, and to recognise the
   * toggle's own clicks — those are the caller's to handle, so dismissing here
   * as well would close and reopen in one gesture.
   */
  anchor: HTMLElement | null;
  onDismiss: () => void;
}

/** How far the panel keeps away from the edges of the window. */
const MARGIN = 8;
const WIDTH = 460;
/** Taller than the longest tab, so on a normal window nothing is capped. */
const MAX_HEIGHT = 520;
/** The gap between the button and the panel below it. */
const OFFSET = 6;

/**
 * The accepted import formats, one tab at a time.
 *
 * Rendered through a portal onto `document.body` rather than inline. The button
 * that opens it sits inside the import dialog's scrolling body, so an inline
 * panel is clipped by that scroll container the moment it is taller than the
 * space below the button — which, with an example in it, is always. Being out
 * here is also what lets it overlap the dialog's own edge instead of forcing
 * the dialog to grow.
 *
 * Not a modal: it takes focus for the keyboard's sake and hands it straight
 * back, but it never traps it, and the dialog underneath stays live.
 */
export default function FormatsPopover({ anchor, onDismiss }: Props) {
  const tabsId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedTabRef = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState(0);
  const [placement, setPlacement] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  }>();

  // Layout effect, so the panel is never painted at 0,0 before it is placed.
  useLayoutEffect(() => {
    if (anchor === null) return;

    const place = (): void => {
      const rect = anchor.getBoundingClientRect();
      // Right-aligned to the button, then pulled back inside the viewport. The
      // button sits at the right end of its row, so hanging the panel leftwards
      // is what keeps it on screen at the narrowest width the console supports.
      const left = Math.max(
        MARGIN,
        Math.min(rect.right - WIDTH, window.innerWidth - WIDTH - MARGIN),
      );

      /*
        Below the button, then slid up by however much of it would fall off the
        bottom of the window. The matchRules tab is sixteen lines tall, and this
        panel is both portalled and fixed — so nothing clips that overflow and
        nothing scrolls to it either; it would simply be unreadable.

        Sliding rather than flipping to the other side of the button: the button
        sits near the top of a vertically centred dialog, so there is always
        less room above it than below, and a flip would move the panel somewhere
        worse. Measuring the panel is what keeps the slide honest — a short tab
        is not pushed up to make room it does not need.
      */
      const maxHeight = Math.min(MAX_HEIGHT, window.innerHeight - 2 * MARGIN);
      const height = Math.min(
        maxHeight,
        panelRef.current?.scrollHeight ?? maxHeight,
      );
      const top = Math.min(
        rect.bottom + OFFSET,
        window.innerHeight - MARGIN - height,
      );

      setPlacement({ top: Math.max(MARGIN, top), left, maxHeight });
    };

    place();
    // `true` so this also fires for the dialog body scrolling, which does not
    // bubble: without it the panel hangs in place while its button moves away.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
    // `selected` too: the tabs differ in height, so switching to the tall one
    // has to re-measure or it hangs off the bottom the slide exists to prevent.
  }, [anchor, selected]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    selectedTabRef.current?.focus();

    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) === true) return;
      if (anchor?.contains(target) === true) return;
      onDismiss();
    };

    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      previouslyFocused?.focus();
    };
    // Subscribed once on purpose: `onDismiss` and `anchor` are stable for as
    // long as this is open, and re-subscribing mid-gesture would drop the
    // listener between a mousedown and its mouseup.
  }, []);

  const help = FORMAT_HELP[selected];

  /** Left/Right move between tabs, which is what makes a tablist a tablist. */
  const onTabKeyDown = (event: React.KeyboardEvent): void => {
    const delta =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    setSelected(
      (current) => (current + delta + FORMAT_HELP.length) % FORMAT_HELP.length,
    );
  };

  return createPortal(
    <div
      className="formats-popover"
      ref={panelRef}
      role="group"
      aria-label="Accepted import formats"
      style={{
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        width: WIDTH,
        maxHeight: placement?.maxHeight,
        visibility: placement === undefined ? "hidden" : undefined,
      }}
    >
      <div className="seg formats-tabs" role="tablist" aria-label="Formats">
        {FORMAT_HELP.map((entry, index) => (
          <button
            key={entry.format}
            ref={index === selected ? selectedTabRef : undefined}
            type="button"
            role="tab"
            id={`${tabsId}-tab-${entry.format}`}
            aria-selected={index === selected}
            aria-controls={`${tabsId}-panel`}
            // Only the selected tab is in the tab order; the arrows move
            // between them. Four stops on the way past a help panel is four
            // too many.
            tabIndex={index === selected ? 0 : -1}
            className={index === selected ? "is-active" : ""}
            onClick={() => setSelected(index)}
            onKeyDown={onTabKeyDown}
          >
            {FORMAT_LABEL[entry.format]}
          </button>
        ))}
      </div>

      <div
        className="formats-panel"
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-tab-${help.format}`}
      >
        <p className="formats-blurb">{help.blurb}</p>
        <pre className="formats-example mono">
          <code>{help.example}</code>
        </pre>
        <p className="formats-file">
          Detected from the extension first, so name it{" "}
          <span className="mono">{help.filename}</span> or paste the text.
        </p>
      </div>
    </div>,
    document.body,
  );
}
