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
 * should announce, not "checked". The visible label is the accessible name, so
 * there is no `aria-label` to drift out of sync with it.
 */
export default function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: Props) {
  return (
    <div className="toggle-row">
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {description !== undefined && (
          <span className="toggle-desc">{description}</span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={`switch${checked ? " is-on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-knob" aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </button>
    </div>
  );
}
