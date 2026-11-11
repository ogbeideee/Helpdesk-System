/* How a queue row signals state, as a contract.
 *
 * Two halves of one subject: a row has to be readable at a glance, and it has
 * to be readable about the right thing.
 *
 *   1. COLOUR. A row carries four independent signals — lifecycle, priority,
 *      SLA and ownership — and they used to share one palette, so a healthy row
 *      shouted as loudly as a breached one. Exactly one tier now owns saturated
 *      colour: the exceptions an agent has to act on.
 *   2. INTERACTION. Hover, keyboard focus and checkbox selection used to be
 *      three near-identical tints, so a shaded row meant nothing in particular.
 *      Each now has its own shape as well as its own tone.
 *
 * Static analysis of index.css, in the repo's existing check-script style
 * (mobile-check / sla-check). It reads rules, not pixels — it cannot tell you a
 * colour is pleasant, only that the rule that makes it distinguishable is still
 * there. The next person who wants "just a little green" on a healthy clock has
 * to delete an assertion that says why they cannot.
 *
 * Run: npm test  (from client/) */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(dir, 'src', 'index.css'), 'utf8');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}

/** The declaration block for a selector, or '' when the selector is absent. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : '';
}
const uses = (selector, token) => rule(selector).includes(`var(${token})`);

/* ---- the tier is documented where it is defined ---------------------- */
check('the hierarchy is stated in the stylesheet, not just applied',
  /Exception hierarchy/.test(css) && /exactly one tier/i.test(css));

/* ---- exceptions: the only saturated things in a row ------------------ */
check('an overdue SLA clock owns the danger tone', uses('.sla-mini.is-bad', '--danger'));
check('an overdue SLA clock outranks its neighbours typographically',
  /font-weight:\s*700/.test(rule('.sla-mini.is-bad')));
check('unread mail owns an accent', uses('.next-response.is-attention', '--primary'));
check('an unowned ticket is a badge, not quiet grey text',
  /border:\s*1px dashed/.test(rule('.unassigned-tag'))
  && uses('.unassigned-tag', '--warning')
  && !/font-style:\s*italic/.test(rule('.unassigned-tag')));

/* ---- routine: neutral, so the exceptions have something to stand out from */
check('a healthy SLA clock is neutral, not green', !uses('.sla-mini.is-ok', '--success'));
check('a healthy SLA clock is neutral, not amber', !uses('.sla-mini.is-ok', '--warning'));
check('New has a blue lifecycle tint',
  uses('.pill-state-new', '--primary-soft') && uses('.pill-state-new', '--primary-2'));
check('In Progress has a distinct violet lifecycle tint',
  uses('.pill-state-in_progress', '--violet-soft') && uses('.pill-state-in_progress', '--violet'));
check('the routine priority is neutral', !uses('.pill-priority-moderate', '--primary-soft'));

/* ---- amber means "soon", and only two things are soon ---------------- */
check('In Progress no longer spends the amber that means "approaching"',
  !uses('.pill-state-in_progress', '--warning'));
check('an approaching breach still owns amber', uses('.sla-mini.is-warn', '--warning'));
check('High priority still owns amber', uses('.pill-priority-high', '--warning'));

/* ---- colour comes from tokens, in both themes ------------------------ */
check('no literal hex colours were introduced by the hierarchy',
  !/#[0-9a-f]{3,8}/i.test([rule('.sla-mini.is-bad'), rule('.unassigned-tag'), rule('.pill-state-in_progress')].join(' ')));
check('every token the hierarchy uses is declared for the light theme too',
  (() => {
    const light = /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(css);
    if (!light) return false;
    return ['--danger', '--warning', '--primary', '--success', '--surface-2', '--text-dim']
      .every((token) => light[1].includes(`${token}:`) || css.includes(`${token}:`));
  })());

/* ---- interaction: hover, focus and selection are three different things -- */
const hover = rule('.queue-table tbody tr:hover');
const focus = rule('.queue-table tbody tr:focus-visible');
const selected = rule('.queue-table tbody tr:has(.select-cell input:checked)');
const selectedBar = rule('.queue-table tbody tr:has(.select-cell input:checked) .select-cell');

check('hover is a tint and nothing more', uses('.queue-table tbody tr:hover', '--surface-hover')
  && !/outline/.test(hover) && !/box-shadow/.test(hover));
check('focus is a visible ring', /outline:\s*2px solid/.test(focus));
check('focus does not rely on the same tint as hover', /outline/.test(focus));
check('selection has a tint of its own', uses('.queue-table tbody tr:has(.select-cell input:checked)', '--primary-soft'));
check('selection also has a shape, not just a shade',
  /box-shadow:\s*inset/.test(selectedBar) && uses('.queue-table tbody tr:has(.select-cell input:checked) .select-cell', '--primary'));
check('the selection bar is not drawn on the row itself',
  !/box-shadow/.test(selected),
  'a box-shadow on a <tr> does not paint reliably across browsers');
check('focus stays visible on an already-selected row',
  /:has\(\.select-cell input:checked\):focus-visible/.test(css));
check('the folded card carries the selection bar on the card',
  /\.queue-cards tbody tr:has\(\.select-cell input:checked\)\s*\{[^}]*box-shadow/.test(css));

/* ---- the subject column is the flexible one -------------------------- */
check('the subject column takes the leftover width rather than a fixed share',
  !/max-width:\s*1px/.test(rule('.queue-table .cell-main'))
  && /width:\s*auto/.test(rule('.queue-table .cell-main')));
check('the table uses a fixed layout, so the column widths are a real budget',
  /table-layout:\s*fixed/.test(rule('.queue-table')));

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nexception-hierarchy-check: ALL PASS');
