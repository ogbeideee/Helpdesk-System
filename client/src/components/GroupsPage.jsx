import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, ErrorState } from './ui.jsx';
import { loadLabel, poolSummaryLine, poolWarning, rosterSections } from '../poolView.js';

/* Line icons from the same family the sidebar uses. The emoji these replaced
   rendered in the OS colour font, so they ignored the theme entirely and were
   the only pictorial icons left in the product. */
const GROUP_ICON_PATHS = {
  service_desk: <><circle cx="8" cy="8" r="5.5" /><path d="M10.2 5.8L9 9 5.8 10.2 7 7z" /></>,
  accounts: <><circle cx="6" cy="6" r="2.8" /><path d="M8 8l5 5M11 11l1.5-1.5M12.5 12.5L14 11" /></>,
  software: <><rect x="2.5" y="3" width="11" height="8" rx="1.2" /><path d="M5.5 13.5h5" /></>,
  hardware: <><rect x="4" y="2.5" width="8" height="4" rx="1" /><rect x="2.5" y="6.5" width="11" height="5" rx="1.2" /><path d="M5 13.5h6" /></>,
  network: <><circle cx="8" cy="4" r="1.8" /><circle cx="3.5" cy="12" r="1.8" /><circle cx="12.5" cy="12" r="1.8" /><path d="M8 5.8v3M6.8 9.2L4.7 10.6M9.2 9.2l2.1 1.4" /></>,
};

function GroupIcon({ groupKey }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GROUP_ICON_PATHS[groupKey] || <rect x="2.5" y="2.5" width="11" height="11" rx="2" />}
    </svg>
  );
}

export default function GroupsPage() {
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    // The pools endpoint is a superset of the group cards: per-group members
    // with their availability state (online / unavailable / offline), the
    // group lead and the live ticket load.
    return api.assignmentPools().then((d) => setGroups(d.pools)).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <div className="page"><ErrorState message={error} onRetry={load} /></div>;
  if (!groups) return <div className="page"><Spinner label="Loading assignment groups…" /></div>;

  return (
    <div className="page">
      {groups.length === 0 ? (
        <div className="callout callout-error">No assignment groups found — run <code>npm run db:init</code>.</div>
      ) : (
        <div className="group-grid">
          {groups.map((g) => (
            <section key={g.key} className="card group-card">
              <div className="group-head">
                <span className="group-icon" aria-hidden="true"><GroupIcon groupKey={g.key} /></span>
                <div>
                  <h2>{g.name}</h2>
                  <span className="muted small">
                    {g.key} · min skill L{g.minSkillLevel}
                    {g.lead ? ` · lead ${g.lead.name}` : ''}
                  </span>
                </div>
              </div>
              <div className="group-stats">
                <div className={`group-stat ${g.pool.online === 0 ? 'stat-warn' : ''}`}>
                  <span className="group-stat-value">{g.pool.online}<span className="muted">/{g.pool.total}</span></span>
                  <span className="group-stat-label">Online</span>
                </div>
                <div className="group-stat">
                  <span className="group-stat-value">{g.pool.eligible}</span>
                  <span className="group-stat-label">Eligible now</span>
                </div>
                <div className={`group-stat ${g.load.openTickets > 0 ? '' : ''}`}>
                  <span className="group-stat-value">{g.load.openTickets}</span>
                  <span className="group-stat-label">Open tickets</span>
                </div>
                <div className={`group-stat ${g.load.unassignedTickets > 0 ? 'stat-critical' : ''}`}>
                  <span className="group-stat-value">{g.load.unassignedTickets}</span>
                  <span className="group-stat-label">Unassigned</span>
                </div>
              </div>
              {poolWarning(g) && <p className="group-note">{poolWarning(g)}</p>}
              {g.load.unassignedTickets > 0 && !poolWarning(g) && (
                <p className="group-note">Tickets waiting for an available agent with the required skill level.</p>
              )}

              <div className="pool-roster">
                <div className="pool-summary muted small">{poolSummaryLine(g)}</div>
                {rosterSections(g.agents).map((section) => (
                  <div key={section.state} className="pool-section">
                    <div className="pool-section-label muted small">
                      <span className={`availability-dot ${section.meta.dot}`} aria-hidden="true" />
                      {section.meta.label}
                    </div>
                    {section.agents.map((a) => (
                      <div key={a.id} className="pool-agent">
                        <span className="pool-agent-name">
                          {a.name}
                          {a.isLead && <span className="chip chip-you" style={{ marginLeft: 6 }}>lead</span>}
                        </span>
                        <span className="muted small">{a.skillLabel}</span>
                        <span className={`muted small ${a.autoEligible ? '' : 'is-dim'}`}>{loadLabel(a.openTickets)}</span>
                        {!a.autoEligible && a.availabilityState === 'online' && (
                          <span className="chip chip-warn" title="Above the workload cap or below the group's skill bar">not eligible</span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
