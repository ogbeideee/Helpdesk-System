/* Mobile layout contract checks.
 *
 * The phone layout lives in two places that have to agree: the stylesheet
 * (index.css) and the shell markup (App.jsx / TopBar.jsx). Nothing here needs a
 * browser — these are static checks over those files, in the repo's existing
 * check-script style (see sla-check.mjs / live-check.mjs).
 *
 * What is pinned:
 *   1. the document opts into the device width and the safe area,
 *   2. every breakpoint is a step on the sanctioned ladder,
 *   3. the rail/drawer contract: CSS slides the rail, the shell toggles the
 *      class, the header carries the toggle, the scrim closes it,
 *   4. the ≤900px rail is still a *row* — the shell must not be restacked into
 *      a column, which is what turned the rail into a strip across the top,
 *   5. stacked tables: the opt-in class, the label printer, and the cells that
 *      need a `data-label` to survive the fold,
 *   6. the two iOS behaviours that make a phone form unusable (page zoom on
 *      focus, and a shortcut hint with no keyboard).
 *
 * Run: node mobile-check.mjs  (from client/)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(dir, ...p), 'utf8');

const css = read('src', 'index.css');
const html = read('index.html');
const app = read('src', 'App.jsx');
const topbar = read('src', 'components', 'TopBar.jsx');
const tickets = read('src', 'components', 'TicketsPage.jsx');
const agents = read('src', 'components', 'AgentsPage.jsx');
const audit = read('src', 'components', 'AuditTrailPage.jsx');
const m365 = read('src', 'components', 'Microsoft365Page.jsx');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}

/* ---- tiny CSS reader ----------------------------------------------------
   Every @media block, with its query and its body, whatever the nesting. */
function mediaBlocks(source) {
  const out = [];
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(source))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    out.push({ query: m[0].slice(0, -1).trim(), body: source.slice(start, i - 1) });
  }
  return out;
}

const blocks = mediaBlocks(css);
const widths = new Set();
for (const b of blocks) {
  for (const w of b.query.matchAll(/max-width:\s*(\d+)px/g)) widths.add(Number(w[1]));
}

/* On phones the drawer is the shell's navigation; below 560 the phone rules
   take over. The rest are the pre-existing desktop/tablet ladder. */
const LADDER = [1240, 1180, 1100, 1080, 900, 860, 768, 640, 620, 560];
const stray = [...widths].filter((w) => !LADDER.includes(w)).sort((a, b) => a - b);
check('every max-width breakpoint is on the sanctioned ladder', stray.length === 0,
  `unexpected: ${stray.join(', ')}`);
check('the drawer breakpoint (768px) exists', widths.has(768));
check('the phone breakpoint (560px) exists', widths.has(560));

/* ---- 1. the document ---------------------------------------------------- */
check('viewport targets the device width',
  /<meta\s+name="viewport"[^>]*width=device-width/.test(html));
check('viewport includes initial-scale=1', /initial-scale=1/.test(html));
check('viewport opts into the safe area (viewport-fit=cover)',
  /viewport-fit=cover/.test(html));
check('the CSS honours the safe-area insets', /env\(safe-area-inset-left\)/.test(css));
check('typography cannot be inflated by rotating the device',
  /-webkit-text-size-adjust: 100%/.test(css));


