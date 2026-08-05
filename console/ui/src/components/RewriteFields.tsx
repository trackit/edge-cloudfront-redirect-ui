import Toggle from "./Toggle";
import { IconInfo } from "./icons";
import type {
  CustomDraft,
  OriginKind,
  RewriteDraft,
  S3Draft,
} from "../ruleDraft";

interface Props {
  draft: RewriteDraft;
  onChange: (patch: Partial<RewriteDraft>) => void;
}

/**
 * Only the two origins a rewrite can point at. `none` stays in the draft — it is
 * what a path-only rewrite loads as, and what a new one starts as — but it is not
 * offered as a card: picking "no origin" is expressed by leaving both unpicked
 * and filling the forwarded path instead.
 */
const ORIGIN_KINDS: { value: OriginKind; label: string; hint: string }[] = [
  {
    value: "custom",
    label: "Custom origin",
    hint: "Any HTTP(S) backend",
  },
  {
    value: "s3",
    label: "S3 origin",
    hint: "An S3 bucket",
  },
];

const PROTOCOLS: CustomDraft["protocol"][] = [
  "https-only",
  "http-only",
  "match-viewer",
  "https",
  "http",
];

const REGIONS = [
  "us-east-1",
  "us-west-2",
  "eu-west-1",
  "eu-west-3",
  "eu-central-1",
  "ap-southeast-1",
  "ap-northeast-1",
];

/**
 * The rewrite-specific half of the editor.
 *
 * A rewrite has two independent levers — where the request goes (the origin) and
 * what it asks for (the path) — and either alone is a valid rule. They are
 * presented as two sections for that reason, rather than as one destination.
 */
