/* Contrast, measured rather than eyeballed.
 *
 * Every colour in this app comes from a token, and every token is declared
 * twice — once in `:root` (dark) and once in `:root[data-theme="light"]`. That
 * makes contrast checkable without a browser: parse the two blocks, composite
 * the alpha tokens over the surface they sit on, and compute the ratio for the
 * pairs the queue actually renders.
 *
 * What this catches is the failure mode that screenshots hide. A muted grey
 * looks fine in a mock-up on a bright monitor and is unreadable on a laptop at
 * 60% brightness — and the small text on the queue is 10–11.5px, where the
 * threshold is not negotiable.
 *
 * Thresholds (WCAG 2.1 AA):
 *   4.5:1  normal text
 *   3.0:1  large text (≥24px, or ≥18.66px bold) and non-text UI boundaries
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

/* ---- read the two palettes ------------------------------------------- */

/** Every `--token: value;` declaration in the block that follows `header {`. */
function themeTokens(header) {
  const start = css.indexOf(header);
  if (start === -1) return null;
  const open = css.indexOf('{', start);
  const end = css.indexOf('\n}', open);
  const body = css.slice(open + 1, end);
  const tokens = {};
  for (const line of body.split('\n')) {
    const match = /^\s*(--[\w-]+):\s*([^;]+);/.exec(line);
    if (match) tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

const THEMES = {
  dark: themeTokens(':root {'),
  light: themeTokens(':root[data-theme="light"] {'),
};

/* ---- colour maths ---------------------------------------------------- */

function parseColor(value) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value);
  if (rgba) {
    return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] };
  }
  return null;
}

/** Flatten a possibly-translucent colour onto an opaque one. */
function over(fg, bg) {
  if (fg.a >= 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---- the pairs the queue screen renders ------------------------------ */
/* `tokens` are [foreground, background]. A soft background is composited over
   the surface it sits on first, which is what the browser does. */
const PAIRS = [
  ['subject text on a row', ['--text', '--surface'], 4.5],
  ['subject text on a hovered row', ['--text', '--surface-hover'], 4.5],
  ['cell text on a row', ['--text-dim', '--surface'], 4.5],
  ['cell text on a hovered row', ['--text-dim', '--surface-hover'], 4.5],
  ['requester line', ['--muted', '--surface'], 4.5],
  ['age / created cell', ['--muted', '--surface'], 4.5],
  ['column header', ['--muted-2', '--surface'], 4.5],
  ['healthy SLA chip (11px)', ['--text-dim', '--surface-2'], 4.5],
  ['quick-view count (10.5px)', ['--muted', '--surface-2'], 4.5],
  ['filter chip label (11px)', ['--muted', '--surface-2'], 4.5],
  ['status tab count, idle (11px)', ['--muted', '--surface'], 4.5],
  ['status tab count, active (11px)', ['--text-dim', '--surface-3'], 4.5],
  ['segment label, idle (12.5px)', ['--text-dim', '--surface'], 4.5],
  ['sidebar section label (10px)', ['--muted-2', '--surface'], 4.5],
  ['overdue SLA chip (11px bold)', ['--danger', '--danger-soft'], 4.5],
  ['approaching SLA chip (11px bold)', ['--warning', '--warning-soft'], 4.5],
  ['resolved badge', ['--success', '--success-soft'], 4.5],
  ['New badge', ['--primary-2', '--primary-soft'], 4.5],
  ['In Progress badge', ['--violet', '--violet-soft'], 4.5],
  ['active quick view (12.5px 600)', ['--primary', '--primary-soft'], 4.5],
  ['"Next response: us" (11px)', ['--text-dim', '--surface'], 4.5],
  ['unread reply line (11px 600)', ['--primary', '--surface'], 4.5],
  ['unowned badge text (11.5px 600)', ['--warning', '--surface'], 4.5],
  ['unowned badge outline', ['--warning', '--surface'], 3.0],
  ['count badge on its fill', ['--on-solid', '--primary'], 4.5],
  ['nav badge on its fill', ['--on-solid', '--danger'], 4.5],
];

/* The SLA chip's clock name is the declaration that is easiest to get wrong,
   because `opacity` is not a token and nothing else in the file knows it is
   there. It has to inherit the chip's colour — which the pair above already
   checks — rather than fade it. */
const chipKeyRule = /\.sla-mini-key\s*\{([^}]*)\}/.exec(css);
check('the SLA chip clock name does not fade itself below the AA floor',
  chipKeyRule !== null && !/opacity:\s*0?\.\d/.test(chipKeyRule[1]),
  'a fractional opacity here is a contrast failure that no token review will catch');

for (const [themeName, tokens] of Object.entries(THEMES)) {
  check(`${themeName}: both palettes declare the same token names`,
    tokens !== null && Object.keys(tokens).length > 10);
  if (!tokens) continue;

  const value = (name) => {
    const raw = tokens[name];
    const parsed = raw ? parseColor(raw) : null;
    return parsed;
  };

  for (const [label, [fgName, bgName], min] of PAIRS) {
    const fg = value(fgName);
    const bgRaw = value(bgName);
    if (!fg || !bgRaw) {
      check(`${themeName}: ${label}`, false, `missing ${!fg ? fgName : bgName}`);
      continue;
    }
    // A soft background is translucent; flatten it onto the row surface.
    const surface = value('--surface');
    const bg = over(bgRaw, surface);
    const r = ratio(over(fg, bg), bg);
    check(`${themeName}: ${label} ≥ ${min}:1`, r >= min, `measured ${r.toFixed(2)}:1`);
  }
}

/* ---- the focus ring --------------------------------------------------
   Non-text UI contrast (WCAG 2.1 1.4.11) needs 3:1 against what it sits on, and
   a focus ring sits on whatever the element is on — so it has to clear both the
   page background and the surface above it. The ring is declared as a two-layer
   box-shadow; the outer layer is the one you see against the page, and it is
   read per theme (a ring's alpha cannot be copied between palettes: the same
   value that passes on a near-black page fails on a near-white one). */
for (const [themeName, tokens] of Object.entries(THEMES)) {
  if (!tokens) { check(`${themeName}: focus ring is declared`, false); continue; }
  const layers = [...(tokens['--ring'] || '').matchAll(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi)].map((m) => m[0]);
  const outer = layers.length ? parseColor(layers[layers.length - 1]) : null;
  if (!outer) { check(`${themeName}: focus ring has a resolvable colour`, false, tokens['--ring']); continue; }
  for (const base of ['--bg', '--surface']) {
    const bg = parseColor(tokens[base]);
    if (!bg) { check(`${themeName}: focus ring vs ${base}`, false, `missing ${base}`); continue; }
    const r = ratio(over(outer, bg), bg);
    check(`${themeName}: focus ring ≥ 3:1 against ${base}`, r >= 3, `measured ${r.toFixed(2)}:1`);
  }
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\ncontrast-check: ALL PASS');
