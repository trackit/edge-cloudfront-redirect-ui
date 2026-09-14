import PriorityField from "./PriorityField";
import Toggle from "./Toggle";
import { canBeRelative, convertRedirectUrl, originOf } from "../ruleDraft";
import type { RedirectDraft } from "../ruleDraft";

interface Props {
  draft: RedirectDraft;
  /** The rule's host. Needed to convert the URL between relative and absolute. */
  host: string;
  onChange: (patch: Partial<RedirectDraft>) => void;
}

const STATUS_CODES = [
  { value: 301 as const, label: "301 — Moved Permanently" },
  { value: 302 as const, label: "302 — Found (temporary)" },
];

/** The redirect-specific half of the rule editor: what to answer, and with what. */
export default function RedirectFields({ draft, host, onChange }: Props) {
  // Offered only where it means "the same destination, written shorter". For a
  // redirect that points at another host it would move the destination, so it
  // is disabled and says which host it would have moved it to.
  const canGoRelative = canBeRelative(draft.redirectURL, host);
  const target = originOf(draft.redirectURL);

  return (
    <fieldset className="editor-section">
      <legend>Destination</legend>

      <div className="field-row">
        <div className="field">
          <label htmlFor="statusCode">Status code</label>
          <select
            id="statusCode"
            className="select"
            value={draft.statusCode}
            onChange={(event) =>
              onChange({ statusCode: Number(event.target.value) as 301 | 302 })
            }
          >
            {STATUS_CODES.map((code) => (
              <option key={code.value} value={code.value}>
                {code.label}
              </option>
            ))}
          </select>
        </div>

        <PriorityField
          kind="redirect"
          value={draft.priority}
          onChange={(priority) => onChange({ priority })}
        />
      </div>

      <div className="field">
        <label htmlFor="redirectURL">Redirect URL</label>
        <input
          id="redirectURL"
          className="input mono"
          placeholder={
            draft.relative ? "/new-landing" : "https://example.com/new-landing"
          }
          value={draft.redirectURL}
          onChange={(event) => onChange({ redirectURL: event.target.value })}
        />
      </div>

      <Toggle
        label="Relative URL"
        description={
          canGoRelative
            ? "Redirect to a path on the same host instead of an absolute URL."
            : `Unavailable: this points at ${target ?? "another host"}, and a path would send visitors to ${host} instead.`
        }
        checked={draft.relative}
        disabled={!canGoRelative}
        onChange={(relative) =>
          // Rewrites the value as well as the flag: the two forms describe the
          // same destination, so switching should not make the user retype it.
          //
          // Going relative also records the origin it dropped, so coming back
          // restores the address that was there rather than assuming https and
          // the default port.
          onChange({
            relative,
            relativeFrom: relative
              ? originOf(draft.redirectURL)
              : draft.relativeFrom,
            redirectURL: convertRedirectUrl(
              draft.redirectURL,
              relative,
              host,
              draft.relativeFrom,
            ),
          })
        }
      />

      <Toggle
        label="Keep incoming query string"
        description="Append the visitor's original ?query to the redirect target."
        checked={draft.keepQueryString}
        onChange={(keepQueryString) => onChange({ keepQueryString })}
      />
    </fieldset>
  );
}
