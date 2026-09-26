// Attachment presentation and retrieval.
//
// The server owns attachment bytes: they live in a private store and are only
// reachable through the authorized download endpoint, which serves them as an
// inert octet-stream. Nothing here parses, previews or renders a file — it
// formats the metadata the ticket payload already carries and performs the
// authenticated fetch-and-save.
//
// The one grouping rule that matters: an attachment belongs to the original
// message when it has no `commentId`, and otherwise to the comment it arrived
// with. That is the association the timeline renders, so it lives here next to
// the fetch rather than being re-derived per component.

import { getToken } from './api.js';

/** `application/pdf; charset=…` → `application/pdf`. Never throws. */
export function attachmentType(att) {
  return (att?.mimeType || '').split(';')[0].trim() || 'file';
}

export function formatBytes(n) {
  // A negative size cannot come from the server, but it must never reach the
  // DOM as one.
  const size = Math.max(0, Number(n) || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** The chip's tooltip: type and human size, or null when there is nothing to say. */
export function attachmentTitle(att) {
  if (!att) return null;
  return `${attachmentType(att)} · ${formatBytes(att.size)}`;
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

function allAttachments(ticket) {
  return ticket?.attachments || [];
}

/** Attachments that arrived with the ticket email itself. */
export function originalAttachments(ticket) {
  return allAttachments(ticket).filter((a) => !a.commentId);
}

/** Attachments that arrived with one particular comment. */
export function attachmentsForComment(ticket, commentId) {
  if (commentId == null) return [];
  return allAttachments(ticket).filter((a) => a.commentId === commentId);
}

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fetch one attachment and hand it to the browser as a file.
 *
 * The response is never rendered or interpreted: the server sends an inert
 * octet-stream with an attachment disposition and `nosniff`, and the blob
 * keeps that inertness on the client side. The object URL is revoked
 * immediately after the synthetic click.
 *
 * @throws {Error} with the server's own message when the download is refused
 */
export async function downloadAttachment(ticketId, attachment) {
  const res = await fetch(`/api/tickets/${ticketId}/attachments/${attachment.id}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = attachment.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
