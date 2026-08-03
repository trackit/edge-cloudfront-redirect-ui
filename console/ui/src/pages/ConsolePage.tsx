import Brand from "../components/Brand";
import OnboardingScreen from "../components/OnboardingScreen";
import { useDistribution } from "../distribution";

/* Ticket: MVP - Front — Console + env configuration.
   Nothing configured → the connect screen. Configured → the empty view below,
   which the console skeleton ticket replaces. */
export default function ConsolePage() {
  const { distribution, connect, disconnect } = useDistribution();

  if (distribution === null) {
    return <OnboardingScreen onConnect={connect} />;
  }

  return (
    <div className="console">
      <header className="console-bar">
        <Brand />
        <div className="console-conn">
          <span className="mono">{distribution.distributionId}</span>
          <span className="console-conn-sep">·</span>
          <span className="mono">{distribution.tableName}</span>
          <span className="console-conn-sep">·</span>
          <span className="mono">{distribution.region}</span>
          {/* Not in this ticket's criteria, but without it the connect screen is
              unreachable once configured — including for whoever reviews this.
              Settings takes it over when that ticket lands. */}
          <button className="btn btn-ghost btn-sm" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      </header>

      <main className="console-empty">
        <h1>No rules yet</h1>
        <p>
          This distribution is connected. Browsing hosts and editing redirect
          and rewrite rules arrives with the console skeleton.
        </p>
      </main>
    </div>
  );
}
