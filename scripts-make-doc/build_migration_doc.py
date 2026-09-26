# Builds "Helpdesk-Domain-Migration-Guide-v3.docx" in the workspace root.
# Run:  python scripts-make-doc/build_migration_doc.py
import datetime
import os
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

ACCENT = RGBColor(0x1F, 0x3B, 0x66)   # dark navy
ACCENT2 = RGBColor(0x2E, 0x74, 0xB5)  # heading blue
WARN_FILL = "FDECEA"                   # light red
NOTE_FILL = "EAF3FB"                   # light blue
CODE_FILL = "F2F2F2"                   # light grey
OK_FILL = "E8F5E9"                     # light green

doc = Document()

normal = doc.styles["Normal"]
normal.font.name = "Calibri"
normal.font.size = Pt(11)
normal.paragraph_format.space_after = Pt(6)

for i, (size, color, before) in enumerate(
    [(20, ACCENT, 6), (15, ACCENT, 14), (12.5, ACCENT2, 10), (11.5, ACCENT2, 8)],
    start=1,
):
    st = doc.styles[f"Heading {i}"]
    st.font.name = "Calibri"
    st.font.size = Pt(size)
    st.font.color.rgb = color
    st.font.bold = True
    st.paragraph_format.space_before = Pt(before)
    st.paragraph_format.space_after = Pt(4)
    st.paragraph_format.keep_with_next = True


def shade(paragraph, fill):
    pPr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), fill)
    pPr.append(shd)


def p(text="", bold=False, italic=False, size=None, color=None):
    par = doc.add_paragraph()
    run = par.add_run(text)
    run.bold = bold
    run.italic = italic
    if size:
        run.font.size = Pt(size)
    if color:
        run.font.color.rgb = color
    return par


def h(level, text):
    return doc.add_heading(text, level=level)


def bullets(items, style="List Bullet"):
    for it in items:
        if isinstance(it, tuple):
            par = doc.add_paragraph(style=style)
            par.add_run(it[0]).bold = True
            par.add_run(it[1])
        else:
            doc.add_paragraph(it, style=style)


def numbered(items):
    bullets(items, style="List Number")


def code(lines):
    if isinstance(lines, str):
        lines = lines.split("\n")
    for i, line in enumerate(lines):
        par = doc.add_paragraph()
        par.paragraph_format.space_after = Pt(0 if i < len(lines) - 1 else 6)
        par.paragraph_format.left_indent = Inches(0.25)
        run = par.add_run(line if line else " ")
        run.font.name = "Consolas"
        run.font.size = Pt(9.5)
        shade(par, CODE_FILL)


def callout(fill, label, text):
    par = doc.add_paragraph()
    par.paragraph_format.left_indent = Inches(0.1)
    run = par.add_run(label + "  ")
    run.bold = True
    run.font.color.rgb = ACCENT
    par.add_run(text)
    shade(par, fill)
    return par


def table(headers, rows, widths=None):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Light Grid Accent 1"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for j, htext in enumerate(headers):
        cell = t.rows[0].cells[j]
        cell.text = ""
        run = cell.paragraphs[0].add_run(htext)
        run.bold = True
    for row in rows:
        cells = t.add_row().cells
        for j, val in enumerate(row):
            cells[j].text = ""
            run = cells[j].paragraphs[0].add_run(str(val))
            run.font.size = Pt(10)
    if widths:
        for j, w in enumerate(widths):
            for row in t.rows:
                row.cells[j].width = Inches(w)
    doc.add_paragraph()
    return t


def checklist(items):
    for it in items:
        par = doc.add_paragraph()
        par.add_run("\u2610  ").font.size = Pt(12)
        if isinstance(it, tuple):
            par.add_run(it[0]).bold = True
            par.add_run(it[1])
        else:
            par.add_run(it)


# ======================================================================
# COVER PAGE
# ======================================================================
for _ in range(6):
    doc.add_paragraph()
tp = p("Helpdesk Domain Migration Guide", bold=True, size=30, color=ACCENT)
tp.alignment = WD_ALIGN_PARAGRAPH.CENTER
sp = p("Moving the MRS Holdings IT Helpdesk from Fly.io to ithelpdesk.mrsholdings.com",
       size=15, color=ACCENT2)
