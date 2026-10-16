import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Brand from "../components/Brand";
import ConsoleBody from "../components/ConsoleBody";
import DistributionChip from "../components/DistributionChip";
import ProfileMenu from "../components/ProfileMenu";
import OnboardingScreen from "../components/OnboardingScreen";
import SettingsModal from "../components/SettingsModal";
import { useAuth, useCanWrite } from "../auth/useAuth";
import { useDistributions } from "../domain/distribution";
import { CONSOLE_PATH } from "../domain/hostRoutes";
import type { Distribution } from "../domain/types";

/**
 * Which overlay the console is showing. `null` is the console itself; `add`
 * replaces the page with the link screen; `settings` keeps the console and
 * opens a centred dialog over it.
 */
type Flow = null | "add" | "settings";

/**
 * What the host list and the selected host belong to. The table too, not only
 * the target: Settings can repoint a target at another table, whose hosts are
 * not the ones on screen.
 */
const hostsSource = (distribution: Distribution): string =>
  [distribution.targetId, distribution.region, distribution.tableName].join(
    "\u0000",
  );

/* Tickets: MVP - Front — Console + env configuration, Console - Display host,
   and CF-56. The team has no linked distribution → the link screen. Otherwise
   the bar carries the selected distribution and the team's others, and the host
   list and selected host below it. */
export default function ConsolePage() {
  const { user } = useAuth();
  const canWrite = useCanWrite();
  const { state, current, reload, forget, select, linked, unlinkCurrent } =
    useDistributions(user?.sub ?? user?.email);
  const [flow, setFlow] = useState<Flow>(null);
  const navigate = useNavigate();

  /*
    CF-58: the host is in the URL and the distribution is not, so a host from
    the distribution just left stayed selected and read "No such host". Whenever
    the distribution changes — the switcher, Unlink moving to the next one,
    linking another, a teammate unlinking this one — go back to the hostless
    path, which lands on the new one's first host or its empty state.

    Not on the first load, so a link to a host still opens it; and not on a
    reload of the list (Try again), where the distribution comes back the same.
    `replace`: the host left behind is not one Back can show under the new
    distribution.
  */
  const source = current === null ? null : hostsSource(current);
  const lastSource = useRef(source);
  useEffect(() => {
    if (source === null) return;
    const previous = lastSource.current;
    lastSource.current = source;
    if (previous !== null && previous !== source) {
      navigate(CONSOLE_PATH, { replace: true });
    }
  }, [source, navigate]);

  if (state.status === "loading") {
    return (
      <main className="console-note">
        <p>Loading distributions…</p>
      </main>
    );
  }

  // Never the link screen: that would tell a team whose list did not load that
  // it has none, and invite linking one again.
  if (state.status === "failed") {
    return (
      <main className="console-note">
        <div className="console-error" role="alert">
          <strong>Could not load the distributions</strong>
          <span>{state.error.message}</span>
        </div>
        <button className="btn btn-ghost" type="button" onClick={reload}>
          Try again
        </button>
      </main>
    );
  }

  if (current === null) {
    return <OnboardingScreen onLink={linked} readOnly={!canWrite} />;
  }

  /*
    Linking another distribution uses the full link screen — it is the same form
    as first-run, just cancellable. Settings is a short edit of three fields
    already in use, so it opens as a centred dialog over the console instead of
    tearing the page down.
  */
  if (flow === "add") {
    return (
      <OnboardingScreen
        onLink={(next) => {
          linked(next);
          setFlow(null);
        }}
        onCancel={() => setFlow(null)}
      />
    );
  }

  return (
    <div className="console">
      <header className="console-bar">
        <Brand />
        <DistributionChip
          distributions={state.distributions}
          current={current}
          onSelect={select}
          onAddDistribution={() => setFlow("add")}
          onOpenSettings={() => setFlow("settings")}
        />
        {/* The account belongs to the page, not to the distribution, so it sits
            at the far end of the bar rather than beside the chip. */}
        <div className="console-bar-end">
          <ProfileMenu />
        </div>
      </header>

      {/* Keyed so nothing carries over from the distribution before: not its
          host list, and not a host's open editor where two distributions share
          a host name. */}
      <ConsoleBody
        key={source}
        distribution={current}
        onUnlinked={(targetId) => {
          // Settings open on it would otherwise reopen on the next one, seeded
          // with its values, with no sign it switched.
          setFlow(null);
          forget(targetId);
        }}
      />

      {flow === "settings" && (
        <SettingsModal
          distribution={current}
          onSave={(next) => {
            linked(next);
            setFlow(null);
          }}
          onUnlink={async () => {
            await unlinkCurrent();
            setFlow(null);
          }}
          onClose={() => setFlow(null)}
        />
      )}
    </div>
  );
}
