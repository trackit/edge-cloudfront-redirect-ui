import { useState } from "react";
import Brand from "../components/Brand";
import ConsoleBody from "../components/ConsoleBody";
import DistributionChip from "../components/DistributionChip";
import ProfileMenu from "../components/ProfileMenu";
import OnboardingScreen from "../components/OnboardingScreen";
import SettingsModal from "../components/SettingsModal";
import { useAuth, useCanWrite } from "../auth/useAuth";
import { useDistributions } from "../domain/distribution";

/**
 * Which overlay the console is showing. `null` is the console itself; `add`
 * replaces the page with the link screen; `settings` keeps the console and
 * opens a centred dialog over it.
 */
type Flow = null | "add" | "settings";

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

      <ConsoleBody
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
