import type { MatchCondition } from "../api";
import { emptyMatch } from "../ruleDraft";
import { IconPlus, IconTrash } from "./icons";

interface Props {
  matches: MatchCondition[];
  onChange: (matches: MatchCondition[]) => void;
}

/**
 * Values come from the shared schema's `match` definition. Listed rather than
 * derived because a JSON Schema `enum` is not reachable at runtime from the
 * generated types — `openapi-rule-input.test.ts` guards the API side of the same
 * duplication, and a value added to the schema will fail to typecheck here.
 */
const TYPES: MatchCondition["matchType"][] = [
  "path",
  "hostname",
  "protocol",
  "regex",
  "header",
  "cookie",
];

const OPERATORS: MatchCondition["matchOperator"][] = [
  "equals",
  "contains",
  "regex",
];

/**
 * The `matches` builder, shared by the redirect and rewrite editors — the
 * conditions are the same shape for both, and the schema `$ref`s one definition
 * for them.
 *
 * All conditions must hold for a rule to fire, so they are listed as an AND, not
 * as a rule set with its own operators.
 */
export default function MatchConditions({ matches, onChange }: Props) {
  const update = (at: number, patch: Partial<MatchCondition>): void => {
    onChange(
      matches.map((match, i) => (i === at ? { ...match, ...patch } : match)),
    );
  };

  const remove = (at: number): void => {
    onChange(matches.filter((_, i) => i !== at));
  };

  return (
    <div className="matches">
      {matches.length === 0 && (
        <p className="matches-empty" role="status">
          No conditions, so this rule would fire on <strong>every</strong>{" "}
          request to this host. Add at least one unless that is really what you
          want.
        </p>
      )}

      {matches.map((match, at) => (
        /*
          Index as key. The conditions have no id, and nothing here reorders them
          — add appends, remove splices — so an index is stable for as long as a
          row exists. Keying on the value would remount a field on every
          keystroke and lose the caret.
        */
        <fieldset
          className="match"
          key={at}
          aria-labelledby={`match-title-${at}`}
        >
          <div className="match-head">
            <span className="match-legend" id={`match-title-${at}`}>
              Condition {at + 1}
            </span>
            <button
              type="button"
              className="icon-btn is-danger match-remove"
              onClick={() => remove(at)}
              aria-label={`Remove condition ${at + 1}`}
            >
              <IconTrash size={15} />
            </button>
          </div>

          <div className="match-grid">
            <div className="field">
              <label htmlFor={`match-type-${at}`}>Type</label>
              <select
                id={`match-type-${at}`}
                className="select"
                value={match.matchType}
                onChange={(event) => {
                  const matchType = event.target
                    .value as MatchCondition["matchType"];
                  // `headerName` is required when the type is `header` and
                  // rejected otherwise, so it is added and dropped with the type
                  // rather than left behind to fail validation on save.
                  update(at, {
                    matchType,
                    headerName:
                      matchType === "header"
                        ? (match.headerName ?? "")
                        : undefined,
                  });
                }}
              >
                {TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor={`match-op-${at}`}>Operator</label>
              <select
                id={`match-op-${at}`}
                className="select"
                value={match.matchOperator}
                onChange={(event) =>
                  update(at, {
                    matchOperator: event.target
                      .value as MatchCondition["matchOperator"],
                  })
                }
              >
                {OPERATORS.map((operator) => (
                  <option key={operator} value={operator}>
                    {operator}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor={`match-value-${at}`}>Value</label>
              <input
                id={`match-value-${at}`}
                className="input mono"
                placeholder={
                  match.matchOperator === "regex" ? "^/support/.+" : "/old-path"
                }
                value={match.matchValue}
                onChange={(event) =>
                  update(at, { matchValue: event.target.value })
                }
              />
            </div>
          </div>

          {match.matchType === "header" && (
            <div className="field">
              <label htmlFor={`match-header-${at}`}>Header name</label>
              <input
                id={`match-header-${at}`}
                className="input mono"
                placeholder="x-custom-header"
                value={match.headerName ?? ""}
                onChange={(event) =>
                  update(at, { headerName: event.target.value })
                }
              />
              <p className="hint">
                Required for a header condition, and rejected for any other
                type.
              </p>
            </div>
          )}

          <div className="match-flags">
            <Toggleable
              label="Negate"
              hint="Fires when the condition does not hold"
              on={match.negate === true}
              onClick={() => update(at, { negate: match.negate !== true })}
            />
            <Toggleable
              label="Case sensitive"
              hint="Compare exactly, including case"
              on={match.caseSensitive === true}
              onClick={() =>
                update(at, { caseSensitive: match.caseSensitive !== true })
              }
            />
          </div>
        </fieldset>
      ))}

      <button
        type="button"
        className="add-match"
        onClick={() => onChange([...matches, emptyMatch()])}
      >
        <IconPlus size={15} />
        Add condition
      </button>
    </div>
  );
}

/**
 * A compact two-state chip. `aria-pressed` rather than `role="switch"`: these sit
 * inline as a pair of modifiers on the condition above them, and the switches in
 * the editor are the labelled rows — using the same role for both would flatten
 * that distinction.
 */
function Toggleable({
  label,
  hint,
  on,
  onClick,
}: {
  label: string;
  hint: string;
  on: boolean;
  onClick: () => void;
}) {
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
