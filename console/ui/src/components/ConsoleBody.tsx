import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import AddHostModal from "./AddHostModal";
import HostsSidebar from "./HostsSidebar";
import { useHosts } from "../hosts";
import { hostPath } from "../hostRoutes";
import type { Distribution } from "../types";

interface Props {
  distribution: Distribution;
}

/**
 * The console proper: the host list on the left, the addressed host on the
 * right. Everything below the title — the rule list, its filters and the
 * editors — belongs to the rules ticket and lands in this main area.
 *
 * Kept out of ConsolePage because that page owns which *screen* is showing
 * (connect, settings, console); this owns what the console screen contains.
 */
export default function ConsoleBody({ distribution }: Props) {
  const { state, reload } = useHosts(distribution.targetId);
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();

  // Decoded by React Router, so this is the host itself, not its URL spelling.
  const { host } = useParams<{ host: string }>();
  const current = host ?? null;

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

  const modal = adding ? (
    <AddHostModal
      targetId={distribution.targetId}
      onClose={() => setAdding(false)}
      onAdded={added}
    />
  ) : null;

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

  // The sidebar's own add button is not on screen in this state, so the empty
  // view has to carry one — otherwise a target with no hosts has no way to gain
  // its first.
  if (hosts.length === 0) {
    return (
      <main className="console-note">
        <h1>No hosts yet</h1>
        <p>
          A host is a domain your distribution serves. Add one to start writing
          redirect and rewrite rules for it.
        </p>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => setAdding(true)}
        >
          Add a host
        </button>
        {modal}
      </main>
    );
  }

  // Land on a host rather than an empty right-hand pane. `replace` so the
  // hostless URL does not sit in history, where Back would bounce off it
  // straight back to the host just left.
  if (current === null) {
    return <Navigate to={hostPath(hosts[0].host)} replace />;
  }

  const known = hosts.some((h) => h.host === current);

  return (
    <div className="console-body">
      <HostsSidebar
        hosts={hosts}
        current={current}
        onAdd={() => setAdding(true)}
      />

      <main className="host-view">
        <header className="host-head">
          <h1 className="host-name mono">{current}</h1>
          <p className="host-sub mono">
            {distribution.distributionId} · {distribution.tableName}
          </p>
        </header>

        {known ? (
          <p className="console-note-inline">
            Rules for this host arrive with the rule list.
          </p>
        ) : (
          /* Reachable from a stale link or a host someone else deleted. Saying
             so beats an empty pane that looks like a host with no rules. */
          <div className="console-error" role="alert">
            <strong>No such host</strong>
            <span>
              “{current}” is not in this target. It may have been deleted, or
              the link may point at another distribution.
            </span>
          </div>
        )}
      </main>

      {modal}
    </div>
  );
}
