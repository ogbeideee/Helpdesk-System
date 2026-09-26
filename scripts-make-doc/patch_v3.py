import io

path = r"c:\Users\dogbeide\TICKETING SYSTEM\scripts-make-doc\build_migration_doc.py"
with io.open(path, encoding="utf-8") as f:
    src = f.read()

# Mark Steps 2 and 3 as completed (migration executed 24 Sep 2026).
old1 = '''callout(OK_FILL, "CHECKPOINT:",
        "Browse to https://ithelpdesk.mrsholdings.com \\u2014 the helpdesk login screen "
        "should load with a valid padlock, WHILE "
        "https://ticketing-system-drifting-horizon-5610.fly.dev still works. Both URLs now "
        "serve the same application.")'''
new1 = '''callout(OK_FILL, "CHECKPOINT:",
        "Browse to https://ithelpdesk.mrsholdings.com \\u2014 the helpdesk login screen "
        "should load with a valid padlock, WHILE "
        "https://ticketing-system-drifting-horizon-5610.fly.dev still works. Both URLs now "
        "serve the same application.")
callout(OK_FILL, "STATUS:",
        "COMPLETED for this migration (24 Sep 2026): certificate issued by Let's "
        "Encrypt and verified active; https://ithelpdesk.mrsholdings.com returns 200 "
        "with a valid padlock; the fly.dev URL remains live.")'''
assert src.count(old1) == 1, "old1 not found"
src = src.replace(old1, new1)

old2 = '''p("Do NOT change DATABASE_URL, DIRECT_URL, JWT_SECRET, the GRAPH_* credentials, or "
  "anything else. The Supabase database and the Microsoft app registration are completely "
  "independent of the domain.", bold=True)'''
new2 = '''p("Do NOT change DATABASE_URL, DIRECT_URL, JWT_SECRET, the GRAPH_* credentials, or "
  "anything else. The Supabase database and the Microsoft app registration are completely "
  "independent of the domain.", bold=True)
callout(OK_FILL, "STATUS:",
        "COMPLETED for this migration (24 Sep 2026): both PORTAL_BASE_URL and "
        "WEBHOOK_PUBLIC_URL were set to https://ithelpdesk.mrsholdings.com (they had "
        "previously been set to the fly.dev URL \\u2014 both were present in 'fly "
        "secrets list'). Machines restarted cleanly on the new values; /api/health "
        "now reports notificationUrl = https://ithelpdesk.mrsholdings.com/api/"
        "webhooks/microsoft-graph. Note: this deployment ingests mail via IMAP "
        "polling (IMAP_* secrets) with Microsoft Graph currently disabled, so Step 4 "
        "was not required \\u2014 the webhook URL is simply correct and ready for "
        "when Graph is enabled.")'''
assert src.count(old2) == 1, "old2 not found"
src = src.replace(old2, new2)

src = src.replace("Helpdesk-Domain-Migration-Guide-v2.docx",
                  "Helpdesk-Domain-Migration-Guide-v3.docx")

with io.open(path, "w", encoding="utf-8") as f:
    f.write(src)
print("v3 patches applied.")
