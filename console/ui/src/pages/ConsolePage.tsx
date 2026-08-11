import { useState } from "react";
import Brand from "../components/Brand";
import ConsoleBody from "../components/ConsoleBody";
import DistributionChip from "../components/DistributionChip";
import OnboardingScreen from "../components/OnboardingScreen";
import { useDistributions } from "../distribution";

/**
 * Which screen the console is showing. `null` is the console itself; the other
 * two are the connect screen wearing a different hat. One state rather than two
 * booleans, because they are mutually exclusive and a pair of flags would allow
 * a fourth combination that means nothing.
 */
type Flow = null | "add" | "settings";

/* Ticket: MVP - Front — Console - Display host.
   Nothing configured → the connect screen. Configured → the bar carries the
   connected environment and the ones this browser knows about, and the host
   list and selected host sit below it. */
export default function ConsolePage() {
  const { distributions, current, connect, replaceCurrent, select } =
    useDistributions();
  const [flow, setFlow] = useState<Flow>(null);

  if (current === null) {
    return <OnboardingScreen onConnect={connect} />;
  }

  /*
    Both panel actions reuse the connect screen rather than adding a second form
    over the same four fields — the difference is only whether it starts empty or
    prefilled, and which way the result is stored. Adding appends and selects;
    saving settings replaces the entry being edited, so editing a distribution
    does not leave its previous version behind in the menu.

    `connectDistribution` already resolves a table that turns out to be registered
    already, so re-submitting unchanged values lands on the same target instead of
    failing.

    One thing this does not do: changing the table in Settings registers a new
    target and leaves the previous one in the API's registry. Removing it needs a
    delete the AC does not ask for, and the registry is shared with anyone else
    pointed at the same table.
  */
  if (flow !== null) {
    return (
      <OnboardingScreen
        {...(flow === "settings" ? { initial: current } : {})}
        onConnect={(next) => {
          if (flow === "settings") {
            replaceCurrent(next);
          } else {
            connect(next);
          }
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
    </div>
  );
}
