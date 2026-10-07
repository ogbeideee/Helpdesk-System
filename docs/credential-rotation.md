# Credential rotation runbook

Every credential in this deployment is set in two places and nowhere else:
`server/.env` (local, git-ignored) and the Fly secret store (production).
Nothing is stored in source — see [Secrets](#secrets-never-in-the-repository).

**If a credential is ever exposed, rotate it. Do not reason about how likely
exposure was.** The cost of an unnecessary rotation is five minutes; the cost
of a skipped one is a mailbox someone else can read.

---

## Google OAuth client (Gmail IMAP)

The one used by the live ingestion path: IMAP over XOAUTH2 against
`ithelpdesk@example.com`.

| Where | Name |
|---|---|
| Google Cloud Console | the OAuth client used by the IMAP poller |
| `server/.env` | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |
| Fly secret | same three names |

### Rotate the client secret

1. Google Cloud Console → **APIs & Services** → **Credentials**.
2. Find the OAuth client used by the IMAP poller → **Edit** → **Create new
   client secret**. Note the new value; the old one stays valid until you
   delete it, which is what makes step 5 necessary.
3. Update the secret in both places:
   ```powershell
   # production
   flyctl secrets set GOOGLE_OAUTH_CLIENT_SECRET="<new-value>" --app ticketing-system-drifting-horizon-5610
   # local — edit server/.env directly
   ```
4. Redeploy so the machines pick up the new secret:
   ```bash
   flyctl deploy --remote-only --app ticketing-system-drifting-horizon-5610
   ```
5. **Delete the old client secret** in the console. Until you do, both values
   work, so deleting only the local copy achieves nothing.

### Check it worked

The poller must keep polling. Within a minute of the redeploy:

```bash
curl -s https://ithelpdesk.example.com/api/health | python -c "import json,sys; d=json.load(sys.stdin)['integration']['imap']; print(d['polling']['running'], d['lastError'])"
```

`True` and a blank `lastError` means ingestion is healthy. A bad token shows
`invalid_grant` or an auth error in the same payload, and **no new tickets will
be created** while it fails.

### The refresh token

Independent of the client secret, and rarely the problem. To mint a new one:

```bash
cd server
GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node scripts/generate-refresh-token.js
```

The script reads both from the environment, refuses to run without them, and
prints the redirect URL to open. Put the new token in `server/.env` and in the
Fly secret store, redeploy, and delete the old one if you are replacing it.

---

## Other credentials

| Credential | Where it lives | How to rotate |
|---|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Supabase → project settings → database | Reset in the Supabase dashboard, then update `.env` and `flyctl secrets set`. **The old pooled connections die**, so redeploy immediately. |
| `GROQ_API_KEY` | console.groq.com | Create a new key, update both, redeploy, delete the old one. |
| `FLY_API_TOKEN` | fly.io account → personal access tokens | `flyctl auth token` issues a new one; update the GitHub secret `FLY_API_TOKEN` and your local `flyctl`. |
| `JWT_SECRET` | your own value | Changing it signs every user out. Update both, redeploy. |
| `INITIAL_ADMIN_EMAIL` | your own value | Only ever mints the first admin while zero active admins exist. Changing it later cannot mint a second. |

---

## Secrets: never in the repository

**This repository is public.** Anything committed here is published, and every
clone and mirror keeps a copy. GitHub's push protection is one layer, not the
only layer.

Three controls, all in place:

1. **A pre-commit hook** — `npm run hooks:install` (once per clone). Runs
   `scripts/secret-scan.js` on every commit and refuses the commit.
   `git commit --no-verify` skips it, which is why control 3 exists.
2. **CI** — `.github/workflows/secret-scan.yml` runs gitleaks *and* the project
   scanner over the full history on every push and pull request. This cannot be
   skipped locally.
3. **GitHub push protection** — the server-side backstop that stopped the
   2026-09-26 incident.

Scan by hand at any time:

```bash
npm run scan:secrets          # every tracked file
npm run scan:secrets -- <a>..<b>   # a commit range
cd server && npm run test:secret-scan   # the scanner's own suite
```

### The deployment's own address is also forbidden

The shared mailbox and its domain are not credentials, and that is precisely why
they need a rule of their own: a scanner looking for a password has no reason to
read an email address. They reached `.env.example`, three docs and two committed
`.docx` guides before anyone noticed — and a `.docx` is deflated XML inside a
zip, so the scanner, `git grep -I` and gitleaks all skip it silently. Two rules
(`production-mailbox`, `production-domain`) now block both the address and the
bare domain, and `*.docx` is git-ignored outright: a binary no control can read
has no place in a public repository.

The rules assemble the domain from fragments rather than spelling it out, so
neither the scanner nor its test suite contains the value it forbids. That is
also why `IGNORED_PATHS` does not need a new exemption — an exemption is a hole
that quietly rots.

They are **forward-only**, and that is deliberate rather than a convenience. CI
sweeps every commit in history, and a rule forbidding a value that is already in
the history fires on every one of those commits — permanently, because a value
in published history cannot be unpublished. Writing the rules turned the whole
history sweep red on the day it was done. So the current tree (and the
pre-commit hook) is scanned with every rule, and the history sweep skips only
the forward-only pair. The credential rules still sweep history in full, because
a credential in history is a live exposure that has to be found and rotated;
`J.1`–`J.7` in the scanner's suite pin both halves of that split.

For the same reason these two rules are **not** in `.gitleaks.toml`. gitleaks
has no equivalent of forward-only scoping, and the project scanner runs in the
same workflow anyway.

If you need the real values: `server/.env` (git-ignored) and the Fly secret
store. `GRAPH_SHARED_MAILBOX` and `PORTAL_BASE_URL` are the two names that carry
it.

### If the scanner is wrong

False positives happen. Two options, in order of preference:

- Narrow the rule or add the shape to `ALLOW_SUBSTRINGS` in
  `scripts/secret-scan.js`, **with a comment saying why it is safe**.
- Never `--no-verify` as a habit. A hook that cries wolf gets bypassed, and a
  bypassed hook protects nothing.

### If you do commit a secret

1. Do not "unblock" it in GitHub — that publishes it.
2. Rotate the credential **first** (the sections above).
3. Rewrite the unpushed commits, or the published history, to remove it.
4. Re-scan the range to confirm: `npm run scan:secrets -- <a>..<b>`.
5. Tell the team. A secret removal nobody knows about looks like a fix when it
   is only half of one.
