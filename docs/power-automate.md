# Power Automate mailbox integration

The application supports two flows: an incoming-mail flow and a request-triggered
gateway that sends mail and re-exports a source email on an attachment cache miss.
The backend integration is opt-in. Local tests do not establish that either flow
has been configured or that a production deployment has occurred.

## What replaces the pilot

The pilot sent selected fields to `/api/tickets/from-email` using a personal
account login. Production uses the credential-protected
`POST /api/integrations/power-automate/email` and the original EML export.
MIME preserves names, the RFC Message-ID, reply references, To/Cc, automated-mail
headers, HTML and attachment bytes. Existing parser and intake services own
screening, classification, assignment, threading, reopens, dedupe and persistence.
No second set of rules is introduced. The pilot endpoint is unchanged.

The previous Html to text and Get Sender steps become unnecessary in the new
flow. Do not delete the saved pilot until the replacement passes live checks.

## Prerequisites

- The Outlook connection account has Full Access to the shared mailbox and
  Send As for outbound mail. Use an organisation-managed account and co-owner.
- The environment permits the HTTP action and Request trigger, with appropriate
  licensing and data policies. A Request action unable to accept calls from this
  backend requires administrator configuration before rollout.
- Keep shared mailbox messages in place. The mailbox is the attachment archive.
- Create two independent random secrets of at least 32 characters. Store them
  in the deployment secret store and approved flow secret storage, not source
  control, chat, run-history screenshots or this document. The gateway callback
  URL itself is also a secret because it can contain a signature.

## Server environment

```dotenv
POWER_AUTOMATE_INTAKE_KEY=<incoming-flow-secret>
POWER_AUTOMATE_MAILBOX=helpdesk@example.com
INTAKE_MAILBOX_ADDRESSES=helpdesk@example.com
POWER_AUTOMATE_FLOW_URL=<gateway-request-trigger-url>
POWER_AUTOMATE_FLOW_KEY=<gateway-header-secret>
POWER_AUTOMATE_OUTBOUND_ENABLED=false
POWER_AUTOMATE_BROADCAST_DL=it-team@example.com
```

Use the actual private mailbox in the deployment secrets only. The intake
mailbox list enables internal-copy screening, while POWER_AUTOMATE_MAILBOX also
prevents the helpdesk's own outgoing messages from opening tickets.
Restart after environment changes. Do not enable outgoing Power Automate until
its gateway flow has passed send tests. With outbound enabled, mailer.js selects
Power Automate ahead of Graph/SMTP; misconfiguration produces a delivery failure
in the existing encrypted Notification queue, not a silent SMTP fallback.

## Flow A Incoming mail

Create a replacement automated flow while the existing intake remains recoverable.

1. Trigger: Office 365 Outlook **When a new email arrives in a shared mailbox
   (V2)**. Enter the shared mailbox's full address and Inbox. Leave To, Cc,
   To or Cc, From and subject filters empty; Importance Any; Only with Attachments
   No; Include Attachments No. No custom trigger conditions are needed.
2. Action: Office 365 Outlook **Export email (V2)**. Rename it `Export email`.
   Message Id = the trigger's Message Id token. Original Mailbox Address = the
   same shared mailbox address. This does not move or delete mail.
3. Action: generic **HTTP**, renamed `Submit MIME`. Method POST. URI is the
   deployment's HTTPS base URL followed by
   `/api/integrations/power-automate/email`.
4. Headers: Content-Type = application/json; x-ticketdesk-key = the incoming
   secret. No Login action and no Authorization Bearer header.
5. Body has these fields (the bracket descriptions are NOT literal values):

```json
{
  "messageId": "[trigger Message Id token]",
  "mimeBase64": "[base64 export expression]"
}
```

For mimeBase64 insert this through the Expression editor, rather than pasting
the words as literal text:

```text
base64(body('Export_email'))
```

Power Automate can expose binary exports as an envelope containing `$content`.
If the export is explicitly supplied as that envelope, use its existing base64
`$content` value, rather than encoding the envelope JSON or encoding twice.
Verify this with a synthetic message during commissioning. The endpoint rejects
malformed exports; a correctly decoded export must contain MIME email headers.
Do not use an attachment array as mimeBase64 and do not loop Submit MIME over
attachments. One whole source message is submitted per trigger event.

6. Enable Secure Inputs and Secure Outputs for export and HTTP actions. Apply
   secure handling to the trigger where available; restrict owners. Configure
   flow failure notifications in Power Automate.
7. Optional: Mark as read or unread (V3), set Read, only after Submit MIME succeeds.
   Never mark a failed message processed. Do not move/delete source messages.

The decoder caps the entire original message at 25 MiB (including embedded MIME
attachments). Oversize requests return 413, invalid input 400, bad integration
credentials 401, missing configuration 503, and transient backend failure 500.
The HTTP body cap is 36 MiB to cover base64. Investigate 400/413 rather than
repeatedly replaying them. Retry transient failures with backoff and the exact
same source message identity. Do not generate a new id on retry.

Success returns 201 for a new ticket or 200 for a definitive outcome, including
duplicates, replies/reopens and screened messages. Only status, duplicate and
ticket id/number are returned; source text, names and bytes are not echoed.

## Flow B Mailbox gateway

Create an instant/request-triggered flow using **When an HTTP request is received**.
This is a second flow, not an action inserted into Flow A.

