import { useState } from "react";
import Brand from "../components/Brand";
import ConsoleBody from "../components/ConsoleBody";
import DistributionChip from "../components/DistributionChip";
import OnboardingScreen from "../components/OnboardingScreen";
import SettingsModal from "../components/SettingsModal";
import { useDistributions } from "../distribution";

/**
 * Which overlay the console is showing. `null` is the console itself; `add`
 * replaces the page with the connect screen; `settings` keeps the console and
 * opens a centred dialog over it.
 */
type Flow = null | "add" | "settings";

/* Tickets: MVP - Front — Console + env configuration, and Console - Display host.
   Nothing configured → the connect screen. Configured → the bar carries the
   connected environment and the ones this browser knows about, and the host list
   and selected host below it. */
export default function ConsolePage() {
  const {
    distributions,
    current,
    connect,
    replaceCurrent,
    select,
    disconnectCurrent,
  } = useDistributions();
  const [flow, setFlow] = useState<Flow>(null);

  if (current === null) {
    return <OnboardingScreen onConnect={connect} />;
  }

  /*
    Adding a distribution still uses the full connect screen — it is the same
    form as first-run, just cancellable. Settings is a short edit of three fields
    already in use, so it opens as a centred dialog over the console instead of
    tearing the page down.

    `connectDistribution` already resolves a table that turns out to be registered
    already, so re-submitting unchanged values lands on the same target instead of
    failing.

    Changing the table in Settings registers a new target and leaves the previous
    one in the API's registry. Removing it needs a delete the AC does not ask for,
    and the registry is shared with anyone else pointed at the same table.
    Disconnect only forgets the entry in this browser.
  */
  if (flow === "add") {
    return (
      <OnboardingScreen
        onConnect={(next) => {
          connect(next);
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
          distributions={distributions}
          current={current}
          onSelect={select}
          onAddDistribution={() => setFlow("add")}
          onOpenSettings={() => setFlow("settings")}
        />
      </header>

      <ConsoleBody distribution={current} />

      {flow === "settings" && (
        <SettingsModal
          distribution={current}
          onSave={(next) => {
            replaceCurrent(next);
            setFlow(null);
          }}
          onDisconnect={() => {
            disconnectCurrent();
            setFlow(null);
          }}
          onClose={() => setFlow(null)}
        />
      )}
    </div>
  );
}
