/**
 * Where focus goes in a grid of chips for a key press — the whole of a roving
 * tabindex, kept pure so it is tested without a browser. `columns` is how many
 * chips the current layout fits on a row, so Up and Down move by that much; a
 * layout that could not be measured counts as one column. `null` for a key
 * the grid does not handle, which then does what it does natively (Space and
 * Enter press the chip, Tab leaves the grid).
 */
export const nextIndex = (
  key: string,
  index: number,
  count: number,
  columns: number,
): number | null => {
  const last = count - 1;
  const row = Math.max(columns, 1);
  switch (key) {
    case "ArrowRight":
      return Math.min(index + 1, last);
    case "ArrowLeft":
      return Math.max(index - 1, 0);
    case "ArrowDown":
      return Math.min(index + row, last);
    case "ArrowUp":
      return Math.max(index - row, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
};
