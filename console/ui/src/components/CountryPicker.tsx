import { useMemo, useState } from "react";
import {
  OTHER_GROUP,
  codeFromQuery,
  countryLabel,
  groupCountries,
  matchesCountryQuery,
} from "../countries";
import { COUNTRY_CODES } from "../countries.gen";
import { IconCheck, IconPlus, IconSearch } from "./icons";
import Toggleable from "./Toggleable";

interface Props {
  /** ISO 3166-1 alpha-2 codes, as stored on the condition. */
  codes: string[];
  /** The condition's `negate`: the countries are excluded rather than matched. */
  excluded: boolean;
  onChange: (next: { codes: string[]; excluded: boolean }) => void;
}

const isKnown = (code: string): boolean =>
  COUNTRY_CODES.includes(code as never);

/**
 * Picks the countries a match condition applies to, and whether it includes or
 * excludes them.
 *
 * The list it offers is a convenience and never a gate. Three behaviours follow
 * from that, and they are the reason this component is not a plain multi-select:
 *
 * 1. A selected code the list does not contain is still shown, under "Other",
 *    and stays selected. Saving replaces the whole rule, so a code this does
 *    not render is a code the next save deletes.
 * 2. A search that matches nothing but looks like a code offers to use it
 *    verbatim, so a country CloudFront added since `countries.gen.ts` was
 *    generated does not have to wait for a release.
 * 3. An unrecognised code is flagged, not refused. We cannot tell a typo from a
 *    country we have not heard of, and the two deserve opposite answers, so the
 *    user is told and left to decide.
 */
export default function CountryPicker({ codes, excluded, onChange }: Props) {
  const [query, setQuery] = useState("");

  const selected = useMemo(() => new Set(codes), [codes]);

  // Selected codes are passed in so an unrecognised one is grouped rather than
  // dropped; recomputed as they change so a code added by the escape hatch
  // below appears immediately.
  const groups = useMemo(() => groupCountries(codes), [codes]);

  const visible = groups
    .map((group) => ({
      ...group,
      codes: group.codes.filter(
        // A selected country stays visible whatever the search says: it is the
        // current value, and hiding it makes the row look empty.
        (code) => selected.has(code) || matchesCountryQuery(code, query),
      ),
    }))
    .filter((group) => group.codes.length > 0);

  const nothingFound = !groups.some((group) =>
    group.codes.some((code) => matchesCountryQuery(code, query)),
  );
  const offered = nothingFound ? codeFromQuery(query) : undefined;

  const unknown = codes.filter((code) => !isKnown(code));

  const toggle = (code: string): void => {
    onChange({
      codes: selected.has(code)
        ? codes.filter((c) => c !== code)
        : [...codes, code],
      excluded,
    });
  };

  const add = (code: string): void => {
    setQuery("");
    if (!selected.has(code)) onChange({ codes: [...codes, code], excluded });
  };

  return (
    <div className="countries">
      <div className="field">
        <label htmlFor="country-search">Selected</label>
        {/* Read-only summary rather than a list of removable chips: the grid
            below is where a country is added and removed, and two places to
            deselect from is two places to get wrong. */}
        <p className="countries-selected" aria-live="polite">
          {codes.length === 0 ? (
            <span className="hint">No country selected yet.</span>
          ) : (
            codes.map(countryLabel).join(", ")
          )}
        </p>
      </div>

      <div className="input-icon">
        <IconSearch size={15} />
        <input
          id="country-search"
          className="input"
          type="search"
          placeholder="Search countries..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="country-groups">
        {visible.map((group) => (
          <div className="country-group" key={group.label}>
            <p className="country-group-label">
              {group.label === OTHER_GROUP ? "Not in our list" : group.label}
            </p>
            <div className="country-chips">
              {group.codes.map((code) => {
                const on = selected.has(code);
                const label = countryLabel(code);
                return (
                  <button
                    type="button"
                    key={code}
                    className={`country-chip${on ? " is-on" : ""}${
                      isKnown(code) ? "" : " is-unknown"
                    }`}
                    aria-pressed={on}
                    onClick={() => toggle(code)}
                  >
                    {on && <IconCheck size={13} />}
                    <span className="country-chip-name">{label}</span>
                    {/* Skipped when the label *is* the code, which is how an
                        unrecognised one renders — printing "FF FF" reads as a
                        bug. */}
                    {label !== code && (
                      <span className="country-chip-code">{code}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {offered !== undefined && (
          <button
            type="button"
            className="country-offer"
            onClick={() => add(offered)}
          >
            <IconPlus size={14} />
            Use code {offered}
          </button>
        )}

        {nothingFound && offered === undefined && (
          <p className="hint" role="status">
            No country matches “{query.trim()}”. A country code is exactly two
            letters.
          </p>
        )}
      </div>

      {unknown.length > 0 && (
        <p className="callout is-warn" role="status">
          <strong>{unknown.join(", ")}</strong>{" "}
          {unknown.length === 1 ? "is" : "are"} not in our country list. It will
          be saved, but it only matches if CloudFront reports that code. Check
          for a typo.
        </p>
      )}

      <div className="match-flags">
        <Toggleable
          label="Exclude these countries"
          hint="Fires for every country except the ones selected"
          on={excluded}
          onClick={() => onChange({ codes, excluded: !excluded })}
        />
      </div>
    </div>
  );
}