1. Permit the deployed backend to invoke the trigger under the tenant policy.
   This implementation calls an HTTPS signed callback URL plus a custom secret
   header; it does not acquire an Entra token for a tenant-authenticated trigger.
   If tenant policy prohibits signed externally callable triggers, stop and
   arrange an approved identity design before deployment.
2. Use the schema in `power-automate-gateway-schema.json`. Save to obtain the
   callback URL; store it as POWER_AUTOMATE_FLOW_URL privately.
3. Immediately check the incoming `x-ticketdesk-key` header against the separate
   gateway secret. Use approved secret storage; secure the condition inputs and
   outputs. Reject a mismatch with **Response**, HTTP 401, and no Outlook action.
4. For a matching key, add a **Switch** on the request body's `operation`.

### sendMail case

Add **Send an email from a shared mailbox (V2)** using a FIXED shared mailbox
address in the action, not an arbitrary sender provided by the request. Map:

| Outlook field | Expression |
|---|---|
| To | `triggerBody()?['mail']?['to']` |
| Cc | `triggerBody()?['mail']?['cc']` |
| Subject | `triggerBody()?['mail']?['subject']` |
| Body HTML | `triggerBody()?['mail']?['html']` |

The backend supplies semicolon-separated addresses so no Apply to each is needed.
Leave Reply To unset so replies return to the shared mailbox. If the action
requires HTML/source mode, use it so the formatted body is sent as HTML.

After the Outlook send succeeds, add a **Response**, status 200, JSON body:

```json
{ "ok": true, "operation": "sendMail" }
```

Do not acknowledge before sending. Do not return a trigger's automatic 202 as
evidence of delivery. Add a failure response with status 502 after failure or
timeout. Keep total flow completion under the backend's 90-second timeout.

### exportEmail case

Add Office 365 Outlook **Export email (V2)**, rename it `Export source`.
Original Mailbox Address is FIXED to the same shared mailbox; Message Id is
`triggerBody()?['messageId']`. After success add a **Response**, status 200:

```json
{
  "ok": true,
  "operation": "exportEmail",
  "mimeBase64": "[base64 export expression]"
}
```

Insert `base64(body('Export_source'))` as the mimeBase64 value through Expression.
The same binary-envelope qualification as Flow A applies. Return a failed
response (e.g. 404 if a source was deleted, 502 on connector failure) rather
than success with empty content. The backend re-parses the export and serves
only an attachment whose sanitized name AND exact byte size match its row.

### Default case and privacy

Return HTTP 400 for an unrecognised operation. Secure inputs/outputs for Request,
the key condition, Outlook actions and Response actions wherever supported;
restrict editors and manage failure alerts. Do not send raw connector errors,
keys, URLs or message text to logs. The sender callback may contain requester
text and signed confirmation links. All transport sends still pass through
mailer.js and the existing Notification delivery queue.

## Live commissioning and cutover

1. Deploy the reviewed application change with outbound disabled. Configure
   incoming secrets privately; no production database migration is required.
2. Configure both flows and securely set callback URL/key on the server. Keep
   outbound disabled while checking export and rejected-key responses.
3. Use controlled synthetic requests. Verify one ticket, name, readable body,
   correct routing and byte-identical attachment download.
4. Evict only a synthetic cached attachment, then verify source re-export and
   exact-byte matching. Do not clear production attachment caches to test this.
5. Replay the same MIME and identity: duplicate, no second ticket or comment.
   Test the same original RFC Message-ID through IMAP and Power Automate in an
   isolated rehearsal. Earlier pilot rows without an RFC id cannot retroactively
   gain cross-source identity merely by replaying with a different id.
6. Test requester replies, subject ticket references, MIME References/In-Reply-To,
   closed-ticket reopening, automated-mail screening and internal-copy screening.
7. Enable POWER_AUTOMATE_OUTBOUND_ENABLED=true and restart only after gateway
   sends are verified. Check requester acknowledgements, agent assignment,
   public replies, resolution/confirmation and optional team broadcasts.
8. Confirm the From and Reply-To behavior in received mail. Reply to an actual
   shared-mailbox acknowledgement and confirm the response arrives through the
   new flow and adds to the same ticket without a new agent/DL reply alert.
9. Pause the old poller, reconcile the transition window, then retire forwarding
   after the live checks pass. Keep one backend instance and retain old Gmail
   access for historical IMAP attachments. Do not delete mailbox archives.
10. Monitor Power Automate run failures as well as administrator delivery status.
    The poller watchdog does not monitor an event-driven Power Automate flow;
    a quiet mailbox is not proof of connector health.

Rollback: turn off Flow A; restore IMAP/forwarding; set outbound false and restart
to restore the previous configured mail transport. Reconcile messages and pending
Notification deliveries before manual retries. Outlook send success followed by a
network timeout can cause a duplicate send on retry; the transport does not claim
exactly-once outbound delivery. Email identity uniqueness protects inbound replay.

## Verification

`cd server && node scripts/test-power-automate.js` uses the disposable test
PostgreSQL database and mocked callback transport. It checks MIME, sender name,
attachments, reply/reopen, screening, cross-source dedupe, concurrent identity
conflicts, authentication, gateway acknowledgement and cache-miss re-export.
All real Power Automate variables are cleared by the DB-test harness before
mailer imports. No automated test sends real email or calls a live flow.

Microsoft references:
- [Office 365 Outlook connector and Export email V2](https://learn.microsoft.com/en-us/connectors/office365connector/)
- [Secure flow data](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/use-secure-inputs-outputs-triggers)
