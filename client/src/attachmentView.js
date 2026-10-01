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
/* Preview                                                             */
/* ------------------------------------------------------------------ */

/**
 * May these bytes be rendered on screen?
 *
 * The answer is the SERVER's: `previewable` is set from an allowlist of image
 * types when the ticket is serialized (a screenshot yes; SVG, HTML and
 * anything unrecognised no — those stay an inert download). This module keeps
 * no allowlist of its own, so there is exactly one place to change the rule.
 */
export function canPreviewInline(attachment) {
  return Boolean(attachment && attachment.previewable);
}

/**
 * Fetch a previewable attachment and return a local object URL to render.
 *
 * The bytes still come through the authorized endpoint with the session token
 * — a preview is not a second, weaker way in. The caller owns the URL and must
 * revoke it when the preview closes.
 *
 * @throws {Error} with the server's own message when the content is unavailable
 */
export async function fetchAttachmentObjectUrl(ticketId, attachment) {
  const res = await fetch(`/api/tickets/${ticketId}/attachments/${attachment.id}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Could not open the attachment (${res.status})`);
  }
  return URL.createObjectURL(await res.blob());
}

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fetch one attachment and hand it to the browser as a file.
 *
 * This is the path for everything that is not previewable, and it never
 * renders what it receives: the blob is handed to the browser as a file and
 * the object URL is revoked immediately after the synthetic click. The server
 * sends an attachment disposition and `nosniff` for every non-image, so a
 * saved file is exactly the bytes that arrived.
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
