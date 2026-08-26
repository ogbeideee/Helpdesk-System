import { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  STATES,
  PRIORITIES,
  stateLabel,
  priorityLabel,
  isOverdue,
  dueDisplay,
} from '../constants.js';

const badgeClass = (state) => `status-${String(state).toLowerCase()}`;

export default function TicketList({ me, onOpen }) {
  const [tickets, setTickets] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [q, setQ] = useState('');
  const [mine, setMine] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .listTickets({
          status,
          priority,
          q,
          mine: mine ? '1' : '',
          overdue: overdueOnly ? '1' : '',
        })
        .then(setTickets)
        .catch((e) => setError(e.message));
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [status, priority, q, mine, overdueOnly]);

  if (error) return <p className="error">{error}</p>;
  if (!tickets) return <p className="muted">Loading…</p>;

  return (
    <section>
      <h2>Tickets</h2>

      <div className="filters">
        <input
          placeholder="Search subject, body, ticket # or requester…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All states</option>
          {STATES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <label className="toggle">
          <input
            type="checkbox"
            checked={mine}
            onChange={(e) => setMine(e.target.checked)}
          />{' '}
          Assigned to me
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
          />{' '}
          Overdue only
        </label>
      </div>

      <table className="ticket-table">
        <thead>
          <tr>
            <th>Ticket #</th>
            <th>Subject</th>
            <th>State</th>
            <th>Priority</th>
            <th>Team</th>
            <th>Assignee</th>
            <th>SLA</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => {
            const due = dueDisplay(t);
            return (
              <tr key={t.id} onClick={() => onOpen(t.id)}>
                <td className="mono">{t.ticketNumber}</td>
                <td>{t.shortDescription}</td>
                <td>
                  <span className={`badge ${badgeClass(t.state)}`}>
                    {stateLabel(t.state)}
                  </span>
                </td>
                <td>
                  <span className={`badge priority-${t.priority}`}>
                    {priorityLabel(t.priority)}
                  </span>
                </td>
                <td>{t.team?.name || <span className="muted">Triage</span>}</td>
                <td>{t.assignedAgent?.name || <span className="muted">Unassigned</span>}</td>
                <td>
                  {due && (
                    <span className={`badge ${due.overdue ? 'overdue-badge' : 'sla-badge'}`}>
                      {due.text}
                    </span>
                  )}
                </td>
                <td className="muted">
                  {new Date(t.updatedAt).toLocaleString()}
                </td>
              </tr>
            );
          })}
          {!tickets.length && (
            <tr>
              <td colSpan="8" className="muted center">
                No tickets match your filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
