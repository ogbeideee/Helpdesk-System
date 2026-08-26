// Deterministic HTML -> readable plain text.
//
// No LLM, no DOM library: a fixed sequence of replacements over the markup.
// Goals, in order of priority:
//   1. never leak markup into a ticket body
//   2. preserve the line breaks that carry meaning (paragraphs, lists, rows)
//   3. collapse the whitespace that email clients scatter everywhere
//
// This module is provider-independent — it knows nothing about Graph, IMAP or
// tickets. src/graph/htmlToText.js re-exports it so there is one implementation.

const NAMED_ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&bull;': '•',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&ldquo;': '“',
  '&rdquo;': '”',
};

function decodeEntities(text) {
  let out = text;
  for (const [entity, char] of Object.entries(NAMED_ENTITIES)) {
    out = out.split(entity).join(char);
  }
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)));
  out = out.replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)));
  return out;
}

function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/** Block-level elements whose *opening* tag should also start a new line. */
const BLOCK_OPEN =
  /<(p|div|section|article|header|footer|table|tr|h[1-6]|blockquote|pre|ul|ol)\b[^>]*>/gi;
/**
 * …and whose closing tag ends the line.
 * `li` is deliberately absent: the opening `<li>` already starts a new line,
 * so closing it too would double-space every list.
 */
const BLOCK_CLOSE =
  /<\/(p|div|section|article|header|footer|table|h[1-6]|blockquote|pre|ul|ol|tr)>/gi;

/**
 * @param {string} html
 * @returns {string} plain text, trimmed
 */
function htmlToPlainText(html) {
  if (html === null || html === undefined) return '';
  if (typeof html !== 'string') return '';

  let text = html;

  // 1) Drop anything that is not content.
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<!DOCTYPE[^>]*>/gi, ' ');
  text = text.replace(/<\?xml[^>]*\?>/gi, ' ');
  // Conditional comments / Office noise.
  text = text.replace(/<!\[[\s\S]*?\]>/g, ' ');

  // 2) Structural breaks, before tags are stripped.
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n');
  // List items become bullets on their own line. Leading whitespace is
  // consumed so pretty-printed source (newline + indent between </li> and the
  // next <li>) does not turn into a blank line between bullets.
  text = text.replace(/\s*<li\b[^>]*>\s*/gi, '\n- ');
  text = text.replace(/\s*<\/li>/gi, '');
  // Table cells separated by a space so a row stays on one line.
  text = text.replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, ' \t ');
  text = text.replace(/<t[dh]\b[^>]*>/gi, '');
  text = text.replace(BLOCK_CLOSE, '\n');
  text = text.replace(BLOCK_OPEN, '\n');

  // 3) Remove every remaining tag.
  text = text.replace(/<[^>]+>/g, '');

  // 4) Entities, after tag removal so &lt;b&gt; survives as literal text.
  text = decodeEntities(text);

  // 5) Whitespace normalisation.
  text = text.replace(/\r\n?/g, '\n');
  // Non-breaking / zero-width characters email clients love.
  text = text.replace(/[ ​‌‍﻿]/g, ' ');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  // At most one blank line between blocks.
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/** True when the string looks like it carries HTML markup. */
function looksLikeHtml(value) {
  if (typeof value !== 'string' || !value) return false;
  return /<\/?[a-z][\s\S]*>/i.test(value) || /&[a-z#0-9]+;/i.test(value);
}

module.exports = { htmlToPlainText, looksLikeHtml, decodeEntities };