sp.alignment = WD_ALIGN_PARAGRAPH.CENTER
doc.add_paragraph()
mp = p("End-to-end runbook: DNS request, Fly.io certificate setup, application "
       "configuration, verification, cutover, and rollback", italic=True, size=11)
mp.alignment = WD_ALIGN_PARAGRAPH.CENTER
for _ in range(4):
    doc.add_paragraph()
dp = p(f"Prepared: {datetime.date.today():%d %B %Y}    |    Version 1.0    |    "
       "Classification: Internal \u2013 IT Operations", size=10)
dp.alignment = WD_ALIGN_PARAGRAPH.CENTER
doc.add_page_break()

# ======================================================================
# SYSTEM FACT SHEET
# ======================================================================
h(1, "System Fact Sheet")
p("Everything in this guide is specific to the current production deployment. "
  "These are the facts the steps below rely on:")
table(
    ["Item", "Value"],
    [
        ["Application", "Internal IT helpdesk ticketing system (Node.js/Express API + React "
                          "SPA, served together by one server on port 4000)"],
        ["Hosting platform", "Fly.io"],
        ["Fly.io app name", "ticketing-system-drifting-horizon-5610"],
        ["Fly.io region", "ams (Amsterdam)"],
        ["Current URL", "https://ticketing-system-drifting-horizon-5610.fly.dev"],
        ["Target URL", "https://ithelpdesk.mrsholdings.com"],
        ["Database", "PostgreSQL on Supabase (external to Fly.io \u2013 completely unaffected "
                     "by this migration)"],
        ["HTTPS on Fly.io", "Already forced (force_https = true in fly.toml); the certificate "
                            "for the custom domain is issued automatically by Fly.io via "
                            "Let's Encrypt"],
        ["Email / M365 integration", "Optional Microsoft Graph integration. Two settings bake "
                                     "the public URL into behaviour: PORTAL_BASE_URL (links "
                                     "inside notification emails) and WEBHOOK_PUBLIC_URL "
                                     "(Graph webhook callback base URL). Both must be "
                                     "updated."],
        ["UI routing", "Hash-based (#/tickets\u2026). No server-side URL rewrites are needed "
                       "for the domain change \u2013 a deliberate simplification of this app."],
    ],
    widths=[1.8, 4.7],
)
callout(NOTE_FILL, "KEY POINT:",
        "Nothing in this migration is destructive until the very final cleanup step. The old "
        "fly.dev address keeps working the entire time, so there is no downtime window and "
        "rollback is trivial at every stage.")
doc.add_page_break()

# ======================================================================
# PART 1
# ======================================================================
h(1, "Part 1 \u2014 Decisions to Make First (Before Touching Anything)")

h(2, "1.1  Use a subdomain, not the apex domain")
p("mrsholdings.com itself is almost certainly the company's main website (or will be). "
  "Putting the helpdesk on a subdomain avoids colliding with it and avoids a DNS technical "
  "limitation: apex domains cannot be CNAME records, which is the record type Fly.io works "
  "best with.")
p("The chosen address for this migration:", bold=True)
code("ithelpdesk.mrsholdings.com")
p("If this ever changes, substitute the new name consistently everywhere in this guide.")

h(2, "1.2  Who does what")
p("There are two halves to this job:")
bullets([
    ("DNS half \u2014 ", "the person who controls the mrsholdings.com DNS zone (the registrar "
     "or DNS host: GoDaddy, Cloudflare, Route53, cPanel hosting, etc.). Only someone with "
     "access to that account can create the record."),
    ("App half \u2014 ", "whoever has Fly.io access (flyctl signed into the organisation that "
     "owns the app ticketing-system-drifting-horizon-5610)."),
])
callout(NOTE_FILL, "CAN I DO IT ALL MYSELF?",
        "Yes \u2014 if you personally have logins for both the DNS provider account and the "
        "Fly.io organisation. If not, hand Part 2 to the domain person and do Part 3 "
        "yourself.")
doc.add_page_break()

# ======================================================================
# PART 2
# ======================================================================
h(1, "Part 2 \u2014 Exactly What to Send the Domain/DNS Person")
p("Send them the block below verbatim. It contains everything they need and nothing "
  "they don't \u2014 including the certificate-validation record Fly.io asked for.")

