import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, ErrorState } from './ui.jsx';

const GROUP_ICONS = {
  service_desk: '🧭',
  accounts: '🔑',
  software: '💾',
  hardware: '🖨️',
};

export default function GroupsPage() {
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    return api.groups().then(setGroups).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <div className="page"><ErrorState message={error} onRetry={load} /></div>;
  if (!groups) return <div className="page"><Spinner label="Loading assignment groups…" /></div>;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Assignment Groups</h1>
          <p className="muted">
            Routing targets for the assignment engine. Rules (category → group,
            minimum skill levels, priority boosts) are configured in{' '}
            <code className="mono-sm">server/config/assignment.config.json</code>.
          </p>
        </div>
      </header>

      {groups.length === 0 ? (
        <div className="callout callout-error">No assignment groups found — run <code>npm run db:init</code>.</div>
      ) : (
        <div className="group-grid">
          {groups.map((g) => (
            <section key={g.key} className="card group-card">
              <div className="group-head">
                <span className="group-icon" aria-hidden="true">{GROUP_ICONS[g.key] || '⛁'}</span>
                <div>
                  <h2>{g.name}</h2>
                  <span className="muted mono-sm">{g.key} · min skill L{g.minSkillLevel}</span>
                </div>
              </div>
              <div className="group-stats">
                <div className="group-stat">
                  <span className="group-stat-value">{g.activeAgents}</span>
                  <span className="group-stat-label">Active agents</span>
                </div>
                <div className={`group-stat ${g.unassignedTickets > 0 ? 'stat-warn' : ''}`}>
                  <span className="group-stat-value">{g.openTickets}</span>
                  <span className="group-stat-label">Open tickets</span>
                </div>
                <div className={`group-stat ${g.unassignedTickets > 0 ? 'stat-critical' : ''}`}>
                  <span className="group-stat-value">{g.unassignedTickets}</span>
                  <span className="group-stat-label">Unassigned</span>
                </div>
              </div>
              {g.unassignedTickets > 0 && (
                <p className="group-note">⚠ Tickets waiting for an available agent with the required skill level.</p>
              )}
              {g.activeAgents === 0 && (
                <p className="group-note">No active agents — new tickets will await manual assignment.</p>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
