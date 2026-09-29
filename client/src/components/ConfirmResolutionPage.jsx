import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './ui.jsx';

const STATE_LABEL = {
  NEW: 'Received',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

/**
 * Public requester resolution-confirmation page — the "Yes, it's resolved"
 * button behind the link in the resolve email.
 *
 * Two-step on purpose: opening the link (which mail scanners and Outlook
 * Safe-Links prefetch) only SHOWS the ticket; closing it takes an explicit
 * button press, which POSTs. The signed token is the credential — the same
 * trust model as the status page: possession of the link is proof of access
 * to the requester's mailbox.
 *
 * This page renders without a session, alongside StatusPage.
 */
export default function ConfirmResolutionPage({ token }) {
  // undefined = loading, null = not found, object = ticket
  const [ticket, setTicket] = useState(undefined);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null); // { ok, message } after the POST
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .ticketStatus(token)
      .then((t) => { if (!cancelled) setTicket(t); })
      .catch(() => { if (!cancelled) setTicket(null); });
    return () => { cancelled = true; };
  }, [token]);

  async function confirm() {
    setConfirming(true);
    setError('');
    try {
      const r = await api.confirmResolution(token);
      setResult({ ok: true, state: r.state });
    } catch (e) {
      // A 409 (already closed / no longer awaiting) is a polite outcome, not
      // an error: the ticket reached a decided state without this click.
      setResult({ ok: false, message: e.message });
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="login-split">
      <aside className="login-hero">
        <div className="login-brand">
          <span className="brand-mark brand-mark-lg">IT</span>
          <div>
            <h1>Helpdesk</h1>
            <p className="muted">Confirm Resolution</p>
          </div>
        </div>
        <div>
          <h2>Did we solve it?</h2>
          <p>
            Confirming closes your ticket. If you still need help, reply to any
            of the helpdesk emails instead &mdash; your message reopens the
            ticket and the team takes another look.
          </p>
        </div>
      </aside>
      <main className="login-pane">
        <div className="login-card">
          {ticket === undefined && (
            <p className="muted"><span className="spinner" /> Looking up your ticket…</p>
          )}
          {ticket === null && (
            <div className="callout callout-error" role="alert">
              <div>
                <strong>We couldn&apos;t find that ticket.</strong>
                <div className="muted">
                  The link may be incomplete &mdash; copy the whole address from
                  the email, or reply to the email and we&apos;ll pick it up.
                </div>
              </div>
            </div>
          )}
          {ticket && !result && (
            <>
              <div className="card-head" style={{ marginBottom: 14 }}>
                <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>{ticket.ticketNumber}</span>
                <span className={`pill pill-state-${ticket.state.toLowerCase()}`}>
                  {STATE_LABEL[ticket.state] || ticket.state}
                </span>
              </div>
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>
                {ticket.shortDescription}
              </h2>
              {ticket.resolution && (
                <div className="callout" style={{ marginBottom: 14 }}>
                  <div>
                    <strong>Resolution</strong>
                    <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{ticket.resolution}</div>
                  </div>
                </div>
              )}
              {ticket.state === 'RESOLVED' ? (
                <>
                  <p style={{ marginTop: 0 }}>
                    Please confirm this resolution so we can close your ticket.
                  </p>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={confirming}
                      onClick={confirm}
                    >
                      {confirming && <span className="spinner" />}
                      Yes, it&apos;s resolved &mdash; close my ticket
                    </button>
                  </div>
                  <p className="login-hint muted" style={{ marginTop: 14 }}>
                    <Icon name="mail" size={13} /> Still need help? Reply to the helpdesk email &mdash;
                    that reopens the ticket instead.
                  </p>
                </>
              ) : (
                <div className="callout" role="status">
                  <div>
                    <strong>This ticket is {STATE_LABEL[ticket.state] || ticket.state} — nothing to confirm.</strong>
                    <div className="muted">
                      {ticket.state === 'CLOSED'
                        ? 'It was already closed — thank you.'
                        : 'The team is still working on it. Reply to the email if you have more to add.'}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
          {result && (
            result.ok ? (
              <div className="callout" role="status">
                <div>
                  <strong>Thank you — your ticket is closed.</strong>
                  <div className="muted">
                    {ticket?.ticketNumber} is now closed. If anything comes back,
                    reply to any helpdesk email and it reopens.
                  </div>
                </div>
              </div>
            ) : (
              <div className="callout callout-error" role="alert">
                <div>
                  <strong>We couldn&apos;t close that ticket.</strong>
                  <div className="muted">{result.message}</div>
                  <div className="muted">
                    It may have been closed already, or the team may have reopened it.
                    Reply to the helpdesk email if you still need help.
                  </div>
                </div>
              </div>
            )
          )}
        </div>
      </main>
    </div>
  );
}