quote_lines = [
    ("Request: add DNS records for the IT helpdesk on Fly.io", True),
    ("", False),
    ("Please add ALL THREE of these records:", True),
    ("", False),
    ("1.  A record", True),
    ("     Hostname:  ithelpdesk.mrsholdings.com", False),
    ("     Value:     66.241.124.121", False),
    ("", False),
    ("2.  AAAA record (IPv6 \u2014 required by Fly.io for verification)", True),
    ("     Hostname:  ithelpdesk.mrsholdings.com", False),
    ("     Value:     2a09:8280:1::189:b7e5:0", False),
    ("", False),
    ("3.  ACME challenge CNAME (lets Fly.io issue the HTTPS certificate "
     "immediately, before any traffic flows)", True),
    ("     Hostname:  _acme-challenge.ithelpdesk.mrsholdings.com", False),
    ("     Value:     ithelpdesk.mrsholdings.com.w03q9ge.flydns.net.", False),
    ("     (note the trailing dot if the provider's panel supports it)", False),
    ("", False),
    ("TTL:  300 seconds (5 minutes) on all records if the provider asks \u2014 this "
     "makes any future change propagate fast.", False),
    ("", False),
    ("Do NOT enable HTTP redirects or forwarding. Do NOT proxy these records "
     "through a CDN/WAF during initial setup \u2014 if the DNS is on Cloudflare, "
     "set the cloud icon to \u201cDNS only\u201d (grey), NOT orange/proxied. "
     "Proxied mode breaks Fly.io's automatic TLS certificate issuance. Proxying "
     "can be re-enabled later once everything works.", False),
    ("", False),
    ("Do not touch any existing records for mrsholdings.com, www, mail, MX, or "
     "TXT \u2014 we are only ADDING records.", False),
    ("", False),
    ("Alternative (only if the provider cannot do A + AAAA): a single CNAME "
     "record \u2014 Hostname: ithelpdesk.mrsholdings.com, Value: "
     "w03q9ge.ticketing-system-drifting-horizon-5610.fly.dev \u2014 plus the "
     "ACME challenge CNAME above. A name cannot have both a CNAME and A/AAAA "
     "records, so pick ONE approach.", False),
    ("", False),
    ("Fly.io will issue the HTTPS certificate automatically once these records "
     "exist. No certificate purchase or upload is needed.", False),
]
for text, bold in quote_lines:
    par = doc.add_paragraph()
    par.paragraph_format.left_indent = Inches(0.3)
    par.paragraph_format.right_indent = Inches(0.3)
    par.paragraph_format.space_after = Pt(3)
    run = par.add_run(text if text else " ")
    run.bold = bold
    if bold:
        run.font.size = Pt(11.5)
    shade(par, NOTE_FILL)

h(2, "Why these records?")
p("Fly.io recommends A + AAAA records pointing at the app's dedicated anycast addresses; "
  "the AAAA record is also what Fly uses to verify ownership automatically. The ACME "
  "challenge CNAME is optional but valuable: it lets Fly's certificate authority "
  "(Let's Encrypt) validate the domain via DNS and issue the HTTPS certificate "
  "immediately, even before traffic is flowing \u2014 the smoothest possible cutover. "
  "A CNAME alternative exists for providers that cannot manage A + AAAA, but a hostname "
  "cannot hold a CNAME and A/AAAA records at the same time, so only one approach may be "
  "used.")
callout(WARN_FILL, "WARNING:",
        "If the DNS is managed by an external hosting company through a control panel only "
        "they can access, the domain person may need to raise a support ticket with that "
        "host. The record details above are all the host needs \u2014 the process is the "
        "same.")
doc.add_page_break()

# ======================================================================
# PART 3
# ======================================================================
h(1, "Part 3 \u2014 The App-Side Steps (Fly.io)")
p("Do these in order. None of them takes the site down \u2014 the existing fly.dev URL "
  "keeps working the entire time, right up until the optional final cleanup.", bold=True)

h(2, "Step 0 \u2014 Preparation")
p("On a machine with the Fly.io CLI installed:")
code("""# Sign in (opens a browser) \u2014 skip if already signed in
fly auth login

# Confirm you can see the app (name must match fly.toml)
fly status -a ticketing-system-drifting-horizon-5610""")
p("Expected result: one or more machines running in region ams, internal port 4000. "
  "If 'fly' is not recognised, install the CLI first:")
