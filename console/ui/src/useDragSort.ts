import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { isNoOpSlot, slotFromMidpoints } from "./domain/reorder";

/**
 * Dragging rows of a vertical list into a new order.
 *
 * Pointer events rather than HTML5 drag-and-drop: one code path covers mouse,
 * touch and pen, the drag can be styled (native DnD hands you a browser-drawn
 * ghost), and `setPointerCapture` keeps the events coming to the handle even
 * when the pointer leaves it — so there is nothing to attach to the window
 * except the escape hatch below.
 *
 * The hook owns *where the row would land*, not what that means. It reports a
 * gap and calls `onDrop` once, and the caller decides whether that is a write.
 *
 * Nothing here measures anything until a drag starts: rows are read from the
 * live DOM on each move, which is also what keeps the insertion line correct
 * when the list scrolls mid-drag.
 */

export interface DragSort {
  /** Index of the row being dragged, or `null` when no drag is in progress. */
  dragging: number | null;
  /**
   * Gap the row would drop into (`0`…`count`), or `null` when there is no drag
   * or the drop would not move it — so the caller can draw an insertion line
   * only where something actually changes.
   */
  slot: number | null;
  /** Spread onto row `index`'s drag handle. */
  handleProps: (index: number) => {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
  };
  /** Ref callback for row `index`'s element, so the hook can measure it. */
  rowRef: (index: number) => (element: HTMLElement | null) => void;
}

export function useDragSort(options: {
  count: number;
  /** A drag that starts is one that can be saved; a viewer's list passes `true`. */
  disabled?: boolean;
  onDrop: (from: number, slot: number) => void;
}): DragSort {
  const { count, disabled = false, onDrop } = options;

  const [drag, setDrag] = useState<{ from: number; slot: number } | null>(null);
  const rows = useRef(new Map<number, HTMLElement>());

  const rowRef = useCallback(
    (index: number) => (element: HTMLElement | null) => {
      if (element === null) rows.current.delete(index);
      else rows.current.set(index, element);
    },
    [],
  );

  /** Midpoints in row order. Read live — a stale rect is a misplaced line. */
  const midpoints = useCallback((): number[] => {
    const found: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const rect = rows.current.get(index)?.getBoundingClientRect();
      if (rect) found.push(rect.top + rect.height / 2);
    }
    return found;
  }, [count]);

  // Escape abandons the drag without moving anything. The only listener outside
  // the handle, because a key has no pointer to capture.
  useEffect(() => {
    if (drag === null) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDrag(null);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drag]);

  const handleProps = useCallback(
    (index: number) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>): void => {
        // Primary button only: a right-click drag would start one the user
        // cannot see the end of, since the context menu swallows the pointerup.
        if (disabled || event.button !== 0) return;

        // The handle keeps receiving move and up events wherever the pointer
        // goes, so a fast drag that outruns the cursor does not strand the list
        // mid-drag with no way to finish.
        event.currentTarget.setPointerCapture(event.pointerId);
        // Suppresses the text selection a press-and-move would otherwise start
        // across the rows being dragged over.
        event.preventDefault();
        setDrag({ from: index, slot: index });
      },

      onPointerMove: (event: ReactPointerEvent<HTMLElement>): void => {
        if (drag === null) return;

        const slot = slotFromMidpoints(midpoints(), event.clientY);
        // Compared before setting so a move within the same gap — most of them —
        // does not re-render the list.
        if (slot !== drag.slot) setDrag({ from: drag.from, slot });
      },

      onPointerUp: (event: ReactPointerEvent<HTMLElement>): void => {
        if (drag === null) return;

        event.currentTarget.releasePointerCapture(event.pointerId);
        setDrag(null);
        // Reported even when the row did not move: the caller decides what a
        // no-op drop costs, and it is the one that knows whether the list it is
        // showing is already the saved one.
        onDrop(drag.from, drag.slot);
      },

      onPointerCancel: (): void => setDrag(null),
    }),
    [disabled, drag, midpoints, onDrop],
  );

  return {
    dragging: drag?.from ?? null,
    slot: drag === null || isNoOpSlot(drag.from, drag.slot) ? null : drag.slot,
    handleProps,
    rowRef,
  };
}
