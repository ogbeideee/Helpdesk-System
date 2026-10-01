// Byte cache for inbound email attachments.
//
// The bytes are a CACHE, not the record. The source message stays in the shared
// mailbox (the poller never moves or deletes it), and that is the archive; this
// directory exists so the common case — an agent opening a screenshot minutes
// after the ticket arrives — never round-trips to the mail server. A miss is
// therefore routine, not a data loss: attachmentFetchService re-reads the
// source message and re-caches the bytes (see sweepAttachmentCache for
// eviction, and attachmentFetchService for the re-read).
//
// The provider sits behind this small factory so it can be replaced later
// (S3, Azure Blob, ...) without touching the ingestion pipeline or the
// download endpoint. The default provider is the local filesystem: a private
// directory that is never web-served, with server-generated keys — it plays
// the role of a bucket for self-hosted deployments.
//
// Guarantees every provider must keep:
//   - keys are generated HERE, server-side, and never derive from the
//     filename (no user input ever reaches a storage path)
//   - the bucket/directory is private: nothing in it is reachable without
//     going through the authorized download endpoint
//   - put/get are injectable, so tests run against in-memory or temp storage
//     without any real object-storage credentials
//
// Credentials, bucket names and storage keys are never logged here.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Display-name sanitizer. The result is used ONLY in Content-Disposition and
 * UI labels — never for storage paths. It strips path components, separators,
 * control characters and Windows-reserved names, caps the length and always
 * yields something usable.
 */
function sanitizeFilename(name) {
  let out = String(name ?? '');
  // Take only the last path segment for every common separator.
  out = out.split(/[/\\]/).pop() || '';
  // Drop control characters and the characters Windows forbids in names.
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '');
  // Dot-segments never survive (traversal defense in depth).
  out = out.replace(/^\.+/, '').trim();
  if (out.length > 200) {
    const ext = path.extname(out).slice(0, 20);
    out = out.slice(0, 200 - ext.length) + ext;
  }
  // Reserved device names are not safe as display names either.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out)) out = `_${out}`;
  return out || 'attachment.bin';
}

/** Server-generated storage key. Contains nothing user-supplied. */
function generateStorageKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `att/${y}/${m}/${crypto.randomUUID()}`;
}

/** Filesystem provider. The directory is created on demand, mode 0700. */
function createLocalStorage({ rootDir, logger = console } = {}) {
  return {
    kind: 'local',
    async put(key, buffer) {
      const target = path.join(rootDir, key);
      await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(target, buffer, { mode: 0o600 });
      return { key, size: buffer.length };
    },
    async get(key) {
      const target = path.join(rootDir, key);
      // The key is server-generated, but the join is still guarded: anything
      // that escapes the root is treated as a missing object, not a read.
      const resolved = path.resolve(target);
      const root = path.resolve(rootDir);
      if (!resolved.startsWith(root + path.sep)) {
        const err = new Error('attachment not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      try {
        return await fs.promises.readFile(resolved);
      } catch (err) {
        if (err.code === 'ENOENT') {
          const notFound = new Error('attachment not found');
          notFound.code = 'NOT_FOUND';
          throw notFound;
        }
        throw err;
      }
    },
    async delete(key) {
      const target = path.join(rootDir, key);
      await fs.promises.rm(target, { force: true }).catch(() => {});
    },
  };
}

/**
 * Where the default local cache lives. Exported so the eviction job and the
 * purge scripts resolve the directory exactly the same way the provider does —
 * a second copy of this rule is a second place to get it wrong.
 */
function resolveAttachmentRootDir(options = {}) {
  return options.rootDir
    || process.env.ATTACHMENT_STORAGE_DIR
    || path.join(__dirname, '..', '..', 'data', 'attachments');
}

/** Every file under the cache root, oldest-last is irrelevant: callers stat. */
async function listCacheFiles(rootDir) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return; // empty or absent cache is not an error
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      // Symlinks are deliberately NOT followed: the cache holds regular files
      // written by the provider, and a link could point anywhere.
      else if (entry.isFile()) out.push(full);
    }
  }
  await walk(rootDir);
  return out;
}