code('powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"')

h(2, "Step 1 \u2014 Register the custom domain with Fly.io")
code("fly certs add ithelpdesk.mrsholdings.com -a ticketing-system-drifting-horizon-5610")
p("Fly.io responds by listing the DNS records it needs. For this app they are: "
  "A \u2192 66.241.124.121, AAAA \u2192 2a09:8280:1::189:b7e5:0, plus the optional "
  "ACME challenge CNAME _acme-challenge.ithelpdesk.mrsholdings.com \u2192 "
  "ithelpdesk.mrsholdings.com.w03q9ge.flydns.net. for pre-issuing the certificate. "
  "These exact values are already written into the Part 2 request \u2014 nothing "
  "further needs to be forwarded to the DNS person.")
callout(OK_FILL, "STATUS:",
        "This step has already been executed for this migration (certificate created, "
        "status 'Not verified' \u2014 normal until DNS exists). If re-running this "
        "guide for another app, record the exact values Fly prints; app-specific "
        "prefixes like w03q9ge differ per app.")

h(2, "Step 2 \u2014 Wait for DNS, then verify the certificate")
p("Once the DNS person confirms the record has been added:")
code("""# Check the world can resolve it (can take 5 min \u2013 24 h depending on old TTLs)
nslookup ithelpdesk.mrsholdings.com

# Check Fly.io has issued the certificate
fly certs show ithelpdesk.mrsholdings.com -a ticketing-system-drifting-horizon-5610""")
p("You want an 'Issued' status. Fly.io uses Let's Encrypt automatically; issuance "
  "typically completes within minutes of DNS resolving correctly. Re-run 'fly certs show' "
  "until it says issued.")
callout(OK_FILL, "CHECKPOINT:",
        "Browse to https://ithelpdesk.mrsholdings.com \u2014 the helpdesk login screen "
        "should load with a valid padlock, WHILE "
        "https://ticketing-system-drifting-horizon-5610.fly.dev still works. Both URLs now "
        "serve the same application.")
callout(OK_FILL, "STATUS:",
        "COMPLETED for this migration (24 Sep 2026): certificate issued by Let's "
        "Encrypt and verified active; https://ithelpdesk.mrsholdings.com returns 200 "
        "with a valid padlock; the fly.dev URL remains live.")

h(2, "Step 3 \u2014 Update the domain-dependent environment variables")
p("This application has two settings that bake the public URL into outgoing behaviour. "
  "Both must change or things will silently keep pointing at the old fly.dev address:")
table(
    ["Variable", "Where it is used", "New value"],
    [
        ["PORTAL_BASE_URL",
         "The \u201cview your ticket\u201d portal links inside every notification email "
         "(acknowledgement, assignment, status update, reply alerts).",
         "https://ithelpdesk.mrsholdings.com"],
        ["WEBHOOK_PUBLIC_URL",
         "Microsoft Graph change-notification subscription URL, derived as "
         "<WEBHOOK_PUBLIC_URL>/api/webhooks/microsoft-graph. Only relevant if the Graph "
         "integration is enabled.",
         "https://ithelpdesk.mrsholdings.com"],
    ],
    widths=[1.5, 3.3, 1.7],
)
code('fly secrets set PORTAL_BASE_URL="https://ithelpdesk.mrsholdings.com" -a ticketing-system-drifting-horizon-5610')
p("Only run this next command if WEBHOOK_PUBLIC_URL was previously set. Check first with "
  "'fly secrets list' \u2014 values stay hidden, but the variable names are shown:")
code('fly secrets set WEBHOOK_PUBLIC_URL="https://ithelpdesk.mrsholdings.com" -a ticketing-system-drifting-horizon-5610')
callout(WARN_FILL, "NOTE:",
        "'fly secrets set' restarts the machines \u2014 a few seconds of blip. This is "
        "the only interruption in the whole process. Do it at a quiet time.")
p("Do NOT change DATABASE_URL, DIRECT_URL, JWT_SECRET, the GRAPH_* credentials, or "
  "anything else. The Supabase database and the Microsoft app registration are completely "
  "independent of the domain.", bold=True)
