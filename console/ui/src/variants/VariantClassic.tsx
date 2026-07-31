import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import RuleList from '../components/RuleList';
import { IconClock, IconPlus } from '../components/icons';
import type { ConsoleController } from '../useConsole';

/* Variant A — Classic sidebar / dashboard. Dark appbar, host sidebar,
   rule cards grouped by type. IDE / developer-tool feel. */
export default function VariantClassic({ c }: { c: ConsoleController }) {
  return (
    <div className="app">
      <Header
        distributions={c.distributions}
        current={c.distribution!}
        onSelectDistribution={c.selectDistribution}
        onAddDistribution={c.openAddDist}
        onOpenSettings={c.openSettings}
      />

      <div className="workspace">
        <Sidebar
          rules={c.rules}
          hosts={c.hosts}
          selectedHost={c.selectedHost}
          onSelectHost={c.setSelectedHost}
          onAddHost={c.openAddHost}
          onDeleteHost={c.deleteHost}
        />

        <main className="content">
          <div className="content-head">
            <div>
              <h1>{c.selectedHost ?? 'Rules'}</h1>
              <p className="sub">
                <span className="mono">{c.distribution!.distributionId}</span> ·{' '}
                <span className="mono">{c.distribution!.tableName}</span>
              </p>
            </div>
            <div className="head-actions">
              {c.selectedHost && (
                <>
                  <button
                    className="btn btn-ghost"
                    onClick={() => c.openCreate('rewrite')}
                  >
                    <IconPlus size={16} /> Rewrite
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => c.openCreate('redirect')}
                  >
                    <IconPlus size={16} /> Redirect
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="propagation-note">
            <IconClock size={15} />
            Rule changes propagate to the edge in about a minute (edge cache
            TTL).
          </div>

          <RuleList
            host={c.selectedHost}
            rules={c.hostRules}
            loading={c.loading}
            onEdit={c.openEdit}
            onDelete={c.remove}
            onToggle={c.toggle}
            onCreate={c.openCreate}
            reorderable
            onReprioritize={c.reprioritize}
          />
        </main>
      </div>
    </div>
  );
}
