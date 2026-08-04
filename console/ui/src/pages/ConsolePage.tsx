import { useState } from "react";
import Brand from "../components/Brand";
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

/* Ticket: MVP - Front — Console + env configuration.
   Nothing configured → the connect screen. Configured → the bar carries the
   connected environment and the ones this browser knows about, and the empty
   body below is what the console skeleton ticket replaces. */
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

      <main className="console-empty">
        <h1>No rules yet</h1>
        {/* The id the rules routes are keyed on — worth showing while there is
            no rules UI, since it is the only visible proof the table is
            registered with the API. Goes when the console skeleton lands. */}
        <p className="console-target mono">target {current.targetId}</p>
        <p>
          This distribution is connected. Browsing hosts and editing redirect
          and rewrite rules arrives with the console skeleton.
        </p>
      </main>
    </div>
  );
}
