import { sortKeyFor } from "../api";
import { PRIORITY_MAX, PRIORITY_MIN } from "../domain/ruleDraft";

interface Props {
  kind: "redirect" | "rewrite";
  value: string;
  onChange: (priority: string) => void;
}

/**
 * The priority, with the sort key it produces spelled out under it.
 *
 * Showing the key is what makes the consequence visible: priority is part of the
 * rule's identity, so changing it here moves the rule rather than editing it in
 * place. The key appears only once the value is one the server would accept —
 * echoing `REDIRECT#0NaN` back at someone mid-keystroke helps nobody.
 */
export default function PriorityField({ kind, value, onChange }: Props) {
  const parsed = Number(value);
  const usable =
    value.trim() !== "" &&
    Number.isInteger(parsed) &&
    parsed >= PRIORITY_MIN &&
    parsed <= PRIORITY_MAX;

  return (
    <div className="field">
      <label htmlFor="priority">Priority</label>
      <input
        id="priority"
        className="input mono"
        type="number"
        min={PRIORITY_MIN}
        max={PRIORITY_MAX}
        placeholder="100"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="hint">
        Lower = higher priority
        {usable && (
          <>
            {" · "}
            <span className="mono">{sortKeyFor(kind, parsed)}</span>
          </>
        )}
      </p>
    </div>
  );
}
