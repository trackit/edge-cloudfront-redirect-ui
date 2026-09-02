import { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconArrow, IconCheck, IconClose, IconInfo, IconUpload } from "./icons";
import { parseExport } from "../domain/akamaiImport";
import type {
  ImportPreview,
  ParsedRow,
  SourceFormat,
} from "../domain/akamaiImport";
import type { RedirectDraft } from "../domain/ruleDraft";
import type { ImportItem, ImportOutcome } from "../domain/rules";

interface Props {
  /** The distribution rules are imported into, named in the subtitle. */
  distributionId: string;
  /** Every host in the distribution, for the target-host picker. */
  hosts: string[];
  /** The host selected by default — the one the console was showing. */
  defaultHost: string;
  onImport: (items: ImportItem[]) => Promise<ImportOutcome>;
  /** Called on close after a run created at least one rule, to refresh counts. */
  onImported: () => void;
  onClose: () => void;
}

const FORMAT_LABEL: Record<SourceFormat, string> = {
  "edge-redirector-csv": "Edge Redirector CSV",
  "edge-redirector-policy-csv": "Edge Redirector policy CSV",
  "simple-csv": "Simple CSV",
  "match-rules-json": "matchRules JSON",
};

const ACCEPT = ".csv,.json,.txt";

/**
 * The condition a preview row leads with.
 *
 * Normally the path condition. But when the redirect reinjects a capture
 * (`$1` …), the regex that *provides* that capture is the meaningful matcher —
 * leading with a broad `path` pre-filter would hide where `$1` comes from — so
 * that regex is shown instead.
 */
const fromLabel = (draft: RedirectDraft): string => {
  if (draft.matches.length === 0) return "(any)";

  const reinjectsCapture = /\$[1-9]\d*/.test(draft.redirectURL);
  const captureSource = reinjectsCapture
    ? draft.matches.find((match) => match.matchOperator === "regex")
    : undefined;
  const lead =
    captureSource ??
    draft.matches.find((match) => match.matchType === "path") ??
    draft.matches[0];

  if (lead.matchType === "path" && lead.matchOperator !== "regex") {
    return lead.matchValue;
  }
  const name =
    lead.matchType === "header" && lead.headerName
      ? `header:${lead.headerName}`
      : lead.matchType;
  return `${name} ${lead.matchValue}`;
};

/** The right-aligned note on a row: why it was skipped, or what it lost. */
const noteFor = (row: ParsedRow): string => {
  if (row.status === "skipped") {
    if (row.validation.some((detail) => detail.path.includes("redirectURL"))) {
      return "Missing redirectURL.";
    }
    if (row.validation.length > 0) {
      return row.validation
        .map((detail) => `${detail.path} ${detail.message}`)
        .join(", ");
    }
  }
  return row.messages.join(", ");
};

/**
 * Import Akamai Edge Redirector rules into a distribution.
 *
 * A centred overlay rather than a native <dialog>, for the reason SettingsModal
 * documents: Strict Mode's mount/unmount probe fires the dialog's `close` event
 * and would tear the modal down before it sticks.
 *
 * The preview is derived, not stored: every keystroke, dropped file or change of
 * target host re-runs `parseExport`, so the table is exactly what Import sends.
 * Rules land on the target host unless they name their own hostname condition,
 * which is why one file can preview across several hosts.
 */