callout(OK_FILL, "STATUS:",
        "COMPLETED for this migration (24 Sep 2026): both PORTAL_BASE_URL and "
        "WEBHOOK_PUBLIC_URL were set to https://ithelpdesk.mrsholdings.com (they had "
        "previously been set to the fly.dev URL \u2014 both were present in 'fly "
        "secrets list'). Machines restarted cleanly on the new values; /api/health "
        "now reports notificationUrl = https://ithelpdesk.mrsholdings.com/api/"
        "webhooks/microsoft-graph. Note: this deployment ingests mail via IMAP "
        "polling (IMAP_* secrets) with Microsoft Graph currently disabled, so Step 4 "
        "was not required \u2014 the webhook URL is simply correct and ready for "
        "when Graph is enabled.")

h(2, "Step 4 \u2014 Microsoft Graph webhook resubscription (only if Graph is enabled)")
p("The existing Graph subscription still points at the old fly.dev notification URL. The "
  "app's subscription service auto-renews subscriptions and recreates them when broken, "
  "but a URL change is not picked up by a simple renewal \u2014 so force a clean one:")
numbered([
    "After the Step 3 restart, the stored subscription record is stale. The service "
    "detects the mismatch on its next renewal cycle (default check every 30 minutes) "
    "\u2014 but do not wait for that.",
    "Either delete the old subscription via the admin integration screen / subscription "
    "service, or simply restart the app after the secret change and watch the logs \u2014 "
    "on recreation it logs the new notification URL. Confirm the new subscription's "
    "notificationUrl starts with https://ithelpdesk.mrsholdings.com/.",
    "Send a test email to the shared mailbox and confirm a ticket appears. Worst case it "
    "arrives within one poll cycle (MAIL_POLL_INTERVAL_MS, default 2 minutes) \u2014 "
    "polling is the always-on fallback, so mail ingestion never truly breaks during this.",
])

h(2, "Step 5 \u2014 Verification checklist")
checklist([
    "https://ithelpdesk.mrsholdings.com loads, valid certificate, no mixed-content "
    "warnings",
    "Sign in works; open a ticket; change its status; assign it to an agent",
    "https://ithelpdesk.mrsholdings.com/api/health returns healthy (it reports "
    "Graph/webhook/polling/subscription state and never leaks secrets)",
    "Trigger any notification email (e.g. create a test ticket) and confirm the portal "
    "link in the email goes to ithelpdesk.mrsholdings.com, NOT fly.dev",
    "Deep links work: refresh on https://ithelpdesk.mrsholdings.com/#/tickets?agentId=\u2026 "
    "(routing is hash-based, so there are no server-side rewrite rules to configure)",
    "Old fly.dev URL still responds (keep it alive during the transition)",
])

h(2, "Step 6 \u2014 Cutover communication & cleanup")
numbered([
    "Announce the new address to staff; update bookmarks, intranet links, email "
    "signatures, and onboarding documents.",
    "Be aware: emails sent BEFORE the change contain old fly.dev links. They still work "
    "(because the fly.dev URL stays live) \u2014 which is exactly why the old address is "
    "not hard-cut.",
    "Optional hardening once everyone has moved (wait at least 1\u20132 weeks so old "
    "emailed links die out): redirect or block the fly.dev hostname. There is currently "
    "no redirect logic in the server, so add a small middleware comparing "
    "req.headers.host and 301-redirecting to ithelpdesk.mrsholdings.com \u2014 a ~6-line "
    "change if wanted.",
    "Update internal records: fly.toml comments, README, docs/PROJECT_STATE.md, and any "
    "runbook that references the fly.dev URL.",
])
doc.add_page_break()

# ======================================================================
# PART 4
# ======================================================================
h(1, "Part 4 \u2014 Rollback Plan")
p("Nothing is destructive until Step 6, item 3, so rollback is trivial at every stage:")
table(
    ["Scenario", "Rollback action"],
    [
        ["Certificate will not issue",
         "Remove the CNAME at the DNS provider, then run:  fly certs remove "
         "ithelpdesk.mrsholdings.com -a ticketing-system-drifting-horizon-5610.  "
         "Done \u2014 the fly.dev address never stopped working."],
        ["Emails / webhooks point at the wrong place after Step 3",
         "fly secrets set PORTAL_BASE_URL=\"https://ticketing-system-drifting-horizon-5610."
         "fly.dev\" -a ticketing-system-drifting-horizon-5610  (and the same for "
         "WEBHOOK_PUBLIC_URL) to revert instantly."],
        ["DNS change itself was a mistake",
         "Deleting the CNAME returns mrsholdings.com DNS to exactly its prior state, "
         "because you only ever ADDED a record."],
    ],
    widths=[2.6, 3.9],
)
doc.add_page_break()