/* ---- 2. the rail / drawer contract -------------------------------------- */
const drawer = blocks.find((b) => /max-width:\s*768px/.test(b.query));
check('the 768px block exists', !!drawer);
const drawerBody = drawer ? drawer.body : '';
check('the rail becomes a fixed drawer', /\.sidebar\s*\{[^}]*position:\s*fixed/.test(drawerBody));
check('the drawer starts off-screen, not merely invisible',
  /\.sidebar\s*\{[^}]*transform:\s*translateX\(-/.test(drawerBody));
check('the open state is driven by the shell class',
  /\.shell\.is-nav-open\s+\.sidebar/.test(drawerBody));
check('a scrim closes the drawer', /\.nav-scrim/.test(drawerBody));
check('the page behind an open drawer does not scroll',
  /body\.is-nav-open\s*\{[^}]*overflow:\s*hidden/.test(drawerBody));

/* A collapsed rail is a desktop preference: inside the drawer nothing may
   stay hidden, so the drawer re-points the tokens for `.is-collapsed` too. */
check('the drawer overrides the collapsed-rail tokens',
  /\.shell,\s*\.shell\.is-collapsed\s*\{/.test(drawerBody));

check('the shell toggles the open class', /is-nav-open/.test(app));
check('the scrim is rendered by the shell', /className="nav-scrim"/.test(app));
check('the rail is a landmark the header can point at', /id="app-nav"/.test(app));
check('the header renders the drawer toggle', /className="nav-toggle"/.test(topbar));
check('the toggle is labelled and wired to the rail',
  /aria-controls="app-nav"/.test(topbar) && /aria-expanded=\{navOpen\}/.test(topbar));
check('the toggle is hidden above the drawer breakpoint',
  /^\.nav-toggle\s*\{\s*display:\s*none;/m.test(css));
check('navigating closes the drawer',
  /function navigate\(path\)\s*\{[\s\S]{0,140}setNavOpen\(false\)/.test(app));
check('Escape closes the drawer',
  /Escape'[\s\S]{0,60}setNavOpen\(false\)/.test(app));
check('leaving the phone layout closes the drawer', /matchMedia\(MOBILE_NAV_QUERY\)/.test(app));

/* A menu hung off a 36px button near the right edge would fall off a phone:
   the header menus anchor to the header instead. */
check('header menus hang from the header, not from a button edge',
  /\.topbar \.menu\s*\{/.test(drawerBody)
  && /\.topbar \.popover-anchor\s*\{\s*position:\s*static/.test(drawerBody));
check('search results stay anchored to the search field',
  /\.topbar \.global-search\s*\{\s*position:\s*relative/.test(drawerBody)
  && /\.topbar \.menu-search\s*\{/.test(drawerBody));

/* ---- 3. the ≤900px rail is a rail, not a strip across the top ----------- */
const tablet = blocks.find((b) => /max-width:\s*900px/.test(b.query));
const tabletBody = tablet ? tablet.body : '';
check('the tablet rail is not restacked into a column',
  !/\.shell\s*\{[^}]*flex-direction:\s*column/.test(tabletBody));
check('the tablet rail is not stretched to the full width',
  !/\.sidebar\s*\{[^}]*width:\s*100%/.test(tabletBody));
check('the tablet rail folds to icons through the rail tokens',
  /--rail-w:\s*62px/.test(css));

/* ---- 4. stacked tables -------------------------------------------------- */
check('a stacked table un-tables the table element itself',
  /\.table-stack > table\s*\{[^}]*display:\s*block/.test(drawerBody));
check('a stacked table prints its own column names',
  /\.table-stack td\[data-label\]::before\s*\{[^}]*content:\s*attr\(data-label\)/.test(drawerBody));
check('a stacked table hides its header row',
  /\.table-stack thead\s*\{[^}]*display:\s*none/.test(drawerBody));
check('a stacked row is not clipped by a scroll frame',
  /\.table-stack\s*\{[^}]*overflow:\s*visible/.test(drawerBody));

const labels = (src) => (src.match(/data-label=/g) || []).length;
check('the ticket queue keeps its per-cell labels', labels(tickets) >= 8, `found ${labels(tickets)}`);
check('the agents table folds into cards',
  /agents-table table-stack/.test(agents) && labels(agents) >= 7, `found ${labels(agents)}`);
check('the availability timeline folds into cards', /table-wrap table-stack/.test(agents));
check('the audit trail folds into cards',
  /table-wrap table-stack/.test(audit) && labels(audit) >= 5, `found ${labels(audit)}`);
check('truncated audit cells may wrap once they are cards',
  /\.audit-table \.audit-summary[\s\S]{0,240}white-space:\s*normal/.test(drawerBody));
check('the Microsoft 365 variable table folds too',
  /className="table-stack"/.test(m365) && labels(m365) >= 3, `found ${labels(m365)}`);

/* A fixed-track grid wider than a phone widens the page; the drawer block must
   not introduce one. */
const drawerTracks = [...drawerBody.matchAll(/grid-template-columns:[^;]*/g)].map((m) => m[0]);
const wide = drawerTracks.filter((t) => /minmax\(\s*\d{3,}px/.test(t));
check('no drawer-width grid track is wider than a phone', wide.length === 0, wide.join(' | '));

/* ---- 5. the ticket queue, which is the screen people live in --------- */
/* A folded table is not yet a good list: printing "STATUS  NEW" above every
   ticket spends a row on a fact the badge already says, and sorting becomes
   unreachable once the header row is hidden. */
check('the queue composes each ticket as a card, not a stack of labels',
  /\.queue-cards \.queue-table tbody tr\s*\{[^}]*display:\s*grid/.test(drawerBody)
  && /grid-template-areas:[\s\S]{0,160}"id\s+age"/.test(drawerBody));
check('the queue card does not print column labels',
  /\.queue-cards \.queue-table td\[data-label\]::before\s*\{\s*display:\s*none/.test(drawerBody));
check('the queue card keeps every field',
  /data-label="Ticket"/.test(tickets) && /data-label="Assigned to"/.test(tickets)
  && /data-label="SLA"/.test(tickets) && /data-label="Group"/.test(tickets));
check('the queue card is scoped to the queue screen, not the dashboard panel',
  /className="queue-table-wrap queue-cards"/.test(tickets));
check('sorting survives the fold (the header sort buttons do not)',
  /function SortControl/.test(tickets) && /className="queue-sort"/.test(tickets)
  && /\.queue-sort\s*\{\s*display:\s*none/.test(css)
  && /\.queue-sort\s*\{[^}]*display:\s*flex/.test(drawerBody));
check('the subject is clamped to two lines on a card',
  /-webkit-line-clamp:\s*2/.test(drawerBody));
check('the secondary filters open full-width',
  /\.filter-row\s*\{[^}]*flex-direction:\s*column/.test(drawerBody));

/* ---- 6. ticket detail ------------------------------------------------- */
/* Stacked, the inspector used to land below the whole conversation, so the
   status and assignment controls were two screens down from the ticket. */
check('ticket detail puts the inspector above the conversation',
  /\.detail-layout\s*\{[^}]*display:\s*flex/.test(drawerBody)
  && /\.detail-layout \.inspector\s*\{[^}]*order:\s*-1/.test(drawerBody));
check('ticket detail is not a sticky sidebar on a phone',
  /\.detail-layout \.inspector\s*\{[^}]*position:\s*static/.test(drawerBody));
check('a card head may wrap on a phone',
  /\.card-head\s*\{\s*flex-wrap:\s*wrap/.test(drawerBody));

/* ---- 7. one search, in the header ------------------------------------ */
/* The header search is the product's and is on every screen. A second field
   on the queue is the same job twice, and two search boxes on one screen is
   the fastest way to stop people trusting either of them. */
check('the queue has no search field of its own',
  !/Search tickets, subjects/.test(tickets)
  && !/aria-label="Search tickets"/.test(tickets)
  && !/className="search-field"/.test(tickets)
  && !/filters\.q/.test(tickets)
  && !/debouncedQ/.test(tickets));
check('the queue does not keep a dead q filter behind',
  !/q:\s*debouncedQ/.test(tickets) && !/\bq:\s*''/.test(tickets));
check('the header keeps the product search',
  /global-search/.test(topbar)
  && /placeholder="Search tickets, users, categories…"/.test(topbar));
check('the status segments fill the space the search field left',
  /\.queue-controls \.segmented\s*\{[^}]*flex:\s*1 1 auto/.test(css));

/* ---- 6. the things that make a phone form unusable ---------------------- */
check('focusable fields are 16px on phones (no iOS zoom-on-focus)',
  /input,\s*select,\s*textarea[\s\S]{0,340}font-size:\s*16px/.test(drawerBody));
check('the keyboard-shortcut hint is hidden on phones',
  /\.kbd-hint\s*\{\s*display:\s*none/.test(drawerBody));

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — mobile checks (${failures} failure${failures === 1 ? '' : 's'})`);
process.exit(failures === 0 ? 0 : 1);
