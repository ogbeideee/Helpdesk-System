/* Pins the attachment rules: how a file is labelled, which message it belongs
   to, which bytes may be rendered in place (the server decides), and that the
   download path stays inert. Pure module, checked the same way the other client
   view modules are (plain node, no DOM for the pure parts).
   Usage: node attachments-check.mjs */

import {
  attachmentType, formatBytes, attachmentTitle, originalAttachments, attachmentsForComment,
  canPreviewInline,
} from './src/attachmentView.js';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function list(name, actual, expected) {
  const a = (actual || []).map((v) => String(v));
  check(name, a.join(',') === expected.join(','), `expected [${expected}], got [${a}]`);
}

/* ---- A. grouping — the rule the timeline depends on ------------------ */

const ticket = {
  id: 42,
  attachments: [
    { id: 1, commentId: null, filename: 'photo.png', mimeType: 'image/png', size: 2048 },
    { id: 2, commentId: 10, filename: 'error.png', mimeType: 'image/png', size: 512 },
    { id: 3, commentId: 10, filename: 'trace.log', mimeType: 'text/plain', size: 40 },
    { id: 4, commentId: 11, filename: 'internal.txt', mimeType: 'text/plain', size: 12 },
  ],
};

list('A1 an attachment with no comment belongs to the original message',
  originalAttachments(ticket).map((a) => a.id), ['1']);
list('A2 a comment gets exactly the attachments that arrived with it',
  attachmentsForComment(ticket, 10).map((a) => a.id), ['2', '3']);
eq('A3 a comment with no attachments gets an empty list',
  attachmentsForComment(ticket, 99).length, 0);
eq('A4 a null comment id is never a match',
  attachmentsForComment(ticket, null).length, 0);
eq('A5 a ticket with no attachments is safe', originalAttachments({ id: 1 }).length, 0);
eq('A6 a null attachment list is safe', originalAttachments({ id: 1, attachments: null }).length, 0);
eq('A7 a null ticket is safe', originalAttachments(null).length, 0);
check('A8 a commentId of 0 is a real id, not a missing one',
  attachmentsForComment({ attachments: [{ id: 1, commentId: 0 }] }, 0).length === 1);

/* ---- B. labels ------------------------------------------------------- */

eq('B1 a bare mime type passes through', attachmentType({ mimeType: 'image/png' }), 'image/png');
eq('B2 parameters are stripped', attachmentType({ mimeType: 'application/pdf; charset=utf-8' }), 'application/pdf');
eq('B3 a missing mime type reads as a plain file', attachmentType({}), 'file');
eq('B4 a null attachment is safe', attachmentType(null), 'file');
eq('B5 a whitespace-only mime type is not a mime type', attachmentType({ mimeType: '   ' }), 'file');

eq('B6 bytes under a kilobyte', formatBytes(512), '512 B');
eq('B7 exactly one kilobyte is still bytes', formatBytes(1024), '1.0 KB');
eq('B8 a kilobyte-scale file', formatBytes(2048), '2.0 KB');
eq('B9 the megabyte boundary', formatBytes(1024 * 1024), '1.0 MB');
eq('B10 a large file', formatBytes(5 * 1024 * 1024), '5.0 MB');
eq('B11 a missing size is zero, never NaN', formatBytes(undefined), '0 B');
eq('B12 a nonsense size is zero, never NaN', formatBytes('big'), '0 B');
eq('B13 a negative size is clamped, never printed as a negative label', formatBytes(-5), '0 B');

eq('B14 the chip tooltip carries the type and the size',
  attachmentTitle({ mimeType: 'application/pdf', size: 2048 }), 'application/pdf · 2.0 KB');
eq('B15 a null attachment has no tooltip', attachmentTitle(null), null);

/* ---- C. the download path is inert ----------------------------------- */

/* Static check: the fetch must carry the bearer token, and the response must
   be written to a synthetic link and never opened as a location. The point of
   the endpoint is that an inbound file is never rendered or executed, so the
   client must not introduce a second way in. */
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./src/attachmentView.js', import.meta.url), 'utf8');

check('C1 the download is authenticated with the session token',
  /Authorization:\s*`Bearer \$\{getToken\(\)\}`/.test(src));
check('C2 the response is fetched as a blob, never navigated to',
  /res\.blob\(\)/.test(src) && !/window\.open|location\.href\s*=\s*blob/.test(src));
check('C3 the object URL is revoked after the click',
  /URL\.revokeObjectURL\(url\)/.test(src));
check('C4 the download filename comes from the attachment record',
  /a\.download = attachment\.filename/.test(src));
check('C5 nothing here can execute or inline a file',
  !/innerHTML|insertAdjacentHTML|data:text|eval\(/.test(src));
check('C6 the view module has no JSX, so it is importable by the node checks',
  !/<\w+[ />]/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));

/* ---- D. preview: the server decides, the client reflects -------------- */

/* An image the server marked `previewable` opens in place; everything else is
   a download. The allowlist is the SERVER's (attachmentFetchService.js) and the
   client keeps no copy of it — same rule as `selectable` assignment candidates
   and every other server-decided flag. */

check('D1 preview follows the server flag and nothing else',
  /attachment\.previewable/.test(src));
check('D2 the client keeps no MIME allowlist of its own',
  !/image\/(png|jpe?g|gif|webp|svg)/i.test(src));
eq('D3 a server-flagged image previews', canPreviewInline({ previewable: true }), true);
eq('D4 an unflagged attachment does not', canPreviewInline({ previewable: false }), false);
eq('D5 a payload from before the flag existed does not preview',
  canPreviewInline({ mimeType: 'image/png', size: 10 }), false);
eq('D6 a null attachment does not preview', canPreviewInline(null), false);
check('D7 the preview is fetched with the same authenticated call as the download',
  (src.match(/Authorization:\s*`Bearer \$\{getToken\(\)\}`/g) || []).length === 2);

/* The object URL for a preview belongs to whoever opened it: the component must
   revoke it, or every preview leaks a blob for the life of the tab. */
const conversation = readFileSync(new URL('./src/components/TicketConversation.jsx', import.meta.url), 'utf8');
check('D8 the preview URL is revoked (no leaked blobs)',
  /URL\.revokeObjectURL\(/.test(conversation));
check('D9 the preview renders an object URL, never the API path directly',
  /<img src=\{preview\.url\}/.test(conversation) && !/<img src="\/api\//.test(conversation));
check('D10 the lightbox is the shared Modal, not a second dialog',
  /<Modal /.test(conversation));

console.log(failures === 0 ? '\nattachments-check: ALL PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