# ======================================================================
# PART 5
# ======================================================================
h(1, "Part 5 \u2014 Common Pitfalls (Each One Is a Real Failure Mode)")
table(
    ["#", "Pitfall", "Consequence / prevention"],
    [
        ["1", "Cloudflare orange-cloud proxying on the new record",
         "Breaks Fly.io's TLS issuance \u2014 set \u201cDNS only\u201d (grey cloud) until "
         "the certificate is issued."],
        ["2", "TTL too long on the new record",
         "Slows validation and any future fix \u2014 ask for 300 seconds."],
        ["3", "Forgetting PORTAL_BASE_URL",
         "The site works, but every notification email links to the old domain. This is "
         "the #1 silent failure for this app."],
        ["4", "Forgetting WEBHOOK_PUBLIC_URL",
         "Near-real-time mail ingestion quietly degrades to 2-minute polling."],
        ["5", "Mixing record types on ithelpdesk.mrsholdings.com (CNAME + A/AAAA)",
         "Invalid DNS (a name cannot have both); may block validation. Pick ONE "
         "approach from Part 2."],
        ["6", "Trying to put the helpdesk on bare mrsholdings.com",
         "Breaks/conflicts with the company website and apex DNS rules. Don't."],
        ["7", "DNS managed by an external host's control panel",
         "The domain person may need to raise a support ticket with the host \u2014 the "
         "record details in Part 2 are all they need."],
    ],
    widths=[0.35, 2.45, 3.7],
)

doc.add_paragraph()
callout(OK_FILL, "REALISTIC TIMELINE:",
        "About 15 minutes of hands-on work, plus DNS propagation (typically 5\u201360 "
        "minutes, worst case 24 hours).")
doc.add_page_break()

# ======================================================================
# APPENDIX
# ======================================================================
h(1, "Appendix \u2014 One-Page Quick Reference")
h(2, "The DNS record (give to the domain person)")
table(
    ["Hostname", "Type", "Value", "TTL"],
    [
        ["ithelpdesk.mrsholdings.com", "A", "66.241.124.121", "300"],
        ["ithelpdesk.mrsholdings.com", "AAAA", "2a09:8280:1::189:b7e5:0", "300"],
        ["_acme-challenge.ithelpdesk.mrsholdings.com", "CNAME",
         "ithelpdesk.mrsholdings.com.w03q9ge.flydns.net.", "300"],
    ],
    widths=[2.2, 0.8, 2.6, 0.6],
)
h(2, "The commands (app side, in order)")
code("""fly auth login
fly status -a ticketing-system-drifting-horizon-5610
fly certs add ithelpdesk.mrsholdings.com -a ticketing-system-drifting-horizon-5610
nslookup ithelpdesk.mrsholdings.com
fly certs show ithelpdesk.mrsholdings.com -a ticketing-system-drifting-horizon-5610
fly secrets set PORTAL_BASE_URL="https://ithelpdesk.mrsholdings.com" -a ticketing-system-drifting-horizon-5610
fly secrets set WEBHOOK_PUBLIC_URL="https://ithelpdesk.mrsholdings.com" -a ticketing-system-drifting-horizon-5610   # only if already set""")
h(2, "Success criteria")
bullets([
    "https://ithelpdesk.mrsholdings.com serves the app with a valid certificate.",
    "Notification-email links point at ithelpdesk.mrsholdings.com.",
    "Graph webhook subscription (if enabled) uses the new notification URL.",
    "https://ticketing-system-drifting-horizon-5610.fly.dev still works during the "
    "transition period.",
])

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                   "Helpdesk-Domain-Migration-Guide-v3.docx")
out = os.path.normpath(out)
doc.save(out)
print("Saved:", out)
