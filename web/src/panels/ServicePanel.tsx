import { useStore, deploymentsFor } from '../lib/store.ts';
import type { ServiceView } from '../lib/types.ts';
import { Tabs, Button, Badge, Tooltip, openMenuAt } from '../components/ui.tsx';
import { Icon, ServiceGlyph } from '../components/Icon.tsx';
import { serviceTone, serviceLabel, isBusy } from '../lib/format.ts';
import { deploy, serviceMenu } from '../lib/actions.ts';
import { OverviewTab } from './OverviewTab.tsx';
import { DeploymentsTab } from './DeploymentsTab.tsx';
import { LogsTab } from './LogsTab.tsx';
import { VariablesTab } from './VariablesTab.tsx';
import { MetricsTab } from './MetricsTab.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import { ConsoleTab } from './ConsoleTab.tsx';
import { BackupsTab } from './BackupsTab.tsx';
import { DataTab } from './DataTab.tsx';

export type PanelTab = 'overview' | 'deployments' | 'logs' | 'console' | 'data' | 'variables' | 'metrics' | 'backups' | 'settings';

export function ServicePanel({ service: s, tab, onClose, onTab }: { service: ServiceView; tab?: string; onClose: () => void; onTab: (t: PanelTab) => void }) {
  const current = useStore((st) => st.current);
  const deps = deploymentsFor(current, s.id);
  const active: PanelTab = (['overview', 'deployments', 'logs', 'console', 'data', 'variables', 'metrics', 'backups', 'settings'] as const).includes(tab as PanelTab) ? (tab as PanelTab) : 'overview';
  const latest = deps[0];
  const busy = isBusy(s.status) || (latest && isBusy(latest.status));

  return (
    <aside className="panel" aria-label={`${s.name} details`}>
      <div className="panel-head">
        <ServiceGlyph icon={s.icon} name={s.name} size={40} />
        <div className="grow">
          <div className="row" style={{ gap: 10 }}>
            <h2 className="h2 truncate">{s.name}</h2>
            <Badge tone={serviceTone[s.status]} live={busy || s.status === 'running'}>
              {latest?.status === 'queued' ? 'Queued' : serviceLabel[s.status]}
            </Badge>
          </div>
          <div className="panel-sub">
            {s.url ? (
              <a href={s.url} target="_blank" rel="noreferrer" className="panel-link mono">
                <Icon name="globe" size={12} />
                {s.url.replace(/^https?:\/\//, '')}
                <Icon name="arrowUpRight" size={12} />
              </a>
            ) : s.tcpAddress ? (
              <span className="panel-link mono">
                <Icon name="network" size={12} />
                {s.tcpAddress}
              </span>
            ) : (
              <span className="faint mono" style={{ fontSize: 12 }}>
                {s.protocol === 'none' ? 'background worker · no networking' : 'private network only'}
              </span>
            )}
          </div>
        </div>
        <div className="row" style={{ gap: 4, alignSelf: 'flex-start' }}>
          {s.source.type !== 'external' && s.source.type !== 'redirect' && (
            <Button variant={s.pendingChanges.length ? 'primary' : 'secondary'} size="sm" icon="rocket" onClick={() => void deploy(s)} loading={false}>
              {s.pendingChanges.length ? 'Deploy changes' : 'Deploy'}
            </Button>
          )}
          <Tooltip label="More actions" side="bottom">
            <button className="btn btn-ghost btn-sm btn-icon" onClick={(e) => openMenuAt(e.currentTarget, serviceMenu(s, { open: (t) => onTab((t as PanelTab) ?? 'overview') }), 'right')} aria-label="More">
              <Icon name="more" size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Close" kbd="Esc" side="bottom">
            <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close">
              <Icon name="x" size={16} />
            </button>
          </Tooltip>
        </div>
      </div>
      {s.pendingChanges.length > 0 && (
        <div className="panel-pending">
          <Icon name="info" size={14} />
          <span className="grow">
            Undeployed changes: <b>{s.pendingChanges.join(', ')}</b>
          </span>
          <Button size="sm" variant="primary" onClick={() => void deploy(s)}>
            Deploy
          </Button>
        </div>
      )}
      <Tabs
        value={active}
        onChange={onTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'deployments', label: 'Deployments', count: deps.length || null },
          { value: 'logs', label: 'Logs' },
          { value: 'console', label: 'Console' },
          ...(s.backupMethod === 'pg_dumpall' || s.backupMethod === 'mysqldump' ? [{ value: 'data' as const, label: 'Data' }] : []),
          { value: 'variables', label: 'Variables', count: Object.keys(s.env).length || null },
          { value: 'metrics', label: 'Metrics' },
          ...(s.backupMethod ? [{ value: 'backups' as const, label: 'Backups' }] : []),
          { value: 'settings', label: 'Settings' },
        ]}
      />
      <div className="panel-body" key={active}>
        {active === 'overview' && <OverviewTab service={s} onTab={onTab} />}
        {active === 'deployments' && <DeploymentsTab service={s} />}
        {active === 'logs' && <LogsTab service={s} />}
        {active === 'console' && <ConsoleTab service={s} />}
        {active === 'data' && <DataTab service={s} />}
        {active === 'variables' && <VariablesTab service={s} />}
        {active === 'metrics' && <MetricsTab service={s} />}
        {active === 'backups' && <BackupsTab service={s} />}
        {active === 'settings' && <SettingsTab service={s} />}
      </div>
    </aside>
  );
}