export default function RewriteFields({ draft, onChange }: Props) {
  const patchS3 = (patch: Partial<S3Draft>): void =>
    onChange({ s3: { ...draft.s3, ...patch } });

  const patchCustom = (patch: Partial<CustomDraft>): void =>
    onChange({ custom: { ...draft.custom, ...patch } });

  return (
    <>
      <p className="callout">
        <IconInfo size={15} />
        <span>
          Rewrites are invisible to the user — they change where CloudFront
          fetches content from, without changing the URL in the browser.
        </span>
      </p>

      <fieldset className="editor-section">
        <legend>Target origin</legend>

        {/*
          Real radios inside labels rather than buttons with `aria-checked`: a
          radio group answers to the arrow keys for free, and the browser owns
          the roving focus a hand-rolled group would have to reimplement.
        */}
        <div className="origin-cards">
          {ORIGIN_KINDS.map((kind) => (
            <label
              key={kind.value}
              className={`origin-card${draft.originKind === kind.value ? " is-on" : ""}`}
            >
              <input
                type="radio"
                name="originKind"
                value={kind.value}
                checked={draft.originKind === kind.value}
                onChange={() => onChange({ originKind: kind.value })}
              />
              <span className="origin-card-name">{kind.label}</span>
              <span className="origin-card-hint">{kind.hint}</span>
            </label>
          ))}
        </div>

        {draft.originKind === "s3" && (
          <>
            <div className="field">
              <label htmlFor="s3-domain">Bucket domain name</label>
              <input
                id="s3-domain"
                className="input mono"
                placeholder="example-assets.s3.us-east-1.amazonaws.com"
                value={draft.s3.domainName}
                onChange={(event) =>
                  patchS3({ domainName: event.target.value })
                }
              />
              <p className="hint">
                The bucket&apos;s regional endpoint, not the bucket name alone.
              </p>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="s3-auth">Auth method</label>
                <select
                  id="s3-auth"
                  className="select"
                  value={draft.s3.authMethod}
                  onChange={(event) =>
                    patchS3({
                      authMethod: event.target.value as S3Draft["authMethod"],
                    })
                  }
                >
                  <option value="origin-access-identity">
                    origin-access-identity
                  </option>
                  <option value="none">none — public bucket</option>
                </select>
              </div>

              {/* The schema requires `region` for origin-access-identity and
                  forbids it for `none`, so the field appears and disappears with
                  the choice instead of being sent empty. */}
              {draft.s3.authMethod === "origin-access-identity" && (
                <div className="field">
                  <label htmlFor="s3-region">Bucket region</label>
                  <select
                    id="s3-region"
                    className="select"
                    value={draft.s3.region}
                    onChange={(event) =>
                      patchS3({ region: event.target.value })
                    }
                  >
                    {REGIONS.map((region) => (
                      <option key={region} value={region}>
                        {region}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="field">
              <label htmlFor="s3-path">Origin path</label>
              <input
                id="s3-path"
                className="input mono"
                placeholder="(optional)"
                value={draft.s3.path}
                onChange={(event) => patchS3({ path: event.target.value })}
              />
              <p className="hint">
                Prefixed to every request sent to the bucket. Leave empty for
                none.
              </p>
            </div>
          </>
        )}

        {draft.originKind === "custom" && (
          <>
            <div className="field">
              <label htmlFor="custom-domain">Domain name</label>
              <input
                id="custom-domain"
                className="input mono"
                placeholder="legacy-backend.internal.example.com"
                value={draft.custom.domainName}
                onChange={(event) =>
                  patchCustom({ domainName: event.target.value })
                }
              />
            </div>

            <div className="field-row-3">
              <div className="field">
                <label htmlFor="custom-protocol">Protocol</label>
                <select
                  id="custom-protocol"
                  className="select"
                  value={draft.custom.protocol}
                  onChange={(event) =>
                    patchCustom({
                      protocol: event.target.value as CustomDraft["protocol"],
                    })
                  }
                >
                  {PROTOCOLS.map((protocol) => (
                    <option key={protocol} value={protocol}>
                      {protocol}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="custom-port">Port</label>
                <input
                  id="custom-port"
                  className="input mono"
                  type="number"
                  value={draft.custom.port}
                  onChange={(event) =>
                    patchCustom({ port: event.target.value })
                  }
                />
              </div>

              <div className="field">
                <label htmlFor="custom-path">Origin path</label>
                <input
                  id="custom-path"
                  className="input mono"
                  placeholder="(optional)"
                  value={draft.custom.path}
                  onChange={(event) =>
                    patchCustom({ path: event.target.value })
                  }
                />
              </div>
            </div>

            <div className="field-row-3">
              <div className="field">
                <label htmlFor="custom-read">Read timeout (s)</label>
                <input
                  id="custom-read"
                  className="input mono"
                  type="number"
                  value={draft.custom.readTimeout}
                  onChange={(event) =>
                    patchCustom({ readTimeout: event.target.value })
                  }
                />
              </div>

              <div className="field">
                <label htmlFor="custom-keepalive">Keepalive (s)</label>
                <input
                  id="custom-keepalive"
                  className="input mono"
                  type="number"
                  value={draft.custom.keepaliveTimeout}
                  onChange={(event) =>
                    patchCustom({ keepaliveTimeout: event.target.value })
                  }
                />
              </div>

              <div className="field">
                <label htmlFor="custom-ssl">SSL protocols</label>
                <input
                  id="custom-ssl"
                  className="input mono"
                  placeholder="TLSv1.2"
                  value={draft.custom.sslProtocols}
                  onChange={(event) =>
                    patchCustom({ sslProtocols: event.target.value })
                  }
                />
              </div>
            </div>
          </>
        )}
      </fieldset>

      {/* Banded: the path and the switch are one decision — what the origin is
          asked for — so a rule sits above the heading and another under the
          switch, with nothing between them. */}
      <fieldset className="editor-section is-banded">
        <legend>Forwarded path</legend>

        <div className="field">
          <label htmlFor="pathAndQS">Rewritten path &amp; query string</label>
          <input
            id="pathAndQS"
            className="input mono"
            placeholder="/api/v1/legacy"
            value={draft.pathAndQS}
            onChange={(event) => onChange({ pathAndQS: event.target.value })}
          />
          <p className="hint">
            The path the request is forwarded with. Leave empty to keep the
            incoming path.
          </p>
        </div>

        <Toggle
          label="Keep incoming query string"
          description="Forward the visitor's original ?query to the origin."
          checked={draft.keepQueryString}
          onChange={(keepQueryString) => onChange({ keepQueryString })}
        />
      </fieldset>
    </>
  );
}
