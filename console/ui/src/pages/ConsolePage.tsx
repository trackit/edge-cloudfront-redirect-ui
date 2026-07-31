import { useConsole } from '../useConsole';
import VariantClassic from '../variants/VariantClassic';
import RedirectEditor from '../components/RedirectEditor';
import RewriteEditor from '../components/RewriteEditor';
import RequestTester from '../components/RequestTester';
import AddHostModal from '../components/AddHostModal';
import OnboardingScreen from '../components/OnboardingScreen';
import SettingsModal from '../components/SettingsModal';
import AddDistributionModal from '../components/AddDistributionModal';
import { IconCheck } from '../components/icons';

export default function ConsolePage() {
  const c = useConsole();

  // first-run: connect a distribution before showing the console
  if (!c.onboarded) {
    return <OnboardingScreen onConnect={c.completeOnboarding} />;
  }

  return (
    <>
      <VariantClassic c={c} />

      {c.editor?.kind === 'redirect' && c.selectedHost && (
        <RedirectEditor
          host={c.selectedHost}
          initial={c.editor.rule}
          onClose={c.closeEditor}
          onSave={c.upsert}
        />
      )}
      {c.editor?.kind === 'rewrite' && c.selectedHost && (
        <RewriteEditor
          host={c.selectedHost}
          initial={c.editor.rule}
          onClose={c.closeEditor}
          onSave={c.upsert}
        />
      )}
      {c.testerOpen && (
        <RequestTester
          rules={c.rules}
          hosts={c.hosts}
          defaultHost={c.selectedHost}
          onClose={c.closeTester}
        />
      )}
      {c.addHostOpen && (
        <AddHostModal
          existing={c.hosts}
          onClose={c.closeAddHost}
          onAdd={c.addHost}
        />
      )}
      {c.settingsOpen && c.distribution && (
        <SettingsModal
          distribution={c.distribution}
          onClose={c.closeSettings}
          onSave={c.updateDistribution}
          onDisconnect={c.disconnect}
        />
      )}
      {c.addDistOpen && (
        <AddDistributionModal
          existingIds={c.distributions.map((d) => d.distributionId)}
          onClose={c.closeAddDist}
          onAdd={c.addDistribution}
        />
      )}

      {c.toast && (
        <div className="toast">
          <span style={{ color: 'var(--green)' }}>
            <IconCheck size={16} />
          </span>
          {c.toast}
        </div>
      )}
    </>
  );
}
