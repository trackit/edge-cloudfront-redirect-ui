interface Props {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

/* Labelled on/off switch row used across the editors. */
export default function Toggle({
  label,
  description,
  checked,
  onChange,
}: Props) {
  return (
    <div className="toggle-row">
      <div>
        <div className="tl">{label}</div>
        {description && <div className="td">{description}</div>}
      </div>
      <button
        className={`switch ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
        aria-label={label}
      />
    </div>
  );
}
