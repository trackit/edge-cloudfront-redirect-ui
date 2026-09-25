import type { MatchCondition } from "../api";
import {
  emptyMatch,
  formatCountries,
  isExcludingCountries,
  parseCountries,
  unavailableMatchTypes,
} from "../domain/ruleDraft";
import CountryPicker from "./CountryPicker";
import { IconInfo, IconPlus, IconTrash } from "./icons";
import Toggleable from "./Toggleable";

interface Props {
  matches: MatchCondition[];
  /**
   * A redirect with a geographic condition changes event, which words the
   * notice below and rules out header, cookie and protocol conditions beside it.
   */
  kind: "redirect" | "rewrite";
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
  "country",
];

/**
 * Only where the stored value is not what to show. `country` is stored as
 * `country` so `city` and `region` can be added beside it later — CloudFront
 * reports those too — but "Geographic location" is what it does.
 */
const TYPE_LABELS: Partial<Record<MatchCondition["matchType"], string>> = {
  country: "Geographic location",
};

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
export default function MatchConditions({ matches, kind, onChange }: Props) {
  const hasCountry = matches.some((match) => match.matchType === "country");

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
          <strong>Warning:</strong> No conditions, so this rule would fire on{" "}
          <strong>every</strong> request to this host. Add at least one unless
          that is really what you want.
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

          <div
            className={
              match.matchType === "country" ? "match-grid-geo" : "match-grid"
            }
          >
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
                  //
                  // Into or out of a country, the value, operator and negate
                  // are reset for the same reason: a path is not a country
                  // code, `notEquals` only exists for a country, and a country
                  // never carries `negate`. Carrying any of them across means a
                  // 400 on a field the editor no longer shows.
                  const crossesCountry =
                    matchType === "country" || match.matchType === "country";
                  update(at, {
                    matchType,
                    matchValue: crossesCountry ? "" : match.matchValue,
                    matchOperator: crossesCountry
                      ? "equals"
                      : match.matchOperator,
                    negate: crossesCountry ? false : match.negate,
                    headerName:
                      matchType === "header"
                        ? (match.headerName ?? "")
                        : undefined,
                  });
                }}
              >
                {/* Disabled rather than hidden, with the reason in the label:
                    an option that vanishes when a second condition is added
                    reads as a bug. The current type stays selectable, so a
                    rule loaded in that state still shows what it holds, and
                    validateDraft reports it. */}
                {TYPES.map((type) => {
                  const unavailable =
                    type !== match.matchType &&
                    unavailableMatchTypes(kind, matches, at).has(type);
                  return (
                    <option key={type} value={type} disabled={unavailable}>
                      {TYPE_LABELS[type] ?? type}
                      {unavailable &&
                        (type === "country"
                          ? " (not with header, cookie or protocol on a redirect)"
                          : " (not with a geographic location on a redirect)")}
                    </option>
                  );
                })}
              </select>
            </div>

            {match.matchType === "country" ? (
              <CountryPicker
                codes={parseCountries(match.matchValue)}
                excluded={isExcludingCountries(match)}
                onChange={({ codes, excluded }) =>
                  update(at, {
                    matchValue: formatCountries(codes),
                    matchOperator: excluded ? "notEquals" : "equals",
                    negate: false,
                  })
                }
              />
            ) : (
              <>
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
                      match.matchOperator === "regex"
                        ? "^/support/.+"
                        : "/old-path"
                    }
                    value={match.matchValue}
                    onChange={(event) =>
                      update(at, { matchValue: event.target.value })
                    }
                  />
                </div>
              </>
            )}
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

          {/* Hidden for a country: `negate` is the picker's own "Exclude these
              countries" button, and case cannot mean anything on two uppercase
              letters. A visible control with no effect is worse than no
              control. */}
          {match.matchType !== "country" && (
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
          )}
        </fieldset>
      ))}

      {/* Said here rather than in the picker because it is about the rule, not
          about the countries, and because a user who never sees it creates a
          rule that quietly never fires. */}
      {hasCountry && (
        <p className="callout">
          <IconInfo size={15} />
          <span>
            The viewer's country comes from CloudFront, so this rule only fires
            if the distribution asks for <code>CloudFront-Viewer-Country</code>:
            in its cache key when the behavior caches, or in its origin request
            policy when caching is disabled.
            {kind === "redirect" &&
              " It is also answered at the origin request stage, which means on a cache miss, and so cannot check headers, cookies or the protocol."}
          </span>
        </p>
      )}

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
