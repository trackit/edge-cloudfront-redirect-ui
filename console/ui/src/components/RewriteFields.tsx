import Toggle from "./Toggle";
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

const ORIGIN_KINDS: { value: OriginKind; label: string; hint: string }[] = [
  {
    value: "none",
    label: "Keep the current origin",
    hint: "Only the path changes. The request still goes to the distribution's own origin.",
  },
  {
    value: "s3",
    label: "S3 bucket",
    hint: "Serve from a bucket instead. The edge swaps the origin at request time.",
  },
  {
    value: "custom",
    label: "Custom origin",
    hint: "Serve from any HTTP host — another backend, a legacy server.",
  },
];

const PROTOCOLS: CustomDraft["protocol"][] = [
  "https-only",
  "http-only",
  "match-viewer",
  "https",
  "http",
];

/**
 * A short list, not every TLS version CloudFront names. The schema takes free
 * strings, so this is a convenience over the ones worth choosing — TLSv1 and 1.1
 * are deprecated and offered only for a legacy origin that still requires them.
 */
const SSL_PROTOCOLS = ["TLSv1.2", "TLSv1.1", "TLSv1", "SSLv3"];

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

  const selected = ORIGIN_KINDS.find((kind) => kind.value === draft.originKind);

  return (
    <>
      <div className="field">
        <label htmlFor="originKind">Origin</label>
        <select
          id="originKind"
          className="select"
          value={draft.originKind}
          onChange={(event) =>
            onChange({ originKind: event.target.value as OriginKind })
          }
        >
          {ORIGIN_KINDS.map((kind) => (
            <option key={kind.value} value={kind.value}>
              {kind.label}
            </option>
          ))}
        </select>
        {selected !== undefined && <p className="hint">{selected.hint}</p>}
      </div>

      {draft.originKind === "s3" && (
        <fieldset className="origin">
          <legend>S3 origin</legend>

          <div className="field">
            <label htmlFor="s3-domain">Bucket domain name</label>
            <input
              id="s3-domain"
              className="input mono"
              placeholder="example-assets.s3.us-east-1.amazonaws.com"
              value={draft.s3.domainName}
              onChange={(event) => patchS3({ domainName: event.target.value })}
            />
            <p className="hint">
              The bucket&apos;s regional endpoint, not the bucket name alone.
            </p>
          </div>

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
                origin-access-identity — private bucket
              </option>
              <option value="none">none — public bucket</option>
            </select>
          </div>

          {/* The schema requires `region` for origin-access-identity and forbids
              it for `none`, so the field appears and disappears with the choice
              instead of being sent empty. */}
          {draft.s3.authMethod === "origin-access-identity" && (
            <div className="field">
              <label htmlFor="s3-region">Bucket region</label>
              <select
                id="s3-region"
                className="select"
                value={draft.s3.region}
                onChange={(event) => patchS3({ region: event.target.value })}
              >
                {REGIONS.map((region) => (
                  <option key={region} value={region}>
                    {region}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="field">
            <label htmlFor="s3-path">Origin path</label>
            <input
              id="s3-path"
              className="input mono"
              placeholder="(none)"
              value={draft.s3.path}
              onChange={(event) => patchS3({ path: event.target.value })}
            />
            <p className="hint">
              Prefixed to every request sent to the bucket. Leave empty for
              none.
            </p>
          </div>
        </fieldset>
      )}

      {draft.originKind === "custom" && (
        <fieldset className="origin">
          <legend>Custom origin</legend>

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

          <div className="origin-grid">
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
                onChange={(event) => patchCustom({ port: event.target.value })}
              />
            </div>
          </div>

          <div className="origin-grid">
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
              <label htmlFor="custom-keepalive">Keepalive timeout (s)</label>
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
          </div>

          <div className="field">
            <label htmlFor="custom-path">Origin path</label>
            <input
              id="custom-path"
              className="input mono"
              placeholder="(none)"
              value={draft.custom.path}
              onChange={(event) => patchCustom({ path: event.target.value })}
            />
          </div>

          <fieldset className="field ssl">
            <legend>TLS versions</legend>
            <div className="ssl-flags">
              {SSL_PROTOCOLS.map((protocol) => {
                const on = draft.custom.sslProtocols.includes(protocol);
                return (
                  <button
                    key={protocol}
                    type="button"
                    className={`flag${on ? " is-on" : ""}`}
                    aria-pressed={on}
                    onClick={() =>
                      patchCustom({
                        sslProtocols: on
                          ? draft.custom.sslProtocols.filter(
                              (value) => value !== protocol,
                            )
                          : [...draft.custom.sslProtocols, protocol],
                      })
                    }
                  >
                    {protocol}
                  </button>
                );
              })}
            </div>
            <p className="hint">
              What the edge will negotiate with this origin. TLSv1.2 unless the
              origin cannot do it.
            </p>
          </fieldset>
        </fieldset>
      )}

      <div className="field">
        <label htmlFor="pathAndQS">Rewrite the path to</label>
        <input
          id="pathAndQS"
          className="input mono"
          placeholder="/api/v1/legacy"
          value={draft.pathAndQS}
          onChange={(event) => onChange({ pathAndQS: event.target.value })}
        />
        <p className="hint">
          What the origin is asked for, instead of the incoming path. Leave
          empty to forward the path unchanged.
        </p>
      </div>

      <Toggle
        label="Keep the query string"
        description="Carry ?a=1 from the incoming request over to the origin"
        checked={draft.keepQueryString}
        onChange={(keepQueryString) => onChange({ keepQueryString })}
      />
    </>
  );
}
