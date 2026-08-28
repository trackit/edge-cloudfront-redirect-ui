interface Props {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/**
 * A labelled on/off switch.
 *
 * `role="switch"` with `aria-checked` rather than a styled checkbox: the control
 * takes effect on the value it represents, and "on/off" is what a screen reader
 * should announce, not "checked".
 *
 * The whole row is the button, not just the track beside a label: a native
 * checkbox toggles when its label is clicked, and a span next to a 42px track
 * gives up most of that hit target. The visible text inside is the accessible
 * name, so there is no `aria-label` to drift out of sync with it, and the track
 * is decorative — `aria-hidden` — since the button already carries the state.
 */
export default function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className="toggle-row"
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {description !== undefined && (
          <span className="toggle-desc">{description}</span>
        )}
      </span>
      <span className={`switch${checked ? " is-on" : ""}`} aria-hidden="true">
        <span className="switch-knob" />
      </span>
    </button>
  );
}
