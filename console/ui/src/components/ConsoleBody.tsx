import { useCallback, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import AddHostModal from "./AddHostModal";
import DeleteHostDialog from "./DeleteHostDialog";
import HostsSidebar from "./HostsSidebar";
import RuleEditor from "./RuleEditor";
import RuleList from "./RuleList";
import { IconClock, IconPlus } from "./icons";
import { resolveHostView, useHosts } from "../hosts";
import { takenPriorities, useRules } from "../rules";
import { CONSOLE_PATH, hostKey, hostPath } from "../hostRoutes";
import type { HostSummary, Rule, RuleInput } from "../api";
import type { Distribution } from "../types";

interface Props {
  distribution: Distribution;
}

/** What the rule editor is open on: an existing rule, or the kind being created. */
type EditorTarget = Rule | "redirect" | "rewrite" | null;

/**
 * The console proper: the host list on the left, the addressed host and its
 * rules on the right.
 *
 * Kept out of ConsolePage because that page owns which *screen* is showing
 * (connect, settings, console); this owns what the console screen contains.
 */
export default function ConsoleBody({ distribution }: Props) {
  const { state, reload } = useHosts(distribution.targetId);
  const [adding, setAdding] = useState(false);
  // The whole summary, not just the name: the confirmation names the rules that
  // go with it, and those counts are only in the list.
  const [deleting, setDeleting] = useState<HostSummary | null>(null);
  const navigate = useNavigate();

  // Decoded by React Router, so this is the host itself, not its URL spelling.
  //
  // Normalized because this value is matched against the list, printed as the
  // title, and compared against the host a delete just removed. Links from the
  // sidebar already carry the server's spelling, but a typed or shared
  // `/console/hosts/WWW.Example.com` would otherwise match nothing and claim a
  // host that plainly exists is not there.
  const { host } = useParams<{ host: string }>();
  const current = host === undefined ? null : hostKey(host);

  /*
    Reload rather than push the new host into the list here: the counts come from
    the server, and the host may already have had rules — created by someone else,
    or left behind by a host of the same name added before. Guessing them would
    show a count the rule list then contradicts.

    Navigating is what makes the add feel finished; it also covers the case where
    the host was already there and simply needed selecting.
  */
  const added = (host: string) => {
    setAdding(false);
    reload();
    navigate(hostPath(host));
  };

  /*
    Only leave the current host if it is the one that just went. Deleting another
    host from the list must not move the page out from under whoever is reading
    it. CONSOLE_PATH rather than a guess at the next host: it redirects to the
    first remaining one, or shows the empty view when that was the last host, and
    both of those decisions already live in one place below.
  */
  const deleted = (host: string) => {
    setDeleting(null);
    reload();
    // Normalized: this arrives from the deleted entry's own `host`, which is a
    // stored key rather than the value already put through `hostKey` above.
    if (hostKey(host) === current) navigate(CONSOLE_PATH, { replace: true });
  };

  const modal = (
    <>
      {adding && (
        <AddHostModal
          targetId={distribution.targetId}
          onClose={() => setAdding(false)}
          onAdded={added}
        />
      )}
      {deleting !== null && (
        <DeleteHostDialog
          targetId={distribution.targetId}
          host={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={deleted}
        />
      )}
    </>
  );

  /*
    The address bar is the last place a host's spelling survives un-normalized:
    everything below compares and renders `current`, so `/hosts/WWW.Example.com`
    would work while showing one host under two names — the title lowercase, the
    URL not, and a copied link differing from the one the sidebar produces.

    Before the load, because this needs no data — and `replace` so Back leaves
    the console rather than bouncing through the spelling just corrected.

    This terminates: the redirect target is built from `current`, which is
    already normalized, so the next render finds the two equal.
  */
  if (host !== undefined && host !== current) {
    return <Navigate to={hostPath(current ?? host)} replace />;
  }

  if (state.status === "loading") {
    return (
      <main className="console-note">
        <p>Loading hosts…</p>
      </main>
    );
  }

  if (state.status === "failed") {
    return (
      <main className="console-note">
        <div className="console-error" role="alert">
          <strong>Could not load the hosts</strong>
          <span>{state.error.message}</span>
        </div>
        <button className="btn btn-ghost" type="button" onClick={reload}>
          Try again
        </button>
      </main>
    );
  }

  const { hosts } = state;
  const view = resolveHostView(hosts, current);

  // The rail stays put with no hosts. It is where adding a host lives, and a
  // control that moves to the middle of the screen for the empty case and back
  // again once there is one host teaches the user nothing they can reuse. The
  // primary button below is a second way to the same modal, not the only one.
  if (view.kind === "empty") {
    return (
      <div className="console-body">
        <HostsSidebar
          hosts={hosts}
          current={null}
          onAdd={() => setAdding(true)}
          onDelete={setDeleting}
        />

        <main className="console-note">
          <h1>No hosts yet</h1>
          <p>
            A host is a domain your distribution serves. Add one to start
            writing redirect and rewrite rules for it.
          </p>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => setAdding(true)}
          >
            Add a host
          </button>
        </main>

        {modal}
      </div>
    );
  }

  // Land on a host rather than an empty right-hand pane. `replace` so the
  // hostless URL does not sit in history, where Back would bounce off it
  // straight back to the host just left.
  if (view.kind === "redirect") {
    return <Navigate to={hostPath(view.to)} replace />;
  }

  const { host: shown, known } = view;

  return (
    <div className="console-body">
      <HostsSidebar
        hosts={hosts}
        current={shown}
        onAdd={() => setAdding(true)}
        onDelete={setDeleting}
      />

      {known ? (
        /* Keyed on the host so its rules, the open editor and the in-flight
           writes are dropped when the selection moves — they belong to the host
           that was on screen, not to the next one. */
        <HostWorkspace
          key={shown}
          distribution={distribution}
          host={shown}
          onCountsChanged={reload}
        />
      ) : (
        <main className="host-view">
          <header className="host-head">
            <div className="host-title">
              <h1 className="host-name mono">{shown}</h1>
              <p className="host-sub mono">
                {distribution.distributionId} · {distribution.tableName}
              </p>
            </div>
          </header>

          {/* Reachable from a stale link or a host someone else deleted. Saying
              so beats an empty pane that looks like a host with no rules. */}
          <div className="console-error" role="alert">
            <strong>No such host</strong>
            <span>
              “{shown}” is not in this target. It may have been deleted, or the
              link may point at another distribution.
            </span>
          </div>
        </main>
      )}

      {modal}
    </div>
  );
}

/**
 * One host: its name as the title, and its redirects and rewrites below.
 *
 * `onCountsChanged` refreshes the sidebar after a write that adds or removes a
 * rule, so the counts beside each host stay the server's answer rather than
 * drifting from the list on screen. Toggling does not call it — a disabled rule
 * still counts, because the count is of rules that exist.
 */
function HostWorkspace({
  distribution,
  host,
  onCountsChanged,
}: {
  distribution: Distribution;
  host: string;
  onCountsChanged: () => void;
}) {
  const { grouped, loading, error, reload, create, update, toggle, remove } =
    useRules(distribution.targetId, host);
  const [editing, setEditing] = useState<EditorTarget>(null);
  const [busy, setBusy] = useState<string[]>([]);

  /** Marks a row busy for the duration of a write, so it cannot be double-fired. */
  const withBusy = useCallback(
    async (sk: string, action: () => Promise<unknown>): Promise<void> => {
      setBusy((prev) => [...prev, sk]);
      try {
        await action();
      } finally {
        setBusy((prev) => prev.filter((value) => value !== sk));
      }
    },
    [],
  );

  const save = async (input: RuleInput): Promise<void> => {
    // `editing` is a Rule when replacing one: its `sk` addresses the rule as
    // stored, while `priority` in the body says where it should end up. A changed
    // priority therefore moves it, which is a PUT, not a second create.
    if (editing !== null && typeof editing !== "string") {
      await update(editing.sk, input);
      return;
    }
    await create(input);
    onCountsChanged();
  };

  const confirmDelete = (rule: Rule): void => {
    const ok = window.confirm(
      `Delete this rule at priority ${rule.sk.split("#")[1]}?\n\n` +
        "It keeps serving traffic for about a minute after deletion, until the " +
        "edge cache expires.",
    );
    if (!ok) return;

    void withBusy(rule.sk, async () => {
      await remove(rule.sk);
      onCountsChanged();
    });
  };

  const editorTaken =
    editing === null
      ? []
      : takenPriorities(
          [...grouped.redirects, ...grouped.rewrites],
          typeof editing === "string"
            ? editing === "redirect"
              ? "erMatchRule"
              : "frMatchRule"
            : editing.type,
          typeof editing === "string" ? undefined : editing.sk,
        );

  return (
    <main className="host-view">
      <header className="host-head">
        <div className="host-title">
          <h1 className="host-name mono">{host}</h1>
          <p className="host-sub mono">
            {distribution.distributionId} · {distribution.tableName}
          </p>
        </div>

        {/* Creating is refused while the list could not be read. The editor
            checks a new priority against the rules it knows about, and it knows
            about none — so it would wave through a priority that is already
            taken and turn a clear failure into a confusing 409. */}
        <div className="host-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={error !== null}
            onClick={() => setEditing("rewrite")}
          >
            <IconPlus size={15} />
            Rewrite
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={error !== null}
            onClick={() => setEditing("redirect")}
          >
            <IconPlus size={15} />
            Redirect
          </button>
        </div>
      </header>

      {/* ER-306: a write is not live when it returns. Stated once, next to the
          list, rather than only inside the editor — it also explains a deletion
          that still redirects. */}
      <p className="propagation">
        <IconClock size={15} />
        Rule changes reach the edge in about a minute (edge cache TTL).
      </p>

      {error !== null && (
        <div className="form-error" role="alert">
          <strong>Could not load these rules</strong>
          <span>{error.message}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void reload()}
          >
            Try again
          </button>
        </div>
      )}

      <RuleList
        host={host}
        grouped={grouped}
        loading={loading}
        failed={error !== null}
        busy={busy}
        onCreate={setEditing}
        onEdit={setEditing}
        onToggle={(rule) => void withBusy(rule.sk, () => toggle(rule))}
        onDelete={confirmDelete}
      />

      {editing !== null && (
        <RuleEditor
          host={host}
          target={editing}
          taken={editorTaken}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </main>
  );
}
