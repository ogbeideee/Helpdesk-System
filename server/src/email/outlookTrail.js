'use strict';

// A complete Outlook header run is evidence; a lone "From:" in prose is not.
function outlookHeaderAt(lines, start) {
  if (!/^\s*From\s*:\s*\S/i.test(lines[start] || '')) return null;
  const headers = {};
  let current = null;
  for (let i = start; i < Math.min(lines.length, start + 30); i++) {
    const line = lines[i];
    const match = line.match(/^\s*(From|Sent|Date|To|Cc|Subject)\s*:\s*(.*)$/i);
    if (match) {
      const key = match[1].toLowerCase();
      if (headers[key] !== undefined) return null;
      headers[key] = match[2].trim();
      current = key;
      if (key === 'subject') return headers.from && (headers.sent || headers.date) && headers.to
        ? { headers, end: i + 1 } : null;
    } else if (line.trim()) {
      if (!current) return null;
      headers[current] += ' ' + line.trim();
    }
  }
  return null;
}

function splitOutlookTrail(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let start = 0;
  let headers = null;
  for (let i = 0; i < lines.length; i++) {
    const found = outlookHeaderAt(lines, i);
    if (!found) continue;
    const body = lines.slice(start, i).join('\n').replace(/(?:\n|^)\s*[_-]{5,}\s*$/, '').trim();
    if (headers || body) blocks.push({ headers, body });
    headers = found.headers;
    start = found.end;
    i = found.end - 1;
  }
  const body = lines.slice(start).join('\n').trim();
  if (headers || body) blocks.push({ headers, body });
  return blocks;
}

module.exports = { outlookHeaderAt, splitOutlookTrail };
