import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './ui.jsx';

const STATE_LABEL = {
  NEW: 'Received',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

function fmt(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString();
}

/**
 * Public requester status view — reachable from the link in the
 * acknowledgement and status-update emails, without a portal account. The
 * signed token in the URL is the credential; the endpoint only ever returns
 * the ticket's public face (never bodies, comments or agent details).
 */
export default function StatusPage({ token }) {
  const [result, setResult] = useState(undefined); // undefined=loading, null=not found
  useEffect(() => {
    let cancelled = false;
    api
      .ticketStatus(token)
      .then((t) => { if (!cancelled) setResult(t); })
      .catch(() => { if (!cancelled) setResult(null); });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="login-split">
      <aside className="login-hero">
        <div className="login-brand">
          <span className="brand-mark brand-mark-lg">IT</span>
          <div>
            <h1>Helpdesk</h1>
            <p className="muted">Ticket Status</p>
          </div>
        </div>
        <div>
          <h2>Your request, without signing in.</h2>
          <p>
            This page shows the live status of the ticket the link in your email
            refers to. To add information or reply to the team, reply to any of
            the helpdesk emails — your message is attached to the ticket.
          </p>
        </div>
      </aside>
      <main className="login-pane">
        <div className="login-card">
          {result === undefined && (
            <p className="muted"><span className="spinner" /> Looking up your ticket…</p>
          )}
          {result === null && (
            <div className="callout callout-error" role="alert">
              <div>
                <strong>We couldn&apos;t find that ticket.</strong>
                <div className="muted">
                  The link may be incomplete — copy the whole address from the email,
                  or reply to the email and we&apos;ll pick it up.
                </div>
              </div>
            </div>
          )}
          {result && (
            <>
              <div className="card-head" style={{ marginBottom: 14 }}>
                <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>{result.ticketNumber}</span>
                <span className={`pill pill-state-${result.state.toLowerCase()}`}>
                  {STATE_LABEL[result.state] || result.state}
                </span>
              </div>
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>
                {result.shortDescription}
              </h2>
              <dl className="status-facts">
                <div><dt>Category</dt><dd>{result.category}</dd></div>
                <div><dt>Priority</dt><dd>{result.priority}</dd></div>
                <div><dt>Logged</dt><dd>{fmt(result.createdAt)}</dd></div>
                {result.dueAt && <div><dt>Target resolution</dt><dd>{fmt(result.dueAt)}</dd></div>}
                {result.resolvedAt && <div><dt>Resolved</dt><dd>{fmt(result.resolvedAt)}</dd></div>}
                {result.closedAt && <div><dt>Closed</dt><dd>{fmt(result.closedAt)}</dd></div>}
                <div><dt>Last update</dt><dd>{fmt(result.updatedAt)}</dd></div>
              </dl>
              {result.resolution && (
                <div className="callout" style={{ marginTop: 14 }}>
                  <div>
                    <strong>Resolution</strong>
                    <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{result.resolution}</div>
                  </div>
                </div>
              )}
              <p className="login-hint muted" style={{ marginTop: 14 }}>
                <Icon name="mail" size={13} /> Reply to the helpdesk email to add information
                {result.state === 'RESOLVED' ? ' — this reopens the ticket if you still need help.' : '.'}
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
