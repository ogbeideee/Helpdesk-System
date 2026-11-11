# Personal weekly reports

Staff open **My Weekly Report** from Operations. Choose a date to open its
Monday–Sunday week in Africa/Lagos time. Friday is the report date. All 15
initial activities have a counter and description/progress box, including
off-site work and both Helpdesk Platform activities. Add custom activities
with a name and report category. Only non-zero or described activities appear
in accomplishments. Notes cover the summary, ongoing projects, roadblocks and
next week's priorities. **Create Report** now writes the executive summary and
the four accomplishments paragraphs from current counts and descriptions.

The page opens on **Activities**, with Previous week / This week / Next week
navigation and a date picker. Compact activity rows expose quick + / − counts;
expand a row for frequency, description and project status. **All**, **Recorded**
and **Favourites** filters narrow the list; Recorded includes progress-only
entries and explicit project statuses. **Report preview** holds generated wording
separately. **Report setup** folds away the reference upload, AI preference and
automatic ticket counting. Administrators also have a folded team activity list.
The page's sticky action bar offers **Review & generate**, then **Export Excel**
and **Regenerate report** when the current draft is ready. The application rail
and header are unchanged.

Activity frequency uses **Not done** (0), **Once** (1), or **Multiple times**
(2 or more). Multiple times reveals a number field and + / − controls; its
minimum is 2. Use Once to record a single activity. Switching away and back
restores the last multiple count while that week's page remains open. Existing
saved counts automatically select the matching option. Descriptions remain
available in every state; a zero count with a description is progress only.

**Pin as favourite** moves an activity into a personal Favourites section.
Favourites are stored per account and reused across weeks/devices; other agents
do not see them. Entries remain in their original report category when exported.

Counts, descriptions, project statuses and report notes autosave after a short
pause. Saving is serialized: edits made while a save is running are retained
and saved next using the new version. The page shows Saving / Saved, and pauses
autosave on failure or conflict without discarding the local entries. Use Save
activities to retry; for an edit from another tab, reload and reconcile first.
Report wording also autosaves. Its writes are serialized with version updates,
retain edits made during a save and pause on failure. Switching tabs or weeks,
generating and exporting flush pending changes first; failed saves keep the
current editor open. Retry save resumes saving without discarding local text.

Project activities support Not specified, In progress and Completed. Completion
requires a positive activity count, enforced by the service. Setting a completed
activity to Not done clears its completion status. Carry-forward resets project
statuses along with activity counts/descriptions. The writer receives explicit
statuses; its factual fallback and validated AI passages reflect them. Existing
reports with no status retain their original meaning.

Create Report opens **Review your week** with all recorded activities, counts,
project statuses and descriptions. Missing project/off-site descriptions prompt
for more detail without preventing generation. Back to entries lets the agent
correct the inputs; Generate report flushes pending autosaves before writing.
Long reviews scroll inside the activity region while the title and action
buttons stay visible, including on small or short screens. The region can be
focused and scrolled with the keyboard.

Use **Review & generate** to review the current totals. **Generate report** saves
and writes an editable preview; **Export Excel** saves any wording edits and
downloads that draft without invoking the writer again. Changes to activities,
notes or the live ticket total require creating the report again before export.
Edits replace a personal weekly snapshot; there is no activity change history.
Other agents and administrators cannot read another person's weekly report.
Concurrent edits return a conflict instead of silently replacing another tab.

Automatic ticket counting starts off for each week. When enabled it counts
distinct ticket IDs in existing `ticket.resolved` audit events attributed to
the signed-in account within that week. It appears separately under User
Support and never guesses a routine activity from ticket text. Repeated
resolution of the same ticket in a week counts once. Historical resolutions
without an attributed event cannot be counted. Save to refresh the count.

Administrators can add, enable and disable standard activities at the bottom
of the page. Existing weekly snapshots retain their activity labels/counts.
Custom activities remain personal. Shared-list changes do not create a history.

The export layout is a text-only representation of the supplied workbook's
column widths, cell styles, merges and row heights, with its sample contents
removed. The generator fills the original sections with the agent's data and
expands narrative rows for content. No source workbook or private report text
is committed. Export uses ExcelJS on the server; user text is written as literal
strings, never formulas.

## Previous reports and writing style

Upload a previous `.xlsx` once in **Start from a previous report**. The reference
is private to the signed-in account and reused across weeks until replaced or
removed. It stores extracted writing samples and a text-only formatting layout,
not the original file, identity fields or a history of uploads. The supported
format is the supplied two-column workbook with its five section headings and
four accomplishment categories in their original order. Shifted rows and
continuation rows from exported reports are supported. Column widths, cell
styles and single-row A:B merges are reused. Narrative sections are rewritten;
old achievements and totals are never deliberately carried into current work.

Upload copies ongoing projects, roadblocks and priorities into the current
editable notes only after a comparison dialog: select the sections to replace;
unchecked sections keep their current text. Upload still saves the writing
reference even if that notes dialog is dismissed. **Use last week's notes**
reads the most recent earlier saved personal report and opens the same comparison.
Missing activities can be carried
forward with zero counts and blank descriptions; recorded current-week work
is not overwritten. Neither action carries forward an old executive summary.

**Match sample wording with AI** uses the existing server-side `GROQ_API_KEY`.
`GROQ_REPORT_MODEL` overrides the report writer's model, otherwise it uses
`GROQ_TRIAGE_MODEL` or the existing default. `WEEKLY_REPORT_AI_DISABLED=true`
stops AI report calls. AI receives activity names, counts, descriptions and
sample summary/accomplishment text; it does not receive account identity,
mailbox credentials, ticket/email bodies or forward-looking notes. Writing
samples and descriptions are explicitly untrusted data, not instructions.
Without an upload, a prior generated personal report can supply the tone.

The provider returns an executive summary and one passage per activity.
Generated summary/accomplishment prose uses qualitative frequency: single
activities omit the quantity, repeated work uses multiple (two occurrences) or
several (three or more). Exact activity totals remain in the entry fields and
are not sent to the provider; it receives a frequency label instead. Technical
names and details such as M365 and 2FA retain their numbers. The factual fallback
uses the same wording policy. Existing saved drafts change only on regeneration.
Validation rejects missing/duplicate activities and unsupported numeric or
written totals. The writer is instructed to avoid invented outcomes and to
preserve incomplete work as progress. Agents must review the draft. Provider
failure, timeout, rate limiting, invalid output or a missing key produces a
factual sentence-based report with a visible fallback message. Switching AI off
uses local factual writing directly. Report generation is limited to five
attempts per account per minute; uploads to ten. Uploads are capped at 2 MB
compressed and 10 MB expanded, with complex/macro/embedded/external-link files
and formula-based reference text rejected. Generated drafts are saved as current
weekly snapshots, not change logs, with compare-and-set concurrency protection.

Apply the committed migration with `cd server && npm run db:deploy` before
running this feature, then regenerate Prisma with `npm run db:generate` if
needed. Test with `node scripts/test-weekly-reports.js` in `server`; it uses
the disposable local PostgreSQL database and exercises authorization,
isolation, concurrency, counts and the resulting Excel workbook.
