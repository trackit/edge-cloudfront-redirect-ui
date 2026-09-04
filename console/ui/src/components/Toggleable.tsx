interface Props {
  label: string;
  hint: string;
  on: boolean;
  onClick: () => void;
}

/**
 * A compact two-state chip. `aria-pressed` rather than `role="switch"`: these
 * sit inline as modifiers on the control above them, and the switches in the
 * editor are the labelled rows — using the same role for both would flatten
 * that distinction.
 *
 * Extracted from `MatchConditions` so the country picker's include/exclude
 * button is the same control, and so it reads as pressed or not. A plain button
 * labelled with its action cannot say which state it is in.
 */
export default function Toggleable({ label, hint, on, onClick }: Props) {
  return (
    <button
      type="button"
      className={`flag${on ? " is-on" : ""}`}
      aria-pressed={on}
      title={hint}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
