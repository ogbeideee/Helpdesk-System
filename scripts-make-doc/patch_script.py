import io

path = r"c:\Users\dogbeide\TICKETING SYSTEM\scripts-make-doc\build_migration_doc.py"
with io.open(path, encoding="utf-8") as f:
    src = f.read()

# 1) Step 1 narrative — reflect the values Fly actually issued and that it has been run.
old1 = '''code("fly certs add ithelpdesk.mrsholdings.com -a ticketing-system-drifting-horizon-5610")
p("Fly.io responds by listing the DNS records it needs to see. For a subdomain this will "
  "match the CNAME from Part 2. If Fly additionally prints an "
  "_acme-challenge.ithelpdesk.mrsholdings.com TXT or CNAME record, forward that exact "
  "record to the DNS person as well \\u2014 it is the certificate-validation proof.")'''
new1 = '''code("fly certs add ithelpdesk.mrsholdings.com -a ticketing-system-drifting-horizon-5610")
p("Fly.io responds by listing the DNS records it needs. For this app they are: "
  "A \\u2192 66.241.124.121, AAAA \\u2192 2a09:8280:1::189:b7e5:0, plus the optional "
  "ACME challenge CNAME _acme-challenge.ithelpdesk.mrsholdings.com \\u2192 "
  "ithelpdesk.mrsholdings.com.w03q9ge.flydns.net. for pre-issuing the certificate. "
  "These exact values are already written into the Part 2 request \\u2014 nothing "
  "further needs to be forwarded to the DNS person.")
callout(OK_FILL, "STATUS:",
        "This step has already been executed for this migration (certificate created, "
        "status 'Not verified' \\u2014 normal until DNS exists). If re-running this "
        "guide for another app, record the exact values Fly prints; app-specific "
        "prefixes like w03q9ge differ per app.")'''
assert src.count(old1) == 1, "old1 not found"
src = src.replace(old1, new1)

# 2) Pitfall #5 — no longer 'A record just in case'; now the mixing warning.
old2 = '''        ["5", "Adding an A record \\u201cjust in case\\u201d alongside the CNAME",
         "Invalid DNS (a name cannot have both); may block validation."],'''
new2 = '''        ["5", "Mixing record types on ithelpdesk.mrsholdings.com (CNAME + A/AAAA)",
         "Invalid DNS (a name cannot have both); may block validation. Pick ONE "
         "approach from Part 2."],'''
assert src.count(old2) == 1, "old2 not found"
src = src.replace(old2, new2)

# 3) Appendix quick-reference DNS table — the real records.
old3 = '''table(
    ["Hostname", "Type", "Value", "TTL"],
    [["ithelpdesk.mrsholdings.com", "CNAME",
      "ticketing-system-drifting-horizon-5610.fly.dev", "300"]],
    widths=[2.2, 0.8, 2.6, 0.6],
)'''
new3 = '''table(
    ["Hostname", "Type", "Value", "TTL"],
    [
        ["ithelpdesk.mrsholdings.com", "A", "66.241.124.121", "300"],
        ["ithelpdesk.mrsholdings.com", "AAAA", "2a09:8280:1::189:b7e5:0", "300"],
        ["_acme-challenge.ithelpdesk.mrsholdings.com", "CNAME",
         "ithelpdesk.mrsholdings.com.w03q9ge.flydns.net.", "300"],
    ],
    widths=[2.2, 0.8, 2.6, 0.6],
)'''
assert src.count(old3) == 1, "old3 not found"
src = src.replace(old3, new3)

# 4) Part 2 intro — validation record is now part of the request, not 'later'.
old4 = '''p("Send them the block below verbatim. It contains everything they need and nothing they "
  "don't. (If Fly.io later asks for an additional certificate-validation record \\u2014 see "
  "Part 3, Step 1 \\u2014 forward that exact record to them as well.)")'''
new4 = '''p("Send them the block below verbatim. It contains everything they need and nothing "
  "they don't \\u2014 including the certificate-validation record Fly.io asked for.")'''
assert src.count(old4) == 1, "old4 not found"
src = src.replace(old4, new4)

with io.open(path, "w", encoding="utf-8") as f:
    f.write(src)
print("All 4 patches applied.")
