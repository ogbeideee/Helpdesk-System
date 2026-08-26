/**
 * Normalized email model.
 *
 * This is the contract between *any* email provider and the ticket system.
 * It deliberately contains no Microsoft Graph, IMAP, or other provider types:
 *
 *   Provider (Graph / IMAP / dev endpoint)
 *     -> Provider Adapter   (provider-specific -> RawEmailInput)
 *     -> Email Parser       (RawEmailInput -> NormalizedEmail)
 *     -> Ticket Creation Service
 *     -> Assignment Engine
 *     -> Ticket
 *
 * Everything downstream of the parser depends only on the types in this file.
 */

/** Attachment metadata. No file bytes and no storage concerns at this layer. */
export interface EmailAttachment {
  /** Original file name as supplied by the sender, e.g. "screenshot.png". */
  filename: string;
  /** MIME type, e.g. "image/png". Empty string when the provider omits it. */
  contentType: string;
  /** Size in bytes. 0 when unknown. */
  size: number;
  /**
   * Provider-side identifier used to fetch the content later.
   * Null when the provider does not expose one.
   */
  attachmentId: string | null;
  /** True for images referenced from the HTML body rather than attached files. */
  isInline: boolean;
}

/** A single inbound email, normalized and ready for the ticket pipeline. */
export interface NormalizedEmail {
  /** Provider message identifier. Used for idempotency downstream. */
  messageId: string;
  /** Thread/conversation identifier, when the provider supplies one. */
  conversationId: string | null;
  /** Sender address, lower-cased. */
  senderEmail: string;
  /** Sender display name. Null when the provider supplies only an address. */
  senderName: string | null;
  /** Original subject, preserved verbatim (never stripped of "Re:"). */
  subject: string;
  /** Readable plain text. HTML input is converted; never contains markup. */
  body: string;
  /** ISO-8601 timestamp of receipt. */
  receivedAt: string;
  /** True when the source body was HTML and therefore converted. */
  isHtml: boolean;
  /** Attachment metadata; empty array when there are none. */
  attachments: EmailAttachment[];
}

/**
 * Raw input accepted by the parser.
 *
 * Intentionally permissive so one parser can serve several adapters: each
 * field accepts the common shapes emitted by real providers. An adapter may
 * also pre-normalize into the simplest shape.
 */
export interface RawEmailInput {
  messageId?: string | null;
  /** Alternatives some providers use. */
  id?: string | null;
  internetMessageId?: string | null;

  conversationId?: string | null;
  threadId?: string | null;

  /**
   * Sender in any of:
   *   "John Doe <john@x.com>" | "john@x.com"
   *   { name, email } | { name, address }
   *   { emailAddress: { name, address } }
   */
  from?: string | RawEmailAddress | null;
  sender?: string | RawEmailAddress | null;

  subject?: string | null;

  /** Body as a string, or as a { contentType, content } object. */
  body?: string | RawEmailBody | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  bodyPreview?: string | null;
  /** "html" | "text" - explicit override for a string body. */
  bodyType?: string | null;
  contentType?: string | null;

  receivedAt?: string | Date | null;
  receivedDateTime?: string | Date | null;

  attachments?: RawEmailAttachment[] | null;
  hasAttachments?: boolean | null;
}

export interface RawEmailAddress {
  name?: string | null;
  email?: string | null;
  address?: string | null;
  emailAddress?: { name?: string | null; address?: string | null } | null;
}

export interface RawEmailBody {
  contentType?: string | null;
  content?: string | null;
}

export interface RawEmailAttachment {
  filename?: string | null;
  name?: string | null;
  fileName?: string | null;
  contentType?: string | null;
  mimeType?: string | null;
  size?: number | string | null;
  attachmentId?: string | null;
  id?: string | null;
  contentId?: string | null;
  isInline?: boolean | null;
}

/** Thrown when the input cannot yield a usable NormalizedEmail. */
export declare class EmailParseError extends Error {
  errors: string[];
}

/** Convert raw provider data into the normalized model. */
export declare function parseEmail(raw: RawEmailInput): NormalizedEmail;

/** Non-throwing variant: reports validation problems instead. */
export declare function tryParseEmail(
  raw: RawEmailInput
): { ok: true; email: NormalizedEmail } | { ok: false; errors: string[] };

/** Convert an HTML fragment/document to readable plain text. */
export declare function htmlToPlainText(html: string): string;

/**
 * Identify a ticket number in a subject line, tolerating reply/forward
 * prefixes. Returns null when the subject references no ticket.
 *
 *   "[INC-000123] Cannot connect to WiFi"     -> "INC-000123"
 *   "Re: [INC-000123] Cannot connect to WiFi" -> "INC-000123"
 */
export declare function extractTicketNumberFromSubject(
  subject: string
): string | null;

/** Remove leading Re:/Fwd:/AW:/… prefixes. Does not alter the stored subject. */
export declare function stripReplyPrefixes(subject: string): string;