/**
 * Evict cached bytes older than the TTL.
 *
 * Attachment bytes are a CACHE, not the record: the source message in the
 * mailbox is the archive, and a view re-reads it on a miss (see
 * attachmentFetchService). So eviction costs a re-read later, never data.
 * Deleting by mtime — not by database row — is deliberate: the `Attachment`
 * row keeps its key and metadata forever, so an evicted object is
 * indistinguishable from one that was never cached.
 *
 * `ttlDays` 0 (or anything non-positive) disables eviction entirely.
 */
async function sweepAttachmentCache({ rootDir, ttlDays, now = new Date(), logger = console } = {}) {
  const dir = rootDir || resolveAttachmentRootDir();
  const days = Number(ttlDays);
  if (!Number.isFinite(days) || days <= 0) {
    return { disabled: true, scanned: 0, removed: 0, freedBytes: 0, failed: 0 };
  }

  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  let scanned = 0;
  let removed = 0;
  let freedBytes = 0;
  let failed = 0;

  for (const file of await listCacheFiles(dir)) {
    scanned += 1;
    try {
      const stat = await fs.promises.stat(file);
      if (stat.mtimeMs > cutoff) continue;
      await fs.promises.rm(file, { force: true });
      removed += 1;
      freedBytes += stat.size;
    } catch (err) {
      // One unreadable file must not stop the sweep. The key is server-
      // generated, so the basename is safe to log — the full path is not
      // printed, to keep machine layout out of the log.
      failed += 1;
      logger.warn(`[attachments] cache eviction failed for ${path.basename(file)}: ${err.message}`);
    }
  }

  return { disabled: false, scanned, removed, freedBytes, failed };
}

/** In-memory provider for tests: same contract, no filesystem. */
function createMemoryStorage(initial = {}) {
  const objects = new Map(Object.entries(initial));
  return {
    kind: 'memory',
    objects,
    async put(key, buffer) {
      objects.set(key, Buffer.from(buffer));
      return { key, size: buffer.length };
    },
    async get(key) {
      const buf = objects.get(key);
      if (!buf) {
        const err = new Error('attachment not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      return Buffer.from(buf);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

/**
 * Create the attachment storage. Defaults to the private local directory;
 * `options.storage` replaces the whole provider (tests), and env vars choose
 * the location of the default one.
 */
function createAttachmentStorage(options = {}) {
  if (options.storage) return options.storage;
  const kind = options.kind || String(process.env.ATTACHMENT_STORAGE || 'local');
  if (kind !== 'local') {
    throw new Error(`Unknown ATTACHMENT_STORAGE kind "${kind}" — only "local" is built in`);
  }
  const rootDir = resolveAttachmentRootDir(options);
  return createLocalStorage({ rootDir, logger: options.logger });
}

// Process-wide default for API-route usage (the download endpoint).
let defaultStorage = null;
function getAttachmentStorage() {
  if (!defaultStorage) defaultStorage = createAttachmentStorage();
  return defaultStorage;
}

/** Limits, read once at module load per the server's env conventions. */
const LIMITS = {
  maxBytes: (() => {
    const raw = Number(process.env.ATTACHMENT_MAX_BYTES);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 26214400; // 25 MB
  })(),
  maxPerMessage: (() => {
    const raw = Number(process.env.ATTACHMENT_MAX_PER_MESSAGE);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 10;
  })(),
  maxTotalBytes: (() => {
    const raw = Number(process.env.ATTACHMENT_MAX_TOTAL_BYTES);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 104857600; // 100 MB
  })(),
};

module.exports = {
  sanitizeFilename,
  generateStorageKey,
  createAttachmentStorage,
  createLocalStorage,
  createMemoryStorage,
  getAttachmentStorage,
  resolveAttachmentRootDir,
  sweepAttachmentCache,
  LIMITS,
};