export default function ImportModal({
  distributionId,
  hosts,
  defaultHost,
  onImport,
  onImported,
  onClose,
}: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [targetHost, setTargetHost] = useState(defaultHost);
  const [filename, setFilename] = useState<string | undefined>(undefined);
  const [text, setText] = useState("");
  const [showFormats, setShowFormats] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const [dragover, setDragover] = useState(false);
  const [result, setResult] = useState<ImportOutcome | undefined>(undefined);

  /**
   * Refreshing the sidebar counts (`onImported`) reloads the host list, which
   * unmounts this modal — so it is deferred to close, not fired on success.
   * Doing it mid-run would tear the results down before they could be read.
   */
  const close = (): void => {
    if ((result?.created ?? 0) > 0) onImported();
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busyRef.current) closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  const preview: ImportPreview = useMemo(
    () => parseExport(text, { filename, defaultHost: targetHost }),
    [text, filename, targetHost],
  );

  const items: ImportItem[] = preview.rows
    .filter((row) => row.input !== undefined)
    .map((row) => ({ host: row.host, input: row.input! }));
  const hasFormat = preview.format !== "unrecognized";
  const done = result !== undefined;
  // The picker always offers the default host, even if the list has not loaded.
  const hostOptions = hosts.includes(defaultHost)
    ? hosts
    : [defaultHost, ...hosts];

  const loadFile = async (file: File): Promise<void> => {
    const content = await file.text();
    setFilename(file.name);
    setText(content);
    setResult(undefined);
  };

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault();
    setDragover(false);
    const file = event.dataTransfer.files[0];
    if (file !== undefined) void loadFile(file);
  };

  const doImport = async (): Promise<void> => {
    if (busy || done || items.length === 0) return;
    setBusy(true);
    try {
      setResult(await onImport(items));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) close();
      }}
    >
      <div
        className="modal modal-wide"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal-head">
          <div>
            <h2 id={titleId}>Import rules</h2>
            <p className="modal-sub">
              Rules are imported into{" "}
              <span className="mono">{distributionId}</span>
            </p>
          </div>
          <button
            className="modal-x"
            type="button"
            onClick={close}
            aria-label="Close"
            disabled={busy}
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="modal-body">
          <div className="field">
            <label htmlFor="import-target-host">Target host</label>
            <select
              id="import-target-host"
              className="select"
              value={targetHost}
              onChange={(event) => {
                setTargetHost(event.target.value);
                setResult(undefined);
              }}
            >
              {hostOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <div className="hint">
              Rules are imported into this host by default, unless the rule
              carries its own hostname condition.
            </div>
          </div>

          <div className="import-load">
            <div className="import-load-head">
              <span className="field-label">Load file (.csv, .json)</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-expanded={showFormats}
                onClick={() => setShowFormats((open) => !open)}
              >
                <IconInfo size={14} />
                Formats
              </button>
            </div>

            {showFormats && (
              <div className="callout" role="note">
                <IconInfo size={15} />
                <span>
                  Edge Redirector CSV (ruleName, matchURL, redirectURL,
                  result.statusCode); a simple source/target CSV; or a
                  matchRules JSON export (matches[] + result).
                </span>
              </div>
            )}

            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void loadFile(file);
                event.target.value = "";
              }}
            />

            <div
              className={`dropzone${dragover ? " dragover" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  fileRef.current?.click();
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragover(true);
              }}
              onDragLeave={() => setDragover(false)}
              onDrop={onDrop}
            >
              <IconUpload size={22} />
              <p className="dropzone-lead">
                {filename !== undefined ? (
                  <>
                    Loaded <span className="mono">{filename}</span>
                  </>
                ) : (
                  "Drag & drop a file here, or click to browse"
                )}
              </p>
              <button
                type="button"
                className="btn btn-dark btn-sm"
                onClick={(event) => {
                  event.stopPropagation();
                  fileRef.current?.click();
                }}
              >
                Browse files…
              </button>
            </div>
          </div>

          <div className="import-divider">
            <span>Manually edit if needed</span>
          </div>

          <textarea
            className="input mono import-textarea"
            rows={5}
            value={text}
            placeholder="Paste an Edge Redirector CSV or matchRules JSON…"
            aria-label="Export contents"
            onChange={(event) => {
              setText(event.target.value);
              setFilename(undefined);
              setResult(undefined);
            }}
          />

          {text.trim() !== "" && !hasFormat && (
            <div className="callout" role="status">
              <IconInfo size={15} />
              <span>{preview.error}</span>
            </div>
          )}

          {text.trim() !== "" && hasFormat && preview.error !== undefined && (
            <div className="form-error" role="alert">
              <span>{preview.error}</span>
            </div>
          )}

          {hasFormat && preview.rows.length > 0 && (
            <>
              <div className="import-badges">
                <span className="import-pill is-detected">
                  Detected: {FORMAT_LABEL[preview.format as SourceFormat]}
                </span>
                <span className="import-pill is-ready">
                  {preview.summary.ready} ready
                </span>
                {preview.summary.warnings > 0 && (
                  <span className="import-pill is-warning">
                    {preview.summary.warnings}{" "}
                    {preview.summary.warnings === 1 ? "warning" : "warnings"}
                  </span>
                )}
                {preview.summary.skipped > 0 && (
                  <span className="import-pill is-skipped">
                    {preview.summary.skipped} skipped
                  </span>
                )}
                {preview.summary.hosts > 1 && (
                  <span className="import-pill is-hosts">
                    {preview.summary.hosts} hosts
                  </span>
                )}
              </div>

              <h3 className="import-preview-title">Preview</h3>
              <ul className="import-rows">
                {preview.rows.map((row) => {
                  const note = noteFor(row);
                  return (
                    <li
                      key={row.index}
                      className={`import-row is-${row.status}`}
                    >
                      <span
                        className={`import-dot is-${row.status}`}
                        aria-hidden="true"
                      />
                      {row.draft.redirectURL !== "" && (
                        <span className="import-code">
                          {row.draft.statusCode}
                        </span>
                      )}
                      <span className="import-host">{row.host}</span>
                      <span className="import-from mono">
                        {fromLabel(row.draft)}
                      </span>
                      <span className="import-arrow" aria-hidden="true">
                        <IconArrow size={14} />
                      </span>
                      <span className="import-to mono">
                        {row.draft.redirectURL || "—"}
                      </span>
                      {note !== "" && (
                        <span className="import-note">{note}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {result !== undefined && (
            <div
              className={result.failures.length > 0 ? "form-error" : "callout"}
              role="status"
            >
              <strong>
                Imported {result.created}{" "}
                {result.created === 1 ? "rule" : "rules"}.
              </strong>
              {result.failures.length > 0 && (
                <ul>
                  {result.failures.map((failure) => (
                    <li key={failure.index}>
                      Row {failure.index + 1}: {failure.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <footer className="modal-foot">
          <button
            className="btn btn-ghost"
            type="button"
            disabled={busy}
            onClick={close}
          >
            {done ? "Close" : "Cancel"}
          </button>
          {!done && (
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || items.length === 0}
              onClick={() => void doImport()}
            >
              <IconCheck size={16} />
              {busy
                ? "Importing…"
                : `Import ${items.length} ${items.length === 1 ? "rule" : "rules"}`}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
