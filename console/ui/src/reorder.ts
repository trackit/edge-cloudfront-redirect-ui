/**
 * The list arithmetic behind drag-to-reorder, with no DOM and no React in it.
 *
 * A drop is described as a **gap**, not as an index: `0` is above the first row,
 * `list.length` is below the last, and gap `n` is the space above row `n`. That
 * is what a pointer between two rows actually picks out, and it is the one
 * formulation where "dropped where it started" is expressible — gaps `from` and
 * `from + 1` are both the row's own position, which `isNoOpSlot` reads as no
 * change rather than as a move by nothing.
 */

/**
 * The list with the row at `from` moved into `slot`.
 *
 * The `slot > from` adjustment is the part worth stating: the gaps are numbered
 * against the list *before* the row is lifted out, so every gap below the row
 * shifts up by one once it is gone.
 */
export const moveToSlot = <T>(list: T[], from: number, slot: number): T[] => {
  const next = [...list];
  const [row] = next.splice(from, 1);
  if (row === undefined) return list;

  next.splice(slot > from ? slot - 1 : slot, 0, row);
  return next;
};

/**
 * Which gap a pointer at `y` is in, given each row's vertical midpoint in the
 * same coordinate space (viewport pixels, from `getBoundingClientRect`).
 *
 * Midpoints rather than edges: a row is claimed by the gap above it until the
 * pointer is more than half way down it, which is what makes the insertion line
 * follow the cursor without flickering as it crosses a border.
 */
export const slotFromMidpoints = (midpoints: number[], y: number): number =>
  midpoints.filter((midpoint) => y > midpoint).length;

/** True when dropping the row from `from` into `slot` would not move it. */
export const isNoOpSlot = (from: number, slot: number): boolean =>
  slot === from || slot === from + 1;

/**
 * The gap one step up or down from `from` — what an arrow key on the handle
 * means. Down is `from + 2` rather than `from + 1` because the latter is the
 * row's own gap: it would be a no-op, not a move past its neighbour.
 */
export const stepSlot = (from: number, direction: "up" | "down"): number =>
  direction === "up" ? from - 1 : from + 2;
