import { Link } from "react-router-dom";
import type { HostSummary } from "../api";
import { hostPath } from "../hostRoutes";
import { IconPlus, IconTrash } from "./icons";

interface Props {
  hosts: HostSummary[];
  /** The host the console is showing, or `null` when none is addressed yet. */
  current: string | null;
  onAdd: () => void;
  /** Takes the whole summary, so the confirmation can name what will be lost. */
  onDelete: (host: HostSummary) => void;
}

/**
 * How many rules a host has, in words. The count includes disabled rules — it
 * counts what is stored, matching the badges beside it and the list the main
 * area shows.
 */
const ruleCount = (host: HostSummary): string => {
  const total = host.redirects + host.rewrites;
  if (total === 0) return "No rules";
  return total === 1 ? "1 rule" : `${total} rules`;
};

/*
  The host list. Every entry is a real link rather than a click handler, so the
  browser's own affordances still work — middle-click, copy link address, and
  the back button after picking a host.
*/
export default function HostsSidebar({
  hosts,
  current,
  onAdd,
  onDelete,
}: Props) {
  return (
    <nav className="hosts" aria-label="Hosts">
      <div className="hosts-head">
        <span className="hosts-title">Hosts</span>
        <span className="hosts-count">{hosts.length}</span>
        <button
          className="hosts-add"
          type="button"
          onClick={onAdd}
          // The icon alone says nothing to a screen reader, and "add" without a
          // noun is no better in a page that also adds rules.
          aria-label="Add a host"
          title="Add a host"
        >
          <IconPlus size={15} />
        </button>
      </div>

      <ul className="hosts-list">
        {hosts.map((host) => {
          const active = host.host === current;

          return (
            /* The delete button is a sibling of the link, never inside it: a
               button nested in an anchor is invalid HTML, and a click on it
               would navigate to the host it is about to delete. */
            <li key={host.host} className="hosts-row">
              <Link
                to={hostPath(host.host)}
                className={`hosts-item${active ? " is-active" : ""}`}
                // The visual highlight alone does not reach a screen reader, and
                // this is a list of links rather than tabs, so `aria-current`
                // is what says which one the page is showing.
                aria-current={active ? "page" : undefined}
              >
                <span className="hosts-item-main">
                  <span className="hosts-item-name mono">{host.host}</span>
                  <span className="hosts-item-sub">{ruleCount(host)}</span>
                </span>

                <span className="hosts-badges">
                  {host.redirects > 0 && (
                    <span
                      className="hosts-badge is-redirect"
                      title={`${host.redirects} redirect rules`}
                    >
                      {host.redirects}R
                    </span>
                  )}
                  {host.rewrites > 0 && (
                    <span
                      className="hosts-badge is-rewrite"
                      title={`${host.rewrites} rewrite rules`}
                    >
                      {host.rewrites}W
                    </span>
                  )}
                </span>
              </Link>

              <button
                className="hosts-del"
                type="button"
                onClick={() => onDelete(host)}
                // Names the host: "Delete" alone is ambiguous read out of a list
                // of them, and this is the destructive one.
                aria-label={`Delete ${host.host}`}
                title={`Delete ${host.host}`}
              >
                <IconTrash size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
