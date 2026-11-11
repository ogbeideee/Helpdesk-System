const OUTCOMES = { created: 'Ticket created', comment_added: 'Reply added', appended: 'Reply added', reopened: 'Ticket reopened',
  skipped_self: 'Helpdesk sender ignored', skipped_automated: 'Screened out', skipped_non_ticket: 'Not a helpdesk request' };
export function outcomeLabel(value) { return OUTCOMES[value] || String(value || 'Unknown').replace(/_/g, ' '); }
export function deliveryLabel(value) { return ({ pending: 'Waiting to retry', sending: 'Sending', delivered: 'Sent', failed: 'Failed', expired: 'Retry expired' })[value] || 'Unknown'; }
export function operationTime(value) { return value ? new Date(value).toLocaleString() : '—'; }
export function decisionExplanation(row) {
  const data = row.metadata || {};
  return [data.reason, data.greeting?.reason && `Greeting: ${data.greeting.reason}`].filter(Boolean).join(' · ') || 'No additional detail';
}

/** Who wrote in, as the intake gate recorded it. Older rows predate the field. */
export function decisionSender(row) { return row.metadata?.sender || '—'; }

/** The message this row is about (RFC Message-ID), for a title attribute only. */
export function decisionMessageId(row) { return row.metadata?.messageId || ''; }
