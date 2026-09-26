// Remove the decorative inline images (signature logos, social icons, pasted
// pictures) that were stored as attachments before the inline-image policy
// existed.
//
//   npm run db:purge-signature-images            -> report what WOULD be removed
//   npm run db:purge-signature-images -- --apply -> actually remove it
//
// Scope is deliberately narrow, and read-only until --apply:
//   - only rows whose MIME type is an image, and
//   - only rows whose filename looks like a mail-client inline part
//     (image.png, image001.png, imageNNN.jpg, …) or a hash-named embedded part.
// A file the sender actually attached (a named invoice PDF, a named
// screenshot) never matches, whatever its type.
//
// Row deletion is the metadata; `storageKey` is then removed from object
// storage best-effort. The ticket, its comments and its audit trail are
// untouched — only the attachment rows and their binaries go.
const prisma = require('../src/lib/prisma');
const { getAttachmentStorage } = require('../src/services/attachmentStorage');

const APPLY = process.argv.includes('--apply');

/**
 * Mail clients name embedded parts themselves: image.png, image001.png …
 * Outlook raises the counter per message, so image012.jpg is still a part name.
 * Hash-named parts (32 hex chars) are webmail/inline-editor artefacts.
 */
const INLINE_PART_NAME_RE = /^image\d{0,3}\.(?:png|jpe?g|gif|bmp|webp|tiff?)$/i;
const HASH_PART_NAME_RE = /^[0-9a-f]{16,}\.(?:png|jpe?g|gif|webp)$/i;
const IMAGE_MIME_RE = /^image\//i;

function heading(text) {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

function looksLikeInlinePart(row) {
  if (!IMAGE_MIME_RE.test(String(row.mimeType || ''))) return false;
  const name = String(row.filename || '').trim();
  return INLINE_PART_NAME_RE.test(name) || HASH_PART_NAME_RE.test(name);
}

async function main() {
  console.log(
    APPLY
      ? 'PURGING stored inline signature images'
      : 'DRY RUN — nothing will be deleted (pass --apply to remove)'
  );

  const all = await prisma.attachment.findMany({
    select: { id: true, ticketId: true, filename: true, mimeType: true, size: true, storageKey: true },
    orderBy: { id: 'asc' },
  });
  const matched = all.filter(looksLikeInlinePart);
  const bytes = matched.reduce((sum, r) => sum + (r.size || 0), 0);

  heading(`Inline signature images (${matched.length} of ${all.length} stored attachments)`);
  const byName = new Map();
  for (const row of matched) {
    const key = `${row.filename} (${row.mimeType})`;
    const entry = byName.get(key) || { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += row.size || 0;
    byName.set(key, entry);
  }
  for (const [key, entry] of [...byName.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(entry.count).padStart(4)} ×  ${key}  [${Math.round(entry.bytes / 1024)} KB]`);
  }
  if (!matched.length) console.log('  none — nothing to do');
  console.log(`\n  total objects: ${matched.length}`);
  console.log(`  total size:    ${(bytes / (1024 * 1024)).toFixed(1)} MB`);
  console.log(`  tickets touched: ${new Set(matched.map((r) => r.ticketId)).size} (rows only, tickets stay)`);

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to remove the rows and their objects.');
    return;
  }
  if (!matched.length) {
    console.log('\nNothing to delete.');
    return;
  }

  // Binaries are not in the database: remove them best-effort FIRST, so a
  // storage failure can never leave a row pointing at a deleted object.
  const storage = getAttachmentStorage();
  let objectsDeleted = 0;
  for (const row of matched) {
    try {
      await storage.delete(row.storageKey);
      objectsDeleted += 1;
    } catch {
      // best-effort: an object that is already gone is the desired state
    }
  }
  const removed = await prisma.attachment.deleteMany({ where: { id: { in: matched.map((r) => r.id) } } });

  heading('Done');
  console.log(`  attachment rows removed: ${removed.count}`);
  console.log(`  objects removed:         ${objectsDeleted} (best-effort)`);
  console.log('  tickets, comments and audit history are untouched.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
