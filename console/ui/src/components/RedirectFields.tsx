import Toggle from "./Toggle";
import { convertRedirectUrl } from "../ruleDraft";
import type { RedirectDraft } from "../ruleDraft";

interface Props {
  draft: RedirectDraft;
  /** The rule's host. Needed to convert the URL between relative and absolute. */
  host: string;
  onChange: (patch: Partial<RedirectDraft>) => void;
}

const STATUS_CODES = [
  {
    value: 301 as const,
    label: "301 — Permanent",
    hint: "Browsers and search engines cache it. Use for a move that is final.",
  },
  {
    value: 302 as const,
    label: "302 — Temporary",
    hint: "Not cached as permanent. Use while the move may be reverted.",
  },
];

/** The redirect-specific half of the rule editor: what to answer, and with what. */
export default function RedirectFields({ draft, host, onChange }: Props) {
  const selected = STATUS_CODES.find((code) => code.value === draft.statusCode);

  return (
    <>
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
        {selected !== undefined && <p className="hint">{selected.hint}</p>}
      </div>

      <div className="field">
        <label htmlFor="redirectURL">Redirect to</label>
        <input
          id="redirectURL"
          className="input mono"
          placeholder={
            draft.relative ? "/new-landing" : "https://example.com/new-landing"
          }
          value={draft.redirectURL}
          onChange={(event) => onChange({ redirectURL: event.target.value })}
        />
        <p className="hint">
          {draft.relative
            ? "A path on this same host, starting with /."
            : "A full address, including https://. It may point at another host."}
        </p>
      </div>

      <Toggle
        label="Relative URL"
        description="Stay on this host and give only the path"
        checked={draft.relative}
        onChange={(relative) =>
          // Rewrites the value as well as the flag: the two forms describe the
          // same destination, so switching should not make the user retype it.
          onChange({
            relative,
            redirectURL: convertRedirectUrl(draft.redirectURL, relative, host),
          })
        }
      />

      <Toggle
        label="Keep the query string"
        description="Carry ?a=1 from the incoming request over to the destination"
        checked={draft.keepQueryString}
        onChange={(keepQueryString) => onChange({ keepQueryString })}
      />
    </>
  );
}
