import { useEffect, useMemo, useState } from 'react';
import { RULES, hostsFromRules } from './mockData';
import type { Distribution, RedirectRule, Rule, RewriteRule } from './types';
import { isRedirect } from './types';

export type EditorState =
  | { kind: 'redirect'; rule: RedirectRule | null }
  | { kind: 'rewrite'; rule: RewriteRule | null }
  | null;

const DISTS_KEY = 'edgeroute.distributions';
const CUR_KEY = 'edgeroute.currentDist';

/* Shared console state + mutations. */
export function useConsole() {
  // connected CloudFront distributions (+ their DynamoDB tables). Empty = not onboarded.
  const [distributions, setDistributions] = useState<Distribution[]>(() => {
    const raw = localStorage.getItem(DISTS_KEY);
    return raw ? (JSON.parse(raw) as Distribution[]) : [];
  });
  const [currentId, setCurrentId] = useState<string | null>(() =>
    localStorage.getItem(CUR_KEY),
  );
  useEffect(() => {
    localStorage.setItem(DISTS_KEY, JSON.stringify(distributions));
  }, [distributions]);
  useEffect(() => {
    if (currentId) localStorage.setItem(CUR_KEY, currentId);
    else localStorage.removeItem(CUR_KEY);
  }, [currentId]);

  const distribution =
    distributions.find((d) => d.distributionId === currentId) ??
    distributions[0] ??
    null;
  const onboarded = distributions.length > 0;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addDistOpen, setAddDistOpen] = useState(false);

  const [rules, setRules] = useState<Rule[]>(RULES);
  // explicit host list, so a freshly-added host with no rules still shows
  const [hostList, setHostList] = useState<string[]>(() =>
    hostsFromRules(RULES),
  );
  const [selectedHost, setSelectedHost] = useState<string | null>(
    'www.example.com',
  );
  const [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [testerOpen, setTesterOpen] = useState(false);
  const [addHostOpen, setAddHostOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => setLoading(false), 450);
    return () => clearTimeout(t);
  }, [currentId]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  };

  const completeOnboarding = (d: Distribution) => {
    setDistributions([d]);
    setCurrentId(d.distributionId);
    flash('Connected to your distribution');
  };
  const selectDistribution = (id: string) => setCurrentId(id);
  const addDistribution = (d: Distribution) => {
    setDistributions((prev) =>
      prev.some((x) => x.distributionId === d.distributionId)
        ? prev.map((x) => (x.distributionId === d.distributionId ? d : x))
        : [...prev, d],
    );
    setCurrentId(d.distributionId);
    setAddDistOpen(false);
    flash(`Added ${d.distributionId}`);
  };
  const updateDistribution = (d: Distribution) => {
    const oldId = distribution?.distributionId;
    setDistributions((prev) =>
      prev.map((x) => (x.distributionId === oldId ? d : x)),
    );
    setCurrentId(d.distributionId);
    setSettingsOpen(false);
    flash('Settings saved');
  };
  const disconnect = () => {
    const oldId = distribution?.distributionId;
    setSettingsOpen(false);
    const remaining = distributions.filter((x) => x.distributionId !== oldId);
    setDistributions(remaining);
    setCurrentId(remaining[0]?.distributionId ?? null);
  };

  // union of explicit hosts + any host referenced by a rule
  const hosts = useMemo(
    () =>
      Array.from(new Set([...hostList, ...rules.map((r) => r.pk)])).sort(),
    [hostList, rules],
  );
  const hostRules = useMemo(
    () => rules.filter((r) => r.pk === selectedHost),
    [rules, selectedHost],
  );

  const addHost = (raw: string) => {
    const name = raw.trim().toLowerCase();
    if (!name) return;
    setHostList((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setSelectedHost(name);
    setAddHostOpen(false);
    flash(`Host ${name} added`);
  };

  const deleteHost = (name: string) => {
    const count = rules.filter((r) => r.pk === name).length;
    const ok = window.confirm(
      count > 0
        ? `Delete host "${name}" and its ${count} rule${count > 1 ? 's' : ''}? This can't be undone.`
        : `Delete host "${name}"?`,
    );
    if (!ok) return;
    setRules((prev) => prev.filter((r) => r.pk !== name));
    setHostList((prev) => prev.filter((h) => h !== name));
    setSelectedHost((cur) => {
      if (cur !== name) return cur;
      const remaining = hosts.filter((h) => h !== name);
      return remaining[0] ?? null;
    });
    flash(`Host ${name} deleted`);
  };

  const upsert = (rule: Rule) => {
    setRules((prev) => {
      const idx = prev.findIndex((r) => r.pk === rule.pk && r.sk === rule.sk);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = rule;
        return next;
      }
      return [...prev, rule];
    });
    setEditor(null);
    flash('Rule saved · live at the edge in ~1 min');
  };

  const remove = (rule: Rule) => {
    setRules((prev) =>
      prev.filter((r) => !(r.pk === rule.pk && r.sk === rule.sk)),
    );
    flash('Rule deleted');
  };

  const toggle = (rule: Rule) => {
    setRules((prev) =>
      prev.map((r) =>
        r.pk === rule.pk && r.sk === rule.sk
          ? { ...r, disabled: !r.disabled }
          : r,
      ),
    );
  };

  // drag-to-reorder: recompute spaced priorities for one host+type
  const reprioritize = (orderedOfType: Rule[]) => {
    if (orderedOfType.length === 0) return;
    const prefix = isRedirect(orderedOfType[0]) ? 'REDIRECT' : 'REWRITE';
    const newSk = new Map<string, string>();
    orderedOfType.forEach((r, i) => {
      const prio = (i + 1) * 100;
      newSk.set(
        `${r.pk}|${r.sk}`,
        `${prefix}#${String(prio).padStart(5, '0')}`,
      );
    });
    setRules((prev) =>
      prev.map((r) => {
        const sk = newSk.get(`${r.pk}|${r.sk}`);
        return sk ? ({ ...r, sk } as Rule) : r;
      }),
    );
    flash('Priority updated');
  };

  const openCreate = (kind: 'redirect' | 'rewrite') =>
    setEditor({ kind, rule: null });
  const openEdit = (rule: Rule) =>
    setEditor(
      isRedirect(rule) ? { kind: 'redirect', rule } : { kind: 'rewrite', rule },
    );
  const closeEditor = () => setEditor(null);

  return {
    distributions,
    distribution,
    onboarded,
    completeOnboarding,
    selectDistribution,
    addDistribution,
    updateDistribution,
    disconnect,
    settingsOpen,
    openSettings: () => setSettingsOpen(true),
    closeSettings: () => setSettingsOpen(false),
    addDistOpen,
    openAddDist: () => setAddDistOpen(true),
    closeAddDist: () => setAddDistOpen(false),
    rules,
    hosts,
    hostRules,
    selectedHost,
    setSelectedHost,
    loading,
    editor,
    openCreate,
    openEdit,
    closeEditor,
    testerOpen,
    openTester: () => setTesterOpen(true),
    closeTester: () => setTesterOpen(false),
    addHostOpen,
    openAddHost: () => setAddHostOpen(true),
    closeAddHost: () => setAddHostOpen(false),
    addHost,
    deleteHost,
    upsert,
    remove,
    toggle,
    reprioritize,
    toast,
  };
}

export type ConsoleController = ReturnType<typeof useConsole>;
